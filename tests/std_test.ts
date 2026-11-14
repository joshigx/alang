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

Deno.test("std.fs: describe gives each error as a short text", () => {
  const cases: [rt.std$fs$Error, string][] = [
    [{ tag: "NotFound" }, "no such file or directory"],
    [{ tag: "PermissionDenied" }, "permission denied"],
    [{ tag: "IsADirectory" }, "is a directory"],
    [{ tag: "AlreadyExists" }, "already exists"],
    [{ tag: "Other", value: "Disk quota exceeded (os error 122)" }, "Disk quota exceeded (os error 122)"],
  ];
  for (const [error, text] of cases) assertEquals(rt.std$fs$describe(error), text);
});

Deno.test("std.http: describe gives each error of send as a short text", () => {
  const cases: [rt.std$http$SendError, string][] = [
    [{ tag: "InvalidUrl" }, "invalid URL"],
    [{ tag: "Unreachable" }, "cannot reach the server"],
    [{ tag: "TimedOut" }, "timed out"],
    [{ tag: "Failed", value: "fetch failed: other side closed" }, "fetch failed: other side closed"],
  ];
  for (const [error, text] of cases) assertEquals(rt.std$http$describe(error), text);
});

Deno.test("std.http: describe_serve_error gives each error of serve as a short text", () => {
  const cases: [rt.std$http$ServeError, string][] = [
    [{ tag: "AddressInUse" }, "address already in use"],
    [{ tag: "PermissionDenied" }, "permission denied"],
    [{ tag: "Other", value: "Invalid argument (os error 22)" }, "Invalid argument (os error 22)"],
  ];
  for (const [error, text] of cases) assertEquals(rt.std$http$describe_serve_error(error), text);
});

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

// ---- std.map ----

// A node of the tree, as the test inspects it.
type Node = { key: unknown; value: unknown; left: Node | null; right: Node | null; height: number };

// Order by Unicode scalar values, computed here without the runtime.
function scalarOrder(a: string, b: string): number {
  const xs = Array.from(a, (c) => c.codePointAt(0)!);
  const ys = Array.from(b, (c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) if (xs[i] !== ys[i]) return xs[i] - ys[i];
  return xs.length - ys.length;
}

// Balance, order and the stored heights of every node; returns the height.
function checkTree(n: Node | null, order: (a: unknown, b: unknown) => number, low?: unknown, high?: unknown): number {
  if (n === null) return 0;
  if (low !== undefined) assert_(order(low, n.key) < 0, `order at ${String(n.key)}`);
  if (high !== undefined) assert_(order(n.key, high) < 0, `order at ${String(n.key)}`);
  const hl = checkTree(n.left, order, low, n.key);
  const hr = checkTree(n.right, order, n.key, high);
  assert_(Math.abs(hl - hr) <= 1, `balance at ${String(n.key)}`);
  assertEquals(n.height, Math.max(hl, hr) + 1, `height at ${String(n.key)}`);
  return n.height;
}

// A seeded linear congruential generator, so that every run is the same.
function lcg(seed: number): (below: number) => number {
  let state = seed;
  return (below) => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state % below;
  };
}

function againstReference<K>(keys: readonly K[], order: (a: K, b: K) => number, seed: number): void {
  const random = lcg(seed);
  let m = rt.std$map$empty<K, number>();
  const reference = new Map<K, number>();
  const snapshots: [rt.SortedMap<K, number>, [K, number][]][] = [];
  for (let step = 1; step <= 3000; step++) {
    const key = keys[random(keys.length)];
    if (random(3) === 0) {
      m = rt.std$map$remove(m, key);
      reference.delete(key);
    } else {
      m = rt.std$map$insert(m, key, step);
      reference.set(key, step);
    }
    const expected = [...reference.entries()].sort(([a], [b]) => order(a, b));
    assertEquals(rt.std$map$size(m), reference.size);
    assertEquals(rt.std$map$keys(m), expected.map(([k]) => k));
    const probe = keys[random(keys.length)];
    assertEquals(rt.std$map$get(m, probe), reference.has(probe) ? rt.Some(reference.get(probe)!) : rt.None);
    if (step % 100 === 0) checkTree(m.root as Node | null, order as (a: unknown, b: unknown) => number);
    if (step % 500 === 0) snapshots.push([m, expected]);
  }
  // Earlier maps are values: later inserts and removes left them unchanged.
  for (const [snapshot, entries] of snapshots) assertEquals(rt.map_entries(snapshot), entries);
}

Deno.test("std.map: the tree agrees with a sorted reference and stays balanced", () => {
  againstReference(rt.std$list$range(0, 199), (a, b) => a - b, 7);
  const alphabet = ["a", "b", "B", "é", "😀", "\u{FFFF}", "z"];
  const generated = alphabet.flatMap((x) => ["", ...alphabet].map((y) => x + y));
  againstReference(["a", "B", "é", "😀", "\u{FFFF}", "", ...generated], scalarOrder, 11);
});

const counts = (entries: [string, number][]) =>
  entries.reduce((m, [k, v]) => rt.std$map$insert(m, k, v), rt.std$map$empty<string, number>());

Deno.test("std.map: insert, get, remove, contains, size, keys, values, to_list, from_list", () => {
  const m = counts([["b", 2], ["a", 1], ["c", 3]]);
  // Replacing a key keeps the size; the old map stays as it was.
  const replaced = rt.std$map$insert(m, "a", 10);
  assertEquals([rt.std$map$size(replaced), rt.std$map$get(replaced, "a"), rt.std$map$get(m, "a")], [
    3,
    rt.Some(10),
    rt.Some(1),
  ]);
  assertEquals(rt.std$map$get(m, "d"), rt.None);
  // A missing key gives the same map back.
  assert_(rt.std$map$remove(m, "d") === m);
  const removed = rt.std$map$remove(m, "b");
  assertEquals([rt.std$map$size(removed), rt.std$map$keys(removed), rt.std$map$size(m)], [2, ["a", "c"], 3]);
  assertEquals([rt.std$map$contains(m, "c"), rt.std$map$contains(removed, "b")], [true, false]);
  assertEquals([rt.std$map$size(rt.std$map$empty()), rt.std$map$keys(rt.std$map$empty())], [0, []]);
  assertEquals([rt.std$map$keys(m), rt.std$map$values(m)], [["a", "b", "c"], [1, 2, 3]]);
  assertEquals(rt.std$map$to_list(m, (k: string, v: number) => `${k}${v}`), ["a1", "b2", "c3"]);
  // Int keys by value, String keys by scalar values: U+FFFF before 😀,
  // which UTF-16 order would put first.
  const ints = rt.std$map$from_list([10, -1, 2], (n: number) => n, (n: number) => n * 2);
  assertEquals([rt.std$map$keys(ints), rt.std$map$values(ints)], [[-1, 2, 10], [-2, 4, 20]]);
  assertEquals(rt.std$map$keys(counts([["😀", 1], ["\u{FFFF}", 2], ["", 3]])), ["", "\u{FFFF}", "😀"]);
  const words = rt.std$map$from_list(["bb", "a"], (w: string) => w, (w: string) => w.length);
  assertEquals([rt.std$map$size(words), rt.map_entries(words)], [2, [["a", 1], ["bb", 2]]]);
  assertEquals(rt.std$map$size(rt.std$map$from_list([], (n: number) => n, (n: number) => n)), 0);
  assertEquals(trapOf(() => rt.std$map$from_list(["a", "b", "a"], (w: string) => w, (w: string) => w)), [
    "key",
    "std.map.from_list",
    '"a"',
  ]);
  const trap = assertThrows(() => rt.std$map$from_list([1, 1], (n: number) => n, (n: number) => n), rt.Trap);
  assertEquals(trap.message, "The key 1 appears twice in the list given to std.map.from_list.");
});

Deno.test("std.map: equal maps compare and show alike, in key order", () => {
  const forward = counts([["a", 1], ["b", 2], ["c", 3], ["d", 4]]);
  const backward = counts([["d", 4], ["c", 3], ["b", 2], ["a", 1]]);
  // Different trees, the same value.
  assert_(JSON.stringify(forward.root) !== JSON.stringify(backward.root));
  assert_(rt.eq(forward, backward));
  assert_(!rt.eq(forward, rt.std$map$insert(backward, "a", 0)));
  assert_(!rt.eq(forward, rt.std$map$remove(backward, "a")));
  assert_(!rt.eq(forward, [1]) && !rt.eq(rt.std$map$empty(), {}));
  assert_(rt.eq(rt.Some(rt.std$map$empty()), rt.Some(rt.std$map$empty())));
  assertEquals(rt.std$text$show(counts([["b", 2], ["a", 1]])), '["a": 1, "b": 2]');
  assertEquals(rt.std$text$show(rt.std$map$empty()), "[:]");
  const nested = rt.std$map$insert(rt.std$map$empty<string, readonly number[]>(), "a", [1]);
  assertEquals(rt.std$text$show([nested]), '[["a": [1]]]');
  assertEquals(rt.std$text$show(rt.std$map$insert(rt.std$map$empty<number, string>(), -1, "x")), '[-1: "x"]');
});

// One alang program whose examples call every function added with maps,
// accepted and then held against the runtime's TypeScript, as PROGRAM is.
const MAPS_PROGRAM = `fn maps.bump
  doc: "The map with the count of the word raised by one."
  in:
    seen: Map<String, Int>
    word: String
  out: Map<String, Int>
  effects: none
  requires: none
  ensures: none
  examples:
    bump(seen: std.map.empty<String, Int>(), word: "a") == std.map.insert(map: std.map.empty<String, Int>(), key: "a", value: 1)
  body:
    let count: Int = match std.map.get(map: seen, key: word)
      case Some(n) then
        n
      case None then
        0
    end match
    return std.map.insert(map: seen, key: word, value: count + 1)
end fn maps.bump

fn maps.counts
  doc: "How often each word occurs."
  in:
    words: List<String>
  out: Map<String, Int>
  effects: none
  requires: none
  ensures: none
  examples:
    counts(words: ["b", "a", "b"]) == std.map.insert(map: std.map.insert(map: std.map.empty<String, Int>(), key: "a", value: 1), key: "b", value: 2)
    counts(words: std.list.empty<String>()) == std.map.empty<String, Int>()
  body:
    return std.list.fold(list: words, initial: std.map.empty<String, Int>(), with: bump)
end fn maps.counts

fn maps.listed
  doc: "The words in key order, their counts, and both as rows."
  in:
    words: List<String>
  out: List<List<String>>
  effects: none
  requires: none
  ensures: none
  examples:
    listed(words: ["b", "a", "b"]) == [["a", "b"], ["1", "2"], ["a=1", "b=2"]]
  body:
    let seen: Map<String, Int> = counts(words: words)
    let numbers: List<String> = std.list.map(list: std.map.values(map: seen), with: fn(n: Int): String => std.text.show(value: n))
    let rows: List<String> = std.map.to_list(map: seen, with: fn(word: String, n: Int): String => std.string.join(parts: [word, std.text.show(value: n)], separator: "="))
    return [std.map.keys(map: seen), numbers, rows]
end fn maps.listed

fn maps.facts
  doc: "Whether the word was seen and how many words differ, before and after removing it."
  in:
    words: List<String>
    word: String
  out: List<Int>
  effects: none
  requires: none
  ensures: none
  examples:
    facts(words: ["b", "a", "b"], word: "b") == [1, 2, 0, 1]
    facts(words: ["a"], word: "c") == [0, 1, 0, 1]
  body:
    let seen: Map<String, Int> = counts(words: words)
    let rest: Map<String, Int> = std.map.remove(map: seen, key: word)
    let before: Int = if std.map.contains(map: seen, key: word) then
      1
    else
      0
    end if
    let after: Int = if std.map.contains(map: rest, key: word) then
      1
    else
      0
    end if
    return [before, std.map.size(map: seen), after, std.map.size(map: rest)]
end fn maps.facts

fn maps.by_length
  doc: "The words by their length."
  in:
    words: List<String>
  out: Map<Int, String>
  effects: none
  requires: none
  ensures: none
  examples:
    by_length(words: ["abc", "d"]) == std.map.insert(map: std.map.insert(map: std.map.empty<Int, String>(), key: 1, value: "d"), key: 3, value: "abc")
  body:
    return std.map.from_list(list: words, key: fn(word: String): Int => std.string.length(text: word), value: fn(word: String): String => word)
end fn maps.by_length

fn maps.tally
  doc: "How often each word occurs, counted in a fold with std.option.with_default."
  in:
    words: List<String>
  out: Map<String, Int>
  effects: none
  requires: none
  ensures: none
  examples:
    tally(words: ["b", "a", "b"]) == ["a": 1, "b": 2]
  body:
    return std.list.fold(list: words, initial: std.map.empty<String, Int>(), with: fn(seen: Map<String, Int>, word: String): Map<String, Int> => std.map.insert(map: seen, key: word, value: std.option.with_default(option: std.map.get(map: seen, key: word), default: 0) + 1))
end fn maps.tally

fn maps.doubled
  doc: "The double of the count of the word, if it was seen."
  in:
    words: List<String>
    word: String
  out: Option<Int>
  effects: none
  requires: none
  ensures: none
  examples:
    doubled(words: ["a", "a"], word: "a") == Some(4)
    doubled(words: ["a"], word: "b") == None
  body:
    return std.option.map(option: std.map.get(map: tally(words: words), key: word), with: fn(n: Int): Int => n * 2)
end fn maps.doubled

type maps.Row
  doc: "A word and its count."
  record:
    word: String
    count: Int
  where: none
end type maps.Row

fn maps.ranked
  doc: "The rows by count, most first, then by word."
  in:
    rows: List<Row>
  out: List<String>
  effects: none
  requires: none
  ensures: none
  examples:
    ranked(rows: [Row(word: "b", count: 1), Row(word: "c", count: 2), Row(word: "a", count: 1)]) == ["c", "a", "b"]
  body:
    let sorted: List<Row> = std.list.sort(list: rows, by: fn(x: Row, y: Row): Order => std.order.then_by(first: std.int.compare(left: y.count, right: x.count), second: std.string.compare(left: x.word, right: y.word)))
    return std.list.map(list: sorted, with: fn(row: Row): String => row.word)
end fn maps.ranked

fn maps.numbers
  doc: "Facts about the numbers among the texts."
  in:
    texts: List<String>
  out: List<List<Int>>
  effects: none
  requires: none
  ensures: none
  examples:
    numbers(texts: ["1", "x", "2", "30"]) == [[1, 2, 30], [1], [2, 30], [1, 1, 30]]
  body:
    let all: List<Int> = std.list.filter_map(list: texts, with: fn(text: String): Option<Int> => std.int.parse(text: text))
    let small: List<Int> = std.list.take_while(list: all, with: fn(n: Int): Bool => n < 2)
    let rest: List<Int> = std.list.drop_while(list: all, with: fn(n: Int): Bool => n < 2)
    let any: Int = if std.list.any(list: all, with: fn(n: Int): Bool => n > 9) then
      1
    else
      0
    end if
    let every: Int = if std.list.all(list: all, with: fn(n: Int): Bool => n > 0) then
      1
    else
      0
    end if
    let large: Int = std.option.with_default(option: std.list.find(list: all, with: fn(n: Int): Bool => n > 9), default: 0)
    return [all, small, rest, [any, every, large]]
end fn maps.numbers

fn maps.texts
  doc: "The word repeated, padded on both sides, stripped of punctuation, and through its code points."
  in:
    word: String
  out: List<String>
  effects: none
  requires: none
  ensures: none
  examples:
    texts(word: "\\"ab!\\"") == ["\\"ab!\\"\\"ab!\\"", "  \\"ab!\\"", "\\"ab!\\"..", "ab", "\\"ab!\\""]
  body:
    let codes: List<Int> = std.string.code_points(text: word)
    return [std.string.repeat(text: word, count: 2), std.string.pad_left(text: word, width: 7, fill: " "), std.string.pad_right(text: word, width: 7, fill: "."), std.string.trim_characters(text: word, characters: "\\"!"), std.string.from_code_points(code_points: codes)]
end fn maps.texts

fn maps.codes
  doc: "The character codes of the text."
  in:
    text: String
  out: List<Int>
  effects: none
  requires: none
  ensures: none
  examples:
    codes(text: "a😀") == [97, 128_512]
  body:
    return std.string.code_points(text: text)
end fn maps.codes

fn maps.measures
  doc: "The number read from the text, rounded in three ways and formatted."
  in:
    text: String
  out: Option<List<String>>
  effects: none
  requires: none
  ensures: none
  examples:
    measures(text: "-2.5") == Some(["-3", "-2", "-2", "-2.50", "2.5", "Less"])
    measures(text: "1e3") == None
  body:
    let value: Float = std.float.parse(text: text) else return None
    let ints: List<Int> = [std.float.round(value: value), std.float.ceil(value: value), std.float.trunc(value: value)]
    let shown: List<String> = std.list.map(list: ints, with: fn(n: Int): String => std.text.show(value: n))
    let size: Float = std.float.max(left: std.float.abs(value: value), right: std.float.min(left: value, right: 0.0))
    let order: String = std.text.show(value: std.float.compare(left: value, right: std.float.sqrt(value: 4.0)))
    return Some(std.list.concat(left: shown, right: [std.float.to_fixed(value: value, decimals: 2), std.float.to_fixed(value: size, decimals: 1), order]))
end fn maps.measures
`;

Deno.test("std: the map functions are accepted from alang, and their calls type-check", async () => {
  assertEquals(printProgram(parseProgram(MAPS_PROGRAM)), MAPS_PROGRAM);
  const out = new URL("../out/test/std/maps.ts", import.meta.url).pathname;
  const { built, examples } = await accept(MAPS_PROGRAM, out);
  assertEquals(examples.filter((e) => !e.passed), []);
  assertEquals(examples.length, 16);
  const checked = await new Deno.Command(Deno.execPath(), { args: ["check", built.outPath], stderr: "piped" }).output();
  assert_(checked.success, new TextDecoder().decode(checked.stderr));
});

// ---- lists, options and order ----

Deno.test("std.list: any, all, find, filter_map, take_while, drop_while", () => {
  const even = (n: number) => n % 2 === 0;
  const cases: [number[], boolean, boolean, rt.Option<number>, number[], number[]][] = [
    // list, any, all, find, take_while, drop_while
    [[], false, true, rt.None, [], []],
    [[1, 3], false, false, rt.None, [], [1, 3]],
    [[2, 4], true, true, rt.Some(2), [2, 4], []],
    [[2, 3, 4], true, false, rt.Some(2), [2], [3, 4]],
    [[1, 2, 3], true, false, rt.Some(2), [], [1, 2, 3]],
  ];
  for (const [xs, any, all, find, taken, dropped] of cases) {
    assertEquals(
      [
        rt.std$list$any(xs, even),
        rt.std$list$all(xs, even),
        rt.std$list$find(xs, even),
        rt.std$list$take_while(xs, even),
        rt.std$list$drop_while(xs, even),
      ],
      [any, all, find, taken, dropped],
      JSON.stringify(xs),
    );
  }
  const half = (n: number) => (even(n) ? rt.Some(n / 2) : rt.None);
  assertEquals([[], [1, 3], [2, 4], [1, 2, 3, 4]].map((xs) => rt.std$list$filter_map(xs, half)), [[], [], [1, 2], [
    1,
    2,
  ]]);
  // Each stops at the item that decides: a function that would trap later is never called there.
  const upTo = (limit: number, test: (n: number) => boolean) => (n: number) => {
    if (n > limit) throw new Error(`called on ${n}`);
    return test(n);
  };
  assertEquals(rt.std$list$any([1, 2, 3], upTo(2, even)), true);
  assertEquals(rt.std$list$all([2, 3, 4], upTo(3, even)), false);
  assertEquals(rt.std$list$find([1, 2, 3], upTo(2, even)), rt.Some(2));
  assertEquals(rt.std$list$take_while([2, 3, 4], upTo(3, even)), [2]);
  assertEquals(rt.std$list$drop_while([2, 3, 4], upTo(3, even)), [3, 4]);
});

Deno.test("std.option and std.order: with_default, map, then_by", () => {
  assertEquals([rt.std$option$with_default(rt.Some(1), 0), rt.std$option$with_default(rt.None, 0)], [1, 0]);
  assertEquals(rt.std$option$map(rt.Some(2), (n: number) => `${n}`), rt.Some("2"));
  assertEquals(rt.std$option$map(rt.None, () => assert_(false, "called on None")), rt.None);
  const orders = [rt.Less, rt.Equal, rt.Greater];
  for (const first of orders) {
    for (const second of orders) {
      assertEquals(rt.std$order$then_by(first, second), first.tag === "Equal" ? second : first);
    }
  }
});

// ---- text ----

Deno.test("std.string: repeat, pad_left and pad_right", () => {
  assertEquals([rt.std$string$repeat("ab", 0), rt.std$string$repeat("ab", 3), rt.std$string$repeat("", 5)], [
    "",
    "ababab",
    "",
  ]);
  assertEquals(trapOf(() => rt.std$string$repeat("ab", -1)), ["requires", "std.string.repeat", "count >= 0"]);
  // Widths below, at and above the length; a negative width changes nothing either.
  assertEquals([1, 2, 5, -3].map((w) => rt.std$string$pad_left("ab", w, " ")), ["ab", "ab", "   ab", "ab"]);
  assertEquals([1, 2, 5].map((w) => rt.std$string$pad_right("ab", w, ".")), ["ab", "ab", "ab..."]);
  // Lengths and the fill are in Unicode scalar values.
  assertEquals(rt.std$string$pad_left("😀", 3, "0"), "00😀");
  assertEquals(rt.std$string$pad_right("a", 3, "😀"), "a😀😀");
  // The fill is one scalar value, checked even where nothing is added.
  const condition = "std.string.length(text: fill) == 1";
  for (const fill of ["ab", ""]) {
    assertEquals(trapOf(() => rt.std$string$pad_left("abc", 0, fill)), ["requires", "std.string.pad_left", condition]);
    assertEquals(trapOf(() => rt.std$string$pad_right("a", 5, fill)), ["requires", "std.string.pad_right", condition]);
  }
  const trap = assertThrows(() => rt.std$string$pad_left("a", 2, "ab"), rt.Trap);
  assertEquals(trap.message, `Precondition of std.string.pad_left violated: ${condition}`);
});

Deno.test("std.string: trim_characters, code_points and from_code_points", () => {
  assertEquals(rt.std$string$trim_characters('"hi!"', '"!'), "hi");
  assertEquals(rt.std$string$trim_characters("..a.b..", "."), "a.b");
  assertEquals(rt.std$string$trim_characters(" a ", ""), " a ");
  assertEquals(rt.std$string$trim_characters("!?!", "?!"), "");
  assertEquals(rt.std$string$trim_characters("😀a😀", "😀"), "a");
  assertEquals(rt.std$string$code_points("a😀"), [97, 128_512]);
  assertEquals(rt.std$string$code_points(""), []);
  assertEquals(rt.std$string$from_code_points([97, 128_512, 0, 1_114_111]), "a😀\u0000\u{10FFFF}");
  const text = "Grüße, 😀 \u{FFFF}";
  assertEquals(rt.std$string$from_code_points(rt.std$string$code_points(text)), text);
  for (const n of [-1, 1_114_112, 55_296, 57_343]) {
    assertEquals(trapOf(() => rt.std$string$from_code_points([97, n])), [
      "requires",
      "std.string.from_code_points",
      String(n),
    ]);
  }
  const trap = assertThrows(() => rt.std$string$from_code_points([56_000]), rt.Trap);
  assertEquals(
    trap.message,
    "Precondition of std.string.from_code_points violated: 56000 is not a Unicode scalar value.",
  );
  // A long list is built in chunks, not with one spread that overflows the stack.
  const many = Array(200_000).fill(128_512);
  assertEquals(rt.std$string$length(rt.std$string$from_code_points(many)), 200_000);
});

// ---- Float ----

Deno.test("std.float: compare, parse, abs, min, max, sqrt", () => {
  assertEquals([rt.std$float$compare(1, 2), rt.std$float$compare(2, 1), rt.std$float$compare(-0, 0)], [
    rt.Less,
    rt.Greater,
    rt.Equal,
  ]);
  assertEquals(["3", "-0.25", "007.5", "0.0"].map(rt.std$float$parse), [
    rt.Some(3),
    rt.Some(-0.25),
    rt.Some(7.5),
    rt.Some(0),
  ]);
  // "-0" is the Float -0.0, which is a value of its own (Int has no -0).
  assert_(Object.is((rt.std$float$parse("-0") as rt.Some<number>).value, -0));
  for (
    const text of ["+1", ".5", "1.", "1e3", " 1", "1 ", "", "-", "1.2.3", "0x1", "Infinity", "1" + "0".repeat(400)]
  ) {
    assertEquals(rt.std$float$parse(text), rt.None, JSON.stringify(text));
  }
  assertEquals([rt.std$float$abs(-2.5), rt.std$float$abs(2.5), rt.std$float$abs(-Infinity)], [2.5, 2.5, Infinity]);
  assert_(Object.is(rt.std$float$abs(-0), 0));
  assertEquals([rt.std$float$min(1.5, -2), rt.std$float$max(1.5, -2)], [-2, 1.5]);
  // On equal values the left one wins.
  assert_(Object.is(rt.std$float$min(-0, 0), -0) && Object.is(rt.std$float$max(0, -0), 0));
  assertEquals([rt.std$float$sqrt(6.25), rt.std$float$sqrt(0), rt.std$float$sqrt(Infinity)], [2.5, 0, Infinity]);
  assert_(Object.is(rt.std$float$sqrt(-0), -0));
  assertEquals(trapOf(() => rt.std$float$sqrt(-1)), ["requires", "std.float.sqrt", "value >= 0.0"]);
  assertEquals(trapOf(() => rt.std$float$sqrt(-Infinity))[0], "requires");
});

Deno.test("std.float: round halves away from zero; round, ceil and trunc trap outside the Int range", () => {
  assertEquals([2.5, -2.5, 2.4, -2.6, 0.5, 0.49999999999999994, 4_503_599_627_370_495.5].map(rt.std$float$round), [
    3,
    -3,
    2,
    -3,
    1,
    0,
    4_503_599_627_370_496,
  ]);
  assertEquals([2.1, -2.9, 3].map(rt.std$float$ceil), [3, -2, 3]);
  assertEquals([2.9, -2.9, -3].map(rt.std$float$trunc), [2, -2, -3]);
  // An Int is never -0 (S1).
  for (
    const zero of [rt.std$float$round(-0.4), rt.std$float$ceil(-0.5), rt.std$float$trunc(-0.9), rt.std$float$round(-0)]
  ) {
    assert_(Object.is(zero, 0));
  }
  for (
    const [name, fn] of [["round", rt.std$float$round], ["ceil", rt.std$float$ceil], [
      "trunc",
      rt.std$float$trunc,
    ]] as const
  ) {
    assertEquals(trapOf(() => fn(2 ** 53)), ["overflow", `std.float.${name}`, "9007199254740992"]);
    assertEquals(trapOf(() => fn(-Infinity)), ["overflow", `std.float.${name}`, "-Infinity"]);
    assertEquals(fn(2 ** 53 - 1), 2 ** 53 - 1);
  }
  const trap = assertThrows(() => rt.std$float$round(Infinity), rt.Trap);
  assertEquals(trap.message, "Float outside the Int range.");
});

Deno.test("std.float: to_fixed, without exponents and without a minus before zeros", () => {
  const cases: [number, number, string][] = [
    // Ties break on the exact binary value, away from zero: 1.005 is a little below.
    [1.005, 2, "1.00"],
    [0.125, 2, "0.13"],
    [2.5, 0, "3"],
    [-2.5, 0, "-3"],
    [-0.001, 2, "0.00"],
    [-0, 1, "0.0"],
    [1.5, 2, "1.50"],
    [-1.5, 0, "-2"],
    [12.345_6, 1, "12.3"],
    [0, 0, "0"],
    [1e21, 2, "1000000000000000000000.00"],
    [-1e21, 0, "-1000000000000000000000"],
    [999_999_999_999_999_900_000, 1, "999999999999999868928.0"],
    [Infinity, 2, "Infinity"],
    [-Infinity, 0, "-Infinity"],
  ];
  for (const [value, decimals, text] of cases) assertEquals(rt.std$float$to_fixed(value, decimals), text, `${value}`);
  assertEquals(rt.std$float$to_fixed(0.1, 100).length, 102);
  const condition = "0 <= decimals and decimals <= 100";
  assertEquals(trapOf(() => rt.std$float$to_fixed(1, -1)), ["requires", "std.float.to_fixed", condition]);
  assertEquals(trapOf(() => rt.std$float$to_fixed(1, 101)), ["requires", "std.float.to_fixed", condition]);
});
