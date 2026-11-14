// `rename` (section 6): references are names, so a rename rewrites the
// renamed definition and every caller ("followers"). It must keep what each
// reference denotes.

import { join } from "node:path";
import { assert_, assertEquals } from "./assert.ts";
import {
  add,
  codes,
  done,
  dump,
  fails,
  fn,
  fresh,
  hashOf,
  LOAD_PORT,
  ok,
  PARSE,
  PORT,
  withPort,
} from "./db_helpers.ts";
import { type Codebase, hashText } from "../src/codebase.ts";
import { AlangError } from "../src/diagnostic.ts";

const rename = (cb: Codebase, name: string, to: string) => ({
  op: "rename" as const,
  name,
  hash: hashOf(cb, name),
  to,
});

async function exportFiles(cb: Codebase): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for await (const e of Deno.readDir(join(cb.dir, "export"))) {
    out[e.name] = await Deno.readTextFile(join(cb.dir, "export", e.name));
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

Deno.test("rename: the definition and its callers are rewritten", async () => {
  const cb = await withPort();
  const r = await ok(cb, [rename(cb, "net.port.parse", "net.port.read")]);
  const read = cb.definition("net.port.read");
  const loadPort = cb.definition("config.load_port");
  assertEquals(r.written, [
    { name: "net.port.parse", hash: null, operation: "rename" },
    { name: "net.port.read", hash: read.hash, operation: "rename" },
    { name: "config.load_port", hash: loadPort.hash, operation: "follow" },
  ]);
  assertEquals(
    read.text,
    PARSE.replaceAll("net.port.parse", "net.port.read").replaceAll('parse(text: "', 'read(text: "'),
  );
  assertEquals(loadPort.text, LOAD_PORT.replace("net.port.parse(text: trimmed)", "net.port.read(text: trimmed)"));
  assertEquals(cb.callers("net.port.read").callers, ["config.load_port"]);
  try {
    cb.definition("net.port.parse");
    throw new Error("expected E0502");
  } catch (e) {
    assert_(e instanceof AlangError);
  }

  // History follows the rename back to the old name.
  assertEquals(cb.history("net.port.read").entries.map((e) => [e.name, e.operation, e.other_name]), [
    ["net.port.parse", "add", null],
    ["net.port.read", "rename", "net.port.parse"],
  ]);
  assertEquals(cb.history("net.port.parse").entries.map((e) => [e.operation, e.hash === null, e.other_name]), [
    ["add", false, null],
    ["rename", true, "net.port.read"],
  ]);
  assertEquals(cb.history("config.load_port").entries.map((e) => e.operation), ["add", "follow"]);

  // The export follows.
  const files = await exportFiles(cb);
  assert_(files["net.port.alang"].includes("fn net.port.read\n"));
  assert_(!files["net.port.alang"].includes("net.port.parse"));
  assert_(files["config.alang"].includes("net.port.read(text: trimmed)"));
  await done(cb);
});

Deno.test("rename: moving a function to another module rewrites its references from there", async () => {
  const cb = await withPort();
  await ok(cb, [rename(cb, "net.port.parse", "net.parse_port")]);
  const text = cb.definition("net.parse_port").text;
  assert_(text.includes("  out: Result<net.port.Port, net.port.ParseError>"), text);
  assert_(text.includes('    parse_port(text: "8080") == Ok(net.port.Port(value: 8080))'), text);
  assert_(text.includes("else return Err(net.port.NotANumber)"), text);
  assertEquals(Object.keys(await exportFiles(cb)), ["config.alang", "net.alang", "net.port.alang"]);
  await done(cb);
});

Deno.test("rename: a variant type that changes module takes its cases along", async () => {
  const cb = await withPort();
  // A user in the target module, writing the old cases qualified.
  const describe = fn("net.errors.describe", {
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
  });
  await ok(cb, [add(describe)]);
  const r = await ok(cb, [rename(cb, "net.port.ParseError", "net.errors.ParseError")]);
  assertEquals(r.written.map((w) => [w.name, w.operation]), [
    ["net.port.ParseError", "rename"],
    ["net.errors.ParseError", "rename"],
    ["config.LoadError", "follow"],
    ["net.errors.describe", "follow"],
    ["net.port.parse", "follow"],
  ]);
  // From the old module, the cases are now qualified; from the target module, short.
  const parse = cb.definition("net.port.parse").text;
  assert_(parse.includes("  out: Result<Port, net.errors.ParseError>"), parse);
  assert_(parse.includes('    parse(text: "0") == Err(net.errors.OutOfRange(0))'), parse);
  assert_(parse.includes("else return Err(net.errors.NotANumber)"), parse);
  const desc = cb.definition("net.errors.describe").text;
  assert_(desc.includes("    e: ParseError"), desc);
  assert_(desc.includes("  case NotANumber then") && desc.includes("  case OutOfRange(n) then"), desc);
  assert_(desc.includes('describe(e: NotANumber) == "not a number"'), desc);
  assert_(cb.definition("config.LoadError").text.includes("InvalidPort: net.errors.ParseError"));
  // The type's own text keeps its cases; callers of the type are found through them.
  assertEquals(cb.callers("net.errors.ParseError").callers, [
    "config.LoadError",
    "net.errors.describe",
    "net.port.parse",
  ]);
  await done(cb);
});

Deno.test("rename: a caller whose text does not change is not rewritten", async () => {
  // n.is_red uses only a case of m.Color, which keeps its name when the type is
  // renamed within its module.
  const cb = await fresh();
  const color = `type m.Color
  doc: "A color."
  variant:
    Red
    Green
  where: none
end type m.Color`;
  const nameOf = fn("m.name_of", {
    params: ["c: Color"],
    out: "String",
    examples: ['name_of(c: Red) == "red"'],
    body:
      'let text: String = match c\n  case Red then\n    "red"\n  case Green then\n    "green"\nend match\nreturn text',
  });
  const isRed = fn("n.is_red", {
    out: "Bool",
    examples: ["is_red() == true"],
    body: 'return m.name_of(c: m.Red) == "red"',
  });
  await ok(cb, [add(color), add(nameOf), add(isRed)]);
  const hash = hashOf(cb, "n.is_red");
  assertEquals(cb.callers("m.Color").callers, ["m.name_of", "n.is_red"]);
  const r = await ok(cb, [rename(cb, "m.Color", "m.Colour")]);
  assertEquals(r.written.map((w) => [w.name, w.operation]), [
    ["m.Color", "rename"],
    ["m.Colour", "rename"],
    ["m.name_of", "follow"],
  ]);
  assertEquals(hashOf(cb, "n.is_red"), hash);
  assertEquals(cb.history("n.is_red").entries.map((e) => e.operation), ["add"]);
  assertEquals(cb.callers("m.Colour").callers, ["m.name_of", "n.is_red"]);
  await done(cb);
});

// geo: every kind of reference a rename has to rewrite.
const GEO = [
  `type geo.Point
  doc: "A point."
  record:
    x: Int
    y: Int
  where: none
end type geo.Point`,
  `type geo.Shape
  doc: "A shape."
  variant:
    Dot: Point
    Empty
  where: none
end type geo.Shape`,
  fn("geo.cmp", {
    params: ["left: Point", "right: Point"],
    out: "Order",
    examples: ["cmp(left: Point(x: 1, y: 0), right: Point(x: 2, y: 0)) == Less"],
    body: "return std.int.compare(left: left.x, right: right.x)",
  }),
  fn("geo.ok", {
    params: ["low: Int", "high: Int"],
    out: "Bool",
    examples: ["ok(low: 1, high: 2) == true"],
    body: "return low <= high",
  }),
  `type geo.Span
  doc: "A range."
  record:
    low: Int
    high: Int
  where: ok(low: low, high: high)
end type geo.Span`,
  fn("geo.down", {
    params: ["n: Int"],
    out: "Int",
    examples: ["down(n: 3) == 0"],
    body: "if n <= 0 then\n  return 0\nend if\nreturn down(n: n - 1)",
  }),
  fn("geo.use_all", {
    params: ["points: List<Point>", "s: Shape"],
    out: "List<Point>",
    examples: ["use_all(points: std.list.empty<Point>(), s: Empty) == std.list.empty<Point>()"],
    body: [
      "let moved: List<Point> = std.list.map(list: points, with: fn(p: Point): Point => Point(x: p.x, y: p.y))",
      "let sorted: List<Point> = std.list.sort(list: moved, by: cmp)",
      "let copied: List<Point> = for q: Point in sorted do",
      "  q",
      "end for",
      "let picked: List<Point> = match s",
      "  case Dot(d) then",
      "    std.list.append(list: copied, item: d)",
      "  case Empty then",
      "    copied",
      "end match",
      "let span: Span = Span(low: 0, high: down(n: 2))",
      "return picked",
    ].join("\n"),
  }).replace("  requires: none", "  requires: ok(low: 0, high: std.list.length(list: points))"),
];

Deno.test("rename: every kind of reference is rewritten, in one transaction of several renames", async () => {
  const cb = await fresh();
  await ok(cb, GEO.map(add));
  const before = cb.definition("geo.use_all").text;
  const r = await ok(cb, [
    rename(cb, "geo.Point", "geo.Pos"),
    rename(cb, "geo.Shape", "shapes.Shape"),
    rename(cb, "geo.cmp", "geo.order"),
    rename(cb, "geo.ok", "geo.ordered"),
    rename(cb, "geo.down", "geo.count_down"),
  ]);
  assertEquals(r.written.filter((w) => w.operation === "follow").map((w) => w.name), ["geo.Span", "geo.use_all"]);
  const expected = before
    .replaceAll("Point", "Pos")
    .replace("s: Shape", "s: shapes.Shape")
    .replace("s: Empty)", "s: shapes.Empty)")
    .replace("case Dot(d)", "case shapes.Dot(d)")
    .replace("case Empty", "case shapes.Empty")
    .replace("by: cmp", "by: order")
    .replace("requires: ok(", "requires: ordered(")
    .replace("down(n: 2)", "count_down(n: 2)");
  assertEquals(cb.definition("geo.use_all").text, expected);
  assert_(cb.definition("geo.Span").text.includes("where: ordered(low: low, high: high)"));
  const down = cb.definition("geo.count_down").text;
  assert_(down.includes("count_down(n: 3) == 0") && down.includes("return count_down(n: n - 1)"), down);
  const shape = cb.definition("shapes.Shape").text;
  assert_(shape.includes("    Dot: geo.Pos\n    Empty"), shape);
  const order = cb.definition("geo.order").text;
  assert_(order.includes("order(left: Pos(x: 1, y: 0), right: Pos(x: 2, y: 0)) == Less"), order);
  await done(cb);
});

Deno.test("rename: a call inside a list literal is a reference and is rewritten", async () => {
  const cb = await fresh();
  const one = fn("m.one", { out: "Int", examples: ["one() == 1"], body: "return 1" });
  const many = fn("other.many", {
    out: "List<Int>",
    examples: ["many() == [1, 1]"],
    body: "return [m.one(), m.one()]",
  });
  await ok(cb, [add(one), add(many)]);
  assertEquals(cb.callers("m.one").callers, ["other.many"]);
  await ok(cb, [rename(cb, "m.one", "m.single")]);
  assertEquals(cb.definition("other.many").text, many.replaceAll("m.one()", "m.single()"));
  assertEquals(cb.callers("m.single").callers, ["other.many"]);
  await done(cb);
});

Deno.test("rename: calls in the keys and values of a map literal are references and are rewritten", async () => {
  const cb = await fresh();
  const one = fn("m.one", { out: "Int", examples: ["one() == 1"], body: "return 1" });
  const named = fn("m.named", { out: "String", examples: ['named() == "a"'], body: 'return "a"' });
  const both = fn("other.both", {
    out: "Map<String, Int>",
    examples: ['both() == ["a": 1]'],
    body: "return [m.named(): m.one()]",
  });
  await ok(cb, [add(one), add(named), add(both)]);
  assertEquals([cb.callers("m.one").callers, cb.callers("m.named").callers], [["other.both"], ["other.both"]]);
  await ok(cb, [rename(cb, "m.one", "m.single"), rename(cb, "m.named", "m.label")]);
  assertEquals(cb.definition("other.both").text, both.replace("[m.named(): m.one()]", "[m.label(): m.single()]"));
  assertEquals(cb.callers("m.single").callers, ["other.both"]);
  await done(cb);
});

Deno.test("rename: an application reads a local, never a function, so it is never captured (F2)", async () => {
  const cb = await fresh();
  const g = fn("m.g", { params: ["n: Int"], out: "Int", examples: ["g(n: 1) == 2"], body: "return n + 1" });
  const uses = fn("m.uses", {
    params: ["f: (Int) -> Int", "x: Int"],
    out: "Int",
    examples: ["uses(f: fn(n: Int): Int => n * 10, x: 1) == 20"],
    body: "return f(g(n: x))",
  });
  // An example passing a function by name is a reference to it.
  const twice = fn("m.twice", {
    params: ["x: Int"],
    out: "Int",
    examples: ["twice(x: uses(f: g, x: 1)) == 6"],
    body: "return x * 2",
  });
  await ok(cb, [add(g), add(uses), add(twice)]);
  assertEquals(cb.callers("m.g").callers, ["m.twice", "m.uses"]);
  // The named call is the function, the unnamed one the parameter.
  await ok(cb, [rename(cb, "m.g", "m.f")]);
  assertEquals(cb.definition("m.uses").text, uses.replace("return f(g(n: x))", "return f(f(n: x))"));
  assertEquals(cb.callers("m.f").callers, ["m.twice", "m.uses"]);
  await done(cb);
});

Deno.test("rename: a type inside a function type is a reference and is rewritten (F1)", async () => {
  const cb = await fresh();
  const row = 'type old.Row\n  doc: "A row."\n  record:\n    name: String\n  where: none\nend type old.Row';
  const count = fn("other.count", {
    params: ["names: List<String>", "keep: (old.Row) -> Bool"],
    out: "Int",
    examples: ['count(names: ["a"], keep: fn(row: old.Row): Bool => true) == 1'],
    body:
      "let rows: List<old.Row> = std.list.map(list: names, with: fn(name: String): old.Row => old.Row(name: name))\nreturn std.list.length(list: std.list.filter(list: rows, with: keep))",
  });
  const user = fn("other.user", {
    out: "Int",
    examples: ["user() == 0"],
    body: "return count(names: std.list.empty<String>(), keep: fn(row: old.Row): Bool => false)",
  });
  await ok(cb, [add(row), add(count), add(user)]);
  assertEquals(cb.callers("old.Row").callers, ["other.count", "other.user"]);
  await ok(cb, [rename(cb, "old.Row", "fresh.Row")]);
  assertEquals(cb.definition("other.count").text, count.replaceAll("old.Row", "fresh.Row"));
  assert_(cb.definition("other.count").text.includes("    keep: (fresh.Row) -> Bool\n"));
  // The function type belongs to the interface: changing it with a caller
  // outside the transaction is E0506.
  const changed = cb.definition("other.count").text.replace("keep: (fresh.Row) -> Bool", "keep: (fresh.Row) -> Int")
    .replace("fn(row: fresh.Row): Bool => true", "fn(row: fresh.Row): Int => 1")
    .replace("with: keep))", "with: fn(row: fresh.Row): Bool => true))");
  const r = await fails(cb, [{ op: "replace", name: "other.count", hash: hashOf(cb, "other.count"), text: changed }]);
  assertEquals(codes(r.diagnostics), ["E0506"]);
  assert_(r.diagnostics[0].message.includes("`in`"), r.diagnostics[0].message);
  await done(cb);
});

Deno.test("rename: a new name captured by a local binding is rejected (E0510)", async () => {
  // A function value `by: cmp` would read the local `g` after renaming cmp to g.
  const cb = await fresh();
  const cmp = fn("m.cmp", {
    params: ["left: Int", "right: Int"],
    out: "Order",
    examples: ["cmp(left: 1, right: 2) == Less"],
    body: "return std.int.compare(left: left, right: right)",
  });
  const sorted = fn("m.sorted", {
    params: ["xs: List<Int>"],
    out: "List<Int>",
    examples: ["sorted(xs: std.list.empty<Int>()) == std.list.append(list: std.list.empty<Int>(), item: 0)"],
    body:
      "let g: Int = 0\nlet s: List<Int> = std.list.sort(list: xs, by: cmp)\nreturn std.list.append(list: s, item: g)",
  });
  await ok(cb, [add(cmp), add(sorted)]);
  const before = dump(cb);
  const files = await exportFiles(cb);
  const r = await fails(cb, [rename(cb, "m.cmp", "m.g")]);
  assertEquals(codes(r.diagnostics), ["E0510"]);
  assertEquals(r.diagnostics[0].definition, "m.sorted");
  assertEquals(r.diagnostics[0].at, `rename(m.cmp, ${hashOf(cb, "m.cmp")}, m.g)`);
  assertEquals(dump(cb), before);
  assertEquals(await exportFiles(cb), files);
  await done(cb);
});

Deno.test("rename: a new module captured by a parameter is rejected (E0510)", async () => {
  // config.load_port has a parameter `path`; `path.parse(...)` would be a method call on it.
  const cb = await withPort();
  const before = dump(cb);
  const r = await fails(cb, [rename(cb, "net.port.parse", "path.parse")]);
  assertEquals(codes(r.diagnostics), ["E0510"]);
  assertEquals(r.diagnostics[0].definition, "config.load_port");
  assert_(r.diagnostics[0].message.includes("no longer checks"), r.diagnostics[0].message);
  assertEquals(dump(cb), before);
  await done(cb);
});

Deno.test("rename: invalid, taken and twice-touched names are rejected and change nothing", async () => {
  const cb = await withPort();
  const before = dump(cb);
  const files = await exportFiles(cb);
  const one = async (change: ReturnType<typeof rename>) => (await fails(cb, [change])).diagnostics;

  for (const to of ["net.port.Parse", "parse", "std.port.parse", "net.port.parse", "net.port.parse x"]) {
    const ds = await one(rename(cb, "net.port.parse", to));
    assertEquals(codes(ds), ["E0509"], `${to}: ${JSON.stringify(ds)}`);
  }
  assertEquals(codes(await one(rename(cb, "net.port.Port", "net.port.port"))), ["E0509"]);

  const taken = await fails(cb, [rename(cb, "net.port.Port", "net.port.ParseError")]);
  assertEquals(codes(taken.diagnostics), ["E0503"]);
  assertEquals(taken.current.map((v) => v.name), ["net.port.ParseError"]);

  const twice = await fails(cb, [
    rename(cb, "net.port.parse", "net.port.read"),
    add(PARSE.replaceAll("net.port.parse", "net.port.read").replaceAll('parse(text: "', 'read(text: "')),
  ]);
  assertEquals(codes(twice.diagnostics), ["E0508"]);
  const swap = await fails(cb, [
    rename(cb, "net.port.Port", "net.port.Number"),
    rename(cb, "net.port.ParseError", "net.port.Port"),
  ]);
  assertEquals(codes(swap.diagnostics), ["E0508"]);

  assertEquals(dump(cb), before);
  assertEquals(await exportFiles(cb), files);
  await done(cb);
});

Deno.test("rename: followers are outside the transaction for the interface rule", async () => {
  const cb = await withPort();
  const renamedParam = PARSE.replaceAll("text: ", "source: ").replace(
    "std.int.parse(source: text)",
    "std.int.parse(text: source)",
  );
  // Renaming the caller does not adapt it to the changed interface.
  const r = await fails(cb, [
    { op: "replace", name: "net.port.parse", hash: hashOf(cb, "net.port.parse"), text: renamedParam },
    rename(cb, "config.load_port", "config.read_port"),
  ]);
  assertEquals(codes(r.diagnostics), ["E0506"]);
  assert_(r.diagnostics[0].message.includes("`config.load_port`"), r.diagnostics[0].message);
  await done(cb);
});

Deno.test("rename: a replace of a follower in the same transaction wins over the rewrite", async () => {
  const cb = await withPort();
  const adapted = LOAD_PORT
    .replace("Reads the port number", "Reads the TCP port number")
    .replace("net.port.parse(text: trimmed)", "net.port.read(text: trimmed)");
  const r = await ok(cb, [
    rename(cb, "net.port.parse", "net.port.read"),
    { op: "replace", name: "config.load_port", hash: hashOf(cb, "config.load_port"), text: adapted },
  ]);
  assertEquals(r.written.map((w) => [w.name, w.operation]), [
    ["net.port.parse", "rename"],
    ["net.port.read", "rename"],
    ["config.load_port", "replace"],
  ]);
  assertEquals(cb.definition("config.load_port").text, adapted);
  await done(cb);
});

Deno.test("rename: renaming back reuses every version", async () => {
  const cb = await withPort();
  const original = dump(cb);
  await ok(cb, [rename(cb, "net.port.parse", "net.port.read")]);
  const grown = dump(cb).definitions.length;
  assertEquals(grown, original.definitions.length + 2); // read, and load_port following it
  await ok(cb, [rename(cb, "net.port.read", "net.port.parse")]);
  const back = dump(cb);
  assertEquals(back.names, original.names);
  assertEquals(back.definitions.length, grown);
  assertEquals(hashOf(cb, "net.port.parse"), hashText(PARSE));
  // Each history row once, in order.
  assertEquals(cb.history("net.port.parse").entries.map((e) => [e.name, e.operation, e.hash === null]), [
    ["net.port.parse", "add", false],
    ["net.port.read", "rename", false],
    ["net.port.parse", "rename", true],
    ["net.port.parse", "rename", false],
  ]);
  await done(cb);
});

Deno.test("rename: export, then import into a fresh database, gives the same names and hashes", async () => {
  const cb = await fresh();
  await ok(cb, GEO.map(add));
  await ok(cb, [rename(cb, "geo.Shape", "shapes.Shape"), rename(cb, "geo.cmp", "geo.order")]);
  const other = await fresh();
  const r = await other.importAll(join(cb.dir, "export"));
  assert_(r.ok, JSON.stringify(r));
  assertEquals(dump(other).names, dump(cb).names);
  await done(cb);
  await done(other);
});

// ---- rename with text ----

// net.port.parse under the name net.port.read, changed: it ignores
// surrounding whitespace, which adds a reference (std.string.trim).
const READ = PARSE
  .replaceAll("net.port.parse", "net.port.read")
  .replaceAll('parse(text: "', 'read(text: "')
  .replace("from decimal text.", "from decimal text, ignoring surrounding whitespace.")
  .replace("std.int.parse(text: text)", "std.int.parse(text: std.string.trim(text: text))")
  .replace("  examples:\n", '  examples:\n    read(text: " 80 ") == Ok(Port(value: 80))\n');

Deno.test("rename: with text, a definition is renamed and changed in one transaction", async () => {
  const cb = await withPort();
  const r = await ok(cb, [{ ...rename(cb, "net.port.parse", "net.port.read"), text: READ }]);
  const read = cb.definition("net.port.read");
  assertEquals(read.text, READ);
  assertEquals(r.written, [
    { name: "net.port.parse", hash: null, operation: "rename" },
    { name: "net.port.read", hash: read.hash, operation: "rename" },
    { name: "config.load_port", hash: hashOf(cb, "config.load_port"), operation: "follow" },
  ]);
  assertEquals(
    cb.definition("config.load_port").text,
    LOAD_PORT.replace("net.port.parse(text: trimmed)", "net.port.read(text: trimmed)"),
  );
  assertEquals(cb.history("net.port.read").entries.map((e) => [e.name, e.operation]), [
    ["net.port.parse", "add"],
    ["net.port.read", "rename"],
  ]);
  await done(cb);
});

Deno.test("rename: with text, own-module names written in full are stored short", async () => {
  // The text is the definition under its new name, so its own module is the
  // new one; the shortened tree is the one stored, with its `refs` rows
  // (checked by the invariants in `done`).
  const cb = await withPort();
  const long = READ
    .replace('read(text: "8080")', 'net.port.read(text: "8080")')
    .replace("Err(OutOfRange(n))", "Err(net.port.OutOfRange(n))")
    .replace("Ok(Port(value: n))", "Ok(net.port.Port(value: n))");
  const r = await ok(cb, [{ ...rename(cb, "net.port.parse", "net.port.read"), text: long }]);
  assertEquals(r.fixed!.map((d) => [d.definition, d.fix!.replace]), [
    ["net.port.read", "net.port.read"],
    ["net.port.read", "net.port.OutOfRange"],
    ["net.port.read", "net.port.Port"],
  ]);
  assertEquals(cb.definition("net.port.read").text, READ);
  await done(cb);
});

Deno.test("rename: a text that changes the interface takes its callers into the transaction", async () => {
  const cb = await withPort();
  const source = PARSE
    .replaceAll("net.port.parse", "net.port.read")
    .replaceAll('parse(text: "', 'read(text: "')
    .replaceAll("text: ", "source: ")
    .replace("std.int.parse(source: text)", "std.int.parse(text: source)");
  const alone = await fails(cb, [{ ...rename(cb, "net.port.parse", "net.port.read"), text: source }]);
  assertEquals(codes(alone.diagnostics), ["E0506"]);
  assert_(alone.diagnostics[0].message.includes("`config.load_port`"), alone.diagnostics[0].message);
  const adapted = LOAD_PORT.replace("net.port.parse(text: trimmed)", "net.port.read(source: trimmed)");
  const r = await ok(cb, [
    { ...rename(cb, "net.port.parse", "net.port.read"), text: source },
    { op: "replace", name: "config.load_port", hash: hashOf(cb, "config.load_port"), text: adapted },
  ]);
  assertEquals(r.written.map((w) => [w.name, w.operation]), [
    ["net.port.parse", "rename"],
    ["net.port.read", "rename"],
    ["config.load_port", "replace"],
  ]);
  assertEquals(cb.definition("net.port.read").text, source);
  await done(cb);
});

Deno.test("rename: a text that is not the definition under its new name is rejected", async () => {
  const cb = await withPort();
  const before = dump(cb);
  const wrong = await fails(cb, [{ ...rename(cb, "net.port.parse", "net.port.read"), text: PARSE }]);
  assertEquals(codes(wrong.diagnostics), ["E0505"]);
  assertEquals(wrong.diagnostics[0].expected, "fn net.port.read");
  const two = await fails(cb, [{ ...rename(cb, "net.port.parse", "net.port.read"), text: `${READ}\n\n${READ}` }]);
  assertEquals(codes(two.diagnostics), ["E0504"]);
  assertEquals(two.diagnostics[0].definition, "net.port.parse");
  // Still one change per name: a rename with text and a replace of either name.
  const twice = await fails(cb, [
    { ...rename(cb, "net.port.parse", "net.port.read"), text: READ },
    { op: "replace", name: "net.port.parse", hash: hashOf(cb, "net.port.parse"), text: PARSE },
  ]);
  assertEquals(codes(twice.diagnostics), ["E0508"]);
  assertEquals(dump(cb), before);
  await done(cb);
});

Deno.test("rename: a definition replaced alongside a renamed type is compared with its renamed form", async () => {
  // parse's `out` names Port. Renaming Port and adapting parse to the new
  // name is no interface change for parse's caller, config.load_port.
  const cb = await withPort();
  const number = PORT.replaceAll("net.port.Port", "net.port.Number").replace("A valid TCP", "A TCP");
  const parse = PARSE.replaceAll("Port", "Number");
  const r = await ok(cb, [
    { ...rename(cb, "net.port.Port", "net.port.Number"), text: number },
    { op: "replace", name: "net.port.parse", hash: hashOf(cb, "net.port.parse"), text: parse },
  ]);
  assertEquals(r.written.map((w) => [w.name, w.operation]), [
    ["net.port.Port", "rename"],
    ["net.port.Number", "rename"],
    ["net.port.parse", "replace"],
    ["config.load_port", "follow"],
  ]);
  assertEquals(cb.definition("net.port.Number").text, number);
  assertEquals(cb.definition("config.load_port").text, LOAD_PORT.replaceAll("net.port.Port", "net.port.Number"));
  await done(cb);
});

Deno.test("rename: a caller that propagates the renamed function's error follows it (T1)", async () => {
  const cb = await fresh();
  await ok(cb, [
    add(fn("checks.positive", {
      params: ["n: Int"],
      out: "Result<Unit, String>",
      examples: ["positive(n: 1) == Ok(Unit)"],
      body: 'if n < 1 then\n  return Err("not positive")\nend if\nreturn Ok(Unit)',
    })),
    add(fn("sizes.area", {
      params: ["width: Int", "height: Int"],
      out: "Result<Int, String>",
      examples: ["area(width: 2, height: 3) == Ok(6)"],
      body: "checks.positive(n: width) else return Err(error)\nreturn Ok(width * height)",
    })),
  ]);
  assertEquals(cb.callers("checks.positive").callers, ["sizes.area"]);
  await ok(cb, [rename(cb, "checks.positive", "checks.above_zero")]);
  assertEquals(cb.callers("checks.above_zero").callers, ["sizes.area"]);
  assert_(cb.definition("sizes.area").text.includes("    checks.above_zero(n: width) else return Err(error)\n"));
  await done(cb);
});

Deno.test("rename: the cases of a shared case follow their type to another module (T6)", async () => {
  const cb = await fresh();
  const shape = [
    "type old.Shape",
    '  doc: "A shape."',
    "  variant:",
    "    Circle: Int",
    "    Square: Int",
    "    Dot",
    "  where: none",
    "end type old.Shape",
  ].join("\n");
  const size = fn("app.size", {
    params: ["s: old.Shape"],
    out: "Int",
    examples: ["size(s: old.Dot) == 0"],
    body: [
      "let n: Int = match s",
      "  case old.Circle(r) or old.Square(r) then",
      "    r",
      "  case old.Dot then",
      "    0",
      "end match",
      "return n",
    ].join("\n"),
  });
  await ok(cb, [add(shape), add(size)]);
  await ok(cb, [rename(cb, "old.Shape", "fresh.Shape")]);
  const text = cb.definition("app.size").text;
  assert_(text.includes("  case fresh.Circle(r) or fresh.Square(r) then\n"), text);
  assert_(text.includes("size(s: fresh.Dot) == 0"), text);
  assertEquals(cb.callers("fresh.Shape").callers, ["app.size"]);
  await done(cb);
});
