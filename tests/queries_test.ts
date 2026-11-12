// The queries of section 6: signature, context, list, search and history.
// `definition` and `callers` are covered in codebase_test.ts.

import { assert_, assertEquals } from "./assert.ts";
import { add, done, fails, fn, fresh, hashOf, ok, PARSE, PARSE_REORDERED, withPort } from "./db_helpers.ts";
import { hashText } from "../src/codebase.ts";
import { pathText } from "../src/ast.ts";
import { checkProgram } from "../src/check.ts";
import { AlangError } from "../src/diagnostic.ts";
import { casesOf } from "../src/interface.ts";
import { parseProgram } from "../src/parser.ts";
import { printDefinition, printSignature } from "../src/printer.ts";
import { dependencies } from "../src/refs.ts";
import { signatureLine, STD_BY_NAME, STD_TYPES } from "../src/std.ts";

function throwsCode(f: () => unknown, code: string): AlangError {
  try {
    f();
  } catch (e) {
    assert_(e instanceof AlangError, String(e));
    assertEquals(e.diagnostic.code, code);
    return e;
  }
  throw new Error(`expected ${code}`);
}

Deno.test("queries: signature is every section but the body", async () => {
  const cb = await withPort();
  const s = cb.signature("net.port.parse");
  assertEquals(s.hash, hashText(PARSE));
  assertEquals(s.signature, printSignature(parseProgram(PARSE)[0]));
  assert_(!s.signature.includes("body:"));
  assert_(s.signature.includes('  examples:\n    parse(text: "8080")'));
  // A type has no body: its signature is its text.
  assertEquals(cb.signature("net.port.Port").signature, cb.definition("net.port.Port").text);
  throwsCode(() => cb.signature("net.port.nope"), "E0502");
  await done(cb);
});

Deno.test("queries: context lists what a definition uses, then the types of those signatures", async () => {
  const cb = await withPort();
  const c = cb.context("config.load_port");
  assertEquals(c.text, cb.definition("config.load_port").text);
  assertEquals(c.uses.map((u) => u.name), [
    // In order of first use; the cases FileUnreadable and InvalidPort bring their type, config.LoadError.
    "net.port.Port",
    "config.LoadError",
    "std.fs.read_text",
    "std.string.trim",
    "net.port.parse",
    // One level deeper: types in the signatures above.
    "std.fs.ReadError",
    "net.port.ParseError",
  ]);
  const used = new Map(c.uses.map((u) => [u.name, u]));
  assertEquals(used.get("net.port.parse"), {
    name: "net.port.parse",
    hash: hashOf(cb, "net.port.parse"),
    text: cb.signature("net.port.parse").signature,
  });
  assertEquals(used.get("std.fs.read_text"), {
    name: "std.fs.read_text",
    hash: null,
    text: signatureLine(STD_BY_NAME.get("std.fs.read_text")!),
  });
  assertEquals(used.get("std.fs.ReadError")?.text, printDefinition(STD_TYPES[0]));
  assertEquals(
    used.get("std.fs.read_text")?.text,
    'fn std.fs.read_text(path: String): Result<String, std.fs.ReadError>, effects: fs.read, doc: "Reads a whole file as UTF-8 text."',
  );

  // A definition is not listed among its own uses.
  assertEquals(cb.context("net.port.parse").uses.map((u) => u.name), [
    "net.port.Port",
    "net.port.ParseError",
    "std.int.parse",
  ]);
  await done(cb);
});

Deno.test("queries: context covers every reference of every definition (6.5)", async () => {
  const cb = await withPort();
  // Uses cases of another module's type in patterns, and nothing in its signature.
  await ok(cb, [
    add(fn("app.describe", {
      params: ["e: net.port.ParseError"],
      out: "String",
      examples: ['describe(e: net.port.NotANumber) == "not a number"'],
      body: [
        "let text: String = match e",
        "  case net.port.NotANumber then",
        '    "not a number"',
        "  case net.port.OutOfRange(n) then",
        '    "out of range"',
        "end match",
        "return text",
      ].join("\n"),
    })),
  ]);
  // References computed independently of the `refs` table: check the whole
  // program and walk each definition.
  const names = cb.searchText("").filter((h) => h.hash !== null).map((h) => h.name);
  const defs = names.map((n) => parseProgram(cb.definition(n).text)[0]);
  const { diagnostics, info } = checkProgram(defs);
  assertEquals(diagnostics, []);
  const owner = new Map(
    [...STD_TYPES, ...defs].flatMap((d) => casesOf(d).map((c): [string, string] => [c, pathText(d.path)])),
  );
  for (const def of defs) {
    const name = pathText(def.path);
    const listed = new Set(cb.context(name).uses.map((u) => u.name));
    for (const r of dependencies(def, info)) {
      const needed = owner.get(r) ?? r;
      if (needed !== name) assert_(listed.has(needed), `context(${name}) lacks ${needed}`);
    }
  }
  assertEquals(cb.context("app.describe").uses.map((u) => u.name), ["net.port.ParseError"]);
  await done(cb);
});

Deno.test("queries: list gives a module's definitions and submodules", async () => {
  const cb = await withPort();
  const l = cb.list("net.port");
  assertEquals(l.definitions.map((d) => [d.name, d.kind]), [
    ["net.port.ParseError", "type"],
    ["net.port.Port", "type"],
    ["net.port.parse", "fn"],
  ]);
  assertEquals(l.definitions[1], {
    name: "net.port.Port",
    hash: hashOf(cb, "net.port.Port"),
    kind: "type",
    doc: "A valid TCP port number.",
  });
  assertEquals(l.submodules, []);
  assertEquals(cb.list("net"), { module: "net", definitions: [], submodules: ["net.port"] });
  assertEquals(cb.list("").submodules, ["config", "net"]);
  const e = throwsCode(() => cb.list("nett"), "E0502");
  assertEquals(e.diagnostic.fix, { replace: "nett", with: "net" });
  await done(cb);
});

Deno.test("queries: search(text) matches names and doc lines, std included", async () => {
  const cb = await withPort();
  assertEquals(cb.searchText("PORT").map((h) => h.name), [
    "config.load_port",
    "net.port.ParseError",
    "net.port.Port",
    "net.port.parse",
  ]);
  assertEquals(cb.searchText("file").map((h) => [h.name, h.hash === null]), [
    ["config.load_port", false],
    ["std.fs.ReadError", true],
    ["std.fs.read_text", true],
  ]);
  assertEquals(cb.searchText("no such words"), []);
  await done(cb);
});

Deno.test("queries: search(type) matches signatures by pattern", async () => {
  const cb = await withPort();
  const names = (p: string) => cb.searchType(p).map((h) => h.name);
  // A one-segment name matches by last segment, so `Port` is `net.port.Port` here.
  assertEquals(names("String -> Result<Port, _>"), ["config.load_port", "net.port.parse"]);
  assertEquals(names("String -> Result<_, ParseError>"), ["net.port.parse"]);
  assertEquals(names("String -> Result<net.port.Port, _>"), ["config.load_port", "net.port.parse"]);
  assertEquals(names("String -> Result<other.Port, _>"), []);
  assertEquals(names("String -> Option<Int>"), ["std.int.parse"]);
  assertEquals(names("String -> Result<String, _>"), ["std.fs.read_text"]);
  // std type variables match anything; a function-typed parameter only `_`.
  assertEquals(names("List<_>, Int -> _"), ["std.list.append", "std.list.get"]);
  assertEquals(names("List<_>, Int -> Option<_>"), ["std.list.get"]);
  assertEquals(names("List<Int>, _ -> List<_>"), [
    "std.list.append",
    "std.list.filter",
    "std.list.map",
    "std.list.sort",
  ]);
  // A type variable stands for one type throughout a signature.
  assertEquals(names("List<Int>, Int -> List<Int>"), ["std.list.append"]);
  assertEquals(names("List<Int>, String -> List<Int>"), []);
  assertEquals(names("List<String>, _ -> List<Int>"), ["std.list.map"]);
  assertEquals(names("-> _"), ["std.list.empty"]);
  assertEquals(cb.searchType("String -> Result<_, ParseError>")[0], {
    name: "net.port.parse",
    hash: hashOf(cb, "net.port.parse"),
    line:
      'fn net.port.parse(text: String): Result<net.port.Port, net.port.ParseError>, effects: none, doc: "Reads a TCP port number from decimal text."',
  });
  for (const bad of ["String", "String ->", "String -> Result<Int", "-> Int Int", "String, -> Int"]) {
    const e = throwsCode(() => cb.searchType(bad), "E0511");
    assertEquals(e.diagnostic.expected, "String -> Result<Int, _>");
  }
  await done(cb);
});

Deno.test("queries: history lists every version, removals included", async () => {
  const cb = await withPort();
  const h1 = hashOf(cb, "net.port.parse");
  await ok(cb, [{ op: "replace", name: "net.port.parse", hash: h1, text: PARSE_REORDERED }]);
  const h = cb.history("net.port.parse");
  assertEquals(h.hash, hashText(PARSE_REORDERED));
  assertEquals(h.entries.map((e) => [e.hash, e.operation, e.changed_at]), [
    [h1, "add", "2026-11-12T10:00:00.000Z"],
    [hashText(PARSE_REORDERED), "replace", "2026-11-12T10:00:00.000Z"],
  ]);
  // Every earlier hash stays retrievable (6.6).
  await ok(cb, [{ op: "remove", name: "config.load_port", hash: hashOf(cb, "config.load_port") }]);
  const removed = cb.history("config.load_port");
  assertEquals(removed.hash, null);
  assertEquals(removed.entries.map((e) => e.operation), ["add", "remove"]);
  throwsCode(() => cb.definition("config.load_port"), "E0502");
  const e = throwsCode(() => cb.history("config.load_prt"), "E0502");
  assertEquals(e.diagnostic.fix, { replace: "config.load_prt", with: "config.load_port" });
  await done(cb);
});

Deno.test("queries: an empty codebase", async () => {
  const cb = await fresh();
  assertEquals(cb.searchText("x").every((h) => h.hash === null), true);
  throwsCode(() => cb.list(""), "E0502");
  assertEquals((await fails(cb, [{ op: "remove", name: "m.a", hash: "0".repeat(16) }])).diagnostics[0].code, "E0502");
  await done(cb);
});
