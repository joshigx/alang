// Generic definitions (phase `generics`, G1 to G12, G16): the header, type
// parameters inside their definition, equality on them, calls, the
// generated TypeScript and acceptance, on the fixtures of
// docs/plans/generics.md (section 4).

import { assert_, assertEquals, assertThrows } from "./assert.ts";
import type { FnDef } from "../src/ast.ts";
import { checkProgram } from "../src/check.ts";
import { AlangError, type Diagnostic } from "../src/diagnostic.ts";
import { parseProgram } from "../src/parser.ts";
import { printProgram, printSignature } from "../src/printer.ts";
import { applyOwnFixes } from "../src/refs.ts";
import { accept, build } from "../src/toolchain.ts";
import { HIDE, TYPE_T, UTIL } from "./generics_fixtures.ts";

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
  const end = parseError(UTIL.replace("end fn util.last\n", "end fn util.last<T>\n"));
  assertEquals([end.code, end.message], ["E0101", "Expected a line break, found `<`."]);
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

// ---- TypeScript and acceptance (G16) ----

Deno.test("generics: TypeScript generics, with the checked type arguments at user calls (G16)", async () => {
  assertEquals(await acceptance(UTIL), []);
  const mod = await load(UTIL, "util");
  assertEquals(mod.util$last([1, 2, 3]), { tag: "Some", value: 3 });
  assertEquals(mod.util$repeat("x", 2), ["x", "x"]);
  const text = await Deno.readTextFile(`${OUT}util.ts`);
  assert_(text.includes("export function util$last<T>(list: ReadonlyArray<T>): $rt.Option<T> {"));
  assert_(text.includes('util$repeat<T>(item, $rt.int_sub(count, 1, "util.repeat"))'));
  assert_(text.includes("actual: () => util$last<number>("));
});

Deno.test("generics: every accepted program here is accepted by TypeScript too", async () => {
  const files: string[] = [];
  for (const [i, source] of accepted.entries()) files.push((await build(source, `${OUT}checked_${i}.ts`)).outPath);
  assert_(files.length >= 5, String(files.length));
  const result = await new Deno.Command(Deno.execPath(), { args: ["check", ...files], stderr: "piped" }).output();
  assertEquals(result.success, true, new TextDecoder().decode(result.stderr));
});
