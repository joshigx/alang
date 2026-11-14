// Fixtures of docs/plans/extern-fn.md (section 4), shared by the extern tests:
// alang programs with `extern fn` and the TypeScript modules they name.

// The two externs of spec 7.3, a pure function over them and a `main`.
export const TEXT = `extern fn text.decode
  doc: "The text with its percent-encoding undone, as JavaScript's decodeURIComponent does it; None if it is not valid percent-encoded UTF-8."
  in:
    text: String
  out: Option<String>
  effects: none
  requires: none
  ensures: none
  examples:
    decode(text: "caf%C3%A9") == Some("café")
    decode(text: "100%") == None
  target: "./text.ts#decode"
end extern fn text.decode

extern fn text.encode
  doc: "The text percent-encoded for a URL, as JavaScript's encodeURIComponent does it."
  in:
    text: String
  out: String
  effects: none
  requires: none
  ensures: none
  examples:
    encode(text: "a b&c") == "a%20b%26c"
    encode(text: "é") == "%C3%A9"
  target: "./text.ts#encode"
end extern fn text.encode

fn text.pair
  doc: "The key and the value, each percent-encoded, joined by an equals sign."
  in:
    key: String
    value: String
  out: String
  effects: none
  requires: none
  ensures: none
  examples:
    pair(key: "q", value: "café au lait") == "q=caf%C3%A9%20au%20lait"
  body:
    return std.string.join(parts: [encode(text: key), "=", encode(text: value)], separator: "")
end fn text.pair

fn text.main
  doc: "Prints the pair of q and the one argument."
  in: none
  out: Result<Unit, String>
  effects: env, console
  requires: none
  ensures: none
  examples: none
  body:
    let [value]: List<String> = std.env.args() else return Err("usage: text <value>")
    std.console.print_line(text: pair(key: "q", value: value))
    return Ok(Unit)
end fn text.main
`;

export const TEXT_TS = `export function encode(text: string): string {
  return encodeURIComponent(text);
}

export function decode(text: string): { tag: "Some"; value: string } | { tag: "None" } {
  try {
    return { tag: "Some", value: decodeURIComponent(text) };
  } catch {
    return { tag: "None" };
  }
}
`;

// An extern of module `b`, pure unless `effects` is given, with one example.
export function bExtern(name: string, params: string, out: string, example: string, effects = "none"): string {
  const inSection = params === "" ? "  in: none" : `  in:\n${params.split(", ").map((p) => `    ${p}`).join("\n")}`;
  return `extern fn b.${name}
  doc: "The value b.ts gives for ${name}."
${inSection}
  out: ${out}
  effects: ${effects}
  requires: none
  ensures: none
  examples:
    ${example}
  target: "./b.ts#${name}"
end extern fn b.${name}`;
}

export const B_TYPES = `type b.Branch
  doc: "A node's two subtrees."
  record:
    left: Tree
    right: Tree
  where: none
end type b.Branch

type b.Span
  doc: "A range of positions."
  record:
    start: Int
    stop: Int
  where: start <= stop
end type b.Span

type b.Tree
  doc: "A binary tree without values."
  variant:
    Leaf
    Node: Branch
  where: none
end type b.Tree`;

const BOTH = `fn b.both
  doc: "The items, then the items sorted."
  in:
    items: List<Int>
  out: List<Int>
  effects: none
  requires: none
  ensures: none
  examples:
    both(items: [3, 1, 2]) == [3, 1, 2, 1, 2, 3]
  body:
    let s: List<Int> = sorted(items: items)
    return std.list.concat(left: items, right: s)
end fn b.both`;

const ZERO_INVERSE = `fn b.zero_inverse
  doc: "One divided by the Float of zero."
  in: none
  out: Float
  effects: none
  requires: none
  ensures: none
  examples:
    zero_inverse() == 1.0 / 0.0
  body:
    return 1.0 / std.int.to_float(value: zero())
end fn b.zero_inverse`;

// Every boundary case of the plan's table (4, fixture B), definitions in
// alphabetical order; `leave` and `deep` are separate programs.
export const B = [
  BOTH,
  bExtern("counts", "words: List<String>", "Map<String, Int>", 'counts(words: ["b", "a", "b"]) == ["a": 1, "b": 2]'),
  bExtern("fails", "", "Int", "fails() == 1"),
  bExtern("half", "", "Int", "half() == 1"),
  bExtern("inf", "", "Float", "inf() == 1.0 / 0.0"),
  bExtern("later", "", "Int", "later() == 1"),
  bExtern("lone", "", "String", 'lone() == "a"'),
  bExtern("missing", "", "Option<Int>", "missing() == None"),
  bExtern("nan", "", "Float", "nan() == 0.0"),
  bExtern("nothing", "", "Unit", "nothing() == Unit"),
  bExtern("peek", "", "String", 'peek() == ""'),
  bExtern("sorted", "items: List<Int>", "List<Int>", "sorted(items: [3, 1, 2]) == [1, 2, 3]"),
  bExtern("span", "text: String", "Span", 'span(text: "abc") == Span(start: 0, stop: 3)'),
  bExtern("tree", "depth: Int", "Tree", "tree(depth: 1) == Node(Branch(left: Leaf, right: Leaf))"),
  bExtern("zero", "", "Int", "zero() == 0"),
  ZERO_INVERSE,
  B_TYPES,
].join("\n\n") + "\n";

export const B_TS = `export function counts(words: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of words) m.set(w, (m.get(w) ?? 0) + 1);
  return m;
}

export function fails(): number {
  throw new TypeError("bad input");
}

export function half(): number {
  return 1.5;
}

export function inf(): number {
  return Infinity;
}

export async function later(): Promise<number> {
  return await Promise.resolve(1);
}

export function lone(): string {
  return "a\\uD800";
}

export function missing(): null {
  return null;
}

export function nan(): number {
  return NaN;
}

export function nothing(): void {
}

export function peek(): string {
  return Deno.readTextFileSync("/etc/hostname");
}

export function sorted(items: number[]): number[] {
  return items.sort((a, b) => a - b);
}

export function span(text: string): { start: number; stop: number; extra: string } {
  return { start: text.length, stop: 0, extra: "x" };
}

type Tree = { tag: "Leaf" } | { tag: "Node"; value: { left: Tree; right: Tree } };
export function tree(depth: number): Tree {
  if (depth === 0) return { tag: "Leaf" };
  return { tag: "Node", value: { left: tree(depth - 1), right: tree(depth - 1) } };
}

export function zero(): number {
  return -0;
}

export function leave(): number {
  Deno.exit(3);
}

export function deep(): unknown {
  return [{ tag: "Node", value: { left: { tag: "Leaf" }, right: { tag: "Lef" } } }];
}
`;

// A program whose one extern ends the process (E0406 without a module named).
export const LEAVE = bExtern("leave", "", "Int", "leave() == 1") + "\n";

// The path to a wrong case, deep inside a list (4.3.3).
export const DEEP = [bExtern("deep", "", "List<Tree>", "deep() == [Leaf]"), B_TYPES].join("\n\n") + "\n";

// An effectful extern and a `main` that calls it.
export const FILES = `extern fn files.touch
  doc: "Creates an empty file at the path, or empties it."
  in:
    path: String
  out: Result<Unit, String>
  effects: fs.write
  requires: none
  ensures: none
  examples: none
  target: "./files.ts#touch"
end extern fn files.touch

fn files.main
  doc: "Touches made.txt and prints made."
  in: none
  out: Result<Unit, String>
  effects: fs.write, console
  requires: none
  ensures: none
  examples: none
  body:
    touch(path: "made.txt") else return Err(error)
    std.console.print_line(text: "made")
    return Ok(Unit)
end fn files.main
`;

export const FILES_TS = `export async function touch(path: string): Promise<{ tag: "Ok"; value: null }> {
  await Deno.writeTextFile(path, "");
  return { tag: "Ok", value: null };
}
`;

// Contracts around an extern, and an extern passed by name.
export const C = `extern fn c.halve
  doc: "Half of a number that is not negative, rounded down."
  in:
    n: Int
  out: Int
  effects: none
  requires: n >= 0
  ensures: result * 2 <= n
  examples:
    halve(n: 7) == 3
  target: "./c.ts#halve"
end extern fn c.halve

fn c.halves
  doc: "Half of each number, through halve passed by name."
  in:
    numbers: List<Int>
  out: List<Int>
  effects: none
  requires: none
  ensures: none
  examples:
    halves(numbers: [2, 5]) == [1, 2]
  body:
    return std.list.map(list: numbers, with: halve)
end fn c.halves
`;

// One example breaks `requires`, the other `ensures` (c.ts errs at 9).
export const C_BROKEN = C.replace("    halve(n: 7) == 3", "    halve(n: -1) == 0\n    halve(n: 9) == 4");

export const C_TS = `export function halve(n: number): number {
  return n === 9 ? 9 : Math.floor(n / 2);
}
`;

// Generic and std types across the boundary, and `show` of a returned record.
function gExtern(name: string, params: string[], out: string, example: string): string {
  const inSection = params.length === 0 ? "  in: none" : `  in:\n${params.map((p) => `    ${p}`).join("\n")}`;
  return `extern fn g.${name}
  doc: "The value g.ts gives for ${name}."
${inSection}
  out: ${out}
  effects: none
  requires: none
  ensures: none
  examples:
    ${example}
  target: "./g.ts#${name}"
end extern fn g.${name}`;
}

const NEST = `type g.Nest<T>
  doc: "An item and, maybe, a nest of lists of items: a type that grows at each level."
  record:
    item: T
    inner: Option<Nest<List<T>>>
  where: none
end type g.Nest`;

export const G = [
  `type g.Box<T>
  doc: "One value."
  record:
    value: T
  where: none
end type g.Box`,
  NEST,
  gExtern("box", ["n: Int"], "Box<Int>", "box(n: 2) == Box(value: 4)"),
  gExtern("cut", ["text: String"], "std.string.Cut", 'cut(text: "a") == std.string.Cut(before: "a", after: "")'),
  gExtern("nest", [], "Nest<Int>", "nest() == Nest(item: 1, inner: Some(Nest(item: [2, 3], inner: None)))"),
  gExtern("order", ["a: Int"], "Order", "order(a: -1) == Less"),
  gExtern("parse", ["text: String"], "Result<Int, String>", 'parse(text: "") == Err("empty")'),
  gExtern(
    "sum",
    ["items: List<Int>", "counts: Map<String, Int>", "box: Box<Int>"],
    "Int",
    'sum(items: [1], counts: ["a": 5], box: Box(value: 1)) == 9',
  ),
  `fn g.copies
  doc: "The arguments of sum, after sum changed its copies."
  in:
    n: Int
  out: List<Int>
  effects: none
  requires: none
  ensures: none
  examples:
    copies(n: 1) == [1, 1, 5]
  body:
    let items: List<Int> = [n]
    let counts: Map<String, Int> = ["a": 5]
    let held: Box<Int> = Box(value: n)
    let total: Int = sum(items: items, counts: counts, box: held)
    return [std.list.length(list: items), std.map.size(map: counts), total - 4]
end fn g.copies`,
  `fn g.shown
  doc: "A box and a cut from g.ts, as text."
  in:
    n: Int
  out: String
  effects: none
  requires: none
  ensures: none
  examples:
    shown(n: 1) == "Box(value: 2) Cut(before: \\"x\\", after: \\"\\")"
  body:
    return std.string.join(parts: [std.text.show(value: box(n: n)), std.text.show(value: cut(text: "x"))], separator: " ")
end fn g.shown`,
].join("\n\n") + "\n";

export const G_DEEP = [NEST, gExtern("bad_nest", [], "Nest<Int>", "bad_nest() == Nest(item: 1, inner: None)")].join(
  "\n\n",
) + "\n";

export const G_TS = `export function box(n: number): unknown {
  return { value: n * 2, extra: true };
}

export function cut(text: string): unknown {
  return { before: text, after: "" };
}

export function nest(): unknown {
  return { item: 1, inner: { tag: "Some", value: { item: [2, 3], inner: { tag: "None" } } } };
}

export function bad_nest(): unknown {
  return { item: 1, inner: { tag: "Some", value: { item: [2, "x"], inner: { tag: "None" } } } };
}

export function order(a: number): unknown {
  return a < 0 ? { tag: "Less" } : { tag: "Greater" };
}

export function parse(text: string): unknown {
  return text === "" ? { tag: "Err", value: "empty" } : { tag: "Ok", value: text.length };
}

// Changes its copies; the caller's values stay as they were.
export function sum(items: number[], counts: Map<string, number>, box: { value: number }): number {
  items.push(99);
  counts.set("b", 1);
  box.value = 100;
  return items.length + counts.size + (counts.get("a") ?? 0);
}
`;
