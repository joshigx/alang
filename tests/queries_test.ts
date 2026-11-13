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
    "std.fs.Error",
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
  assertEquals(used.get("std.fs.Error")?.text, printDefinition(STD_TYPES[0]));
  assertEquals(
    used.get("std.fs.read_text")?.text,
    'fn std.fs.read_text(path: String): Result<String, std.fs.Error>, effects: fs.read, doc: "Reads a whole file as UTF-8 text."',
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

Deno.test("queries: context of a server shows std.http as text, serve's handler with its effects", async () => {
  const cb = await fresh();
  const empty = "std.list.empty<std.http.Header>()";
  await ok(cb, [
    add(fn("web.handle", {
      params: ["request: std.http.Request"],
      out: "std.http.Response",
      effects: "console",
      body:
        `std.console.print_line(text: request.path)\nreturn std.http.Response(status: 200, headers: ${empty}, content: "")`,
    })),
    add(fn("web.main", {
      out: "Unit",
      effects: "net, console",
      body:
        'let served: Unit = std.http.serve(host: "localhost", port: 8080, handler: handle) else return Unit\nreturn Unit',
    })),
  ]);
  const handle = new Map(cb.context("web.handle").uses.map((u) => [u.name, u.text]));
  for (const name of ["std.http.Request", "std.http.Response", "std.http.Header"]) {
    assertEquals(handle.get(name), printDefinition(STD_TYPES.find((d) => pathText(d.path) === name)!));
  }
  const main = new Map(cb.context("web.main").uses.map((u) => [u.name, u.text]));
  assertEquals(
    main.get("std.http.serve")?.split(", doc:")[0],
    "fn std.http.serve(host: String, port: Int, handler: (std.http.Request) -> std.http.Response with effects): Result<Unit, std.http.ServeError>, effects: net",
  );
  // Passing the handler is a reference: it has a caller, and context lists it.
  assertEquals(cb.callers("web.handle").callers, ["web.main"]);
  assert_(main.has("web.handle"));
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

Deno.test("queries: std names are read like definitions, without a hash, and cannot be changed", async () => {
  const cb = await withPort();
  const request = printDefinition(STD_TYPES.find((d) => pathText(d.path) === "std.http.Request")!);
  assertEquals(cb.definition("std.http.Request"), { name: "std.http.Request", hash: null, text: request });
  assertEquals(cb.signature("std.http.Request").signature, request);
  // A std function has no alang body: its text is the line search_type gives.
  const serve = signatureLine(STD_BY_NAME.get("std.http.serve")!);
  assertEquals(cb.definition("std.http.serve").text, serve);
  assertEquals(cb.signature("std.http.serve"), { name: "std.http.serve", hash: null, signature: serve });
  // context: the types of the signature, those the handler takes and returns
  // included, then the types in theirs (Header).
  const context = cb.context("std.http.serve");
  assertEquals([context.hash, context.text], [null, serve]);
  assertEquals(context.uses.map((u) => [u.name, u.hash]), [
    ["std.http.Request", null],
    ["std.http.Response", null],
    ["std.http.ServeError", null],
    ["std.http.Header", null],
  ]);
  assertEquals(context.uses[0].text, request);
  assertEquals(cb.context("std.list.map").uses, []);
  // callers: the codebase's users.
  assertEquals(cb.callers("std.int.parse"), { name: "std.int.parse", hash: null, callers: ["net.port.parse"] });
  assertEquals(cb.callers("std.fs.Error").callers, ["config.LoadError"]);
  // list: std is reached by name, and is not one of the codebase's modules.
  assertEquals(cb.list("std").submodules, [
    "std.console",
    "std.env",
    "std.float",
    "std.fs",
    "std.http",
    "std.int",
    "std.list",
    "std.log",
    "std.map",
    "std.random",
    "std.string",
    "std.text",
    "std.time",
  ]);
  assertEquals(cb.list("std.http").definitions.map((d) => [d.name, d.kind, d.hash]), [
    ["std.http.Header", "type", null],
    ["std.http.Request", "type", null],
    ["std.http.Response", "type", null],
    ["std.http.ServeError", "type", null],
    ["std.http.serve", "fn", null],
  ]);
  assertEquals(cb.list("").submodules, ["config", "net"]);
  // Misspelled std names and modules get a fix.
  assertEquals(throwsCode(() => cb.context("std.http.Requst"), "E0502").diagnostic.fix, {
    replace: "std.http.Requst",
    with: "std.http.Request",
  });
  assertEquals(throwsCode(() => cb.list("std.htp"), "E0502").diagnostic.fix?.with, "std.http");
  // No history, no changes: the message says why instead of "no definition".
  const history = throwsCode(() => cb.history("std.http.serve"), "E0502").diagnostic;
  assert_(history.message.includes("belongs to the standard library"), history.message);
  const removed = await fails(cb, [{ op: "remove", name: "std.int.parse", hash: "0".repeat(16) }]);
  assertEquals(removed.diagnostics.map((d) => [d.code, d.message.includes("standard library")]), [["E0502", true]]);
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
    ["std.fs.Error", true],
    ["std.fs.Kind", true],
    ["std.fs.append_text", true],
    ["std.fs.kind", true],
    ["std.fs.read_text", true],
    ["std.fs.remove", true],
    ["std.fs.write_text", true],
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
  assertEquals(names("List<_>, Int -> _"), [
    "std.list.append",
    "std.list.contains",
    "std.list.drop",
    "std.list.get",
    "std.list.take",
    "std.list.window",
  ]);
  assertEquals(names("List<_>, Int -> Option<_>"), ["std.list.get"]);
  assertEquals(names("List<Int>, _ -> List<_>"), [
    "std.list.append",
    "std.list.concat",
    "std.list.drop",
    "std.list.enumerate",
    "std.list.filter",
    "std.list.map",
    "std.list.sort",
    "std.list.take",
    "std.list.window",
  ]);
  // A type variable stands for one type throughout a signature.
  assertEquals(names("List<Int>, Int -> List<Int>"), ["std.list.append", "std.list.drop", "std.list.take"]);
  assertEquals(names("List<Int>, String -> List<Int>"), []);
  assertEquals(names("List<String>, _ -> List<Int>"), ["std.list.enumerate", "std.list.map"]);
  assertEquals(names("-> _"), [
    "std.console.read_line",
    "std.env.args",
    "std.list.empty",
    "std.map.empty",
    "std.time.now_milliseconds",
  ]);
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
  assertEquals(cb.list(""), { module: "", definitions: [], submodules: [] });
  throwsCode(() => cb.list("m"), "E0502");
  assertEquals((await fails(cb, [{ op: "remove", name: "m.a", hash: "0".repeat(16) }])).diagnostics[0].code, "E0502");
  await done(cb);
});
