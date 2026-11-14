// Types as the checker sees them. Function types are written `(A, B) -> R`
// (F1). A generic function's type parameters are variables in its signature,
// which every call binds, and rigid types inside its own definition (G6).

export type Type =
  // Nominal types: builtins (`Int`, `List`, ...) and user types by full name.
  | { readonly k: "con"; readonly name: string; readonly args: readonly Type[] }
  // `effects: "caller"` marks a parameter of a std function that takes a
  // function with effects (the handler of `std.http.serve`); the call then
  // counts the passed function's effects as its own. Every other function
  // type is pure (2.4). Equality ignores the mark: a value's type never has it.
  | { readonly k: "fn"; readonly params: readonly Type[]; readonly out: Type; readonly effects?: "caller" }
  // Type parameter of a signature, e.g. `T` in `std.list.map`; a call binds it.
  | { readonly k: "var"; readonly name: string }
  // A type parameter of the definition being checked, inside that definition
  // (G6): fixed but unknown, equal only to itself. Callers see the same
  // parameter as a `var`, which a call binds.
  | { readonly k: "rigid"; readonly name: string }
  // Type of a block that always returns; fits every expected type.
  | { readonly k: "never" }
  // Type of an expression that already produced a diagnostic. Fits
  // everything, so that follow-up errors are suppressed (rule 5.6).
  | { readonly k: "error" };

export const con = (name: string, ...args: Type[]): Type => ({ k: "con", name, args });
export const fnType = (params: Type[], out: Type, effects?: "caller"): Type =>
  effects ? { k: "fn", params, out, effects } : { k: "fn", params, out };
export const tvar = (name: string): Type => ({ k: "var", name });
export const rigid = (name: string): Type => ({ k: "rigid", name });

// The signature as callers see it: each rigid type parameter becomes a
// variable of the same name, which a call binds.
export function generalize(t: Type): Type {
  switch (t.k) {
    case "rigid":
      return tvar(t.name);
    case "con":
      return t.args.length === 0 ? t : con(t.name, ...t.args.map(generalize));
    case "fn":
      return fnType(t.params.map(generalize), generalize(t.out), t.effects);
    default:
      return t;
  }
}

// The first type parameter of the definition inside `t`, if any: such a
// value may stand for a type with function values (G2).
export function firstRigid(t: Type): string | null {
  switch (t.k) {
    case "rigid":
      return t.name;
    case "con":
      for (const a of t.args) {
        const r = firstRigid(a);
        if (r !== null) return r;
      }
      return null;
    case "fn":
      for (const p of [...t.params, t.out]) {
        const r = firstRigid(p);
        if (r !== null) return r;
      }
      return null;
    default:
      return null;
  }
}

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
    case "rigid":
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
// belong to `module`, matching how they are written there (rule 1.2). A type
// of the module named like one of `letters`, the type parameters of the
// definition, is written in full there, since the short form is the type
// parameter (G4).
export function showType(t: Type, module?: string, letters: readonly string[] = []): string {
  switch (t.k) {
    case "con": {
      const short = module !== undefined && t.name.startsWith(module + ".") &&
          !t.name.slice(module.length + 1).includes(".")
        ? t.name.slice(module.length + 1)
        : t.name;
      const name = letters.includes(short) ? t.name : short;
      return t.args.length === 0 ? name : `${name}<${t.args.map((a) => showType(a, module, letters)).join(", ")}>`;
    }
    case "fn": {
      const show = (p: Type) => showType(p, module, letters);
      const shown = `(${t.params.map(show).join(", ")}) -> ${show(t.out)}`;
      return t.effects === "caller" ? `${shown} with effects` : shown;
    }
    case "var":
    case "rigid":
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
      return fnType(t.params.map((p) => substitute(p, s)), substitute(t.out, s), t.effects);
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
