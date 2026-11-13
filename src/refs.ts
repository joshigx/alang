// References from a definition to other definitions, resolved to full names
// with the checker's side tables. They feed the `refs` table of the database
// (callers, context) and the rewriting of references when a definition is
// renamed.
//
// The walk needs the CheckInfo of a clean check of the very tree it walks:
// side tables are keyed by node identity.

import type { Arm, Definition, Expr, Param, Path, Pattern, Payload, Stmt, TypeRef } from "./ast.ts";
import { moduleOf, pathText } from "./ast.ts";
import type { CheckInfo } from "./check.ts";
import { BUILTIN_TYPES } from "./types.ts";

// `case` references name a variant case by its full name (`net.port.OutOfRange`).
export type RefKind = "type" | "fn" | "case";

export interface Ref {
  readonly kind: RefKind;
  readonly full: string;
}

const BUILTIN_VALUES = new Set(["Ok", "Err", "Some", "None", "Unit", "Less", "Equal", "Greater"]);

// Every reference in `def`, in text order, duplicates included.
export function references(def: Definition, info: CheckInfo): Ref[] {
  const refs: Ref[] = [];
  mapReferences(def, info, (r) => {
    refs.push(r);
    return r.full;
  });
  return refs;
}

// Distinct full names `def` refers to, in order of first use: types,
// functions and variant cases (a case by its own full name, not its type's).
// Includes std names, and `def` itself if it recurses or has examples.
//
// The result depends on the text alone: locals are resolved within `def`,
// a short name always means the definition's own module, and a case and a
// type of one module never share a name. So the `refs` rows of a stored
// version never go stale.
export function dependencies(def: Definition, info: CheckInfo): string[] {
  return [...new Set(references(def, info).map((r) => r.full))];
}

// A full name as written in `module`: short inside it, full elsewhere (1.2).
export function writtenFrom(full: string, module: Path): Path {
  const segments = full.split(".");
  const own = moduleOf(segments);
  return pathText(own) === pathText(module) ? [segments[segments.length - 1]] : segments;
}

// Rebuilds `def` with every reference passed through `target`, which returns
// the full name the reference should denote. The result is named `path`
// (default: unchanged) and written from its module: a reference whose target
// and module are unchanged keeps its spelling; any other is written as
// `writtenFrom` gives it.
export function mapReferences(
  def: Definition,
  info: CheckInfo,
  target: (ref: Ref) => string,
  path: Path = def.path,
): Definition {
  const moved = pathText(moduleOf(def.path)) !== pathText(moduleOf(path));
  return rebuild(def, info, path, (_node, written, ref) => {
    const to = target(ref);
    return to === ref.full && !moved ? written : writtenFrom(to, moduleOf(path));
  });
}

// `def` with each name of its own module that is written in full shortened
// (1.2): exactly the nodes the checker reported as E0226 (`info.longForms`),
// so a full name that a local would capture keeps its spelling.
export function shortenOwnNames(def: Definition, info: CheckInfo): Definition {
  return rebuild(def, info, def.path, (node, written, ref) => {
    return info.longForms.has(node) ? writtenFrom(ref.full, moduleOf(def.path)) : written;
  });
}

// Rebuilds `def` under the name `path`, with the path of every reference
// given by `spell`: the node, its path as written, and what it refers to.
function rebuild(
  def: Definition,
  info: CheckInfo,
  path: Path,
  spell: (node: object, written: Path, ref: Ref) => Path,
): Definition {
  const oldModule = moduleOf(def.path);
  const resolve = (p: Path) => (p.length === 1 ? [...oldModule, p[0]].join(".") : pathText(p));

  const type = (t: TypeRef): TypeRef => {
    const args = t.args.map(type);
    if (t.path.length === 1 && BUILTIN_TYPES.has(t.path[0])) return { ...t, args };
    return { kind: "type", path: spell(t, t.path, { kind: "type", full: resolve(t.path) }), args };
  };
  const param = (p: Param): Param => ({ name: p.name, type: type(p.type) });

  const pattern = (p: Pattern): Pattern => {
    if (p.kind !== "case") return p;
    const sub = p.sub && pattern(p.sub);
    if (p.path.length === 1 && BUILTIN_VALUES.has(p.path[0])) return { ...p, sub };
    return { kind: "case", path: spell(p, p.path, { kind: "case", full: resolve(p.path) }), sub };
  };

  const payload = (p: Payload): Payload => {
    if (p === null) return null;
    if (p.kind === "value") return { kind: "value", value: expr(p.value) };
    return { kind: "args", args: p.args.map((a) => ({ name: a.name, value: expr(a.value) })) };
  };

  const stmts = (ss: readonly Stmt[]): Stmt[] => ss.map(stmt);
  const stmt = (s: Stmt): Stmt => {
    switch (s.kind) {
      case "let":
        return {
          kind: "let",
          name: s.name,
          type: type(s.type),
          value: expr(s.value),
          elseReturn: s.elseReturn && expr(s.elseReturn),
        };
      case "return":
        return { kind: "return", value: expr(s.value) };
      case "expr":
        return { kind: "expr", expr: expr(s.expr) };
    }
  };
  const arm = (a: Arm): Arm => ({ pattern: pattern(a.pattern), body: stmts(a.body) });

  function expr(e: Expr): Expr {
    switch (e.kind) {
      case "int":
      case "float":
      case "string":
      case "bool":
        return e;
      case "name": {
        const r = info.names.get(e);
        if (r?.kind !== "fn") return e;
        return { kind: "name", path: spell(e, e.path, { kind: "fn", full: r.name }) };
      }
      case "field":
        return { kind: "field", target: expr(e.target), field: e.field };
      case "call": {
        const full = info.calls.get(e) ?? resolve(e.path);
        return {
          kind: "call",
          path: spell(e, e.path, { kind: "fn", full }),
          typeArgs: e.typeArgs.map(type),
          args: e.args.map((a) => ({ name: a.name, value: expr(a.value) })),
        };
      }
      case "construct": {
        const r = info.constructs.get(e);
        const ref: Ref | null = !r || r.kind === "builtin"
          ? null
          : r.kind === "record"
          ? { kind: "type", full: r.type }
          : { kind: "case", full: resolve(e.path) };
        return { kind: "construct", path: ref ? spell(e, e.path, ref) : e.path, payload: payload(e.payload) };
      }
      case "list":
        return { kind: "list", items: e.items.map(expr) };
      case "binary":
        return { kind: "binary", op: e.op, left: expr(e.left), right: expr(e.right) };
      case "not":
        return { kind: "not", operand: expr(e.operand) };
      case "if":
        return { kind: "if", cond: expr(e.cond), then: stmts(e.then), else: e.else && stmts(e.else) };
      case "match":
        return { kind: "match", subject: expr(e.subject), arms: e.arms.map(arm) };
      case "for":
        return { kind: "for", name: e.name, type: type(e.type), iterable: expr(e.iterable), body: stmts(e.body) };
      case "lambda":
        return { kind: "lambda", params: e.params.map(param), out: type(e.out), body: expr(e.body) };
    }
  }

  if (def.kind === "fn") {
    return {
      kind: "fn",
      path,
      doc: def.doc,
      params: def.params.map(param),
      out: type(def.out),
      effects: def.effects,
      requires: def.requires && expr(def.requires),
      ensures: def.ensures && expr(def.ensures),
      examples: def.examples.map(expr),
      body: stmts(def.body),
    };
  }
  return {
    kind: "type",
    path,
    doc: def.doc,
    shape: def.shape.kind === "record" ? { kind: "record", fields: def.shape.fields.map(param) } : {
      kind: "variant",
      cases: def.shape.cases.map((c) => ({ name: c.name, payload: c.payload && type(c.payload) })),
    },
    where: def.where && expr(def.where),
  };
}
