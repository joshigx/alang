// Rule 5.1: every function with `effects: none` has at least one example, and
// a definition whose example fails is rejected. Examples run at acceptance
// (toolchain.ts); this file turns their results into diagnostics (5.5).
//
// A failing example reports the value the call returned, as alang text, so
// that the caller can decide whether the body or the example is wrong. There
// is deliberately no fix: replacing the expected value with the actual one
// would write a bug into the example.

import type { Definition, Expr, FnDef, MapEntry, Path } from "./ast.ts";
import { moduleOf, pathText } from "./ast.ts";
import type { CheckInfo, TypeShape } from "./check.ts";
import { toTypeRef, writable } from "./check.ts";
import { type Diagnostic, diagnostic } from "./diagnostic.ts";
import { printConst, printExpr, printTypeRef } from "./printer.ts";
import {
  type ConstantResult,
  type ExampleResult,
  map_entries,
  type SortedMap,
  std$text$show,
  type TrapInfo,
} from "./runtime.ts";
import { type Subst, substitute, type Type } from "./types.ts";

// ---- presence ----

// Whether a pure function without parameters can be written as a constant
// that says the same: its result is neither `Unit` nor a function type
// (E0248), and it has no contract, which a constant has no section for.
export function asConstant(def: FnDef): boolean {
  const unit = def.out.kind === "type" && def.out.path.length === 1 && def.out.path[0] === "Unit";
  return def.out.kind !== "function" && !unit && def.requires === null && def.ensures === null;
}

export function missingExamples(defs: readonly Definition[]): Diagnostic[] {
  return defs
    .filter((d): d is FnDef => d.kind === "fn" && d.effects.length === 0 && d.examples.length === 0)
    .map((def) => {
      const short = def.path[def.path.length - 1];
      // A constant is not generic (G11), so a generic function keeps its
      // form, and has a body, which an extern lacks (E1).
      if (def.params.length === 0 && def.typeParams.length === 0 && def.target === null && asConstant(def)) {
        // A constant written the long way (C6): it stays legal for now
        // (E0405 is reserved for rejecting it), but the fix is the constant.
        return diagnostic({
          code: "E0401",
          definition: pathText(def.path),
          section: "examples",
          at: "examples: none",
          message: `\`${short}\` has no parameters and no effects, so it always gives the same value: write it as a ` +
            `constant, \`const ${pathText(def.path)}\`, which needs no example.`,
          expected: printConst({ kind: "const", path: def.path, doc: def.doc, out: def.out, body: def.body }),
        });
      }
      const params = def.params.map((p) => `${p.name}: ${printTypeRef(p.type)}`).join(", ");
      return diagnostic({
        code: "E0401",
        definition: pathText(def.path),
        section: "examples",
        at: "examples: none",
        message: `\`${short}\` has \`effects: none\` and needs at least one example (5.1): a call and the value it ` +
          "returns, in the form shown under `expected`.",
        expected: `${short}(${params}) == ${printTypeRef(def.out)}`,
      });
    });
}

// ---- results ----

export interface ExampleOutcome {
  readonly definition: string;
  // The whole example, as printed.
  readonly text: string;
  // Its left side, the call.
  readonly call: string;
  readonly passed: boolean;
  // The value of the call as alang text; null if the example trapped.
  readonly actual: string | null;
  readonly trap: TrapInfo | null;
}

// Pairs the results of the generated `$examples` (in definition order, then
// example order, as the emitter writes them) with their syntax, and renders
// each actual value with the static type of its call.
export function describeResults(
  defs: readonly Definition[],
  info: CheckInfo,
  results: readonly ExampleResult[],
): ExampleOutcome[] {
  const examples = defs.flatMap((d) => (d.kind === "fn" ? d.examples.map((ex) => ({ def: d, ex })) : []));
  if (examples.length !== results.length) {
    throw new Error(`expected ${examples.length} example results, got ${results.length}`);
  }
  return results.map((r, i) => {
    const { def, ex } = examples[i];
    if (ex.kind !== "binary") throw new Error(`not an example: ${r.text}`);
    const type = info.types.get(ex.left);
    const module = pathText(moduleOf(def.path));
    return {
      definition: r.definition,
      text: r.text,
      call: printExpr(ex.left, ""),
      passed: r.passed,
      actual: r.trap || !type ? null : showValue(r.actual, type, info.shapes, module),
      trap: r.trap,
    };
  });
}

export function exampleDiagnostics(outcomes: readonly ExampleOutcome[]): Diagnostic[] {
  return outcomes.filter((o) => !o.passed).map((o) => {
    const base = { definition: o.definition, section: "examples", at: o.text };
    if (o.trap) {
      const { kind, at, message } = o.trap;
      // The trap's own location, unless the message already quotes it or it is the example itself.
      const where = at === o.text || message.includes(at) ? "" : ` (at \`${at}\`)`;
      return diagnostic({
        ...base,
        code: "E0403",
        message: `The example ends in a trap (\`${kind}\`). ${message.replace(/\.$/, "")}${where}.`,
      });
    }
    return diagnostic({
      ...base,
      code: "E0402",
      message: `The example does not hold: \`${o.call}\` is \`${o.actual}\`.`,
    });
  });
}

// E0404 (C4): a constant whose evaluation at acceptance traps, reported where
// the trap came from, once per cause. A constant that traps only because one
// it uses does is that one's E0404; a cycle is reported once, at the first
// of its constants that acceptance evaluated.
export function constantDiagnostics(results: readonly ConstantResult[]): Diagnostic[] {
  const reported = new Set<string>();
  const out: Diagnostic[] = [];
  for (const r of results) {
    if (r.trap === null || r.origin !== r.definition) continue;
    if (r.cycle !== null && r.cycle.every((n) => reported.has(n))) continue;
    for (const n of r.cycle ?? [r.definition]) reported.add(n);
    const { kind, at, message } = r.trap;
    const where = at === r.definition || message.includes(at) ? "" : ` (at \`${at}\`)`;
    out.push(diagnostic({
      code: "E0404",
      definition: r.definition,
      section: "body",
      at: `const ${r.definition}`,
      message: `Evaluating the constant ends in a trap (\`${kind}\`). ${message.replace(/\.$/, "")}${where}.`,
    }));
  }
  return out;
}

// ---- values as alang text ----

// A runtime value of type `t` as canonical alang text, written as it would
// be in `module` (rule 1.2). Values without an alang form (function values,
// which no actual value holds since no `fn` returns one, and empty lists and
// maps whose type holds a function type without parameters, which has no
// written form: F5) fall back to std.text.show.
export function showValue(value: unknown, t: Type, shapes: ReadonlyMap<string, TypeShape>, module: string): string {
  const e = valueExpr(value, t, shapes, module);
  return e ? printExpr(e, "") : std$text$show(value);
}

const construct = (path: Path, value: Expr | null = null): Expr => ({
  kind: "construct",
  path,
  typeArgs: [],
  payload: value ? { kind: "value", value } : null,
});

export function valueExpr(
  value: unknown,
  t: Type,
  shapes: ReadonlyMap<string, TypeShape>,
  module: string,
): Expr | null {
  if (t.k !== "con") return null;
  const go = (v: unknown, type: Type) => valueExpr(v, type, shapes, module);
  const tagged = value as { readonly tag: string; readonly value?: unknown };
  switch (t.name) {
    case "Int":
      return { kind: "int", value: value as number };
    case "Float": {
      const n = value as number;
      if (Number.isFinite(n)) return { kind: "float", value: n };
      // There is no literal for infinity.
      return {
        kind: "binary",
        op: "/",
        left: { kind: "float", value: n > 0 ? 1 : -1 },
        right: { kind: "float", value: 0 },
      };
    }
    case "Bool":
      return { kind: "bool", value: value as boolean };
    case "String":
      return { kind: "string", value: value as string };
    case "Unit":
      return construct(["Unit"]);
    case "Order":
      return construct([tagged.tag]);
    case "Option":
    case "Result": {
      if (tagged.tag === "None") return construct(["None"]);
      const inner = go(tagged.value, t.args[tagged.tag === "Err" ? 1 : 0]);
      return inner && construct([tagged.tag], inner);
    }
    case "List": {
      // A literal; the empty list has its one spelling with the item type (E0228).
      const values = value as readonly unknown[];
      if (values.length === 0) return empty(["std", "list", "empty"], t.args, module);
      const items: Expr[] = [];
      for (const item of values) {
        const v = go(item, t.args[0]);
        if (!v) return null;
        items.push(v);
      }
      return { kind: "list", items };
    }
    case "Map": {
      // A literal in key order, so equal maps print alike; the empty map has
      // its one spelling with its types (E0228).
      const m = value as SortedMap<unknown, unknown>;
      if (m.size === 0) return empty(["std", "map", "empty"], t.args, module);
      const entries: MapEntry[] = [];
      for (const [k, v] of map_entries(m)) {
        const key = go(k, t.args[0]);
        const val = go(v, t.args[1]);
        if (!key || !val) return null;
        entries.push({ key, value: val });
      }
      return { kind: "map", entries };
    }
  }
  const shape = shapes.get(t.name);
  if (!shape) return null;
  // A generic type's fields and case values hold its type parameters, which
  // the value's type arguments give (G8).
  const s: Subst = new Map(shape.typeParams.map((tp, i) => [tp, t.args[i]]));
  if (shape.kind === "record") {
    const fields = value as Record<string, unknown>;
    const args = [];
    for (const f of shape.fields) {
      const v = go(fields[f.name], substitute(f.type, s));
      if (!v) return null;
      args.push({ name: f.name, value: v });
    }
    return { kind: "construct", path: written(t.name, module), typeArgs: [], payload: { kind: "args", args } };
  }
  const c = shape.cases.find((c) => c.name === tagged.tag);
  if (!c) return null;
  const path = written(`${pathText(moduleOf(t.name.split(".")))}.${c.name}`, module);
  if (!c.payload) return construct(path);
  const inner = go(tagged.value, substitute(c.payload, s));
  return inner && construct(path, inner);
}

// `std.list.empty<T>()` or `std.map.empty<K, V>()`; null if a type
// argument cannot be written (H5), so that the value falls back to `show`.
function empty(path: Path, types: readonly Type[], module: string): Expr | null {
  if (!types.every(writable)) return null;
  return { kind: "call", path, typeArgs: types.map((a) => toTypeRef(a, module)), args: [] };
}

// A full name as written in `module`: short inside it, full elsewhere (1.2).
function written(full: string, module: string): Path {
  const prefix = module + ".";
  const rest = full.slice(prefix.length);
  return full.startsWith(prefix) && !rest.includes(".") ? [rest] : full.split(".");
}
