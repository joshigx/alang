// End-to-end: alang source -> TypeScript -> type-checked -> executed.
// The spec programs come straight from alang-specs.md.

import { assert_, assertEquals, assertThrows } from "./assert.ts";
import { AlangError } from "../src/diagnostic.ts";
import { Trap } from "../src/runtime.ts";
import { build, type Built, testExamples } from "../src/toolchain.ts";
import { emitProgram } from "../src/emit.ts";
import { parseProgram } from "../src/parser.ts";
import { printProgram } from "../src/printer.ts";

const OUT = new URL("../out/test/", import.meta.url).pathname;
const spec = await Deno.readTextFile(new URL("../alang-specs.md", import.meta.url));
const specBlock = (firstLine: string): string => {
  const m = [...spec.matchAll(/^```\n([\s\S]*?)^```$/gm)].find((m) => m[1].startsWith(firstLine + "\n"));
  if (!m) throw new Error(`spec block not found: ${firstLine}`);
  return m[1];
};

const BLOCKS = `
type shapes.Shape
  doc: "A geometric shape."
  variant:
    Circle: Int
    Square: Int
    Point
  where: none
end type shapes.Shape

fn shapes.describe
  doc: "Names the kind of a shape."
  in:
    shape: Shape
  out: String
  effects: none
  requires: none
  ensures: none
  examples:
    describe(shape: Circle(2)) == "circle"
    describe(shape: Point) == "point"
  body:
    let name: String = match shape
      case Circle(radius) then
        "circle"
      case Square(side) then
        "square"
      case Point then
        "point"
    end match
    return name
end fn shapes.describe

fn shapes.sign
  doc: "Names the sign of a number."
  in:
    n: Int
  out: String
  effects: none
  requires: none
  ensures: none
  examples:
    sign(n: -2) == "negative"
    sign(n: 0) == "zero"
    sign(n: 5) == "positive"
  body:
    if n < 0 then
      return "negative"
    end if
    let word: String = if n == 0 then
      "zero"
    else
      "positive"
    end if
    return word
end fn shapes.sign

fn shapes.lengths
  doc: "Length of every word."
  in:
    words: List<String>
  out: List<Int>
  effects: none
  requires: none
  ensures: none
  examples:
    lengths(words: std.list.empty<String>()) == std.list.empty<Int>()
  body:
    let counts: List<Int> = for word: String in words do
      std.string.length(text: word)
    end for
    return counts
end fn shapes.lengths

fn shapes.total
  doc: "Sum of all non-negative sizes."
  in:
    sizes: List<Int>
  out: Int
  effects: none
  requires: none
  ensures: result >= 0
  examples:
    total(sizes: std.list.empty<Int>()) == 0
  body:
    let kept: List<Int> = std.list.filter(list: sizes, with: fn(x: Int): Bool => x >= 0)
    return std.list.fold(list: kept, initial: 0, with: fn(sum: Int, item: Int): Int => sum + item)
end fn shapes.total

fn shapes.first_number
  doc: "Parses the text, or returns the fallback."
  in:
    text: String
    fallback: Int
  out: Int
  effects: none
  requires: none
  ensures: none
  examples:
    first_number(text: "12", fallback: 0) == 12
    first_number(text: "x", fallback: 7) == 7
  body:
    let n: Int = std.int.parse(text: text) else return fallback
    return n
end fn shapes.first_number

type shapes.Window
  doc: "A record whose field names clash with emitter internals."
  record:
    fields: Int
    result: Int
  where: fields <= result
end type shapes.Window

fn shapes.broken
  doc: "Claims a positive result but returns its input."
  in:
    n: Int
  out: Int
  effects: none
  requires: none
  ensures: result > 0
  examples:
    broken(n: 1) == 1
    broken(n: 2) == 3
  body:
    return n
end fn shapes.broken
`;

const PROGRAMS: Record<string, string> = {
  hello: specBlock("fn hello.main"),
  port: specBlock("type net.port.Port"),
  clamp: specBlock("fn math.clamp"),
  blocks: BLOCKS,
};

const built: Record<string, Built> = {};
for (const [name, source] of Object.entries(PROGRAMS)) {
  built[name] = await build(source, `${OUT}${name}.ts`);
}

// deno-lint-ignore no-explicit-any
const load = async (name: string): Promise<Record<string, any>> => await import(`file://${built[name].outPath}`);

Deno.test("emit: generated TypeScript passes the TypeScript checker", async () => {
  const files = Object.values(built).map((b) => b.outPath);
  const result = await new Deno.Command(Deno.execPath(), { args: ["check", ...files], stderr: "piped" }).output();
  const stderr = new TextDecoder().decode(result.stderr);
  assert_(result.success, stderr);
  assert_(!stderr.includes("No matching files"), stderr);
  // Guard against a vacuous pass: the same command must reject an ill-typed file.
  const canary = `${OUT}ill_typed.ts`;
  await Deno.writeTextFile(canary, 'export const x: number = "not a number";\n');
  const bad = await new Deno.Command(Deno.execPath(), { args: ["check", canary], stderr: "null" }).output();
  assert_(!bad.success, "deno check accepted an ill-typed file");
});

for (const name of ["hello", "port", "clamp"]) {
  Deno.test(`emit: spec examples of ${name} pass`, async () => {
    const results = await testExamples(built[name]);
    assertEquals(results.filter((r) => !r.passed), []);
  });
}

Deno.test("emit: hello.main prints the greeting", async () => {
  const mod = await load("hello");
  const printed: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => printed.push(args.join(" "));
  try {
    mod.hello$main();
  } finally {
    console.log = original;
  }
  assertEquals(printed, ["Hello, world"]);
});

Deno.test("emit: contracts trap at runtime (5.3)", async () => {
  const clamp = await load("clamp");
  assertEquals(assertThrows(() => clamp.math$clamp(1, 10, 0), Trap).kind, "requires");
  const port = await load("port");
  assertEquals(assertThrows(() => port.net$port$Port({ value: 0 }), Trap).kind, "where");
  assertEquals(port.net$port$Port({ value: 65_535 }), { value: 65_535 });
  const blocks = await load("blocks");
  assertEquals(assertThrows(() => blocks.shapes$broken(0), Trap).kind, "ensures");
  assertEquals(assertThrows(() => blocks.shapes$Window({ fields: 2, result: 1 }), Trap).kind, "where");
});

Deno.test("emit: match, if, for, let-else and lambdas", async () => {
  const results = await testExamples(built.blocks);
  const failed = results.filter((r) => !r.passed).map((r) => r.text);
  assertEquals(failed, ["broken(n: 2) == 3"]);
  const mod = await load("blocks");
  assertEquals(mod.shapes$describe({ tag: "Square", value: 3 }), "square");
  assertEquals(mod.shapes$lengths(["a", "Grüße", "😀"]), [1, 5, 1]);
  assertEquals(mod.shapes$total([3, -4, 5]), 8);
});

Deno.test("emit: the block test program is itself canonical", () => {
  assertEquals(printProgram(parseProgram(BLOCKS)), BLOCKS.trimStart());
});

Deno.test("emit: Int overflow traps", async () => {
  const mod = await load("blocks");
  assertEquals(assertThrows(() => mod.shapes$total([Number.MAX_SAFE_INTEGER, 1]), Trap).kind, "overflow");
});

Deno.test("emit: method calls get a dedicated diagnostic (5.7)", () => {
  const source = PROGRAMS.hello.replace(
    'std.console.print_line(text: "Hello, world")',
    'let greeting: String = "Hello"\n    greeting.print_line()',
  );
  const d = assertThrows(() => emitProgram(parseProgram(source), { runtimeImport: "x" }), AlangError).diagnostic;
  assertEquals(d.code, "E0302");
});

Deno.test("emit: output runs on Node.js without Deno", async () => {
  const node = await new Deno.Command("node", { args: ["--version"], stdout: "null", stderr: "null" }).output()
    .catch(() => null);
  if (!node?.success) return; // Node.js not installed.
  const script = `const m = await import(${JSON.stringify(`file://${built.port.outPath}`)});` +
    `process.exit(m.$examples.every((e) => e.run()) ? 0 : 1);`;
  const result = await new Deno.Command("node", { args: ["--input-type=module", "-e", script], stderr: "piped" })
    .output();
  assert_(result.success, new TextDecoder().decode(result.stderr));
});
