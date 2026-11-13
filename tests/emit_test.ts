// End-to-end: alang source -> TypeScript -> type-checked -> executed.
// The spec programs come straight from alang-specs.md.

import { assert_, assertEquals, assertThrows } from "./assert.ts";
import { AlangError } from "../src/diagnostic.ts";
import { Trap } from "../src/runtime.ts";
import { build, type Built, compile, permissionsFor, run, testExamples, writeEntry } from "../src/toolchain.ts";
import { parseProgram } from "../src/parser.ts";
import { printProgram } from "../src/printer.ts";

const OUT = new URL("../out/test/", import.meta.url).pathname;
const spec = await Deno.readTextFile(new URL("../alang-specs.md", import.meta.url));
const specBlock = (firstLine: string): string => {
  const m = [...spec.matchAll(/^```\w*\n([\s\S]*?)^```$/gm)].find((m) => m[1].startsWith(firstLine + "\n"));
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

const CALC = `
fn calc.divide
  doc: "Integer division, rounding toward zero."
  in:
    a: Int
    b: Int
  out: Int
  effects: none
  requires: none
  ensures: none
  examples:
    divide(a: 7, b: 2) == 3
    divide(a: -7, b: 2) == -3
  body:
    return a / b
end fn calc.divide

fn calc.remainder
  doc: "Remainder with the sign of the dividend."
  in:
    a: Int
    b: Int
  out: Int
  effects: none
  requires: none
  ensures: none
  examples:
    remainder(a: 7, b: 2) == 1
    remainder(a: -7, b: 2) == -1
  body:
    return a % b
end fn calc.remainder

fn calc.ratio
  doc: "Float division."
  in:
    a: Float
    b: Float
  out: Float
  effects: none
  requires: none
  ensures: none
  examples:
    ratio(a: 1.0, b: 4.0) == 0.25
  body:
    return a / b
end fn calc.ratio

fn calc.mean
  doc: "Mean of two integers as a Float."
  in:
    a: Int
    b: Int
  out: Float
  effects: none
  requires: none
  ensures: none
  examples:
    mean(a: 1, b: 2) == 1.5
  body:
    return (std.int.to_float(value: a) + std.int.to_float(value: b)) / 2.0
end fn calc.mean

fn calc.first_word
  doc: "The word that sorts first."
  in:
    a: String
    b: String
  out: String
  effects: none
  requires: none
  ensures: none
  examples:
    first_word(a: "pear", b: "apple") == "apple"
    first_word(a: "Zoo", b: "ant") == "Zoo"
  body:
    if a <= b then
      return a
    end if
    return b
end fn calc.first_word

fn calc.sorted
  doc: "The numbers in ascending order."
  in:
    numbers: List<Int>
  out: List<Int>
  effects: none
  requires: none
  ensures: none
  examples:
    sorted(numbers: std.list.append(list: std.list.append(list: std.list.empty<Int>(), item: 3), item: 1)) == std.list.append(list: std.list.append(list: std.list.empty<Int>(), item: 1), item: 3)
  body:
    return std.list.sort(list: numbers, by: std.int.compare)
end fn calc.sorted
`;

// Nested patterns and `error` of a Result, on top of the spec's port module.
const PORT_PLUS = specBlock("type net.port.Port") + `

fn net.port.describe
  doc: "Names the outcome of parsing the text."
  in:
    text: String
  out: String
  effects: none
  requires: none
  ensures: none
  examples:
    describe(text: "80") == "port 80"
    describe(text: "x") == "not a number"
    describe(text: "70_000") == "not a number"
    describe(text: "70000") == "out of range: 70000"
  body:
    let s: String = match parse(text: text)
      case Ok(port) then
        std.string.concat(left: "port ", right: std.text.show(value: port.value))
      case Err(NotANumber) then
        "not a number"
      case Err(OutOfRange(n)) then
        std.string.concat(left: "out of range: ", right: std.text.show(value: n))
    end match
    return s
end fn net.port.describe

fn net.port.value_of
  doc: "The port number of the text."
  in:
    text: String
  out: Result<Int, ParseError>
  effects: none
  requires: none
  ensures: none
  examples:
    value_of(text: "80") == Ok(80)
    value_of(text: "0") == Err(OutOfRange(0))
  body:
    let port: Port = parse(text: text) else return Err(error)
    return Ok(port.value)
end fn net.port.value_of
`;

// The spec's effect example (config.load_port) as a whole program, with the
// error type the spec leaves out.
const APP = specBlock("fn config.load_port") + "\n\n" + specBlock("type net.port.Port") + `

type config.LoadError
  doc: "Why the configuration could not be loaded."
  variant:
    FileUnreadable: std.fs.Error
    InvalidPort: net.port.ParseError
  where: none
end type config.LoadError

fn app.main
  doc: "Prints the port configured in port.txt."
  in: none
  out: Unit
  effects: fs.read, console
  requires: none
  ensures: none
  examples: none
  body:
    let text: String = match config.load_port(path: "port.txt")
      case Ok(port) then
        std.string.concat(left: "port ", right: std.text.show(value: port.value))
      case Err(config.FileUnreadable(std.fs.NotFound)) then
        "no port.txt"
      case Err(config.FileUnreadable(std.fs.PermissionDenied)) then
        "port.txt is unreadable"
      case Err(config.FileUnreadable(std.fs.IsADirectory)) then
        "port.txt is unreadable"
      case Err(config.FileUnreadable(std.fs.Other(reason))) then
        "port.txt is unreadable"
      case Err(config.InvalidPort(reason)) then
        "port.txt holds no valid port"
    end match
    std.console.print_line(text: text)
    return Unit
end fn app.main
`;

// Effects in every position an expression can take: a function with effects
// is async in the output (emit.ts), and the order of the effects must stay
// the order of the text.
const STEPS = `
fn steps.words
  doc: "Two words."
  in: none
  out: List<String>
  effects: none
  requires: none
  ensures: none
  examples:
    words() == std.list.append(list: std.list.append(list: std.list.empty<String>(), item: "a"), item: "bc")
  body:
    return std.list.append(list: std.list.append(list: std.list.empty<String>(), item: "a"), item: "bc")
end fn steps.words

fn steps.say
  doc: "Prints the text and returns its length."
  in:
    text: String
  out: Int
  effects: console
  requires: none
  ensures: result >= 0
  examples: none
  body:
    std.console.print_line(text: text)
    return std.string.length(text: text)
end fn steps.say

fn steps.shout
  doc: "Prints the text; promises more than it keeps."
  in:
    text: String
  out: Int
  effects: console
  requires: none
  ensures: result > 100
  examples: none
  body:
    return say(text: text)
end fn steps.shout

fn steps.count_down
  doc: "Prints the numbers from n down to 1."
  in:
    n: Int
  out: Unit
  effects: console
  requires: n >= 0
  ensures: none
  examples: none
  body:
    if n == 0 then
      return Unit
    end if
    std.console.print_line(text: std.text.show(value: n))
    return count_down(n: n - 1)
end fn steps.count_down

fn steps.main
  doc: "Prints in the order of the text."
  in: none
  out: Unit
  effects: console
  requires: none
  ensures: none
  examples: none
  body:
    let sizes: List<Int> = for word: String in words() do
      say(text: word)
    end for
    let total: Int = say(text: "sum") + std.list.fold(list: sizes, initial: 0, with: fn(sum: Int, item: Int): Int => sum + item)
    if say(text: "check") > 0 then
      std.console.print_line(text: std.text.show(value: total))
    end if
    count_down(n: 3)
    return Unit
end fn steps.main

fn halt.main
  doc: "Ends in a trap inside an awaited call."
  in: none
  out: Unit
  effects: console
  requires: none
  ensures: none
  examples: none
  body:
    let n: Int = steps.shout(text: "quiet")
    std.console.print_line(text: "not reached")
    return Unit
end fn halt.main
`;

const PROGRAMS: Record<string, string> = {
  hello: specBlock("fn hello.main"),
  port: specBlock("type net.port.Port"),
  clamp: specBlock("fn math.clamp"),
  blocks: BLOCKS,
  calc: CALC,
  port_plus: PORT_PLUS,
  app: APP,
  steps: STEPS,
};

const built: Record<string, Built> = {};
for (const [name, source] of Object.entries(PROGRAMS)) {
  built[name] = await build(source, `${OUT}${name}.ts`);
}

// deno-lint-ignore no-explicit-any
const load = async (name: string): Promise<Record<string, any>> => await import(`file://${built[name].outPath}`);

Deno.test("emit: generated TypeScript passes the TypeScript checker", async () => {
  const entries = [
    await writeEntry(built.hello),
    await writeEntry(built.app),
    await writeEntry(built.steps, "steps.main"),
  ];
  const files = [...Object.values(built).map((b) => b.outPath), ...entries];
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

for (const name of ["hello", "port", "clamp", "calc", "port_plus"]) {
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
    // A function with effects is async (emit.ts).
    assertEquals(await mod.hello$main(), null);
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

Deno.test("emit: Int and Float arithmetic are separate", async () => {
  const mod = await load("calc");
  assertEquals(assertThrows(() => mod.calc$divide(1, 0), Trap).kind, "division");
  assertEquals(assertThrows(() => mod.calc$remainder(1, 0), Trap).kind, "division");
  assertEquals(mod.calc$ratio(1, 0), Infinity);
  assertEquals(assertThrows(() => mod.calc$ratio(0, 0), Trap).kind, "nan");
  // Large integral Floats are not Ints and do not overflow.
  assertEquals(mod.calc$ratio(2 ** 60, 0.5), 2 ** 61);
});

Deno.test("emit: the test programs are themselves canonical", () => {
  assertEquals(printProgram(parseProgram(CALC)), CALC.trimStart());
  assertEquals(printProgram(parseProgram(BLOCKS)), BLOCKS.trimStart());
  assertEquals(printProgram(parseProgram(STEPS)), STEPS.trimStart());
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
  const d = assertThrows(() => compile(source, "x"), AlangError).diagnostic;
  assertEquals(d.code, "E0220");
});

Deno.test("emit: output runs on Node.js without Deno", async () => {
  const node = await new Deno.Command("node", { args: ["--version"], stdout: "null", stderr: "null" }).output()
    .catch(() => null);
  if (!node?.success) return; // Node.js not installed.
  const script = `const m = await import(${JSON.stringify(`file://${built.port.outPath}`)});` +
    `const rt = await import(${JSON.stringify(new URL("../src/runtime.ts", import.meta.url).href)});` +
    `const fs = await import(${JSON.stringify(`file://${built.app.outPath}`)});` +
    `const r = await fs.config$load_port(${JSON.stringify(new URL("../deno.json", import.meta.url).pathname)});` +
    // deno.json is not a port number: the file was read, then rejected.
    `const read = r.tag === "Err" && r.value.tag === "InvalidPort";` +
    `const missing = (await fs.config$load_port("/does/not/exist")).value.value.tag === "NotFound";` +
    `const examples = rt.runExamples(m.$examples);` +
    `process.exit(examples.length === 3 && examples.every((r) => r.passed) && read && missing ? 0 : 1);`;
  const result = await new Deno.Command("node", { args: ["--input-type=module", "-e", script], stderr: "piped" })
    .output();
  assert_(result.success, new TextDecoder().decode(result.stderr));
});

Deno.test("emit: functions with effects are async, pure code stays synchronous", async () => {
  const ts = await Deno.readTextFile(built.steps.outPath);
  assert_(ts.includes("export function steps$words(): readonly string[] {"), ts);
  assert_(ts.includes("export async function steps$say(text: string): Promise<number> {"), ts);
  // Calls of functions with effects are awaited, std ones included; pure calls are not.
  assert_(ts.includes("(await $rt.std$console$print_line(text));"), ts);
  assert_(ts.includes("(await steps$say(word))"), ts);
  assert_(ts.includes("for (const word of steps$words())"), ts);
  // The ensures wrapper of an async function is awaited too.
  assert_(ts.includes("const result: number = await (async (): Promise<number> => {"), ts);
  // Examples call only pure functions (5.4), so they run without awaiting.
  assertEquals((await testExamples(built.steps)).every((r) => r.passed), true);
  const mod = await load("steps");
  assertEquals(mod.steps$words(), ["a", "bc"]);
  assert_(mod.steps$say instanceof (async () => {}).constructor);
});

// ---- effects at runtime ----

Deno.test("run: effects map to Deno permissions", () => {
  assertEquals(permissionsFor([]), []);
  assertEquals(permissionsFor(["console", "log", "time", "random"]), []);
  assertEquals(permissionsFor(["fs.read", "console"]), ["--allow-read"]);
  assertEquals(permissionsFor(["fs.read", "fs.write", "net", "env"]), [
    "--allow-read",
    "--allow-write",
    "--allow-net",
    "--allow-env",
  ]);
});

const text = (b: Uint8Array) => new TextDecoder().decode(b).trim();

Deno.test("run: effects happen in the order of the text", async () => {
  const out = await run(built.steps, { stdio: "piped", main: "steps.main" });
  assertEquals([out.code, text(out.stdout).split("\n")], [0, ["a", "bc", "sum", "check", "6", "3", "2", "1"]]);
});

Deno.test("run: a trap inside an awaited call ends the program", async () => {
  const out = await run(built.steps, { stdio: "piped", main: "halt.main" });
  assertEquals(out.code, 70);
  assertEquals(text(out.stdout), "quiet");
  const trap = JSON.parse(text(out.stderr));
  assertEquals([trap.trap, trap.definition], ["ensures", "steps.shout"]);
});

Deno.test("run: main runs with exactly the permissions of its effects", async () => {
  const dir = await Deno.makeTempDir({ dir: OUT });
  await Deno.writeTextFile(`${dir}/port.txt`, "8080\n");
  const ok = await run(built.app, { stdio: "piped", cwd: dir });
  assertEquals([ok.code, text(ok.stdout)], [0, "port 8080"], text(ok.stderr));

  await Deno.writeTextFile(`${dir}/port.txt`, "99999");
  assertEquals(text((await run(built.app, { stdio: "piped", cwd: dir })).stdout), "port.txt holds no valid port");
  await Deno.remove(`${dir}/port.txt`);
  assertEquals(text((await run(built.app, { stdio: "piped", cwd: dir })).stdout), "no port.txt");

  const hello = await run(built.hello, { stdio: "piped" });
  assertEquals([hello.code, text(hello.stdout)], [0, "Hello, world"]);
});

Deno.test("run: reading without the fs.read permission traps", async () => {
  const dir = await Deno.makeTempDir({ dir: OUT });
  await Deno.writeTextFile(`${dir}/port.txt`, "8080");
  // As if main had declared only `console`: the read is refused by Deno and
  // the program ends with a trap instead of treating it as a missing file.
  const denied = await run(built.app, { stdio: "piped", cwd: dir, effects: ["console"] });
  assertEquals(denied.code, 70);
  assertEquals(JSON.parse(text(denied.stderr)).trap, "effect");
  assertEquals(text(denied.stdout), "");
});
