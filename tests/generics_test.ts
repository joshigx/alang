// Generic definitions (phase `generics`, G1 to G12, G16): the header, type
// parameters inside their definition, equality on them, calls, the
// generated TypeScript and acceptance, on the fixtures of
// docs/plans/generics.md (section 4).

import { assert_, assertEquals, assertThrows } from "./assert.ts";
import type { FnDef } from "../src/ast.ts";
import { checkProgram } from "../src/check.ts";
import { AlangError, type Diagnostic } from "../src/diagnostic.ts";
import { parseExpression, parseProgram } from "../src/parser.ts";
import { printExpr, printProgram, printSignature } from "../src/printer.ts";
import { applyOwnFixes } from "../src/refs.ts";
import { accept, build } from "../src/toolchain.ts";
import { FIRST_SOME, HIDE, PAIR, TREE, TYPE_T, UTIL } from "./generics_fixtures.ts";
import * as rt from "../src/runtime.ts";
import { STD } from "../src/std.ts";
import { fnType, freeVars, INT, showType, substitute } from "../src/types.ts";

const OUT = new URL("../out/test/generics/", import.meta.url).pathname;

// A function `name` (default `m.f`) with the given type parameters around
// the body, plus extra definitions.
function fn(
  body: string,
  o: {
    name?: string;
    typeParams?: string;
    params?: string[];
    out?: string;
    examples?: string[];
    extra?: string;
  } = {},
): string {
  const name = o.name ?? "m.f";
  const lines = [
    `fn ${name}${o.typeParams ? `<${o.typeParams}>` : ""}`,
    '  doc: "Test."',
    o.params ? ["  in:", ...o.params.map((p) => `    ${p}`)].join("\n") : "  in: none",
    `  out: ${o.out ?? "Int"}`,
    "  effects: none",
    "  requires: none",
    "  ensures: none",
    o.examples ? ["  examples:", ...o.examples.map((e) => `    ${e}`)].join("\n") : "  examples: none",
    "  body:",
    ...body.split("\n").map((l) => `    ${l}`),
    `end fn ${name}`,
  ];
  return lines.join("\n") + (o.extra ? `\n\n${o.extra}` : "") + "\n";
}

function check(source: string): Diagnostic[] {
  return checkProgram(parseProgram(source)).diagnostics;
}

// Exactly one diagnostic, with the given code; a fix applies inside `at`.
function one(source: string, code: string): Diagnostic {
  const ds = check(source);
  assertEquals(ds.map((d) => d.code), [code], JSON.stringify(ds, null, 2));
  const fix = ds[0].fix;
  if (fix) assert_(ds[0].at.includes(fix.replace), `fix outside its location: ${JSON.stringify(ds[0])}`);
  return ds[0];
}

// The source with the diagnostic's fix applied at its location.
const fixed = (source: string, d: Diagnostic): string =>
  source.replace(d.at, d.at.replace(d.fix!.replace, d.fix!.with));

// Every accepted program here is also emitted and checked by TypeScript.
const accepted: string[] = [];
function clean(source: string): void {
  const ds = check(source);
  assertEquals(ds, [], JSON.stringify(ds, null, 2));
  accepted.push(source);
}

function parseError(source: string): Diagnostic {
  return assertThrows(() => parseProgram(source), AlangError).diagnostic;
}

// The program with the places the checker reports as E0226 shortened, as
// the codebase stores it (refs.ts), printed.
function shortened(source: string): string {
  const defs = parseProgram(source);
  const { info } = checkProgram(defs);
  return printProgram(defs.map((d) => applyOwnFixes(d, info)));
}

let counter = 0;
async function acceptance(source: string): Promise<Diagnostic[]> {
  try {
    await accept(source, `${OUT}accept_${counter++}.ts`);
    return [];
  } catch (e) {
    if (e instanceof AlangError) return [...e.diagnostics];
    throw e;
  }
}

// deno-lint-ignore no-explicit-any
async function load(source: string, name: string): Promise<Record<string, any>> {
  const built = await build(source, `${OUT}${name}.ts`);
  return await import(`file://${built.outPath}?v=${counter++}`);
}

// ---- the header (G1, G3) ----

Deno.test("generics: the header round-trips; the end line names the definition alone (G1)", () => {
  const tree = parseProgram(UTIL);
  assertEquals(printProgram(tree), UTIL);
  assertEquals(parseProgram(printProgram(tree)), tree);
  assert_(printSignature(tree[0]).startsWith("fn util.last<T>\n"));
  assert_(printSignature(tree[0]).endsWith("\nend fn util.last"));
  const two = fn("return 0", { typeParams: "A, B", params: ["a: A", "b: B"] });
  assertEquals(printProgram(parseProgram(two)), two);
  assert_(two.startsWith("fn m.f<A, B>\n"));
  // Without type parameters the text is as before.
  assertEquals((parseProgram(fn("return 0"))[0] as FnDef).typeParams, []);
  assert_(fn("return 0").startsWith("fn m.f\n"));
});

Deno.test("generics: a type parameter is one capital letter in `<...>` (E0101)", () => {
  const header = (h: string) => parseError(fn("return 0").replace("fn m.f\n", `${h}\n`));
  const empty = header("fn m.f<>");
  assertEquals([empty.code, empty.message], [
    "E0101",
    "A definition's type parameters are capital letters in `<...>`: `fn util.last<T>`; without any, write the name alone.",
  ]);
  for (const [written, shown] of [["Item", "`Item`"], ["t", "`t`"], ["1", "`1`"]]) {
    const d = header(`fn m.f<${written}>`);
    assertEquals([d.code, d.message], [
      "E0101",
      `A type parameter is one capital letter, such as \`T\` or \`K\` (3); ${shown} is not one.`,
    ]);
  }
  const comma = header("fn m.f<T,>");
  assertEquals([comma.code, comma.message], [
    "E0101",
    "A list of type parameters ends after its last letter; remove the comma before `>`.",
  ]);
  const open = header("fn m.f<T");
  assertEquals([open.code, open.message], ["E0101", "Expected `>`, found line break."]);
});

// ---- checking (G2 to G6, G12) ----

Deno.test("generics: generic functions check; a type parameter hides the module's type of its letter (G4)", () => {
  clean(UTIL);
  clean(HIDE);
  // `m.T` is the only spelling inside `keep`, so it is no E0226 and stays.
  assertEquals(shortened(HIDE), printProgram(parseProgram(HIDE)));
});

Deno.test("generics: a type parameter equals only itself (G6)", () => {
  const d = one(fn("return b", { typeParams: "A, B", params: ["a: A", "b: B"], out: "A" }), "E0204");
  assertEquals([d.at, d.message], ["b", "Expected `A`, found `B`."]);
  // A callee's `T` binds to the caller's, which stays fixed: the result is
  // `Option<T>`, not a variable that fits anything.
  const trace = one(fn("return std.list.first(list: xs)", { typeParams: "T", params: ["xs: List<T>"] }), "E0204");
  assertEquals(trace.message, "Expected `Int`, found `Option<T>`.");
});

Deno.test("generics: each type parameter once, and used by the signature (E0215, E0250)", () => {
  const twice = one(fn("return 0", { typeParams: "T, T", params: ["x: T"] }), "E0215");
  assertEquals([twice.at, twice.message], ["fn m.f<T, T>", "Type parameter `T` is declared twice."]);
  const source = fn("return x", { typeParams: "T", params: ["x: Int"] });
  const unused = one(source, "E0250");
  assertEquals([unused.at, unused.message, unused.fix], [
    "fn m.f<T>",
    "`T` occurs in no parameter type and not in `out`, so no call could give it a meaning; remove it from `<...>`.",
    { replace: "fn m.f<T>", with: "fn m.f" },
  ]);
  assertEquals(check(fixed(source, unused)), []);
  const second = one(fn("return 0", { typeParams: "T, U", params: ["x: T"] }), "E0250");
  assertEquals(second.fix, { replace: "fn m.f<T, U>", with: "fn m.f<T>" });
  // A letter only in `out` is written at each call (`none_list<Int>()`).
  clean(
    fn("return std.list.empty<T>()", {
      typeParams: "T",
      out: "List<T>",
      examples: ["f<Int>() == std.list.empty<Int>()"],
    }),
  );
  // Letters count as written: `V` occurs in `Map<K, V>`, which fails for `K`.
  const key = one(
    fn("return std.list.empty<K>()", {
      name: "m.keys_of",
      typeParams: "K, V",
      params: ["map: Map<K, V>"],
      out: "List<K>",
    }),
    "E0229",
  );
  assertEquals(key.at, "Map<K, V>");
});

Deno.test("generics: a letter without its header, or in an example, is E0202 (G12)", () => {
  const missing = one(
    fn("return std.list.first(list: list)", { name: "util.first_of", params: ["list: List<T>"], out: "Option<T>" }),
    "E0202",
  );
  assertEquals([missing.at, missing.message, missing.expected], [
    "T",
    "Unknown type `T`; a type parameter is declared after the definition's name: `fn util.first_of<T>`.",
    "fn util.first_of<T>",
  ]);
  const example = one(
    fn("return std.list.empty<T>()", {
      typeParams: "T",
      out: "List<T>",
      examples: ["f<T>() == std.list.empty<T>()"],
    }),
    "E0202",
  );
  assertEquals([example.section, example.message], [
    "examples",
    "`T` is a type parameter of `f`, which an example cannot name: an example calls the function at concrete types, such as `Int` (5.1).",
  ]);
});

Deno.test("generics: the short form of a hidden type or case is E0203 (G4)", () => {
  const source = HIDE.replace("    return item\n", "    let t: m.T = T(n: 1)\n    return item\n");
  const hidden = one(source, "E0203");
  assertEquals([hidden.at, hidden.message, hidden.fix], [
    "T(n: 1)",
    "`T` is a type parameter of `keep` here; the record `m.T` of this module is written in full in it: `m.T(n: 1)`.",
    { replace: "T(n: 1)", with: "m.T(n: 1)" },
  ]);
  assertEquals(check(fixed(source, hidden)), []);
  // Outside a definition with that letter, the full name is E0226 as ever.
  one(`${TYPE_T}\n\n${fn("return tag.n", { name: "m.g", params: ["tag: m.T"] })}`, "E0226");
  const none = one(fn("return T", { name: "m.id", typeParams: "T", params: ["x: T"], out: "T" }), "E0203");
  assertEquals([none.message, none.fix], [
    "`T` is a type parameter of `id`, not a record or case; a value of it comes from a parameter.",
    null,
  ]);
  // A case of the module named like the letter, in a pattern.
  const cases = `type m.Tag\n  doc: "Tags."\n  variant:\n    T\n    U\n  where: none\nend type m.Tag`;
  const pattern = one(
    fn("let n: Int = match tag\n  case T then\n    1\n  case U then\n    2\nend match\nreturn n", {
      name: "m.h",
      typeParams: "T",
      params: ["item: T", "tag: Tag"],
      extra: cases,
    }),
    "E0203",
  );
  assertEquals([pattern.at, pattern.fix], ["T", { replace: "T", with: "m.T" }]);
});

Deno.test("generics: no `==`, order, show or contains on a type parameter (G2)", () => {
  const ab = { typeParams: "T", params: ["a: T", "b: T"], out: "Bool" };
  const eq = one(fn("return a == b", ab), "E0222");
  assertEquals(
    eq.message,
    "`==` compares values of `T`, a type parameter, which may stand for a type with function values (3.9). Compare with a function taken as a parameter, such as `same: (T, T) -> Bool`, or tell cases apart with `match`.",
  );
  assert_(one(fn("return a != b", ab), "E0222").message.startsWith("`!=` compares values of `T`"));
  const show = one(fn("return std.text.show(value: a)", { ...ab, out: "String" }), "E0222");
  assertEquals(
    show.message,
    "`std.text.show` is defined for types without function values (3.9), and `T` is a type parameter, which may stand for one; take what you need of `T` as a function parameter, such as `show: (T) -> String` or `same: (T, T) -> Bool`.",
  );
  assert_(
    one(fn("return std.list.contains(list: [a], item: b)", ab), "E0222").message.startsWith("`std.list.contains`"),
  );
  one(fn("return [a] == [b]", ab), "E0222");
  assert_(one(fn("return a < b", ab), "E0211").message.includes("with a function returning `Order`"));
  one(fn("return a + b", { ...ab, out: "T" }), "E0211");
});

Deno.test("generics: `==` against a value built from literals and cases works on every type (G2b)", () => {
  clean(fn("return o == None", { typeParams: "T", params: ["o: Option<T>"], out: "Bool" }));
  clean(fn("return xs == std.list.empty<T>()", { typeParams: "T", params: ["xs: List<T>"], out: "Bool" }));
  clean(
    fn("return r != Err(std.fs.NotFound)", { typeParams: "T", params: ["r: Result<T, std.fs.Error>"], out: "Bool" }),
  );
  clean(
    fn("return std.list.first(list: xs) == Some(std.list.empty<T>())", {
      typeParams: "T",
      params: ["xs: List<List<T>>"],
      out: "Bool",
    }),
  );
  // Function types too: no function is compared.
  clean(fn("return f == None", { params: ["f: Option<(Int) -> Int>"], out: "Bool" }));
  one(fn("return o == Some(a)", { typeParams: "T", params: ["o: Option<T>", "a: T"], out: "Bool" }), "E0222");
  one(fn("return f == f", { params: ["f: Option<(Int) -> Int>"], out: "Bool" }), "E0222");
});

Deno.test("generics: a type parameter is no map key (E0229)", () => {
  const d = one(
    fn("return std.map.empty<K, Int>()", {
      name: "m.count",
      typeParams: "K",
      params: ["keys: List<K>"],
      out: "Map<K, Int>",
    }),
    "E0229",
  );
  assertEquals([d.at, d.message], [
    "Map<K, Int>",
    "Map keys are `Int` or `String`, found `K`, a type parameter, which may stand for any type; key the map by `Int` or `String`.",
  ]);
  // A generic function over map values works.
  clean(fn("return std.map.size(map: m)", { typeParams: "V", params: ["m: Map<String, V>"] }));
});

Deno.test("generics: calls bind type parameters as for std; explicit ones only where needed (E0209, E0228)", () => {
  const guess = one(
    fn("let xs: List<Int> = none_list()\nreturn std.list.length(list: xs)", { name: "util.f", extra: UTIL }),
    "E0209",
  );
  assertEquals(guess.fix, { replace: "none_list()", with: "none_list<Int>()" });
  const extra = one(fn("let o: Option<Int> = util.last<Int>(list: [1])\nreturn 0", { extra: UTIL }), "E0209");
  assertEquals(extra.fix, { replace: "util.last<Int>(list: [1])", with: "util.last(list: [1])" });
  const empty = one(
    fn("let ys: List<T> = []\nreturn std.list.length(list: ys)", { typeParams: "T", params: ["x: T"] }),
    "E0228",
  );
  assertEquals(empty.fix, { replace: "[]", with: "std.list.empty<T>()" });
  clean(
    fn("let zs: List<T> = std.list.empty<T>()\nreturn std.list.length(list: zs)", {
      typeParams: "T",
      params: ["x: T"],
    }),
  );
  // Recursion and calls at other types, lambdas over `T`, `for` over `List<T>`.
  clean(fn(
    "let doubled: List<List<T>> = std.list.map(list: xs, with: fn(x: T): List<T> => util.repeat(item: x, count: 2))\nlet n: Int = util.count_if(list: doubled, test: fn(ys: List<T>): Bool => ys == std.list.empty<T>())\nlet total: List<Int> = for x: List<T> in doubled do\n  std.list.length(list: x)\nend for\nreturn n + std.list.length(list: total)",
    { typeParams: "T", params: ["xs: List<T>"], extra: UTIL },
  ));
});

// ---- case type arguments (G7) ----

Deno.test("generics: a case names its type arguments after its name; `<` after a value stays a comparison", () => {
  for (const source of ["None<Int>", "Ok<Int, String>(1)", 'Err<Int, String>("x")', "Leaf<List<Int>>"]) {
    const tree = parseExpression(source);
    assertEquals(printExpr(tree, ""), source);
    assertEquals(parseExpression(printExpr(tree, "")), tree);
  }
  assertEquals(parseExpression("n < Limit").kind, "binary");
  assertEquals(parseExpression("n < (limit)").kind, "binary");
  const shape = parseExpression("None<Int> == x");
  assertEquals(shape.kind === "binary" && shape.left.kind === "construct" && shape.left.typeArgs.length, 1);
});

const SHAPE = 'type m.Shape\n  doc: "A shape."\n  variant:\n    Circle: Int\n    Dot\n  where: none\nend type m.Shape';
const POINT = 'type m.Point\n  doc: "A point."\n  record:\n    x: Int\n    y: Int\n  where: none\nend type m.Point';

Deno.test("generics: a case names its type arguments where nothing else gives them (G7)", () => {
  clean(FIRST_SOME);
  clean(fn("return std.list.length(list: [None<Int>, Some(1)])"));
  clean(fn("return None<Int> == std.list.first(list: [1])", { out: "Bool" }));
  clean(fn("let o: Option<T> = None\nreturn util.first_some(first: None<T>, second: o)", {
    typeParams: "T",
    params: ["x: T"],
    out: "Option<T>",
    extra: FIRST_SOME,
  }));
});

Deno.test("generics: type arguments where the expected type or the value gives them are E0209 (G7)", () => {
  const cases: [string, string | null, { replace: string; with: string } | null][] = [
    ["let o: Option<Int> = None<Int>\nreturn 0", "`None` takes its type from what is expected here; remove `<Int>`.", {
      replace: "None<Int>",
      with: "None",
    }],
    [
      "let o: Option<Int> = None<Int, Int>\nreturn 0",
      "`None` is a case of `Option<T>`, which takes 1 type argument.",
      null,
    ],
    [
      "let o: Option<Int> = Some<Int>(1)\nreturn 0",
      "`Some` takes its type from what is expected here; remove `<Int>`.",
      {
        replace: "Some<Int>(1)",
        with: "Some(1)",
      },
    ],
    ["return std.list.length(list: [Some<Int>(1)])", "`Some` takes its type from its value; remove `<Int>`.", {
      replace: "Some<Int>(1)",
      with: "Some(1)",
    }],
    ["let o: Order = Less<Int>\nreturn 0", "`Less` is a case of `Order`, which takes no type arguments.", {
      replace: "Less<Int>",
      with: "Less",
    }],
  ];
  for (const [body, message, fix] of cases) {
    const source = fn(body);
    const d = one(source, "E0209");
    assertEquals([d.message, d.fix], [message, fix]);
    if (fix) assertEquals(check(fixed(source, d)), []);
  }
  // Before generic types, no type of a module takes type arguments.
  const dot = fn("return Dot<Int>", { out: "Shape", extra: SHAPE });
  const d = one(dot, "E0209");
  assertEquals([d.message, d.fix], [
    "`Dot` is a case of `Shape`, which takes no type arguments.",
    { replace: "Dot<Int>", with: "Dot" },
  ]);
  assertEquals(check(fixed(dot, d)), []);
  const point = fn("return Point<Int>(x: 1, y: 2)", { out: "Point", extra: POINT });
  const p = one(point, "E0209");
  assertEquals([p.message, p.fix], [
    "A record takes its type arguments from its fields; remove `<Int>`.",
    { replace: "Point<Int>(x: 1, y: 2)", with: "Point(x: 1, y: 2)" },
  ]);
  assertEquals(check(fixed(point, p)), []);
});

Deno.test("generics: a case whose type nothing gives is E0210, naming the form with type arguments (G7)", () => {
  const none = one(fn("return std.option.with_default(option: None, default: 0)"), "E0210");
  assertEquals([none.at, none.expected], ["None", "None<T>"]);
  assertEquals(
    none.message,
    "The type of `None` cannot be determined here; types flow from left to right (1.4). Write its type arguments, `None<T>` with a type for `T`, or put the side with a known type first.",
  );
  const ok = one(fn("return std.list.length(list: [Ok(1)])"), "E0210");
  assertEquals(ok.expected, "Ok<T, E>(1)");
  assert_(ok.message.includes("`Ok<T, E>` with types for `T` and `E`"), ok.message);
  one(fn("return None == std.list.first(list: [1])", { out: "Bool" }), "E0210");
});

// ---- generic functions passed by name (G9) ----

const LASTS = `fn m.lasts<T>
  doc: "The last item of each group."
  in:
    groups: List<List<T>>
  out: List<Option<T>>
  effects: none
  requires: none
  ensures: none
  examples:
    lasts(groups: [[1], [2, 3]]) == [Some(1), Some(3)]
  body:
    return std.list.map(list: groups, with: util.last)
end fn m.lasts

${UTIL}`;

Deno.test("generics: a generic function passed by name takes its type arguments from the function type there (G9)", () => {
  clean(fn(
    "let xss: List<List<Int>> = [[1], [2, 3]]\nlet lasts: List<Option<Int>> = std.list.map(list: xss, with: util.last)\nreturn std.list.length(list: lasts)",
    { extra: UTIL },
  ));
  clean(
    fn("let f: (List<Int>) -> Option<Int> = util.last\nreturn std.option.with_default(option: f([1]), default: 0)", {
      extra: UTIL,
    }),
  );
  clean(fn("let g: (List<Int>) -> Int = std.list.length\nreturn g([1])"));
  clean(LASTS);
});

Deno.test("generics: without a function type there, or with another, a generic function value is E0210 or E0204 (G9)", () => {
  const unknown = one(fn("let h: Int = util.last\nreturn h", { extra: UTIL }), "E0210");
  assertEquals([unknown.at, unknown.message], [
    "util.last",
    "The generic function `util.last` cannot be passed here: its type arguments come from the parameter types of a function type expected at this point (1.4), and none is known. Wrap it in a lambda, or bind it with `let` and a function type first.",
  ]);
  const other = one(fn("let k: (Int) -> Option<Int> = util.last\nreturn 0", { extra: UTIL }), "E0204");
  assertEquals([other.message, other.expected], [
    "Expected `(Int) -> Option<Int>`, found `util.last`, a generic function of type `(List<T>) -> Option<T>`.",
    "(Int) -> Option<Int>",
  ]);
  // Instantiated at a type with function values, or at a type parameter,
  // a function that shows its values is E0222 (G2).
  const fns = one(
    fn("let shown: List<String> = std.list.map(list: fs, with: std.text.show)\nreturn 0", {
      params: ["fs: List<(Int) -> Int>"],
    }),
    "E0222",
  );
  assertEquals(fns.at, "std.text.show");
  const letter = one(
    fn("let shown: List<String> = std.list.map(list: xs, with: std.text.show)\nreturn 0", {
      typeParams: "T",
      params: ["xs: List<T>"],
    }),
    "E0222",
  );
  assert_(letter.message.includes("and `T` is a type parameter"), letter.message);
});

// ---- generic types (G8) ----

const G = 'fn m.g\n  doc: "G."\n  in: none\n  out: Int\n  effects: none\n  requires: none\n  ensures: none\n' +
  "  examples:\n    g() == 1\n  body:\n    return 1\nend fn m.g";

Deno.test("generics: a generic type's header round-trips; `<>` and a word are E0101 (G8)", () => {
  for (const source of [TREE, PAIR]) {
    const tree = parseProgram(source);
    assertEquals(printProgram(tree), source);
    assertEquals(parseProgram(printProgram(tree)), tree);
  }
  assert_(printSignature(parseProgram(TREE)[0]).startsWith("type tree.Tree<T>\n"));
  assert_(printSignature(parseProgram(TREE)[0]).endsWith("\nend type tree.Tree"));
  const empty = parseError(
    PAIR.replace("type m.Pair<A, B>", "type m.Box<>").replace("end type m.Pair", "end type m.Box"),
  );
  assertEquals([empty.code, empty.message], [
    "E0101",
    "A definition's type parameters are capital letters in `<...>`: `type util.Pair<A, B>`; without any, write the name alone.",
  ]);
  const word = parseError(PAIR.replace("type m.Pair<A, B>", "type m.Pair<Item>"));
  assertEquals([word.code, word.message], [
    "E0101",
    "A type parameter is one capital letter, such as `T` or `K` (3); `Item` is not one.",
  ]);
});

Deno.test("generics: generic types check: fields and cases at their type arguments (G8)", () => {
  clean(TREE);
  // A constant is not generic (G11), but its type may be a generic type.
  const empty =
    'const tree.empty\n  doc: "The empty tree of Int."\n  out: Tree<Int>\n  body:\n    return Leaf\nend const tree.empty';
  clean(`${TREE}\n${empty}\n\n${fn("return std.list.length(list: items(tree: empty))", { name: "tree.size" })}`);
  clean(fn(
    'let p: Pair<Int, String> = Pair(left: 1, right: "a")\nlet q: Pair<Option<Int>, Int> = Pair(left: None, right: 1)\nlet r: Int = Pair(left: None<Int>, right: 1).right\nreturn Pair(left: 1, right: "a").right',
    { out: "String", extra: PAIR },
  ));
  // A generic function over a generic type, a record inside a generic body.
  clean(fn("let p: Pair<T, List<T>> = Pair(left: x, right: [x])\nreturn std.list.length(list: p.right)", {
    typeParams: "T",
    params: ["x: T"],
    extra: PAIR,
  }));
  const wrong = one(fn("let a: Int = p.right\nreturn a", { params: ["p: Pair<Int, String>"], extra: PAIR }), "E0204");
  assertEquals(wrong.message, "Expected `Int`, found `String`.");
});

Deno.test("generics: a generic type is written with its type arguments (E0209)", () => {
  for (const written of ["Pair<Int>", "Pair"]) {
    const d = one(fn("return 0", { params: [`p: ${written}`], extra: PAIR }), "E0209");
    assertEquals([d.at, d.message], [written, "`Pair` takes 2 type arguments: `Pair<A, B>`."]);
  }
  const record = fn('return Pair<Int, String>(left: 1, right: "a").left', { extra: PAIR });
  const r = one(record, "E0209");
  assertEquals([r.message, r.fix], [
    "A record takes its type arguments from its fields; remove `<Int, String>`.",
    { replace: 'Pair<Int, String>(left: 1, right: "a")', with: 'Pair(left: 1, right: "a")' },
  ]);
  assertEquals(check(fixed(record, r)), []);
  const node = fn("let t: Tree<Int> = Node<Int>(Branch(item: 1, left: Leaf, right: Leaf))\nreturn 0", {
    name: "tree.f",
    extra: TREE,
  });
  const n = one(node, "E0209");
  assertEquals([n.message, n.fix], [
    "`Node` takes its type from what is expected here; remove `<Int>`.",
    {
      replace: "Node<Int>(Branch(item: 1, left: Leaf, right: Leaf))",
      with: "Node(Branch(item: 1, left: Leaf, right: Leaf))",
    },
  ]);
  assertEquals(check(fixed(node, n)), []);
  const value = one(
    fn("return std.list.length(list: [Node<Int>(Branch(item: 1, left: Leaf, right: Leaf))])", {
      name: "tree.f",
      extra: TREE,
    }),
    "E0209",
  );
  assertEquals(value.message, "`Node` takes its type from its value; remove `<Int>`.");
});

Deno.test("generics: a case or field whose type nothing gives is E0210 (G7, G8)", () => {
  const none = one(fn("return Pair(left: None, right: 1).right", { extra: PAIR }), "E0210");
  assertEquals(none.at, "None");
  const leaf = one(fn("return std.list.length(list: [Leaf])", { name: "tree.f", extra: TREE }), "E0210");
  assertEquals([leaf.at, leaf.expected], ["Leaf", "Leaf<T>"]);
  // Another type expected: the case's type is named with its letters.
  const other = one(fn("return Leaf", { name: "tree.f", extra: TREE }), "E0204");
  assertEquals(other.message, "Expected `Int`, found a case of `Tree<T>`.");
});

Deno.test("generics: every type parameter of a type occurs in a field or case (E0250, G5)", () => {
  const box = 'type m.Box<T>\n  doc: "A box."\n  record:\n    n: Int\n  where: none\nend type m.Box';
  const d = one(box, "E0250");
  assertEquals([d.message, d.fix], [
    "`T` occurs in no field, so no value could give it a meaning; remove it from `<...>`.",
    { replace: "type m.Box<T>", with: "type m.Box" },
  ]);
  assertEquals(check(fixed(box, d)), []);
  const index =
    'type m.Index<K>\n  doc: "An index."\n  record:\n    entries: Map<K, Int>\n  where: none\nend type m.Index';
  assertEquals(one(index, "E0229").at, "Map<K, Int>");
});

Deno.test("generics: match, equality and function values over generic types (G2, G8, G9)", () => {
  const partial = one(
    fn("let n: Int = match t\n  case Leaf then\n    0\nend match\nreturn n", {
      name: "tree.f",
      params: ["t: Tree<Int>"],
      extra: TREE,
    }),
    "E0213",
  );
  assertEquals(partial.expected, "case Node(_) then");
  one(
    fn("return Pair(left: g, right: 1) == Pair(left: g, right: 1)", { out: "Bool", extra: `${PAIR}\n${G}` }),
    "E0222",
  );
  clean(fn("return t == Leaf", { name: "tree.f", typeParams: "T", params: ["t: Tree<T>"], out: "Bool", extra: TREE }));
  // A field whose function type has known parameter types takes a generic
  // function by name (G9), from the fields to its left.
  const mapping =
    'type m.Mapping<T, U>\n  doc: "Items and a function over them."\n  record:\n    items: List<T>\n    with: (T) -> U\n  where: none\nend type m.Mapping';
  clean(fn("let m: Mapping<List<Int>, Option<Int>> = Mapping(items: [[1]], with: util.last)\nreturn 0", {
    extra: `${mapping}\n\n${UTIL}`,
  }));
  clean(fn("return std.list.length(list: std.list.map(list: m.items, with: m.with))", {
    params: ["m: Mapping<List<Int>, Option<Int>>"],
    extra: mapping,
  }));
  // Without an expected type, the field to its left binds `T`.
  clean(
    fn(
      "let m: List<Int> = std.list.first(list: Mapping(items: [[1]], with: util.last).items) else return 0\nreturn 1",
      {
        extra: `${mapping}\n\n${UTIL}`,
      },
    ),
  );
});

// ---- habits around generic headers (5.7) ----

Deno.test("generics habits: a bound on a type parameter is E0006, naming the function parameter", () => {
  for (const header of ["fn m.f<T: Ord>", "fn m.f<T extends Ord>", "fn m.f<T: Eq + Show>"]) {
    const d = parseError(fn("return 0", { typeParams: "T", params: ["x: T"] }).replace("fn m.f<T>", header));
    assertEquals([d.code, d.message, d.fix], [
      "E0006",
      "A type parameter takes no bounds: alang has no traits (2.6). Take what the function needs of `T` as a parameter, such as `same: (T, T) -> Bool` or `by: (T, T) -> Order`.",
      null,
    ]);
  }
});

Deno.test("generics habits: the end line names the definition without its type parameters (E0103)", () => {
  const source = UTIL.replace("end fn util.last\n", "end fn util.last<T>\n");
  const d = parseError(source);
  assertEquals([d.code, d.message, d.expected, d.fix], [
    "E0103",
    "The block end names the definition without its type parameters: `end fn util.last`.",
    "end fn util.last",
    { replace: "end fn util.last<T>", with: "end fn util.last" },
  ]);
  assertEquals(parseProgram(fixed(source, d)), parseProgram(UTIL));
  const type = parseError(TREE.replace("end type tree.Tree\n", "end type tree.Tree<T>\n"));
  assertEquals([type.code, type.fix], ["E0103", { replace: "end type tree.Tree<T>", with: "end type tree.Tree" }]);
});

Deno.test("generics habits: a pattern takes no type arguments; a constant takes no type parameters (E0101)", () => {
  const pattern = parseError(
    TREE.replace("      case Leaf then\n        std.list.empty", "      case Leaf<T> then\n        std.list.empty"),
  );
  assertEquals([pattern.code, pattern.message], [
    "E0101",
    "A pattern takes no type arguments; the `match` subject gives them: `case Leaf then`.",
  ]);
  const nested = parseError(
    fn("return 0").replace(
      "    return 0",
      "    let n: Int = match t\n      case Some(Leaf<Int>) then\n        0\n    end match\n    return n",
    ),
  );
  assertEquals(nested.message, "A pattern takes no type arguments; the `match` subject gives them: `Leaf`.");
  const constant = parseError(
    'const m.c<T>\n  doc: "C."\n  out: List<T>\n  body:\n    return std.list.empty<T>()\nend const m.c\n',
  );
  assertEquals([constant.code, constant.message], [
    "E0101",
    "A constant has one type and takes no type parameters; a value for every type is a `fn` with a type parameter, such as `fn m.empty<T>`.",
  ]);
});

// ---- TypeScript and acceptance (G16) ----

Deno.test("generics: TypeScript generics, with the checked type arguments at user calls (G16)", async () => {
  assertEquals(await acceptance(UTIL), []);
  assertEquals(await acceptance(FIRST_SOME), []);
  // A function value is passed bare; TypeScript instantiates it from context.
  assertEquals(await acceptance(LASTS), []);
  assertEquals(await acceptance(TREE), []);
  const lasts = await load(LASTS, "lasts");
  assertEquals(lasts.m$lasts([[1], [2, 3]]), [{ tag: "Some", value: 1 }, { tag: "Some", value: 3 }]);
  assert_((await Deno.readTextFile(`${OUT}lasts.ts`)).includes("$rt.std$list$map(groups, util$last)"));
  const mod = await load(UTIL, "util");
  assertEquals(mod.util$last([1, 2, 3]), { tag: "Some", value: 3 });
  assertEquals(mod.util$repeat("x", 2), ["x", "x"]);
  const text = await Deno.readTextFile(`${OUT}util.ts`);
  assert_(text.includes("export function util$last<T>(list: ReadonlyArray<T>): $rt.Option<T> {"));
  assert_(text.includes('util$repeat<T>(item, $rt.int_sub(count, 1, "util.repeat"))'));
  assert_(text.includes("actual: () => util$last<number>("));
});

// Every pure generic std function whose type parameters its parameters
// bind is a value at `Int` (G9), and TypeScript accepts it there too, since
// a function value is passed bare and TypeScript instantiates it.
Deno.test("generics: every generic std function is a value at Int, in alang and in TypeScript (G9)", () => {
  const generic = STD.filter((sig) => {
    if (sig.typeParams.length === 0 || sig.effects.length > 0 || sig.params.length === 0) return false;
    const bound = new Set<string>();
    for (const p of sig.params) freeVars(p.type, bound);
    return sig.typeParams.every((tp) => bound.has(tp));
  });
  assert_(generic.length > 30, String(generic.length));
  for (const sig of generic) {
    const ints = new Map(sig.typeParams.map((tp) => [tp, INT]));
    const type = showType(fnType(sig.params.map((p) => substitute(p.type, ints)), substitute(sig.out, ints)));
    clean(fn(`let f: ${type} = ${sig.name}\nreturn 0`));
  }
});

Deno.test("generics: every accepted program here is accepted by TypeScript too", async () => {
  const files: string[] = [];
  for (const [i, source] of accepted.entries()) files.push((await build(source, `${OUT}checked_${i}.ts`)).outPath);
  assert_(files.length >= 5, String(files.length));
  const result = await new Deno.Command(Deno.execPath(), { args: ["check", ...files], stderr: "piped" }).output();
  assertEquals(result.success, true, new TextDecoder().decode(result.stderr));
});

Deno.test("generics: generic types are TypeScript generic types, constructed at their checked types (G16)", async () => {
  const mod = await load(TREE, "tree");
  const text = await Deno.readTextFile(`${OUT}tree.ts`);
  assert_(text.includes("export type tree$Tree<T> ="));
  assert_(text.includes("satisfies tree$Tree<number> as tree$Tree<number>"));
  assert_(text.includes("tree$Branch<T>({"));
  // The second example's tree of `items`: `b` with `c` on its right.
  const leaf = { tag: "Leaf" };
  const c = { tag: "Node", value: mod.tree$Branch({ item: "c", left: leaf, right: leaf }) };
  assertEquals(mod.tree$items({ tag: "Node", value: mod.tree$Branch({ item: "b", left: leaf, right: c }) }), [
    "b",
    "c",
  ]);
  // A generic record shows with its type's short name (R7).
  const pairs = await load(`${PAIR}\n${fn("return 0", { params: ["p: Pair<Int, String>"] })}`, "pair");
  assertEquals(rt.std$text$show(pairs.m$Pair({ left: 1, right: "a" })), 'Pair(left: 1, right: "a")');
});

Deno.test("generics: a failing example shows a generic type's actual value (E0402)", async () => {
  const wrong = TREE.replace(
    "insert(tree: Leaf<Int>, item: 2, by: std.int.compare) == Node(Branch(item: 2, left: Leaf, right: Leaf))",
    "insert(tree: Leaf<Int>, item: 2, by: std.int.compare) == Leaf",
  );
  const ds = await acceptance(wrong);
  assertEquals(ds.map((d) => [d.code, d.message]), [[
    "E0402",
    "The example does not hold: `insert(tree: Leaf<Int>, item: 2, by: std.int.compare)` is `Node(Branch(item: 2, left: Leaf, right: Leaf))`.",
  ]]);
});
