// The codebase as a database (section 6): storage, the hash guard, and
// transactions of add, replace and remove.

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assert_, assertEquals } from "./assert.ts";
import { type Change, Codebase, hashText, type SubmitResult } from "../src/codebase.ts";
import type { Diagnostic } from "../src/diagnostic.ts";
import { AlangError } from "../src/diagnostic.ts";
import { parseProgram } from "../src/parser.ts";
import { printDefinition, printSignature } from "../src/printer.ts";

const spec = await Deno.readTextFile(new URL("../alang-specs.md", import.meta.url));
const specBlock = (firstLine: string): string => {
  const m = [...spec.matchAll(/^```\n([\s\S]*?)^```$/gm)].find((m) => m[1].startsWith(firstLine + "\n"));
  if (!m) throw new Error(`spec block not found: ${firstLine}`);
  return m[1];
};
// The single definitions of a spec block, as canonical texts.
const texts = (source: string): string[] => parseProgram(source).map(printDefinition);

const [PORT, PARSE_ERROR, PARSE] = texts(specBlock("type net.port.Port"));
const [LOAD_PORT] = texts(specBlock("fn config.load_port"));
const LOAD_ERROR = `type config.LoadError
  doc: "Why the configuration could not be loaded."
  variant:
    FileUnreadable: std.fs.ReadError
    InvalidPort: net.port.ParseError
  where: none
end type config.LoadError`;

// A function `<module>.<name>` with the given sections.
function fn(
  name: string,
  o: { params?: string[]; out: string; effects?: string; examples?: string[]; body: string },
): string {
  const short = name.slice(name.lastIndexOf(".") + 1);
  return [
    `fn ${name}`,
    `  doc: "${short}."`,
    o.params ? ["  in:", ...o.params.map((p) => `    ${p}`)].join("\n") : "  in: none",
    `  out: ${o.out}`,
    `  effects: ${o.effects ?? "none"}`,
    "  requires: none",
    "  ensures: none",
    o.examples ? ["  examples:", ...o.examples.map((e) => `    ${e}`)].join("\n") : "  examples: none",
    "  body:",
    ...o.body.split("\n").map((l) => `    ${l}`),
    `end fn ${name}`,
  ].join("\n");
}

const CLOCK = () => new Date("2026-11-12T10:00:00.000Z");

async function fresh(): Promise<Codebase> {
  return await Codebase.open(await Deno.makeTempDir({ prefix: "alang-db-" }), { clock: CLOCK });
}

async function done(cb: Codebase): Promise<void> {
  cb.close();
  await Deno.remove(cb.dir, { recursive: true });
}

const add = (text: string): Change => ({ op: "add", text });

async function ok(cb: Codebase, changes: Change[]): Promise<Extract<SubmitResult, { ok: true }>> {
  const r = await cb.submit(changes);
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics, null, 2));
  return r;
}

async function fails(cb: Codebase, changes: Change[]): Promise<Extract<SubmitResult, { ok: false }>> {
  const r = await cb.submit(changes);
  if (r.ok) throw new Error(`expected a rejection, got ${JSON.stringify(r)}`);
  return r;
}

const codes = (ds: readonly Diagnostic[]) => ds.map((d) => d.code);
const hashOf = (cb: Codebase, name: string) => cb.definition(name).hash;

// Every row of every table, for "a rejected transaction changes nothing".
function dump(cb: Codebase): Record<string, unknown[]> {
  const db = new DatabaseSync(join(cb.dir, "alang.db"), { readOnly: true });
  try {
    const all = (sql: string) => db.prepare(sql).all().map((r) => ({ ...r }));
    return {
      definitions: all("SELECT * FROM definitions ORDER BY hash"),
      names: all("SELECT * FROM names ORDER BY name"),
      refs: all("SELECT rowid, * FROM refs ORDER BY rowid"),
      history: all("SELECT * FROM history ORDER BY id"),
    };
  } finally {
    db.close();
  }
}

async function withPort(): Promise<Codebase> {
  const cb = await fresh();
  await ok(cb, [PORT, PARSE_ERROR, PARSE, LOAD_PORT, LOAD_ERROR].map(add));
  return cb;
}

// The body of net.port.parse with its condition reordered: same behaviour.
const PARSE_REORDERED = PARSE.replace("if n < 1 or n > 65_535 then", "if n > 65_535 or n < 1 then");

// ---- storage ----

Deno.test("codebase: add stores canonical text under the hash of that text", async () => {
  const cb = await withPort();
  const v = cb.definition("net.port.parse");
  assertEquals(v.text, PARSE);
  assertEquals(v.hash, hashText(PARSE));
  assertEquals(v.hash.length, 16);
  await done(cb);
});

Deno.test("codebase: every stored row round-trips and matches its hash and signature", async () => {
  const cb = await withPort();
  await ok(cb, [{ op: "replace", name: "net.port.parse", hash: hashOf(cb, "net.port.parse"), text: PARSE_REORDERED }]);
  const rows = dump(cb).definitions as { hash: string; kind: string; text: string; signature: string }[];
  assertEquals(rows.length, 6);
  for (const row of rows) {
    const defs = parseProgram(row.text);
    assertEquals(defs.length, 1);
    assertEquals(printDefinition(defs[0]), row.text);
    assertEquals(hashText(row.text), row.hash);
    assertEquals(printSignature(defs[0]), row.signature);
    assertEquals(defs[0].kind, row.kind);
  }
  await done(cb);
});

Deno.test("codebase: history records each change in order", async () => {
  const cb = await withPort();
  const h1 = hashOf(cb, "net.port.parse");
  await ok(cb, [{ op: "replace", name: "net.port.parse", hash: h1, text: PARSE_REORDERED }]);
  const history = dump(cb).history as { name: string; hash: string; operation: string; changed_at: string }[];
  assertEquals(history.map((h) => [h.name, h.operation]), [
    ["net.port.Port", "add"],
    ["net.port.ParseError", "add"],
    ["net.port.parse", "add"],
    ["config.load_port", "add"],
    ["config.LoadError", "add"],
    ["net.port.parse", "replace"],
  ]);
  assertEquals(history[2].hash, h1);
  assertEquals(history[5].hash, hashText(PARSE_REORDERED));
  assertEquals(history[5].changed_at, "2026-11-12T10:00:00.000Z");
  await done(cb);
});

// ---- callers and the interface rule ----

Deno.test("codebase: callers survive a body-only replace", async () => {
  const cb = await withPort();
  assertEquals(cb.callers("net.port.parse").callers, ["config.load_port"]);
  const r = await ok(cb, [
    { op: "replace", name: "net.port.parse", hash: hashOf(cb, "net.port.parse"), text: PARSE_REORDERED },
  ]);
  assertEquals(r.written, [{ name: "net.port.parse", hash: hashText(PARSE_REORDERED), operation: "replace" }]);
  assertEquals(cb.callers("net.port.parse"), {
    name: "net.port.parse",
    hash: hashText(PARSE_REORDERED),
    callers: ["config.load_port"],
  });
  // A type's callers include the users of its cases; a type is not its own caller.
  assertEquals(cb.callers("net.port.ParseError").callers, ["config.LoadError", "net.port.parse"]);
  assertEquals(cb.callers("net.port.Port").callers, ["config.load_port", "net.port.parse"]);
  await done(cb);
});

Deno.test("codebase: an interface change with callers outside the transaction is rejected", async () => {
  const cb = await withPort();
  const renamedParam = PARSE.replaceAll("text: ", "source: ").replace(
    "std.int.parse(source: text)",
    "std.int.parse(text: source)",
  );
  const r = await fails(cb, [{
    op: "replace",
    name: "net.port.parse",
    hash: hashOf(cb, "net.port.parse"),
    text: renamedParam,
  }]);
  assertEquals(codes(r.diagnostics), ["E0506"]);
  assertEquals(r.diagnostics[0].definition, "net.port.parse");
  assertEquals(r.diagnostics[0].at, `replace(net.port.parse, ${hashOf(cb, "net.port.parse")})`);
  assert_(r.diagnostics[0].message.includes("`in`"), r.diagnostics[0].message);
  assert_(r.diagnostics[0].message.includes("`config.load_port`"), r.diagnostics[0].message);

  // With the caller adapted in the same transaction it is accepted (6.4).
  await ok(cb, [
    { op: "replace", name: "net.port.parse", hash: hashOf(cb, "net.port.parse"), text: renamedParam },
    {
      op: "replace",
      name: "config.load_port",
      hash: hashOf(cb, "config.load_port"),
      text: LOAD_PORT.replace("net.port.parse(text: trimmed)", "net.port.parse(source: trimmed)"),
    },
  ]);
  await done(cb);
});

Deno.test("codebase: doc, examples and full spelling of a type are not interface changes", async () => {
  const cb = await withPort();
  const parse = PARSE
    .replace("Reads a TCP port number", "Parses a TCP port number")
    .replace("  examples:\n", '  examples:\n    parse(text: "1") == Ok(Port(value: 1))\n')
    .replace("out: Result<Port, ParseError>", "out: Result<net.port.Port, ParseError>");
  await ok(cb, [{ op: "replace", name: "net.port.parse", hash: hashOf(cb, "net.port.parse"), text: parse }]);
  const error = PARSE_ERROR.replace("Reasons why", "Why");
  await ok(cb, [{ op: "replace", name: "net.port.ParseError", hash: hashOf(cb, "net.port.ParseError"), text: error }]);
  await done(cb);
});

Deno.test("codebase: a changed variant lists the users of the type and of its cases", async () => {
  const cb = await withPort();
  const more = PARSE_ERROR.replace("    NotANumber\n", "    NotANumber\n    Empty\n");
  const r = await fails(cb, [
    { op: "replace", name: "net.port.ParseError", hash: hashOf(cb, "net.port.ParseError"), text: more },
  ]);
  assertEquals(codes(r.diagnostics), ["E0506"]);
  assert_(r.diagnostics[0].message.includes("`variant`"), r.diagnostics[0].message);
  assert_(r.diagnostics[0].message.includes("`config.LoadError`, `net.port.parse`"), r.diagnostics[0].message);
  await done(cb);
});

// m.a <- m.b <- m.c (console), m.b <- m.d (none). a gains `console`.
const A = fn("m.a", { params: ["n: Int"], out: "Int", examples: ["a(n: 1) == 2"], body: "return n + 1" });
const A_CONSOLE = fn("m.a", {
  params: ["n: Int"],
  out: "Int",
  effects: "console",
  body: 'std.console.print_line(text: "a")\nreturn n + 1',
});
const B = fn("m.b", { params: ["n: Int"], out: "Int", examples: ["b(n: 1) == 2"], body: "return a(n: n)" });
const C = fn("m.c", { out: "Unit", effects: "console", body: "let x: Int = b(n: 1)\nreturn Unit" });
const D = fn("m.d", { out: "Int", examples: ["d() == 2"], body: "return b(n: 1)" });

Deno.test("codebase: an added effect lists every caller that would lack it, transitively", async () => {
  const cb = await fresh();
  await ok(cb, [A, B, C, D].map(add));
  const r = await fails(cb, [{ op: "replace", name: "m.a", hash: hashOf(cb, "m.a"), text: A_CONSOLE }]);
  assertEquals(codes(r.diagnostics), ["E0506"]);
  assert_(r.diagnostics[0].message.includes("adds the effects `console`"), r.diagnostics[0].message);
  // m.c declares console already; m.d calls m.b, which would need it.
  assert_(r.diagnostics[0].message.includes("which affects `m.b`, `m.d`."), r.diagnostics[0].message);
  await done(cb);
});

Deno.test("codebase: removing an effect is compatible", async () => {
  const cb = await fresh();
  const e = fn("m.e", { out: "Int", effects: "console", body: "return 1" });
  const f = fn("m.f", { out: "Unit", effects: "console", body: "let x: Int = e()\nreturn Unit" });
  await ok(cb, [add(e), add(f)]);
  const pure = fn("m.e", { out: "Int", examples: ["e() == 1"], body: "return 1" });
  await ok(cb, [{ op: "replace", name: "m.e", hash: hashOf(cb, "m.e"), text: pure }]);
  await done(cb);
});

// ---- remove ----

Deno.test("codebase: remove is rejected while callers exist outside the transaction", async () => {
  const cb = await withPort();
  const r = await fails(cb, [{ op: "remove", name: "net.port.parse", hash: hashOf(cb, "net.port.parse") }]);
  assertEquals(codes(r.diagnostics), ["E0507"]);
  assert_(r.diagnostics[0].message.includes("`config.load_port`"), r.diagnostics[0].message);
  // Removed together with its only caller, it goes.
  const w = await ok(cb, [
    { op: "remove", name: "net.port.parse", hash: hashOf(cb, "net.port.parse") },
    { op: "remove", name: "config.load_port", hash: hashOf(cb, "config.load_port") },
  ]);
  assertEquals(w.written.map((x) => [x.name, x.hash, x.operation]), [
    ["net.port.parse", null, "remove"],
    ["config.load_port", null, "remove"],
  ]);
  assertEquals((dump(cb).names as { name: string }[]).map((n) => n.name), [
    "config.LoadError",
    "net.port.ParseError",
    "net.port.Port",
  ]);
  await done(cb);
});

Deno.test("codebase: a recursive function can be removed", async () => {
  const cb = await fresh();
  const sum = fn("m.sum", {
    params: ["n: Int"],
    out: "Int",
    examples: ["sum(n: 3) == 6"],
    body: "if n <= 0 then\n  return 0\nend if\nreturn n + sum(n: n - 1)",
  });
  await ok(cb, [add(sum)]);
  assertEquals(cb.callers("m.sum").callers, []);
  await ok(cb, [{ op: "remove", name: "m.sum", hash: hashOf(cb, "m.sum") }]);
  // The empty program is accepted.
  assertEquals(dump(cb).names, []);
  await done(cb);
});

// ---- the guard and the operations' own checks ----

Deno.test("codebase: a stale hash is rejected with the current version", async () => {
  const cb = await withPort();
  const old = hashOf(cb, "net.port.parse");
  await ok(cb, [{ op: "replace", name: "net.port.parse", hash: old, text: PARSE_REORDERED }]);
  const r = await fails(cb, [{ op: "remove", name: "net.port.parse", hash: old }]);
  assertEquals(codes(r.diagnostics), ["E0501"]);
  assertEquals(r.diagnostics[0].fix, { replace: old, with: hashText(PARSE_REORDERED) });
  assertEquals(r.current, [{ name: "net.port.parse", hash: hashText(PARSE_REORDERED), text: PARSE_REORDERED }]);
  await done(cb);
});

Deno.test("codebase: unknown names, existing names, and malformed submissions", async () => {
  const cb = await withPort();
  const h = hashOf(cb, "net.port.parse");

  const unknown = await fails(cb, [{ op: "remove", name: "net.port.pars", hash: h }]);
  assertEquals(codes(unknown.diagnostics), ["E0502"]);
  assertEquals(unknown.diagnostics[0].fix, { replace: "net.port.pars", with: "net.port.parse" });

  const exists = await fails(cb, [add(PARSE_REORDERED)]);
  assertEquals(codes(exists.diagnostics), ["E0503"]);
  assertEquals(exists.diagnostics[0].at, "add(net.port.parse)");
  assertEquals(exists.current.map((v) => v.hash), [h]);

  const two = await fails(cb, [add(A + "\n\n" + B)]);
  assertEquals(codes(two.diagnostics), ["E0504"]);
  assert_(two.diagnostics[0].message.includes("`m.a`, `m.b`"), two.diagnostics[0].message);

  const other = await fails(cb, [{ op: "replace", name: "net.port.parse", hash: h, text: A }]);
  assertEquals(codes(other.diagnostics), ["E0505"]);
  assertEquals(other.diagnostics[0].expected, "fn net.port.parse");

  const twice = await fails(cb, [
    { op: "replace", name: "net.port.parse", hash: h, text: PARSE_REORDERED },
    { op: "remove", name: "net.port.parse", hash: h },
  ]);
  assertEquals(codes(twice.diagnostics), ["E0508"]);

  // Parse errors come from the parser; every failing change is reported (5.6).
  const broken = await fails(cb, [add("fn m.x\n  doc: 1"), { op: "remove", name: "m.nope", hash: h }]);
  assertEquals(broken.diagnostics.length, 2);
  assertEquals(broken.diagnostics[1].code, "E0502");
  await done(cb);
});

Deno.test("codebase: a rejected transaction leaves every table untouched", async () => {
  const cb = await withPort();
  const double = fn("m.double", {
    params: ["n: Int"],
    out: "Int",
    examples: ["double(n: 1) == 2"],
    body: "return n * 2",
  });
  const quad = fn("m.quad", {
    params: ["n: Int"],
    out: "Int",
    examples: ["quad(n: 1) == 4"],
    body: "return double(n: double(n: n))",
  });
  await ok(cb, [add(double), add(quad)]);
  const before = dump(cb);
  const h = hashOf(cb, "net.port.parse");

  // The guard.
  assertEquals(codes((await fails(cb, [{ op: "remove", name: "net.port.parse", hash: "0".repeat(16) }])).diagnostics), [
    "E0501",
  ]);
  // The interface rule.
  const outChanged = PARSE.replace("out: Result<Port, ParseError>", "out: Result<Int, ParseError>");
  assertEquals(
    codes((await fails(cb, [{ op: "replace", name: "net.port.parse", hash: h, text: outChanged }])).diagnostics),
    ["E0506"],
  );
  // A type error, in a transaction that also holds a valid change.
  const typeError = PARSE_REORDERED.replace("return Ok(Port(value: n))", "return Ok(n)");
  const r = await fails(cb, [add(fn("m.ok", { out: "Int", examples: ["ok() == 1"], body: "return 1" })), {
    op: "replace",
    name: "net.port.parse",
    hash: h,
    text: typeError,
  }]);
  assertEquals(r.diagnostics.every((d) => d.code.startsWith("E02")), true, JSON.stringify(r.diagnostics));
  // A caller's example broken by a changed body.
  const triple = fn("m.double", {
    params: ["n: Int"],
    out: "Int",
    examples: ["double(n: 1) == 3"],
    body: "return n * 3",
  });
  const broken = await fails(cb, [{ op: "replace", name: "m.double", hash: hashOf(cb, "m.double"), text: triple }]);
  assertEquals(codes(broken.diagnostics), ["E0402"]);
  assertEquals(broken.diagnostics[0].definition, "m.quad");

  assertEquals(dump(cb), before);
  await done(cb);
});

// ---- versions ----

Deno.test("codebase: a revert reuses the earlier version", async () => {
  const cb = await withPort();
  const h1 = hashOf(cb, "net.port.parse");
  await ok(cb, [{ op: "replace", name: "net.port.parse", hash: h1, text: PARSE_REORDERED }]);
  const back = await ok(cb, [{ op: "replace", name: "net.port.parse", hash: hashText(PARSE_REORDERED), text: PARSE }]);
  assertEquals(back.written, [{ name: "net.port.parse", hash: h1, operation: "replace" }]);
  const tables = dump(cb);
  assertEquals(tables.definitions.length, 6);
  const history = (tables.history as { name: string; hash: string }[]).filter((h) => h.name === "net.port.parse");
  assertEquals(history.map((h) => h.hash), [h1, hashText(PARSE_REORDERED), h1]);
  // Removed and added again: the same version, a new history entry.
  await ok(cb, [
    { op: "remove", name: "config.load_port", hash: hashOf(cb, "config.load_port") },
  ]);
  await ok(cb, [add(LOAD_PORT)]);
  assertEquals(hashOf(cb, "config.load_port"), hashText(LOAD_PORT));
  assertEquals(dump(cb).definitions.length, 6);
  assertEquals(cb.callers("net.port.parse").callers, ["config.load_port"]);
  await done(cb);
});

Deno.test("codebase: replacing with the same text writes nothing", async () => {
  const cb = await withPort();
  const before = dump(cb);
  const r = await ok(cb, [{ op: "replace", name: "net.port.parse", hash: hashOf(cb, "net.port.parse"), text: PARSE }]);
  assertEquals(r.written, []);
  assertEquals(r.unchanged, ["net.port.parse"]);
  assertEquals(dump(cb), before);
  await done(cb);
});

Deno.test("codebase: queries on unknown names throw E0502", async () => {
  const cb = await withPort();
  try {
    cb.definition("net.port.Prt");
    throw new Error("expected E0502");
  } catch (e) {
    assert_(e instanceof AlangError);
    assertEquals(e.diagnostic.code, "E0502");
    assertEquals(e.diagnostic.fix, { replace: "net.port.Prt", with: "net.port.Port" });
  }
  await done(cb);
});

Deno.test("codebase: submits run one at a time", async () => {
  const cb = await fresh();
  const results = await Promise.all([
    cb.submit([add(A)]),
    cb.submit([add(B)]),
    cb.submit([add(fn("m.one", { out: "Int", examples: ["one() == 1"], body: "return 1" }))]),
  ]);
  assertEquals(results.map((r) => r.ok), [true, true, true]);
  await done(cb);
});
