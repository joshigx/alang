// `extern fn` in the database and the MCP server (phase `extern-fn`, E13 to
// E15, E11): hits, signatures, `context`, `search_type`, a `fn` turned into
// an extern, the export, a module edit caught at the next acceptance, and the
// server's permission to start the separate process.

import { join } from "node:path";
import { assert_, assertEquals } from "./assert.ts";
import { type Codebase, hashText } from "../src/codebase.ts";
import { INSTRUCTIONS } from "../src/mcp.ts";
import { parseProgram } from "../src/parser.ts";
import { printDefinition } from "../src/printer.ts";
import { add, codes, done, fails, fn, fresh, hashOf, ok } from "./db_helpers.ts";
import { TEXT, TEXT_TS } from "./extern_fixtures.ts";

// The two externs and `text.pair`, without `main`.
const [DECODE, ENCODE, PAIR] = parseProgram(TEXT).map(printDefinition);

async function withText(): Promise<Codebase> {
  const cb = await fresh();
  await Deno.writeTextFile(join(cb.dir, "text.ts"), TEXT_TS);
  await ok(cb, [DECODE, ENCODE, PAIR].map(add));
  return cb;
}

// No acceptance file stays behind, the entry of the separate process
// included.
function noLeftovers(cb: Codebase): void {
  const left = [...Deno.readDirSync(join(cb.dir, "out"))].filter((e) => e.name.startsWith("accept-"));
  assertEquals(left.map((e) => e.name), []);
}

Deno.test("extern db: a hit starts `extern fn`; the signature leaves `target` out (E13)", async () => {
  const cb = await withText();
  noLeftovers(cb);
  const hits = cb.list("text").definitions;
  assertEquals(hits.map((h) => [h.name, h.kind, h.signature]), [
    ["text.decode", "fn", "extern fn text.decode(text: String): Option<String>, effects: none"],
    ["text.encode", "fn", "extern fn text.encode(text: String): String, effects: none"],
    ["text.pair", "fn", "fn text.pair(key: String, value: String): String, effects: none"],
  ]);
  const signature = cb.signature("text.encode").signature;
  assert_(signature.endsWith("end extern fn text.encode"), signature);
  assert_(!signature.includes("target:"), signature);
  assert_(cb.definition("text.encode").text.includes('\n  target: "./text.ts#encode"\n'));
  const context = cb.context("text.pair");
  const encode = context.uses.find((u) => u.name === "text.encode")!;
  assert_(encode.text.startsWith("extern fn text.encode\n"), encode.text);
  assert_(cb.searchType("String -> String").map((h) => h.name).includes("text.encode"));
  await done(cb);
});

Deno.test("extern db: `replace` turns a `fn` into an extern; its target is no interface (E14)", async () => {
  const cb = await fresh();
  const double = fn("m.double", {
    params: ["n: Int"],
    out: "Int",
    examples: ["double(n: 2) == 4"],
    body: "return n * 2",
  });
  const quad = fn("m.quad", {
    params: ["n: Int"],
    out: "Int",
    examples: ["quad(n: 1) == 4"],
    body: "return double(n: double(n: n))",
  });
  await ok(cb, [double, quad].map(add));
  await Deno.writeTextFile(join(cb.dir, "m.ts"), "export function double(n: number): number {\n  return n * 2;\n}\n");
  const extern = double.replace("fn m.double", "extern fn m.double").replace(
    "  body:\n    return n * 2\nend fn m.double",
    '  target: "./m.ts#double"\nend extern fn m.double',
  );
  await ok(cb, [{ op: "replace", name: "m.double", hash: hashOf(cb, "m.double"), text: extern }]);
  assertEquals(cb.history("m.double").entries.map((e) => e.operation), ["add", "replace"]);
  const float = extern.replace("  out: Int", "  out: Float").replace("double(n: 2) == 4", "double(n: 2) == 4.0");
  const r = await fails(cb, [{ op: "replace", name: "m.double", hash: hashOf(cb, "m.double"), text: float }]);
  assertEquals(codes(r.diagnostics), ["E0506"]);
  assert_(r.diagnostics[0].message.includes("m.quad"), r.diagnostics[0].message);
  // E0505 names the stored header.
  const other = await fails(cb, [{
    op: "replace",
    name: "m.double",
    hash: hashOf(cb, "m.double"),
    text: extern.replaceAll("m.double", "m.twice").replace("double(n: 2)", "twice(n: 2)"),
  }]);
  assertEquals(other.diagnostics.map((d) => [d.code, d.expected]), [["E0505", "extern fn m.double"]]);
  noLeftovers(cb);
  await done(cb);
});

Deno.test("extern db: the export holds the target; an import gives the same hashes (E15)", async () => {
  const cb = await withText();
  const exported = await Deno.readTextFile(join(cb.dir, "export", "text.alang"));
  assertEquals(exported, `${DECODE}\n\n${ENCODE}\n\n${PAIR}\n`);
  const copy = await fresh();
  await Deno.writeTextFile(join(copy.dir, "text.ts"), TEXT_TS);
  const imported = await copy.importAll(join(cb.dir, "export"));
  assert_(imported.ok, JSON.stringify(imported));
  for (const name of ["text.decode", "text.encode", "text.pair"]) {
    assertEquals(hashOf(copy, name), hashOf(cb, name));
    assertEquals(hashOf(copy, name), hashText(cb.definition(name).text));
  }
  await done(copy);
  await done(cb);
});

Deno.test("extern db: a module edit is caught by the next acceptance of anything (E15)", async () => {
  const cb = await withText();
  await Deno.writeTextFile(join(cb.dir, "text.ts"), TEXT_TS.replace("encodeURIComponent(text)", "text.toUpperCase()"));
  const one = fn("other.one", { out: "Int", examples: ["one() == 1"], body: "return 1" });
  const r = await fails(cb, [add(one)]);
  assertEquals(r.diagnostics.map((d) => [d.code, d.definition, d.message]), [
    ["E0402", "text.encode", 'The example does not hold: `encode(text: "a b&c")` is `"A B&C"`.'],
    ["E0402", "text.encode", 'The example does not hold: `encode(text: "é")` is `"É"`.'],
    ["E0402", "text.pair", 'The example does not hold: `pair(key: "q", value: "café au lait")` is `"Q=CAFÉ AU LAIT"`.'],
  ]);
  assertEquals(cb.list("").submodules.includes("other"), false);
  noLeftovers(cb);
  await done(cb);
});

Deno.test("extern db: `alang db run` runs a program with an extern from the codebase's directory", async () => {
  const cb = await withText();
  const [, , , MAIN] = parseProgram(TEXT).map(printDefinition);
  await ok(cb, [add(MAIN)]);
  const out = await cb.run("text.main", { args: ["café au lait"], stdio: "piped", cwd: cb.dir });
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  assertEquals([out.code, decode(out.stdout), decode(out.stderr)], [0, "q=caf%C3%A9%20au%20lait\n", ""]);
  noLeftovers(cb);
  await done(cb);
});

// ---- the server (E11) ----

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

// One tool call to a server started with `flags`, as a client registers it.
async function serve(dir: string, flags: string[], name: string, args: unknown): Promise<Record<string, unknown>> {
  const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", ...flags, CLI, "mcp", "--dir", dir],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(call) + "\n"));
  await writer.close();
  const out = await child.output();
  const response = JSON.parse(new TextDecoder().decode(out.stdout).split("\n")[0]);
  return JSON.parse(response.result.content[0].text);
}

Deno.test("extern db: a server without --allow-run refuses an extern (E0408); with it, it is written", async () => {
  const cb = await fresh();
  cb.close(); // The server processes open it.
  await Deno.writeTextFile(join(cb.dir, "text.ts"), TEXT_TS);
  const refused = await serve(cb.dir, ["--allow-read", "--allow-write"], "add", { text: ENCODE });
  assertEquals(refused.ok, false);
  const ds = refused.diagnostics as { code: string; at: string; message: string }[];
  assertEquals(ds.map((d) => [d.code, d.at]), [["E0408", "extern fn text.encode"]]);
  assert_(ds[0].message.includes("--allow-run"), ds[0].message);
  // Exactly the registration of the README: nothing else is needed.
  const flags = ["--allow-read", "--allow-write", "--allow-run"];
  const written = await serve(cb.dir, flags, "add", { text: ENCODE });
  assertEquals(written.ok, true, JSON.stringify(written));
  // A module that does not load is named with the host's message, without
  // terminal colors (`NO_COLOR` reaches the separate process).
  await Deno.writeTextFile(join(cb.dir, "text.ts"), "export function decode(: string) {}\n" + TEXT_TS);
  const broken = await serve(cb.dir, flags, "add", { text: DECODE });
  const [load] = broken.diagnostics as { code: string; message: string }[];
  assertEquals(load.code, "E0406");
  assert_(load.message.includes("cannot be loaded: SyntaxError"), load.message);
  assert_(!load.message.includes("\x1b["), load.message);
  const left = [...Deno.readDirSync(join(cb.dir, "out"))].filter((e) => e.name.startsWith("accept-"));
  assertEquals(left.map((e) => e.name), []);
  await Deno.remove(cb.dir, { recursive: true });
});

Deno.test("extern db: a server ended by a signal stops the separate process it started", async () => {
  const cb = await fresh();
  cb.close(); // The server process opens it.
  // A module that never finishes loading.
  await Deno.writeTextFile(join(cb.dir, "text.ts"), "while (true) {}\n" + TEXT_TS);
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", "--allow-write", "--allow-run", CLI, "mcp", "--dir", cb.dir],
    stdin: "piped",
    stdout: "null",
    stderr: "null",
  }).spawn();
  const writer = child.stdin.getWriter();
  const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "add", arguments: { text: ENCODE } } };
  await writer.write(new TextEncoder().encode(JSON.stringify(call) + "\n"));
  // The separate processes of this codebase, by their entry's path.
  const isolated = async () => {
    const ps = await new Deno.Command("ps", { args: ["-eo", "args"], stdout: "piped" }).output();
    return new TextDecoder().decode(ps.stdout).split("\n").filter((l) => l.includes(join(cb.dir, "out", "accept-")));
  };
  const until = async (test: () => Promise<boolean>) => {
    for (let i = 0; i < 100 && !(await test()); i++) await new Promise((r) => setTimeout(r, 50));
  };
  await until(async () => (await isolated()).length > 0);
  assertEquals((await isolated()).length, 1);
  child.kill("SIGTERM");
  assertEquals((await child.status).code, 0);
  await until(async () => (await isolated()).length === 0);
  assertEquals(await isolated(), []);
  await writer.close().catch(() => {});
  await Deno.remove(cb.dir, { recursive: true });
});

Deno.test("extern db: the instructions name the module as the one file to write", () => {
  assert_(INSTRUCTIONS.includes("the TypeScript module an `extern fn` names is the one file you write"));
});
