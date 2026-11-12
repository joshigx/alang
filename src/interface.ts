// The caller-facing interface of a definition, for the rule of section 6:
// "if replace changes the signature, it is rejected and names the affected
// callers". What callers depend on is narrower than the `signature` query:
// adding an example or tightening `doc` must not force every caller into the
// transaction. Contracts and examples are covered by acceptance instead,
// which re-runs every example of the program.
//
// - fn: `in` (names, types, order), `out`, and added effects. Removing an
//   effect is compatible, since over-declared effects are allowed.
// - type: its shape (record or variant), fields, and cases with payloads, in
//   order. `doc` and `where` are not part of it.
//
// Types are compared by full name, so `Port` and `net.port.Port` written in
// `net.port` are the same type.

import type { Definition, Effect, Path, TypeRef } from "./ast.ts";
import { moduleOf, pathText } from "./ast.ts";
import { BUILTIN_TYPES } from "./types.ts";

export interface InterfaceChange {
  // Sections whose caller-facing part changed: `in`, `out`, `record`, `variant`.
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
  if (before.kind === "fn" && after.kind === "fn") {
    const params = (d: typeof before) =>
      d.params.map((p) => `${p.name}: ${fullType(p.type, moduleOf(d.path))}`).join(", ");
    const sections: string[] = [];
    if (params(before) !== params(after)) sections.push("in");
    if (fullType(before.out, moduleOf(before.path)) !== fullType(after.out, moduleOf(after.path))) sections.push("out");
    return { sections, addedEffects: after.effects.filter((e) => !before.effects.includes(e)) };
  }
  if (before.kind === "type" && after.kind === "type") {
    if (before.shape.kind !== after.shape.kind) {
      return { sections: [before.shape.kind, after.shape.kind], addedEffects: [] };
    }
    return { sections: shapeKey(before) === shapeKey(after) ? [] : [after.shape.kind], addedEffects: [] };
  }
  throw new Error("interfaceChange: the two versions differ in kind");
}

// Full names of the cases of a variant type; none for anything else.
export function casesOf(def: Definition): string[] {
  if (def.kind !== "type" || def.shape.kind !== "variant") return [];
  const module = moduleOf(def.path);
  return def.shape.cases.map((c) => pathText([...module, c.name]));
}
