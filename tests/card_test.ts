// The language card (src/card.ts): its program is accepted, every code, std
// name and tool call it mentions exists and answers as it says, and it stays
// short enough to be a card.

import { assert_, assertEquals, assertThrows } from "./assert.ts";
import { done, fresh } from "./db_helpers.ts";
import { EFFECTS, pathText } from "../src/ast.ts";
import { CARD } from "../src/card.ts";
import { McpServer, TOOLS } from "../src/mcp.ts";
import { AlangError } from "../src/diagnostic.ts";
import { parseExpression, parseProgram } from "../src/parser.ts";
import { printProgram } from "../src/printer.ts";
import { STD, STD_TYPES } from "../src/std.ts";
import { accept } from "../src/toolchain.ts";

const blocks = [...CARD.matchAll(/^```(\w*)\n([\s\S]*?)^```$/gm)].map((m) => ({ lang: m[1], text: m[2] }));

Deno.test("card: block inventory", () => {
  // Guards against the program silently dropping out of the tests.
  assertEquals(blocks.map((b) => b.lang), [""]);
  assertEquals(parseProgram(blocks[0].text).map((d) => `${d.kind} ${pathText(d.path)}`), [
    "type temp.Problem",
    "fn temp.fahrenheit",
    "fn temp.main",
  ]);
});

Deno.test("card: its code is canonical and round-trips", () => {
  for (const block of blocks) {
    const tree = parseProgram(block.text);
    const printed = printProgram(tree);
    assertEquals(printed, block.text);
    assertEquals(parseProgram(printed), tree);
  }
});

Deno.test("card: the complete program is accepted, its examples run", async () => {
  const out = new URL("../out/test/card/temp.ts", import.meta.url).pathname;
  const { examples } = await accept(blocks[0].text, out);
  assertEquals(examples.length, 4);
});

Deno.test("card: every diagnostic code it names exists", async () => {
  let sources = "";
  for await (const entry of Deno.readDir(new URL("../src/", import.meta.url))) {
    if (entry.name.endsWith(".ts")) {
      sources += await Deno.readTextFile(new URL(`../src/${entry.name}`, import.meta.url));
    }
  }
  const codes = new Set<number>();
  for (const m of CARD.matchAll(/E(\d{4})(?: to E(\d{4}))?/g)) {
    const [low, high] = [Number(m[1]), Number(m[2] ?? m[1])];
    for (let code = low; code <= high; code++) codes.add(code);
  }
  assert_(codes.size >= 20, `only ${codes.size} codes`);
  for (const code of codes) {
    const name = `E${String(code).padStart(4, "0")}`;
    assert_(sources.includes(`"${name}"`), `${name} is not a diagnostic code in src/`);
  }
});

Deno.test("card: every std name it mentions exists", () => {
  const known = new Set<string>();
  const modules = (name: string) => {
    for (let i = name.indexOf("."); i !== -1; i = name.indexOf(".", i + 1)) known.add(name.slice(0, i));
  };
  for (const s of STD) {
    known.add(s.name);
    modules(s.name);
  }
  for (const t of STD_TYPES) {
    const name = pathText(t.path);
    known.add(name);
    modules(name);
    if (t.kind === "type" && t.shape.kind === "variant") {
      for (const c of t.shape.cases) known.add(`${pathText(t.path.slice(0, -1))}.${c.name}`);
    }
  }
  const mentioned = new Set([...CARD.matchAll(/\bstd(?:\.[A-Za-z_]\w*)+/g)].map((m) => m[0]));
  assert_(mentioned.size >= 10, `only ${mentioned.size} std names`);
  for (const name of mentioned) assert_(known.has(name), `${name} is not in std`);
});

Deno.test("card: the effects are listed in table order", () => {
  assert_(CARD.includes(`\`${EFFECTS.join(", ")}\``));
});

Deno.test("card: every tool it names exists", () => {
  const section = CARD.slice(CARD.indexOf("## Working through the tools"), CARD.indexOf("## Definitions"));
  const named = [...new Set([...section.matchAll(/`([a-z_]+)\(/g)].map((m) => m[1]))];
  assertEquals(named, ["list", "search", "search_type", "context", "add", "replace", "submit"]);
  for (const name of named) assert_(TOOLS.some((t) => t.name === name), name);
});

Deno.test("card: the tool calls it shows find what it says", async () => {
  const cb = await fresh();
  const server = new McpServer(cb);
  let ids = 0;
  const call = async (name: string, args: Record<string, string>): Promise<unknown> => {
    const response = await server.handle({
      jsonrpc: "2.0",
      id: ++ids,
      method: "tools/call",
      params: { name, arguments: args },
    });
    const r = response!.result as { content: { text: string }[]; isError: boolean };
    assert_(!r.isError, `${name}: ${r.content[0].text}`);
    return JSON.parse(r.content[0].text);
  };
  const names = (entries: unknown) => (entries as { name: string }[]).map((e) => e.name);

  for (
    const shown of [
      '`list("std")`',
      '`list("std.string")`',
      '`search("split")`',
      '`search_type("String, String -> List<String>")`',
      "`context(name)`",
    ]
  ) assert_(CARD.includes(shown), shown);
  const std = await call("list", { module: "std" }) as { submodules: string[] };
  assert_(std.submodules.includes("std.string"));
  // Each function hit holds its signature (parameters, result, effects) and its doc.
  const split = "fn std.string.split(text: String, separator: String): List<String>, effects: none";
  const module = await call("list", { module: "std.string" }) as { definitions: { name: string; doc: string }[] };
  assert_(module.definitions.some((d) => d.name === "std.string.split" && d.doc !== ""));
  const hits = [module.definitions, await call("search", { text: "split" })] as { name: string; signature: string }[][];
  for (const found of hits) assertEquals(found.find((h) => h.name === "std.string.split")?.signature, split);
  assertEquals(names(await call("search_type", { pattern: "String, String -> List<String>" })), [
    "std.string.split",
  ]);
  // A std name: its signature line with the doc, and the types it mentions.
  const context = await call("context", { name: "std.fs.read_text" }) as { text: string; uses: unknown };
  assert_(context.text.startsWith("fn std.fs.read_text(path: String): Result<String, std.fs.Error>, effects: fs.read"));
  assert_(context.text.includes("doc: "));
  assertEquals(names(context.uses), ["std.fs.Error"]);
  await done(cb);
});

Deno.test("card: it stays a card", () => {
  const bytes = new TextEncoder().encode(CARD).length;
  assert_(bytes < 10_240, `${bytes} bytes`);
  assert_(CARD.split("\n").length <= 160, `${CARD.split("\n").length} lines`);
  // The escapes are text on the card, not characters the template made.
  assert_([...CARD].every((c) => c === "\n" || (c >= " " && c !== "\u007F")));
  for (const escape of ['`\\"`', "`\\\\`", "`\\n`", "`\\t`", "`\\u{1B}`"]) assert_(CARD.includes(escape), escape);
  // \r is the C escape a model reaches for (the tasks round): the card gives
  // the form that E0005's fix gives.
  const r = assertThrows(() => parseExpression('"a\\rb"'), AlangError).diagnostic;
  assertEquals([r.code, r.fix], ["E0005", { replace: "\\r", with: "\\u{D}" }]);
  assert_(CARD.includes(`\`${r.fix!.replace}\` is \`${r.fix!.with}\``));
  assert_(!CARD.includes("${"));
});
