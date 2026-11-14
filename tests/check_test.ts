// Type checker: the spec programs check cleanly, the spec's diagnostic
// example is reproduced exactly, and each rule has a negative test that
// yields exactly one diagnostic (rule 5.6).

import { assertEquals } from "./assert.ts";
import { type CheckOptions, checkProgram } from "../src/check.ts";
import type { Diagnostic } from "../src/diagnostic.ts";
import { pathText } from "../src/ast.ts";
import { parseProgram } from "../src/parser.ts";
import { printProgram } from "../src/printer.ts";
import { applyOwnFixes } from "../src/refs.ts";
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
  return printProgram(defs.map((d) => applyOwnFixes(d, info)));
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
  clean(specBlock("fn calc.first_true"));
  clean(specBlock("fn util.contains_by"));
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
  // A generic function passed by name takes its type arguments from the
  // parameter types known there (G9): `show` at `Int` gives `List<String>`.
  const shown = one(
    fn(
      "let xs: List<Int> = std.list.empty<Int>()\nlet s: List<Int> = std.list.map(list: xs, with: std.text.show)\nreturn 0",
    ),
    "E0204",
  );
  assertEquals(shown.message, "Expected `List<Int>`, found `List<String>`.");
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
      match("e", [
        "std.fs.NotFound",
        "std.fs.PermissionDenied",
        "std.fs.IsADirectory",
        "std.fs.AlreadyExists",
        "std.fs.Other(why)",
      ]),
  ));
});

Deno.test("check: an fs error becomes the text of main's Err through std.fs.describe", () => {
  // `error:` is a label here, not a binding, so E0109 does not apply.
  clean(fn(
    "let t: String = std.fs.read_text(path: p) else return Err(std.fs.describe(error: error))\nreturn Ok(Unit)",
    { params: ["p: String"], out: "Result<Unit, String>", effects: "fs.read" },
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

// ---- shared cases (T6 to T8) ----

// A match over `s: Shape` whose arms are the given case lines and values.
const shapes = (arms: [string, string][], extra = SHAPE): string =>
  fn(
    [
      "let n: Int = match s",
      ...arms.flatMap(([c, v]) => [`  case ${c} then`, `    ${v}`]),
      "end match",
      "return n",
    ].join("\n"),
    { params: ["s: Shape"], extra },
  );

// A match over a `std.fs.Error` whose arms are the given case lines.
const fsErrors = (arms: [string, string][], params = ["e: std.fs.Error"]): string =>
  fn(
    [
      "let text: String = match e",
      ...arms.flatMap(([c, v]) => [`  case ${c} then`, `    ${v}`]),
      "end match",
      "return text",
    ].join("\n"),
    { params, out: "String" },
  );

const UNREADABLE = "std.fs.PermissionDenied or std.fs.IsADirectory or std.fs.AlreadyExists or std.fs.Other(message)";

Deno.test("check: cases handled alike share an arm (T6, T7)", () => {
  clean(shapes([["Circle(size) or Square(size)", "size"], ["Dot", "0"]]));
  clean(fsErrors([["std.fs.NotFound", '"missing"'], [UNREADABLE, '"unreadable"']]));
  // A name every pattern binds with one type is bound in the arm.
  clean(fn(
    "let n: Int = match r\n  case Ok(Some(v)) or Err(v) then\n    v\n  case Ok(None) then\n    0\nend match\nreturn n",
    { params: ["r: Result<Option<Int>, Int>"] },
  ));
});

Deno.test("check: a name not every pattern binds has no value in the arm (E0236)", () => {
  const d = one(fsErrors([["std.fs.NotFound", '"missing"'], [UNREADABLE, "message"]]), "E0236");
  assertEquals([d.at, d.fix], ["message", null]);
  assertEquals(
    d.message,
    "`message` is bound by `std.fs.Other(message)` but not by every pattern of its case, so it has no value here.",
  );
  const types = one(
    fn(
      "let n: Int = match r\n  case Ok(n) or Err(n) then\n    n\nend match\nreturn 0".replace(
        "let n: Int",
        "let k: Int",
      ),
      {
        params: ["r: Result<Int, String>"],
      },
    ),
    "E0236",
  );
  assertEquals(types.message, "`n` is an `Int` in `Ok(n)` and a `String` in `Err(n)`, so it has no single type here.");
  // A module function of the same name does not stand in for it.
  const message = 'fn m.message\n  doc: "M."\n  in:\n    text: String\n  out: String\n  effects: none\n' +
    '  requires: none\n  ensures: none\n  examples:\n    message(text: "m") == "m"\n  body:\n    return text\nend fn m.message';
  const withFn = fsErrors([["std.fs.NotFound", '"missing"'], [UNREADABLE, "message"]]) + "\n\n" + message;
  one(withFn, "E0236");
  // Written in full, it is the function, not reported as E0226: the short form would be the hidden name.
  const join = 'std.string.join(parts: std.list.map(list: ["a"], with: m.message), separator: "")';
  clean(fsErrors([["std.fs.NotFound", '"missing"'], [UNREADABLE, join]]) + "\n\n" + message);
  // Used twice: one cause, one diagnostic.
  one(
    fsErrors([["std.fs.NotFound", '"missing"'], [UNREADABLE, "std.string.concat(left: message, right: message)"]]),
    "E0236",
  );
  // Bound again in the arm, or by a pattern over a visible name: E0216.
  one(
    fsErrors([["std.fs.NotFound", '"missing"'], [UNREADABLE, 'let message: String = "x"\n    message']]),
    "E0216",
  );
  one(
    fsErrors([["std.fs.NotFound", '"missing"'], [UNREADABLE.replace("Other(message)", "Other(p)"), '"x"']], [
      "e: std.fs.Error",
      "p: Int",
    ]),
    "E0216",
  );
});

Deno.test("check: shared cases are exhaustive and reachable pattern by pattern (T8)", () => {
  const twice = one(shapes([["Dot or Dot", "0"], ["Circle(a) or Square(a)", "a"]]), "E0214");
  assertEquals([twice.at, twice.message], [
    "case Dot or Dot then",
    "`Dot` is never reached; earlier cases or patterns cover it.",
  ]);
  one(shapes([["Circle(c)", "c"], ["Circle(t) or Dot", "0"], ["Square(q)", "q"]]), "E0214");
  const missing = one(shapes([["Circle(a) or Square(a)", "a"]]), "E0213");
  assertEquals(missing.expected, "case Dot then");
  // A name after a specific pattern of the same case is a catch-all.
  const port = specBlock("type net.port.Port") + "\n\n";
  const inArm = one(
    port + fn(
      "let s: Int = match net.port.parse(text: t)\n  case Ok(p) then\n    1\n  case Err(net.port.NotANumber) or Err(e) then\n    0\nend match\nreturn s",
      { params: ["t: String"] },
    ),
    "E0227",
  );
  assertEquals([inArm.at, inArm.expected], [
    "case Err(net.port.NotANumber) or Err(e) then",
    "case Err(net.port.NotANumber) or Err(net.port.OutOfRange(name)) then",
  ]);
  assertEquals(inArm.message.endsWith("Write a case for each, or name them in one case with `or`."), true);
  // Several remaining cases: one case line naming them all.
  const several = one(
    fn(
      'let text: String = match std.fs.read_text(path: p)\n  case Ok(t) then\n    t\n  case Err(std.fs.NotFound) then\n    ""\n  case Err(other) then\n    "x"\nend match\nreturn text',
      { params: ["p: String"], out: "String", effects: "fs.read" },
    ),
    "E0227",
  );
  assertEquals([several.at, several.expected], [
    "case Err(other) then",
    "case Err(std.fs.PermissionDenied) or Err(std.fs.IsADirectory) or Err(std.fs.AlreadyExists) or Err(std.fs.Other(name)) then",
  ]);
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

// A pure validation helper, as the propagation statement serves it.
const CHECK_WIDTH = [
  "fn m.check_width",
  '  doc: "Whether a width is positive."',
  "  in:",
  "    width: Int",
  "  out: Result<Unit, String>",
  "  effects: none",
  "  requires: none",
  "  ensures: none",
  "  examples:",
  "    check_width(width: 1) == Ok(Unit)",
  "  body:",
  "    if width < 1 then",
  '      return Err("too narrow")',
  "    end if",
  "    return Ok(Unit)",
  "end fn m.check_width",
].join("\n");

// A program with the fix of its one diagnostic applied, in the body.
const fixed = (source: string, d: Diagnostic): string => source.replace(d.fix!.replace, d.fix!.with);

Deno.test("check: a Result<Unit, E> or Option<Unit> is propagated by a statement (T1)", () => {
  const pure = { params: ["w: Int"], out: "Result<Int, String>", extra: CHECK_WIDTH };
  clean(fn("check_width(width: w) else return Err(error)\nreturn Ok(w)", pure));
  clean(fn(
    'std.fs.write_text(path: "a", text: "b") else return Err(std.fs.describe(error: error))\nreturn Ok(Unit)',
    { out: "Result<Unit, String>", effects: "fs.write" },
  ));
  clean(fn("opt else return 0\nreturn 1", { params: ["opt: Option<Unit>"] }));
  clean(fn(
    "for w: Int in ws do\n  check_width(width: w) else return Err(error)\nend for\nreturn Ok(0)",
    { params: ["ws: List<Int>"], out: "Result<Int, String>", extra: CHECK_WIDTH },
  ));
  clean(fn("check_width(width: w) else return Err(error)\nreturn Ok(w)", { ...pure, ensures: "result != Ok(0)" }));
});

Deno.test("check: a propagation statement takes a Result or Option whose content is Unit (T1)", () => {
  const pure = { params: ["w: Int"], out: "Result<Int, String>", extra: CHECK_WIDTH };
  const unit = one(
    fn('std.console.print_line(text: "a") else return Unit\nreturn Unit', {
      out: "Unit",
      effects: "console",
    }),
    "E0224",
  );
  assertEquals(
    unit.message,
    "`else return` takes the content of a `Result` or an `Option`, found `Unit`; write the statement without `else return …`, and put the `else` of an `if` on a line of its own.",
  );
  // The non-canonical `if` whose else ends a then-branch line (T2).
  one(
    fn('if true then\nstd.console.print_line(text: "a") else return Unit\nend if\nreturn Unit', {
      out: "Unit",
      effects: "console",
    }),
    "E0224",
  );
  const content = one(fn('std.int.parse(text: "1") else return 0\nreturn 0'), "E0217");
  assertEquals(content.at, 'std.int.parse(text: "1") else return 0');
  assertEquals(content.expected, 'let name: Int = std.int.parse(text: "1") else return …');
  one(fn('check_width(width: w) else return "no"\nreturn Ok(w)', pure), "E0204");
  // Like a let, it has no value to end a value block with.
  const last = one(
    fn(
      "let n: Int = if w > 0 then\n  check_width(width: w) else return Err(error)\nelse\n  1\nend if\nreturn Ok(n)",
      pure,
    ),
    "E0204",
  );
  assertEquals(last.message.startsWith("This block ends with `… else return` and has no value"), true);
});

// A pure step whose `Ok` holds an `Int`, as in the tickets round.
const STEP = [
  "fn m.step",
  '  doc: "One step."',
  "  in:",
  "    n: Int",
  "  out: Result<Int, String>",
  "  effects: none",
  "  requires: none",
  "  ensures: none",
  "  examples:",
  "    step(n: 1) == Ok(2)",
  '    step(n: 0) == Err("zero")',
  "  body:",
  "    if n == 0 then",
  '      return Err("zero")',
  "    end if",
  "    return Ok(n + 1)",
  "end fn m.step",
].join("\n");

// A program with a diagnostic's `expected` in place of the line it quotes,
// at that line's indentation, and `…` filled with the line's own else value.
const withExpected = (source: string, d: Diagnostic, elseValue: string): string => {
  const lines = source.split("\n");
  const i = lines.findIndex((l) => l.trim() === d.at);
  const indent = lines[i].slice(0, lines[i].length - lines[i].trimStart().length);
  const replaced = d.expected!.replace("…", elseValue).split("\n").map((l) => indent + l);
  return [...lines.slice(0, i), ...replaced, ...lines.slice(i + 1)].join("\n");
};

Deno.test("check: a propagation statement with a content to bind ending a value block is one E0217 (5.6)", () => {
  // The shape of the tickets round: the statement as the value of a match arm.
  const arm = fn(
    "let value: Int = match o\n  case Some(n) then\n    step(n: n) else return Err(error)\n  case None then\n    0\nend match\nreturn Ok(value)",
    { params: ["o: Option<Int>"], out: "Result<Int, String>", extra: STEP },
  );
  const d = one(arm, "E0217");
  assertEquals(d.at, "step(n: n) else return Err(error)");
  assertEquals(
    d.message,
    "The `Int` inside `Ok` is discarded, and `… else return` has no value: bind it, `let name: Int = … else return …`, and end the block with `name`.",
  );
  assertEquals(d.expected, "let name: Int = step(n: n) else return …\nname");
  clean(withExpected(arm, d, "Err(error)"));
  // An `Option` in an `if` branch.
  const branch = fn(
    'let n: Int = if w > 0 then\n  std.int.parse(text: "1") else return Err("no")\nelse\n  1\nend if\nreturn Ok(n)',
    { params: ["w: Int"], out: "Result<Int, String>" },
  );
  const option = one(branch, "E0217");
  assertEquals(option.message.startsWith("The `Int` inside `Some` is discarded, and `… else return` has no"), true);
  clean(withExpected(branch, option, 'Err("no")'));
});

Deno.test("check: a let binds no Unit (E0235)", () => {
  const write = 'std.fs.write_text(path: "a", text: "b") else return Err(std.fs.describe(error: error))';
  const io = { out: "Result<Unit, String>", effects: "fs.write" };
  const source = fn(`let w: Unit = ${write}\nreturn Ok(Unit)`, io);
  const d = one(source, "E0235");
  assertEquals([d.at, d.expected, d.fix], [`let w: Unit = ${write}`, write, {
    replace: `let w: Unit = ${write}`,
    with: write,
  }]);
  assertEquals(
    d.message,
    "A `let` binds no `Unit`, which carries nothing (3): write the statement without `let w: Unit = `.",
  );
  clean(fixed(source, d));
  // A used name: no fix, since the uses would dangle.
  const used = one(fn(`let w: Unit = ${write}\nreturn Ok(w)`, io), "E0235");
  assertEquals([used.expected, used.fix], [write, null]);
  assertEquals(used.message.endsWith("without `let w: Unit = `, and `Unit` where `w` is used."), true);
  const print = one(fn('let u: Unit = std.console.print_line(text: "a")\nreturn 0', { effects: "console" }), "E0235");
  assertEquals(print.fix?.with, 'std.console.print_line(text: "a")');
  // A match of Unit arms stays a match statement.
  const units = fn(
    'let x: Unit = match o\n  case Some(v) then\n    std.console.print_line(text: v)\n  case None then\n    std.console.print_line(text: "none")\nend match\nreturn 0',
    { params: ["o: Option<String>"], effects: "console" },
  );
  const m = one(units, "E0235");
  assertEquals(m.fix, { replace: "let x: Unit = match o", with: "match o" });
  clean(fixed(units, m));
  // A block value with `else`: without the let it would not parse, so no fix.
  const options = fn(
    "let x: Unit = match o\n  case Some(v) then\n    Some(Unit)\n  case None then\n    None\nend match else return 0\nreturn 1",
    { params: ["o: Option<String>"] },
  );
  const block = one(options, "E0235");
  assertEquals([block.fix, block.expected], [null, null]);
  assertEquals(
    block.message,
    "A `let` binds no `Unit`, which carries nothing (3): bind the `match` to a `Result` or an `Option` with `let` first, then propagate that name.",
  );
  // One cause, one diagnostic: a let that fails otherwise is not E0235 too.
  one(fn("let u: Unit = nothing()\nreturn 0"), "E0201");
  one(fn("let u: Unit = 1\nreturn 0"), "E0204");
  // Patterns, lambda parameters and for variables may still be Unit.
  clean(fn(
    "let r: Result<Unit, String> = Ok(Unit)\nlet n: Int = match r\n  case Ok(done) then\n    1\n  case Err(e) then\n    0\nend match\nreturn n",
  ));
  clean(fn(
    "let ones: List<Int> = std.list.map(list: [Unit, Unit], with: fn(u: Unit): Int => 1)\nreturn std.list.length(list: ones)",
  ));
});

Deno.test("check: a discarded Result<Unit, E> points to the propagation statement (T4)", () => {
  const io = { out: "Result<Unit, String>", effects: "fs.write" };
  const d = one(fn('std.fs.write_text(path: "a", text: "b")\nreturn Ok(Unit)', io), "E0217");
  assertEquals(d.expected, 'std.fs.write_text(path: "a", text: "b") else return …');
  assertEquals(
    d.message,
    "The value of type `Result<Unit, std.fs.Error>` is discarded; propagate its error: `… else return …`.",
  );
  assertEquals(d.fix, null);
  // Any other value keeps the message that names `let`.
  const other = one(fn('std.int.parse(text: "1")\nreturn 0'), "E0217");
  assertEquals(other.expected, null);
});

Deno.test("check: a list of known length is taken apart by name (T11)", () => {
  clean(fn(
    'let [method, path, status]: List<String> = std.string.split(text: line, separator: " ") else return None\nreturn Some(status)',
    { params: ["line: String"], out: "Option<String>" },
  ));
  // The declared type is the value's expected type: the literal is a List<Int>.
  clean(fn("let [only]: List<Int> = [1] else return 0\nreturn only"));
  // `error` is Unit in the else value.
  clean(fn("let [a, b]: List<Int> = xs else return Err(error)\nreturn Ok(a + b)", {
    params: ["xs: List<Int>"],
    out: "Result<Int, Unit>",
  }));
  // The fragment of section 3.
  clean(fn(specBlock("let [path, text]").trimEnd() + "\nreturn Ok(Unit)", {
    params: ["line: String"],
    out: "Result<Unit, String>",
    effects: "fs.write",
  }));
});

Deno.test("check: the type of a let [...] is the list's type (T11)", () => {
  const parts = { params: ["parts: List<String>"], out: "Option<String>" };
  const source = fn("let [a, b]: String = parts else return None\nreturn Some(b)", parts);
  const d = one(source, "E0204");
  assertEquals(d.at, "let [a, b]: String = parts else return None");
  assertEquals(d.message, "`[a, b]` is a list, so its type is a `List`: `List<String>`.");
  assertEquals([d.expected, d.fix], ["List<String>", { replace: "]: String =", with: "]: List<String> =" }]);
  clean(fixed(source, d));
  // A value that is no List: the placeholder, and no fix.
  const option = one(
    fn("let [a]: String = o else return None\nreturn Some(a)", {
      params: ["o: Option<String>"],
      out: "Option<String>",
    }),
    "E0204",
  );
  assertEquals([option.expected, option.fix], ["List<T>", null]);
  one(
    fn("let [a]: List<String> = o else return None\nreturn Some(a)", {
      params: ["o: Option<String>"],
      out: "Option<String>",
    }),
    "E0204",
  );
  one(fn("let [a, a]: List<String> = parts else return None\nreturn Some(a)", parts), "E0216");
  one(fn("let [parts, b]: List<String> = parts else return None\nreturn Some(b)", parts), "E0216");
  // The names are not visible in the else value.
  one(fn("let [a]: List<String> = parts else return Some(a)\nreturn Some(a)", parts), "E0203");
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

// ---- list literals ----

Deno.test("check: a list literal takes its item type from the expected type, else from the first item (1.4)", () => {
  clean(fn("let xs: List<Int> = [1, 2, 3]\nreturn std.list.length(list: xs)"));
  clean(fn("return std.list.length(list: [1, 2, 3])"));
  clean(fn('return [std.string.length(text: "a"), 2] == [1, 2]', { out: "Bool" }));
  clean(fn("let xss: List<List<Int>> = [[1], [2, 3]]\nreturn std.list.length(list: xss)"));
  clean(fn("let p: List<Point> = [Point(x: 1, y: 2)]\nreturn 0", { extra: POINT }));
  // The expected type reaches every item, so `None` first is fine there.
  clean(fn("let xs: List<Option<Int>> = [None, Some(1)]\nreturn 0"));
  clean(fn("return std.list.length(list: [Some(1), None])"));
  const mixed = one(fn("let xs: List<Float> = [1.0, 2]\nreturn 0"), "E0204");
  assertEquals(mixed.fix, { replace: "2", with: "2.0" });
  // Without an expected type, the first item decides: `[1.0, 2]` is a List<Float>.
  assertEquals(one(fn("return std.list.length(list: [1.0, 2])"), "E0204").fix, { replace: "2", with: "2.0" });
  one(fn("return std.list.length(list: [None, Some(1)])"), "E0210");
  one(fn("let x: Int = [1]\nreturn x"), "E0204");
  one(fn('let xs: List<Int> = [1, "a"]\nreturn 0'), "E0204");
});

Deno.test("check: the empty list is written std.list.empty<T>() (E0228)", () => {
  const sites: [string, Parameters<typeof fn>[1], string][] = [
    ["let xs: List<Int> = []\nreturn 0", {}, "std.list.empty<Int>()"],
    ["return []", { out: "List<Point>", extra: POINT }, "std.list.empty<Point>()"],
    ['return std.string.join(parts: [], separator: ",")', { out: "String" }, "std.list.empty<String>()"],
    ["return xs == []", { params: ["xs: List<Option<Int>>"], out: "Bool" }, "std.list.empty<Option<Int>>()"],
    ["let xss: List<List<Int>> = [[1], []]\nreturn 0", {}, "std.list.empty<Int>()"],
  ];
  for (const [body, o, empty] of sites) {
    const source = fn(body, o);
    const d = one(source, "E0228");
    assertEquals(
      [d.at, d.message, d.expected, d.fix],
      ["[]", "The empty list is written `std.list.empty<T>()`, with its item type (1.4).", empty, {
        replace: "[]",
        with: empty,
      }],
    );
    // Applied, the fix gives an accepted program; `[]` occurs once in each.
    clean(source.replace(d.at, d.at.replace(d.fix!.replace, d.fix!.with)));
  }
  // Without an expected item type there is no fix.
  const bare = one(fn("return std.list.length(list: [])"), "E0228");
  assertEquals([bare.expected, bare.fix], ["std.list.empty<T>()", null]);
  // Nor when the item type is `() -> Int`: a zero-parameter function type has no written form (F5).
  const fns = one(fn("return std.list.length(list: std.list.concat(left: [g], right: []))", { extra: G }), "E0228");
  assertEquals([fns.expected, fns.fix], ["std.list.empty<T>()", null]);
});

Deno.test("check: items of a list literal follow the usual rules", () => {
  // An own-module name written in full (1.2).
  const long = one(fn("let xs: List<Int> = [m.g(), 2]\nreturn 0", { extra: G }), "E0226");
  assertEquals([long.at, long.fix], ["m.g()", { replace: "m.g", with: "g" }]);
  // An effectful call in a pure function.
  one(fn("let xs: List<Option<String>> = [std.console.read_line()]\nreturn 0"), "E0230");
  clean(fn("let xs: List<Option<String>> = [std.console.read_line()]\nreturn 0", { effects: "console" }));
  one(fn("return [g] == [g]", { out: "Bool", extra: G }), "E0222");
});

Deno.test("check: std.list.contains and std.text.show need a type without function values (E0222)", () => {
  const contains = one(fn("return std.list.contains(list: [g], item: g)", { out: "Bool", extra: G }), "E0222");
  assertEquals(
    [contains.at, contains.message],
    [
      "std.list.contains(list: [g], item: g)",
      "`std.list.contains` is defined for types without function values (3.9).",
    ],
  );
  const show = one(fn("return std.text.show(value: [g])", { out: "String", extra: G }), "E0222");
  assertEquals(show.message, "`std.text.show` is defined for types without function values (3.9).");
  clean(
    fn("return std.list.contains(list: [Point(x: 1, y: 2)], item: Point(x: 1, y: 2))", { out: "Bool", extra: POINT }),
  );
  clean(fn('return std.text.show(value: ["a"])', { out: "String" }));
});

Deno.test("check: a for passes its declared type to a list literal (1.4)", () => {
  const loop = (iterable: string, declared: string) =>
    fn(
      `for x: ${declared} in ${iterable} do\n  std.console.print_line(text: std.text.show(value: x))\nend for\nreturn 0`,
      {
        effects: "console",
      },
    );
  clean(loop("[None, Some(1)]", "Option<Int>"));
  clean(loop("[[1], std.list.empty<Int>()]", "List<Int>"));
  const float = one(loop("[1]", "Float"), "E0204");
  assertEquals([float.at, float.fix], ["1", { replace: "1", with: "1.0" }]);
  const empty = one(loop("[]", "Int"), "E0228");
  assertEquals(empty.fix, { replace: "[]", with: "std.list.empty<Int>()" });
  assertEquals(one(loop('["a"]', "Int"), "E0204").at, '"a"');
});

Deno.test("check: the E0209 guess offers no type argument it cannot write (H5)", () => {
  // The expected type holds `() -> Int`: a zero-parameter function type has no written form (F5).
  const d = one(
    fn("return std.list.length(list: std.list.concat(left: [g], right: std.list.empty()))", { extra: G }),
    "E0209",
  );
  assertEquals([d.expected, d.fix], ["std.list.empty<T>", null]);
});

// ---- function types (F1, F3, F8) ----

// A pure function `m.<name>` of one parameter, with one example.
function pureFn(name: string, param: string, out: string, value: string, example: string): string {
  return [
    `fn m.${name}`,
    '  doc: "Test."',
    "  in:",
    `    ${param}`,
    `  out: ${out}`,
    "  effects: none",
    "  requires: none",
    "  ensures: none",
    "  examples:",
    `    ${example}`,
    "  body:",
    `    return ${value}`,
    `end fn m.${name}`,
  ].join("\n");
}

const RULE =
  'type m.Rule\n  doc: "A named check of a line."\n  record:\n    name: String\n    broken: (String) -> Bool\n  where: none\nend type m.Rule';
const CHECK =
  'type m.Check\n  doc: "How a number is checked."\n  variant:\n    Custom: (Int) -> Bool\n    Off\n  where: none\nend type m.Check';
const ROW = 'type m.Row\n  doc: "A row."\n  record:\n    name: String\n  where: none\nend type m.Row';
const FNS = [
  RULE,
  CHECK,
  pureFn("double", "n: Int", "Int", "n * 2", "double(n: 2) == 4"),
  pureFn("triple", "n: Int", "Int", "n * 3", "triple(n: 2) == 6"),
  pureFn("to_text", "n: Int", "String", "std.text.show(value: n)", 'to_text(n: 2) == "2"'),
  pureFn("blank", "line: String", "Bool", 'line == ""', 'blank(line: "") == true'),
].join("\n\n");

Deno.test("check: function types stand wherever a type does (F1)", () => {
  clean(fn("return std.list.sort(list: xs, by: by)", {
    params: ["xs: List<Int>", "by: (Int, Int) -> Order"],
    out: "List<Int>",
    examples: [
      "f(xs: [3, 1, 2], by: std.int.compare) == [1, 2, 3]",
      "f(xs: [3, 1, 2], by: fn(a: Int, b: Int): Order => std.int.compare(left: b, right: a)) == [3, 2, 1]",
    ],
  }));
  // A record with a function field, from a lambda and from a function name;
  // a case with a function value.
  clean(fn(
    [
      'let long: Rule = Rule(name: "long", broken: fn(line: String): Bool => std.string.length(text: line) > 80)',
      'let rules: List<Rule> = [long, Rule(name: "blank", broken: blank)]',
      "let checks: List<Check> = [Custom(fn(n: Int): Bool => n > 0), Off]",
      "return std.list.length(list: rules) + std.list.length(list: checks)",
    ].join("\n"),
    { extra: FNS },
  ));
  // A function chosen by an `if`, and one from a map literal.
  clean(fn(
    [
      "let pick: (Int) -> Int = if flag then",
      "  double",
      "else",
      "  triple",
      "end if",
      "return std.list.length(list: std.list.map(list: [1, 2], with: pick))",
    ].join("\n"),
    { params: ["flag: Bool"], extra: FNS },
  ));
  clean(fn(
    [
      'let ops: Map<String, (Int) -> Int> = ["d": double, "t": triple]',
      "let op: (Int) -> Int = std.map.get(map: ops, key: k) else return 0",
      "return std.list.length(list: std.list.map(list: [1], with: op))",
    ].join("\n"),
    { params: ["k: String"], extra: FNS },
  ));
});

Deno.test("check: function types follow the rules of every type (F1, F3)", () => {
  const wrong = one(fn("let t: (Int) -> Int = to_text\nreturn 0", { extra: FNS }), "E0204");
  assertEquals([wrong.at, wrong.message, wrong.expected], [
    "to_text",
    "Expected `(Int) -> Int`, found `(Int) -> String`.",
    "(Int) -> Int",
  ]);
  // A generic function takes its type arguments from the function type
  // expected (G9, which resolves F10), and a function with effects is none
  // where a pure function type is expected (F3).
  clean(fn("let n: (List<Int>) -> Int = std.list.length\nreturn n(std.list.empty<Int>())"));
  one(fn("let say: (String) -> Unit = shout\nreturn 0", { extra: SHOUT }), "E0232");
  // Types holding a function value have no `==` and no `show` (3.9).
  one(fn("return by == by", { params: ["by: (Int, Int) -> Order"], out: "Bool" }), "E0222");
  one(fn("return std.text.show(value: rule)", { params: ["rule: Rule"], out: "String", extra: FNS }), "E0222");
  // Map keys, unknown types and own-module long forms inside a function type.
  const key = one(fn("return 0", { params: ["table: Map<(Int) -> Int, Int>"] }), "E0229");
  assertEquals(key.message, keyMessage("(Int) -> Int"));
  const unknown = one(fn("return 0", { params: ["keep: (Rowz) -> Bool"], extra: ROW }), "E0202");
  assertEquals([unknown.at, unknown.fix], ["Rowz", { replace: "Rowz", with: "Row" }]);
  const long = fn("return 0", { params: ["keep: (m.Row) -> Bool"], extra: ROW });
  const d = one(long, "E0226");
  assertEquals([d.at, d.fix], ["m.Row", { replace: "m.Row", with: "Row" }]);
  assertEquals(shortened(long).includes("    keep: (Row) -> Bool\n"), true);
});

Deno.test("check: an empty collection of a function type is written with its type (F8)", () => {
  const source = fn("let fs: List<(Int) -> Int> = []\nreturn 0");
  const d = one(source, "E0228");
  assertEquals(d.fix, { replace: "[]", with: "std.list.empty<(Int) -> Int>()" });
  // Applied, the fix gives an accepted program; `[]` occurs once.
  clean(source.replace(d.at, d.fix!.with));
  const guess = one(fn("let fs: List<(Int) -> Int> = std.list.empty()\nreturn 0"), "E0209");
  assertEquals(guess.fix, { replace: "std.list.empty()", with: "std.list.empty<(Int) -> Int>()" });
});

// ---- applying function values (F2, F7) ----

const TWICE = pureFn("twice", "x: Int", "Int", "x * 2", "twice(x: 1) == 2");

Deno.test("check: a function value is applied by position (F2)", () => {
  clean(fn("if test(n) then\n  return 1\nend if\nreturn 0", { params: ["n: Int", "test: (Int) -> Bool"] }));
  clean(fn("return rule.broken(line)", { params: ["rule: Rule", "line: String"], out: "Bool", extra: FNS }));
  clean(fn("return std.list.map(list: xs, with: fn(x: Int): Int => h(x))", {
    params: ["xs: List<Int>", "h: (Int) -> Int"],
    out: "List<Int>",
  }));
  // Applying is pure: in a condition and in an example's lambda too.
  clean(
    fn("return low", {
      params: ["low: Int", "high: Int", "by: (Int, Int) -> Order"],
      requires: "by(low, high) != Greater",
    }),
  );
  clean(
    fn("return h(h(x))", {
      params: ["h: (Int) -> Int", "x: Int"],
      examples: ["f(h: fn(n: Int): Int => n + 1, x: 1) == 3"],
    }),
  );
  // Beside a module function of the same name, unnamed arguments apply the
  // parameter and named ones call the function (7.5).
  clean(fn("if check(1) and check(n: 1) then\n  return 1\nend if\nreturn 0", {
    params: ["check: (Int) -> Bool"],
    extra: pureFn("check", "n: Int", "Bool", "n > 0", "check(n: 1) == true"),
  }));
});

Deno.test("check: an application works with the statements (F2, T1, T7, T11)", () => {
  clean(fn("check(x) else return Err(error)\nreturn Ok(Unit)", {
    params: ["x: Int", "check: (Int) -> Result<Unit, String>"],
    out: "Result<Unit, String>",
  }));
  clean(fn("let [first, second]: List<(Int) -> Int> = fs else return 0\nreturn first(second(1))", {
    params: ["fs: List<(Int) -> Int>"],
  }));
  // A name that not every pattern of a shared case binds is hidden there.
  const hidden = one(
    fn("let ok: Bool = match c\n  case Custom(test) or Off then\n    test(1)\nend match\nreturn 0", {
      params: ["c: Check"],
      extra: FNS,
    }),
    "E0236",
  );
  assertEquals(hidden.at, "test");
});

Deno.test("check: a function defined with fn called by position gets its names as fix (E0107)", () => {
  const message =
    "`twice` is defined with `fn`, so every argument carries its parameter name (4.1); only a function value is applied by position.";
  const source = fn("return twice(x)", { params: ["x: Int"], extra: TWICE });
  const d = one(source, "E0107");
  assertEquals([d.at, d.message, d.expected, d.fix], [
    "twice(x)",
    message,
    "twice(x: x)",
    { replace: "twice(x)", with: "twice(x: x)" },
  ]);
  clean(source.replace(d.at, d.fix!.with));
  const compare = one(
    fn("return 0", { params: ["a: Int", "b: Int"], requires: "std.int.compare(a, b) == Less" }),
    "E0107",
  );
  assertEquals(compare.fix, { replace: "std.int.compare(a, b)", with: "std.int.compare(left: a, right: b)" });
  // Another count: no fix, the parameters as expected.
  const count = one(fn("return twice(1, 2)", { extra: TWICE }), "E0107");
  assertEquals([count.expected, count.fix], ["twice(x: Int)", null]);
  // The named call is checked at the written text: its own causes are
  // reported there, and nothing follows from the missing names (5.6).
  const typed = check(fn("return twice(x: 1) + twice(true)", { extra: TWICE }));
  assertEquals(typed.map((d) => [d.code, d.at]), [["E0107", "twice(true)"], ["E0204", "true"]]);
  const long = check(fn("return m.twice(1)", { extra: TWICE }));
  assertEquals(long.map((d) => [d.code, d.at, d.fix?.replace]), [
    ["E0107", "m.twice(1)", "m.twice(1)"],
    ["E0226", "m.twice(1)", "m.twice"],
  ]);
  // In an example, E0107 instead of E0221.
  const example = one(pureFn("twice", "x: Int", "Int", "x * 2", "twice(2) == 4"), "E0107");
  assertEquals([example.section, example.at, example.fix], ["examples", "twice(2)", {
    replace: "twice(2)",
    with: "twice(x: 2)",
  }]);
  const unknown = one(fn("return nothing(1)"), "E0201");
  assertEquals(unknown.message, "Unknown function `nothing`.");
});

Deno.test("check: named arguments on a function value get the application as fix (E0220)", () => {
  const method = one(fn("return std.list.length(list: xs.map(f))", { params: ["xs: List<Int>"] }), "E0220");
  assertEquals([method.at, method.message], [
    "xs.map(f)",
    "There are no method calls (3.1); `xs` is a value. Pass it as a named argument instead.",
  ]);
  const named = one(fn("return h(x: 1)", { params: ["h: (Int) -> Int"] }), "E0220");
  assertEquals([named.message, named.expected, named.fix], [
    "`h` is a function value of type `(Int) -> Int`; it takes its arguments by position, without names (4.1).",
    "h(1)",
    { replace: "h(x: 1)", with: "h(1)" },
  ]);
  const field = one(
    fn("return rule.broken(line: l)", { params: ["rule: Rule", "l: String"], out: "Bool", extra: FNS }),
    "E0220",
  );
  assertEquals(field.fix, { replace: "rule.broken(line: l)", with: "rule.broken(l)" });
  const none = one(fn("return h()", { params: ["h: (Int) -> Int"] }), "E0220");
  assertEquals([none.expected, none.fix], ["(Int) -> Int", null]);
  // Each value against the parameter at its position (5.6).
  one(fn("return h(x: None)", { params: ["h: (Option<Int>) -> Int"] }), "E0220");
  const length = one(fn("let xs: List<Int> = std.list.empty<Int>()\nreturn xs.length()"), "E0220");
  assertEquals(
    length.message,
    "There are no method calls (3.1); `xs` is a value. Pass it as a named argument instead.",
  );
});

Deno.test("check: only a function value is applied, with as many arguments as its type has (E0238)", () => {
  const value = one(fn("return count(1)", { params: ["count: Int"] }), "E0238");
  assertEquals(value.message, "`count` has type `Int` and is not a function value, so it cannot be applied.");
  const by = one(fn("return 0", { params: ["by: (Int, Int) -> Order"], requires: "by(1) == Less" }), "E0238");
  assertEquals([by.message, by.expected], [
    "`by` takes 2 arguments, found 1: its type is `(Int, Int) -> Order`.",
    "(Int, Int) -> Order",
  ]);
  // The arguments still get their parameter types, so `None` adds no E0210.
  one(fn("return pick(None)", { params: ["pick: (Option<Int>, Int) -> Int"] }), "E0238");
  assertEquals(
    one(fn("return 0", { params: ["by: (Int, Int) -> Order"], requires: 'by(1, "a") == Less' }), "E0204").at,
    '"a"',
  );
});

Deno.test("check: no fn returns a function value, also not inside another type (E0237)", () => {
  const d = one(fn("return double", { out: "(Int) -> Int", extra: FNS }), "E0237");
  assertEquals([d.section, d.at, d.message, d.expected, d.fix], [
    "out",
    "(Int) -> Int",
    "`f` returns `(Int) -> Int`, which holds a function value; a `fn` never does, since its result could not be compared, shown or stated in an example (3.9, 5.1). Build the function where it is applied, with `let` (from a `match`, an `if` or a map literal), or take what decides it as a parameter. For a lookup, return the name and apply the function where it is used; a table of functions is a `const`.",
    null,
    null,
  ]);
  const cases: [string, string][] = [
    ["Option<(Int) -> Int>", "return Some(double)"],
    ["List<Rule>", 'return [Rule(name: "blank", broken: blank)]'],
    ["Map<String, (Int) -> Int>", 'return ["d": double]'],
    ["Check", "return Off"],
  ];
  for (const [out, body] of cases) assertEquals(one(fn(body, { out, extra: FNS }), "E0237").at, out);
  // With effects too: the rule is one sentence.
  one(fn("return double", { out: "(Int) -> Int", effects: "console", extra: FNS }), "E0237");
  // The example's `==` on that result is the same cause (5.6).
  one(fn("return double", { out: "(Int) -> Int", examples: ["f() == double"], extra: FNS }), "E0237");
});

Deno.test("check: lambdas may return functions, and a fn may take records holding them (F4)", () => {
  clean(fn(
    [
      "let add: (Int) -> (Int) -> Int = fn(x: Int): (Int) -> Int => fn(y: Int): Int => x + y",
      "let inc: (Int) -> Int = add(1)",
      "return inc(2)",
    ].join("\n"),
  ));
  clean(fn("return std.list.map(list: rules, with: fn(rule: Rule): String => rule.name)", {
    params: ["rules: List<Rule>"],
    out: "List<String>",
    extra: FNS,
  }));
});

// ---- maps ----

const keyMessage = (found: string) =>
  `Map keys are \`Int\` or \`String\`, found \`${found}\`; key the map by an \`Int\` or \`String\` field, or keep a \`List\` of records.`;

Deno.test("check: map keys are Int or String, wherever the type arises (E0229)", () => {
  // A written type.
  const written = one(fn("return 0", { params: ["m: Map<Float, Int>"] }), "E0229");
  assertEquals([written.at, written.message, written.expected, written.fix], [
    "Map<Float, Int>",
    keyMessage("Float"),
    "Int or String",
    null,
  ]);
  // Type arguments of a std call, a type nested in one, and a key type bound from an argument.
  const sites: [string, Parameters<typeof fn>[1], string, string][] = [
    [
      "return std.map.size(map: std.map.empty<Point, Int>())",
      { extra: POINT },
      "std.map.empty<Point, Int>()",
      "Point",
    ],
    ["return std.list.length(list: std.list.empty<Map<Bool, Int>>())", {}, "Map<Bool, Int>", "Bool"],
    [
      "return std.map.size(map: std.map.from_list(list: [1.5], key: fn(x: Float): Float => x, value: fn(x: Float): Int => 1))",
      {},
      "std.map.from_list(list: [1.5], key: fn(x: Float): Float => x, value: fn(x: Float): Int => 1)",
      "Float",
    ],
  ];
  for (const [body, o, at, found] of sites) {
    const d = one(fn(body, o), "E0229");
    assertEquals([d.at, d.message], [at, keyMessage(found)]);
  }
  // One cause, one report (5.6): the call that builds the declared type is not reported again.
  const once = one(fn("let m: Map<Point, Int> = std.map.empty<Point, Int>()\nreturn 0", { extra: POINT }), "E0229");
  assertEquals(once.at, "Map<Point, Int>");
  // An argument that failed binds nothing, so the result's key type stays open: no E0229.
  one(fn("let m: Map<String, Int> = std.map.insert(map: nope, key: nope, value: 1)\nreturn 0"), "E0203");
});

Deno.test("check: maps through the std functions", () => {
  clean(fn(
    'let m: Map<String, Int> = std.map.insert(map: std.map.empty<String, Int>(), key: "a", value: 1)\n' +
      'let n: Int = std.map.get(map: m, key: "a") else return 0\n' +
      "let words: List<String> = std.map.to_list(map: m, with: fn(k: String, v: Int): String => k)\n" +
      "return n + std.list.length(list: words)",
  ));
  clean(fn(
    "let m: Map<Int, List<Point>> = std.map.insert(map: std.map.empty<Int, List<Point>>(), key: 1, value: [Point(x: 1, y: 2)])\n" +
      "let points: List<Point> = std.map.get(map: m, key: 1) else return 0\n" +
      "let all: List<List<Point>> = std.map.to_list(map: m, with: fn(k: Int, v: List<Point>): List<Point> => v)\n" +
      "return std.list.length(list: points) + std.list.length(list: all)",
    { extra: POINT },
  ));
  // The expected type names the type arguments of the empty map.
  const source = fn("let m: Map<String, Int> = std.map.empty()\nreturn std.map.size(map: m)");
  const d = one(source, "E0209");
  assertEquals(d.fix, { replace: "std.map.empty()", with: "std.map.empty<String, Int>()" });
  clean(source.replace(d.at, d.at.replace(d.fix!.replace, d.fix!.with)));
});

Deno.test("check: a map literal takes its types from the expected type, else from the first entry (1.4)", () => {
  clean(fn('let m: Map<String, Int> = ["a": 1, "b": 2]\nreturn std.map.size(map: m)'));
  clean(fn('return std.map.size(map: ["a": 1, "b": 2])'));
  clean(fn('return std.map.size(map: [1: ["x"], 2: std.list.empty<String>()])'));
  clean(fn("let m: Map<Int, List<Point>> = [1: [Point(x: 1, y: 2)]]\nreturn std.map.size(map: m)", { extra: POINT }));
  clean(fn('return ["b": 2, "a": 1] == ["a": 1, "b": 2]', { out: "Bool" }));
  // The expected type reaches every entry, so `None` first is fine there.
  clean(fn('let m: Map<String, Option<Int>> = ["a": None, "b": Some(1)]\nreturn std.map.size(map: m)'));
  one(fn('return std.map.size(map: ["a": None, "b": Some(1)])'), "E0210");
  const mixed = one(fn('let m: Map<String, Float> = ["a": 1.0, "b": 2]\nreturn 0'), "E0204");
  assertEquals([mixed.at, mixed.fix], ["2", { replace: "2", with: "2.0" }]);
  one(fn("let m: Map<String, Int> = [1: 1]\nreturn 0"), "E0204");
  one(fn('let m: Map<String, Int> = ["a": 1, 2: 2]\nreturn 0'), "E0204");
  one(fn('let x: Int = ["a": 1]\nreturn x'), "E0204");
  // An inferred key type that is not Int or String; a written one is reported once, where it is written.
  const inferred = one(fn("return std.map.size(map: [1.5: 1])"), "E0229");
  assertEquals([inferred.at, inferred.message], ["[1.5: 1]", keyMessage("Float")]);
  assertEquals(one(fn("return std.map.size(map: [[1]: 1])"), "E0229").message, keyMessage("List<Int>"));
  const written = one(fn("let m: Map<Point, Int> = [Point(x: 1, y: 2): 1]\nreturn 0", { extra: POINT }), "E0229");
  assertEquals(written.at, "Map<Point, Int>");
});

Deno.test("check: a literal key written twice is E0234; a bare unknown name as a key gets quotes (E0203)", () => {
  const twice = one(fn('return std.map.size(map: ["a": 1, "b": 2, "a": 3])'), "E0234");
  assertEquals([twice.at, twice.message, twice.expected, twice.fix], [
    '"a": 3',
    'The key `"a"` already has an entry in this map; write each key once.',
    null,
    null,
  ]);
  assertEquals(one(fn('return std.map.size(map: [1: "x", 1: "y"])'), "E0234").at, '1: "y"');
  assertEquals(
    one(fn("return std.map.size(map: [-1: 0, -1: 1])"), "E0234").message,
    "The key `-1` already has an entry in this map; write each key once.",
  );
  // Computed keys trap at runtime instead, if they are equal.
  clean(fn("return std.map.size(map: [x: 1, y: 2])", { params: ["x: String", "y: String"] }));
  clean(fn("return std.map.size(map: [1: 1, -1: 2, 2: 3])"));
  // The habit from JavaScript object keys (5.7).
  const source = fn("let m: Map<String, Int> = [name: 1, other: 2]\nreturn std.map.size(map: m)");
  const ds = check(source);
  assertEquals(ds.map((d) => [d.code, d.at, d.message, d.expected, d.fix]), [
    [
      "E0203",
      "name",
      'Unknown name `name`; a map key is a value, so a text key is written in quotes: `"name"`.',
      '"name"',
      {
        replace: "name",
        with: '"name"',
      },
    ],
    [
      "E0203",
      "other",
      'Unknown name `other`; a map key is a value, so a text key is written in quotes: `"other"`.',
      '"other"',
      {
        replace: "other",
        with: '"other"',
      },
    ],
  ]);
  clean(source.replace("[name: 1, other: 2]", '["name": 1, "other": 2]'));
  // A local or a function of the module is a key like any other value.
  clean(fn("return std.map.size(map: [g(): 1])", { extra: G }));
  // A for over a map names the ways to a list.
  const loop = one(
    fn('for k: String in ["a": 1] do\n  std.console.print_line(text: k)\nend for\nreturn 0', { effects: "console" }),
    "E0204",
  );
  assertEquals(
    loop.message,
    "`for` iterates over a List, found `Map<String, Int>`; take `std.map.keys` or `std.map.to_list` of it.",
  );
});

Deno.test("check: the empty map is written std.map.empty<K, V>() (E0228), in both directions", () => {
  const mapMessage = "The empty map is written `std.map.empty<K, V>()`, with its key and value types (1.4).";
  const listMessage = "The empty list is written `std.list.empty<T>()`, with its item type (1.4).";
  const sites: [string, Parameters<typeof fn>[1], string, string, string][] = [
    ["let m: Map<String, Int> = [:]\nreturn 0", {}, "[:]", mapMessage, "std.map.empty<String, Int>()"],
    [
      "return m == [:]",
      { params: ["m: Map<Int, Point>"], out: "Bool", extra: POINT },
      "[:]",
      mapMessage,
      "std.map.empty<Int, Point>()",
    ],
    ["let m: Map<String, Int> = []\nreturn 0", {}, "[]", mapMessage, "std.map.empty<String, Int>()"],
    ["let xs: List<Int> = [:]\nreturn 0", {}, "[:]", listMessage, "std.list.empty<Int>()"],
    ['let m: Map<String, List<Int>> = ["a": [:]]\nreturn 0', {}, "[:]", listMessage, "std.list.empty<Int>()"],
  ];
  for (const [body, o, at, message, empty] of sites) {
    const source = fn(body, o);
    const d = one(source, "E0228");
    assertEquals([d.at, d.message, d.expected, d.fix], [at, message, empty, { replace: at, with: empty }]);
    clean(source.replace(at, empty));
  }
  // Without expected types, or with `() -> Int` among them (no written form, F5), there is no fix.
  const bare = one(fn("return std.map.size(map: [:])"), "E0228");
  assertEquals([bare.message, bare.expected, bare.fix], [mapMessage, "std.map.empty<K, V>()", null]);
  const fns = one(fn('return std.list.length(list: [["a": g], [:]])', { extra: G }), "E0228");
  assertEquals([fns.expected, fns.fix], ["std.map.empty<K, V>()", null]);
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
  assertEquals(
    one(fn("return a", { params: ["a: Int"], examples: ["g() == 1"], extra: G }), "E0221").message,
    "An example's left side is a call of the function it belongs to: `f(…) == …` (5.1).",
  );
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

// Every std function with an effect but std.http.serve (tested below), as a
// statement that binds its result, in the order of STD.
const EFFECTFUL: [string, string][] = [
  ['std.console.print_line(text: "x")', "console"],
  ['std.console.print(text: "x")', "console"],
  ["let r: Option<String> = std.console.read_line()", "console"],
  ["let r: List<String> = std.env.args()", "env"],
  ['let r: Option<String> = std.env.get(name: "HOME")', "env"],
  ['let r: Result<String, std.fs.Error> = std.fs.read_text(path: "x")', "fs.read"],
  ['let r: Result<Unit, std.fs.Error> = std.fs.write_text(path: "x", text: "y")', "fs.write"],
  ['let r: Result<Unit, std.fs.Error> = std.fs.append_text(path: "x", text: "y")', "fs.write"],
  ['let r: Result<Unit, std.fs.Error> = std.fs.create_text(path: "x", text: "y")', "fs.write"],
  ['let r: Result<List<String>, std.fs.Error> = std.fs.list_directory(path: "x")', "fs.read"],
  ['let r: Result<std.fs.Kind, std.fs.Error> = std.fs.kind(path: "x")', "fs.read"],
  ['let r: Result<Unit, std.fs.Error> = std.fs.create_directory(path: "x")', "fs.write"],
  ['let r: Result<Unit, std.fs.Error> = std.fs.remove(path: "x")', "fs.write"],
  [
    'let r: Result<std.http.Response, std.http.SendError> = std.http.send(method: "GET", url: "http://localhost/", ' +
    'headers: std.list.empty<std.http.Header>(), content: "", timeout_milliseconds: 1000)',
    "net",
  ],
  ['std.log.print_line(text: "x")', "log"],
  ["let r: Int = std.random.int(low: 1, high: 6)", "random"],
  ["let r: Int = std.time.now_milliseconds()", "time"],
  ["std.time.wait(milliseconds: 10)", "time"],
];

Deno.test("effects: each std function with an effect needs it on the caller (2.1)", () => {
  const effectful = STD.filter((s) => s.effects.length > 0 && s.name !== "std.http.serve").map((s) => s.name);
  assertEquals(EFFECTFUL.map(([call]) => effectful.find((name) => call.includes(`${name}(`))), effectful);
  for (const [call, effect] of EFFECTFUL) {
    assertEquals(one(fn(call + "\nreturn 0"), "E0230").fix?.with, `effects: ${effect}`, call);
    clean(fn(call + "\nreturn 0", { effects: effect }));
  }
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
