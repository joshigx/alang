// Lexer and parser rules beyond the spec examples, and the round trip
// "parse, print, parse again" on constructs the spec does not show.

import { assertEquals, assertThrows } from "./assert.ts";
import { parseExpression, parseProgram, parseStatements } from "../src/parser.ts";
import { printExpr, printProgram, printStmts } from "../src/printer.ts";
import { AlangError } from "../src/diagnostic.ts";

function code(fn: () => unknown): string {
  return assertThrows(fn, AlangError).diagnostic.code;
}

function canonicalExpr(source: string): string {
  const tree = parseExpression(source);
  const printed = printExpr(tree, "");
  assertEquals(parseExpression(printed), tree, `round trip of ${source}`);
  return printed;
}

Deno.test("names: spelling is enforced by the lexer (3.6)", () => {
  assertEquals(code(() => parseExpression("myValue")), "E0002");
  assertEquals(code(() => parseExpression("My_Type")), "E0002");
  const d = assertThrows(() => parseExpression("portNumber"), AlangError).diagnostic;
  assertEquals(d.fix, { replace: "portNumber", with: "port_number" });
});

Deno.test("numbers: thousands are grouped exactly when longer than four digits (4.7)", () => {
  assertEquals(canonicalExpr("65_535"), "65_535");
  assertEquals(canonicalExpr("1000"), "1000");
  assertEquals(canonicalExpr("1_000_000"), "1_000_000");
  assertEquals(code(() => parseExpression("65535")), "E0003");
  assertEquals(code(() => parseExpression("1_000")), "E0003");
  assertEquals(code(() => parseExpression("007")), "E0003");
  assertEquals(canonicalExpr("-3"), "-3");
  assertEquals(canonicalExpr("12_345.5"), "12_345.5");
  assertEquals(canonicalExpr("1.0"), "1.0");
});

Deno.test("strings: one spelling per character", () => {
  assertEquals(canonicalExpr('"a\\"b\\\\c\\nd\\te"'), '"a\\"b\\\\c\\nd\\te"');
  assertEquals(canonicalExpr('"\\u{1B}[0m"'), '"\\u{1B}[0m"');
  assertEquals(canonicalExpr('"Grüße ✓"'), '"Grüße ✓"');
  assertEquals(code(() => parseExpression('"\\u{41}"')), "E0005");
  assertEquals(code(() => parseExpression('"\\r"')), "E0005");
  assertEquals(code(() => parseExpression('"\\u{a}"')), "E0005");
});

Deno.test("strings: a C escape gets its \\u{...} form as the fix (E0005)", () => {
  const cases: [string, string, number][] = [
    ["\\r", "\\u{D}", 0x0d],
    ["\\0", "\\u{0}", 0x00],
    ["\\a", "\\u{7}", 0x07],
    ["\\b", "\\u{8}", 0x08],
    ["\\f", "\\u{C}", 0x0c],
    ["\\v", "\\u{B}", 0x0b],
    ["\\e", "\\u{1B}", 0x1b],
  ];
  for (const [written, fixed, cp] of cases) {
    const source = `"a${written}b"`;
    const d = assertThrows(() => parseExpression(source), AlangError).diagnostic;
    assertEquals([d.code, d.at, d.expected, d.fix], ["E0005", written, fixed, { replace: written, with: fixed }]);
    // Applied, the fix gives the character the C escape stands for.
    const repaired = parseExpression(source.replace(d.fix!.replace, d.fix!.with));
    assertEquals(repaired, { kind: "string", value: `a${String.fromCodePoint(cp)}b` });
  }
  // Other unknown escapes, and `\0` before a digit (a C octal escape), have no fix.
  for (const written of ["\\q", "\\x", "\\'", "\\u0041", "\\012"]) {
    const d = assertThrows(() => parseExpression(`"${written}"`), AlangError).diagnostic;
    assertEquals([d.code, d.at, d.expected, d.fix], ["E0005", written.slice(0, 2), null, null]);
  }
});

Deno.test("foreign habits get dedicated diagnostics (5.7)", () => {
  assertEquals(code(() => parseExpression("a === b")), "E0006");
  assertEquals(code(() => parseExpression("a && b")), "E0006");
  assertEquals(code(() => parseStatements("var x: Int = 1")), "E0006");
  assertEquals(code(() => parseStatements("let x: Int = 1 // one")), "E0006");
  assertEquals(code(() => parseStatements("let x: Int = f(a: 1)?")), "E0006");
  assertEquals(code(() => parseExpression("xs[0]")), "E0006");
  assertEquals(code(() => parseExpression("null")), "E0006");
});

Deno.test("operators: mixing requires parentheses (3.5)", () => {
  assertEquals(code(() => parseExpression("a + b * c")), "E0102");
  assertEquals(code(() => parseExpression("a and b or c")), "E0102");
  assertEquals(code(() => parseExpression("a < b < c")), "E0102");
  assertEquals(canonicalExpr("a + (b * c)"), "a + (b * c)");
  assertEquals(canonicalExpr("(a + b) * c"), "(a + b) * c");
  assertEquals(canonicalExpr("a - (b - c)"), "a - (b - c)");
  assertEquals(canonicalExpr("(a - b) - c"), "a - b - c");
  assertEquals(canonicalExpr("((a))"), "a");
  assertEquals(canonicalExpr("(a and b) or c"), "(a and b) or c");
  assertEquals(canonicalExpr("not a == b"), "not a == b");
  assertEquals(canonicalExpr("not (a and b)"), "not (a and b)");
  assertEquals(canonicalExpr("(a == b) == c"), "(a == b) == c");
  assertEquals(canonicalExpr("n < 1 or n > 65_535"), "n < 1 or n > 65_535");
  assertEquals(canonicalExpr("a - -3"), "a - -3");
});

Deno.test("calls, constructs, fields and type arguments", () => {
  assertEquals(canonicalExpr("std.list.empty<Int>()"), "std.list.empty<Int>()");
  assertEquals(canonicalExpr("n < limit"), "n < limit");
  assertEquals(canonicalExpr("n < Limit"), "n < Limit");
  assertEquals(canonicalExpr("port.value"), "port.value");
  assertEquals(canonicalExpr("make(x: 1).value"), "make(x: 1).value");
  assertEquals(canonicalExpr("(a + b).value"), "(a + b).value");
  assertEquals(canonicalExpr("Err(OutOfRange(n))"), "Err(OutOfRange(n))");
  assertEquals(canonicalExpr("net.port.Port(value: 1)"), "net.port.Port(value: 1)");
  assertEquals(canonicalExpr("f(\n  a: 1,\n  b: 2\n)"), "f(a: 1, b: 2)");
  assertEquals(code(() => parseExpression("f(1)")), "E0107");
  assertEquals(code(() => parseExpression("-x")), "E0106");
});

Deno.test("statements: blocks round-trip at any indentation", () => {
  const source = [
    "let kind: String = match parse(text: raw)",
    "  case Ok(port) then",
    '    "port"',
    "  case Err(NotANumber) then",
    '    "text"',
    "  case Err(OutOfRange(n)) then",
    '    "range"',
    "end match",
    'if kind == "port" then',
    "  std.console.print_line(text: kind)",
    "else",
    "  return Unit",
    "end if",
    "for x: Int in xs do",
    "  std.console.print_line(text: std.text.show(value: x))",
    "end for",
  ].join("\n");
  const tree = parseStatements(source);
  assertEquals(printStmts(tree, ""), source);
  // Indentation has no meaning (3.7): a flattened text has the same tree.
  const flat = source.split("\n").map((l) => l.trim()).join("\n");
  assertEquals(parseStatements(flat), tree);
});

Deno.test("match: there is no catch-all case (3.3)", () => {
  assertEquals(code(() => parseStatements("match x\ncase other then\n1\nend match")), "E0108");
});

Deno.test("definitions: section order, end names and effects", () => {
  const fn = (extra: Partial<Record<string, string>>) =>
    [
      "fn m.f",
      '  doc: "d"',
      "  in: none",
      "  out: Unit",
      `  effects: ${extra.effects ?? "none"}`,
      "  requires: none",
      "  ensures: none",
      "  examples: none",
      "  body:",
      "    return Unit",
      `end fn ${extra.end ?? "m.f"}`,
    ].join("\n");
  assertEquals(printProgram(parseProgram(fn({}))), fn({}) + "\n");
  assertEquals(printProgram(parseProgram(fn({ effects: "fs.read, net" }))), fn({ effects: "fs.read, net" }) + "\n");
  assertEquals(code(() => parseProgram(fn({ end: "m.g" }))), "E0103");
  assertEquals(code(() => parseProgram(fn({ effects: "disk" }))), "E0104");
  assertEquals(code(() => parseProgram(fn({ effects: "net, fs.read" }))), "E0111");
  assertEquals(code(() => parseProgram(fn({ effects: "console, console" }))), "E0111");
  const d = assertThrows(() => parseProgram(fn({ effects: "console, fs.read" })), AlangError).diagnostic;
  assertEquals(d.fix, { replace: "effects: console, fs.read", with: "effects: fs.read, console" });
  assertEquals(code(() => parseProgram(fn({}).replace("  in: none\n  out: Unit", "  out: Unit\n  in: none"))), "E0101");
  assertEquals(code(() => parseProgram(fn({}).replace("fn m.f", "fn f").replace("end fn m.f", "end fn f"))), "E0101");
});

Deno.test("numbers: floats print without exponent, -0 is rejected", () => {
  assertEquals(canonicalExpr("0.0000001"), "0.0000001");
  assertEquals(canonicalExpr("1_000_000_000_000_000_000_000.5"), "1_000_000_000_000_000_000_000.0");
  assertEquals(canonicalExpr("1.50"), "1.5");
  assertEquals(code(() => parseExpression("-0")), "E0003");
  assertEquals(code(() => parseExpression("-0.0")), "E0003");
});

Deno.test("lambdas: parenthesized whenever they are an operand", () => {
  assertEquals(canonicalExpr("(fn(x: Int): Int => x) == y"), "(fn(x: Int): Int => x) == y");
  assertEquals(canonicalExpr("y == (fn(x: Int): Int => x)"), "y == (fn(x: Int): Int => x)");
  assertEquals(canonicalExpr("f(with: fn(x: Int): Int => x + 1)"), "f(with: fn(x: Int): Int => x + 1)");
});

Deno.test("bindings: result and error are reserved (E0109)", () => {
  assertEquals(code(() => parseStatements("let result: Int = 1")), "E0109");
  assertEquals(code(() => parseStatements("let error: Int = 1")), "E0109");
  assertEquals(code(() => parseExpression("fn(result: Int): Int => result")), "E0109");
  assertEquals(code(() => parseStatements("for error: Int in xs do\n  f(x: error)\nend for")), "E0109");
  // As field names they are fine.
  assertEquals(canonicalExpr("outcome.error"), "outcome.error");
});

Deno.test("if: without else only as a statement (E0110)", () => {
  assertEquals(code(() => parseStatements("let x: Unit = if c then\n  f(a: 1)\nend if")), "E0110");
  assertEquals(code(() => parseStatements("return if c then\n  1\nend if")), "E0110");
  assertEquals(printStmts(parseStatements("if c then\n  f(a: 1)\nend if"), ""), "if c then\n  f(a: 1)\nend if");
});

Deno.test("lists: literals print on one line and round-trip", () => {
  assertEquals(canonicalExpr("[1, 2, 3]"), "[1, 2, 3]");
  assertEquals(canonicalExpr("[[1], [2, 3]]"), "[[1], [2, 3]]");
  // Line breaks and spaces inside the brackets are ignored (3.7).
  assertEquals(canonicalExpr("[ 1 ,\n 2 ]"), "[1, 2]");
  assertEquals(canonicalExpr("[\n  1,\n  2\n]"), "[1, 2]");
  assertEquals(
    canonicalExpr('std.string.join(parts: ["a", "b"], separator: "")'),
    'std.string.join(parts: ["a", "b"], separator: "")',
  );
  assertEquals(canonicalExpr("f(a: 1) == [Some(1), None]"), "f(a: 1) == [Some(1), None]");
  assertEquals(
    canonicalExpr("[fn(x: Int): Int => x, fn(x: Int): Int => x + 1]"),
    "[fn(x: Int): Int => x, fn(x: Int): Int => x + 1]",
  );
  assertEquals(canonicalExpr("[a + b, not c, d and e]"), "[a + b, not c, d and e]");
  assertEquals(canonicalExpr("[p].x"), "[p].x");
  // The empty list parses, so that the checker can give its spelling (E0228).
  assertEquals(canonicalExpr("[]"), "[]");
  assertEquals(parseExpression("[1, 2]"), {
    kind: "list",
    items: [{ kind: "int", value: 1 }, { kind: "int", value: 2 }],
  });
});

Deno.test("lists: no index access, no T[] and no trailing comma", () => {
  const index =
    "There is no index access; use `std.list.get(list: xs, index: i)` or `std.map.get(map: m, key: k)` (4.6).";
  for (const source of ["xs[0]", "f(a: 1)[0]", "[1, 2][0]", "p.items[i]", 'm["a"]', '["a": 1]["a"]']) {
    const d = assertThrows(() => parseExpression(source), AlangError).diagnostic;
    assertEquals([d.code, d.message], ["E0006", index], source);
  }
  const type = assertThrows(() => parseStatements("let xs: Int[] = y"), AlangError).diagnostic;
  assertEquals([type.code, type.message, type.expected], ["E0006", "A list type is written `List<T>`.", "List<T>"]);
  assertEquals(code(() => parseStatements("let xs: List<Int[]> = y")), "E0006");
  const comma = assertThrows(() => parseExpression("[1, ]"), AlangError).diagnostic;
  assertEquals(
    [comma.code, comma.message],
    ["E0101", "A list ends after its last item; remove the comma before `]`."],
  );
  assertEquals(code(() => parseExpression("[1,\n]")), "E0101");
  assertEquals(code(() => parseExpression("[1 2]")), "E0101");
  assertEquals(code(() => parseExpression("[1, 2")), "E0101");
});

Deno.test("maps: literals print on one line and round-trip", () => {
  assertEquals(canonicalExpr('["a": 1, "b": 2]'), '["a": 1, "b": 2]');
  // Line breaks and spaces inside the brackets are ignored, around `:` too.
  assertEquals(canonicalExpr('[\n "a" : 1 ,\n "b":2\n]'), '["a": 1, "b": 2]');
  assertEquals(canonicalExpr('[\n  "a"\n  :\n  1\n]'), '["a": 1]');
  assertEquals(canonicalExpr("[1: [2: 3]]"), "[1: [2: 3]]");
  assertEquals(canonicalExpr('[["a": 1]]'), '[["a": 1]]');
  assertEquals(canonicalExpr("[-1: 0]"), "[-1: 0]");
  assertEquals(
    canonicalExpr('["f": fn(x: Int): Int => x + 1, "g": fn(x: Int): Int => x]'),
    '["f": fn(x: Int): Int => x + 1, "g": fn(x: Int): Int => x]',
  );
  assertEquals(canonicalExpr("[Point(x: 1, y: 2): Some(1), k: f(a: 1)]"), "[Point(x: 1, y: 2): Some(1), k: f(a: 1)]");
  assertEquals(canonicalExpr('f(a: 1) == ["a": None]'), 'f(a: 1) == ["a": None]');
  // The empty map parses, so that the checker can give its spelling (E0228).
  assertEquals(canonicalExpr("[:]"), "[:]");
  assertEquals(canonicalExpr("[ :\n ]"), "[:]");
  assertEquals(parseExpression('["a": 1]'), {
    kind: "map",
    entries: [{ key: { kind: "string", value: "a" }, value: { kind: "int", value: 1 } }],
  });
  assertEquals(parseExpression("[:]"), { kind: "map", entries: [] });
});

Deno.test("maps: every entry is key: value, without a trailing comma; no braces", () => {
  const message = (source: string) => {
    const d = assertThrows(() => parseExpression(source), AlangError).diagnostic;
    return [d.code, d.message];
  };
  assertEquals(message('["a": 1, 2]'), ["E0101", "Every entry of a map is `key: value`."]);
  assertEquals(message('[1, "a": 2]'), [
    "E0101",
    "A list holds items without `:`; in a map, every entry is `key: value`, the first one too.",
  ]);
  assertEquals(message('["a": 1, ]'), ["E0101", "A map ends after its last entry; remove the comma before `]`."]);
  assertEquals(code(() => parseExpression('["a": 1,\n]')), "E0101");
  assertEquals(code(() => parseExpression("[:1]")), "E0101");
  assertEquals(code(() => parseExpression('["a": ]')), "E0101");
  assertEquals(code(() => parseExpression('["a": 1')), "E0101");
  const braces =
    "There are no curly braces; blocks end with `end if`, `end for`, `end match`, `end fn <name>`, and a map is written `[key: value]`.";
  for (const source of ['{"a": 1}', "let m: Int = {}"]) {
    const d = assertThrows(() => parseStatements(source), AlangError).diagnostic;
    assertEquals([d.code, d.message], ["E0006", braces], source);
  }
});

// ---- statements (phase statements) ----

// The canonical text of a statement block, checked to round-trip.
function canonicalStmts(source: string): string {
  const tree = parseStatements(source);
  const printed = printStmts(tree, "");
  assertEquals(parseStatements(printed), tree, `round trip of ${source}`);
  return printed;
}

Deno.test("propagate: `expression else return value` is a statement (T1)", () => {
  const line = "std.fs.write_text(path: p, text: t) else return Err(error)";
  assertEquals(canonicalStmts(line), line);
  assertEquals(parseStatements(line)[0].kind, "propagate");
  const inIf = `if ready then\n  ${line}\n  check(width: 3) else return Unit\nend if`;
  assertEquals(canonicalStmts(inIf), inIf);
});

Deno.test("propagate: an else on the line of an if's then belongs to the if (T2)", () => {
  // A one-line if keeps its meaning: an if with an else branch.
  assertEquals(
    canonicalStmts("if c then f(x: 1) else return Unit end if"),
    "if c then\n  f(x: 1)\nelse\n  return Unit\nend if",
  );
  assertEquals(
    canonicalStmts("if c then f(x: 1) else g(x: 1) end if"),
    "if c then\n  f(x: 1)\nelse\n  g(x: 1)\nend if",
  );
  // A let takes the else greedily, as before.
  assertEquals(
    canonicalStmts("if c then let a: Int = f(x: 1) else return 0 end if"),
    "if c then\n  let a: Int = f(x: 1) else return 0\nend if",
  );
  // Not canonical: the else ends a then-branch line, so it is a propagate
  // (which the checker rejects as E0224 for a Unit call).
  const [stmt] = parseStatements("if c then\nf(x: 1) else return Unit\nend if");
  assertEquals(stmt.kind === "expr" && stmt.expr.kind === "if" && stmt.expr.then[0].kind, "propagate");
});

Deno.test("propagate: no else after a block or before anything but return (T2)", () => {
  const message = (source: string) => {
    const d = assertThrows(() => parseStatements(source), AlangError).diagnostic;
    return [d.code, d.message];
  };
  const lineBreak = ["E0101", "Expected a line break, found `else`."];
  assertEquals(message("match x\ncase A then\n1\nend match else return 0"), lineBreak);
  assertEquals(message("for x: Int in xs do\nf(x: x)\nend for else return 0"), lineBreak);
  assertEquals(message("f(x: 1) else g(x: 1)"), lineBreak);
  assertEquals(code(() => parseStatements("if c then\nf(x: 1)\nend if else return Unit")), "E0101");
});

Deno.test("let [...]: a list taken apart into names round-trips (T11)", () => {
  const line = "let [a, b]: List<String> = xs else return None";
  assertEquals(canonicalStmts(line), line);
  assertEquals(canonicalStmts("let [\n  a,\n  b\n]: List<String> = xs else return None"), line);
  assertEquals(
    canonicalStmts("let [only]: List<Int> = [1] else return 0"),
    "let [only]: List<Int> = [1] else return 0",
  );
});

Deno.test("let [...]: names only, at least one, with else return (T11, T12)", () => {
  const message = (source: string) => {
    const d = assertThrows(() => parseStatements(source), AlangError).diagnostic;
    return [d.code, d.message];
  };
  const namesOnly = [
    "E0101",
    "A `let [...]` takes a list apart into names only: `let [first, second]: List<String> = items else return ...`.",
  ];
  assertEquals(message("let []: List<Int> = xs else return 0"), ["E0101", "A `let [...]` names at least one item."]);
  assertEquals(message("let [a, ]: List<Int> = xs else return 0"), [
    "E0101",
    "A `let [...]` ends after its last name; remove the comma before `]`.",
  ]);
  for (const items of ['"x", b', "A", "[a]", "a b", "a.b"]) {
    assertEquals(message(`let [${items}]: List<Int> = xs else return 0`), namesOnly, items);
  }
  assertEquals(message("let [a, b]: List<String> = xs"), [
    "E0101",
    "A `let [...]` needs `else return ...` for a list of another length.",
  ]);
  assertEquals(code(() => parseStatements("let [error]: List<Int> = xs else return 0")), "E0109");
  assertEquals(message("match xs\ncase [a, b] then\n1\nend match"), [
    "E0101",
    "A `case` takes no list apart: no set of cases covers every length without a catch-all (3.3). Use `let [first, second]: List<T> = items else return ...`, or `std.list.first` and `std.list.drop`.",
  ]);
});

Deno.test("shared cases: patterns joined by or on one case line round-trip (T6)", () => {
  const source = [
    "let n: Int = match x",
    "  case A or B then",
    "    1",
    "  case Err(NotANumber) or Err(OutOfRange(n)) then",
    "    2",
    "end match",
  ].join("\n");
  assertEquals(canonicalStmts(source), source);
  const [stmt] = parseStatements(source);
  assertEquals(stmt.kind === "let" && stmt.value.kind === "match" && stmt.value.arms[1].patterns.length, 2);
  const oneLine = ["E0101", "A `case` and all its patterns stand on one line, up to `then`."];
  const message = (source: string) => {
    const d = assertThrows(() => parseStatements(source), AlangError).diagnostic;
    return [d.code, d.message];
  };
  assertEquals(message("match x\ncase A or\nB then\n1\nend match"), oneLine);
  assertEquals(message("match x\ncase A\nor B then\n1\nend match"), oneLine);
  // A name alternative is still a catch-all.
  assertEquals(code(() => parseStatements("match x\ncase A or other then\n1\nend match")), "E0108");
});

Deno.test("shared cases: the forms of other languages name `or` (T9, 5.7)", () => {
  const diagnostic = (source: string) => assertThrows(() => parseStatements(source), AlangError).diagnostic;
  for (const line of ["case A | B then", "case A|B then", "case A  |  B then"]) {
    const d = diagnostic(`match x\n${line}\n1\nend match`);
    assertEquals([d.code, d.at, d.expected, d.fix], ["E0006", line, "or", { replace: line, with: "case A or B then" }]);
  }
  // Every `|` of the line outside its strings, and only those.
  const literal = diagnostic('match x\ncase "a|b" | "c" then\n1\nend match');
  assertEquals(literal.fix, { replace: 'case "a|b" | "c" then', with: 'case "a|b" or "c" then' });
  const comma = diagnostic("match x\ncase A, B, Err(C) then\n1\nend match");
  assertEquals([comma.code, comma.fix], ["E0101", {
    replace: "case A, B, Err(C) then",
    with: "case A or B or Err(C) then",
  }]);
  assertEquals(comma.message, "Patterns that share an arm are joined with `or`: `case A or B then`.");
  assertEquals(diagnostic('match x\ncase "a", "b" then\n1\nend match').fix, null);
  const nested = diagnostic("match x\ncase Err(A or B) then\n1\nend match");
  assertEquals([nested.code, nested.fix], ["E0101", null]);
  assertEquals(
    nested.message,
    "`or` joins whole patterns of a case, not the values inside one: `case Err(A) or Err(B) then`, not `case Err(A or B) then`.",
  );
  const logic = diagnostic("let x: Bool = a || b");
  assertEquals([logic.code, logic.fix], ["E0006", { replace: "||", with: "or" }]);
});

// ---- function types (F1, F5, F6) ----

const FN_TYPES = `type m.Rule
  doc: "A named check of a line."
  record:
    name: String
    broken: (String) -> Bool
  where: none
end type m.Rule

type m.Check
  doc: "How a number is checked."
  variant:
    Custom: (Int) -> Bool
    Off
  where: none
end type m.Check

fn m.f
  doc: "Takes functions."
  in:
    f: (Int) -> Int
    by: (Int, Int) -> Order
    g: ((Int) -> Int) -> Int
    h: (Int) -> (Int) -> Int
    fs: List<(Int) -> Bool>
    table: Map<String, (net.port.Port) -> Bool>
  out: Int
  effects: none
  requires: none
  ensures: none
  examples: none
  body:
    let d: (Int) -> Int = double
    let same: (Int) -> Int = fn(k: (Int) -> Int): (Int) -> Int => k
    let empty: List<(Int) -> Bool> = std.list.empty<(Int) -> Bool>()
    return 0
end fn m.f
`;

Deno.test("function types: written wherever a type is, round-trip (F1)", () => {
  const tree = parseProgram(FN_TYPES);
  assertEquals(printProgram(tree), FN_TYPES);
  assertEquals(parseProgram(printProgram(tree)), tree);
  const f = tree[2];
  const int = { kind: "type", path: ["Int"], args: [] } as const;
  // `->` nests to the right.
  assertEquals(f.kind === "fn" && f.params[3].type, {
    kind: "function",
    params: [int],
    out: { kind: "function", params: [int], out: int },
  });
  assertEquals(canonicalExpr("std.list.empty<(Int) -> Bool>()"), "std.list.empty<(Int) -> Bool>()");
  assertEquals(canonicalExpr("fn(f: (Int) -> Int): (Int) -> Int => f"), "fn(f: (Int) -> Int): (Int) -> Int => f");
});

Deno.test("function types: the forms of other languages name `(Int) -> Int` (F5, F6)", () => {
  const message = (type: string) => {
    const source = FN_TYPES.replace("    f: (Int) -> Int\n", `    f: ${type}\n`);
    const d = assertThrows(() => parseProgram(source), AlangError).diagnostic;
    return [d.code, d.message];
  };
  const p1 = [
    "E0006",
    "A function type names no parameters: `(Int) -> Int`; the names belong to a lambda, `fn(x: Int): Int => ...`.",
  ];
  const p3 = ["E0006", "A function type puts its parameter types in parentheses: `(Int) -> Int`."];
  const p4 = [
    "E0006",
    "A function type is written `(Int) -> Int`, without `fn`; `fn(x: Int): Int => ...` is a lambda, which is a value.",
  ];
  assertEquals(message("(x: Int) -> Int"), p1);
  assertEquals(message("(Int) => Int"), [
    "E0006",
    "A function type is written with `->`: `(Int) -> Int`; `=>` starts the body of a lambda.",
  ]);
  assertEquals(message("Int -> Int"), p3);
  assertEquals(message("(Int) -> Int -> Int"), p3);
  assertEquals(message("fn(Int) -> Int"), p4);
  assertEquals(message("fn(Int): Int"), p4);
  assertEquals(message("() -> Int"), [
    "E0101",
    "A function type takes at least one parameter: a pure function without parameters always gives the same value, so take that value instead (`limit: Int`).",
  ]);
  assertEquals(message("(Int) -> Int with effects"), [
    "E0101",
    "Function types in your own code are pure (2.4); only the `handler` of `std.http.serve` takes a function with effects. Take a pure function, and put effects in a `for` or in the function that calls it.",
  ]);
  // Inside type arguments the form's own message comes through
  // (tryTypeArgs), while a comparison still reads as one.
  const d = assertThrows(() => parseExpression("std.list.empty<(x: Int) -> Int>()"), AlangError).diagnostic;
  assertEquals([d.code, d.message], p1);
  assertEquals(canonicalExpr("n < (limit)"), "n < limit");
  assertEquals(canonicalExpr("n < Limit"), "n < Limit");
  assertEquals(canonicalExpr("n < (a + b)"), "n < a + b");
});
