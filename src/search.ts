// Type patterns for the `search(type)` query (section 6), such as
// `String -> Result<Int, _>` or `String, Int -> Bool`; `-> Int` for a
// function without parameters.
//
// - `_` matches any type.
// - A name with a module matches exactly that type; a one-segment name
//   matches a type by its last segment (`Port` matches `net.port.Port`).
// - A type variable of a std signature, or a type parameter of a stored
//   function, matches any type, the same one at each occurrence, a function
//   type pattern included.
// - A function type is written as in alang, `(_) -> Bool` (F9), and matches
//   a function type with as many parameters by the same rules; `_` matches
//   it too. A whole pattern in parentheses, `(String) -> Option<Int>`, reads
//   as `String -> Option<Int>`, since nothing else would parse.
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

export type TypePattern =
  // `name` "_" matches anything.
  | { readonly kind: "named"; readonly name: string; readonly args: readonly TypePattern[] }
  | { readonly kind: "fn"; readonly params: readonly TypePattern[]; readonly out: TypePattern };

export interface FnPattern {
  readonly params: readonly TypePattern[];
  readonly out: TypePattern;
}

// ---- conversion ----

// A type as written in `module`, with full names; a type parameter of the
// definition (`letters`) is a variable, as in a std signature (G15).
export function treeOfRef(t: TypeRef, module: Path, letters: readonly string[] = []): TypeTree {
  const tree = (u: TypeRef) => treeOfRef(u, module, letters);
  if (t.kind === "function") return { k: "fn", params: t.params.map(tree), out: tree(t.out) };
  if (t.path.length === 1 && letters.includes(t.path[0])) return { k: "var", name: t.path[0] };
  const name = t.path.length === 1 && !BUILTIN_TYPES.has(t.path[0])
    ? pathText([...module, t.path[0]])
    : pathText(t.path);
  return { k: "con", name, args: t.args.map(tree) };
}

export function treeOfType(t: Type): TypeTree {
  switch (t.k) {
    case "con":
      return { k: "con", name: t.name, args: t.args.map(treeOfType) };
    case "fn":
      return { k: "fn", params: t.params.map(treeOfType), out: treeOfType(t.out) };
    case "var":
    case "rigid":
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
  const tokens = text.match(/->|[<>,()]|[A-Za-z_][A-Za-z0-9_.]*|\S/g) ?? [];
  let pos = 0;
  const peek = () => tokens[pos];
  // Types separated by commas, at least one.
  const types = (): TypePattern[] => {
    const list = [type()];
    while (peek() === ",") {
      pos++;
      list.push(type());
    }
    return list;
  };
  const type = (): TypePattern => {
    if (peek() === "(") {
      // A function type, as alang writes it: `(_, Int) -> Bool`.
      pos++;
      if (peek() === ")") throw malformed(text, "A function type takes at least one parameter.");
      const params = types();
      if (tokens[pos++] !== ")") throw malformed(text, "A parameter list is not closed with `)`.");
      if (tokens[pos++] !== "->") throw malformed(text, "A function type has `->` after its parameters.");
      return { kind: "fn", params, out: type() };
    }
    const name = tokens[pos++];
    if (name === undefined || !/^[A-Za-z_]/.test(name)) {
      throw malformed(text, `Expected a type, found \`${name ?? "the end"}\`.`);
    }
    const args: TypePattern[] = [];
    if (peek() === "<") {
      pos++;
      args.push(...types());
      if (tokens[pos++] !== ">") throw malformed(text, "A type argument list is not closed with `>`.");
    }
    return { kind: "named", name, args };
  };
  // A whole pattern in parentheses, `(String) -> Option<Int>` or `() -> _`,
  // reads as the top-level form, since nothing else would parse: the
  // parameters up to the matching `)`, then `->` and one result type that
  // ends the text. Otherwise it is read from the start as usual.
  const whole = (): FnPattern | null => {
    if (tokens[0] !== "(") return null;
    let close = -1;
    for (let i = 0, depth = 0; i < tokens.length && close < 0; i++) {
      if (tokens[i] === "(") depth++;
      else if (tokens[i] === ")" && --depth === 0) close = i;
    }
    if (close < 0 || tokens[close + 1] !== "->") return null;
    try {
      pos = close + 2;
      const out = type();
      if (pos !== tokens.length) return null;
      pos = 1;
      const params = close === 1 ? [] : types();
      return pos === close ? { params, out } : null;
    } catch (e) {
      if (e instanceof AlangError) return null;
      throw e;
    }
  };
  const top = whole();
  if (top) return top;
  pos = 0;
  const params = peek() === "->" ? [] : types();
  if (tokens[pos++] !== "->") throw malformed(text, "The pattern has no `->`.");
  const out = type();
  if (pos !== tokens.length) throw malformed(text, `Unexpected \`${tokens[pos]}\` after the result type.`);
  return { params, out };
}

// ---- matching ----

const any = (p: TypePattern) => p.kind === "named" && p.name === "_";

// Two patterns that some type matches both of: equal up to `_`.
function compatible(a: TypePattern, b: TypePattern): boolean {
  if (any(a) || any(b)) return true;
  if (a.kind === "fn" || b.kind === "fn") {
    return a.kind === "fn" && b.kind === "fn" && a.params.length === b.params.length &&
      a.params.every((x, i) => compatible(x, b.params[i])) && compatible(a.out, b.out);
  }
  return a.name === b.name && a.args.length === b.args.length && a.args.every((x, i) => compatible(x, b.args[i]));
}

// `bound` holds the pattern each type variable met first; a later occurrence
// must agree with it, so `List<Int>, String -> _` does not match
// `std.list.append(list: List<T>, item: T)`.
export function matchesType(p: TypePattern, t: TypeTree, bound = new Map<string, TypePattern>()): boolean {
  if (any(p)) return true;
  if (t.k === "var") {
    const first = bound.get(t.name);
    if (!first) bound.set(t.name, p);
    return !first || compatible(first, p);
  }
  if (t.k === "fn" || p.kind === "fn") {
    return t.k === "fn" && p.kind === "fn" && p.params.length === t.params.length &&
      p.params.every((q, i) => matchesType(q, t.params[i], bound)) && matchesType(p.out, t.out, bound);
  }
  const name = p.name.includes(".") ? t.name : t.name.slice(t.name.lastIndexOf(".") + 1);
  if (name !== p.name || p.args.length !== t.args.length) return false;
  return p.args.every((a, i) => matchesType(a, t.args[i], bound));
}

export function matchesFn(p: FnPattern, params: readonly TypeTree[], out: TypeTree): boolean {
  const bound = new Map<string, TypePattern>();
  return p.params.length === params.length && p.params.every((q, i) => matchesType(q, params[i], bound)) &&
    matchesType(p.out, out, bound);
}
