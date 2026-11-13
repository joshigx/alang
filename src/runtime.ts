// The one runtime library shared by the checker and by generated programs.
// It must stay runtime-neutral: no Deno.*, no Node APIs, so generated code
// runs on Deno, Node.js and Bun alike.

// ---- built-in types ----

export type Unit = null;
export const Unit: Unit = null;

export type Some<T> = { readonly tag: "Some"; readonly value: T };
export type None = { readonly tag: "None" };
export type Option<T> = Some<T> | None;
export type Ok<T> = { readonly tag: "Ok"; readonly value: T };
export type Err<E> = { readonly tag: "Err"; readonly value: E };
export type Result<T, E> = Ok<T> | Err<E>;
export type Order = { readonly tag: "Less" } | { readonly tag: "Equal" } | { readonly tag: "Greater" };

export function Some<T>(value: T): Some<T> {
  return { tag: "Some", value };
}
export const None: None = { tag: "None" };
export function Ok<T>(value: T): Ok<T> {
  return { tag: "Ok", value };
}
export function Err<E>(value: E): Err<E> {
  return { tag: "Err", value };
}
export const Less = { tag: "Less" } as const;
export const Equal = { tag: "Equal" } as const;
export const Greater = { tag: "Greater" } as const;

// A Map is a persistent AVL tree ordered by its keys, which are Int or
// String (the checker's E0229). The order is an invariant of the value, so
// equal maps walk, show and compare alike, whatever order built them.
// `insert` and `remove` copy only the path to the key: O(log n). Data only,
// without methods, so that TypeScript treats `SortedMap<K, Some<number>>`
// as a `SortedMap<K, Option<number>>`; fields declared, not parameter
// properties, for Node.js's type stripping.

type MapNode<K, V> = {
  readonly key: K;
  readonly value: V;
  readonly left: MapNode<K, V> | null;
  readonly right: MapNode<K, V> | null;
  readonly height: number;
};

export class SortedMap<K, V> {
  readonly root: MapNode<K, V> | null;
  readonly size: number;
  constructor(root: MapNode<K, V> | null, size: number) {
    this.root = root;
    this.size = size;
  }
}

// Int keys by value, String keys by Unicode scalar values (`str_compare`),
// never with `<` on strings, which compares UTF-16 units.
function keyOrder(a: unknown, b: unknown): number {
  if (typeof a === "string") return str_compare(a, b as string);
  return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
}

function heightOf<K, V>(n: MapNode<K, V> | null): number {
  return n === null ? 0 : n.height;
}

function mapNode<K, V>(key: K, value: V, left: MapNode<K, V> | null, right: MapNode<K, V> | null): MapNode<K, V> {
  return { key, value, left, right, height: Math.max(heightOf(left), heightOf(right)) + 1 };
}

// A node whose subtrees differ in height by at most 2, rebalanced by a
// single or double rotation.
function balance<K, V>(key: K, value: V, left: MapNode<K, V> | null, right: MapNode<K, V> | null): MapNode<K, V> {
  const hl = heightOf(left);
  const hr = heightOf(right);
  if (hl > hr + 1) {
    const l = left!;
    if (heightOf(l.left) >= heightOf(l.right)) {
      return mapNode(l.key, l.value, l.left, mapNode(key, value, l.right, right));
    }
    const lr = l.right!;
    return mapNode(lr.key, lr.value, mapNode(l.key, l.value, l.left, lr.left), mapNode(key, value, lr.right, right));
  }
  if (hr > hl + 1) {
    const r = right!;
    if (heightOf(r.right) >= heightOf(r.left)) {
      return mapNode(r.key, r.value, mapNode(key, value, left, r.left), r.right);
    }
    const rl = r.left!;
    return mapNode(rl.key, rl.value, mapNode(key, value, left, rl.left), mapNode(r.key, r.value, rl.right, r.right));
  }
  return mapNode(key, value, left, right);
}

// The tree with `key` bound to `value`, and whether the key was there.
function put<K, V>(n: MapNode<K, V> | null, key: K, value: V): [MapNode<K, V>, boolean] {
  if (n === null) return [mapNode(key, value, null, null), false];
  const c = keyOrder(key, n.key);
  if (c === 0) return [mapNode(n.key, value, n.left, n.right), true];
  if (c < 0) {
    const [left, existed] = put(n.left, key, value);
    return [balance(n.key, n.value, left, n.right), existed];
  }
  const [right, existed] = put(n.right, key, value);
  return [balance(n.key, n.value, n.left, right), existed];
}

// The tree without `key`, and whether it was there; the same tree if not.
function del<K, V>(n: MapNode<K, V> | null, key: K): [MapNode<K, V> | null, boolean] {
  if (n === null) return [null, false];
  const c = keyOrder(key, n.key);
  if (c < 0) {
    const [left, removed] = del(n.left, key);
    return removed ? [balance(n.key, n.value, left, n.right), true] : [n, false];
  }
  if (c > 0) {
    const [right, removed] = del(n.right, key);
    return removed ? [balance(n.key, n.value, n.left, right), true] : [n, false];
  }
  if (n.left === null) return [n.right, true];
  if (n.right === null) return [n.left, true];
  // Two children: the smallest key of the right subtree takes the place.
  let min = n.right;
  while (min.left !== null) min = min.left;
  const [right] = del(n.right, min.key);
  return [balance(min.key, min.value, n.left, right), true];
}

function lookup<K, V>(m: SortedMap<K, V>, key: K): MapNode<K, V> | null {
  let n = m.root;
  while (n !== null) {
    const c = keyOrder(key, n.key);
    if (c === 0) return n;
    n = c < 0 ? n.left : n.right;
  }
  return null;
}

// A map literal, built entry by entry. A key that occurs twice traps; the
// checker reports two equal literal keys before (E0234), so this is a
// computed key.
export function map_literal<K, V>(entries: ReadonlyArray<readonly [K, V]>, definition: string): SortedMap<K, V> {
  let root: MapNode<K, V> | null = null;
  for (const [key, value] of entries) {
    const [next, existed]: [MapNode<K, V>, boolean] = put(root, key, value);
    if (existed) {
      const shown = std$text$show(key);
      trap("key", definition, shown, `The key ${shown} appears twice in a map literal.`);
    }
    root = next;
  }
  return new SortedMap(root, entries.length);
}

// The entries in key order, walked with an explicit stack.
export function map_entries<K, V>(m: SortedMap<K, V>): (readonly [K, V])[] {
  const entries: (readonly [K, V])[] = [];
  const stack: MapNode<K, V>[] = [];
  let n = m.root;
  while (n !== null || stack.length > 0) {
    while (n !== null) {
      stack.push(n);
      n = n.left;
    }
    const top = stack.pop()!;
    entries.push([top.key, top.value]);
    n = top.right;
  }
  return entries;
}

// ---- traps ----

// A trap ends the program with a diagnostic and cannot be caught by alang code.
// (No parameter properties: the file must run under plain type stripping, as
// Node.js does it.)
export class Trap extends Error {
  readonly kind: string;
  readonly definition: string | null;
  readonly at: string;
  constructor(kind: string, definition: string | null, at: string, message: string) {
    super(message);
    this.name = "Trap";
    this.kind = kind;
    this.definition = definition;
    this.at = at;
  }
}

export function trap(kind: string, definition: string | null, at: string, message: string): never {
  throw new Trap(kind, definition, at, message);
}

// ---- let ... else (rule 3.2) ----

export function isPresent<T>(r: Result<T, unknown> | Option<T>): r is Ok<T> | Some<T> {
  return r.tag === "Ok" || r.tag === "Some";
}

// ---- equality and order (rule 3.9) ----

// Equality of Int, Float, Bool, String and Unit.
export function same<T extends number | string | boolean | null>(a: T, b: T): boolean {
  return a === b;
}

export function eq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => eq(x, b[i]));
  }
  // Before the record branch: equal maps may differ in the shape of their trees.
  if (a instanceof SortedMap) {
    if (!(b instanceof SortedMap) || a.size !== b.size) return false;
    const ea = map_entries(a);
    const eb = map_entries(b);
    return ea.every(([k, v], i) => k === eb[i][0] && eq(v, eb[i][1]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    Object.hasOwn(b, k) && eq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
  );
}

// Strings order by Unicode scalar values, not by UTF-16 code units. Int and
// Float compare with the native operators in generated code.
export function str_compare(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done || y.done) return x.done && y.done ? 0 : x.done ? -1 : 1;
    const cx = x.value.codePointAt(0)!;
    const cy = y.value.codePointAt(0)!;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

export const str_lt = (a: string, b: string): boolean => str_compare(a, b) < 0;
export const str_le = (a: string, b: string): boolean => str_compare(a, b) <= 0;
export const str_gt = (a: string, b: string): boolean => str_compare(a, b) > 0;
export const str_ge = (a: string, b: string): boolean => str_compare(a, b) >= 0;

function toOrder(n: number): Order {
  return n < 0 ? Less : n > 0 ? Greater : Equal;
}

// ---- Int ----
// Integers from -(2^53 - 1) to 2^53 - 1; leaving the range traps. Generated
// code passes the full name of the definition the operation is written in,
// so that the trap names it.
//
// An Int is never -0 (JavaScript gives it for `0 * -1` and for
// `Math.trunc(-1 / 2)`), so that equal Ints are the same value everywhere,
// also after `std.int.to_float` (3.9). A Float keeps IEEE's -0.0.

function intZero(r: number): number {
  return r === 0 ? 0 : r;
}

function int(op: string, a: number, b: number, r: number, definition: string): number {
  if (!Number.isSafeInteger(r)) trap("overflow", definition, `${a} ${op} ${b}`, "Int overflow.");
  return intZero(r);
}

export const int_add = (a: number, b: number, definition: string): number => int("+", a, b, a + b, definition);
export const int_sub = (a: number, b: number, definition: string): number => int("-", a, b, a - b, definition);
export const int_mul = (a: number, b: number, definition: string): number => int("*", a, b, a * b, definition);

// Rounds toward zero.
export function int_div(a: number, b: number, definition: string): number {
  if (b === 0) trap("division", definition, `${a} / ${b}`, "Int division by zero.");
  return int("/", a, b, Math.trunc(a / b), definition);
}

// Has the sign of the dividend: -7 % 2 == -1.
export function int_rem(a: number, b: number, definition: string): number {
  if (b === 0) trap("division", definition, `${a} % ${b}`, "Int remainder by zero.");
  return int("%", a, b, a % b, definition);
}

// ---- Float ----
// IEEE 754 doubles without NaN: a NaN result traps. Infinities are values.

function float(op: string, a: number, b: number, r: number, definition: string): number {
  if (Number.isNaN(r)) trap("nan", definition, `${a} ${op} ${b}`, "Float operation produced NaN.");
  return r;
}

export const float_add = (a: number, b: number, definition: string): number => float("+", a, b, a + b, definition);
export const float_sub = (a: number, b: number, definition: string): number => float("-", a, b, a - b, definition);
export const float_mul = (a: number, b: number, definition: string): number => float("*", a, b, a * b, definition);
export const float_div = (a: number, b: number, definition: string): number => float("/", a, b, a / b, definition);
export const float_rem = (a: number, b: number, definition: string): number => float("%", a, b, a % b, definition);

// ---- examples ----

// An example `call == expected`, with both sides as separate thunks so that a
// failing example can report the value the call returned.
export interface Example {
  readonly definition: string;
  readonly text: string;
  readonly actual: () => unknown;
  readonly expected: () => unknown;
}

export interface TrapInfo {
  readonly kind: string;
  readonly definition: string | null;
  readonly at: string;
  readonly message: string;
}

export interface ExampleResult {
  readonly definition: string;
  readonly text: string;
  readonly passed: boolean;
  // The value of the call; undefined if the example trapped.
  readonly actual: unknown;
  readonly trap: TrapInfo | null;
}

// Recursion is the only way to repeat (3), so a missing base case ends in a
// stack overflow, which the host reports as a RangeError, not as a trap.
function isStackOverflow(e: unknown): boolean {
  return e instanceof RangeError && /call stack/i.test(e.message);
}

export function runExamples(examples: readonly Example[]): ExampleResult[] {
  return examples.map((ex) => {
    const result = (actual: unknown, passed: boolean, trap: TrapInfo | null): ExampleResult => ({
      definition: ex.definition,
      text: ex.text,
      passed,
      actual,
      trap,
    });
    try {
      const actual = ex.actual();
      return result(actual, eq(actual, ex.expected()), null);
    } catch (e) {
      if (e instanceof Trap) {
        return result(undefined, false, { kind: e.kind, definition: e.definition, at: e.at, message: e.message });
      }
      if (isStackOverflow(e)) {
        const message = "The call stack overflowed; a recursion does not reach its base case, or recurses too deep.";
        return result(undefined, false, { kind: "stack", definition: null, at: ex.text, message });
      }
      throw e;
    }
  });
}

// ---- std ----
// Named std$<module>$<name>, matching the mangled paths the emitter produces.

export function std$console$print_line(text: string): Unit {
  console.log(text);
  return Unit;
}

// ---- std.console input, std.env ----
// The program's input from the host: the console (stdin), its arguments and
// the environment. None of them needs a permission but the environment.

type InputHost = {
  Deno?: {
    readonly stdin: { readSync(buffer: Uint8Array): number | null };
    readonly args: readonly string[];
    readonly env: { get(name: string): string | undefined };
  };
  process?: {
    readonly argv: readonly string[];
    readonly env: Record<string, string | undefined>;
    getBuiltinModule(name: "node:fs"): { readSync(fd: number, buffer: Uint8Array): number };
  };
};

// What was read from the console but not returned yet; the runtime is the
// only reader of stdin.
let consolePending = new Uint8Array(0);
let consoleEnded = false;
const consoleText = new TextDecoder("utf-8", { ignoreBOM: true });

// Reads the next bytes of the console into `buffer`; 0 at the end. A console
// that cannot be read counts as ended.
function readConsole(buffer: Uint8Array): number {
  const host = globalThis as InputHost;
  try {
    if (host.Deno) return host.Deno.stdin.readSync(buffer) ?? 0;
    if (host.process) {
      const fs = host.process.getBuiltinModule("node:fs");
      for (;;) {
        try {
          return fs.readSync(0, buffer);
        } catch (e) {
          // A non-blocking stdin with nothing to read yet.
          if ((e as { code?: string }).code !== "EAGAIN") throw e;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
      }
    }
  } catch {
    // Closed or not readable: the end of the input.
  }
  return 0;
}

// A line ends at a line feed; a carriage return right before it goes too. A
// last line without a line break is a line; after it, every call is `None`.
// A line feed never occurs inside a UTF-8 sequence, so each line decodes on
// its own, invalid bytes as U+FFFD.
export function std$console$read_line(): Option<string> {
  for (;;) {
    const end = consolePending.indexOf(0x0a);
    if (end >= 0) {
      const cut = end > 0 && consolePending[end - 1] === 0x0d ? end - 1 : end;
      const line = consoleText.decode(consolePending.subarray(0, cut));
      consolePending = consolePending.slice(end + 1);
      return Some(line);
    }
    if (consoleEnded) {
      if (consolePending.length === 0) return None;
      const line = consoleText.decode(consolePending);
      consolePending = new Uint8Array(0);
      return Some(line);
    }
    const buffer = new Uint8Array(4096);
    const n = readConsole(buffer);
    if (n === 0) {
      consoleEnded = true;
    } else {
      const joined = new Uint8Array(consolePending.length + n);
      joined.set(consolePending);
      joined.set(buffer.subarray(0, n), consolePending.length);
      consolePending = joined;
    }
  }
}

// The words after the program's own name (after `--` in `alang run`).
export function std$env$args(): readonly string[] {
  const host = globalThis as InputHost;
  if (host.Deno) return [...host.Deno.args];
  if (host.process) return host.process.argv.slice(2);
  return trap("effect", "std.env.args", "", "This runtime has no program arguments.");
}

export function std$env$get(name: string): Option<string> {
  const host = globalThis as InputHost;
  if (host.Deno) {
    let value: string | undefined;
    try {
      value = host.Deno.env.get(name);
    } catch (e) {
      const err = e as { name?: string };
      // Refused for lack of the permission: more than `main` declares (2.5).
      if (err.name === "NotCapable") {
        return trap("effect", "std.env.get", name, "Reading environment variables needs the effect `env` on `main`.");
      }
      // A name no variable can have (empty, with `=` or NUL) is not set.
      if (err.name === "TypeError") return None;
      throw e;
    }
    return value === undefined ? None : Some(value);
  }
  if (host.process) {
    // Own properties only: `process.env.toString` is a function, not a variable.
    const env = host.process.env;
    return Object.hasOwn(env, name) ? Some(env[name] ?? "") : None;
  }
  return trap("effect", "std.env.get", name, "This runtime has no environment variables.");
}

// ---- std.fs ----
// Files are one of the places where the runtime touches the host; the
// network (std.http) and the program's input (std.env, std.console) are the
// others. Deno and Node.js (and Bun) are detected by their globals; the error
// codes are shared. Every operation is synchronous.

type DenoFs = {
  readTextFileSync(path: string): string;
  writeTextFileSync(path: string, text: string, options?: { append: boolean }): void;
  readDirSync(path: string): Iterable<{ readonly name: string }>;
  statSync(path: string): { readonly isDirectory: boolean };
  lstatSync(path: string): { readonly isSymlink: boolean };
  mkdirSync(path: string, options: { recursive: boolean }): void;
  removeSync(path: string): void;
};

type NodeFs = {
  readFileSync(path: string, encoding: "utf8"): string;
  writeFileSync(path: string, text: string): void;
  appendFileSync(path: string, text: string): void;
  readdirSync(path: string): string[];
  statSync(path: string): { isDirectory(): boolean };
  lstatSync(path: string): { isSymbolicLink(): boolean };
  mkdirSync(path: string, options: { recursive: boolean }): void;
  rmSync(path: string): void;
  rmdirSync(path: string): void;
};

type FsHost = { Deno?: DenoFs; process?: { getBuiltinModule(name: "node:fs"): NodeFs } };

export type std$fs$Error =
  | { readonly tag: "NotFound" }
  | { readonly tag: "PermissionDenied" }
  | { readonly tag: "IsADirectory" }
  | { readonly tag: "Other"; readonly value: string };

export type std$fs$Kind = { readonly tag: "File" } | { readonly tag: "Directory" };

const NEEDS = {
  "fs.read": "Reading files and directories needs the effect `fs.read` on `main`.",
  "fs.write": "Creating, changing and deleting files needs the effect `fs.write` on `main`.",
} as const;

// A link whose target is missing (a dangling link) names nothing, and the
// hosts disagree on it. Node.js reads it as ENOENT but writes through it,
// creating the target; Deno, without all permissions (as `alang run` starts
// programs), refuses to open it at all (ELOOP), and without the read
// permission cannot even look at it, so it can neither follow the link nor
// tell it from a loop. Hence one rule for both: reading, writing and
// appending through a dangling link are `NotFound`, as are `kind` and
// `list_directory`; `create_directory` is `Other`, as for a file in the way
// (`mkdir -p` says "File exists"); `remove` removes the link. A real loop is
// `Other`, except that a program with `fs.write` and without `fs.read` gets
// `NotFound` when writing on Deno, which cannot tell the two apart.

const codeOf = (e: unknown): string | undefined => (e as { code?: string } | null)?.code;

// Whether `path` goes through a dangling link: the deepest part of it that
// exists is a link that resolves to nothing. Null if that cannot be told
// (Deno without the read permission). Never throws.
function throughDanglingLink(path: string): boolean | null {
  const host = globalThis as FsHost;
  const node = host.Deno ? null : host.process?.getBuiltinModule("node:fs");
  const isLink = (p: string) => host.Deno ? host.Deno.lstatSync(p).isSymlink : node!.lstatSync(p).isSymbolicLink();
  const resolve = (p: string) => host.Deno ? host.Deno.statSync(p) : node!.statSync(p);
  if (!host.Deno && !node) return null;
  const parts = path.split("/");
  for (let n = parts.length; n > 0; n--) {
    const prefix = parts.slice(0, n).join("/");
    if (prefix === "") continue;
    let link: boolean;
    try {
      link = isLink(prefix);
    } catch (e) {
      if ((e as { name?: string }).name === "NotCapable") return null;
      if (codeOf(e) === "ENOENT") continue;
      return false;
    }
    if (!link) return false;
    try {
      resolve(prefix);
      return false;
    } catch (e) {
      return codeOf(e) === "ENOENT";
    }
  }
  return false;
}

function hostError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

// Before a write: a dangling link is not followed (see above).
function refuseDanglingLink(path: string): void {
  if (throughDanglingLink(path) === true) throw hostError("ENOENT", `The link ${path} leads to nothing.`);
}

// One file operation on whichever host runs the program, with the host's
// errors as std.fs.Error. A refusal for lack of the permission traps: the
// program does more than its `main` declares (2.5). A path Deno guards
// although the permission is there (`/proc`, `/sys`: "Requires all access")
// is refused by the system, as the OS would refuse it: an `Err`.
function onFiles<T>(
  name: string,
  effect: keyof typeof NEEDS,
  path: string,
  onDeno: (deno: DenoFs) => T,
  onNode: (fs: NodeFs) => T,
): Result<T, std$fs$Error> {
  const host = globalThis as FsHost;
  try {
    if (host.Deno) return Ok(onDeno(host.Deno));
    if (host.process) return Ok(onNode(host.process.getBuiltinModule("node:fs")));
  } catch (e) {
    const err = e as { name?: string; code?: string; message?: string };
    if (err.name === "NotCapable" && /\ball access\b/.test(String(err.message))) {
      return Err<std$fs$Error>({ tag: "PermissionDenied" });
    }
    if (err.name === "NotCapable" || err.code === "ERR_ACCESS_DENIED") return trap("effect", name, path, NEEDS[effect]);
    // Node.js reports ENOENT for an empty path; Deno refuses it before
    // asking the system, with a message of its own and no code.
    if (err.code === "ENOENT" || path === "") return Err<std$fs$Error>({ tag: "NotFound" });
    // Deno's answer for a dangling link; a real loop stays `Other`.
    if (err.code === "ELOOP" && throughDanglingLink(path) !== false) return Err<std$fs$Error>({ tag: "NotFound" });
    if (err.code === "EACCES" || err.code === "EPERM") return Err<std$fs$Error>({ tag: "PermissionDenied" });
    if (err.code === "EISDIR") return Err<std$fs$Error>({ tag: "IsADirectory" });
    return Err<std$fs$Error>({ tag: "Other", value: String(err.message ?? e) });
  }
  return trap("effect", name, path, "This runtime has no file system.");
}

export function std$fs$read_text(path: string): Result<string, std$fs$Error> {
  return onFiles(
    "std.fs.read_text",
    "fs.read",
    path,
    (deno) => deno.readTextFileSync(path),
    (fs) => fs.readFileSync(path, "utf8"),
  );
}

// Exactly the text's UTF-8 bytes: no line break added, no byte order mark.
// Links are followed, but not a dangling one.
export function std$fs$write_text(path: string, text: string): Result<Unit, std$fs$Error> {
  return onFiles("std.fs.write_text", "fs.write", path, (deno) => {
    refuseDanglingLink(path);
    deno.writeTextFileSync(path, text);
    return Unit;
  }, (fs) => {
    refuseDanglingLink(path);
    fs.writeFileSync(path, text);
    return Unit;
  });
}

export function std$fs$append_text(path: string, text: string): Result<Unit, std$fs$Error> {
  return onFiles("std.fs.append_text", "fs.write", path, (deno) => {
    refuseDanglingLink(path);
    deno.writeTextFileSync(path, text, { append: true });
    return Unit;
  }, (fs) => {
    refuseDanglingLink(path);
    fs.appendFileSync(path, text);
    return Unit;
  });
}

// Sorted, so that every host gives the same order (3.7); hidden entries
// included, `.` and `..` not.
export function std$fs$list_directory(path: string): Result<readonly string[], std$fs$Error> {
  return onFiles(
    "std.fs.list_directory",
    "fs.read",
    path,
    (deno) => [...deno.readDirSync(path)].map((e) => e.name).sort(str_compare),
    (fs) => fs.readdirSync(path).sort(str_compare),
  );
}

// Follows links: a link to a directory is a directory, a broken one is
// NotFound. Everything that is not a directory (a device too) is a file.
export function std$fs$kind(path: string): Result<std$fs$Kind, std$fs$Error> {
  const kind = (directory: boolean): std$fs$Kind => directory ? { tag: "Directory" } : { tag: "File" };
  return onFiles(
    "std.fs.kind",
    "fs.read",
    path,
    (deno) => kind(deno.statSync(path).isDirectory),
    (fs) => kind(fs.statSync(path).isDirectory()),
  );
}

// A dangling link at the path or on the way is in the way, as a file is:
// Deno says EEXIST, Node.js ENOENT.
export function std$fs$create_directory(path: string): Result<Unit, std$fs$Error> {
  return onFiles("std.fs.create_directory", "fs.write", path, (deno) => {
    deno.mkdirSync(path, { recursive: true });
    return Unit;
  }, (fs) => {
    try {
      fs.mkdirSync(path, { recursive: true });
    } catch (e) {
      if (codeOf(e) === "ENOENT" && path !== "" && throughDanglingLink(path)) {
        throw hostError("EEXIST", `A link that leads to nothing is in the way: ${path}`);
      }
      throw e;
    }
    return Unit;
  });
}

// A link is removed itself, not its target. Node.js's rmSync takes no
// directory without `recursive`, so an empty one goes through rmdirSync.
export function std$fs$remove(path: string): Result<Unit, std$fs$Error> {
  return onFiles("std.fs.remove", "fs.write", path, (deno) => {
    deno.removeSync(path);
    return Unit;
  }, (fs) => {
    try {
      fs.rmSync(path);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "ERR_FS_EISDIR" && code !== "EISDIR") throw e;
      fs.rmdirSync(path);
    }
    return Unit;
  });
}

// ---- std.http ----

export type std$http$Header = { readonly name: string; readonly value: string };
export function std$http$Header($fields: std$http$Header): std$http$Header {
  return $fields;
}

export type std$http$Request = {
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly headers: readonly std$http$Header[];
  readonly content: string;
};
export function std$http$Request($fields: std$http$Request): std$http$Request {
  return $fields;
}

export type std$http$Response = {
  readonly status: number;
  readonly headers: readonly std$http$Header[];
  readonly content: string;
};

// The `where` of std.http.Response in std.ts, as printed (a test compares them).
const RESPONSE_WHERE =
  '200 <= status and status <= 599 and (content == "" or (status != 204 and status != 205 and status != 304))';

function noContent(status: number): boolean {
  return status === 204 || status === 205 || status === 304;
}

export function std$http$Response($fields: std$http$Response): std$http$Response {
  const { status, content } = $fields;
  if (!(200 <= status && status <= 599 && (content === "" || !noContent(status)))) {
    trap("where", "std.http.Response", RESPONSE_WHERE, `Invariant of std.http.Response violated: ${RESPONSE_WHERE}`);
  }
  return $fields;
}

export type std$http$ServeError =
  | { readonly tag: "AddressInUse" }
  | { readonly tag: "PermissionDenied" }
  | { readonly tag: "Other"; readonly value: string };

// A function value with effects is async (see emit.ts), a pure one is not.
type Handler = (request: std$http$Request) => std$http$Response | Promise<std$http$Response>;

// What the host sees of a running server: `close` stops accepting requests,
// `closed` settles once the requests in progress are answered.
interface Listener {
  close(): void;
  readonly closed: Promise<void>;
}

// The alang response for a request; null if the handler trapped (the host
// answers 500 then). `fail` ends the server with an error of the host's own.
interface Answering {
  answer(request: std$http$Request): Promise<std$http$Response | null>;
  fail(error: unknown): void;
}

type Listen = (host: string, port: number, a: Answering) => Promise<Listener | std$http$ServeError>;

// Headers as the host sends them. Both hosts reject names that are not HTTP
// tokens and values with line breaks or characters above U+00FF; checking
// here gives one trap on every host instead of two different exceptions. A
// response without content-type gets the same one on every host.
function hostHeaders(response: std$http$Response): [string, string][] {
  const headers: [string, string][] = [];
  for (const { name, value } of response.headers) {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || !/^[\t\x20-\x7e\x80-\xff]*$/.test(value)) {
      trap(
        "http",
        "std.http.serve",
        `${name}: ${value}`,
        "A response header has a name that is not an HTTP token, or a value with a line break or a character above U+00FF.",
      );
    }
    headers.push([name, value]);
  }
  if (!headers.some(([name]) => name.toLowerCase() === "content-type") && response.content !== "") {
    headers.push(["content-type", "text/plain; charset=utf-8"]);
  }
  return headers;
}

function serveError(e: unknown): std$http$ServeError {
  const err = e as { name?: string; code?: string; message?: string };
  // Listening refused for lack of the permission: the program does more
  // than its `main` declares (2.5).
  if (err.name === "NotCapable") {
    return trap("effect", "std.http.serve", String(err.message), "Serving needs the effect `net` on `main`.");
  }
  if (err.code === "EADDRINUSE" || err.name === "AddrInUse") return { tag: "AddressInUse" };
  if (err.code === "EACCES" || err.name === "PermissionDenied") return { tag: "PermissionDenied" };
  return { tag: "Other", value: String(err.message ?? e) };
}

// ---- std.http on Deno ----

type DenoServer = { shutdown(): Promise<void>; readonly finished: Promise<void> };
type DenoHost = {
  serve(
    options: { hostname: string; port: number; onListen(): void; onError(error: unknown): Response },
    handler: (request: Request) => Promise<Response>,
  ): DenoServer;
};

const listenDeno = (deno: DenoHost): Listen => (host, port, a) => {
  let server: DenoServer;
  try {
    server = deno.serve({
      hostname: host,
      port,
      // The program decides what it prints.
      onListen() {},
      onError(error) {
        a.fail(error);
        return new Response(null, { status: 500 });
      },
    }, async (request) => {
      let received: std$http$Request;
      try {
        const url = new URL(request.url);
        received = {
          method: request.method,
          path: url.pathname,
          query: url.search.slice(1),
          headers: [...request.headers].map(([name, value]) => ({ name, value })),
          content: await request.text(),
        };
      } catch {
        // A request that cannot be read (the client went away while
        // sending) is the client's fault, not the program's: 400, and the
        // server goes on.
        return new Response(null, { status: 400 });
      }
      const answer = await a.answer(received);
      if (answer === null) return new Response(null, { status: 500 });
      try {
        // Empty content is no body, so Deno adds no content-type of its own.
        const content = answer.content === "" ? null : answer.content;
        return new Response(content, { status: answer.status, headers: hostHeaders(answer) });
      } catch (e) {
        a.fail(e);
        return new Response(null, { status: 500 });
      }
    });
  } catch (e) {
    return Promise.resolve(serveError(e));
  }
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void server.shutdown();
  };
  return Promise.resolve({ close, closed: server.finished });
};

// ---- std.http on Node.js ----

type NodeRequest = AsyncIterable<Uint8Array> & {
  readonly method?: string;
  readonly url?: string;
  readonly headersDistinct: Record<string, string[]>;
};
type NodeResponse = { writeHead(status: number, headers: string[]): void; end(content?: string): void };
type NodeServer = {
  listen(port: number, host: string, listening: () => void): void;
  once(event: "error", listener: (error: unknown) => void): void;
  off(event: "error", listener: (error: unknown) => void): void;
  close(closed: () => void): void;
  closeIdleConnections(): void;
};
type NodeHttp = { createServer(handler: (req: NodeRequest, res: NodeResponse) => void): NodeServer };

const listenNode = (http: NodeHttp): Listen => (host, port, a) => {
  let closing = false;
  const server = http.createServer(async (req, res) => {
    let received: std$http$Request;
    try {
      // Read like Deno does: the target appended to the origin, so `//x`
      // is a path, not a host.
      const target = req.url ?? "/";
      const url = new URL(target.startsWith("/") ? `http://localhost${target}` : target);
      let content = "";
      const decoder = new TextDecoder();
      for await (const chunk of req) content += decoder.decode(chunk, { stream: true });
      content += decoder.decode();
      received = {
        method: req.method ?? "GET",
        path: url.pathname,
        query: url.search.slice(1),
        headers: Object.entries(req.headersDistinct)
          .map(([name, values]) => ({ name, value: values.join(", ") }))
          .sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0)),
        content,
      };
    } catch {
      // A request that cannot be read (an odd target, the client went away
      // while sending) is the client's fault, not the program's: 400, and
      // the server goes on.
      res.writeHead(400, ["connection", "close"]);
      res.end();
      return;
    }
    try {
      const answer = await a.answer(received);
      if (answer === null) {
        res.writeHead(500, ["connection", "close"]);
        res.end();
        return;
      }
      const flat = hostHeaders(answer).flat();
      // Once closing, every answer ends its connection, so that close
      // finishes although clients keep connections alive.
      if (closing) flat.push("connection", "close");
      res.writeHead(answer.status, flat);
      res.end(answer.content === "" && noContent(answer.status) ? undefined : answer.content);
    } catch (e) {
      a.fail(e);
      res.writeHead(500, ["connection", "close"]);
      res.end();
    }
  });
  return new Promise((resolve) => {
    const refused = (error: unknown) => resolve(serveError(error));
    server.once("error", refused);
    try {
      server.listen(port, host, () => {
        server.off("error", refused);
        let close: (() => void) | null = null;
        const closed = new Promise<void>((done) => {
          close = () => {
            if (closing) return;
            closing = true;
            server.close(done);
            server.closeIdleConnections();
          };
        });
        resolve({ close: () => close!(), closed });
      });
    } catch (e) {
      // An invalid port throws before listening.
      resolve(serveError(e));
    }
  });
};

// ---- std.http.serve ----

type Signals = {
  Deno?: {
    addSignalListener(signal: string, listener: () => void): void;
    removeSignalListener(signal: string, listener: () => void): void;
  };
  process?: { on(signal: string, listener: () => void): void; off(signal: string, listener: () => void): void };
};

// Calls `stop` on SIGINT and SIGTERM until the returned function is called.
// A signal the platform does not know (SIGTERM on Windows) is skipped.
function onStopSignals(stop: () => void): () => void {
  const host = globalThis as Signals;
  const added: string[] = [];
  for (const signal of ["SIGINT", "SIGTERM"]) {
    try {
      if (host.Deno) host.Deno.addSignalListener(signal, stop);
      else host.process?.on(signal, stop);
      added.push(signal);
    } catch {
      // Not supported here.
    }
  }
  return () => {
    for (const signal of added.splice(0)) {
      if (host.Deno) host.Deno.removeSignalListener(signal, stop);
      else host.process?.off(signal, stop);
    }
  };
}

type HttpHost = {
  Deno?: DenoHost;
  process?: { getBuiltinModule(name: "node:http"): NodeHttp };
};

// Requests are answered one at a time, in the order they arrive: alang has no
// concurrency, so a handler never starts before the previous one returned.
// A trap in the handler (or in sending its response) ends the server: the
// request gets status 500, later ones are not handled, and the trap ends
// the program from where `serve` was called. `stop` is for tests only, since
// alang code cannot make an AbortSignal; programs end on SIGINT or SIGTERM.
export async function std$http$serve(
  host: string,
  port: number,
  handler: Handler,
  stop?: AbortSignal,
): Promise<Result<Unit, std$http$ServeError>> {
  const h = globalThis as HttpHost;
  const listen = h.Deno ? listenDeno(h.Deno) : h.process ? listenNode(h.process.getBuiltinModule("node:http")) : null;
  if (listen === null) return trap("effect", "std.http.serve", host, "This runtime has no network.");

  let failure: { error: unknown } | null = null;
  let listener: Listener | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const fail = (error: unknown) => {
    failure ??= { error };
    listener?.close();
  };
  const answering: Answering = {
    answer(request) {
      const turn = queue.then(async () => {
        if (failure !== null) return null;
        try {
          return await handler(request);
        } catch (e) {
          fail(e);
          return null;
        }
      });
      queue = turn;
      return turn;
    },
    fail,
  };

  const listening = await listen(host, port, answering);
  if (!("close" in listening)) return Err(listening);
  listener = listening;
  const close = () => listening.close();
  // After the first signal the listeners go, so a second one ends the
  // program at once if answering the requests in progress takes too long.
  const removeSignals = onStopSignals(() => {
    removeSignals();
    close();
  });
  stop?.addEventListener("abort", close);
  try {
    await listening.closed;
  } finally {
    removeSignals();
    stop?.removeEventListener("abort", close);
  }
  if (failure !== null) throw (failure as { error: unknown }).error;
  return Ok(Unit);
}

// ---- std.log, std.random, std.time ----

// The log is stderr on every host; the console (print_line) is stdout.
export function std$log$print_line(text: string): Unit {
  console.error(text);
  return Unit;
}

// Uniform over low..high, both included, as long as the count of values is
// an Int. Math.random is not for secrets, and says so in the doc.
export function std$random$int(low: number, high: number): number {
  if (low > high) {
    trap("requires", "std.random.int", "low <= high", "Precondition of std.random.int violated: low <= high");
  }
  const count = high - low + 1;
  if (!Number.isSafeInteger(count)) {
    trap("overflow", "std.random.int", `${low} to ${high}`, "More values from low to high than an Int can count.");
  }
  return low + Math.min(count - 1, Math.floor(Math.random() * count));
}

export function std$time$now_milliseconds(): number {
  return Date.now();
}

export function std$int$parse(text: string): Option<number> {
  if (!/^-?[0-9]+$/.test(text)) return None;
  const n = Number(text);
  return Number.isSafeInteger(n) ? Some(intZero(n)) : None;
}

export function std$int$to_float(value: number): number {
  return value;
}

export function std$int$compare(left: number, right: number): Order {
  return toOrder(left - right);
}

export function std$int$min(left: number, right: number): number {
  return left <= right ? left : right;
}

export function std$int$max(left: number, right: number): number {
  return left >= right ? left : right;
}

// Cannot leave the range, which is symmetric.
export function std$int$abs(value: number): number {
  return value < 0 ? -value : value;
}

// A result outside the range is a value here, not a trap. Below 2^53 every
// sum, difference and product of Ints is exact, and rounding keeps a larger
// one outside, so the test is the same as for `+ - *`.
function checkedInt(r: number): Option<number> {
  return Number.isSafeInteger(r) ? Some(intZero(r)) : None;
}

export function std$int$checked_add(left: number, right: number): Option<number> {
  return checkedInt(left + right);
}

export function std$int$checked_subtract(left: number, right: number): Option<number> {
  return checkedInt(left - right);
}

export function std$int$checked_multiply(left: number, right: number): Option<number> {
  return checkedInt(left * right);
}

// A Float rounded to an Int by `floor`, `round`, `ceil` or `trunc`: outside
// the Int range (infinities included) it traps; `-0` becomes `0` (S1).
function floatToInt(name: string, value: number, r: number): number {
  if (!Number.isSafeInteger(r)) trap("overflow", name, String(value), "Float outside the Int range.");
  return intZero(r);
}

export function std$float$floor(value: number): number {
  return floatToInt("std.float.floor", value, Math.floor(value));
}

// `-0.0` and `0.0` are Equal, as under `==`.
export function std$float$compare(left: number, right: number): Order {
  return left < right ? Less : left > right ? Greater : Equal;
}

// Exactly the form the doc states; `-0` gives `-0.0`, a valid Float.
export function std$float$parse(text: string): Option<number> {
  if (!/^-?[0-9]+(\.[0-9]+)?$/.test(text)) return None;
  const n = Number(text);
  return Number.isFinite(n) ? Some(n) : None;
}

// Halves away from zero (R1); Math.round alone rounds -2.5 to -2.
export function std$float$round(value: number): number {
  return floatToInt("std.float.round", value, Math.sign(value) * Math.round(Math.abs(value)));
}

export function std$float$ceil(value: number): number {
  return floatToInt("std.float.ceil", value, Math.ceil(value));
}

export function std$float$trunc(value: number): number {
  return floatToInt("std.float.trunc", value, Math.trunc(value));
}

export function std$float$abs(value: number): number {
  return Math.abs(value);
}

// On equal values the left one wins.
export function std$float$min(left: number, right: number): number {
  return left <= right ? left : right;
}

export function std$float$max(left: number, right: number): number {
  return left >= right ? left : right;
}

// Traps before Math.sqrt, so the trap names the cause, not a NaN (R5).
export function std$float$sqrt(value: number): number {
  if (!(value >= 0)) {
    trap("requires", "std.float.sqrt", "value >= 0.0", "Precondition of std.float.sqrt violated: value >= 0.0");
  }
  return Math.sqrt(value);
}

const DECIMALS_CONDITION = "0 <= decimals and decimals <= 100";

// One text per shown value (R4): no exponent form, which toFixed gives from
// 1e21 on, and no `-` before zeros only (`-0.001` with 2 is `0.00`).
// toFixed breaks a tie toward the larger magnitude, on the exact binary
// value, so `1.005` (a little below) gives `1.00` with 2 (R1).
export function std$float$to_fixed(value: number, decimals: number): string {
  if (decimals < 0 || decimals > 100) {
    trap(
      "requires",
      "std.float.to_fixed",
      DECIMALS_CONDITION,
      `Precondition of std.float.to_fixed violated: ${DECIMALS_CONDITION}`,
    );
  }
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  const m = Math.abs(value);
  // From 1e21 on every Float is an integer.
  const digits = m < 1e21
    ? m.toFixed(decimals)
    : BigInt(m).toString() + (decimals > 0 ? "." + "0".repeat(decimals) : "");
  return value < 0 && /[1-9]/.test(digits) ? `-${digits}` : digits;
}

export function std$string$trim(text: string): string {
  return text.trim();
}

// Number of Unicode scalar values.
export function std$string$length(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

export function std$string$concat(left: string, right: string): string {
  return left + right;
}

export function std$string$join(parts: readonly string[], separator: string): string {
  return parts.join(separator);
}

// The inverse of join: join(split(t, s), s) == t for every text.
export function std$string$split(text: string, separator: string): readonly string[] {
  if (separator === "") {
    trap(
      "requires",
      "std.string.split",
      'separator != ""',
      'Precondition of std.string.split violated: separator != ""',
    );
  }
  return text.split(separator);
}

export function std$string$compare(left: string, right: string): Order {
  return toOrder(str_compare(left, right));
}

// Positions and counts are in Unicode scalar values, like `length`; the
// host's indexOf, slice and length count UTF-16 units. A question about the
// empty part has its mathematical answer (it occurs everywhere, first at 0);
// an operation that would act at every position traps instead (`replace`,
// like `split`).

export type std$string$Cut = { readonly before: string; readonly after: string };
export function std$string$Cut($fields: std$string$Cut): std$string$Cut {
  return $fields;
}

export function std$string$contains(text: string, part: string): boolean {
  return text.includes(part);
}

export function std$string$starts_with(text: string, prefix: string): boolean {
  return text.startsWith(prefix);
}

export function std$string$ends_with(text: string, suffix: string): boolean {
  return text.endsWith(suffix);
}

export function std$string$find(text: string, part: string): Option<number> {
  const i = text.indexOf(part);
  return i < 0 ? None : Some(std$string$length(text.slice(0, i)));
}

export function std$string$cut(text: string, separator: string): Option<std$string$Cut> {
  const i = text.indexOf(separator);
  return i < 0 ? None : Some({ before: text.slice(0, i), after: text.slice(i + separator.length) });
}

// A count above the length takes or drops everything; a negative count is a
// programming error.
function countAtLeastZero(name: string, count: number): void {
  if (count < 0) trap("requires", name, "count >= 0", `Precondition of ${name} violated: count >= 0`);
}

export function std$string$take(text: string, count: number): string {
  countAtLeastZero("std.string.take", count);
  return Array.from(text).slice(0, count).join("");
}

export function std$string$drop(text: string, count: number): string {
  countAtLeastZero("std.string.drop", count);
  return Array.from(text).slice(count).join("");
}

export function std$string$characters(text: string): readonly string[] {
  return Array.from(text);
}

// The lines as std.console.read_line reads them: a line ends at a line feed,
// a carriage return right before it goes too, and a last line without a line
// break counts. Unlike `split`, a final line feed adds no empty line.
export function std$string$lines(text: string): readonly string[] {
  const parts = text.split("\n");
  // After the last line feed: a line without a break, or nothing.
  const last = parts.pop()!;
  const lines = parts.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (last !== "") lines.push(last);
  return lines;
}

// Not replaceAll, which reads `$&` in the replacement as a pattern.
export function std$string$replace(text: string, part: string, replacement: string): string {
  if (part === "") {
    trap("requires", "std.string.replace", 'part != ""', 'Precondition of std.string.replace violated: part != ""');
  }
  return text.split(part).join(replacement);
}

// The locale-free forms: the same result on every system.
export function std$string$to_upper(text: string): string {
  return text.toUpperCase();
}

export function std$string$to_lower(text: string): string {
  return text.toLowerCase();
}

// A result too long for the host ends with the host's RangeError, not a
// trap, as `std.list.range` running out of memory does.
export function std$string$repeat(text: string, count: number): string {
  countAtLeastZero("std.string.repeat", count);
  return text.repeat(count);
}

const FILL_CONDITION = "std.string.length(text: fill) == 1";

// The fill is checked first, so a bad one traps even where nothing would be
// added (P1); a width at or below the length leaves the text as it is.
function pad(name: string, text: string, width: number, fill: string, before: boolean): string {
  if (std$string$length(fill) !== 1) {
    trap("requires", name, FILL_CONDITION, `Precondition of ${name} violated: ${FILL_CONDITION}`);
  }
  const length = std$string$length(text);
  if (length >= width) return text;
  const padding = fill.repeat(width - length);
  return before ? padding + text : text + padding;
}

export function std$string$pad_left(text: string, width: number, fill: string): string {
  return pad("std.string.pad_left", text, width, fill, true);
}

export function std$string$pad_right(text: string, width: number, fill: string): string {
  return pad("std.string.pad_right", text, width, fill, false);
}

export function std$string$trim_characters(text: string, characters: string): string {
  const strip = new Set(Array.from(characters));
  const scalars = Array.from(text);
  let start = 0;
  let end = scalars.length;
  while (start < end && strip.has(scalars[start])) start++;
  while (end > start && strip.has(scalars[end - 1])) end--;
  return scalars.slice(start, end).join("");
}

export function std$string$code_points(text: string): readonly number[] {
  return Array.from(text, (c) => c.codePointAt(0)!);
}

// Every number is checked before any text is built. The text is built in
// chunks, since one spread of a long list overflows the host's stack.
export function std$string$from_code_points(code_points: readonly number[]): string {
  for (const n of code_points) {
    if (n < 0 || n > 1_114_111 || (n >= 55_296 && n <= 57_343)) {
      trap(
        "requires",
        "std.string.from_code_points",
        String(n),
        `Precondition of std.string.from_code_points violated: ${n} is not a Unicode scalar value.`,
      );
    }
  }
  let text = "";
  for (let i = 0; i < code_points.length; i += 4096) text += String.fromCodePoint(...code_points.slice(i, i + 4096));
  return text;
}

export function std$list$empty<T>(): readonly T[] {
  return [];
}

export function std$list$append<T>(list: readonly T[], item: T): readonly T[] {
  return [...list, item];
}

export function std$list$length<T>(list: readonly T[]): number {
  return list.length;
}

export function std$list$get<T>(list: readonly T[], index: number): Option<T> {
  return index >= 0 && index < list.length ? Some(list[index]) : None;
}

export function std$list$map<T, U>(list: readonly T[], fn: (item: T) => U): readonly U[] {
  return list.map((x) => fn(x));
}

export function std$list$filter<T>(list: readonly T[], fn: (item: T) => boolean): readonly T[] {
  return list.filter((x) => fn(x));
}

export function std$list$fold<T, A>(list: readonly T[], initial: A, fn: (acc: A, item: T) => A): A {
  let acc = initial;
  for (const x of list) acc = fn(acc, x);
  return acc;
}

export function std$list$sort<T>(list: readonly T[], by: (left: T, right: T) => Order): readonly T[] {
  const order = { Less: -1, Equal: 0, Greater: 1 } as const;
  return [...list].sort((a, b) => order[by(a, b).tag]);
}

export function std$list$first<T>(list: readonly T[]): Option<T> {
  return list.length > 0 ? Some(list[0]) : None;
}

export function std$list$last<T>(list: readonly T[]): Option<T> {
  return list.length > 0 ? Some(list[list.length - 1]) : None;
}

export function std$list$take<T>(list: readonly T[], count: number): readonly T[] {
  countAtLeastZero("std.list.take", count);
  return list.slice(0, count);
}

export function std$list$drop<T>(list: readonly T[], count: number): readonly T[] {
  countAtLeastZero("std.list.drop", count);
  return list.slice(count);
}

export function std$list$reverse<T>(list: readonly T[]): readonly T[] {
  return [...list].reverse();
}

export function std$list$concat<T>(left: readonly T[], right: readonly T[]): readonly T[] {
  return [...left, ...right];
}

export function std$list$flatten<T>(lists: readonly (readonly T[])[]): readonly T[] {
  const items: T[] = [];
  for (const list of lists) for (const item of list) items.push(item);
  return items;
}

// Structural equality, as `==` (3.9); the checker keeps out function values.
export function std$list$contains<T>(list: readonly T[], item: T): boolean {
  return list.some((x) => eq(x, item));
}

// The most items a JavaScript array holds (checked: 2^32 - 1). Memory runs
// out long before, with the host's own error; the trap only states the limit.
const MAX_LIST_LENGTH = 4_294_967_295;

export function std$list$range(low: number, high: number): readonly number[] {
  if (low > high) return [];
  // May round for wide ranges, but stays far above the limit then.
  const count = high - low + 1;
  if (count > MAX_LIST_LENGTH) {
    trap("overflow", "std.list.range", `${low} to ${high}`, "More integers from low to high than a list can hold.");
  }
  const items: number[] = [];
  for (let n = low; n <= high; n++) items.push(n);
  return items;
}

export function std$list$window<T>(list: readonly T[], size: number): readonly (readonly T[])[] {
  if (size < 1) trap("requires", "std.list.window", "size >= 1", "Precondition of std.list.window violated: size >= 1");
  const runs: (readonly T[])[] = [];
  for (let i = 0; i + size <= list.length; i++) runs.push(list.slice(i, i + size));
  return runs;
}

const ZIP_CONDITION = "std.list.length(list: left) == std.list.length(list: right)";

// Different lengths trap: a silent cut at the shorter list would hide an error.
export function std$list$zip<T, U, V>(
  left: readonly T[],
  right: readonly U[],
  fn: (left: T, right: U) => V,
): readonly V[] {
  if (left.length !== right.length) {
    trap("requires", "std.list.zip", ZIP_CONDITION, `Precondition of std.list.zip violated: ${ZIP_CONDITION}`);
  }
  return left.map((x, i) => fn(x, right[i]));
}

export function std$list$enumerate<T, U>(list: readonly T[], fn: (index: number, item: T) => U): readonly U[] {
  return list.map((x, i) => fn(i, x));
}

// `any`, `all`, `find`, `take_while` and `drop_while` stop at the item that
// decides (H3). The function is pure, so stopping shows only as a trap in a
// later item that does not happen; their docs say so.

export function std$list$any<T>(list: readonly T[], fn: (item: T) => boolean): boolean {
  for (const x of list) if (fn(x)) return true;
  return false;
}

export function std$list$all<T>(list: readonly T[], fn: (item: T) => boolean): boolean {
  for (const x of list) if (!fn(x)) return false;
  return true;
}

export function std$list$find<T>(list: readonly T[], fn: (item: T) => boolean): Option<T> {
  for (const x of list) if (fn(x)) return Some(x);
  return None;
}

export function std$list$filter_map<T, U>(list: readonly T[], fn: (item: T) => Option<U>): readonly U[] {
  const kept: U[] = [];
  for (const x of list) {
    const r = fn(x);
    if (r.tag === "Some") kept.push(r.value);
  }
  return kept;
}

// The number of items from the start for which the function is true.
function leading<T>(list: readonly T[], fn: (item: T) => boolean): number {
  let i = 0;
  while (i < list.length && fn(list[i])) i++;
  return i;
}

export function std$list$take_while<T>(list: readonly T[], fn: (item: T) => boolean): readonly T[] {
  return list.slice(0, leading(list, fn));
}

export function std$list$drop_while<T>(list: readonly T[], fn: (item: T) => boolean): readonly T[] {
  return list.slice(leading(list, fn));
}

// ---- std.map ----
// On the AVL tree of `SortedMap` (top of this file).

export function std$map$empty<K, V>(): SortedMap<K, V> {
  return new SortedMap<K, V>(null, 0);
}

export function std$map$insert<K, V>(map: SortedMap<K, V>, key: K, value: V): SortedMap<K, V> {
  const [root, existed] = put(map.root, key, value);
  return new SortedMap(root, existed ? map.size : map.size + 1);
}

export function std$map$get<K, V>(map: SortedMap<K, V>, key: K): Option<V> {
  const n = lookup(map, key);
  return n === null ? None : Some(n.value);
}

// A missing key gives the same map back.
export function std$map$remove<K, V>(map: SortedMap<K, V>, key: K): SortedMap<K, V> {
  const [root, removed] = del(map.root, key);
  return removed ? new SortedMap(root, map.size - 1) : map;
}

export function std$map$contains<K, V>(map: SortedMap<K, V>, key: K): boolean {
  return lookup(map, key) !== null;
}

export function std$map$size<K, V>(map: SortedMap<K, V>): number {
  return map.size;
}

export function std$map$keys<K, V>(map: SortedMap<K, V>): readonly K[] {
  return map_entries(map).map(([k]) => k);
}

export function std$map$values<K, V>(map: SortedMap<K, V>): readonly V[] {
  return map_entries(map).map(([, v]) => v);
}

// Item by item: the key, then the value, then the insert. A key that is
// there already traps, as a duplicate in a literal does.
export function std$map$from_list<T, K, V>(
  list: readonly T[],
  key: (item: T) => K,
  value: (item: T) => V,
): SortedMap<K, V> {
  let root: MapNode<K, V> | null = null;
  for (const item of list) {
    const k = key(item);
    const v = value(item);
    const [next, existed]: [MapNode<K, V>, boolean] = put(root, k, v);
    if (existed) {
      const shown = std$text$show(k);
      trap("key", "std.map.from_list", shown, `The key ${shown} appears twice in the list given to std.map.from_list.`);
    }
    root = next;
  }
  return new SortedMap(root, list.length);
}

export function std$map$to_list<K, V, T>(map: SortedMap<K, V>, fn: (key: K, value: V) => T): readonly T[] {
  return map_entries(map).map(([k, v]) => fn(k, v));
}

// ---- std.option, std.order ----

export function std$option$with_default<T>(option: Option<T>, fallback: T): T {
  return option.tag === "Some" ? option.value : fallback;
}

export function std$option$map<T, U>(option: Option<T>, fn: (value: T) => U): Option<U> {
  return option.tag === "Some" ? Some(fn(option.value)) : None;
}

export function std$order$then_by(first: Order, second: Order): Order {
  return first.tag === "Equal" ? second : first;
}

// Text representation (rule 3.9). Records have no runtime type name yet, so
// they show as their fields in parentheses.
export function std$text$show(value: unknown): string {
  if (value === null) return "Unit";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(std$text$show).join(", ")}]`;
  // In key order, as the literal is written; before the record branch.
  if (value instanceof SortedMap) {
    if (value.size === 0) return "[:]";
    return `[${map_entries(value).map(([k, v]) => `${std$text$show(k)}: ${std$text$show(v)}`).join(", ")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.tag === "string") return "value" in obj ? `${obj.tag}(${std$text$show(obj.value)})` : obj.tag;
    return `(${Object.entries(obj).map(([k, v]) => `${k}: ${std$text$show(v)}`).join(", ")})`;
  }
  return String(value);
}
