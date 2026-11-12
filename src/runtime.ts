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

export function failureOf<E>(r: Err<E> | None): E | Unit {
  return r.tag === "Err" ? r.value : Unit;
}

// ---- equality and order (rule 3.9) ----

export function eq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => eq(x, b[i]));
  }
  if (a instanceof Map) {
    if (!(b instanceof Map) || a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (!b.has(k) || !eq(v, b.get(k))) return false;
    }
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    Object.hasOwn(b, k) && eq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
  );
}

// Strings order by Unicode scalar values, not by UTF-16 code units.
function compare(a: number | string, b: number | string): number {
  if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
  const ia = String(a)[Symbol.iterator]();
  const ib = String(b)[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done || y.done) return x.done && y.done ? 0 : x.done ? -1 : 1;
    const cx = x.value.codePointAt(0)!;
    const cy = y.value.codePointAt(0)!;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

export const lt = (a: number | string, b: number | string): boolean => compare(a, b) < 0;
export const le = (a: number | string, b: number | string): boolean => compare(a, b) <= 0;
export const gt = (a: number | string, b: number | string): boolean => compare(a, b) > 0;
export const ge = (a: number | string, b: number | string): boolean => compare(a, b) >= 0;

// ---- arithmetic ----
// Without a type checker Int and Float share these operations: a NaN result
// traps, and a result outside the Int range traps when both operands are
// integers. Once types are known the emitter will pick separate Int and Float
// operations.

function checked(op: string, a: number, b: number, r: number): number {
  if (Number.isNaN(r)) trap("nan", null, `${a} ${op} ${b}`, "Float operation produced NaN.");
  if (Number.isSafeInteger(a) && Number.isSafeInteger(b) && Number.isInteger(r) && !Number.isSafeInteger(r)) {
    trap("overflow", null, `${a} ${op} ${b}`, "Int overflow.");
  }
  return r;
}

export const add = (a: number, b: number): number => checked("+", a, b, a + b);
export const sub = (a: number, b: number): number => checked("-", a, b, a - b);
export const mul = (a: number, b: number): number => checked("*", a, b, a * b);

// ---- examples ----

export interface Example {
  readonly definition: string;
  readonly text: string;
  readonly run: () => boolean;
}

export interface ExampleResult {
  readonly definition: string;
  readonly text: string;
  readonly passed: boolean;
  readonly trap: string | null;
}

export function runExamples(examples: readonly Example[]): ExampleResult[] {
  return examples.map((ex) => {
    try {
      return { definition: ex.definition, text: ex.text, passed: ex.run(), trap: null };
    } catch (e) {
      if (!(e instanceof Trap)) throw e;
      return { definition: ex.definition, text: ex.text, passed: false, trap: e.message };
    }
  });
}

// ---- std ----
// Named std$<module>$<name>, matching the mangled paths the emitter produces.

export function std$console$print_line(text: string): Unit {
  console.log(text);
  return Unit;
}

// Decimal digits with an optional leading minus, inside the Int range.
export function std$int$parse(text: string): Option<number> {
  if (!/^-?[0-9]+$/.test(text)) return None;
  const n = Number(text);
  return Number.isSafeInteger(n) ? Some(n) : None;
}

export function std$int$to_float(value: number): number {
  return value;
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

export function std$list$empty<T>(): readonly T[] {
  return [];
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

// Text representation (rule 3.9). Records have no runtime type name yet, so
// they show as their fields in parentheses.
export function std$text$show(value: unknown): string {
  if (value === null) return "Unit";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(std$text$show).join(", ")}]`;
  if (value instanceof Map) {
    return `{${[...value].map(([k, v]) => `${std$text$show(k)}: ${std$text$show(v)}`).join(", ")}}`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.tag === "string") return "value" in obj ? `${obj.tag}(${std$text$show(obj.value)})` : obj.tag;
    return `(${Object.entries(obj).map(([k, v]) => `${k}: ${std$text$show(v)}`).join(", ")})`;
  }
  return String(value);
}
