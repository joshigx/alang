// The caller-facing interface of a definition, for the rule of section 6:
// "if replace changes the signature, it is rejected and names the affected
// callers". The `signature` query is every section but `body`; of those,
// `doc` and `examples` concern only the definition itself, so adding an
// example or rewording `doc` does not force every caller into the
// transaction. Everything else counts:
//
// - fn: `in` (names, types, order), `out`, `requires`, `ensures`, and added
//   effects. Removing an effect is compatible, since over-declared effects
//   are allowed. A contract counts although acceptance re-runs every example:
//   callers with effects have no examples (5.4), so a tightened `requires`
//   would surface only as a trap at runtime.
// - type: its shape (record or variant), fields, cases with payloads, in
//   order, and `where`.
// - const: its `out`. Its body, the value, is not: acceptance re-runs every
//   example, so a caller whose example states the old value is rejected.
// - A `fn` that becomes a `const` of the same name, or back, changes how
//   every caller writes it.
//
// Contracts are compared as printed, since there is no proof that one
// implies the other yet (5.2): any change counts, also a renamed type
// parameter that a contract names (G13). Types are compared by full
// name; a caller compares a version with what a rename makes of it.

import type { Definition, Effect, Expr, Path, TypeRef } from "./ast.ts";
import { moduleOf, pathText } from "./ast.ts";
import { printExpr } from "./printer.ts";
import { BUILTIN_TYPES } from "./types.ts";

export interface InterfaceChange {
  // Sections whose caller-facing part changed: `in`, `out`, `requires`,
  // `ensures`, `record`, `variant`, `where`.
  readonly sections: readonly string[];
  readonly addedEffects: readonly Effect[];
  // A value that turns from a `fn` into a `const` or back (C7): every
  // caller is affected, so no section is named.
  readonly kind?: { readonly from: string; readonly to: string };
}

// A type with full names. A type parameter is written by its position,
// `#0`, `#1` (G13): renaming one throughout its definition changes no
// caller, while adding, removing or reordering one changes the types it
// occurs in, since every letter occurs there (E0250).
function fullType(t: TypeRef, module: Path, letters: readonly string[] = []): string {
  const full = (u: TypeRef) => fullType(u, module, letters);
  if (t.kind === "function") return `(${t.params.map(full).join(", ")}) -> ${full(t.out)}`;
  const letter = t.path.length === 1 ? letters.indexOf(t.path[0]) : -1;
  const head = letter >= 0
    ? `#${letter}`
    : t.path.length === 1 && !BUILTIN_TYPES.has(t.path[0])
    ? pathText([...module, t.path[0]])
    : pathText(t.path);
  return t.args.length === 0 ? head : `${head}<${t.args.map(full).join(", ")}>`;
}

function shapeKey(def: Definition): string {
  const module = moduleOf(def.path);
  if (def.kind !== "type") return "";
  const full = (t: TypeRef) => fullType(t, module, def.typeParams);
  if (def.shape.kind === "record") return def.shape.fields.map((f) => `${f.name}: ${full(f.type)}`).join(", ");
  return def.shape.cases.map((c) => (c.payload ? `${c.name}: ${full(c.payload)}` : c.name)).join(", ");
}

// How the interface changes from `before` to `after`, two versions of one
// name and kind.
export function interfaceChange(before: Definition, after: Definition): InterfaceChange {
  const contract = (e: Expr | null) => (e === null ? "none" : printExpr(e, ""));
  if (before.kind === "fn" && after.kind === "fn") {
    const params = (d: typeof before) =>
      d.params.map((p) => `${p.name}: ${fullType(p.type, moduleOf(d.path), d.typeParams)}`).join(", ");
    const out = (d: typeof before) => fullType(d.out, moduleOf(d.path), d.typeParams);
    const sections: string[] = [];
    if (params(before) !== params(after)) sections.push("in");
    if (out(before) !== out(after)) sections.push("out");
    if (contract(before.requires) !== contract(after.requires)) sections.push("requires");
    if (contract(before.ensures) !== contract(after.ensures)) sections.push("ensures");
    return { sections, addedEffects: after.effects.filter((e) => !before.effects.includes(e)) };
  }
  if (before.kind === "type" && after.kind === "type") {
    const sections: string[] = before.shape.kind !== after.shape.kind
      ? [before.shape.kind, after.shape.kind]
      : shapeKey(before) === shapeKey(after)
      ? []
      : [after.shape.kind];
    if (contract(before.where) !== contract(after.where)) sections.push("where");
    return { sections, addedEffects: [] };
  }
  // A constant's interface is its type; its body, the value, is not (C8).
  if (before.kind === "const" && after.kind === "const") {
    const out = (d: typeof before) => fullType(d.out, moduleOf(d.path));
    return { sections: out(before) === out(after) ? [] : ["out"], addedEffects: [] };
  }
  // Only a `fn` and a `const` can share a name: both are snake_case.
  return { sections: [], addedEffects: [], kind: { from: before.kind, to: after.kind } };
}

// Full names of the cases of a variant type; none for anything else.
export function casesOf(def: Definition): string[] {
  if (def.kind !== "type" || def.shape.kind !== "variant") return [];
  const module = moduleOf(def.path);
  return def.shape.cases.map((c) => pathText([...module, c.name]));
}
