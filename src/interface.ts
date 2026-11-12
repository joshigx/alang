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
//
// Contracts are compared as printed, since there is no proof that one
// implies the other yet (5.2): any change counts. Types are compared by full
// name, so `Port` and `net.port.Port` written in `net.port` are the same type.

import type { Definition, Effect, Expr, Path, TypeRef } from "./ast.ts";
import { moduleOf, pathText } from "./ast.ts";
import { printExpr } from "./printer.ts";
import { BUILTIN_TYPES } from "./types.ts";

export interface InterfaceChange {
  // Sections whose caller-facing part changed: `in`, `out`, `requires`,
  // `ensures`, `record`, `variant`, `where`.
  readonly sections: readonly string[];
  readonly addedEffects: readonly Effect[];
}

function fullType(t: TypeRef, module: Path): string {
  const head = t.path.length === 1 && !BUILTIN_TYPES.has(t.path[0])
    ? pathText([...module, t.path[0]])
    : pathText(t.path);
  return t.args.length === 0 ? head : `${head}<${t.args.map((a) => fullType(a, module)).join(", ")}>`;
}

function shapeKey(def: Definition): string {
  const module = moduleOf(def.path);
  if (def.kind === "fn") return "";
  if (def.shape.kind === "record") {
    return def.shape.fields.map((f) => `${f.name}: ${fullType(f.type, module)}`).join(", ");
  }
  return def.shape.cases.map((c) => (c.payload ? `${c.name}: ${fullType(c.payload, module)}` : c.name)).join(", ");
}

// How the interface changes from `before` to `after`, two versions of one
// name and kind.
export function interfaceChange(before: Definition, after: Definition): InterfaceChange {
  const contract = (e: Expr | null) => (e === null ? "none" : printExpr(e, ""));
  if (before.kind === "fn" && after.kind === "fn") {
    const params = (d: typeof before) =>
      d.params.map((p) => `${p.name}: ${fullType(p.type, moduleOf(d.path))}`).join(", ");
    const sections: string[] = [];
    if (params(before) !== params(after)) sections.push("in");
    if (fullType(before.out, moduleOf(before.path)) !== fullType(after.out, moduleOf(after.path))) sections.push("out");
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
  throw new Error("interfaceChange: the two versions differ in kind");
}

// Full names of the cases of a variant type; none for anything else.
export function casesOf(def: Definition): string[] {
  if (def.kind !== "type" || def.shape.kind !== "variant") return [];
  const module = moduleOf(def.path);
  return def.shape.cases.map((c) => pathText([...module, c.name]));
}
