// Type checker: the spec programs check cleanly, the spec's diagnostic
// example is reproduced exactly, and each rule has a negative test that
// yields exactly one diagnostic (rule 5.6).

import { assertEquals } from "./assert.ts";
import { type CheckOptions, checkProgram } from "../src/check.ts";
import type { Diagnostic } from "../src/diagnostic.ts";
import { pathText } from "../src/ast.ts";
import { parseProgram } from "../src/parser.ts";
import { printProgram } from "../src/printer.ts";
import { shortenOwnNames } from "../src/refs.ts";
import { STD, STD_TYPES } from "../src/std.ts";
import { build } from "../src/toolchain.ts";
import * as runtime from "../src/runtime.ts";
import { list, STRING } from "../src/types.ts";

const spec = await Deno.readTextFile(new URL("../alang-specs.md", import.meta.url));
const specBlock = (firstLine: string): string => {
  const m = [...spec.matchAll(/^```\w*\n([\s\S]*?)^```$/gm)].find((m) => m[1].startsWith(firstLine));
  if (!m) throw new Error(`spec block not found: ${firstLine}`);
  return m[1];
};

function check(source: string, options?: CheckOptions): Diagnostic[] {
  return checkProgram(parseProgram(source), options).diagnostics;
}

// A function `m.f` around the given body, plus extra definitions.
function fn(
  body: string,
  o: {
    params?: string[];
    out?: string;
    effects?: string;
    extra?: string;
    requires?: string;
    ensures?: string;
    examples?: string[];
  } = {},
): string {
  const lines = [
    "fn m.f",
    '  doc: "Test."',
    o.params ? ["  in:", ...o.params.map((p) => `    ${p}`)].join("\n") : "  in: none",
    `  out: ${o.out ?? "Int"}`,
    `  effects: ${o.effects ?? "none"}`,
    `  requires: ${o.requires ?? "none"}`,
    `  ensures: ${o.ensures ?? "none"}`,
    o.examples ? ["  examples:", ...o.examples.map((e) => `    ${e}`)].join("\n") : "  examples: none",
    "  body:",
    ...body.split("\n").map((l) => `    ${l}`),
    "end fn m.f",
  ];
  return lines.join("\n") + (o.extra ? `\n\n${o.extra}` : "");
}

// The program with the places the checker reports as E0226 shortened, as
// the codebase stores it (refs.ts), printed.
function shortened(source: string): string {
  const defs = parseProgram(source);
  const { info } = checkProgram(defs);
  return printProgram(defs.map((d) => shortenOwnNames(d, info)));
}

// Exactly one diagnostic, with the given code; returns it. A fix always
// applies inside the quoted location (5.5).
function one(source: string, code: string): Diagnostic {
  const ds = check(source);
  assertEquals(ds.map((d) => d.code), [code], JSON.stringify(ds, null, 2));
  const fix = ds[0].fix;
  if (fix) assertEquals(ds[0].at.includes(fix.replace), true, `fix outside its location: ${JSON.stringify(ds[0])}`);
  return ds[0];
}

// Applies a diagnostic's fix the way a tool would: find the quoted location
// in the line of its section, then replace inside it.
function applyFix(source: string, d: Diagnostic): string {
  const lines = source.split("\n");
  const i = lines.findIndex((l) => l.trimStart().startsWith(`${d.section}:`) && l.includes(d.at));
  if (i < 0 || !d.fix) throw new Error(`cannot apply ${JSON.stringify(d)}`);
  lines[i] = lines[i].replace(d.at, d.at.replace(d.fix.replace, d.fix.with));
  return lines.join("\n");
}

// Every accepted program with the default std is also emitted and checked by
// TypeScript at the end, so that whatever the checker accepts TypeScript
// accepts too ("Checked output" in the spec).
const accepted: string[] = [];

function clean(source: string, options?: CheckOptions): void {
  const ds = check(source, options);
  assertEquals(ds, [], JSON.stringify(ds, null, 2));
  if (!options) accepted.push(source);
}

const POINT = 'type m.Point\n  doc: "A point."\n  record:\n    x: Int\n    y: Int\n  where: none\nend type m.Point';
const SHAPE =
  'type m.Shape\n  doc: "A shape."\n  variant:\n    Circle: Int\n    Square: Int\n    Dot\n  where: none\nend type m.Shape';
const G = 'fn m.g\n  doc: "G."\n  in: none\n  out: Int\n  effects: none\n  requires: none\n  ensures: none\n' +
  "  examples:\n    g() == 1\n  body:\n    return 1\nend fn m.g";

// ---- spec ----

Deno.test("check: spec programs are accepted", () => {
  clean(specBlock("fn hello.main"));
  clean(specBlock("type net.port.Port"));
  clean(specBlock("fn math.clamp"));
});

// The type config.load_port relies on, which the spec leaves out, plus the
// port module it calls. Ordinary source, so these programs also reach the
// checked-output test at the end.
const LOAD_PORT_CONTEXT = `type config.LoadError
  doc: "Why the configuration could not be loaded."
  variant:
    FileUnreadable: std.fs.Error
    InvalidPort: net.port.ParseError
  where: none
end type config.LoadError

${specBlock("type net.port.Port")}`;

Deno.test("check: config.load_port is accepted given its missing declarations", () => {
  clean(specBlock("fn config.load_port") + "\n\n" + LOAD_PORT_CONTEXT);
  // Without its context: each missing name is reported once, however often it is used (5.6).
  assertEquals(check(specBlock("fn config.load_port")).map((d) => d.message), [
    "Unknown type `net.port.Port`.",
    "Unknown type `LoadError`.",
    "Unknown type or case `FileUnreadable`.",
    "Unknown function `net.port.parse`.",
    "Unknown type or case `InvalidPort`.",
  ]);
});

Deno.test("check: the spec's let fragments are accepted inside a function", () => {
  clean(
    fn(specBlock("let contents") + "\nreturn contents", {
      params: ["paths: List<String>"],
      out: "List<Result<String, std.fs.Error>>",
      effects: "fs.read",
    }),
  );
  clean(fn(specBlock("let lengths") + "\nreturn total", { params: ["names: List<String>"] }));
});

Deno.test("check: the 5.5 diagnostic example is reproduced field for field", () => {
  const source = specBlock("type net.port.Port").replace("std.int.parse(text: text)", "std.int.parse(txt: text)");
  assertEquals(check(source), [{
    code: "E0207",
    definition: "net.port.parse",
    section: "body",
    at: "std.int.parse(txt: text)",
    message: "Unknown parameter name `txt`.",
    expected: "text: String",
    fix: { replace: "std.int.parse(txt: text)", with: "std.int.parse(text: text)" },
  }]);
});

Deno.test("check: std signatures and runtime exports match", () => {
  const exported = Object.keys(runtime).filter((k) => k.startsWith("std$")).sort();
  // Functions, and the checking constructor of every record type; variant
  // types are TypeScript types only.
  const records = STD_TYPES.filter((d) => d.kind === "type" && d.shape.kind === "record").map((d) => pathText(d.path));
  assertEquals([...STD.map((s) => s.name), ...records].map((n) => n.replaceAll(".", "$")).sort(), exported);
});

// ---- types and conversions ----

Deno.test("check: mismatches, without implicit conversion (2.6)", () => {
  one(fn('let x: Int = "a"\nreturn x'), "E0204");
  assertEquals(one(fn("let x: Float = 1\nreturn 0"), "E0204").fix, { replace: "1", with: "1.0" });
  assertEquals(one(fn("let x: Int = 1\nlet y: Float = x\nreturn 0"), "E0204").fix, {
    replace: "x",
    with: "std.int.to_float(value: x)",
  });
  one(fn("return 1 + 2.0"), "E0204");
  one(fn("return true"), "E0204");
});

Deno.test("check: operators", () => {
  const concat = one(fn('return "a" + "b"', { out: "String" }), "E0211");
  assertEquals(concat.fix?.with, 'std.string.concat(left: "a", right: "b")');
  one(fn("return Point(x: 1, y: 2) < Point(x: 1, y: 3)", { out: "Bool", extra: POINT }), "E0211");
  one(fn("return g == g", { out: "Bool", extra: G }), "E0222");
  clean(fn("return Point(x: 1, y: 2) == Point(x: 1, y: 3)", { out: "Bool", extra: POINT }));
  clean(fn('return "a" < "b" and 1.5 >= 1.0', { out: "Bool" }));
  one(fn("return 1 and true", { out: "Bool" }), "E0204");
});

// ---- names, calls, arguments ----

Deno.test("check: unknown names suggest the closest one", () => {
  const d = one(fn('let n: Int = std.int.prase(text: "1") else return 0\nreturn n'), "E0201");
  assertEquals(d.fix, { replace: "std.int.prase", with: "std.int.parse" });
  assertEquals(one(fn("let count: Int = 1\nreturn cuont"), "E0203").fix, { replace: "cuont", with: "count" });
  assertEquals(one(fn("return 1", { params: ["x: Strin"] }), "E0202").fix, { replace: "Strin", with: "String" });
});

Deno.test("check: one diagnostic per cause (5.6)", () => {
  one(fn("return std.string.length(text: std.text.show(value: missing + 1)) + 2"), "E0203");
  one(fn("let x: Int = missing\nlet y: Int = x + 1\nreturn y"), "E0203");
});

Deno.test("check: arguments are named, complete and in order (4.1)", () => {
  one(
    fn("let xs: List<Int> = std.list.empty<Int>()\nlet v: Int = std.list.get(list: xs) else return 0\nreturn v"),
    "E0205",
  );
  const order = one(
    fn(
      "let xs: List<Int> = std.list.empty<Int>()\nlet v: Int = std.list.get(index: 0, list: xs) else return 0\nreturn v",
    ),
    "E0208",
  );
  assertEquals(order.fix?.with, "std.list.get(list: xs, index: 0)");
  one(fn('return std.string.length(text: "a", text: "b")'), "E0206");
  one(fn("return Point(x: 1, z: 2).x", { extra: POINT }), "E0207");
  one(fn("return g(x: 1)", { extra: G }), "E0207");
});

Deno.test("check: explicit type arguments exactly when the arguments cannot determine them (1.4)", () => {
  const d = one(fn("let xs: List<Int> = std.list.empty()\nreturn 0"), "E0209");
  assertEquals(d.fix, { replace: "std.list.empty()", with: "std.list.empty<Int>()" });
  const extra = one(fn("let xs: List<Int> = std.list.empty<Int>()\nreturn std.list.length<Int>(list: xs)"), "E0209");
  assertEquals(extra.fix?.with, "std.list.length(list: xs)");
  one(fn("return 0", { params: ["xs: List<Int, Int>"] }), "E0209");
});

Deno.test("check: types flow left to right (1.4)", () => {
  const xs = "let xs: List<Int> = std.list.empty<Int>()\n";
  one(fn(xs + "return None == std.list.get(list: xs, index: 0)", { out: "Bool" }), "E0210");
  clean(fn(xs + "return std.list.get(list: xs, index: 0) == None", { out: "Bool" }));
  clean(fn("let o: Option<Int> = Some(1)\nreturn o == Some(2)", { out: "Bool" }));
});

Deno.test("check: method calls (3.1, 5.7)", () => {
  one(fn("let xs: List<Int> = std.list.empty<Int>()\nreturn xs.length()"), "E0220");
});

Deno.test("check: function references and lambdas", () => {
  clean(fn(
    "let xs: List<Int> = std.list.empty<Int>()\nlet s: List<Int> = std.list.sort(list: xs, by: std.int.compare)\nreturn 0",
  ));
  one(
    fn(
      "let xs: List<Int> = std.list.empty<Int>()\nlet s: List<Int> = std.list.map(list: xs, with: std.text.show)\nreturn 0",
    ),
    "E0210",
  );
  one(
    fn(
      "let xs: List<Int> = std.list.empty<Int>()\nlet ys: List<String> = std.list.map(list: xs, with: fn(x: Int): Int => x)\nreturn 0",
    ),
    "E0204",
  );
  one(
    fn(
      "let xs: List<Int> = std.list.empty<Int>()\nreturn std.list.fold(list: xs, initial: 0, with: fn(a: Int, b: Int): Int => if a > b then\n  return a\nelse\n  b\nend if)",
    ),
    "E0219",
  );
});

// ---- records and variants ----

Deno.test("check: fields", () => {
  const d = one(fn("let p: Point = Point(x: 1, y: 2)\nreturn p.z", { extra: POINT }), "E0212");
  assertEquals(d.expected, "x, y");
  one(fn("let n: Int = 1\nreturn n.x"), "E0212");
  clean(fn("let p: Point = Point(x: 1, y: 2)\nreturn p.x + Point(x: 3, y: 4).y", { extra: POINT }));
});

Deno.test("check: construction forms (4.2)", () => {
  one(fn("let p: Point = Point(1)\nreturn 0", { extra: POINT }), "E0223");
  one(fn("let s: Shape = Circle(r: 1)\nreturn 0", { extra: SHAPE }), "E0223");
  one(fn("let s: Shape = Circle\nreturn 0", { extra: SHAPE }), "E0223");
  one(fn("let s: Shape = Dot(1)\nreturn 0", { extra: SHAPE }), "E0223");
  one(fn("let s: Shape = Shape\nreturn 0", { extra: SHAPE }), "E0223");
  one(fn("let s: Shape = Triangle(1)\nreturn 0", { extra: SHAPE }), "E0203");
});

Deno.test("check: names of the own module are written short (1.2)", () => {
  const H = 'fn m.h\n  doc: "H."\n  in:\n    x: Int\n  out: Int\n  effects: none\n  requires: none\n' +
    "  ensures: none\n  examples:\n    h(x: 1) == 1\n  body:\n    return x\nend fn m.h";
  const match = "let n: Int = match s\n  case Circle(v) then\n    v\n  case Square(v) then\n    v\n  case Dot then\n" +
    "    0\nend match\nreturn n";
  const sites: [string, Parameters<typeof fn>[1], string][] = [
    ["return p.x", { params: ["p: m.Point"], extra: POINT }, "m.Point"],
    ["let p: m.Point = Point(x: 1, y: 2)\nreturn p.x", { extra: POINT }, "m.Point"],
    ["let p: Point = m.Point(x: 1, y: 2)\nreturn p.x", { extra: POINT }, "m.Point(x: 1, y: 2)"],
    ["let s: Shape = m.Circle(1)\n" + match, { extra: SHAPE }, "m.Circle(1)"],
    ["let s: Shape = Dot\n" + match.replace("case Dot", "case m.Dot"), { extra: SHAPE }, "m.Dot"],
    ["return m.g()", { extra: G }, "m.g()"],
    [
      "let xs: List<Int> = std.list.empty<Int>()\nlet ys: List<Int> = std.list.map(list: xs, with: m.h)\nreturn 0",
      { extra: H },
      "m.h",
    ],
    ["return 1", { examples: ["m.f() == 1"] }, "m.f()"],
  ];
  for (const [body, options, at] of sites) {
    const source = fn(body, options);
    const d = one(source, "E0226");
    assertEquals(d.at, at);
    const short = d.fix!.replace.slice("m.".length);
    assertEquals([d.fix, d.expected], [{ replace: d.fix!.replace, with: short }, short]);
    const fixed = source.replace(d.at, d.at.replace(d.fix!.replace, d.fix!.with));
    clean(fixed);
    // The codebase applies the fix in the tree, at the same place.
    assertEquals(shortened(source), printProgram(parseProgram(fixed)));
  }
  // In a type definition: a field and a case payload.
  for (const shape of ["record:\n    from: m.Point\n    to: Point", "variant:\n    Wide: m.Point\n    Narrow: Point"]) {
    const other = `type m.Line\n  doc: "A line."\n  ${shape}\n  where: none\nend type m.Line`;
    const source = fn("return 0", { extra: `${POINT}\n\n${other}` });
    assertEquals(one(source, "E0226").at, "m.Point");
    assertEquals(shortened(source), printProgram(parseProgram(source.replace(": m.Point", ": Point"))));
  }
  // A local with the short name takes it, so where a function is passed as
  // a value the full name is then the only spelling, and no error.
  const captured =
    "let xs: List<Int> = std.list.empty<Int>()\nlet ys: List<Int> = std.list.map(list: xs, with: m.h)\n" +
    "return h";
  const capturedSource = fn(captured, { params: ["h: Int"], extra: H });
  clean(capturedSource);
  assertEquals(shortened(capturedSource), printProgram(parseProgram(capturedSource)));
  one(capturedSource.replace("with: m.h", "with: h"), "E0204");
  // Each long name is one diagnostic, also nested in a type.
  const twice = check(fn("let p: Result<m.Point, m.Point> = Ok(Point(x: 1, y: 2))\nreturn 0", { extra: POINT }));
  assertEquals(twice.map((d) => d.code), ["E0226", "E0226"]);
  // Another module, also a nested or an enclosing one, is written in full.
  clean(fn("return n.g() + m.k.g()", {
    extra: [G.replaceAll("m.g", "n.g"), G.replaceAll("m.g", "m.k.g")].join("\n\n"),
  }));
  clean(fn("return m.g()", { extra: G }).replaceAll("fn m.f", "fn m.k.f"));
  // A long name that does not exist is an unknown name, nothing more.
  one(fn("return m.gg()", { extra: G }), "E0201");
});

Deno.test("check: a local built from a case is matched on every case, also of a std type", () => {
  // The emitter must not let TypeScript narrow such a local to the one case.
  const match = (subject: string, cases: string[]) =>
    `let n: Int = match ${subject}\n` + cases.map((c) => `  case ${c} then\n    0\n`).join("") + "end match\nreturn n";
  clean(fn("let s: Shape = Dot\n" + match("s", ["Circle(v)", "Square(v)", "Dot"]), { extra: SHAPE }));
  clean(fn(
    'let e: std.fs.Error = std.fs.Other("disk")\n' +
      match("e", ["std.fs.NotFound", "std.fs.PermissionDenied", "std.fs.IsADirectory", "std.fs.Other(why)"]),
  ));
});

Deno.test("check: uniqueness of definitions, cases, fields and params", () => {
  one(fn("return 1", { extra: G + "\n\n" + G }), "E0215");
  one(
    fn("return 1", {
      extra: SHAPE + '\n\ntype m.Other\n  doc: "O."\n  variant:\n    Dot\n  where: none\nend type m.Other',
    }),
    "E0215",
  );
  one(
    fn("return 1", {
      extra: 'type m.Dot\n  doc: "D."\n  record:\n    v: Int\n  where: none\nend type m.Dot\n\n' + SHAPE,
    }),
    "E0215",
  );
  one(
    fn("return 1", { extra: 'type m.P\n  doc: "P."\n  record:\n    v: Int\n    v: Int\n  where: none\nend type m.P' }),
    "E0215",
  );
  one(fn("return a", { params: ["a: Int", "a: Int"] }), "E0215");
  one(
    fn("return 1", { extra: 'type m.Option\n  doc: "O."\n  record:\n    v: Int\n  where: none\nend type m.Option' }),
    "E0215",
  );
  one(
    fn("return 1", { extra: 'type m.R\n  doc: "R."\n  variant:\n    Ok: Int\n    Bad\n  where: none\nend type m.R' }),
    "E0215",
  );
  one(G.replaceAll("m.g", "std.g"), "E0215");
});

// ---- match ----

Deno.test("check: match is exhaustive, without unreachable cases (3.3)", () => {
  const opt = "let o: Option<Int> = Some(1)\n";
  const d = one(fn(opt + "let n: Int = match o\n  case Some(v) then\n    v\nend match\nreturn n"), "E0213");
  assertEquals(d.expected, "case None then");
  clean(fn(opt + "let n: Int = match o\n  case Some(v) then\n    v\n  case None then\n    0\nend match\nreturn n"));

  const nested = specBlock("type net.port.Port") + "\n\n" + [
    "fn net.port.describe",
    '  doc: "D."',
    "  in:",
    "    text: String",
    "  out: String",
    "  effects: none",
    "  requires: none",
    "  ensures: none",
    "  examples: none",
    "  body:",
    "    let s: String = match parse(text: text)",
    "      case Ok(port) then",
    '        "port"',
    "      case Err(NotANumber) then",
    '        "nan"',
    "    end match",
    "    return s",
    "end fn net.port.describe",
  ].join("\n");
  assertEquals(one(nested, "E0213").expected, "case Err(OutOfRange(_)) then");
  clean(nested.replace('        "nan"\n', '        "nan"\n      case Err(OutOfRange(n)) then\n        "range"\n'));

  one(fn("let n: Int = 1\nlet s: Int = match n\n  case 1 then\n    1\nend match\nreturn s"), "E0213");
  clean(
    fn(
      "let b: Bool = true\nlet s: Int = match b\n  case true then\n    1\n  case false then\n    0\nend match\nreturn s",
    ),
  );
  one(
    fn(
      opt +
        "let n: Int = match o\n  case Some(v) then\n    v\n  case Some(w) then\n    w\n  case None then\n    0\nend match\nreturn n",
    ),
    "E0214",
  );
});

Deno.test("check: a name after a specific case is a catch-all, and rejected (3.3)", () => {
  const port = specBlock("type net.port.Port") + "\n\n";
  const describe = (cases: string[]) =>
    port + [
      "fn net.port.describe",
      '  doc: "D."',
      "  in:",
      "    text: String",
      "  out: String",
      "  effects: none",
      "  requires: none",
      "  ensures: none",
      "  examples: none",
      "  body:",
      "    let s: String = match parse(text: text)",
      ...cases.flatMap((c) => [`      case ${c} then`, '        "x"']),
      "    end match",
      "    return s",
      "end fn net.port.describe",
    ].join("\n");
  // `e` would stand for OutOfRange, and for any case added to ParseError later.
  const d = one(describe(["Ok(p)", "Err(NotANumber)", "Err(e)"]), "E0227");
  assertEquals([d.at, d.expected], ["case Err(e) then", "case Err(OutOfRange(name)) then"]);
  // The name first: the specific case is unreachable, one diagnostic.
  one(describe(["Ok(p)", "Err(e)", "Err(NotANumber)"]), "E0214");
  // A name with no specific case beside it binds the whole value, as always.
  clean(describe(["Ok(p)", "Err(e)"]));
  clean(describe(["Ok(p)", "Err(NotANumber)", "Err(OutOfRange(n))"]));
  // Nested, and for the built-in cases too: 3.3 has no catch-all at all.
  const nested = one(
    fn(
      "let o: Option<Result<Int, String>> = None\nlet n: Int = match o\n  case Some(Ok(v)) then\n    v\n" +
        "  case Some(other) then\n    0\n  case None then\n    0\nend match\nreturn n",
    ),
    "E0227",
  );
  assertEquals(nested.expected, "case Some(Err(name)) then");
});

Deno.test("check: case patterns fit the subject type", () => {
  const opt = "let o: Option<Int> = Some(1)\n";
  one(
    fn(opt + "let n: Int = match o\n  case Ok(v) then\n    v\n  case None then\n    0\nend match\nreturn n"),
    "E0214",
  );
  one(fn(opt + "let n: Int = match o\n  case Some then\n    1\n  case None then\n    0\nend match\nreturn n"), "E0214");
  // Sibling arms may reuse a name; it is not shadowing.
  clean(
    fn(
      "let s: Shape = Circle(1)\nlet n: Int = match s\n  case Circle(v) then\n    v\n  case Square(v) then\n    v\n  case Dot then\n    0\nend match\nreturn n",
      {
        extra: SHAPE,
      },
    ),
  );
});

// ---- statements ----

Deno.test("check: no shadowing (2.6)", () => {
  one(fn("let x: Int = 1\nlet x: Int = 2\nreturn x"), "E0216");
  one(fn("let a: Int = 1\nreturn a", { params: ["a: Int"] }), "E0216");
});

Deno.test("check: discarded values must be Unit", () => {
  one(fn('std.int.parse(text: "1")\nreturn 0'), "E0217");
  clean(fn('std.console.print_line(text: "hi")\nreturn 0', { effects: "console" }));
});

Deno.test("check: a body ends with return; nothing follows a return (3.4)", () => {
  one(fn("if true then\n  return 1\nelse\n  return 2\nend if"), "E0218");
  one(fn("return 1\nreturn 2"), "E0218");
  one(fn("if true then\n  return 1\nelse\n  return 2\nend if\nreturn 3"), "E0218");
});

Deno.test("check: let ... else", () => {
  one(fn("let x: Int = 5 else return 0\nreturn x"), "E0224");
  one(fn('let x: String = std.int.parse(text: "1") else return 0\nreturn 0'), "E0204");
  one(fn('let x: Int = std.int.parse(text: "1") else return "no"\nreturn x'), "E0204");
  clean(fn("let x: Int = std.int.parse(text: t) else return 0\nreturn x", { params: ["t: String"] }));
});

Deno.test("check: if and for", () => {
  one(fn('let x: Int = if true then\n  1\nelse\n  "a"\nend if\nreturn x'), "E0204");
  one(
    fn("for x: Int in 5 do\n  std.console.print_line(text: std.text.show(value: x))\nend for\nreturn 0", {
      effects: "console",
    }),
    "E0204",
  );
  const d = one(
    fn(
      "let xs: List<String> = std.list.empty<String>()\nlet ys: List<Int> = for x: Int in xs do\n  1\nend for\nreturn 0",
    ),
    "E0204",
  );
  assertEquals(d.fix, { replace: "Int", with: "String" });
  one(fn("if 1 then\n  return 1\nend if\nreturn 0"), "E0204");
});

// ---- contracts and examples ----

Deno.test("check: contracts see the right names", () => {
  clean(fn("return a", { params: ["a: Int"], requires: "a > 0", ensures: "result == a" }));
  one(fn("return a", { params: ["a: Int"], requires: "result > 0" }), "E0203");
  one(fn("return a", { params: ["a: Int"], requires: "a" }), "E0204");
  one(
    fn("return 1", {
      extra: 'type m.V\n  doc: "V."\n  variant:\n    A\n  where: true\nend type m.V',
    }),
    "E0225",
  );
});

Deno.test("check: examples call their own function and compare equal types", () => {
  clean(fn("return a", { params: ["a: Int"], examples: ["f(a: 1) == 1"] }));
  one(fn("return a", { params: ["a: Int"], examples: ['f(a: 1) == "1"'] }), "E0204");
  one(fn("return a", { params: ["a: Int"], examples: ["g() == 1"], extra: G }), "E0221");
});

Deno.test("check: the std table can be given explicitly", () => {
  const ds = check(fn('return std.string.length(text: "a")'), { std: [] });
  assertEquals(ds.map((d) => d.code), ["E0201"]);
  assertEquals(list(STRING).k, "con");
});

// ---- effects ----

const SHOUT = [
  "fn m.shout",
  '  doc: "Prints the text."',
  "  in:",
  "    text: String",
  "  out: Unit",
  "  effects: console",
  "  requires: none",
  "  ensures: none",
  "  examples: none",
  "  body:",
  "    std.console.print_line(text: text)",
  "    return Unit",
  "end fn m.shout",
].join("\n");

Deno.test("effects: a caller declares the effects of its callees (2.1)", () => {
  const source = fn('std.console.print_line(text: "hi")\nreturn 0').replace('"Test."', '"Has effects: none so far."');
  const d = one(source, "E0230");
  assertEquals([d.section, d.at], ["effects", "effects: none"]);
  assertEquals(d.message.includes('std.console.print_line(text: "hi")'), true);
  assertEquals(d.fix, { replace: "effects: none", with: "effects: console" });
  // The fix lands on the effects line, not on the doc text, and resolves the diagnostic.
  clean(applyFix(source, d));
  // Through a user function.
  assertEquals(one(fn('shout(text: "hi")\nreturn 0', { extra: SHOUT }), "E0230").fix?.with, "effects: console");
  // Several missing effects: one diagnostic, the whole line fixed, in table order.
  const both = one(
    fn(
      'std.console.print_line(text: "a")\nlet r: Result<String, std.fs.Error> = std.fs.read_text(path: "x")\nreturn 0',
    ),
    "E0230",
  );
  assertEquals(both.fix, { replace: "effects: none", with: "effects: fs.read, console" });
  const partial = one(
    fn('let r: Result<String, std.fs.Error> = std.fs.read_text(path: "x")\nreturn 0', { effects: "console" }),
    "E0230",
  );
  assertEquals(partial.fix, { replace: "effects: console", with: "effects: fs.read, console" });
});

Deno.test("effects: accepted forms", () => {
  clean(fn('std.console.print_line(text: "hi")\nreturn 0', { effects: "console" }));
  // Effects per element go through `for` (2.4).
  clean(
    fn("for x: String in xs do\n  std.console.print_line(text: x)\nend for\nreturn 0", {
      params: ["xs: List<String>"],
      effects: "console",
    }),
  );
  // Declaring more than the body triggers is allowed (2.1 asks for "include").
  clean(fn("return 0", { effects: "console" }));
  // Recursion.
  clean(
    [
      "fn m.count",
      '  doc: "Prints n, n - 1, ..., 1."',
      "  in:",
      "    n: Int",
      "  out: Unit",
      "  effects: console",
      "  requires: none",
      "  ensures: none",
      "  examples: none",
      "  body:",
      "    if n > 0 then",
      "      std.console.print_line(text: std.text.show(value: n))",
      "      count(n: n - 1)",
      "    end if",
      "    return Unit",
      "end fn m.count",
    ].join("\n"),
  );
});

Deno.test("effects: lambdas and function values are pure (2.4)", () => {
  const xs = "let xs: List<String> = std.list.empty<String>()\n";
  one(
    fn(
      xs +
        "let ys: List<Unit> = std.list.map(list: xs, with: fn(x: String): Unit => std.console.print_line(text: x))\nreturn 0",
      {
        effects: "console",
      },
    ),
    "E0232",
  );
  one(
    fn(xs + "let ys: List<Unit> = std.list.map(list: xs, with: shout)\nreturn 0", { effects: "console", extra: SHOUT }),
    "E0232",
  );
});

// A handler for std.http.serve; `effects` and the body are filled in per test.
const handler = (effects: string, body: string): string =>
  [
    "fn m.handle",
    '  doc: "Answers a request."',
    "  in:",
    "    request: std.http.Request",
    "  out: std.http.Response",
    `  effects: ${effects}`,
    "  requires: none",
    "  ensures: none",
    effects === "none"
      ? '  examples:\n    handle(request: std.http.Request(method: "GET", path: "/", query: "", headers: std.list.empty<std.http.Header>(), content: "")) == std.http.Response(status: 200, headers: std.list.empty<std.http.Header>(), content: "/")'
      : "  examples: none",
    "  body:",
    ...body.split("\n").map((l) => `    ${l}`),
    "end fn m.handle",
  ].join("\n");
const RESPOND =
  "return std.http.Response(status: 200, headers: std.list.empty<std.http.Header>(), content: request.path)";
const SERVE =
  'let r: Result<Unit, std.http.ServeError> = std.http.serve(host: "localhost", port: 8080, handler: handle)';

Deno.test("effects: the handler of std.http.serve may have effects; the caller declares them (2.1)", () => {
  const loud = handler("console", "std.console.print_line(text: request.path)\n" + RESPOND);
  clean(fn(SERVE + "\nreturn 0", { effects: "net, console", extra: loud }));
  // A pure handler, by name or as a lambda.
  clean(fn(SERVE + "\nreturn 0", { effects: "net", extra: handler("none", RESPOND) }));
  clean(fn(
    SERVE.replace(
      "handler: handle",
      'handler: fn(request: std.http.Request): std.http.Response => std.http.Response(status: 204, headers: std.list.empty<std.http.Header>(), content: "")',
    ) + "\nreturn 0",
    { effects: "net" },
  ));
  // Passing the handler counts like calling it: its effects are missing here.
  const d = one(fn(SERVE + "\nreturn 0", { effects: "net", extra: loud }), "E0230");
  assertEquals(d.fix, { replace: "effects: net", with: "effects: net, console" });
  // A lambda stays pure there; the advice is a named function, not `for`.
  const lambda = one(
    fn(
      SERVE.replace(
        "handler: handle",
        "handler: fn(request: std.http.Request): std.http.Response => handle(request: request)",
      ) + "\nreturn 0",
      { effects: "net, console", extra: loud },
    ),
    "E0232",
  );
  assertEquals(lambda.message.includes("pass a named function instead of a lambda"), true, lambda.message);
  // Only this parameter takes a function with effects; elsewhere function values stay pure.
  const xs = "let xs: List<std.http.Request> = std.list.empty<std.http.Request>()\n";
  one(
    fn(xs + "let ys: List<std.http.Response> = std.list.map(list: xs, with: handle)\nreturn 0", {
      effects: "console",
      extra: loud,
    }),
    "E0232",
  );
});

Deno.test("effects: conditions and examples are pure (5.4)", () => {
  const loud = SHOUT.replace("out: Unit", "out: Int").replace("return Unit", "return 1");
  one(fn("return a", { params: ["a: Int"], requires: 'a > shout(text: "x")', extra: loud }), "E0233");
  one(fn("return a", { params: ["a: Int"], ensures: 'result > shout(text: "x")', extra: loud }), "E0233");
  one(
    fn("return 0", {
      extra: loud + '\n\ntype m.P\n  doc: "P."\n  record:\n    v: Int\n  where: v > shout(text: "x")\nend type m.P',
    }),
    "E0233",
  );
  // An example of a function with effects would run them at every acceptance.
  one(
    fn('std.console.print_line(text: "hi")\nreturn 0', { effects: "console", examples: ["f() == 0"] }),
    "E0233",
  );
});

Deno.test("check: programs that stress the emitter's TypeScript", () => {
  // Literal and narrowed operands of ==.
  clean(fn("let flag: Bool = true\nreturn flag == false", { out: "Bool" }));
  clean(fn("return 1 == 2", { out: "Bool" }));
  clean(fn('return "a" != "b"', { out: "Bool" }));
  // `error` of a Result, as in config.load_port.
  clean(
    specBlock("type net.port.Port") + "\n\n" + [
      "fn net.port.value_of",
      '  doc: "The port number of the text."',
      "  in:",
      "    text: String",
      "  out: Result<Int, ParseError>",
      "  effects: none",
      "  requires: none",
      "  ensures: none",
      "  examples:",
      '    value_of(text: "80") == Ok(80)',
      "  body:",
      "    let port: Port = parse(text: text) else return Err(error)",
      "    return Ok(port.value)",
      "end fn net.port.value_of",
    ].join("\n"),
  );
  // A for collecting values inside an if branch.
  clean(fn(
    "if std.list.length(list: xs) > 0 then\n  return for x: Int in xs do\n    x + 1\n  end for\nend if\nreturn xs",
    { params: ["xs: List<Int>"], out: "List<Int>" },
  ));
  // A user variant narrowed by its initializer, then matched.
  clean(fn(
    "let s: Shape = Circle(1)\nlet n: Int = match s\n  case Circle(r) then\n    r\n  case Square(a) then\n    a\n  case Dot then\n    0\nend match\nreturn n",
    { extra: SHAPE },
  ));
  // Order values and a match on them.
  clean(fn(
    "let o: Order = std.int.compare(left: 1, right: 2)\nlet n: Int = match o\n  case Less then\n    -1\n  case Equal then\n    0\n  case Greater then\n    1\nend match\nreturn n",
  ));
});

Deno.test("check: every accepted program is accepted by TypeScript too", async () => {
  const dir = new URL("../out/test/accepted/", import.meta.url).pathname;
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  const files: string[] = [];
  for (const [i, source] of accepted.entries()) {
    files.push((await build(source, `${dir}program_${i}.ts`)).outPath);
  }
  assertEquals(files.length > 15, true);
  const result = await new Deno.Command(Deno.execPath(), { args: ["check", ...files], stderr: "piped" }).output();
  const stderr = new TextDecoder().decode(result.stderr);
  assertEquals(result.success, true, stderr);
});
