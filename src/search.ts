// Type patterns for the `search(type)` query (section 6), such as
// `String -> Result<Int, _>` or `String, Int -> Bool`; `-> Int` for a
// function without parameters.
//
// - `_` matches any type.
// - A name with a module matches exactly that type; a one-segment name
//   matches a type by its last segment (`Port` matches `net.port.Port`).
// - A type variable of a std signature matches any type, the same one at
//   each occurrence; a function type matches only `_`.
// - Parameters match by position; their names do not matter.

import type { Path, TypeRef } from "./ast.ts";
import { pathText } from "./ast.ts";
import { AlangError, diagnostic } from "./diagnostic.ts";
import { BUILTIN_TYPES, type Type } from "./types.ts";

// A type with full names, from either alang source or a std signature.
export type TypeTree =
  | { readonly k: "con"; readonly name: string; readonly args: readonly TypeTree[] }
  | { readonly k: "var"; readonly name: string }
  | { readonly k: "fn"; readonly params: readonly TypeTree[]; readonly out: TypeTree };

export interface TypePattern {
  readonly name: string; // "_" matches anything
  readonly args: readonly TypePattern[];
}

export interface FnPattern {
  readonly params: readonly TypePattern[];
  readonly out: TypePattern;
}

// ---- conversion ----

// A type as written in `module`, with full names.
export function treeOfRef(t: TypeRef, module: Path): TypeTree {
  if (t.kind === "function") {
    return { k: "fn", params: t.params.map((p) => treeOfRef(p, module)), out: treeOfRef(t.out, module) };
  }
  const name = t.path.length === 1 && !BUILTIN_TYPES.has(t.path[0])
    ? pathText([...module, t.path[0]])
    : pathText(t.path);
  return { k: "con", name, args: t.args.map((a) => treeOfRef(a, module)) };
}

export function treeOfType(t: Type): TypeTree {
  switch (t.k) {
    case "con":
      return { k: "con", name: t.name, args: t.args.map(treeOfType) };
    case "fn":
      return { k: "fn", params: t.params.map(treeOfType), out: treeOfType(t.out) };
    case "var":
      return { k: "var", name: t.name };
    default:
      return { k: "var", name: "_" };
  }
}

// Full names of the user and std types in `t`, builtins left out, those
// inside function types included (`Sale` in `(Sale) -> Int`).
export function namedTypes(t: TypeTree, into: string[] = []): string[] {
  if (t.k === "fn") {
    for (const p of t.params) namedTypes(p, into);
    return namedTypes(t.out, into);
  }
  if (t.k !== "con") return into;
  if (!BUILTIN_TYPES.has(t.name) && !into.includes(t.name)) into.push(t.name);
  for (const a of t.args) namedTypes(a, into);
  return into;
}

export function showTree(t: TypeTree): string {
  if (t.k === "var") return t.name;
  if (t.k === "fn") return `(${t.params.map(showTree).join(", ")}) -> ${showTree(t.out)}`;
  return t.args.length === 0 ? t.name : `${t.name}<${t.args.map(showTree).join(", ")}>`;
}

// ---- parsing ----

const EXPECTED = "String -> Result<Int, _>";

function malformed(text: string, why: string): AlangError {
  return new AlangError(diagnostic({
    code: "E0511",
    at: `search(${text})`,
    message: `${why} A type pattern lists the parameter types, then \`->\` and the result type; \`_\` matches any ` +
      "type.",
    expected: EXPECTED,
  }));
}

export function parseFnPattern(text: string): FnPattern {
  const tokens = text.match(/->|[<>,]|[A-Za-z_][A-Za-z0-9_.]*|\S/g) ?? [];
  let pos = 0;
  const peek = () => tokens[pos];
  const type = (): TypePattern => {
    const name = tokens[pos++];
    if (name === undefined || !/^[A-Za-z_]/.test(name)) {
      throw malformed(text, `Expected a type, found \`${name ?? "the end"}\`.`);
    }
    const args: TypePattern[] = [];
    if (peek() === "<") {
      pos++;
      args.push(type());
      while (peek() === ",") {
        pos++;
        args.push(type());
      }
      if (tokens[pos++] !== ">") throw malformed(text, "A type argument list is not closed with `>`.");
    }
    return { name, args };
  };
  const params: TypePattern[] = [];
  if (peek() !== "->") {
    params.push(type());
    while (peek() === ",") {
      pos++;
      params.push(type());
    }
  }
  if (tokens[pos++] !== "->") throw malformed(text, "The pattern has no `->`.");
  const out = type();
  if (pos !== tokens.length) throw malformed(text, `Unexpected \`${tokens[pos]}\` after the result type.`);
  return { params, out };
}

// ---- matching ----

// Two patterns that some type matches both of: equal up to `_`.
function compatible(a: TypePattern, b: TypePattern): boolean {
  if (a.name === "_" || b.name === "_") return true;
  return a.name === b.name && a.args.length === b.args.length && a.args.every((x, i) => compatible(x, b.args[i]));
}

// `bound` holds the pattern each type variable met first; a later occurrence
// must agree with it, so `List<Int>, String -> _` does not match
// `std.list.append(list: List<T>, item: T)`.
export function matchesType(p: TypePattern, t: TypeTree, bound = new Map<string, TypePattern>()): boolean {
  if (p.name === "_") return true;
  if (t.k === "var") {
    const first = bound.get(t.name);
    if (!first) bound.set(t.name, p);
    return !first || compatible(first, p);
  }
  if (t.k === "fn") return false;
  const name = p.name.includes(".") ? t.name : t.name.slice(t.name.lastIndexOf(".") + 1);
  if (name !== p.name || p.args.length !== t.args.length) return false;
  return p.args.every((a, i) => matchesType(a, t.args[i], bound));
}

export function matchesFn(p: FnPattern, params: readonly TypeTree[], out: TypeTree): boolean {
  const bound = new Map<string, TypePattern>();
  return p.params.length === params.length && p.params.every((q, i) => matchesType(q, params[i], bound)) &&
    matchesType(p.out, out, bound);
}
