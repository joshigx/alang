// Type and effect checker. Types flow forward only (rule 1.4): the type of an
// expression follows from the expected type and the text to its left.
// Effects (2.1) are checked per call: a caller declares the effects of every
// function it calls; lambdas, function values and conditions are pure.
//
// The checker does not change the syntax tree. What later stages need
// (expression types, how names resolved) goes into side tables keyed by
// tree node, so the tree stays pure for equality and hashing (6.1).

import type { Arg, Definition, Expr, FnDef, Literal, Path, Pattern, Stmt, TypeDef, TypeRef } from "./ast.ts";
import { type Effect, EFFECTS, moduleOf, pathText } from "./ast.ts";
import { type Diagnostic, diagnostic, type Fix } from "./diagnostic.ts";
import { printExpr, printStmts, printString, printTypeRef } from "./printer.ts";
import { type Signature, STD, STD_TYPES } from "./std.ts";
import {
  BOOL,
  BUILTIN_TYPES,
  con,
  containsError,
  containsFn,
  ERROR,
  fits,
  FLOAT,
  fnType,
  freeVars,
  INT,
  isBottom,
  isCon,
  list,
  map,
  NEVER,
  option,
  ORDER,
  showType,
  STRING,
  type Subst,
  substitute,
  type Type,
  typeEquals,
  unify,
  UNIT,
} from "./types.ts";

// ---- results ----

export type NameResolution = { readonly kind: "local" } | { readonly kind: "fn"; readonly name: string };

export type ConstructResolution =
  | { readonly kind: "builtin" }
  | { readonly kind: "record"; readonly type: string }
  | { readonly kind: "case"; readonly type: string };

export interface CheckInfo {
  // Resolved shape of every user and std type, by full name.
  readonly shapes: ReadonlyMap<string, TypeShape>;
  // Type of every checked expression.
  readonly types: WeakMap<Expr, Type>;
  // How each `name` expression resolved.
  readonly names: WeakMap<Expr, NameResolution>;
  // Full name of the function each call refers to.
  readonly calls: WeakMap<Expr, string>;
  // Calls of functions with effects. Such functions are async in the
  // generated TypeScript, so the emitter awaits these calls.
  readonly effectful: WeakSet<Expr>;
  readonly constructs: WeakMap<Expr, ConstructResolution>;
  // Type references, names, calls, constructions and patterns that name a
  // definition of their own module in full (E0226), where the short form
  // means the same.
  readonly longForms: WeakSet<object>;
  // `let` statements of type `Unit` whose E0235 carries a fix: the name is
  // never used, and dropping `let name: Unit = ` leaves a statement that
  // parses. The codebase applies that fix itself (refs.ts).
  readonly unitLets: WeakSet<Stmt>;
}

export interface CheckResult {
  readonly diagnostics: Diagnostic[];
  readonly info: CheckInfo;
}

export interface CheckOptions {
  // The standard library signatures; defaults to std.ts.
  readonly std?: readonly Signature[];
  // Definitions that names may refer to but that are neither checked nor
  // emitted, e.g. std types written in alang.
  readonly declarations?: readonly Definition[];
}

// ---- environment ----

export interface Param {
  readonly name: string;
  readonly type: Type;
}

interface FnSig {
  readonly name: string;
  readonly typeParams: readonly string[];
  readonly params: readonly Param[];
  readonly out: Type;
  readonly effects: readonly Effect[];
  // Type parameters that may not be bound to a type with function values (E0222).
  readonly withoutFunctions?: readonly string[];
}

export type TypeShape =
  | { readonly kind: "record"; readonly name: string; readonly fields: Param[] }
  | { readonly kind: "variant"; readonly name: string; readonly cases: CaseInfo[] };

export interface CaseInfo {
  readonly owner: string; // full name of the variant type; builtins use their type name
  readonly name: string;
  readonly payload: Type | null;
}

const BUILTIN_VALUES = new Set(["Ok", "Err", "Some", "None", "Unit", "Less", "Equal", "Greater"]);

class Env {
  readonly types = new Map<string, TypeShape>();
  readonly fns = new Map<string, FnSig>();
  // Full case name (`module.Case`) -> case.
  readonly cases = new Map<string, CaseInfo>();

  recordFields(name: string): readonly Type[] {
    const t = this.types.get(name);
    if (!t) return [];
    return t.kind === "record" ? t.fields.map((f) => f.type) : t.cases.flatMap((c) => (c.payload ? [c.payload] : []));
  }
}

export function checkProgram(defs: readonly Definition[], options: CheckOptions = {}): CheckResult {
  const diagnostics: Diagnostic[] = [];
  const env = new Env();
  const info: CheckInfo = {
    shapes: env.types,
    types: new WeakMap(),
    names: new WeakMap(),
    calls: new WeakMap(),
    effectful: new WeakSet(),
    constructs: new WeakMap(),
    longForms: new WeakSet(),
    unitLets: new WeakSet(),
  };
  for (const s of options.std ?? STD) env.fns.set(s.name, s);

  const all = [...STD_TYPES, ...(options.declarations ?? []), ...defs];
  const checkers = new Map<Definition, DefChecker>();
  const seen = new Set<string>();

  // Pass 1: names of all types, so that signatures can refer to any of them.
  for (const def of all) {
    const c = new DefChecker(def, env, info, diagnostics);
    checkers.set(def, c);
    const name = pathText(def.path);
    if (seen.has(name)) {
      c.report("E0215", `${def.kind} ${name}`, `\`${name}\` is defined twice.`);
      checkers.delete(def);
      continue;
    }
    seen.add(name);
    const last = def.path[def.path.length - 1];
    if (def.kind === "type" && (BUILTIN_TYPES.has(last) || BUILTIN_VALUES.has(last))) {
      c.report(
        "E0215",
        `type ${name}`,
        `\`${last}\` is a built-in name and is always written short (1.2); choose another name.`,
      );
      checkers.delete(def);
      continue;
    }
    if (def.path[0] === "std" && defs.includes(def)) {
      c.report("E0215", `${def.kind} ${name}`, "The module `std` is reserved for the standard library.");
      checkers.delete(def);
      continue;
    }
    if (def.kind === "type") {
      env.types.set(
        name,
        def.shape.kind === "record" ? { kind: "record", name, fields: [] } : { kind: "variant", name, cases: [] },
      );
    }
  }
  // Pass 2: signatures, fields and cases.
  for (const def of all) checkers.get(def)?.declare();
  // Pass 3: bodies and conditions of the checked definitions.
  for (const def of defs) checkers.get(def)?.check();

  return { diagnostics, info };
}

// ---- scopes ----

class Scope {
  private readonly vars = new Map<string, Type>();
  // Names of this scope that a name expression has read.
  private readonly used = new Set<string>();
  constructor(private readonly parent: Scope | null = null) {}

  child(): Scope {
    return new Scope(this);
  }

  lookup(name: string): Type | undefined {
    return this.vars.get(name) ?? this.parent?.lookup(name);
  }

  define(name: string, type: Type): void {
    this.vars.set(name, type);
  }

  // Marks a read of `name` in the scope that defines it.
  use(name: string): void {
    if (this.vars.has(name)) this.used.add(name);
    else this.parent?.use(name);
  }

  isUsed(name: string): boolean {
    return this.used.has(name);
  }

  visibleNames(): string[] {
    return [...this.vars.keys(), ...(this.parent?.visibleNames() ?? [])];
  }
}

type Mode = { readonly discard: true } | { readonly discard: false; readonly expected: Type | null };
const DISCARD: Mode = { discard: true };
const value = (expected: Type | null): Mode => ({ discard: false, expected });

// ---- per definition ----

class DefChecker {
  private readonly module: string;
  private readonly name: string;
  private section: string | null = null;
  // Result type for `return`, null outside a body.
  private out: Type | null = null;
  private inLambda = false;
  // Whether that lambda stands where a function with effects is allowed
  // (the handler of `std.http.serve`); only the advice of E0232 differs.
  private lambdaMayAct = false;
  // Effects the body triggers but the signature does not declare, with the
  // first call that triggers them (one diagnostic per definition).
  private missingEffects = new Set<Effect>();
  private firstMissing: { at: string } | null = null;

  constructor(
    private readonly def: Definition,
    private readonly env: Env,
    private readonly info: CheckInfo,
    private readonly diagnostics: Diagnostic[],
  ) {
    this.module = pathText(moduleOf(def.path));
    this.name = pathText(def.path);
  }

  report(code: string, at: string, message: string, extra: { expected?: string; fix?: Fix } = {}): void {
    // An unknown name used several times is one cause (5.6).
    const unknownName = code === "E0201" || code === "E0202" || code === "E0203";
    if (
      unknownName &&
      this.diagnostics.some((d) => d.definition === this.name && d.code === code && d.message === message)
    ) {
      return;
    }
    this.diagnostics.push(diagnostic({
      code,
      definition: this.name,
      section: this.section,
      at,
      message,
      expected: extra.expected ?? null,
      fix: extra.fix ?? null,
    }));
  }

  private show(t: Type): string {
    return showType(t, this.module);
  }

  // A full name as it is written from this module (rule 1.2).
  private written(full: string): string {
    const prefix = this.module + ".";
    return full.startsWith(prefix) && !full.slice(prefix.length).includes(".") ? full.slice(prefix.length) : full;
  }

  private resolvePath(path: Path): string {
    return path.length === 1 ? `${this.module}.${path[0]}` : pathText(path);
  }

  // Rule 1.2: a name of this module is written short. Called once the name
  // is known to exist; the long form is reported with the short one as fix
  // and otherwise resolved as usual, so nothing follows from it (5.6). The
  // node is recorded, so that the codebase can apply the fix itself.
  private shortForm(node: object, path: Path, at: string): void {
    if (path.length === 1 || pathText(moduleOf(path)) !== this.module) return;
    this.info.longForms.add(node);
    const written = pathText(path);
    const short = path[path.length - 1];
    this.report("E0226", at, `\`${written}\` is in this module, so it is written short: \`${short}\` (1.2).`, {
      expected: short,
      fix: { replace: written, with: short },
    });
  }

  // ---- declarations ----

  declare(): void {
    const def = this.def;
    if (def.kind === "fn") {
      this.section = "in";
      const params: Param[] = [];
      for (const p of def.params) {
        if (params.some((q) => q.name === p.name)) {
          this.report("E0215", `${p.name}: ${printTypeRef(p.type)}`, `Parameter \`${p.name}\` is declared twice.`);
        }
        params.push({ name: p.name, type: this.resolveType(p.type) });
      }
      this.section = "out";
      const out = this.resolveType(def.out);
      this.section = null;
      this.env.fns.set(this.name, { name: this.name, typeParams: [], params, out, effects: def.effects });
      return;
    }
    const t = this.env.types.get(this.name);
    if (!t) return;
    if (def.shape.kind === "record" && t.kind === "record") {
      this.section = "record";
      for (const f of def.shape.fields) {
        if (t.fields.some((g) => g.name === f.name)) {
          this.report("E0215", `${f.name}: ${printTypeRef(f.type)}`, `Field \`${f.name}\` is declared twice.`);
        }
        t.fields.push({ name: f.name, type: this.resolveType(f.type) });
      }
    } else if (def.shape.kind === "variant" && t.kind === "variant") {
      this.section = "variant";
      for (const c of def.shape.cases) {
        const full = `${this.module}.${c.name}`;
        const at = c.payload ? `${c.name}: ${printTypeRef(c.payload)}` : c.name;
        if (BUILTIN_VALUES.has(c.name) || BUILTIN_TYPES.has(c.name)) {
          this.report("E0215", at, `\`${c.name}\` is a built-in name; choose another case name.`);
          continue;
        }
        if (this.env.cases.has(full)) {
          this.report(
            "E0215",
            at,
            `Case \`${c.name}\` already exists in module \`${this.module}\`; case names are unique per module.`,
          );
          continue;
        }
        if (this.env.types.has(full)) {
          this.report("E0215", at, `Case \`${c.name}\` has the same name as the type \`${full}\`.`);
          continue;
        }
        const info: CaseInfo = {
          owner: this.name,
          name: c.name,
          payload: c.payload ? this.resolveType(c.payload) : null,
        };
        t.cases.push(info);
        this.env.cases.set(full, info);
      }
    }
    this.section = null;
  }

  private resolveType(ref: TypeRef): Type {
    const args = ref.args.map((a) => this.resolveType(a));
    if (ref.path.length === 1 && BUILTIN_TYPES.has(ref.path[0])) {
      const arity = BUILTIN_TYPES.get(ref.path[0])!;
      if (args.length !== arity) {
        this.report(
          "E0209",
          printTypeRef(ref),
          arity === 0
            ? `\`${ref.path[0]}\` takes no type arguments.`
            : `\`${ref.path[0]}\` takes ${arity} type argument${arity === 1 ? "" : "s"}.`,
        );
        return ERROR;
      }
      if (ref.path[0] === "Map" && !keyOk(args[0])) {
        this.badKey(printTypeRef(ref), args[0]);
        return ERROR;
      }
      return con(ref.path[0], ...args);
    }
    const full = this.resolvePath(ref.path);
    if (!this.env.types.has(full)) {
      const written = pathText(ref.path);
      const candidates = [
        ...BUILTIN_TYPES.keys(),
        ...[...this.env.types.keys()].map((n) => this.written(n)),
      ];
      const suggestion = closest(written, candidates);
      this.report("E0202", printTypeRef(ref), `Unknown type \`${written}\`.`, {
        expected: suggestion ?? undefined,
        fix: suggestion ? { replace: written, with: suggestion } : undefined,
      });
      return ERROR;
    }
    this.shortForm(ref, ref.path, printTypeRef(ref));
    if (args.length > 0) {
      this.report("E0209", printTypeRef(ref), `\`${pathText(ref.path)}\` takes no type arguments.`);
      return ERROR;
    }
    return con(full);
  }

  // ---- definitions ----

  check(): void {
    const def = this.def;
    if (def.kind === "fn") this.checkFn(def);
    else this.checkType(def);
  }

  private checkFn(def: FnDef): void {
    const sig = this.env.fns.get(this.name)!;
    const params = new Scope();
    for (const p of sig.params) params.define(p.name, p.type);

    if (def.requires) {
      this.section = "requires";
      this.expr(def.requires, params, BOOL);
    }
    if (def.ensures) {
      this.section = "ensures";
      const scope = params.child();
      scope.define("result", sig.out);
      this.expr(def.ensures, scope, BOOL);
    }
    this.section = "examples";
    for (const ex of def.examples) {
      if (ex.kind === "binary" && ex.left.kind === "call") {
        const callee = this.resolvePath(ex.left.path);
        if (callee !== this.name) {
          this.report(
            "E0221",
            printExpr(ex, ""),
            `An example calls the function it belongs to, \`${this.written(this.name)}\`.`,
          );
          continue;
        }
      }
      this.expr(ex, new Scope(), BOOL);
    }

    this.section = "body";
    this.out = sig.out;
    this.block(def.body, params, DISCARD);
    const last = def.body[def.body.length - 1];
    if (last.kind !== "return") {
      this.report("E0218", firstLine(printStmts([last], "")), "A function ends with an explicit `return` (3.4).");
    }
    if (this.firstMissing) {
      const missing = EFFECTS.filter((e) => this.missingEffects.has(e));
      const line = (effects: readonly string[]) => `effects: ${effects.length === 0 ? "none" : effects.join(", ")}`;
      const fixed = EFFECTS.filter((e) => def.effects.includes(e) || this.missingEffects.has(e));
      // Located at the effects line, where the fix applies; the message
      // quotes the call that triggers the effect.
      this.section = "effects";
      this.report(
        "E0230",
        line(def.effects),
        `\`${this.written(this.name)}\` triggers ${
          missing.map((e) => `\`${e}\``).join(", ")
        } (first through \`${this.firstMissing.at}\`) but does not declare ${
          missing.length === 1 ? "it" : "them"
        }; a caller declares the effects of everything it calls (2.1).`,
        { expected: line(fixed), fix: { replace: line(def.effects), with: line(fixed) } },
      );
    }
    this.out = null;
    this.section = null;
  }

  private checkType(def: TypeDef): void {
    if (!def.where) return;
    this.section = "where";
    const t = this.env.types.get(this.name);
    if (t?.kind !== "record") {
      this.report(
        "E0225",
        printExpr(def.where, ""),
        "`where` on a variant type is not supported yet; it is open which name refers to the value.",
      );
      return;
    }
    const scope = new Scope();
    for (const f of t.fields) scope.define(f.name, f.type);
    this.expr(def.where, scope, BOOL);
    this.section = null;
  }

  // ---- statements ----

  private bind(scope: Scope, name: string, type: Type, at: string): void {
    if (scope.lookup(name) !== undefined) {
      this.report(
        "E0216",
        at,
        `\`${name}\` is already bound here; every name has exactly one meaning in a body (2.6). Choose a new name.`,
      );
    }
    scope.define(name, type);
  }

  // Checks a block. In value mode the result is the type of the block's
  // value; in discard mode it is Unit, or Never if the block always returns.
  private block(stmts: readonly Stmt[], outer: Scope, mode: Mode): Type {
    const scope = outer.child();
    let result: Type = UNIT;
    // `let` statements of type `Unit`, reported once the block is checked,
    // when it is known whether their names are used (E0235).
    const unitLets: Extract<Stmt, { kind: "let" }>[] = [];
    for (let i = 0; i < stmts.length; i++) {
      const s = stmts[i];
      const last = i === stmts.length - 1;
      if (result.k === "never") {
        this.report("E0218", firstLine(printStmts([s], "")), "This statement is never reached; it follows a `return`.");
        break;
      }
      switch (s.kind) {
        case "let":
          if (this.let(s, scope)) unitLets.push(s);
          result = this.noValue(s, last, mode, "`let`");
          break;
        case "propagate":
          this.propagate(s, scope);
          result = this.noValue(s, last, mode, "`… else return`");
          break;
        case "return":
          this.ret(s.value, scope);
          result = NEVER;
          break;
        case "expr":
          if (last && !mode.discard) result = this.expr(s.expr, scope, mode.expected);
          else result = this.discarded(s.expr, scope);
          break;
      }
    }
    for (const s of unitLets) this.unitLet(s, scope);
    return result;
  }

  // The value of a statement that has none: `Unit`, or E0204 if it ends a
  // block whose value is expected to be something else.
  private noValue(s: Stmt, last: boolean, mode: Mode, what: string): Type {
    if (last && !mode.discard && mode.expected && !fits(UNIT, mode.expected)) {
      this.report(
        "E0204",
        firstLine(printStmts([s], "")),
        `This block ends with ${what} and has no value; end it with an expression of type \`${
          this.show(mode.expected)
        }\`.`,
      );
      return ERROR;
    }
    return UNIT;
  }

  // E0235 (T3): a `let` binds no `Unit`, which carries nothing (3); the
  // statement is written without `let name: Unit = `. The fix drops it only
  // if nothing uses the name and what remains parses: `… end match else
  // return v` does not (the parser's E0101), so a block value with `else`
  // gets the form to write instead.
  private unitLet(s: Extract<Stmt, { kind: "let" }>, scope: Scope): void {
    const at = firstLine(printStmts([s], ""));
    const lead = "A `let` binds no `Unit`, which carries nothing (3): ";
    const kind = s.value.kind;
    if (s.elseReturn !== null && (kind === "if" || kind === "match" || kind === "for")) {
      this.report(
        "E0235",
        at,
        `${lead}bind the \`${kind}\` to a \`Result\` or an \`Option\` with \`let\` first, then propagate that name.`,
      );
      return;
    }
    const rest: Stmt = s.elseReturn === null
      ? { kind: "expr", expr: s.value }
      : { kind: "propagate", value: s.value, elseReturn: s.elseReturn };
    const expected = firstLine(printStmts([rest], ""));
    const used = scope.isUsed(s.name);
    const message = `${lead}write the statement without \`let ${s.name}: Unit = \`${
      used ? `, and \`Unit\` where \`${s.name}\` is used` : ""
    }.`;
    if (used) {
      this.report("E0235", at, message, { expected });
      return;
    }
    this.info.unitLets.add(s);
    this.report("E0235", at, message, { expected, fix: { replace: at, with: expected } });
  }

  // `expression else return value` (T1): a `Result` or an `Option` whose
  // content is `Unit`, propagated as by `let ... else` but with nothing to
  // bind. `error` is the `Err` value, or `Unit` for `None`.
  private propagate(s: Extract<Stmt, { kind: "propagate" }>, scope: Scope): void {
    const v = this.expr(s.value, scope, null);
    let error: Type = ERROR;
    if (isCon(v, "Option") || isCon(v, "Result")) {
      const option = isCon(v, "Option");
      error = option ? UNIT : v.args[1];
      const content = v.args[0];
      if (!isBottom(content) && !containsError(content) && !typeEquals(content, UNIT)) {
        const shown = this.show(content);
        this.report(
          "E0217",
          firstLine(printStmts([s], "")),
          `The \`${shown}\` inside \`${
            option ? "Some" : "Ok"
          }\` is discarded; bind it: \`let name: ${shown} = … else return …\`.`,
          { expected: `let name: ${shown} = ${firstLine(printExpr(s.value, ""))} else return …` },
        );
      }
    } else if (!isBottom(v) && !containsError(v)) {
      this.report(
        "E0224",
        firstLine(printExpr(s.value, "")),
        `\`else return\` takes the content of a \`Result\` or an \`Option\`, found \`${
          this.show(v)
        }\`; write the statement without \`else return …\`, and put the \`else\` of an \`if\` on a line of its own.`,
      );
    }
    const elseScope = scope.child();
    elseScope.define("error", error);
    this.ret(s.elseReturn, elseScope);
  }

  // Checks a `let`. Returns whether it binds `Unit` and raised nothing else,
  // so that one cause gives one diagnostic (5.6).
  private let(s: Extract<Stmt, { kind: "let" }>, scope: Scope): boolean {
    const before = this.diagnostics.length;
    const declared = this.resolveType(s.type);
    const at = firstLine(printStmts([s], ""));
    let content: Type;
    if (s.elseReturn) {
      const v = this.expr(s.value, scope, null);
      let inner: Type = ERROR;
      let error: Type = ERROR;
      if (isCon(v, "Option")) {
        inner = v.args[0];
        error = UNIT;
      } else if (isCon(v, "Result")) {
        inner = v.args[0];
        error = v.args[1];
      } else if (!isBottom(v) && !containsError(v)) {
        this.report(
          "E0224",
          printExpr(s.value, ""),
          `\`let ... else\` unpacks a \`Result\` or an \`Option\`, found \`${
            this.show(v)
          }\`. Bind it without \`else\`.`,
        );
      }
      if (!fits(inner, declared)) {
        this.report(
          "E0204",
          printTypeRef(s.type),
          `\`${printExpr(s.value, "")}\` holds \`${this.show(inner)}\`, not \`${this.show(declared)}\`.`,
          { expected: this.show(inner) },
        );
      }
      const elseScope = scope.child();
      elseScope.define("error", error);
      this.ret(s.elseReturn, elseScope);
      content = inner;
    } else {
      content = this.expr(s.value, scope, declared);
    }
    this.bind(scope, s.name, declared, at);
    // A long own-module name (E0226) is resolved as usual: another cause.
    const others = this.diagnostics.slice(before).filter((d) => d.code !== "E0226");
    return typeEquals(declared, UNIT) && typeEquals(content, UNIT) && others.length === 0;
  }

  private ret(valueExpr: Expr, scope: Scope): void {
    const at = `return ${firstLine(printExpr(valueExpr, ""))}`;
    if (this.inLambda) {
      this.report("E0219", at, "A lambda cannot `return` or use `let ... else`; its body is one expression.");
      this.expr(valueExpr, scope, null);
      return;
    }
    if (this.out === null) {
      this.report("E0219", at, "`return` and `let ... else` only appear in a function body.");
      this.expr(valueExpr, scope, null);
      return;
    }
    this.expr(valueExpr, scope, this.out);
  }

  // An expression statement whose value is not used.
  private discarded(e: Expr, scope: Scope): Type {
    if (e.kind === "if" || e.kind === "match" || e.kind === "for") {
      const t = this.blockExpr(e, scope, DISCARD);
      this.info.types.set(e, UNIT);
      return t;
    }
    const t = this.expr(e, scope, null);
    if (!isBottom(t) && !containsError(t) && !typeEquals(t, UNIT)) {
      const at = firstLine(printExpr(e, ""));
      // A `Result<Unit, E>` or `Option<Unit>` has nothing to bind (T4).
      if ((isCon(t, "Result") || isCon(t, "Option")) && typeEquals(t.args[0], UNIT)) {
        this.report(
          "E0217",
          at,
          `The value of type \`${this.show(t)}\` is discarded; propagate its error: \`… else return …\`.`,
          { expected: `${at} else return …` },
        );
      } else {
        this.report(
          "E0217",
          at,
          `The value of type \`${
            this.show(t)
          }\` is discarded. Bind it with \`let\`, or propagate an error with \`let ... else return\`.`,
        );
      }
    }
    return t.k === "never" ? NEVER : UNIT;
  }

  // ---- expressions ----

  private expr(e: Expr, scope: Scope, expected: Type | null): Type {
    const actual = this.infer(e, scope, expected);
    this.info.types.set(e, actual);
    if (expected !== null && !fits(actual, expected)) {
      this.mismatch(e, actual, expected);
      return ERROR;
    }
    return actual;
  }

  private mismatch(e: Expr, actual: Type, expected: Type): void {
    const at = firstLine(printExpr(e, ""));
    let message = `Expected \`${this.show(expected)}\`, found \`${this.show(actual)}\`.`;
    let fix: Fix | undefined;
    if (typeEquals(expected, FLOAT) && typeEquals(actual, INT)) {
      message += " There is no implicit conversion (2.6).";
      fix = e.kind === "int"
        ? { replace: at, with: printExpr({ kind: "float", value: e.value }, "") }
        : { replace: at, with: `std.int.to_float(value: ${at})` };
    }
    this.report("E0204", at, message, { expected: this.show(expected), fix });
  }

  private infer(e: Expr, scope: Scope, expected: Type | null): Type {
    switch (e.kind) {
      case "int":
        return INT;
      case "float":
        return FLOAT;
      case "string":
        return STRING;
      case "bool":
        return BOOL;
      case "name":
        return this.name_(e, scope, expected);
      case "field":
        return this.field(this.expr(e.target, scope, null), e.field, e);
      case "call":
        return this.call(e, scope, expected);
      case "construct":
        return this.construct(e, scope, expected);
      case "list":
        return this.listLiteral(e, scope, expected);
      case "map":
        return this.mapLiteral(e, scope, expected);
      case "binary":
        return this.binary(e, scope);
      case "not":
        this.expr(e.operand, scope, BOOL);
        return BOOL;
      case "if":
      case "match":
      case "for":
        return this.blockExpr(e, scope, value(expected));
      case "lambda":
        return this.lambda(e, scope, expected);
    }
  }

  private name_(e: Extract<Expr, { kind: "name" }>, scope: Scope, expected: Type | null): Type {
    const head = e.path[0];
    const local = scope.lookup(head);
    if (local !== undefined) {
      scope.use(head);
      this.info.names.set(e, { kind: "local" });
      let t = local;
      for (const seg of e.path.slice(1)) t = this.field(t, seg, e);
      return t;
    }
    const full = this.resolvePath(e.path);
    const fn = this.env.fns.get(full);
    if (fn) {
      // A local with the short name would take it (`by: compare` with a
      // parameter `compare`), so there the full name is the only spelling.
      if (scope.lookup(e.path[e.path.length - 1]) === undefined) this.shortForm(e, e.path, pathText(e.path));
      if (fn.typeParams.length > 0) {
        this.report(
          "E0210",
          pathText(e.path),
          `The generic function \`${pathText(e.path)}\` cannot be passed as a value; wrap it in a lambda.`,
        );
        return ERROR;
      }
      if (fn.effects.length > 0 && expected?.k === "fn" && expected.effects === "caller") {
        // A parameter that takes a function with effects (`std.http.serve`):
        // passing it counts like calling it, so the caller declares its
        // effects (2.1). Inside a lambda or a condition this is still an error.
        this.effectsOfCall(fn, pathText(e.path), pathText(e.path));
      } else if (fn.effects.length > 0) {
        this.report(
          "E0232",
          pathText(e.path),
          `\`${pathText(e.path)}\` has effects (${
            fn.effects.join(", ")
          }); a function passed as a value is pure, like a lambda (2.4). Apply effects per element with \`for\`.`,
        );
      }
      this.info.names.set(e, { kind: "fn", name: full });
      return fnType(fn.params.map((p) => p.type), fn.out);
    }
    const written = pathText(e.path);
    const candidates = e.path.length === 1
      ? [...scope.visibleNames(), ...this.moduleFnNames()]
      : [...this.env.fns.keys()].map((n) => this.written(n));
    const suggestion = closest(written, candidates);
    this.report("E0203", written, `Unknown name \`${written}\`.`, {
      expected: suggestion ?? undefined,
      fix: suggestion ? { replace: written, with: suggestion } : undefined,
    });
    return ERROR;
  }

  private moduleFnNames(): string[] {
    return [...this.env.fns.keys()].filter((n) => n.startsWith(this.module + ".")).map((n) => this.written(n));
  }

  private field(t: Type, field: string, e: Expr): Type {
    if (t.k === "error") return ERROR;
    const at = firstLine(printExpr(e, ""));
    const ut = t.k === "con" ? this.env.types.get(t.name) : undefined;
    if (ut?.kind !== "record") {
      this.report("E0212", at, `\`${this.show(t)}\` has no fields; \`.${field}\` needs a record.`);
      return ERROR;
    }
    const f = ut.fields.find((g) => g.name === field);
    if (!f) {
      const suggestion = closest(field, ut.fields.map((g) => g.name));
      this.report("E0212", at, `\`${this.show(t)}\` has no field \`${field}\`.`, {
        expected: ut.fields.map((g) => g.name).join(", "),
        fix: suggestion ? { replace: `.${field}`, with: `.${suggestion}` } : undefined,
      });
      return ERROR;
    }
    return f.type;
  }

  // Matches named arguments to parameters (rule 4.1: every argument carries
  // its name, in declaration order, none omitted). Reports at most one
  // structural problem; returns the argument for each parameter, if any.
  private matchArgs(
    params: readonly Param[],
    args: readonly Arg[],
    at: string,
    rebuild: (args: Arg[]) => string,
    noun: "parameter" | "field",
  ): (Arg | undefined)[] {
    const byName = params.map((p) => args.find((a) => a.name === p.name));
    const describe = (p: Param) => `${p.name}: ${this.show(p.type)}`;

    const unknown = args.findIndex((a) => !params.some((p) => p.name === a.name));
    if (unknown >= 0) {
      const a = args[unknown];
      const free = params.filter((p) => !args.some((b) => b.name === p.name));
      const target = free.includes(params[unknown])
        ? params[unknown]
        : free.find((p) => p.name === closest(a.name, free.map((q) => q.name))) ??
          (free.length === 1 ? free[0] : undefined);
      const fixed = target
        ? args.map((b, i) => (i === unknown ? { name: target.name, value: b.value } : b))
        : args.filter((_, i) => i !== unknown);
      this.report("E0207", at, `Unknown ${noun} name \`${a.name}\`.`, {
        expected: target ? describe(target) : params.map(describe).join(", ") || "no arguments",
        fix: { replace: at, with: rebuild(fixed) },
      });
      return byName;
    }
    const dup = args.findIndex((a, i) => args.findIndex((b) => b.name === a.name) !== i);
    if (dup >= 0) {
      this.report("E0206", at, `Argument \`${args[dup].name}\` is given twice.`, {
        fix: { replace: at, with: rebuild(args.filter((_, i) => i !== dup)) },
      });
      return byName;
    }
    const missing = params.filter((_, i) => byName[i] === undefined);
    if (missing.length > 0) {
      this.report(
        "E0205",
        at,
        `Missing argument \`${
          missing[0].name
        }\`; every argument appears at the call, there are no default values (2.6).`,
        { expected: describe(missing[0]) },
      );
      return byName;
    }
    if (args.some((a, i) => a.name !== params[i].name)) {
      const ordered = byName.filter((a): a is Arg => a !== undefined);
      this.report("E0208", at, "Arguments appear in declaration order (4.1).", {
        expected: params.map((p) => p.name).join(", "),
        fix: { replace: at, with: rebuild(ordered) },
      });
    }
    return byName;
  }

  private call(e: Extract<Expr, { kind: "call" }>, scope: Scope, expected: Type | null): Type {
    const at = firstLine(printExpr(e, ""));
    if (e.path.length > 1 && scope.lookup(e.path[0]) !== undefined) {
      this.report(
        "E0220",
        at,
        `There are no method calls (3.1); \`${e.path[0]}\` is a value. Pass it as a named argument instead.`,
      );
      for (const a of e.args) this.expr(a.value, scope, null);
      return ERROR;
    }
    const full = this.resolvePath(e.path);
    const sig = this.env.fns.get(full);
    if (!sig) {
      const written = pathText(e.path);
      const candidates = e.path.length === 1
        ? this.moduleFnNames()
        : [...this.env.fns.keys()].map((n) => this.written(n));
      const suggestion = closest(written, candidates);
      this.report("E0201", at, `Unknown function \`${written}\`.`, {
        expected: suggestion ?? undefined,
        fix: suggestion ? { replace: written, with: suggestion } : undefined,
      });
      for (const a of e.args) this.expr(a.value, scope, null);
      return ERROR;
    }
    this.info.calls.set(e, full);
    if (sig.effects.length > 0) this.info.effectful.add(e);
    this.shortForm(e, e.path, at);
    this.effectsOfCall(sig, pathText(e.path), at);

    // Type arguments are written exactly when a type parameter does not
    // occur in any parameter type, i.e. when the arguments cannot determine
    // it. This depends on the signature only, so each call has one spelling.
    const subst: Subst = new Map();
    const inParams = new Set<string>();
    for (const p of sig.params) freeVars(p.type, inParams);
    const explicit = sig.typeParams.some((tp) => !inParams.has(tp));
    const shown = `${pathText(e.path)}<${sig.typeParams.join(", ")}>`;
    if (explicit) {
      if (e.typeArgs.length !== sig.typeParams.length) {
        const guess = this.guessTypeArgs(sig, expected);
        const withArgs = guess ? printExpr({ ...e, typeArgs: guess }, "") : undefined;
        this.report(
          "E0209",
          at,
          `\`${pathText(e.path)}\` needs ${sig.typeParams.length} explicit type argument${
            sig.typeParams.length === 1 ? "" : "s"
          }: \`${shown}(...)\` (1.4).`,
          { expected: shown, fix: withArgs ? { replace: at, with: withArgs } : undefined },
        );
        return ERROR;
      }
      sig.typeParams.forEach((tp, i) => subst.set(tp, this.resolveType(e.typeArgs[i])));
    } else if (e.typeArgs.length > 0) {
      this.report(
        "E0209",
        at,
        `The arguments determine the type arguments of \`${pathText(e.path)}\`; remove \`<...>\`.`,
        { fix: { replace: at, with: printExpr({ ...e, typeArgs: [] }, "") } },
      );
    }

    const byName = this.matchArgs(sig.params, e.args, at, (args) => printExpr({ ...e, args }, ""), "parameter");
    sig.params.forEach((p, i) => {
      const a = byName[i];
      if (!a) return;
      const pt = substitute(p.type, subst);
      if (freeVars(pt).size === 0) {
        this.expr(a.value, scope, pt);
        return;
      }
      const t = this.expr(a.value, scope, null);
      if (!unify(pt, t, subst)) {
        this.report(
          "E0204",
          firstLine(printExpr(a.value, "")),
          `Expected \`${this.show(substitute(pt, subst))}\` for \`${p.name}\`, found \`${this.show(t)}\`.`,
          { expected: this.show(substitute(pt, subst)) },
        );
      }
    });
    // Arguments that matched no parameter were reported; still check them.
    for (const a of e.args) if (!byName.includes(a)) this.expr(a.value, scope, null);

    // Functions that compare or show their values (3.9).
    const withFn = (sig.withoutFunctions ?? []).find((tp) => {
      const t = subst.get(tp);
      return t !== undefined && containsFn(t, (n) => this.env.recordFields(n));
    });
    if (withFn !== undefined) {
      this.report("E0222", at, `\`${this.written(full)}\` is defined for types without function values (3.9).`);
    }
    const out = substitute(sig.out, subst);
    if (freeVars(out).size !== 0) return ERROR;
    // A std call builds a Map from its type arguments (`std.map.empty<Float,
    // Int>()`) or binds its key type from an argument (`from_list`); user
    // signatures were checked at their own types.
    const key = sig.typeParams.length > 0 ? badMapKey(out) : null;
    if (key !== null) {
      // An expected type with an error was reported already, often at the
      // same key type (`let m: Map<Point, Int> = std.map.empty<Point, Int>()`):
      // one cause, one report (5.6).
      if (expected === null || !containsError(expected)) this.badKey(at, key);
      return ERROR;
    }
    return out;
  }

  // E0229: a Map keyed by a type other than Int or String.
  private badKey(at: string, key: Type): void {
    this.report(
      "E0229",
      at,
      `Map keys are \`Int\` or \`String\`, found \`${
        this.show(key)
      }\`; key the map by an \`Int\` or \`String\` field, or keep a \`List\` of records.`,
      { expected: "Int or String" },
    );
  }

  private effectsOfCall(sig: FnSig, written: string, at: string): void {
    if (sig.effects.length === 0) return;
    const list = sig.effects.join(", ");
    if (this.inLambda) {
      const advice = this.lambdaMayAct
        ? "To give the handler effects, pass a named function instead of a lambda."
        : "Apply effects per element with `for`.";
      this.report("E0232", at, `\`${written}\` has effects (${list}); lambdas are pure (2.4). ${advice}`);
      return;
    }
    if (this.section !== "body") {
      this.report(
        "E0233",
        at,
        `\`${written}\` has effects (${list}); \`requires\`, \`ensures\`, \`where\` and examples call only functions with \`effects: none\` (5.4).`,
      );
      return;
    }
    const declared = this.def.kind === "fn" ? this.def.effects : [];
    for (const effect of sig.effects) {
      if (declared.includes(effect)) continue;
      this.missingEffects.add(effect);
      this.firstMissing ??= { at };
    }
  }

  // For an explicit-type-argument call, the type arguments implied by the
  // expected type, if it determines all of them.
  private guessTypeArgs(sig: FnSig, expected: Type | null): TypeRef[] | null {
    if (!expected) return null;
    const s: Subst = new Map();
    if (!unify(sig.out, expected, s)) return null;
    const types = sig.typeParams.map((tp) => s.get(tp));
    // A type argument cannot name a function type yet (H5).
    if (types.some((t) => t === undefined || !writable(t))) return null;
    return types.map((t) => toTypeRef(t!, this.module));
  }

  private construct(e: Extract<Expr, { kind: "construct" }>, scope: Scope, expected: Type | null): Type {
    const at = firstLine(printExpr(e, ""));
    const last = e.path[e.path.length - 1];
    const p = e.payload;
    const payloadValue = p?.kind === "value" ? p.value : null;
    const checkAnyway = () => {
      if (p?.kind === "args") { for (const a of p.args) this.expr(a.value, scope, null); }
      if (payloadValue) this.expr(payloadValue, scope, null);
    };

    if (e.path.length === 1 && BUILTIN_VALUES.has(last)) {
      this.info.constructs.set(e, { kind: "builtin" });
      return this.builtinConstruct(e, last, scope, expected);
    }

    const full = this.resolvePath(e.path);
    const ut = this.env.types.get(full);
    if (ut || this.env.cases.has(full)) this.shortForm(e, e.path, at);
    if (ut?.kind === "record") {
      this.info.constructs.set(e, { kind: "record", type: full });
      if (p?.kind !== "args") {
        this.report(
          "E0223",
          at,
          `A record is built with named fields: \`${pathText(e.path)}(${
            ut.fields.map((f) => `${f.name}: ...`).join(", ")
          })\`.`,
        );
        checkAnyway();
        return con(full);
      }
      const byName = this.matchArgs(
        ut.fields,
        p.args,
        at,
        (args) => printExpr({ ...e, payload: { kind: "args", args } }, ""),
        "field",
      );
      ut.fields.forEach((f, i) => {
        const a = byName[i];
        if (a) this.expr(a.value, scope, f.type);
      });
      return con(full);
    }
    if (ut?.kind === "variant") {
      this.report(
        "E0223",
        at,
        `\`${pathText(e.path)}\` is a variant type; build one of its cases: ${
          ut.cases.map((c) => `\`${this.written(`${moduleOfName(c.owner)}.${c.name}`)}\``).join(", ")
        }.`,
      );
      checkAnyway();
      return con(full);
    }
    const c = this.env.cases.get(full);
    if (!c) {
      const written = pathText(e.path);
      const candidates = [
        ...BUILTIN_VALUES,
        ...[...this.env.cases.keys(), ...this.env.types.keys()].map((n) => this.written(n)),
      ];
      const suggestion = closest(written, candidates);
      this.report("E0203", at, `Unknown type or case \`${written}\`.`, {
        expected: suggestion ?? undefined,
        fix: suggestion ? { replace: written, with: suggestion } : undefined,
      });
      checkAnyway();
      return ERROR;
    }
    this.info.constructs.set(e, { kind: "case", type: c.owner });
    this.casePayload(e, c.name, c.payload, scope, at);
    return con(c.owner);
  }

  // Checks the payload of a variant case against the case's declaration.
  private casePayload(
    e: Extract<Expr, { kind: "construct" }>,
    name: string,
    payload: Type | null,
    scope: Scope,
    at: string,
  ): void {
    const p = e.payload;
    if (p?.kind === "args") {
      this.report("E0223", at, `A variant case carries one unnamed value (4.2): \`${name}(value)\`.`);
      for (const a of p.args) this.expr(a.value, scope, null);
      return;
    }
    if (payload === null && p !== null) {
      this.report("E0223", at, `\`${name}\` carries no value; write \`${name}\`.`, {
        fix: { replace: at, with: printExpr({ ...e, payload: null }, "") },
      });
      this.expr(p.value, scope, null);
      return;
    }
    if (payload !== null && p === null) {
      this.report("E0223", at, `\`${name}\` carries a value of type \`${this.show(payload)}\`: \`${name}(value)\`.`);
      return;
    }
    if (payload !== null && p !== null) this.expr(p.value, scope, payload);
  }

  private builtinConstruct(
    e: Extract<Expr, { kind: "construct" }>,
    name: string,
    scope: Scope,
    expected: Type | null,
  ): Type {
    const at = firstLine(printExpr(e, ""));
    switch (name) {
      case "Unit":
        this.casePayload(e, name, null, scope, at);
        return UNIT;
      case "Less":
      case "Equal":
      case "Greater":
        this.casePayload(e, name, null, scope, at);
        return ORDER;
    }
    const owner = name === "Some" || name === "None" ? "Option" : "Result";
    if (expected !== null && isCon(expected, owner)) {
      const payload = name === "None" ? null : name === "Err" ? expected.args[1] : expected.args[0];
      this.casePayload(e, name, payload, scope, at);
      return expected;
    }
    if (expected === null || isBottom(expected) || containsError(expected)) {
      if (name === "Some" && e.payload?.kind === "value") {
        return option(this.expr(e.payload.value, scope, null));
      }
      if (expected === null) {
        this.report(
          "E0210",
          at,
          `The type of \`${name}\` cannot be determined here; types flow from left to right (1.4). Bind it with \`let name: ${owner}<...> = ${at}\` first, or put the side with a known type first.`,
        );
      }
      if (e.payload?.kind === "value") this.expr(e.payload.value, scope, null);
      return ERROR;
    }
    this.report("E0204", at, `Expected \`${this.show(expected)}\`, found a case of \`${owner}\`.`, {
      expected: this.show(expected),
    });
    if (e.payload?.kind === "value") this.expr(e.payload.value, scope, null);
    return ERROR;
  }

  // `[a, b]`: the item type comes from the expected type, otherwise from the
  // first item (1.4). The empty list has one spelling, `std.list.empty<T>()`,
  // which names its item type (3).
  private listLiteral(e: Extract<Expr, { kind: "list" }>, scope: Scope, expected: Type | null): Type {
    const want = expected !== null && isCon(expected, "List") ? expected.args[0] : null;
    if (e.items.length === 0) {
      // Where a map is expected, the message and fix are those of the empty map (H6).
      if (expected !== null && isCon(expected, "Map")) this.emptyMap("[]", expected.args);
      else this.emptyList("[]", want);
      return ERROR;
    }
    let itemType = want;
    for (const item of e.items) {
      const t = this.expr(item, scope, itemType);
      if (itemType === null && t.k !== "never") itemType = t;
    }
    return itemType === null ? ERROR : list(itemType);
  }

  // `["a": 1, "b": 2]`: the key and value types come from the expected type,
  // otherwise from the first entry (1.4), as for a list. The empty map has
  // one spelling, `std.map.empty<K, V>()` (E0228).
  private mapLiteral(e: Extract<Expr, { kind: "map" }>, scope: Scope, expected: Type | null): Type {
    const want = expected !== null && isCon(expected, "Map") ? expected.args : null;
    if (e.entries.length === 0) {
      if (expected !== null && isCon(expected, "List")) this.emptyList("[:]", expected.args[0]);
      else this.emptyMap("[:]", want);
      return ERROR;
    }
    let keyType = want ? want[0] : null;
    let valueType = want ? want[1] : null;
    const literalKeys = new Set<string>();
    for (const entry of e.entries) {
      const k = this.unknownKey(entry.key, scope) ? ERROR : this.expr(entry.key, scope, keyType);
      if (keyType === null && k.k !== "never") keyType = k;
      const v = this.expr(entry.value, scope, valueType);
      if (valueType === null && v.k !== "never") valueType = v;
      // Two equal literal keys (M3); a computed duplicate traps at runtime.
      if ((entry.key.kind === "int" || entry.key.kind === "string") && !isBottom(k)) {
        const id = `${entry.key.kind} ${entry.key.value}`;
        if (literalKeys.has(id)) {
          const key = printExpr(entry.key, "");
          this.report(
            "E0234",
            firstLine(`${key}: ${printExpr(entry.value, "")}`),
            `The key \`${key}\` already has an entry in this map; write each key once.`,
          );
        }
        literalKeys.add(id);
      }
    }
    if (keyType === null || valueType === null) return ERROR;
    // An expected Map type was checked where it was written (or built), so
    // only an inferred key type is checked here (E0229).
    if (want === null && !keyOk(keyType)) {
      if (expected === null || !containsError(expected)) this.badKey(firstLine(printExpr(e, "")), keyType);
      return ERROR;
    }
    return map(keyType, valueType);
  }

  // A bare unknown name as a map key, the habit of JavaScript's object keys
  // (5.7): E0203 with the key in quotes as the fix. Whether it is one.
  private unknownKey(key: Expr, scope: Scope): boolean {
    if (key.kind !== "name" || key.path.length !== 1) return false;
    const name = key.path[0];
    if (scope.lookup(name) !== undefined || this.env.fns.has(`${this.module}.${name}`)) return false;
    const quoted = printString(name);
    this.report(
      "E0203",
      name,
      `Unknown name \`${name}\`; a map key is a value, so a text key is written in quotes: \`${quoted}\`.`,
      { expected: quoted, fix: { replace: name, with: quoted } },
    );
    this.info.types.set(key, ERROR);
    return true;
  }

  // E0228 for the empty list, at `[]` (or at `[:]` where a list is
  // expected). The fix names the item type, if the expected type gives one
  // that can be written.
  private emptyList(at: string, item: Type | null): void {
    const empty = item !== null && writable(item)
      ? printExpr(
        { kind: "call", path: ["std", "list", "empty"], typeArgs: [toTypeRef(item, this.module)], args: [] },
        "",
      )
      : null;
    this.report("E0228", at, "The empty list is written `std.list.empty<T>()`, with its item type (1.4).", {
      expected: empty ?? "std.list.empty<T>()",
      fix: empty ? { replace: at, with: empty } : undefined,
    });
  }

  // E0228 for the empty map, at `[:]` (or at `[]` where a map is expected).
  private emptyMap(at: string, types: readonly Type[] | null): void {
    const empty = types !== null && types.every(writable)
      ? printExpr({
        kind: "call",
        path: ["std", "map", "empty"],
        typeArgs: types.map((t) => toTypeRef(t, this.module)),
        args: [],
      }, "")
      : null;
    this.report(
      "E0228",
      at,
      "The empty map is written `std.map.empty<K, V>()`, with its key and value types (1.4).",
      { expected: empty ?? "std.map.empty<K, V>()", fix: empty ? { replace: at, with: empty } : undefined },
    );
  }

  private binary(e: Extract<Expr, { kind: "binary" }>, scope: Scope): Type {
    const at = firstLine(printExpr(e, ""));
    switch (e.op) {
      case "and":
      case "or":
        this.expr(e.left, scope, BOOL);
        this.expr(e.right, scope, BOOL);
        return BOOL;
      case "==":
      case "!=": {
        const l = this.expr(e.left, scope, null);
        this.expr(e.right, scope, isBottom(l) ? null : l);
        if (containsFn(l, (n) => this.env.recordFields(n))) {
          this.report("E0222", at, `\`${e.op}\` is defined for types without function values (3.9).`);
        }
        return BOOL;
      }
      case "<":
      case "<=":
      case ">":
      case ">=": {
        const l = this.expr(e.left, scope, null);
        if (!isBottom(l) && ![INT, FLOAT, STRING].some((t) => typeEquals(l, t))) {
          this.report(
            "E0211",
            at,
            `\`${e.op}\` orders only Int, Float and String; compare \`${
              this.show(l)
            }\` with a function returning \`Order\` (3.9).`,
          );
          this.expr(e.right, scope, null);
          return BOOL;
        }
        this.expr(e.right, scope, isBottom(l) ? null : l);
        return BOOL;
      }
      default: {
        const l = this.expr(e.left, scope, null);
        if (isBottom(l)) {
          this.expr(e.right, scope, null);
          return ERROR;
        }
        if (!typeEquals(l, INT) && !typeEquals(l, FLOAT)) {
          const concat = e.op === "+" && typeEquals(l, STRING);
          this.report(
            "E0211",
            at,
            concat
              ? "`+` adds numbers; join texts with `std.string.concat` (one name, one function: 2.6)."
              : `\`${e.op}\` is defined for Int and Float, found \`${this.show(l)}\`.`,
            concat
              ? {
                fix: {
                  replace: at,
                  with: `std.string.concat(left: ${printExpr(e.left, "")}, right: ${printExpr(e.right, "")})`,
                },
              }
              : {},
          );
          this.expr(e.right, scope, null);
          return ERROR;
        }
        this.expr(e.right, scope, l);
        return l;
      }
    }
  }

  private lambda(e: Extract<Expr, { kind: "lambda" }>, scope: Scope, expected: Type | null): Type {
    const inner = scope.child();
    const params = e.params.map((p) => {
      const t = this.resolveType(p.type);
      this.bind(inner, p.name, t, `${p.name}: ${printTypeRef(p.type)}`);
      return t;
    });
    const out = this.resolveType(e.out);
    const saved = [this.inLambda, this.lambdaMayAct];
    this.inLambda = true;
    this.lambdaMayAct = expected?.k === "fn" && expected.effects === "caller";
    this.expr(e.body, inner, out);
    [this.inLambda, this.lambdaMayAct] = saved;
    return fnType(params, out);
  }

  // ---- if, match, for ----

  private blockExpr(e: Expr, scope: Scope, mode: Mode): Type {
    switch (e.kind) {
      case "if": {
        this.expr(e.cond, scope, BOOL);
        if (mode.discard || e.else === null) {
          const t1 = this.block(e.then, scope, DISCARD);
          const t2 = e.else ? this.block(e.else, scope, DISCARD) : UNIT;
          return t1.k === "never" && t2.k === "never" ? NEVER : UNIT;
        }
        const t1 = this.block(e.then, scope, mode);
        const t2 = this.block(e.else, scope, value(mode.expected ?? (isBottom(t1) ? null : t1)));
        return mode.expected ?? (isBottom(t1) ? t2 : t1);
      }
      case "match":
        return this.match(e, scope, mode);
      case "for": {
        const declared = this.resolveType(e.type);
        // The declared type stands to the left of a literal, so the literal
        // takes it as its item type (1.4, H4); any other iterable is checked
        // against it below.
        const it = this.expr(e.iterable, scope, e.iterable.kind === "list" ? list(declared) : null);
        if (isCon(it, "List")) {
          if (!fits(it.args[0], declared)) {
            this.report("E0204", printTypeRef(e.type), `The list holds \`${this.show(it.args[0])}\`.`, {
              expected: this.show(it.args[0]),
              fix: { replace: printTypeRef(e.type), with: this.show(it.args[0]) },
            });
          }
        } else if (!isBottom(it) && !containsError(it)) {
          this.report(
            "E0204",
            firstLine(printExpr(e.iterable, "")),
            `\`for\` iterates over a List, found \`${this.show(it)}\`${
              isCon(it, "Map") ? "; take `std.map.keys` or `std.map.to_list` of it." : "."
            }`,
          );
        }
        const body = scope.child();
        this.bind(body, e.name, declared, `${e.name}: ${printTypeRef(e.type)}`);
        if (mode.discard) {
          this.block(e.body, body, DISCARD);
          return UNIT;
        }
        const elem = mode.expected && isCon(mode.expected, "List") ? mode.expected.args[0] : null;
        const t = this.block(e.body, body, value(elem));
        return list(elem ?? t);
      }
      default:
        throw new Error(`not a block expression: ${e.kind}`);
    }
  }

  private match(e: Extract<Expr, { kind: "match" }>, scope: Scope, mode: Mode): Type {
    const subject = this.expr(e.subject, scope, null);
    const patterns: Pattern[] = [];
    let result: Type | null = mode.discard ? null : mode.expected;
    let allNever = true;
    // A broken pattern makes exhaustiveness a follow-up question (5.6).
    let sound = !containsError(subject);
    for (const arm of e.arms) {
      const armScope = scope.child();
      const before = this.diagnostics.length;
      this.pattern(arm.pattern, subject, armScope);
      if (this.diagnostics.length > before) sound = false;
      if (sound && this.subsumed(patterns, arm.pattern, subject)) {
        this.report(
          "E0214",
          `case ${printPattern(arm.pattern)} then`,
          "This case is never reached; earlier cases cover it.",
        );
      }
      patterns.push(arm.pattern);
      const t = this.block(arm.body, armScope, mode.discard ? DISCARD : value(result));
      if (t.k !== "never") allNever = false;
      if (!mode.discard && result === null && !isBottom(t)) result = t;
    }
    if (sound) this.catchAlls(patterns.map((p) => ({ p, arm: p })), subject);
    if (sound) {
      const missing = this.missing(patterns, subject);
      if (missing === "_") {
        this.report(
          "E0213",
          firstLine(printExpr(e, "")),
          `A \`match\` on \`${this.show(subject)}\` cannot list every value; use \`if\` instead (3.3).`,
        );
      } else if (missing !== null) {
        this.report(
          "E0213",
          firstLine(printExpr(e, "")),
          `\`match\` is not exhaustive: \`${missing}\` has no case (3.3).`,
          { expected: `case ${missing} then` },
        );
      }
    }
    if (mode.discard) return allNever ? NEVER : UNIT;
    return result ?? (allNever ? NEVER : ERROR);
  }

  // The cases of a type that `match` can distinguish, or null.
  private casesOf(t: Type): { name: string; written: string; payload: Type | null }[] | null {
    if (t.k !== "con") return null;
    switch (t.name) {
      case "Option":
        return [{ name: "Some", written: "Some", payload: t.args[0] }, {
          name: "None",
          written: "None",
          payload: null,
        }];
      case "Result":
        return [{ name: "Ok", written: "Ok", payload: t.args[0] }, { name: "Err", written: "Err", payload: t.args[1] }];
      case "Order":
        return ["Less", "Equal", "Greater"].map((n) => ({ name: n, written: n, payload: null }));
    }
    const ut = this.env.types.get(t.name);
    if (ut?.kind !== "variant") return null;
    return ut.cases.map((c) => ({
      name: c.name,
      written: this.written(`${moduleOfName(c.owner)}.${c.name}`),
      payload: c.payload,
    }));
  }

  private pattern(p: Pattern, t: Type, scope: Scope): void {
    const at = printPattern(p);
    switch (p.kind) {
      case "bind":
        this.bind(scope, p.name, t, at);
        return;
      case "literal": {
        const lt = this.infer(p.value, scope, null);
        if (!containsError(t) && !typeEquals(lt, t)) {
          this.report("E0214", at, `A \`${this.show(lt)}\` pattern cannot match \`${this.show(t)}\`.`);
        }
        return;
      }
      case "case": {
        const bindAll = (q: Pattern | null) => {
          if (q?.kind === "bind") scope.define(q.name, ERROR);
          if (q?.kind === "case") bindAll(q.sub);
        };
        if (containsError(t)) {
          bindAll(p.sub);
          return;
        }
        const cases = this.casesOf(t);
        if (!cases) {
          this.report(
            "E0214",
            at,
            `\`match\` distinguishes the cases of a variant type; \`${this.show(t)}\` has none.`,
          );
          bindAll(p.sub);
          return;
        }
        const written = pathText(p.path);
        let c = cases.find((c) => c.written === written);
        // A case of this module written in full: reported, then matched as
        // its short form.
        if (!c && p.path.length > 1 && pathText(moduleOf(p.path)) === this.module) {
          c = cases.find((c) => c.written === p.path[p.path.length - 1]);
          if (c) this.shortForm(p, p.path, at);
        }
        if (!c) {
          const byName = cases.find((c) => c.name === p.path[p.path.length - 1]);
          this.report("E0214", at, `\`${written}\` is not a case of \`${this.show(t)}\`.`, {
            expected: cases.map((c) => c.written).join(", "),
            fix: byName ? { replace: written, with: byName.written } : undefined,
          });
          bindAll(p.sub);
          return;
        }
        if (c.payload && !p.sub) {
          this.report("E0214", at, `\`${c.written}\` carries a value; write \`${c.written}(name)\`.`);
        } else if (!c.payload && p.sub) {
          this.report("E0214", at, `\`${c.written}\` carries no value; write \`${c.written}\`.`);
          bindAll(p.sub);
        } else if (c.payload && p.sub) {
          this.pattern(p.sub, c.payload, scope);
        }
        return;
      }
    }
  }

  // A value of `t` that no pattern matches, as text, or null if the
  // patterns are exhaustive. "_" stands for values that only a catch-all
  // could cover.
  private missing(ps: readonly Pattern[], t: Type): string | null {
    if (ps.some((p) => p.kind === "bind")) return null;
    if (typeEquals(t, BOOL)) {
      for (const b of [true, false]) {
        if (!ps.some((p) => p.kind === "literal" && p.value.kind === "bool" && p.value.value === b)) return String(b);
      }
      return null;
    }
    const cases = this.casesOf(t);
    if (!cases) return "_";
    for (const c of cases) {
      const group = ps.filter((p): p is Extract<Pattern, { kind: "case" }> =>
        p.kind === "case" && p.path[p.path.length - 1] === c.name
      );
      if (group.length === 0) return c.payload ? `${c.written}(_)` : c.written;
      if (c.payload) {
        const m = this.missing(group.flatMap((p) => (p.sub ? [p.sub] : [])), c.payload);
        if (m !== null) return `${c.written}(${m})`;
      }
    }
    return null;
  }

  // A name where an earlier case of the same `match` names a specific case
  // at that position (`case Err(std.fs.NotFound)`, then `case Err(other)`)
  // stands for the remaining cases: a catch-all, which 3.3 rules out, since
  // a case added to the type later would not be reported there (E0227). A
  // name before the specific case makes that case unreachable instead (E0214),
  // so each order gets one diagnostic. `items` are the patterns at one
  // position, in the order of their arms.
  private catchAlls(items: readonly { p: Pattern; arm: Pattern }[], t: Type): void {
    const cases = this.casesOf(t);
    if (!cases) return;
    items.forEach((item, k) => {
      if (item.p.kind !== "bind") return;
      const specific = items.slice(0, k).flatMap((i) => (i.p.kind === "case" ? [i.p] : []));
      if (specific.length === 0) return;
      const rest = cases.flatMap((c) => {
        const group = specific.filter((q) => q.path[q.path.length - 1] === c.name);
        if (group.length === 0) return [c.payload ? `${c.written}(name)` : c.written];
        if (!c.payload) return [];
        const m = this.missing(group.flatMap((q) => (q.sub ? [q.sub] : [])), c.payload);
        return m === null ? [] : [`${c.written}(${m})`];
      });
      const target = item.p;
      this.report(
        "E0227",
        `case ${printPattern(item.arm)} then`,
        `\`${target.name}\` stands for the remaining cases of \`${this.show(t)}\`: a catch-all, so a case added ` +
          "later would not be reported here (3.3). Write a case for each.",
        { expected: rest.map((r) => `case ${printPattern(item.arm, target, r)} then`).join(", ") },
      );
    });
    for (const c of cases) {
      if (!c.payload) continue;
      const sub = items.flatMap((i) =>
        i.p.kind === "case" && i.p.path[i.p.path.length - 1] === c.name && i.p.sub ? [{ p: i.p.sub, arm: i.arm }] : []
      );
      this.catchAlls(sub, c.payload);
    }
  }

  // Whether every value matching `p` already matches one of `earlier`.
  private subsumed(earlier: readonly Pattern[], p: Pattern, t: Type): boolean {
    if (earlier.some((q) => q.kind === "bind")) return true;
    switch (p.kind) {
      case "bind":
        return this.missing(earlier, t) === null;
      case "literal":
        return earlier.some((q) => q.kind === "literal" && q.value.value === p.value.value);
      case "case": {
        const name = p.path[p.path.length - 1];
        const group = earlier.filter((q): q is Extract<Pattern, { kind: "case" }> =>
          q.kind === "case" && q.path[q.path.length - 1] === name
        );
        if (group.length === 0) return false;
        const c = this.casesOf(t)?.find((c) => c.name === name);
        if (!c?.payload || !p.sub) return true;
        return this.subsumed(group.flatMap((q) => (q.sub ? [q.sub] : [])), p.sub, c.payload);
      }
    }
  }
}

// ---- helpers ----

function firstLine(text: string): string {
  return text.split("\n", 1)[0];
}

function moduleOfName(full: string): string {
  return full.slice(0, full.lastIndexOf("."));
}

// The text of a pattern, with `target` (a node inside it) written as `as`.
function printPattern(p: Pattern, target?: Pattern, as?: string): string {
  if (p === target) return as!;
  switch (p.kind) {
    case "bind":
      return p.name;
    case "literal":
      return printExpr(p.value as Literal, "");
    case "case":
      return pathText(p.path) + (p.sub ? `(${printPattern(p.sub, target, as)})` : "");
  }
}

// Map keys are Int or String (M1): the types JavaScript compares by value
// and orders by itself, so key lookup agrees with `==` and every map has
// one order. A type that already failed fits, so nothing follows from it.
function keyOk(k: Type): boolean {
  return isBottom(k) || containsError(k) || typeEquals(k, INT) || typeEquals(k, STRING);
}

// The key type of the first Map inside `t` whose key is not Int or String.
function badMapKey(t: Type): Type | null {
  switch (t.k) {
    case "con":
      if (t.name === "Map" && !keyOk(t.args[0])) return t.args[0];
      for (const a of t.args) {
        const bad = badMapKey(a);
        if (bad) return bad;
      }
      return null;
    case "fn":
      for (const p of [...t.params, t.out]) {
        const bad = badMapKey(p);
        if (bad) return bad;
      }
      return null;
    default:
      return null;
  }
}

// Whether `toTypeRef` writes the type: built from named types only, without
// function types, type variables or the error type.
export function writable(t: Type): boolean {
  return t.k === "con" && t.args.every(writable);
}

// A type as it is written in `module` (rule 1.2).
export function toTypeRef(t: Type, module: string): TypeRef {
  if (t.k !== "con") return { kind: "type", path: ["Unit"], args: [] };
  const prefix = module + ".";
  const path = t.name.startsWith(prefix) && !t.name.slice(prefix.length).includes(".")
    ? [t.name.slice(prefix.length)]
    : t.name.split(".");
  return { kind: "type", path, args: t.args.map((a) => toTypeRef(a, module)) };
}

// Edit distance where swapping two neighbouring characters counts as one
// edit (optimal string alignment), since transpositions are common typos.
function distance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

// The closest candidate within a small edit distance, for "did you mean" fixes.
export function closest(name: string, candidates: Iterable<string>): string | null {
  let best: string | null = null;
  let bestDistance = Math.max(1, Math.min(3, Math.floor(name.length / 3)));
  for (const c of new Set(candidates)) {
    if (c === name) continue;
    const d = distance(name, c);
    if (d <= bestDistance && (best === null || d < bestDistance)) {
      best = c;
      bestDistance = d;
    }
  }
  return best;
}
