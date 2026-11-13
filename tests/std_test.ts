// The pure std functions in src/runtime.ts, called directly with tables of
// inputs and results. The checker's view of them (signatures, effects) is
// tested in check_test.ts; their use from generated code in emit_test.ts.

import { assert_, assertEquals, assertThrows } from "./assert.ts";
import { parseProgram } from "../src/parser.ts";
import { printProgram } from "../src/printer.ts";
import * as rt from "../src/runtime.ts";
import { accept } from "../src/toolchain.ts";

Deno.test("std: an Int is never negative zero", () => {
  const zeros: [string, number][] = [
    ["0 * -1", rt.int_mul(0, -1, "m.f")],
    ["-7 % 7", rt.int_rem(-7, 7, "m.f")],
    ["-1 / 2", rt.int_div(-1, 2, "m.f")],
    ["0 - 0", rt.int_sub(0, 0, "m.f")],
    ['parse("-0")', (rt.std$int$parse("-0") as rt.Some<number>).value],
    ["floor(-0.0)", rt.std$float$floor(-0)],
    ["floor(-0.5) + 1", rt.int_add(rt.std$float$floor(-0.5), 1, "m.f")],
  ];
  for (const [what, value] of zeros) assertEquals(Object.is(value, 0), true, what);
  // A Float keeps IEEE's -0.0.
  assertEquals(Object.is(rt.float_mul(0, -1, "m.f"), -0), true);
});

const MAX = Number.MAX_SAFE_INTEGER;

Deno.test("std.int: min, max and abs", () => {
  assertEquals([rt.std$int$min(3, -4), rt.std$int$min(-4, 3), rt.std$int$min(2, 2)], [-4, -4, 2]);
  assertEquals([rt.std$int$max(3, -4), rt.std$int$max(-4, 3), rt.std$int$max(2, 2)], [3, 3, 2]);
  assertEquals([rt.std$int$abs(-5), rt.std$int$abs(5), rt.std$int$abs(0), rt.std$int$abs(-MAX)], [5, 5, 0, MAX]);
});

Deno.test("std.int: checked arithmetic is None outside the Int range", () => {
  const cases: [string, rt.Option<number>, rt.Option<number>][] = [
    ["MAX + 0", rt.std$int$checked_add(MAX, 0), rt.Some(MAX)],
    ["MAX + 1", rt.std$int$checked_add(MAX, 1), rt.None],
    ["-MAX + -1", rt.std$int$checked_add(-MAX, -1), rt.None],
    ["MAX + -MAX", rt.std$int$checked_add(MAX, -MAX), rt.Some(0)],
    ["-MAX - 0", rt.std$int$checked_subtract(-MAX, 0), rt.Some(-MAX)],
    ["-MAX - 1", rt.std$int$checked_subtract(-MAX, 1), rt.None],
    ["MAX - -1", rt.std$int$checked_subtract(MAX, -1), rt.None],
    ["3 - 5", rt.std$int$checked_subtract(3, 5), rt.Some(-2)],
    ["MAX * 1", rt.std$int$checked_multiply(MAX, 1), rt.Some(MAX)],
    ["MAX * -1", rt.std$int$checked_multiply(MAX, -1), rt.Some(-MAX)],
    ["MAX * 2", rt.std$int$checked_multiply(MAX, 2), rt.None],
    ["2^26 * 2^27", rt.std$int$checked_multiply(2 ** 26, 2 ** 27), rt.None],
    ["-6 * 7", rt.std$int$checked_multiply(-6, 7), rt.Some(-42)],
  ];
  for (const [what, actual, expected] of cases) assertEquals(actual, expected, what);
  // Without negative zero: deepStrictEqual tells 0 from -0.
  assertEquals(rt.std$int$checked_multiply(0, -1), rt.Some(0));
  assertEquals(rt.std$int$checked_subtract(-0, 0), rt.Some(0));
});

// The trap a call ends in, as [kind, definition, at].
function trapOf(fn: () => unknown): [string, string | null, string] {
  const trap = assertThrows(fn, rt.Trap);
  return [trap.kind, trap.definition, trap.at];
}

Deno.test("std.string: searching, with the empty part occurring everywhere", () => {
  const s = rt.std$string$contains;
  assertEquals([s("hello", "ell"), s("hello", "xyz"), s("hello", ""), s("", ""), s("", "a")], [
    true,
    false,
    true,
    true,
    false,
  ]);
  const p = rt.std$string$starts_with;
  assertEquals([p("hello", "he"), p("hello", "lo"), p("hello", ""), p("he", "hello")], [true, false, true, false]);
  const e = rt.std$string$ends_with;
  assertEquals([e("hello", "lo"), e("hello", "he"), e("hello", ""), e("lo", "hello")], [true, false, true, false]);
  const f = rt.std$string$find;
  assertEquals(f("hello", "l"), rt.Some(2));
  assertEquals(f("hello", "x"), rt.None);
  assertEquals(f("hello", ""), rt.Some(0));
  assertEquals(f("", ""), rt.Some(0));
  // Counted in Unicode scalar values, not UTF-16 units.
  assertEquals(f("a😀b", "b"), rt.Some(2));
  assertEquals(f("😀😀", "😀"), rt.Some(0));
});

Deno.test("std.string: cut at the first separator", () => {
  const c = rt.std$string$cut;
  assertEquals(c("key=value", "="), rt.Some({ before: "key", after: "value" }));
  assertEquals(c("a=b=c", "="), rt.Some({ before: "a", after: "b=c" }));
  assertEquals(c("a == b", " == "), rt.Some({ before: "a", after: "b" }));
  assertEquals(c("novalue", "="), rt.None);
  assertEquals(c("text", ""), rt.Some({ before: "", after: "text" }));
  assertEquals(c("😀=😀", "="), rt.Some({ before: "😀", after: "😀" }));
});

Deno.test("std.string: take and drop count Unicode scalar values and clamp above the length", () => {
  const text = "a😀b";
  assertEquals([0, 2, 3, 9].map((n) => rt.std$string$take(text, n)), ["", "a😀", "a😀b", "a😀b"]);
  assertEquals([0, 2, 3, 9].map((n) => rt.std$string$drop(text, n)), ["a😀b", "b", "", ""]);
  assertEquals(trapOf(() => rt.std$string$take(text, -1)), ["requires", "std.string.take", "count >= 0"]);
  assertEquals(trapOf(() => rt.std$string$drop(text, -1)), ["requires", "std.string.drop", "count >= 0"]);
});

Deno.test("std.string: characters and lines", () => {
  assertEquals(rt.std$string$characters("a😀b"), ["a", "😀", "b"]);
  assertEquals(rt.std$string$characters(""), []);
  const lines: [string, string[]][] = [
    ["", []],
    ["a", ["a"]],
    ["a\n", ["a"]],
    ["a\r\nb\r\n", ["a", "b"]],
    ["a\n\nb", ["a", "", "b"]],
    ["\n", [""]],
    ["\n\n", ["", ""]],
    ["a\r", ["a\r"]],
    ["a\rb\nc", ["a\rb", "c"]],
    ["a\r\r\n", ["a\r"]],
  ];
  for (const [text, expected] of lines) assertEquals(rt.std$string$lines(text), expected, JSON.stringify(text));
});

Deno.test("std.string: replace, and case mapping without a locale", () => {
  assertEquals(rt.std$string$replace("aaa", "aa", "b"), "ba");
  assertEquals(rt.std$string$replace("a.b.c", ".", "/"), "a/b/c");
  // The replacement is text, not a pattern.
  assertEquals(rt.std$string$replace("a.b", ".", "$&"), "a$&b");
  assertEquals(rt.std$string$replace("abc", "x", "y"), "abc");
  assertEquals(rt.std$string$replace("abc", "b", ""), "ac");
  assertEquals(trapOf(() => rt.std$string$replace("abc", "", "x")), ["requires", "std.string.replace", 'part != ""']);
  assertEquals(rt.std$string$to_upper("straße"), "STRASSE");
  assertEquals(rt.std$string$to_upper("Grüße, i"), "GRÜSSE, I");
  assertEquals(rt.std$string$to_lower("ÄÖÜ ΑΣ I"), "äöü ας i");
});

// One alang program whose examples call the std functions added with list
// literals. Acceptance runs the examples; `deno check` then holds the
// generated calls against the runtime's TypeScript signatures.
const PROGRAM = `fn uses.ints
  doc: "The new functions of std.int on two numbers."
  in:
    a: Int
    b: Int
  out: List<Option<Int>>
  effects: none
  requires: none
  ensures: none
  examples:
    ints(a: 3, b: -4) == [Some(-4), Some(3), Some(4), Some(-1), Some(7), Some(-12)]
    ints(a: 9_007_199_254_740_991, b: 2) == [Some(2), Some(9_007_199_254_740_991), Some(2), None, Some(9_007_199_254_740_989), None]
  body:
    return [Some(std.int.min(left: a, right: b)), Some(std.int.max(left: a, right: b)), Some(std.int.abs(value: b)), std.int.checked_add(left: a, right: b), std.int.checked_subtract(left: a, right: b), std.int.checked_multiply(left: a, right: b)]
end fn uses.ints

fn uses.searches
  doc: "Whether the part occurs in the text, starts it and ends it."
  in:
    text: String
    part: String
  out: List<Bool>
  effects: none
  requires: none
  ensures: none
  examples:
    searches(text: "hello", part: "he") == [true, true, false]
    searches(text: "hello", part: "") == [true, true, true]
  body:
    return [std.string.contains(text: text, part: part), std.string.starts_with(text: text, prefix: part), std.string.ends_with(text: text, suffix: part)]
end fn uses.searches

fn uses.position
  doc: "Where the part first occurs."
  in:
    text: String
    part: String
  out: Option<Int>
  effects: none
  requires: none
  ensures: none
  examples:
    position(text: "a😀b", part: "b") == Some(2)
    position(text: "a😀b", part: "c") == None
  body:
    return std.string.find(text: text, part: part)
end fn uses.position

fn uses.key
  doc: "The key and value of a line such as a=b."
  in:
    line: String
  out: Option<std.string.Cut>
  effects: none
  requires: none
  ensures: none
  examples:
    key(line: "a=b=c") == Some(std.string.Cut(before: "a", after: "b=c"))
    key(line: "x") == None
  body:
    return std.string.cut(text: line, separator: "=")
end fn uses.key

fn uses.pieces
  doc: "The text taken, dropped, mapped to upper and lower case, and with its emoji replaced."
  in:
    text: String
  out: List<String>
  effects: none
  requires: none
  ensures: none
  examples:
    pieces(text: "a😀B") == ["a😀", "B", "A😀B", "a😀b", "a-B"]
  body:
    return [std.string.take(text: text, count: 2), std.string.drop(text: text, count: 2), std.string.to_upper(text: text), std.string.to_lower(text: text), std.string.replace(text: text, part: "😀", with: "-")]
end fn uses.pieces

fn uses.split_up
  doc: "The characters and the lines of the text."
  in:
    text: String
  out: List<List<String>>
  effects: none
  requires: none
  ensures: none
  examples:
    split_up(text: "ab\\ncd\\n") == [["a", "b", "\\n", "c", "d", "\\n"], ["ab", "cd"]]
  body:
    return [std.string.characters(text: text), std.string.lines(text: text)]
end fn uses.split_up

type uses.Point
  doc: "A point."
  record:
    x: Int
    y: Int
  where: none
end type uses.Point

fn uses.ends
  doc: "The first and the last item."
  in:
    xs: List<Int>
  out: List<Option<Int>>
  effects: none
  requires: none
  ensures: none
  examples:
    ends(xs: [1, 2, 3]) == [Some(1), Some(3)]
    ends(xs: std.list.empty<Int>()) == [None, None]
  body:
    return [std.list.first(list: xs), std.list.last(list: xs)]
end fn uses.ends

fn uses.reshaped
  doc: "The list cut, reversed, doubled and flattened."
  in:
    xs: List<Int>
  out: List<List<Int>>
  effects: none
  requires: none
  ensures: none
  examples:
    reshaped(xs: [1, 2, 3]) == [[1, 2], [3], [3, 2, 1], [1, 2, 3, 1, 2, 3], [1, 2, 3, 4]]
  body:
    return [std.list.take(list: xs, count: 2), std.list.drop(list: xs, count: 2), std.list.reverse(list: xs), std.list.concat(left: xs, right: xs), std.list.flatten(lists: [xs, [4]])]
end fn uses.reshaped

fn uses.member
  doc: "Whether the point is one of two fixed points."
  in:
    point: Point
  out: Bool
  effects: none
  requires: none
  ensures: none
  examples:
    member(point: Point(x: 3, y: 4)) == true
    member(point: Point(x: 4, y: 3)) == false
  body:
    return std.list.contains(list: [Point(x: 1, y: 2), Point(x: 3, y: 4)], item: point)
end fn uses.member

fn uses.neighbours
  doc: "Each integer from low to high with its successor."
  in:
    low: Int
    high: Int
  out: List<List<Int>>
  effects: none
  requires: none
  ensures: none
  examples:
    neighbours(low: 1, high: 3) == [[1, 2], [2, 3]]
    neighbours(low: 1, high: 0) == std.list.empty<List<Int>>()
  body:
    return std.list.window(list: std.list.range(low: low, high: high), size: 2)
end fn uses.neighbours

fn uses.labels
  doc: "Two names with their numbers, then with their positions."
  in:
    names: List<String>
  out: List<String>
  effects: none
  requires: none
  ensures: none
  examples:
    labels(names: ["a", "b"]) == ["a1", "b2", "0a", "1b"]
  body:
    let numbered: List<String> = std.list.zip(left: names, right: [1, 2], with: fn(name: String, n: Int): String => std.string.concat(left: name, right: std.text.show(value: n)))
    let placed: List<String> = std.list.enumerate(list: names, with: fn(i: Int, name: String): String => std.string.concat(left: std.text.show(value: i), right: name))
    return std.list.concat(left: numbered, right: placed)
end fn uses.labels
`;

Deno.test("std: the new functions are accepted from alang, and their calls type-check", async () => {
  assertEquals(printProgram(parseProgram(PROGRAM)), PROGRAM);
  const out = new URL("../out/test/std/uses.ts", import.meta.url).pathname;
  const { built, examples } = await accept(PROGRAM, out);
  assertEquals(examples.filter((e) => !e.passed), []);
  const checked = await new Deno.Command(Deno.execPath(), { args: ["check", built.outPath], stderr: "piped" }).output();
  assert_(checked.success, new TextDecoder().decode(checked.stderr));
});

Deno.test("std.list: first, last, take, drop, reverse, concat, flatten", () => {
  const xs = [1, 2, 3];
  assertEquals([rt.std$list$first(xs), rt.std$list$first([])], [rt.Some(1), rt.None]);
  assertEquals([rt.std$list$last(xs), rt.std$list$last([])], [rt.Some(3), rt.None]);
  assertEquals([0, 2, 3, 9].map((n) => rt.std$list$take(xs, n)), [[], [1, 2], [1, 2, 3], [1, 2, 3]]);
  assertEquals([0, 2, 3, 9].map((n) => rt.std$list$drop(xs, n)), [[1, 2, 3], [3], [], []]);
  assertEquals(rt.std$list$take([], 1), []);
  assertEquals(trapOf(() => rt.std$list$take(xs, -1)), ["requires", "std.list.take", "count >= 0"]);
  assertEquals(trapOf(() => rt.std$list$drop(xs, -1)), ["requires", "std.list.drop", "count >= 0"]);
  assertEquals([rt.std$list$reverse(xs), rt.std$list$reverse([])], [[3, 2, 1], []]);
  // The argument stays as it was: lists are values.
  assertEquals(xs, [1, 2, 3]);
  assertEquals(rt.std$list$concat(xs, [4]), [1, 2, 3, 4]);
  assertEquals([rt.std$list$concat([], xs), rt.std$list$concat(xs, []), rt.std$list$concat([], [])], [xs, xs, []]);
  assertEquals(rt.std$list$flatten([[1], [], [2, 3]]), [1, 2, 3]);
  assertEquals([rt.std$list$flatten([]), rt.std$list$flatten([[], []])], [[], []]);
});

Deno.test("std.list: contains compares structurally; range includes both ends", () => {
  const points = [{ x: 1, y: 2 }, { x: 3, y: 4 }];
  assertEquals(rt.std$list$contains(points, { x: 3, y: 4 }), true);
  assertEquals(rt.std$list$contains(points, { x: 4, y: 3 }), false);
  assertEquals(rt.std$list$contains([rt.Some([1])], rt.Some([1])), true);
  assertEquals(rt.std$list$contains([], 1), false);
  assertEquals(rt.std$list$range(1, 3), [1, 2, 3]);
  assertEquals(rt.std$list$range(2, 2), [2]);
  assertEquals(rt.std$list$range(1, 0), []);
  assertEquals(rt.std$list$range(-1, 1), [-1, 0, 1]);
  assertEquals(Object.is(rt.std$list$range(-1, 0)[1], 0), true);
  // More items than an array holds: a trap, before any memory is taken.
  const max = Number.MAX_SAFE_INTEGER;
  assertEquals(trapOf(() => rt.std$list$range(0, 4_294_967_295)), ["overflow", "std.list.range", "0 to 4294967295"]);
  assertEquals(trapOf(() => rt.std$list$range(-max, max))[0], "overflow");
});

Deno.test("std.list: window gives every run of neighbours", () => {
  const xs = ["a", "b", "c"];
  assertEquals(rt.std$list$window(xs, 1), [["a"], ["b"], ["c"]]);
  assertEquals(rt.std$list$window(xs, 2), [["a", "b"], ["b", "c"]]);
  assertEquals(rt.std$list$window(xs, 3), [["a", "b", "c"]]);
  assertEquals(rt.std$list$window(xs, 4), []);
  assertEquals(rt.std$list$window([], 1), []);
  assertEquals(trapOf(() => rt.std$list$window(xs, 0)), ["requires", "std.list.window", "size >= 1"]);
});

Deno.test("std.list: zip and enumerate apply the function pair by pair", () => {
  assertEquals(rt.std$list$zip([1, 2], ["a", "b"], (n: number, s: string) => `${s}${n}`), ["a1", "b2"]);
  assertEquals(rt.std$list$zip([], [], (a: number, b: number) => a + b), []);
  assertEquals(trapOf(() => rt.std$list$zip([1, 2], [1], (a: number, b: number) => a + b)), [
    "requires",
    "std.list.zip",
    "std.list.length(list: left) == std.list.length(list: right)",
  ]);
  assertEquals(rt.std$list$enumerate(["a", "b"], (i: number, s: string) => `${i}${s}`), ["0a", "1b"]);
  assertEquals(rt.std$list$enumerate([], (i: number, s: string) => `${i}${s}`), []);
});
