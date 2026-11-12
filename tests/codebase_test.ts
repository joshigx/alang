// The codebase as a database (section 6): storage, the hash guard, and
// transactions of add, replace and remove.

import { assert_, assertEquals } from "./assert.ts";
import {
  add,
  CLOCK,
  codes,
  done,
  dump,
  fails,
  fn,
  fresh,
  hashOf,
  LOAD_ERROR,
  LOAD_PORT,
  ok,
  PARSE,
  PARSE_ERROR,
  PARSE_REORDERED,
  PORT,
  withPort,
} from "./db_helpers.ts";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Codebase, hashText } from "../src/codebase.ts";
import { AlangError } from "../src/diagnostic.ts";
import { parseProgram } from "../src/parser.ts";
import { printDefinition, printSignature } from "../src/printer.ts";

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

Deno.test("codebase: doc and examples are not interface changes", async () => {
  const cb = await withPort();
  const parse = PARSE
    .replace("Reads a TCP port number", "Parses a TCP port number")
    .replace("  examples:\n", '  examples:\n    parse(text: "1") == Ok(Port(value: 1))\n');
  // A name of the own module has one spelling, the short one (1.2): a full
  // spelling is stored short, so it cannot pose as a changed type.
  const long = parse.replace("out: Result<Port, ParseError>", "out: Result<net.port.Port, ParseError>");
  const hash = hashOf(cb, "net.port.parse");
  const r = await ok(cb, [{ op: "replace", name: "net.port.parse", hash, text: long }]);
  assertEquals(codes(r.fixed!), ["E0226"]);
  assertEquals(cb.definition("net.port.parse").text, parse);
  const error = PARSE_ERROR.replace("Reasons why", "Why");
  await ok(cb, [{ op: "replace", name: "net.port.ParseError", hash: hashOf(cb, "net.port.ParseError"), text: error }]);
  await done(cb);
});

Deno.test("codebase: own-module names written in full are stored short (1.2)", async () => {
  const cb = await fresh();
  await ok(cb, [add(fn("m.one", { out: "Int", examples: ["one() == 1"], body: "return 1" }))]);

  // In a call and an example: accepted, stored short, and the applied E0226
  // listed under `fixed`, one per place.
  const two = fn("m.two", { out: "Int", examples: ["two() == 2"], body: "return one() + one()" });
  const long = two.replace("two() == 2", "m.two() == 2").replace("one() + one()", "m.one() + m.one()");
  const r = await ok(cb, [add(long)]);
  assertEquals(
    new Set(r.fixed!.map((d) => `${d.code} ${d.definition} ${d.fix!.replace} -> ${d.fix!.with}`)),
    new Set([
      "E0226 m.two m.one -> one",
      "E0226 m.two m.two -> two",
    ]),
  );
  assertEquals(r.fixed!.length, 3);
  assertEquals(cb.definition("m.two").text, two);
  assertEquals(cb.definition("m.two").hash, hashText(two));
  assertEquals(
    (await ok(cb, [add(fn("m.zero", { out: "Int", examples: ["zero() == 0"], body: "return 0" }))])).fixed,
    undefined,
  );

  // With any other complaint nothing is shortened, so every diagnostic
  // quotes the text as sent (5.5).
  const before = dump(cb);
  const typo = await fails(cb, [
    add(fn("m.three", { out: "Int", examples: ["three() == 3"], body: "return m.one() + tw()" })),
  ]);
  assertEquals(codes(typo.diagnostics).sort(), ["E0201", "E0226"]);
  // A failing example is found only once the names are shortened; the
  // applied E0226 come first, since the example is quoted short.
  const wrong = await fails(cb, [add(fn("m.three", { out: "Int", examples: ["m.three() == 4"], body: "return 3" }))]);
  assertEquals(codes(wrong.diagnostics), ["E0226", "E0402"]);
  assertEquals(dump(cb), before);

  // A contract that names its module in full is the same contract: no
  // interface change pulls the callers in (E0506).
  const b = fn("m.b", { params: ["n: Int"], out: "Int", examples: ["b(n: 1) == 1"], body: "return n" })
    .replace("  requires: none", "  requires: n >= one()");
  const c = fn("m.c", {
    out: "Unit",
    effects: "console",
    body: 'let x: Int = b(n: 1)\nstd.console.print_line(text: "c")\nreturn Unit',
  });
  await ok(cb, [add(b), add(c)]);
  const same = b.replace("n >= one()", "n >= m.one()");
  const s = await ok(cb, [{ op: "replace", name: "m.b", hash: hashOf(cb, "m.b"), text: same }]);
  assertEquals([s.unchanged, codes(s.fixed!)], [["m.b"], ["E0226"]]);
  await done(cb);
});

Deno.test("codebase: a full own-module name that a local would capture is stored as written", async () => {
  // `by: backwards` would be the parameter, so `m.backwards` is the only
  // spelling of the function there; it is neither reported nor shortened.
  const cb = await fresh();
  const backwards = fn("m.backwards", {
    params: ["left: Int", "right: Int"],
    out: "Order",
    examples: ["backwards(left: 1, right: 2) == Greater"],
    body: "return std.int.compare(left: right, right: left)",
  });
  const sorted = fn("m.sorted", {
    params: ["backwards: Int"],
    out: "List<Int>",
    examples: ["sorted(backwards: 0) == std.list.empty<Int>()"],
    body: "let xs: List<Int> = std.list.empty<Int>()\nreturn std.list.sort(list: xs, by: m.backwards)",
  });
  const r = await ok(cb, [add(backwards), add(sorted)]);
  assertEquals(r.fixed, undefined);
  assertEquals(cb.definition("m.sorted").text, sorted);
  await done(cb);
});

Deno.test("codebase: a changed contract is an interface change", async () => {
  // m.c has effects, so it has no examples (5.4): only the rule protects it
  // from a tightened `requires`, which would trap at runtime.
  const cb = await fresh();
  const b = fn("m.b", { params: ["n: Int"], out: "Int", examples: ["b(n: 1) == 1"], body: "return n" });
  const c = fn("m.c", {
    out: "Unit",
    effects: "console",
    body: 'let x: Int = b(n: -1)\nstd.console.print_line(text: "c")\nreturn Unit',
  });
  await ok(cb, [add(b), add(c)]);
  const tightened = b.replace("  requires: none", "  requires: n >= 0");
  const r = await fails(cb, [{ op: "replace", name: "m.b", hash: hashOf(cb, "m.b"), text: tightened }]);
  assertEquals(codes(r.diagnostics), ["E0506"]);
  assert_(r.diagnostics[0].message.includes("`requires`") && r.diagnostics[0].message.includes("`m.c`"));
  const ensures = b.replace("  ensures: none", "  ensures: result == n");
  assertEquals(
    codes((await fails(cb, [{ op: "replace", name: "m.b", hash: hashOf(cb, "m.b"), text: ensures }])).diagnostics),
    [
      "E0506",
    ],
  );
  // A type's `where` counts too.
  await ok(cb, [add(PORT), add(PARSE_ERROR), add(PARSE)]);
  const wider = PORT.replace("where: 1 <= value and value <= 65_535", "where: 0 <= value and value <= 65_535");
  const w = await fails(cb, [{ op: "replace", name: "net.port.Port", hash: hashOf(cb, "net.port.Port"), text: wider }]);
  assertEquals(codes(w.diagnostics), ["E0506"]);
  assert_(w.diagnostics[0].message.includes("`where`"), w.diagnostics[0].message);
  // Submitting the callers unchanged in the same transaction is the way through (6.4).
  const through = await ok(cb, [
    { op: "replace", name: "m.b", hash: hashOf(cb, "m.b"), text: tightened },
    { op: "replace", name: "m.c", hash: hashOf(cb, "m.c"), text: c },
  ]);
  assertEquals(through.unchanged, ["m.c"]);
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

Deno.test("codebase: a write by another connection during acceptance restarts the submit", async () => {
  // The clock is read once per attempt, after acceptance and before the
  // write; `during` runs there once, as another process would.
  let during: (() => void) | null = null;
  let attempts = 0;
  const clock = () => {
    attempts++;
    const f = during;
    during = null;
    f?.();
    return CLOCK();
  };
  const dir = await Deno.makeTempDir({ prefix: "alang-db-" });
  const cb = await Codebase.open(dir, { clock });
  await ok(cb, [PORT, PARSE_ERROR, PARSE, LOAD_PORT, LOAD_ERROR].map(add));
  const other = () => new DatabaseSync(join(dir, "alang.db"));

  // Another process adds an unrelated definition: the submit starts over and
  // succeeds on top of it.
  const one = printDefinition(parseProgram(fn("m.one", { out: "Int", examples: ["one() == 1"], body: "return 1" }))[0]);
  during = () => {
    const db = other();
    db.prepare("INSERT INTO definitions (hash, kind, text, signature) VALUES (?, 'fn', ?, ?)")
      .run(hashText(one), one, printSignature(parseProgram(one)[0]));
    db.prepare("INSERT INTO refs (from_hash, to_name) VALUES (?, 'm.one')").run(hashText(one));
    db.prepare("INSERT INTO names (name, hash) VALUES ('m.one', ?)").run(hashText(one));
    db.close();
  };
  attempts = 0;
  await ok(cb, [{ op: "replace", name: "net.port.parse", hash: hashOf(cb, "net.port.parse"), text: PARSE_REORDERED }]);
  assertEquals(attempts, 2);
  assertEquals(cb.definition("m.one").text, one);
  assertEquals(cb.definition("net.port.parse").text, PARSE_REORDERED);

  // Another process replaces the very definition: the restart reports the stale guard.
  const h = hashOf(cb, "net.port.parse");
  during = () => {
    const db = other();
    db.prepare("UPDATE names SET hash = ? WHERE name = 'net.port.parse'").run(hashText(PARSE));
    db.close();
  };
  const r = await fails(cb, [{
    op: "replace",
    name: "net.port.parse",
    hash: h,
    text: PARSE.replace("Reads", "Parses"),
  }]);
  assertEquals(codes(r.diagnostics), ["E0501"]);
  assertEquals(r.current.map((v) => v.hash), [hashText(PARSE)]);
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
