// Constants (phase `const`, C1 to C5, C13): the form, names, checking, the
// generated TypeScript and acceptance, on the fixtures of docs/plans/const.md
// (section 4), plus a table of functions held in constants.

import { assert_, assertEquals, assertThrows } from "./assert.ts";
import { pathText } from "../src/ast.ts";
import { checkProgram } from "../src/check.ts";
import { AlangError, type Diagnostic } from "../src/diagnostic.ts";
import { parseProgram } from "../src/parser.ts";
import { printProgram, printSignature } from "../src/printer.ts";
import { applyOwnFixes, dependencies, mapReferences, references } from "../src/refs.ts";
import * as rt from "../src/runtime.ts";
import { accept, build } from "../src/toolchain.ts";

const OUT = new URL("../out/test/const/", import.meta.url).pathname;

const SHOP = `const shop.max_items
  doc: "The most items one order may hold."
  out: Int
  body:
    return 100
end const shop.max_items

const shop.prices
  doc: "The price of one shirt per size, in cents."
  out: Map<String, Int>
  body:
    let base: Int = 1500
    return ["S": base, "M": base, "L": base + 200, "XL": base + 400]
end const shop.prices

type shop.Limits
  doc: "How many items and sizes an order may have."
  record:
    items: Int
    sizes: Int
  where: items <= max_items
end type shop.Limits

const shop.limits
  doc: "The limits of an order."
  out: Limits
  body:
    return Limits(items: max_items, sizes: std.map.size(map: prices))
end const shop.limits

fn shop.price
  doc: "The price of a count of shirts of one size, if the size exists."
  in:
    size: String
    count: Int
  out: Option<Int>
  effects: none
  requires: count <= max_items
  ensures: none
  examples:
    price(size: "M", count: 2) == Some(3000)
    price(size: "XL", count: 1) == Some(1900)
    price(size: "XXL", count: 1) == None
    price(size: "S", count: max_items) == Some(150_000)
  body:
    let each: Int = std.map.get(map: prices, key: size) else return None
    return Some(each * count)
end fn shop.price

fn shop.fits
  doc: "Whether an order of a count of items fits the limits."
  in:
    count: Int
  out: Bool
  effects: none
  requires: none
  ensures: none
  examples:
    fits(count: 100) == true
    fits(count: 101) == false
  body:
    return count <= limits.items
end fn shop.fits
`;

const WEB = `fn web.label
  doc: "The limits as a label."
  in:
    prefix: String
  out: String
  effects: none
  requires: none
  ensures: none
  examples:
    label(prefix: "max ") == "max 100 of 4 sizes"
  body:
    return std.string.join(parts: [prefix, std.text.show(value: shop.max_items), " of ", std.text.show(value: shop.limits.sizes), " sizes"], separator: "")
end fn web.label
`;

// A function of module `m` with one example and the given body.
const fn = (name: string, params: string, out: string, example: string, body: string): string =>
  [
    `fn ${name}`,
    '  doc: "Test."',
    params === "" ? "  in: none" : `  in:\n${params.split(", ").map((p) => `    ${p}`).join("\n")}`,
    `  out: ${out}`,
    "  effects: none",
    "  requires: none",
    "  ensures: none",
    `  examples:\n    ${example}`,
    "  body:",
    ...body.split("\n").map((l) => `    ${l}`),
    `end fn ${name}`,
  ].join("\n");

const constant = (name: string, out: string, body: string): string =>
  [
    `const ${name}`,
    '  doc: "Test."',
    `  out: ${out}`,
    "  body:",
    ...body.split("\n").map((l) => `    ${l}`),
    `end const ${name}`,
  ].join("\n");

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

// ---- syntax (1.1, 1.2) ----

Deno.test("const: the form round-trips; its signature is doc and out (C1, C10)", () => {
  const tree = parseProgram(SHOP);
  assertEquals(printProgram(tree), SHOP);
  assertEquals(parseProgram(printProgram(tree)), tree);
  assertEquals(tree.map((d) => d.kind), ["const", "const", "type", "const", "fn", "fn"]);
  assertEquals(
    printSignature(tree[0]),
    'const shop.max_items\n  doc: "The most items one order may hold."\n  out: Int\nend const shop.max_items',
  );
});

Deno.test("const: a name with a module, its own end, not result or error; extern stays E0199", () => {
  assertEquals(parseError("extern fn m.x\n").code, "E0199");
  const noModule = parseError(constant("m.x", "Int", "return 1").replace("const m.x\n", "const m\n"));
  assertEquals([noModule.code, noModule.message], ["E0101", "A definition name has a module: `module.m`."]);
  const end = parseError(SHOP.replace("end const shop.max_items", "end const shop.other"));
  assertEquals([end.code, end.fix], ["E0103", {
    replace: "end const shop.other",
    with: "end const shop.max_items",
  }]);
  const error = parseError(constant("m.error", "Int", "return 1"));
  assertEquals([error.code, error.at, error.message], [
    "E0109",
    "error",
    "`error` is bound by the language and cannot name a constant.",
  ]);
  const other = parseError("let x: Int = 1\n");
  assertEquals(other.message, "Expected a definition (`fn`, `type` or `const`), found `let`.");
});

// ---- checking (1.3 to 1.7) ----

Deno.test("const: constants of a module and of another one check (C2)", () => {
  clean(SHOP + "\n" + WEB);
});

Deno.test("const: a local hides a constant; the full name is E0226 only where the short one means it", () => {
  const h = fn(
    "shop.h",
    "max_items: Int",
    "Int",
    "h(max_items: 1) == 101",
    "return max_items + shop.max_items",
  );
  clean(SHOP + "\n" + h);
  const long = fn("shop.h", "n: Int", "Int", "h(n: 1) == 101", "return n + shop.max_items");
  const d = one(SHOP + "\n" + long, "E0226");
  assertEquals([d.at, d.fix], ["shop.max_items", { replace: "shop.max_items", with: "max_items" }]);
  const field = fn("shop.h", "n: Int", "Int", "h(n: 1) == 101", "return n + shop.limits.items");
  const e = one(SHOP + "\n" + field, "E0226");
  assertEquals([e.at, e.fix], ["shop.limits.items", { replace: "shop.limits", with: "limits" }]);
  clean(fixed(SHOP + "\n" + field, e));
  const defs = parseProgram(SHOP + "\n" + field);
  const { info } = checkProgram(defs);
  assert_(printProgram(defs.map((def) => applyOwnFixes(def, info))).includes("    return n + limits.items\n"));
});

const AMBIG = [
  'type x.Pair\n  doc: "Two numbers."\n  record:\n    c: Int\n    d: Int\n  where: none\nend type x.Pair',
  constant("x.m", "Pair", "return Pair(c: 1, d: 2)"),
  constant("m.c", "Int", "return 3"),
  fn("x.f", "n: Int", "Int", "f(n: 0) == 3", "return n + m.c"),
].join("\n\n");

Deno.test("const: a name with two readings is E0249, naming both (C2)", () => {
  const d = one(AMBIG, "E0249");
  assertEquals([d.definition, d.at, d.message], [
    "x.f",
    "m.c",
    "`m.c` names both the field `c` of the constant `m` of this module and the constant `m.c`; rename one of them, since a name has one meaning (2.6).",
  ]);
});

const LIMIT = constant("m.limit", "Int", "return 100");

Deno.test("const: a constant is used without parentheses (E0247)", () => {
  const source = LIMIT + "\n\n" + fn("m.f", "n: Int", "Int", "f(n: 1) == 101", "return limit() + n");
  const d = one(source, "E0247");
  assertEquals([d.at, d.message, d.fix], [
    "limit()",
    "`limit` is a constant, not a function; it is used without parentheses: `limit`.",
    { replace: "limit()", with: "limit" },
  ]);
  clean(fixed(source, d));
  const named = one(source.replace("limit()", "limit(x: 1)"), "E0247");
  assertEquals(named.fix, null);
  // By position, the constant is a value that is no function.
  const applied = one(source.replace("limit()", "limit(1)"), "E0238");
  assertEquals(applied.message, "`limit` has type `Int` and is not a function value, so it cannot be applied.");
});

Deno.test("const: pure, a value, ending in return (E0233, E0248, E0218, E0203)", () => {
  const effects = one(constant("m.now", "Int", "return std.time.now_milliseconds()"), "E0233");
  assertEquals([effects.section, effects.message], [
    "body",
    "`std.time.now_milliseconds` has effects (time); a constant is pure, so its body calls only functions with `effects: none` (2.2).",
  ]);
  const unit = one(constant("m.nothing", "Unit", "return Unit"), "E0248");
  assertEquals([unit.section, unit.at, unit.message], [
    "out",
    "Unit",
    "A constant holds a value, and `Unit` carries none (3).",
  ]);
  const function_ = one(constant("m.double", "(Int) -> Int", "return fn(n: Int): Int => n * 2"), "E0248");
  assertEquals(function_.message, "A constant holds no function; write `fn m.double` with parameters instead (3).");
  const end = one(constant("m.one", "Int", "let x: Int = 1\nreturn x").replace("    return x\n", ""), "E0218");
  assertEquals(end.message, "A constant's body ends with an explicit `return` (3.4).");
  const typo = one(SHOP + "\n" + fn("shop.h", "n: Int", "Int", "h(n: 1) == 101", "return n + max_item"), "E0203");
  assertEquals(typo.fix, { replace: "max_item", with: "max_items" });
});

// A table of functions in constants (fn-types): a list of records with a
// function field, a record of functions and a map of them, read in their
// module and from another one, their functions applied by position.
const MEASURES = `type m.Measure
  doc: "A named way to value a number."
  record:
    name: String
    value: (Int) -> Int
  where: none
end type m.Measure

type m.Ops
  doc: "Two operations on a number."
  record:
    double: (Int) -> Int
    square: (Int) -> Int
  where: none
end type m.Ops

const m.measures
  doc: "Every measure, in order."
  out: List<Measure>
  body:
    return [Measure(name: "double", value: fn(n: Int): Int => n * 2), Measure(name: "square", value: fn(n: Int): Int => n * n)]
end const m.measures

const m.ops
  doc: "The operations."
  out: Ops
  body:
    return Ops(double: fn(n: Int): Int => n * 2, square: fn(n: Int): Int => n * n)
end const m.ops

const m.table
  doc: "The operations by name."
  out: Map<String, (Int) -> Int>
  body:
    return ["double": ops.double, "square": ops.square]
end const m.table

${fn("m.twice_squared", "n: Int", "Int", "twice_squared(n: 3) == 18", "return ops.double(ops.square(n))")}

${
  fn(
    "app.value_of",
    "name: String, n: Int",
    "Option<Int>",
    'value_of(name: "square", n: 4) == Some(16)',
    "let measure: m.Measure = std.list.find(list: m.measures, with: fn(candidate: m.Measure): Bool => candidate.name == name) else return None\nreturn Some(measure.value(n))",
  )
}

${
  fn(
    "app.by_table",
    "name: String, n: Int",
    "Int",
    'by_table(name: "double", n: 5) == 11',
    "let op: (Int) -> Int = std.map.get(map: m.table, key: name) else return n\nreturn op(n) + m.ops.square(1)",
  )
}
`;

Deno.test("const: a constant may hold functions, applied by position (C5 with fn-types)", () => {
  clean(MEASURES);
  // Named arguments on a function in a constant's field: E0220, as on a local's.
  const named = one(MEASURES.replace("ops.double(ops.square(n))", "ops.double(n: ops.square(n))"), "E0220");
  assertEquals(named.fix, { replace: "ops.double(n: ops.square(n))", with: "ops.double(ops.square(n))" });
});

// The rank round's design: a table of functions returned by a `fn` without
// parameters (F4 kept; the constant is the form).
const RULES_FN = `fn m.rules
  doc: "Every rule, in order."
  in: none
  out: List<Measure>
  effects: none
  requires: none
  ensures: none
  examples: none
  body:
    return [Measure(name: "double", value: fn(n: Int): Int => n * 2)]
end fn m.rules`;

Deno.test("const: E0237 points a fn without parameters to a constant, and lookups to the name", async () => {
  const types = MEASURES.slice(0, MEASURES.indexOf("const m.measures"));
  const d = one(types + RULES_FN, "E0237");
  const constant = [
    "const m.rules",
    '  doc: "Every rule, in order."',
    "  out: List<Measure>",
    "  body:",
    '    return [Measure(name: "double", value: fn(n: Int): Int => n * 2)]',
    "end const m.rules",
  ].join("\n");
  assertEquals([d.at, d.expected, d.fix], ["List<Measure>", constant, null]);
  assert_(d.message.endsWith("write it as a constant, which needs no example, as under `expected`."), d.message);
  // At acceptance it is the only diagnostic: E0401 is the same cause (5.6).
  assertEquals((await acceptance(types + RULES_FN)).map((x) => x.code), ["E0237"]);
  clean(types + constant);
  // A lookup that returns a record holding a function: return the name.
  const lookup = fn(
    "m.find",
    "name: String",
    "Option<Measure>",
    'find(name: "x") == None',
    "return std.list.find(list: measures, with: fn(m: Measure): Bool => m.name == name)",
  );
  const e = one(
    MEASURES + "\n" + lookup.replace('find(name: "x") == None', 'find(name: "x") == find(name: "y")'),
    "E0237",
  );
  assertEquals(e.expected, null);
  assert_(e.message.includes("For a lookup, return the name and apply the function where it is used"), e.message);
});

// ---- the generated TypeScript (1.8) ----

// deno-lint-ignore no-explicit-any
async function load(source: string, name: string): Promise<Record<string, any>> {
  const built = await build(source, `${OUT}${name}.ts`);
  return await import(`file://${built.outPath}?v=${counter++}`);
}

Deno.test("const: a constant is a getter, evaluated once; records keep their name (C13)", async () => {
  const mod = await load(SHOP + "\n" + WEB, "shop");
  assertEquals(mod.shop$limits() === mod.shop$limits(), true);
  assertEquals(rt.std$text$show(mod.shop$limits()), "Limits(items: 100, sizes: 4)");
  assertEquals(mod.$constants.map((c: rt.Constant) => c.definition), ["shop.max_items", "shop.prices", "shop.limits"]);
  assertEquals(mod.web$label("max "), "max 100 of 4 sizes");
  const measures = await load(MEASURES, "measures");
  assertEquals(measures.app$value_of("double", 7), { tag: "Some", value: 14 });
  assertEquals(measures.app$by_table("square", 3), 10);
});

Deno.test("const: the examples of programs with constants hold (C4)", async () => {
  assertEquals(await acceptance(SHOP + "\n" + WEB), []);
  assertEquals(await acceptance(MEASURES), []);
});

// ---- acceptance (1.9, 1.10) ----

Deno.test("const: a cycle is one E0404, at the first constant of it (C4)", async () => {
  const loop = constant("loop.a", "Int", "return b + 1") + "\n\n" + constant("loop.b", "Int", "return a + 1");
  const ds = await acceptance(loop);
  assertEquals(ds.length, 1, JSON.stringify(ds, null, 2));
  assertEquals([ds[0].code, ds[0].definition, ds[0].section, ds[0].at, ds[0].message], [
    "E0404",
    "loop.a",
    "body",
    "const loop.a",
    "Evaluating the constant ends in a trap (`cycle`). The constant loop.a depends on itself: loop.a -> loop.b -> loop.a.",
  ]);
  // Through a function: the example that traps inside the constant is not
  // reported, since its cause is.
  const self = constant("loop.c", "Int", "return plus(n: 1)") + "\n\n" +
    fn("loop.plus", "n: Int", "Int", "plus(n: 1) == 2", "return n + c");
  const selfDs = await acceptance(self);
  assertEquals(selfDs.map((d) => [d.code, d.definition]), [["E0404", "loop.c"]]);
  assert_(selfDs[0].message.endsWith("loop.c -> loop.c."), selfDs[0].message);
});

Deno.test("const: a trap is reported at its constant; the other examples still run (C4)", async () => {
  const big = [
    constant("big.m", "Int", "return n * 2"),
    constant("big.n", "Int", "return 9_007_199_254_740_991 + 1"),
    fn("big.f", "x: Int", "Int", "f(x: 1) == 2", "return x"),
  ].join("\n\n");
  const ds = await acceptance(big);
  assertEquals(ds.map((d) => [d.code, d.definition]), [["E0404", "big.n"], ["E0402", "big.f"]]);
  assertEquals(
    ds[0].message,
    "Evaluating the constant ends in a trap (`overflow`). Int overflow (at `9007199254740991 + 1`).",
  );
  assertEquals(ds[1].message, "The example does not hold: `f(x: 1)` is `1`.");
});

// ---- references (1.12) ----

Deno.test("const: references name constants; a rename respells their segments only", () => {
  const defs = parseProgram(SHOP + "\n" + WEB + "\n" + MEASURES);
  const { diagnostics, info } = checkProgram(defs);
  assertEquals(diagnostics, []);
  const byName = new Map(defs.map((d) => [pathText(d.path), d]));
  assert_(
    references(byName.get("shop.fits")!, info).some((r) => r.kind === "const" && r.full === "shop.limits"),
    "fits refers to the constant",
  );
  assertEquals(dependencies(byName.get("web.label")!, info), [
    "web.label",
    "std.string.join",
    "std.text.show",
    "shop.max_items",
    "shop.limits",
  ]);
  // A constant used only as the target of an application is a reference too.
  assertEquals(dependencies(byName.get("m.twice_squared")!, info), ["m.twice_squared", "m.ops"]);
  const renamed = (name: string) =>
    printProgram([
      mapReferences(byName.get(name)!, info, (r) => (r.full === "m.ops" ? "m.operations" : r.full)),
    ]);
  assert_(renamed("m.twice_squared").includes("return operations.double(operations.square(n))"));
  assert_(renamed("app.by_table").includes("m.operations.square(1)"));
});

Deno.test("const: every accepted program here is accepted by TypeScript too", async () => {
  const files: string[] = [];
  for (const [i, source] of accepted.entries()) files.push((await build(source, `${OUT}checked_${i}.ts`)).outPath);
  assert_(files.length >= 5, String(files.length));
  const result = await new Deno.Command(Deno.execPath(), { args: ["check", ...files], stderr: "piped" }).output();
  assertEquals(result.success, true, new TextDecoder().decode(result.stderr));
});
