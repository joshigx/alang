// Types as the checker sees them. Only builtins are generic; function types
// and type variables exist for std signatures, which the surface language
// cannot express yet (see docs/notes.md).

export type Type =
  // Nominal types: builtins (`Int`, `List`, ...) and user types by full name.
  | { readonly k: "con"; readonly name: string; readonly args: readonly Type[] }
  | { readonly k: "fn"; readonly params: readonly Type[]; readonly out: Type }
  // Type parameter of a std signature, e.g. `T` in `std.list.map`.
  | { readonly k: "var"; readonly name: string }
  // Type of a block that always returns; fits every expected type.
  | { readonly k: "never" }
  // Type of an expression that already produced a diagnostic. Fits
  // everything, so that follow-up errors are suppressed (rule 5.6).
  | { readonly k: "error" };

export const con = (name: string, ...args: Type[]): Type => ({ k: "con", name, args });
export const fnType = (params: Type[], out: Type): Type => ({ k: "fn", params, out });
export const tvar = (name: string): Type => ({ k: "var", name });

export const INT = con("Int");
export const FLOAT = con("Float");
export const BOOL = con("Bool");
export const STRING = con("String");
export const UNIT = con("Unit");
export const ORDER = con("Order");
export const NEVER: Type = { k: "never" };
export const ERROR: Type = { k: "error" };
export const list = (t: Type) => con("List", t);
export const map = (k: Type, v: Type) => con("Map", k, v);
export const option = (t: Type) => con("Option", t);
export const result = (t: Type, e: Type) => con("Result", t, e);

// Builtin type names and their number of type arguments.
export const BUILTIN_TYPES: ReadonlyMap<string, number> = new Map([
  ["Int", 0],
  ["Float", 0],
  ["Bool", 0],
  ["String", 0],
  ["Unit", 0],
  ["Order", 0],
  ["List", 1],
  ["Map", 2],
  ["Option", 1],
  ["Result", 2],
]);

export function isCon<N extends string>(
  t: Type,
  name: N,
): t is { readonly k: "con"; readonly name: N; readonly args: readonly Type[] } {
  return t.k === "con" && t.name === name;
}

// Whether a type is never or error, i.e. fits wherever it appears.
export function isBottom(t: Type): boolean {
  return t.k === "never" || t.k === "error";
}

export function containsError(t: Type): boolean {
  switch (t.k) {
    case "error":
      return true;
    case "con":
      return t.args.some(containsError);
    case "fn":
      return t.params.some(containsError) || containsError(t.out);
    default:
      return false;
  }
}

export function containsFn(t: Type, records: (name: string) => readonly Type[]): boolean {
  const seen = new Set<string>();
  const go = (t: Type): boolean => {
    switch (t.k) {
      case "fn":
        return true;
      case "con":
        if (t.args.some(go)) return true;
        if (BUILTIN_TYPES.has(t.name) || seen.has(t.name)) return false;
        seen.add(t.name);
        return records(t.name).some(go);
      default:
        return false;
    }
  };
  return go(t);
}

export function typeEquals(a: Type, b: Type): boolean {
  if (a.k !== b.k) return false;
  switch (a.k) {
    case "con": {
      const bb = b as typeof a;
      return a.name === bb.name && a.args.length === bb.args.length &&
        a.args.every((x, i) => typeEquals(x, bb.args[i]));
    }
    case "fn": {
      const bb = b as typeof a;
      return a.params.length === bb.params.length && a.params.every((x, i) => typeEquals(x, bb.params[i])) &&
        typeEquals(a.out, bb.out);
    }
    case "var":
      return a.name === (b as typeof a).name;
    default:
      return true;
  }
}

// `actual` may stand where `expected` is required.
export function fits(actual: Type, expected: Type): boolean {
  if (isBottom(actual) || containsError(expected) || containsError(actual)) return true;
  return typeEquals(actual, expected);
}

// Display in alang notation. User types print by full name unless they
// belong to `module`, matching how they are written there (rule 1.2).
export function showType(t: Type, module?: string): string {
  switch (t.k) {
    case "con": {
      const name = module !== undefined && t.name.startsWith(module + ".") &&
          !t.name.slice(module.length + 1).includes(".")
        ? t.name.slice(module.length + 1)
        : t.name;
      return t.args.length === 0 ? name : `${name}<${t.args.map((a) => showType(a, module)).join(", ")}>`;
    }
    case "fn":
      return `(${t.params.map((p) => showType(p, module)).join(", ")}) -> ${showType(t.out, module)}`;
    case "var":
      return t.name;
    case "never":
      return "Never";
    case "error":
      return "?";
  }
}

export type Subst = Map<string, Type>;

export function substitute(t: Type, s: Subst): Type {
  switch (t.k) {
    case "var":
      return s.get(t.name) ?? t;
    case "con":
      return t.args.length === 0 ? t : con(t.name, ...t.args.map((a) => substitute(a, s)));
    case "fn":
      return fnType(t.params.map((p) => substitute(p, s)), substitute(t.out, s));
    default:
      return t;
  }
}

export function freeVars(t: Type, into = new Set<string>()): Set<string> {
  switch (t.k) {
    case "var":
      into.add(t.name);
      break;
    case "con":
      t.args.forEach((a) => freeVars(a, into));
      break;
    case "fn":
      t.params.forEach((p) => freeVars(p, into));
      freeVars(t.out, into);
      break;
  }
  return into;
}

// Binds the variables of `pattern` so that it equals `actual`. Returns false
// on a mismatch. Variables already bound in `s` must agree.
export function unify(pattern: Type, actual: Type, s: Subst): boolean {
  if (isBottom(actual) || containsError(actual)) return true;
  switch (pattern.k) {
    case "var": {
      const bound = s.get(pattern.name);
      if (bound) return typeEquals(bound, actual) || containsError(bound);
      s.set(pattern.name, actual);
      return true;
    }
    case "con":
      return actual.k === "con" && actual.name === pattern.name && actual.args.length === pattern.args.length &&
        pattern.args.every((p, i) => unify(p, actual.args[i], s));
    case "fn":
      return actual.k === "fn" && actual.params.length === pattern.params.length &&
        pattern.params.every((p, i) => unify(p, actual.params[i], s)) && unify(pattern.out, actual.out, s);
    default:
      return typeEquals(pattern, actual);
  }
}
