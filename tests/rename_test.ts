// `rename` (section 6): references are names, so a rename rewrites the
// renamed definition and every caller ("followers"). It must keep what each
// reference denotes.

import { join } from "node:path";
import { assert_, assertEquals } from "./assert.ts";
import { add, codes, done, dump, fails, fn, fresh, hashOf, LOAD_PORT, ok, PARSE, withPort } from "./db_helpers.ts";
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
