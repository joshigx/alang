// End-to-end: alang source -> TypeScript -> type-checked -> executed.
// The spec programs come straight from alang-specs.md.

import { assert_, assertEquals, assertThrows } from "./assert.ts";
import { ENDING_PROGRAM, IO_PROGRAM, NET_PROGRAM } from "./io_program.ts";
import { AlangError } from "../src/diagnostic.ts";
import * as rt from "../src/runtime.ts";
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
      case Err(config.FileUnreadable(std.fs.AlreadyExists)) then
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

// The propagation statement (T1) in a pure helper's caller and around
// writes, and a statement without a value ending a `return match` arm.
const PROPAGATE = `
fn propagate.check_width
  doc: "Whether a width is positive."
  in:
    width: Int
  out: Result<Unit, String>
  effects: none
  requires: none
  ensures: none
  examples:
    check_width(width: 1) == Ok(Unit)
    check_width(width: 0) == Err("too narrow")
  body:
    if width < 1 then
      return Err("too narrow")
    end if
    return Ok(Unit)
end fn propagate.check_width

fn propagate.area
  doc: "The area of a rectangle of positive sides."
  in:
    width: Int
    height: Int
  out: Result<Int, String>
  effects: none
  requires: none
  ensures: none
  examples:
    area(width: 2, height: 3) == Ok(6)
    area(width: 2, height: 0) == Err("too narrow")
  body:
    check_width(width: width) else return Err(error)
    check_width(width: height) else return Err(error)
    return Ok(width * height)
end fn propagate.area

fn propagate.save
  doc: "Writes two files into the directory; the second one into a directory that does not exist."
  in:
    directory: String
  out: Result<Unit, String>
  effects: fs.write
  requires: none
  ensures: none
  examples: none
  body:
    std.fs.write_text(path: std.string.concat(left: directory, right: "/first.txt"), text: "1") else return Err(std.fs.describe(error: error))
    std.fs.write_text(path: std.string.concat(left: directory, right: "/missing/second.txt"), text: "2") else return Err(std.fs.describe(error: error))
    return Ok(Unit)
end fn propagate.save

fn propagate.settle
  doc: "Checks a width if there is one."
  in:
    width: Option<Int>
  out: Unit
  effects: none
  requires: none
  ensures: none
  examples:
    settle(width: Some(2)) == Unit
    settle(width: None) == Unit
  body:
    return match width
      case Some(w) then
        let doubled: Int = w * 2
      case None then
        check_width(width: 1) else return Unit
    end match
end fn propagate.settle

fn propagate.fields
  doc: "The last of exactly three words."
  in:
    line: String
  out: Option<String>
  effects: none
  requires: none
  ensures: none
  examples:
    fields(line: "GET /index 200") == Some("200")
    fields(line: "GET /index") == None
    fields(line: "GET /index 200 extra") == None
    fields(line: "") == None
  body:
    let [method, path, status]: List<String> = std.string.split(text: line, separator: " ") else return None
    return Some(status)
end fn propagate.fields

fn propagate.first_of_pair
  doc: "The first item of a list of two, or the else value, inside a match arm."
  in:
    items: Option<List<Int>>
  out: Int
  effects: none
  requires: none
  ensures: none
  examples:
    first_of_pair(items: Some([4, 5])) == 4
    first_of_pair(items: Some([4])) == -1
    first_of_pair(items: None) == 0
  body:
    let first: Int = match items
      case Some(pair) then
        let [left, right]: List<Int> = pair else return -1
        left
      case None then
        0
    end match
    return first
end fn propagate.first_of_pair
`;

// Shared cases (T10): one TypeScript branch per pattern, each with its own
// binds, so `n` has an access path of its own in each.
const SHARED = `
fn shared.value
  doc: "The number inside, or the error code."
  in:
    outcome: Result<Option<Int>, Int>
  out: Int
  effects: none
  requires: none
  ensures: none
  examples:
    value(outcome: Ok(Some(3))) == 3
    value(outcome: Ok(None)) == 0
    value(outcome: Err(7)) == 7
  body:
    let found: Int = match outcome
      case Ok(Some(n)) or Err(n) then
        n
      case Ok(None) then
        0
    end match
    return found
end fn shared.value

fn shared.retry
  doc: "Whether a file operation is worth repeating after the error."
  in:
    error_kind: std.fs.Error
  out: Bool
  effects: none
  requires: none
  ensures: none
  examples:
    retry(error_kind: std.fs.NotFound) == true
    retry(error_kind: std.fs.IsADirectory) == false
    retry(error_kind: std.fs.Other("busy")) == false
  body:
    let again: Bool = match error_kind
      case std.fs.NotFound then
        true
      case std.fs.PermissionDenied or std.fs.IsADirectory or std.fs.AlreadyExists or std.fs.Other(message) then
        let quiet: Bool = false
        quiet
    end match
    return again
end fn shared.retry
`;

// The std types of std.fs named in a program: a variant type missing from
// runtime.ts is caught only by `deno check` of such a program.
const KINDS = `
fn kinds.describe
  doc: "Says what a path names."
  in:
    path: String
  out: String
  effects: fs.read
  requires: none
  ensures: none
  examples: none
  body:
    let found: Result<std.fs.Kind, std.fs.Error> = std.fs.kind(path: path)
    let text: String = match found
      case Ok(std.fs.File) then
        "a file"
      case Ok(std.fs.Directory) then
        "a directory"
      case Err(reason) then
        std.text.show(value: reason)
    end match
    return text
end fn kinds.describe
`;

// List literals: annotated with their checked type, so that TypeScript
// neither narrows `[Some(1)]` to `Some<number>[]` nor rejects nested lists.
const LISTS = `
type lists.Point
  doc: "A point."
  record:
    x: Int
    y: Int
  where: none
end type lists.Point

type lists.Shape
  doc: "A shape."
  variant:
    Circle: Int
    Dot
  where: none
end type lists.Shape

fn lists.points
  doc: "Two points."
  in: none
  out: List<Point>
  effects: none
  requires: none
  ensures: none
  examples:
    points() == [Point(x: 1, y: 2), Point(x: 3, y: 4)]
  body:
    return [Point(x: 1, y: 2), Point(x: 3, y: 4)]
end fn lists.points

fn lists.shapes
  doc: "One shape of each case."
  in: none
  out: List<Shape>
  effects: none
  requires: none
  ensures: none
  examples:
    shapes() == [Circle(1), Dot]
  body:
    let all: List<Shape> = [Circle(1), Dot]
    return all
end fn lists.shapes

fn lists.options
  doc: "A literal whose type comes from its first item, then extended."
  in: none
  out: List<Option<Int>>
  effects: none
  requires: none
  ensures: none
  examples:
    options() == [Some(1), None]
  body:
    return std.list.append(list: [Some(1)], item: None)
end fn lists.options

fn lists.rows
  doc: "Each number with its double."
  in: none
  out: List<List<Int>>
  effects: none
  requires: none
  ensures: none
  examples:
    rows() == [[1, 2], [2, 4], [3, 6]]
  body:
    let fixed: List<List<Int>> = [[1, 2], [2, 4]]
    let built: List<List<Int>> = for n: Int in [1, 2, 3] do
      [n, n * 2]
    end for
    if std.list.length(list: fixed) > 2 then
      return fixed
    end if
    return built
end fn lists.rows

fn lists.say
  doc: "Prints the text and returns its length."
  in:
    text: String
  out: Int
  effects: console
  requires: none
  ensures: none
  examples: none
  body:
    std.console.print_line(text: text)
    return std.string.length(text: text)
end fn lists.say

fn lists.main
  doc: "Prints in the order of the list, then the lengths."
  in: none
  out: Unit
  effects: console
  requires: none
  ensures: none
  examples: none
  body:
    let lengths: List<Int> = [say(text: "one"), say(text: "three")]
    for n: Int in lengths do
      std.console.print_line(text: std.text.show(value: n))
    end for
    return Unit
end fn lists.main
`;

const MAPS = `
type maps.Point
  doc: "A point."
  record:
    x: Int
    y: Int
  where: none
end type maps.Point

fn maps.corners
  doc: "Two named points."
  in: none
  out: Map<String, Point>
  effects: none
  requires: none
  ensures: none
  examples:
    corners() == ["low": Point(x: 0, y: 0), "high": Point(x: 9, y: 9)]
  body:
    return ["low": Point(x: 0, y: 0), "high": Point(x: 9, y: 9)]
end fn maps.corners

fn maps.options
  doc: "A map whose first value is None, typed by its declaration, and one more entry."
  in: none
  out: Map<String, Option<Int>>
  effects: none
  requires: none
  ensures: none
  examples:
    options() == ["a": None, "b": Some(2), "c": Some(3)]
  body:
    let fixed: Map<String, Option<Int>> = ["a": None, "b": Some(2)]
    return std.map.insert(map: fixed, key: "c", value: Some(3))
end fn maps.options

fn maps.grown
  doc: "A literal whose type comes from its first entry, then extended by None."
  in: none
  out: Map<String, Option<Int>>
  effects: none
  requires: none
  ensures: none
  examples:
    grown() == ["a": Some(1), "b": None]
  body:
    return std.map.insert(map: ["a": Some(1)], key: "b", value: None)
end fn maps.grown

fn maps.pair
  doc: "Two keys with their values."
  in:
    first: String
    second: String
  out: Map<String, Int>
  effects: none
  requires: none
  ensures: none
  examples:
    pair(first: "b", second: "a") == ["a": 2, "b": 1]
  body:
    return [first: 1, second: 2]
end fn maps.pair

fn maps.say
  doc: "Prints the text and returns it."
  in:
    text: String
  out: String
  effects: console
  requires: none
  ensures: none
  examples: none
  body:
    std.console.print_line(text: text)
    return text
end fn maps.say

fn maps.main
  doc: "Builds a map whose entries print, then prints the map."
  in: none
  out: Unit
  effects: console
  requires: none
  ensures: none
  examples: none
  body:
    let m: Map<String, String> = [say(text: "b"): say(text: "2"), say(text: "a"): say(text: "1")]
    std.console.print_line(text: std.text.show(value: m))
    return Unit
end fn maps.main
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
  propagate: PROPAGATE,
  shared: SHARED,
  kinds: KINDS,
  lists: LISTS,
  maps: MAPS,
  io: IO_PROGRAM,
  ending: ENDING_PROGRAM,
  net: NET_PROGRAM,
  probe: await Deno.readTextFile(new URL("../examples/probe.alang", import.meta.url)),
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
    await writeEntry(built.lists, "lists.main"),
    await writeEntry(built.maps, "maps.main"),
    await writeEntry(built.io),
    // A `Result` main reads `.tag`, which a `Unit` main's entry must not.
    await writeEntry(built.ending),
    await writeEntry(built.net),
    await writeEntry(built.probe),
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

for (const name of ["hello", "port", "clamp", "calc", "port_plus", "propagate", "shared"]) {
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
  // An arithmetic trap names the definition the operation is written in.
  const kindAndDefinition = (fn: () => unknown) => {
    const trap = assertThrows(fn, Trap);
    return [trap.kind, trap.definition];
  };
  assertEquals(kindAndDefinition(() => mod.calc$divide(1, 0)), ["division", "calc.divide"]);
  assertEquals(kindAndDefinition(() => mod.calc$remainder(1, 0)), ["division", "calc.remainder"]);
  assertEquals(mod.calc$ratio(1, 0), Infinity);
  assertEquals(kindAndDefinition(() => mod.calc$ratio(0, 0)), ["nan", "calc.ratio"]);
  // Large integral Floats are not Ints and do not overflow.
  assertEquals(mod.calc$ratio(2 ** 60, 0.5), 2 ** 61);
});

Deno.test("emit: the test programs are themselves canonical", () => {
  assertEquals(printProgram(parseProgram(CALC)), CALC.trimStart());
  assertEquals(printProgram(parseProgram(BLOCKS)), BLOCKS.trimStart());
  assertEquals(printProgram(parseProgram(STEPS)), STEPS.trimStart());
  assertEquals(printProgram(parseProgram(PROPAGATE)), PROPAGATE.trimStart());
  assertEquals(printProgram(parseProgram(SHARED)), SHARED.trimStart());
  assertEquals(printProgram(parseProgram(KINDS)), KINDS.trimStart());
  assertEquals(printProgram(parseProgram(LISTS)), LISTS.trimStart());
  assertEquals(printProgram(parseProgram(MAPS)), MAPS.trimStart());
  assertEquals(printProgram(parseProgram(IO_PROGRAM)), IO_PROGRAM);
  assertEquals(printProgram(parseProgram(ENDING_PROGRAM)), ENDING_PROGRAM);
  assertEquals(printProgram(parseProgram(NET_PROGRAM)), NET_PROGRAM);
});

Deno.test("emit: Int overflow traps", async () => {
  const mod = await load("blocks");
  const trap = assertThrows(() => mod.shapes$total([Number.MAX_SAFE_INTEGER, 1]), Trap);
  // The addition is in a lambda, which belongs to the definition around it.
  assertEquals([trap.kind, trap.definition, trap.at], ["overflow", "shapes.total", "9007199254740991 + 1"]);
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
    // List literals carry `satisfies` and `as`, which Node.js strips like other types.
    `const lists = rt.runExamples((await import(${JSON.stringify(`file://${built.lists.outPath}`)})).$examples);` +
    `const listed = lists.length === 4 && lists.every((r) => r.passed);` +
    `process.exit(examples.length === 3 && examples.every((r) => r.passed) && read && missing && listed ? 0 : 1);`;
  const result = await new Deno.Command("node", { args: ["--input-type=module", "-e", script], stderr: "piped" })
    .output();
  assert_(result.success, new TextDecoder().decode(result.stderr));
});

Deno.test("emit: functions with effects are async, pure code stays synchronous", async () => {
  const ts = await Deno.readTextFile(built.steps.outPath);
  assert_(ts.includes("export function steps$words(): ReadonlyArray<string> {"), ts);
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

Deno.test("emit: list literals run, typed as their checked type", async () => {
  assertEquals((await testExamples(built.lists)).filter((r) => !r.passed), []);
  const ts = await Deno.readTextFile(built.lists.outPath);
  assert_(
    ts.includes("([$rt.Some(1)] satisfies ReadonlyArray<$rt.Option<number>> as ReadonlyArray<$rt.Option<number>>)"),
    ts,
  );
  assert_(ts.includes("export function lists$rows(): ReadonlyArray<ReadonlyArray<number>> {"), ts);
  const mod = await load("lists");
  assertEquals(mod.lists$rows(), [[1, 2], [2, 4], [3, 6]]);
  // Items with effects are awaited from left to right.
  const out = await run(built.lists, { stdio: "piped", main: "lists.main" });
  assertEquals([out.code, text(out.stdout).split("\n")], [0, ["one", "three", "3", "5"]]);
});

Deno.test("emit: map literals run, typed as their checked type", async () => {
  assertEquals((await testExamples(built.maps)).filter((r) => !r.passed), []);
  const ts = await Deno.readTextFile(built.maps.outPath);
  assert_(
    ts.includes('$rt.map_literal<string, $rt.Option<number>>([["a", $rt.None], ["b", $rt.Some(2)]], "maps.options")'),
    ts,
  );
  assert_(ts.includes("export function maps$corners(): $rt.SortedMap<string, maps$Point> {"), ts);
  const mod = await load("maps");
  assertEquals(rt.map_entries(mod.maps$grown()), [["a", rt.Some(1)], ["b", rt.None]]);
  // Two computed keys that are equal trap, naming the definition.
  const trap = assertThrows(() => mod.maps$pair("a", "a"), Trap);
  assertEquals([trap.kind, trap.definition, trap.at, trap.message], [
    "key",
    "maps.pair",
    '"a"',
    'The key "a" appears twice in a map literal.',
  ]);
  // Entries run from left to right, each key before its value; the map is in key order.
  const out = await run(built.maps, { stdio: "piped", main: "maps.main" });
  assertEquals([out.code, text(out.stdout).split("\n")], [0, ["b", "2", "a", "1", '["a": "1", "b": "2"]']]);
});

Deno.test("emit: an if as a list item is not compiled yet (E0303)", () => {
  const source = LISTS.replace(
    "let fixed: List<List<Int>> = [[1, 2], [2, 4]]",
    "let fixed: List<List<Int>> = [if true then\n      [1, 2]\n    else\n      [2, 4]\n    end if]",
  );
  const d = assertThrows(() => compile(source, "x"), AlangError).diagnostic;
  assertEquals([d.code, d.definition, d.at], ["E0303", "lists.rows", "if true then"]);
});

Deno.test("emit: a match over the std.fs types runs", async () => {
  const mod = await load("kinds");
  assertEquals(await mod.kinds$describe(OUT), "a directory");
  assertEquals(await mod.kinds$describe(new URL("../deno.json", import.meta.url).pathname), "a file");
  assertEquals(await mod.kinds$describe("/does/not/exist"), "NotFound");
});

Deno.test("emit: a propagation statement returns the else value, or goes on (T1)", async () => {
  const mod = await load("propagate");
  assertEquals(mod.propagate$area(2, 3), { tag: "Ok", value: 6 });
  assertEquals(mod.propagate$area(0, 3), { tag: "Err", value: "too narrow" });
  const dir = await Deno.makeTempDir({ prefix: "alang-propagate-" });
  try {
    assertEquals(await mod.propagate$save(dir), { tag: "Err", value: "no such file or directory" });
    assertEquals(await Deno.readTextFile(`${dir}/first.txt`), "1");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("emit: a block ending without a value delivers Unit to a return (sink fix)", async () => {
  const mod = await load("propagate");
  assertEquals(mod.propagate$settle({ tag: "Some", value: 2 }), null);
  assertEquals(mod.propagate$settle({ tag: "None" }), null);
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
