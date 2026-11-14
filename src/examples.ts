// Rule 5.1: every function with `effects: none` has at least one example, and
// a definition whose example fails is rejected. Examples run at acceptance
// (toolchain.ts); this file turns their results into diagnostics (5.5).
//
// A failing example reports the value the call returned, as alang text, so
// that the caller can decide whether the body or the example is wrong. There
// is deliberately no fix: replacing the expected value with the actual one
// would write a bug into the example.

import { relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Definition, Expr, FnDef, MapEntry, Path } from "./ast.ts";
import { moduleOf, pathText } from "./ast.ts";
import type { CheckInfo, TypeShape } from "./check.ts";
import { toTypeRef, writable } from "./check.ts";
import { type Diagnostic, diagnostic } from "./diagnostic.ts";
import { printConst, printExpr, printString, printTypeRef } from "./printer.ts";
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

// ---- foreign code at acceptance (E10) ----

// How the separate process that ran a program's constants and examples
// ended (toolchain.ts, `runIsolated`), when it gave no usable results.
export type IsolationFailure =
  // An `extern fn`'s module exports no function of its name.
  | {
    readonly kind: "missing";
    readonly missing: readonly { readonly definition: string; readonly target: string; readonly functions: string[] }[];
  }
  // Stopped at the time limit, during the item it last started (null: while
  // loading its modules).
  | { readonly kind: "killed"; readonly last: { readonly kind: "constant" | "example"; readonly index: number } | null }
  // Ended without a result: a module did not load, or ended the process.
  | { readonly kind: "failed"; readonly code: number; readonly stderr: string };

export interface IsolationContext {
  readonly defs: readonly Definition[];
  // The directory targets are relative to (2.2).
  readonly base: string;
  readonly limitMs: number;
}

// The externs of a program by their target module (`./text.ts`), in the order
// of their first extern; each list in definition order.
export function externsByModule(defs: readonly Definition[]): Map<string, FnDef[]> {
  const modules = new Map<string, FnDef[]>();
  for (const d of defs) {
    if (d.kind !== "fn" || d.target === null) continue;
    const module = d.target.slice(0, d.target.indexOf("#"));
    modules.set(module, [...(modules.get(module) ?? []), d]);
  }
  return modules;
}

const names = (defs: readonly FnDef[]) => {
  const all = defs.map((d) => `\`${pathText(d.path)}\``);
  return all.length === 1 ? all[0] : `${all.slice(0, -1).join(", ")} and ${all[all.length - 1]}`;
};

const targetDiagnostic = (def: FnDef, message: string): Diagnostic =>
  diagnostic({
    code: "E0406",
    definition: pathText(def.path),
    section: "target",
    at: `target: ${printString(def.target!)}`,
    message,
  });

// E0406 for a target module that is not there: once per module, at its
// first extern. `path` is where it was looked for.
export function missingModuleDiagnostic(module: string, defs: readonly FnDef[], path: string): Diagnostic {
  return targetDiagnostic(
    defs[0],
    `The module \`${module}\` of ${names(defs)} does not exist: write it at \`${path}\`.`,
  );
}

// E0408: the tool may not start the separate process. Never a fallback to
// running the foreign code in the tool's own process.
export function noRunPermission(defs: readonly Definition[]): Diagnostic {
  const first = defs.find((d): d is FnDef => d.kind === "fn" && d.target !== null);
  return diagnostic({
    code: "E0408",
    definition: first ? pathText(first.path) : null,
    at: first ? `extern fn ${pathText(first.path)}` : "<program>",
    message: "A program with an `extern fn` runs its examples in a separate process without permissions, and this " +
      "tool may not start one. Start it with `--allow-run`; for the MCP server: `deno run --allow-read " +
      "--allow-write --allow-run <path>/src/cli.ts mcp --dir <dir>` (README).",
  });
}

const seconds = (ms: number) => `${ms / 1000} seconds`;

// E0406 and E0407: what a separate process that gave no results means for the
// program (5.6: one diagnostic per cause).
export function isolationDiagnostics(failure: IsolationFailure, context: IsolationContext): Diagnostic[] {
  const { defs, base, limitMs } = context;
  switch (failure.kind) {
    case "missing":
      return failure.missing.map((m) => {
        const def = defs.find((d): d is FnDef => d.kind === "fn" && pathText(d.path) === m.definition)!;
        const [module, name] = m.target.split("#");
        const known = m.functions.length > 0
          ? `its functions are ${m.functions.map((f) => `\`${f}\``).join(", ")}`
          : "it exports no function";
        return targetDiagnostic(def, `\`${module}\` exports no function \`${name}\`; ${known}.`);
      });
    case "killed": {
      const last = failure.last;
      if (last === null) {
        return [diagnostic({
          code: "E0407",
          definition: null,
          at: "<program>",
          message: `Loading the program's modules did not end within ${seconds(limitMs)}.`,
        })];
      }
      if (last.kind === "constant") {
        const constant = defs.filter((d) => d.kind === "const")[last.index];
        const name = pathText(constant.path);
        return [diagnostic({
          code: "E0407",
          definition: name,
          section: "body",
          at: `const ${name}`,
          message: `Evaluating the constant did not end within ${seconds(limitMs)}, so its process was stopped.`,
        })];
      }
      const example = defs.flatMap((d) => (d.kind === "fn" ? d.examples.map((ex) => ({ d, ex })) : []))[last.index];
      return [diagnostic({
        code: "E0407",
        definition: pathText(example.d.path),
        section: "examples",
        at: printExpr(example.ex, ""),
        message: `The example did not end within ${seconds(limitMs)}, so its process was stopped: foreign code ` +
          "that never returns, or a recursion too slow for an example.",
      })];
    }
    case "failed": {
      const modules = externsByModule(defs);
      // The module whose URL the host names first is the one that failed.
      let blamed: [string, FnDef[]] | null = null;
      let at = Infinity;
      for (const [module, users] of modules) {
        const i = failure.stderr.indexOf(pathToFileURL(resolve(base, module)).href);
        if (i >= 0 && i < at) [blamed, at] = [[module, users], i];
      }
      const lines = failure.stderr.split("\n").map((l) => l.trim()).filter((l) => l !== "");
      if (blamed === null) {
        return [diagnostic({
          code: "E0406",
          definition: null,
          at: "<program>",
          message: `The examples' process ended without a result (exit code ${failure.code}): ${
            lines[0] ?? "no output"
          }.`.replace(/\.\.$/, "."),
        })];
      }
      const [module, users] = blamed;
      const cause = (lines[0] ?? "").replace(/^error: /, "").replace(/\.$/, "");
      const where = /at (file:\/\/\S+?):(\d+):(\d+)/.exec(failure.stderr);
      const located = where ? ` (at \`${relativeTo(base, fileURLToPath(where[1]))}:${where[2]}:${where[3]}\`)` : "";
      return [
        targetDiagnostic(users[0], `The module \`${module}\` of ${names(users)} cannot be loaded: ${cause}${located}.`),
      ];
    }
  }
}

// A path as a target writes it: from `base`, starting `./`.
function relativeTo(base: string, path: string): string {
  const r = relative(base, path).replaceAll("\\", "/");
  return r.startsWith(".") ? r : `./${r}`;
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
