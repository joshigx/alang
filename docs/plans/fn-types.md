# Plan: phase 5, `fn-types`

The planner wrote this on 2026-11-14 from branch `std-net` at `7700807` (`main` plus phase `std-net`). The only file
written was this plan; probes ran in the job's scratch directory (`/home/josua/.claude/jobs/7e0015cb/tmp/fn-types-probes/`,
which may not survive), never in the repository.

- **Observed:** facts from `alang check`, `alang ts`, `deno check` and small Deno scripts, on Deno 2.8.0.
- **To verify:** facts that were not observed, mostly because they need the code of this phase or of `statements`.

The main session takes every recommendation, and nobody is asked. **[language]** marks a decision that changes the
language; those are listed for the user's later review.

**Branch:** `fn-types`, from `main` after `std-net` and `statements` (roadmap rows 3 and 4) are merged. File:line
references are at `7700807`. Three `std-net` commits landed while this was written (`e6504ac`, `7a75e23`, `e55e99a`,
HEAD at the end): they move `src/runtime.ts` (`std$text$show` is now at `:2000`, its function fallback at `:2015`) and `tests/queries_test.ts` after its
line 302 (+2: the `search_type` pins are at `:337-386`), and touch nothing else cited here. `statements` rewrites `Parser.stmt()`, `Parser.block()`, `Arm`, `DefChecker.block()`,
`Scope` and `rebuild()`, so re-grep by the function names given here. After every commit run `deno task test`,
`deno lint` and `deno fmt --check`; commit with explicit paths, never `git add -A`.

## 0. Scope

| Item | Where | Why |
| --- | --- | --- |
| Function types `(T, U) -> V` wherever a type is written | **This phase** (F1, F5, F6) | Roadmap row 5; the notation std, `showType`, `search_type` and E0204 already print |
| Applying a function value by position, `by(a, b)` | **This phase** (F2, F7) | Roadmap row 5; without it a function parameter can only be handed on to std |
| User function types are pure | **This phase** (F3) | Roadmap row 5; 2.4 |
| No `fn` returns a function value (E0237) | **This phase** (F4), own commit | Otherwise such a pure function can never be accepted (2.4) |
| Function types written in fixes and actual values | **This phase** (F8) | Follows from F1; reverses most of H5 |
| `search_type` patterns with function types; hits and `context` see inside them | **This phase**, last code commit, cuttable (F9) | One notation (3); `context` must list `Sale` in `(Sale) -> Int` (6.5) |
| A generic function as a value, typed from the expected type | `generics`, row 7 (F10) | Instantiation belongs with type parameters |
| A `fn` returning a function (`compose`); a table of functions as a definition | Revisit F4 in `const` (row 6) and `generics` (row 7) | F4 is the strict start; loosening breaks no program |
| `with effects` in user signatures; applying a call's result (`make(n: 1)(2)`) | Not planned | 2.1 locality (F3); bind first (4.5), and F4 leaves nothing to apply |

**What this phase leaves ready.** For `generics`: `TypeRef` is a union with a `function` kind, so a type parameter only
adds a named reference that resolves to a `var`, and `(T) -> U` works in generic signatures; `apply` checks against
`t.params` and returns `t.out`, which `unify` handles for `var`s; E0210 and F4 are the rules to revisit. For
`extern-fn`: `ts()` of a function type is `((p0: A) => R)`, which an extern's TypeScript must accept; by F3 a function
value handed to an extern is pure and synchronous; by F4 the result check at the boundary (E2) never meets a function.
For `const`: decide whether a constant may hold function values; it has no examples (C2), so F4's reason does not apply,
and a table of handlers would live there.

## 1. Findings

### 1.1 How function values work today

- **Types.** `Type` has `{ k: "fn", params, out, effects?: "caller" }` (`src/types.ts:12`, `fnType` at `:22`).
  `showType` prints `(A, B) -> C` and ` with effects` for the mark (`:133-136`); `typeEquals` ignores the mark
  (`:104-108`); `containsFn` (`:78-94`) walks record fields and case payloads through `Env.recordFields`
  (`src/check.ts:120-124`). std builds function types in `src/std.ts`: `serve`'s handler with `"caller"` (`:243`), the
  list, map and option functions (`:551-742`).
- **Function names as values.** `DefChecker.name_()` (`check.ts:667-713`): a local comes first; a function gives
  `fnType(params, out)` without parameter names; a generic one is E0210, one with effects E0232 unless the expected
  type carries `"caller"` (then `effectsOfCall`). A function with `in: none` passed by name has type `() -> Int`;
  `tests/check_test.ts:99` (`G`) relies on that (`g == g`, `[g]`).
- **Lambdas** have at least one parameter (`Parser.lambda()`, `parser.ts:794-807`); checked at `check.ts:1288-1302`,
  emitted as arrow functions (`src/emit.ts:535-539`).
- **No syntax** (observed): `f: (Int) -> Int` in `in:` is E0101 "Expected a PascalCase type name, found `(`."
  (`Parser.type()`, `parser.ts:394-410`, starts with `typePath()`). `->` is not a lexer symbol (`SYMBOLS`,
  `src/lexer.ts:64-84`, has `=>`, `-`, `>`); `search.ts` tokenizes its own.
- **Calls** (observed). E0107 comes from the parser (`Parser.arg()`, `parser.ts:703-710`): `return twice(x)` and
  `return xs.map(std.string.length)` are both E0107 "Every argument carries its parameter name: `name: value`.", no
  fix. E0220 (`check.ts:803-811`) fires only for a dotted path whose head is a local; `let f: Int = 1` then `f(x: x)` is
  E0201 "Unknown function `f`." **Precedent for F2:** `Parser.payload()` (`parser.ts:712`) already tells
  `Port(value: 1)` from `Some(x)` by the two tokens `name :` after `(`.
- **E0222**: `==`/`!=` in `binary()` (`check.ts:1232`); `std.text.show` and `std.list.contains` through
  `withoutFunctions` (`check.ts:888-894`). `std$text$show` of a function is `String(fn)` (`src/runtime.ts:1984`), behind
  E0222; `examples.ts` `showValue` falls back to it (`:103-112`).
- **TypeScript.** `tsType` writes a function type as `((p0: A) => R)` (`emit.ts:184-185`); `ts()` of a `TypeRef`
  (`:192-218`) has no function case. Observed: hand-written output in the planned shape passes `deno check` against
  `src/runtime.ts` (probe `ts/probe.ts`): a function-typed parameter applied in a sort lambda, a record field, a `let`
  assigned from an `if`, a map literal of functions, `std.map.get` giving an `Option` of one, a list literal of
  functions, `std.list.empty<((p0: number) => number)>()`, a variant payload, a curried lambda, a `fold` over functions.
- **H5.** `writable` (`check.ts:1630`) is false for function types and `toTypeRef` (`:1635`) writes `Unit` for one;
  used by the E0209 guess (`guessTypeArgs`, `:951-959`), the E0228 fixes (`:1190`, `:1204`) and `examples.ts`
  `empty()` (`:203-208`).
- **Queries.** `TypeTree`'s `{ k: "fn" }` has no structure (`src/search.ts:19-22`): `showTree` prints `fn` (`:67`),
  `namedTypes` stops there (`:59`), `matchesType` matches it only with `_` (`:138`). `storedHead`, `typeHead` and
  `signatureTypes` (`src/codebase.ts:270`, `:281`, `:260`) go through `treeOfRef`, so a stored signature would show
  `fn` and `context` (`:617-640`) would drop `Sale` from `(Sale) -> Int`. `stdTypeNames` (`:342`) already walks std
  function types. `interface.ts` `fullType` (`:32-37`) knows named types only.

### 1.2 Every exhaustive switch this phase meets

- **`TypeRef` readers** (each reads `.path`/`.args`; TypeScript flags them once it is a union): `printTypeRef`
  (`printer.ts:68-71`), `DefChecker.resolveType` (`check.ts:351-390`), `DefinitionEmitter.ts` (`emit.ts:192-218`),
  `rebuild`'s `type` (`refs.ts:91-95`), `fullType` (`interface.ts:32-37`), `treeOfRef` (`search.ts:37-42`). Producers:
  `Parser.type()`, `toTypeRef`. Pass-through only: `toolchain.ts:132,187`, `examples.ts:26,34`, the checker's `at` texts.
- **`Expr` switches** (four): `DefChecker.infer` (`check.ts:630-664`), `printExpr` (`printer.ts:194-247`), `rebuild`'s
  `expr` (`refs.ts:130-179`), `DefinitionEmitter.expr` (`emit.ts:460-545`). Also by kind: `Parser.example()`
  (`parser.ts:340-346`, requires `left.kind === "call"`) and the E0221 check in `checkFn` (`check.ts:415-427`).

### 1.3 Tests that pin current behaviour

| Pin | Fate |
| --- | --- |
| `syntax_test.ts:110` `f(1)` is E0107 | Changes: `f(1)` parses (commit 2) |
| `check_test.ts:184`, `:597`, `:600-615` E0222 for `==`, `contains`, `show` | Stay |
| `check_test.ts:237` `xs.length()`, `emit_test.ts:785-794` `greeting.print_line()`, both E0220 | Stay: no arguments, still a call |
| `check_test.ts:240-262` function references; `:950-970` E0232 | Stay |
| `check_test.ts:585-587`, `:634-640`, `:804-808`: H5 with `g` | Stay: `g` is `() -> Int`, which has no written form (F5); only their comments change |
| `accept_test.ts:326-331`: H5 with `fnType([INT], INT)` | Change (F8) |
| `queries_test.ts:141-152` `context("web.main")`, read with `.get` | Stay; may gain `std.http.Request`/`Response` at level 2 (to verify) |
| `queries_test.ts:148` serve's line; `:335-384` `search_type` | Stay; rows are added |
| `spec_test.ts:34-40`: 6 definition blocks, 17 definitions (3 statement fragments after `statements`) | 7 blocks, 18 definitions (commit 2) |
| `card_test.ts:41-58` codes exist; `:146-150` budget | Pass (2.8) |

No test asserts that a user signature with a function type is rejected (grepped `-> ` and "function type" in `tests/`).

### 1.4 Evidence from the rounds

No round program wanted a user function parameter (observed by grep over the exports of the `std-net` round and the
automated `tasks` round): models write lambdas for `std.list.find`, `enumerate`, `filter` and `map` fluently and pass a
name (`with: parse_line`), but no task asked for reuse across keys. So the round of section 7 must create the need. The
need is recorded in `notes.md`: "From the type checker" (a lambda cannot be bound with `let`, stored in a record, or
taken as a parameter), "From async output and std.http" (the handler exception is std-only; "if function types arrive,
the `with effects` mark needs a surface form", which F3 answers: it stays std's), "From the database" (`search(type)`
cannot express function types), and "Spec observations" (no grammar for function types).

### 1.5 What `statements` changes that this phase touches

- **AST:** `Stmt` gains `propagate` and `destructure`, whose `type` is a `TypeRef`, so the union flows through it;
  `Arm.pattern` becomes `Arm.patterns`.
- **Checker:** `Scope` gains `used`/`use()` (marked in `name_()`) and `hidden` (consulted by `name_()` before E0203).
  So `apply` resolves its target through `name_()` (2.2): an apply on a hidden name is E0236, and it marks a use.
- **refs.ts:** `rebuild()` gains a statement callback (T5, `applyOwnFixes`); add this phase's cases to that version.
- **Parser:** an apply is an expression, so `check(x) else return Err(error)` is a propagate statement.
- **`writable`** also drives T11's E0204 fix (`]: String =`), which a list of functions now gets too (F8).
- **Codes:** `statements` takes E0235 and E0236 and uses E0101/E0006 in the parser. This phase takes **E0237** and
  **E0238** and no new parser code.
- **Card:** `statements` edits the Bodies bullets, the `match` bullet and the program heading; this phase the lambdas
  bullet and "Not in alang". **Spec:** its grammar lines are `stmt`, `let`, `destructure`, `propagate`, `arm`; this
  phase's are `type`, `expr`, `apply`. Both add rows to 7.1 and 7.11.
- **std:** `std.list.set` and `find_index` only change `search_type` results of patterns ending in `-> _`.

## 2. Design

### 2.1 F1: function types [language]

**Grammar** (replaces the `type` line of section 3):

```
type       = TypePath [ "<" type { "," type } ">" ]
           | "(" type { "," type } ")" "->" type ;
```

At least one parameter (F5). `->` nests to the right (`(Int) -> (Int) -> Int` gives a function); a function parameter
stands in the parentheses (`((Int) -> Int) -> Int`). No line break inside a function type, as inside `<...>` today. It
stands wherever a type does: `in:`, `out:` (but F4), fields, case payloads, `let`, `let [...]`, `for`, lambda parameters
and results, type arguments (`List<(Int) -> Bool>`, `std.list.empty<(Int) -> Bool>()`).

**Lexer:** `"->"` joins `SYMBOLS` before `"-"`. No valid text has `-` right before `>` (to verify by the suite).

**AST:**

```ts
export type TypeRef =
  | { readonly kind: "type"; readonly path: Path; readonly args: readonly TypeRef[] }
  // `(A, B) -> R`: at least one parameter (F5); always pure (F3).
  | { readonly kind: "function"; readonly params: readonly TypeRef[]; readonly out: TypeRef };
```

**Parser.** `type()`:

```ts
type(): TypeRef {
  if (this.isKeyword("fn")) this.fail(P4, { code: "E0006" });
  if (this.isSymbol("(")) return this.functionType();
  // ... the named type as today, with its `[` check (E0006) ...
  if (this.isSymbol("->")) this.typeForm(P3, "E0006");
  return { kind: "type", path, args };
}

private functionType(): TypeRef {
  this.expectSymbol("(");
  if (this.isSymbol(")")) this.typeForm(P5, "E0101");
  const params = [this.parameterType()];
  while (this.isSymbol(",")) {
    this.next();
    params.push(this.parameterType());
  }
  this.expectSymbol(")");
  if (this.isSymbol("=>")) this.typeForm(P2, "E0006");
  this.expectSymbol("->");
  const out = this.type();
  if (this.peek().kind === "name" && this.peek().text === "with" && this.isKeyword("effects", 1)) {
    this.typeForm(P6, "E0101");
  }
  return { kind: "function", params, out };
}

private parameterType(): TypeRef {
  if (this.peek().kind === "name" && this.isSymbol(":", 1)) this.typeForm(P1, "E0006");
  return this.type();
}
```

`typeForm(message, code)` fails like `fail()` and records the thrown `AlangError` in a module-level `WeakSet`;
`tryTypeArgs()` (`parser.ts:607-624`) rethrows such an error instead of backtracking, since no expression can contain
these forms after `<` and the comparison reading would fail with a worse message. P4 uses plain `fail()`: a lambda may
follow `<`. Messages (no fix; `at` is the line, as for every parser error):

| # | Input | Code | Message |
| --- | --- | --- | --- |
| P1 | `(x: Int) -> Int` | E0006 | "A function type names no parameters: `(Int) -> Int`; the names belong to a lambda, `fn(x: Int): Int => ...`." |
| P2 | `(Int) => Int` | E0006 | "A function type is written with `->`: `(Int) -> Int`; `=>` starts the body of a lambda." |
| P3 | `Int -> Int`, `(Int) -> Int -> Int` | E0006 | "A function type puts its parameter types in parentheses: `(Int) -> Int`." |
| P4 | `fn(Int) -> Int`, `fn(Int): Int` | E0006 | "A function type is written `(Int) -> Int`, without `fn`; `fn(x: Int): Int => ...` is a lambda, which is a value." |
| P5 | `() -> Int` | E0101 | "A function type takes at least one parameter: a pure function without parameters always gives the same value, so take that value instead (`limit: Int`)." |
| P6 | `(Int) -> Int with effects` | E0101 | "Function types in your own code are pure (2.4); only the `handler` of `std.http.serve` takes a function with effects. Take a pure function, and put effects in a `for` or in the function that calls it." |

**Printer:** `printTypeRef` writes a function type as `` `(${params.map(printTypeRef).join(", ")}) -> ${printTypeRef(out)}` ``.
No extra parentheses are ever needed: parameters sit inside `( )`, and the result nests to the right.

**Checker.** `resolveType` gives `fnType(params.map(resolveType), resolveType(out))`; unknown types (E0202), own-module
long forms (E0226, into `longForms`) and bad map keys (E0229) are reported at the inner reference, as today. **F8:**
`writable(t)` is also true for `t.k === "fn"` with `params.length >= 1`, no `effects` mark, and writable parameters and
result; `toTypeRef` writes such a type as a `function` reference.

**Emitter:** `ts()` gives `` `((${params.map((p, i) => `p${i}: ${this.ts(p)}`).join(", ")}) => ${this.ts(out)})` ``, the
shape of `tsType` (observed to type-check, 1.1).

**refs.ts:** `rebuild`'s `type` recurses (`{ kind: "function", params: t.params.map(type), out: type(t.out) }`), so
`refs`, `callers` and `context` see `Row` in `(Row) -> Bool`, `rename` rewrites it, and `shortenOwnNames` shortens it.
**Interface:** `fullType` prints function types with full names, so `(Row) -> Bool` to `(Row) -> Int` changes `in`.

**Queries** (patterns come in commit 4): `TypeTree` gets `{ k: "fn"; params: readonly TypeTree[]; out: TypeTree }`
from both `treeOfRef` and `treeOfType`; `showTree` prints `(A, B) -> R`, so a hit reads
`fn rank.ranked(sales: List<rank.Sale>, value: (rank.Sale) -> Int): List<rank.Sale>, effects: none`; `namedTypes`
recurses into parameters and result (consequence, to verify: `context` of a user of `std.http.serve` also lists
`std.http.Request` and `Response` at level 2). `matchesType` keeps `if (t.k === "fn") return false` until commit 4.

**Comments to update:** `types.ts:1-3` (only type variables are std-only now), `std.ts:762-763`, `check.ts:956` and
`:1628-1629`, `examples.ts:105-107`, `search.ts:8-10`.

### 2.2 F2: applying a function value [language]

**Form.** `by(a, b)`, `rule.broken(line)`: a local, or a field chain on a local, of function type, with unnamed
arguments in order, at least one (F5). A call with named arguments, or with `()`, always calls a function defined with
`fn`, so the two never collide and a local may still share a function's name (`total(items: xs)`, 7.5).

**Grammar** (section 3): `expr` gains `apply` after `call`, and a new line `apply      = path "(" expr { "," expr } ")" ;`.

**AST:**

```ts
// Applying a function value (F2): a local, or a field of one, of function
// type, with unnamed arguments, since a function type names no parameters.
| { readonly kind: "apply"; readonly target: { readonly kind: "name"; readonly path: Path }; readonly args: readonly Expr[] }
```

**Parser.** In `pathExpr()` (`parser.ts:587-604`), after `tryTypeArgs()`: if no type arguments were read, `(` follows
and `opensApplication()` holds, return `{ kind: "apply", target: { kind: "name", path: segments }, args:
this.applicationArgs() }`. `opensApplication()` skips line breaks after `(` and is true unless the next token is `)`, or
a `name` followed by `:` (the test of `payload()`). `applicationArgs()` mirrors `args()`, line breaks ignored; an
argument written `name: value` is E0107 "A function value takes its arguments by position, without names: `by(a, b)`; a
function defined with `fn` takes every argument by name." (P7), and a comma before `)` is E0101 "An argument list ends
after its last argument; remove the comma before `)`." (P8). In a named call a later unnamed argument keeps `arg()`'s
E0107. `example()` also accepts `apply` on the left, so `twice(2) == 4` reaches the checker's E0107 with its fix.

**Printer:** `` `${pathText(e.target.path)}(${e.args.map((a) => printExpr(a, indent)).join(", ")})` ``; `levelOf` gives
`atom`, so `not test(high)` and `rule.broken(line).name` print without parentheses.

**Checker** (`case "apply"` in `infer`):

```ts
private apply(e: Extract<Expr, { kind: "apply" }>, scope: Scope): Type {
  const at = firstLine(printExpr(e, ""));
  const path = e.target.path;
  const rest = () => { for (const a of e.args) this.expr(a, scope, null); };
  // A hidden name (statements, T7) counts as a local, so name_() reports E0236.
  const head = scope.lookup(path[0]);
  if (head === undefined && !scope.isHidden(path[0])) return this.positionalCall(e, scope, at);
  if (head !== undefined && path.length > 1 && this.fieldPath(head, path.slice(1)) === null) {
    // `xs.map(f)`: the method-call habit (5.7), as for named arguments.
    this.report("E0220", at, `There are no method calls (3.1); \`${path[0]}\` is a value. Pass it as a named argument instead.`);
    rest();
    return ERROR;
  }
  const t = this.expr(e.target, scope, null); // name_(): the local, its fields, uses, E0236
  if (isBottom(t)) { rest(); return ERROR; }
  if (t.k !== "fn") { /* E0238, not a function */ rest(); return ERROR; }
  if (t.params.length !== e.args.length) { /* E0238, count */ }
  // Each argument against its parameter where one exists, also after E0238,
  // so `by(None)` adds no E0210 (5.6).
  e.args.forEach((a, i) => this.expr(a, scope, t.params[i] ?? null));
  return t.params.length === e.args.length ? t.out : ERROR;
}
```

- `isHidden` stands for whatever `statements` calls its hidden-name lookup. `fieldPath(t, segments)` walks record fields
  silently and returns `null` at a segment that is no field (`ERROR` passes through), so nothing is reported twice.
- Arguments get their parameter types as expected types (1.4): `by(None, x)` types `None`.
- **E0238, not a function:** "`count` has type `Int` and is not a function value, so it cannot be applied." No
  `expected`, no fix. **E0238, count:** "`by` takes 2 arguments, found 1: its type is `(Int, Int) -> Order`.",
  `expected` the type.

**`positionalCall`** (a function defined with `fn`, written by position):
- No such function: E0201 "Unknown function `twice`.", as for a named call; closest-name candidates are the visible
  locals and the module's functions for one segment, all functions otherwise.
- As many parameters as arguments: **E0107** at `at`, "`twice` is defined with `fn`, so every argument carries its
  parameter name (4.1); only a function value is applied by position.", with `expected` and `fix: { replace: at, with }`
  the named form, `printExpr({ kind: "call", path, typeArgs: [], args: params.map((p, i) => ({ name: p.name, value:
  e.args[i] })) })` (`twice(x: x)`, `std.int.compare(left: a, right: b)`). Then check that synthesized call with
  `this.call(...)`, so the arguments get their types and nothing follows from the missing names (5.6); its own causes
  (a wrong argument type) are still reported. Return `ERROR`.
- Another count: E0107 without a fix, `expected` `twice(x: Int)` (parameters with types); arguments checked without
  expected types.

**E0220 in `call()`** (`check.ts:803-811`), for named arguments on a function value. If the head is a local, compute
`t = fieldPath(local, rest)`. If `t` is a function type, and the path is not one segment naming a function of the module
(then the named call goes to that function, as today), report E0220 "`f` is a function value of type `(Int) -> Int`; it
takes its arguments by position, without names (4.1).", with `expected` and `fix` the apply with the same values in the
written order (`f(1)`, `rule.broken(line)`) when their count equals the type's and there are no type arguments, else
`expected` the type and no fix; check each value against the type's parameter at its position where one exists (so
`f(x: None)` adds no E0210), the others without; return `ERROR`. Otherwise a dotted path keeps
today's method-call E0220 (`xs.length()`, `greeting.print_line()` unchanged), and a one-segment local that is no function,
without a module function of its name, stays E0201.

**E0221:** `checkFn` (`check.ts:415-427`) takes the path from `ex.left.target.path` for an `apply`, so `twice(2) == 4`
gets E0107 with the fix `twice(x: 2)`, not E0221.

**Emitter:** `case "apply"`: `` `${this.expr(e.target, scope)}(${e.args.map((a) => this.expr(a, scope)).join(", ")})` ``.
The target is always a local (its TypeScript name through `Scope`, `$` for reserved words). Never awaited: every function
value outside std's handler is pure (F3), and pure functions are synchronous.

**refs.ts:** `case "apply": return { kind: "apply", target: e.target, args: e.args.map(expr) };`. The target is a
local, never a reference, so `refs`, `rename` and E0510 see only the arguments; renaming a function `g` to `f` beside a
local `f` changes nothing an apply denotes, since a named call is never an apply.

**Effects:** applying is pure. It may stand in a body, a lambda, `requires`, `ensures`, `where` and examples; no E0230,
E0232 or E0233 comes from it.

**Runtime:** no change in this phase. Stored texts and hashes stay as they are, since no existing form prints
differently; only texts with the new forms are new.

### 2.3 F3: user function types are pure [language]

Every function type written in user code is pure; its values are lambdas or pure functions' names, which the existing
E0232 in `name_()` enforces (the expected type has no `"caller"` mark). `with effects` stays the mark of std's `handler`
(P6). Why: 2.4, and 2.1 locality: a `fn` applying a function with effects would trigger effects its own signature cannot
list, since they depend on what each caller passes. Alternative: `with effects` on user parameters, the caller declaring
the passed function's effects as for `std.http.serve`; it needs async application and effect-polymorphic checking.

### 2.4 F4: no `fn` returns a function value (E0237) [language]

**Why.** A pure function needs an example (5.1, E0401); an example compares its result with `==` (E0105); `==` on a
type holding a function is E0222 (3.9). So a pure function whose `out` holds a function could never be accepted, and
the model would meet E0222 at every example, or E0401, without being told why. Reject such an `out` for every `fn`, with
or without effects, so the rule is one sentence. Loosening it later breaks no program (3.8, the argument of M1);
`const` (row 6, no examples) is where a table of functions would live, and `generics` (row 7) revisits it for
`compose`. Lambdas may still return functions; they have no examples.

**Rule.** In `checkFn`, before `requires`: `this.section = "out"`; if `containsFn(sig.out, (n) =>
this.env.recordFields(n))`, report **E0237** at `printTypeRef(def.out)`, no `expected`, no fix, and set `outHoldsFn`.
Message:

> "`measure` returns `Option<(Sale) -> Int>`, which holds a function value; a `fn` never does, since its result could
> not be compared, shown or stated in an example (3.9, 5.1). Build the function where it is applied, with `let` (from
> a `match`, an `if` or a map literal), or take what decides it as a parameter."

`containsFn` reaches records and variants, so `out: List<Measure>`, `Measure` having a function field, is E0237 too.
One cause, one diagnostic (5.6): while `outHoldsFn` is set, `binary()` skips E0222 in `section === "examples"`. E0401
for such a function with `examples: none` is still reported (true once `out` changes; pin the pair). This runs in pass
3 (`check()`), when every record's fields are declared.

### 2.5 Equality, `show`, examples, actual values, contracts

- **Equality and `std.text.show`:** `==`, `!=`, `show` and `std.list.contains` stay E0222 on every type holding a
  function value, now also user records with a function field. Function values have no identity (3.9).
- **Examples pass functions** as a lambda or a pure function's name: `first_true(low: 0, high: 5, test: fn(n: Int): Bool
  => n > 9) == None`, `apply_twice(f: double, x: 3) == 12`. The emitter writes `actual: () => calc$first_true(0, 5,
  ((n: number): boolean => ...))`; E0402 quotes the call as printed, lambda included.
- **Actual values never hold a function,** since no `fn` returns one (F4); `showValue`'s fallback stays as a guard.
  Empty collections of function types are written (F8): `std.list.empty<(Int) -> Int>()`. A zero-parameter function type
  has no written form (F5), so its empty list still prints `[]`: the only H5 case left, and the pins with `g` stay.
- **Contracts and `where`:** `requires: by(low, high) != Greater` and `ensures` may apply a parameter, and a record's
  `where` may apply a function field, since applying is pure. The scopes are as in 7.6.

### 2.6 F9: `search_type`, hits and MCP (commit 4)

- **Patterns.** `TypePattern` becomes `{ kind: "named"; name; args } | { kind: "fn"; params; out }`. In
  `parseFnPattern`, a type starting with `(` reads a list of at least one type (else E0511 "A function type takes at
  least one parameter."), `)` (else E0511 "A parameter list is not closed with `)`."), `->` and the result. A whole
  pattern in parentheses reads as the top-level form, since nothing else could parse: if the text starts with `(` and
  the matching `)`, `->` and one result type end it, those are the parameters and result (`(String) -> Option<Int>` is
  `String -> Option<Int>`, `() -> Int` is `-> Int`); otherwise rewind and read normally.
- **Matching.** A `fn` pattern matches a `fn` tree with as many parameters, each and the result by the same rules,
  sharing `bound`; `compatible` handles both kinds; `_` matches any function type, as today; a std type variable can be
  bound to a function pattern.
- **Expected** (by hand; to verify): `List<_>, (_) -> Bool -> List<_>` gives `std.list.drop_while`, `filter`, `map`,
  `take_while` (`map` matches: its `U` binds to `Bool`); `List<Int>, (Int, Int) -> Order -> List<Int>` gives
  `std.list.sort`; `(String) -> Option<Int>` gives `std.int.parse`.
- **MCP:** the `search_type` description (`mcp.ts:230-233`) gains "A function-typed parameter is written as a function
  type: `List<_>, (_) -> Bool -> List<_>`."

### 2.7 Spec changes (exact texts; each goes in the commit of its rule)

**Commit 1.**
- **Overview table**, after `Result<T, E>`: "| `(T) -> U`, `(T, U) -> V` | A function value: a lambda or the name of a
  pure function. Pure (2.4), at least one parameter, applied by position: `f(x)` |"
- **2.4:** "**2.4 Pure lambdas.** Lambdas passed to functions have no effects, and neither has any other function value:
  a function type such as `(Int) -> Bool` is pure. Effects per element go through `for`."
- **Grammar:** the `type` line of 2.1.
- **7.1:** delete "Function types in your own signatures | Only std functions take functions …"; add "| A function type
  with effects, `(T) -> U with effects`, or without parameters, `() -> T` (E0101) | A pure function type with at least
  one parameter; effects go in a `for` or in the function that calls it, and a value that needs no parameters is passed
  as the value itself |"
- **7.2, Foreign forms**, append: "A function type written as in another language, `(Int) => Int`, `(x: Int) -> Int`,
  `Int -> Int` or `fn(Int) -> Int`, is E0006, naming `(Int) -> Int`."
- **7.5**, a new bullet before "Function values": "**Function types.** A function type lists its parameter types in
  parentheses, at least one, then `->` and the result type: `(Int) -> Bool`, `(Row, Row) -> Order`. It stands wherever
  a type does (a parameter, a field, a case's value, a `let`, a `for`, a lambda, a type argument such as
  `List<(Int) -> Bool>` or `std.list.empty<(Int) -> Bool>()`), and it nests: `((Int) -> Int) -> Int` takes a function,
  `(Int) -> (Int) -> Int` gives one. Function types are pure (2.4)."
- **7.8 intro:** "A type such as `(T) -> U` is a function parameter; pass a lambda or a function name (7.5)." becomes
  "A type such as `(T) -> U` is a function type (7.5); pass a lambda, a function name, or a local that holds a function."

**Commit 2.**
- **Section 3 table:** "| Call a function | `module.name(parameter: value)`; a function value by position: `by(a, b)` |"
- **4.1**, append: "A function value is the one exception: a function type such as `(Int, Int) -> Order` names no
  parameters, so a parameter, field or binding of that type is applied by position, `by(a, b)`, just as a case's value
  has no name (4.2). A function defined with `fn` is always called with named arguments."
- **Grammar:** `expr` and `apply` (2.2).
- **Section 4, after the sum-of-lengths fragment:** "A function that takes a function: its parameter has a function
  type, the body applies it by position (4.1), and the examples pass lambdas:" and this block, a test case accepted with
  its examples run (section 4). By hand, and observed with a transcription of the body (`first_true.ts` in the probe
  directory): test(100) holds; (0,100) mid 50 holds → (0,50) 25 holds → (0,25) 12 holds → (0,12) 6 fails (36) → (7,12)
  9 holds → (7,9) 8 holds → (7,8) 7 fails (49) → (8,8) gives `Some(8)`; test(5) fails, so `None`.

```
fn calc.first_true
  doc: "The smallest number from low to high for which test holds, found by halving the range; None if test does not hold at high. test must stay true from the first number for which it holds."
  in:
    low: Int
    high: Int
    test: (Int) -> Bool
  out: Option<Int>
  effects: none
  requires: low <= high
  ensures: none
  examples:
    first_true(low: 0, high: 100, test: fn(n: Int): Bool => n * n >= 50) == Some(8)
    first_true(low: 0, high: 5, test: fn(n: Int): Bool => n > 9) == None
  body:
    if not test(high) then
      return None
    end if
    if low == high then
      return Some(high)
    end if
    let middle: Int = (low + high) / 2
    if test(middle) then
      return first_true(low: low, high: middle, test: test)
    end if
    return first_true(low: middle + 1, high: high, test: test)
end fn calc.first_true
```

- **7.5, "Calls and construction (4.1)"**, append: "The one exception is a function value, applied by position (below)."
- **7.5, "Function values"** becomes: "**Function values.** A value of a function type is a lambda, a local or field that
  holds one, or the name of a pure function that is not generic (`by: std.int.compare`, `with: double`; E0232 for one
  with effects, E0210 for a generic one, which needs a lambda). A function value is applied by position, `by(a, b)`,
  since its type names no parameters. With names it is E0220, a value that is no function or a wrong number of
  arguments is E0238, and a function defined with `fn` called by position is E0107, whose fix names the parameters.
  Applying is pure, so it may stand in a lambda, a condition or an example; `with effects` belongs to the `handler` of
  `std.http.serve` alone, which may have effects, and the caller then declares them (E0230). An example passes a
  function as a lambda or by name: `first_true(low: 0, high: 5, test: fn(n: Int): Bool => n > 9) == None`. Function
  values have no `==` and no `std.text.show` (E0222)."
- **7.5, "Names":** "A path followed by `(` is always a call, so a local may share its name with a function: `let total:
  Int = total(items: xs)`." becomes "A path followed by `(` and named arguments, or by `()`, always calls a function
  defined with `fn`, so a local may share its name with a function: `let total: Int = total(items: xs)`. Followed by `(`
  and unnamed arguments, it applies a local function value (above)."
- **7.11**, after `statements`' E0236 row: "| E0238 | Applying a value that is no function, or with the wrong number of
  arguments |"

**Commit 3.**
- **7.1:** "| A `fn` whose result holds a function value: `out: (Int) -> Int`, also inside a `List`, a `Map`, an `Option`
  or a record (E0237) | Choose the function where it is applied: `let by: (Row, Row) -> Order = ...` there, from a
  `match`, an `if` or a map literal; or take what decides it, such as a name, as a parameter |"
- **7.5 "Function values"**, before "An example passes": "No `fn` returns a function value, also not inside a list, a
  map or a record (E0237)."
- **7.11:** "| E0237 | A `fn` whose result holds a function value |", before E0238.

**Commit 4.** 7.10, the `search_type` row appends: "A function-typed parameter is written as a function type:
`List<_>, (_) -> Bool -> List<_>` finds `std.list.filter` (`_` matches it too), and a whole pattern in parentheses,
`(String) -> Option<Int>`, reads as `String -> Option<Int>`."

### 2.8 Card (`src/card.ts`)

Measured with `card_after.ts` and `card_variant.ts`, which apply `statements` 2.8's edits as text and then these
(observed):

| Card | Lines | Bytes | Longest line |
| --- | ---: | ---: | ---: |
| HEAD | 158 | 9,439 | 118 |
| After `statements` | 158 | 9,630 | 118 |
| After `statements` plus this phase | 159 | 9,714 | 118 |

The phase adds 1 line and 84 bytes; 1 line and 526 bytes stay under the guard. **Commit 2:** the lambdas bullet's last
two lines become

```
  A pure function's name is a value too: `by: std.string.compare`. A parameter, field or `let` may have a function
  type such as `(Int, Int) -> Order`, applied by position: `by(a, b)`. An `Option` inside a lambda is unwrapped
  with `std.option.with_default` or `std.list.filter_map`.
```

and "Not in alang" drops "function types in your own signatures":

```
(use recursion), `?`, braces, `;`, `'`, `===`, `&&`, `||`, `!`, tuples, generic definitions, concurrency. Most of
these get E0006, which names the alang form.
```

**Commit 3** adds the E0237 sentence, giving the measured text:

```
  A pure function's name is a value too: `by: std.string.compare`. A parameter, field or `let` may have a function
  type such as `(Int, Int) -> Order`, applied by position: `by(a, b)`. No `fn` returns one (E0237). An `Option`
  inside a lambda is unwrapped with `std.option.with_default` or `std.list.filter_map`.
```

Every std name on it exists; the program `temp` is unchanged.

### 2.9 `docs/decisions.md` and `docs/notes.md`

`decisions.md`:
- **Syntax**, new rows "Function types" (F1, F5, F6, the parser messages, the `tryTypeArgs` rethrow; commit 1) and
  "Applying a function value" (F2, decided by the first argument as in `payload()`, P7, P8; commit 2).
- **Type checking:** rewrite "Function values" (F2, F7, F10, F11; commit 2); new row "Function results" (F4; commit 3);
  "Locals vs functions" gains the unnamed/named sentence (commit 2); "std signatures": the surface writes function types,
  not type variables (commit 1); "List literals": the H5 sentence now covers zero-parameter function types only (F8,
  commit 1).
- **Effects, "Function values":** "User code cannot declare such a parameter, since it has no function types." becomes
  "User function types are pure (F3): only the `handler` of `std.http.serve` takes a function with effects, and
  `with effects` in user code is E0101." (commit 1).
- **Examples and acceptance, "Actual values":** the H5 sentence becomes "An empty list or map whose type holds a function
  type without parameters, which has no written form, prints through `std.text.show` (`[]`, `[:]`); other function
  types are written (`std.list.empty<(Int) -> Int>()`, F8). No actual value holds a function otherwise, since no `fn`
  returns one (F4)." (commit 1; the last sentence in commit 3).
- **Database, `search(type)`:** "a function-typed std parameter matches only `_`" becomes the rules of 2.6 (commit 4).
- **Open questions:** delete "Function types" (commit 2).

`notes.md` (commit 5): "Current state" gets an item for this phase, the test count, "Next" and the review list (F1 to
F11). Mark resolved: "`search(type)` cannot express function types", "The handler exception is std-only" (decided by
F3), "Function types are needed in user code", the grammar bullet of "Spec observations", and "An empty actual list of
function values" (now zero-parameter types only). Add to "Left for later": F4's revisit in `const` and `generics`, and
generic functions as values (F10).

## 3. Commits, in order

**Cut order** if the run must stop early: drop commit 4, then commit 3 (without it a `fn` returning a function is still
rejected, by E0222 or E0401, with a worse message). Commits 1 and 2 are the phase.

1. **[language] Function types `(T, U) -> V`** (F1, F3, F5, F6, F8). `lexer.ts` (`->`); `ast.ts` (the union);
   `parser.ts` (`type()`, `functionType()`, `parameterType()`, `typeForm()`, `tryTypeArgs()`); `printer.ts`; `check.ts`
   (`resolveType`, `writable`, `toTypeRef`); `emit.ts` (`ts()`); `refs.ts` (`type`); `interface.ts`; `search.ts`
   (`TypeTree`, `treeOfRef`, `treeOfType`, `namedTypes`, `showTree`); the comments of 2.1. Spec and `decisions.md`: the
   commit 1 texts. Tests 1.1–1.9.
2. **[language] Apply a function value by position** (F2, F7). `ast.ts` (`apply`); `parser.ts` (`pathExpr`,
   `opensApplication`, `applicationArgs`, `example`); `printer.ts`; `check.ts` (`apply`, `positionalCall`, `fieldPath`,
   E0220 in `call()`, E0221's path, E0238); `emit.ts`; `refs.ts`. Spec, card, `decisions.md`: the commit 2 texts;
   `spec_test.ts` inventory. Tests 2.1–2.10.
3. **[language] No `fn` returns a function value** (F4). `check.ts` (`checkFn`, `outHoldsFn`, `binary()`). Spec, card,
   `decisions.md`: the commit 3 texts. Tests 3.1–3.4.
4. **`search_type` patterns with function types** (F9). `search.ts`, the `mcp.ts` description, spec 7.10,
   `decisions.md` Database. Tests 4.1–4.3.
5. **Notes and the round.** `notes.md` (2.9); save the round prompt (section 7) to
   `~/coding_projects/alang-rounds/prompts/rank.md`, as `statements` did for `tickets.md`, and the reference script
   beside it as `rank-reference.ts` (copied from the probe directory by the main session; if it is gone, check 4 of the
   analysis builds its own).

## 4. Tests

Each language commit's programs go into `check_test`'s `accepted` list (with `clean()`), which `deno check` runs at the
end; each run test goes into `emit_test`'s `PROGRAMS`, TS-checked as a whole. Module `m`, built with the `fn(...)`
helper of `check_test.ts:29-54` unless named otherwise. Shared fixtures: a record `m.Rule(name: String, broken: (String)
-> Bool)`, a variant `m.Check` with cases `Custom: (Int) -> Bool` and `Off`, pure functions `double` and `triple`
(`Int -> Int`) and `to_text` (`Int -> String`).

**Commit 1**
1. **`syntax_test`, round trips** (`parseProgram`/`printProgram`, byte for byte): parameters `f: (Int) -> Int`,
   `by: (Int, Int) -> Order`, `g: ((Int) -> Int) -> Int`, `h: (Int) -> (Int) -> Int`, `fs: List<(Int) -> Bool>`,
   `table: Map<String, (net.port.Port) -> Bool>`; the `Rule` field and the `Custom` case; `let f: (Int) -> Int = double`;
   a lambda `fn(f: (Int) -> Int): (Int) -> Int => f`; the expression `std.list.empty<(Int) -> Bool>()`.
2. **`syntax_test`, P1–P6:** each input of 2.1's table as a parameter type gives its code and exact message;
   `std.list.empty<(x: Int) -> Int>()` gives P1 (rethrown from `tryTypeArgs`); `canonicalExpr("n < (limit)")` is still
   `n < limit`, and `n < Limit` stays.
3. **`check_test`, clean:** `m.sorted(xs: List<Int>, by: (Int, Int) -> Order): List<Int>` returning
   `std.list.sort(list: xs, by: by)`, with the examples `sorted(xs: [3, 1, 2], by: std.int.compare) == [1, 2, 3]` and
   `sorted(xs: [3, 1, 2], by: fn(a: Int, b: Int): Order => std.int.compare(left: b, right: a)) == [3, 2, 1]`; a `Rule`
   built in a body from a lambda and from a function name; `let pick: (Int) -> Int = if flag then double else triple
   end if`; `let ops: Map<String, (Int) -> Int> = ["d": double, "t": triple]` and `let op: (Int) -> Int =
   std.map.get(map: ops, key: k) else return 0`.
4. **`check_test`, errors:** `let f: (Int) -> Int = to_text` is E0204 "Expected `(Int) -> Int`, found `(Int) ->
   String`." with `expected` `(Int) -> Int`; `let f: (List<Int>) -> Int = std.list.length` is E0210; `m.shout` (console,
   `SHOUT` at `check_test.ts:839`) passed for a `(String) -> Unit` parameter is E0232; `by == by` and
   `std.text.show(value: rule)` are E0222; `m: Map<(Int) -> Int, Int>` is E0229 with "found `(Int) -> Int`";
   `keep: (Rowz) -> Bool` beside a type `m.Row` is E0202 at `Rowz` with the fix `Row`; `keep: (m.Row) -> Bool` inside
   `m` is E0226 at `m.Row` with the fix `Row`, and `shortened()` gives `(Row) -> Bool`.
5. **`check_test`, F8:** `let fs: List<(Int) -> Int> = []` is E0228 with the fix `{ replace: "[]", with:
   "std.list.empty<(Int) -> Int>()" }`, and the fixed program is clean; `let fs: List<(Int) -> Int> = std.list.empty()`
   is E0209 with the fix `std.list.empty<(Int) -> Int>()`. The three pins with `g` keep their values, commented "a
   zero-parameter function type has no written form (F5)".
6. **`accept_test.ts:326-331`:** `showValue([], list(fnType([INT], INT)), shapes, "m")` is
   `"std.list.empty<(Int) -> Int>()"`, the map `"std.map.empty<String, (Int) -> Int>()"`, `Some([])`
   `"Some(std.list.empty<(Int) -> Int>())"`; new: `showValue([], list(fnType([], INT)), shapes, "m")` stays `"[]"`.
7. **`emit_test`:** a program `fnvalues` with `sorted`, `Rule` and the `if`-chosen function; its examples run, it is
   TS-checked, and `m$sorted([3, 1, 2], (a, b) => …)` works from TypeScript.
8. **refs, rename, interface:** renaming the type `old.Row` to `fresh.Row` rewrites `keep: (old.Row) -> Bool` in another
   module to `(fresh.Row) -> Bool`, and `callers("old.Row")` listed that function before; replacing `keep: (Row) -> Bool`
   with `keep: (Row) -> Int` while a caller exists is E0506.
9. **queries:** the `list` hit of a stored `m.keep_if(rows: List<m.Row>, keep: (m.Row) -> Bool): List<m.Row>` carries
   exactly that signature after `fn ` and before `, effects: none`; `namedTypes(treeOfRef(<keep's type>, ["m"]))` is
   `["m.Row"]`.

**Commit 2**
1. **`syntax_test`:** `canonicalExpr("f(1)")` is `f(1)` (replaces the pin at `:110`); `"rule.check(\n  line,\n  2\n)"`
   gives `rule.check(line, 2)`; `not ok(x)`, `f(x).name` and `f(fn(n: Int): Int => n)` round-trip; `f(1, b: 2)` is
   E0107 with P7; `f(a: 1, 2)` is E0107 "Every argument carries its parameter name: `name: value`."; `f(1, )` is E0101
   with P8; `f()` still parses as a call.
2. **`check_test`, clean:** `test(n)` on a parameter `test: (Int) -> Bool`; `rule.broken(line)` on a `Rule` parameter;
   `fn(x: Int): Int => f(x)` inside `std.list.map`; `requires: by(low, high) != Greater`; the example
   `apply_twice(f: fn(n: Int): Int => n + 1, x: 1) == 3`; a parameter `check: (Int) -> Bool` beside a module function
   `check(n: Int): Bool`, where `check(1)` applies the parameter and `check(n: 1)` calls the function.
3. **`check_test`, with `statements`:** `check(x) else return Err(error)` with `check: (Int) -> Result<Unit, String>` is
   clean; `let [first, second]: List<(Int) -> Int> = fs else return 0` then `return first(second(1))` is clean; over
   `m.Check`, `case Custom(test) or Off then test(1)` is one E0236.
4. **`check_test`, E0107 (checker):** `return twice(x)` is one E0107 at `twice(x)`, `expected` `twice(x: x)`, fix
   `{ replace: "twice(x)", with: "twice(x: x)" }`, and the program after `applyFix` is clean; `std.int.compare(a, b)`
   has the fix `std.int.compare(left: a, right: b)`; `twice(1, 2)` has no fix, `expected` `twice(x: Int)`; the example
   `twice(2) == 4` is E0107 with the fix `twice(x: 2)`, section `examples`; `nothing(1)` is E0201 "Unknown function
   `nothing`."
5. **`check_test`, E0220:** `xs.map(f)` with `xs: List<Int>` has the method-call message at `xs.map(f)`; `f(x: 1)` with
   `f: (Int) -> Int` and no module function `f` gives "`f` is a function value of type `(Int) -> Int`; it takes its
   arguments by position, without names (4.1).", fix `f(x: 1)` → `f(1)`; `rule.broken(line: l)` has the fix
   `rule.broken(l)`; `f()` has no fix, `expected` `(Int) -> Int`; `xs.length()` keeps the old message.
6. **`check_test`, E0238:** `count(1)` with `count: Int` gives "`count` has type `Int` and is not a function value, so it
   cannot be applied."; `by(1)` with `by: (Int, Int) -> Order` gives "`by` takes 2 arguments, found 1: its type is
   `(Int, Int) -> Order`.", and `by(None)` gives only that E0238, no E0210; `by(1, "a")` is E0204 at `"a"`.
7. **`emit_test`:** a program with `calc.first_true` and a `List<Rule>` applied by field; examples run;
   `calc$first_true(0, 100, (n: number) => n * n >= 50)` is `{ tag: "Some", value: 8 }`; TS-checked.
8. **`spec_test`:** inventory 7 definition blocks and 18 definitions (3 statement fragments, 1 prefix); like the 7.9
   test, `fn calc.first_true` is accepted with 2 examples run. **`check_test`:** `clean(specBlock("fn calc.first_true"))`.
9. **refs:** in `m.uses(f: (Int) -> Int, x: Int): Int` with the body `return f(g(n: x))`, renaming `m.g` to `m.f` is
   accepted and gives `return f(f(n: x))` (the named call is the function, the unnamed one the parameter: no capture,
   E0510); `callers("m.double")` lists a definition whose example passes `double` by name.
10. **`card_test`** passes (codes, std names, budget).

**Commit 3**
1. **E0237:** `out: (Int) -> Int` is one E0237, section `out`, at `(Int) -> Int`, with 2.4's message ("`f` returns
   `(Int) -> Int`, …"); also one each for `out: Option<(Int) -> Int>`, `out: List<Rule>`, `out: Map<String, (Int) ->
   Int>`, `out: Check`, and an `effects: console` function with `out: (Int) -> Int`.
2. **One cause:** a pure `out: (Int) -> Int` with the example `f(n: 1) == double` gives only E0237, no E0222; with
   `examples: none`, `accept` reports E0237 and E0401 (pin both).
3. **Still clean:** `let add: (Int) -> (Int) -> Int = fn(x: Int): (Int) -> Int => fn(y: Int): Int => x + y`, `let inc:
   (Int) -> Int = add(1)`, `return inc(2)`; a pure function from `List<Rule>` to `List<String>`.
4. **`card_test`** passes with E0237 on the card.

**Commit 4** (by hand; to verify)
1. **`queries_test`:** `names("List<_>, (_) -> Bool -> List<_>")` is `["std.list.drop_while", "std.list.filter",
   "std.list.map", "std.list.take_while"]`; `names("List<Int>, (Int, Int) -> Order -> List<Int>")` is
   `["std.list.sort"]`; `names("(String) -> Option<Int>")` is `["std.int.parse"]`; `names("() -> _")` equals
   `names("-> _")`.
2. **E0511:** `(String -> Int` and `List<_>, () -> Bool -> _`; the malformed list (`:384` at HEAD) stays.
3. **Stored:** `m.keep_if` is found by `List<Row>, (Row) -> Bool -> List<Row>` and `List<_>, _ -> _`, not by
   `List<Row>, (Row) -> Int -> List<Row>`.

**Every commit:** `card_test` passes (codes and std names exist, at most 160 lines, under 10,240 bytes).

## 5. Decisions

F continues the roadmap's F1–F3 (`docs/plans/list-literals.md`, section 3), each re-examined against the code and kept:
F1 because std, `showType`, E0204 and `search_type` already print this notation; F2 because `payload()` already decides
by the same two tokens, and named application would need F1's rejected alternative; F3 because nothing in the code or
the rounds asks for user functions with effects, and 2.1 locality argues against it.

| # | Recommendation | Reason by principle | Alternative |
| --- | --- | --- | --- |
| F1 [language] | Function types `(T, U) -> V`, at least one parameter, nested to the right, on one line, wherever a type is written; `->` becomes a lexer symbol | 3: the one notation std, `showType`, `search_type` and E0204 already print; 1.1, 1.3: types before values, left to right | Named parameters `(left: T, right: T) -> Order`, which a lambda's own names would contradict and which give one type many spellings (3.7) |
| F2 [language] | A local, or a field of one, of function type is applied by position, `by(a, b)`; named arguments or `()` always call a function defined with `fn`; the first token after `(` decides, as in `payload()` | 4.2: a function type names no parameters, as a case's value has none; 1.2: one name, one function, and a local may still share a function's name | Named application through names in the type (needs F1's alternative); application only through std |
| F3 [language] | User function types are pure; `with effects` stays std's `handler` mark (P6, E0101) | 2.4; 2.1 locality: a function's effects stand in its own signature, not in what each caller passes | `with effects` on user parameters, the caller declaring the passed function's effects (effect-polymorphic checking) |
| F4 [language] | No `fn` returns a function value, also inside a `List`, `Map`, `Option`, record or variant (E0237 at `out`, no fix); lambdas may; E0222 in that function's examples is suppressed (5.6). Own commit | 5.1, 3.9: such a pure function could never get an example; 3.8: loosening later breaks no program (as M1); `const` and `generics` revisit it | Exempt such functions from 5.1 (`examples: none`), a verification gap |
| F5 [language] | No zero-parameter function types: `() -> T` is E0101 (P5); a function with `in: none` passed by name keeps the internal type `() -> T`, which has no written form | 2.2: a pure function without parameters is a value; pass the value | Allow `() -> T` |
| F6 | `(Int) => Int`, `(x: Int) -> Int`, `Int -> Int` and `fn(Int) -> Int` are E0006 naming `(Int) -> Int` (P1–P4), without fixes; `tryTypeArgs` rethrows them, except P4 (a lambda may follow `<`) | 5.7: TypeScript, Haskell and Rust habits get a message naming the alang form | The generic E0101 "Expected …" |
| F7 | Applying: E0238 for a value that is no function or a wrong count; E0220 extended to named arguments on a function value, with the positional fix; E0107 for a definition called by position moves to the checker, with the named fix, checked as that call | 5.5: a fix where the correction is mechanical; 5.6: no follow-up errors | One generic code; E0107 staying a parser error without a fix |
| F8 | Function types are written in fixes and actual values (`std.list.empty<(Int) -> Int>()`); H5 stays only for zero-parameter function types | 1.4, 3.7: the E0228 and E0209 fixes now have a spelling | Keep H5 for every function type |
| F9 | `search_type` patterns take `(P) -> R`, matched like any type; a whole pattern in parentheses reads as the top-level form; hits show and `context` follows the types inside function types. Own commit, cuttable | 3: one notation everywhere; 6.5: `context` lists `Sale` in `(Sale) -> Int` | Function-typed parameters match only `_`, as today |
| F10 | A generic function stays unusable as a value (E0210), even where an expected function type would fix its type arguments | Deferred to `generics` (row 7), where instantiation belongs | Instantiate from the expected type now |
| F11 | Records and cases may hold function values; such types have no `==`, `show` or `contains` (E0222) and no `fn` returns them (F4) | 3.9 anticipates types with function values; a table of handlers in a body needs them | Forbid function types in fields and cases |

## 6. Risks

- **The `TypeRef` union reaches six readers and two producers** (1.2); TypeScript finds each, and `statements`'
  `destructure.type` takes the union for free.
- **E0107 moves.** `f(1)` now parses (so `alang fmt` prints it, and an export file with it imports up to the check);
  `xs.map(f)` goes from E0107 to E0220, a better message but a changed code.
- **The `tryTypeArgs` rethrow** would break a valid comparison if a rethrown form could start an expression after `<`.
  None can (2.1), P4 is exempt, and tests 1.2 pin `n < (limit)` and `n < Limit`.
- **F4 may cost the round a resubmit.** A model will likely write `fn rank.measure(name): Option<(Sale) -> Int>` or a
  `measures()` table, both E0237. Whether its message leads to a `let` or a map literal in one step is check 2 of the
  analysis; if not, revisit F4 before `const`.
- **`statements`' bookkeeping.** `apply` must go through `name_()` (2.2), or a hidden name would read as a module
  function. Test 2.3 pins E0236 on an apply.
- **`context` gains second-level types** through `namedTypes` (`std.http.Request` beside `std.http.serve`); no pin lists
  them exactly (to verify).
- **TypeScript.** Function types print as `((p0: A) => R)`, safe inside unions and type arguments (observed); function
  values are synchronous, since every one outside std's handler is pure.
- **Card budget.** 159 lines and 9,714 bytes after both phases: 1 line and 526 bytes left; the next rule needs a cut.
- **Concurrent work.** Line numbers are at `7700807`; `statements` moves `check.ts`, `parser.ts`, `refs.ts`, `emit.ts`
  and the spec. Re-grep by function name.

## 7. Playground round

**Run** after the phase is merged:

```
scripts/playground-round.sh 2026-11-DD-rank <head of fn-types> ~/coding_projects/alang-rounds/prompts/rank.md opus
```

The script builds the empty playground, a worktree of the commit and the MCP config under
`~/coding_projects/alang-rounds/`, and passes the round's `CLAUDE.md` (shell: `alang`, `cat`, `ls`, `printf`, `echo`,
`mkdir`, `cd`, joined with `;`). It runs headless without the advisor, from an empty codebase, taught only by `card`
and the std queries. Check `instructions=sent` in `done.txt`; afterwards `git worktree remove --force
~/coding_projects/alang-rounds/2026-11-DD-rank/wt`.

**Prompt** (save as `rank.md`; it names none of the new forms):

> Build `rank`, a command-line tool in alang that ranks the products of a shop by different measures, using the alang
> MCP tools; choose the module name yourself. It reads `sales.txt` in the current directory: one product per line,
> `<product> <units> <price>`, exactly three fields separated by single spaces, the product a name without spaces,
> units and price whole numbers of 0 or more (the price in cents). A product has three measures: `units` (units sold),
> `price` (price in cents) and `revenue` (units times price). It is started as `alang db run <main> -- <command> ...`:
>
> - `measures` prints one line per measure, `<measure>: <description>`, in the order above, with the descriptions in
>   parentheses above.
> - `top <n> <measure>` prints the `n` products with the largest value of the measure (all of them if there are
>   fewer), largest first, products with equal values in alphabetical order of their names; one line each,
>   `<rank>. <product> <value>`, numbered from 1.
> - `bottom <n> <measure>` does the same with the smallest values first, equal values again alphabetically.
> - `goal <measure> <amount>` takes products in the order `top` lists them until their values add up to at least
>   `amount`, and prints `<products joined by ", "> reach <sum>`; if all of them together stay below `amount`, it
>   prints `out of reach: <sum of all>`.
>
> `n` and `amount` are whole numbers of at least 1. Errors go to stderr with exit code 1: no command, an unknown
> command or measure, a wrong number of arguments, or an `n` or `amount` that is not a whole number of at least 1
> prints `usage: rank top|bottom <n> <measure> | goal <measure> <amount> | measures`; a line of `sales.txt` not in the
> form above prints `sales.txt line <k> is malformed`; a file problem prints `cannot read sales.txt: <reason>`, the
> reason in words such as `no such file or directory`. Keep the logic in pure functions with examples, and write the
> ranking once: `top`, `bottom` and `goal` go through the same function for every measure, and adding a fourth
> measure should take one new line. Then, in the current directory: first run `top 3 units` before `sales.txt`
> exists; then create `sales.txt` with the lines `apple 30 50`, `pear 12 80`, `plum 45 20`, `kiwi 7 150`,
> `fig 30 90`, and run `measures`, `top 3 units`, `top 2 revenue`, `bottom 2 price`, `bottom 3 units`,
> `top 9 price`, `goal units 80`, `goal revenue 5000`, `goal price 1000`, `top 0 units`, `top 2 weight` and no
> command at all; then add the line `melon 3` to the end of `sales.txt` and run `top 1 units` once more. Show me every
> output and exit code.

**Expected results.** Computed by hand and observed equal from the reference script `round/reference.ts` in the probe
directory. Revenues: apple 1500, pear 960, plum 900, kiwi 1050, fig 2700.

1. `top 3 units` without the file: stderr `cannot read sales.txt: no such file or directory`, exit 1.
2. `measures`: `units: units sold`, `price: price in cents`, `revenue: units times price`.
3. `top 3 units`: `1. plum 45`, `2. apple 30`, `3. fig 30` (apple and fig tie, so by name).
4. `top 2 revenue`: `1. fig 2700`, `2. apple 1500`.
5. `bottom 2 price`: `1. plum 20`, `2. apple 50`.
6. `bottom 3 units`: `1. kiwi 7`, `2. pear 12`, `3. apple 30`.
7. `top 9 price`: `1. kiwi 150`, `2. fig 90`, `3. pear 80`, `4. apple 50`, `5. plum 20`.
8. `goal units 80`: `plum, apple, fig reach 105` (sums 45, 75, 105).
9. `goal revenue 5000`: `fig, apple, kiwi reach 5250` (sums 2700, 4200, 5250).
10. `goal price 1000`: `out of reach: 390`.
11. `top 0 units`, `top 2 weight` and no command: the usage line on stderr, exit 1 each.
12. After `melon 3`: stderr `sales.txt line 6 is malformed`, exit 1.

Steps 2–10 exit 0.

**Where the forms should appear, if the card teaches them:**

| Form | Expected use | Old idiom it replaces |
| --- | --- | --- |
| A parameter `value: (Sale) -> Int` of the one ranking function | `ranked(sales, value, largest_first)` shared by `top`, `bottom`, `goal` | A variant `Measure` with a `match` in `value_of(measure, sale)`, or one ranking function per measure |
| Application `value(a)` in the comparison lambda | `std.list.sort(list: sales, by: fn(a: Sale, b: Sale): Order => … value(a) …)` | `value_of(measure: m, sale: a)` |
| A record with a function field, applied by field: `Measure(name: "units", about: "units sold", value: fn(s: Sale): Int => s.units)`, `m.value(sale)` | The table that makes a fourth measure one line | Three parallel `match`es (name, description, value) over a variant |
| A `let`, list or map literal of function type where the command is dispatched | `let measures: List<Measure> = [...]`, or `["units": ..., ...]` with `std.map.get(...) else return Err(...)` | A `match` on the measure's name in every command |
| E0237, if the model writes `fn rank.measures(): List<Measure>` or `fn rank.measure(name: String): Option<(Sale) -> Int>` | — | — |

**Checks for the analysis.** A fresh Opus agent, read-only, works like the `tasks` round's step 1: it lists every tool
call, builds an independent reference (or reads and reuses `reference.ts`), reruns only in a scratch copy, and ranks
findings "fix now" or "later" with the files to touch.
1. **Teaching by the card:** count each form of the table in the accepted program, and each old idiom (a `Measure`
   variant with `match`, one ranking function per measure, repeated `match`es on names); check that `card` was called
   first; note whether examples pass lambdas or function names.
2. **Diagnostics per submit,** with codes, and whether each `fix`, `expected` or message led to the right form in one
   resubmit. Above all E0237: if it fired, how many submits until an accepted design, and was it the `let` or map
   literal the message names (the evidence for F4)? Then E0220, E0107 (a definition by position), E0238; E0006/E0101 for
   the function-type forms (`=>`, `(x: Int) -> Int`, `Int -> Int`, `fn(...)`, `with effects`, `()`); E0222 (comparing or
   showing a `Measure`), E0232, E0210.
3. **Discovery:** every `search` and `search_type` call, and whether a function-type pattern was tried and found what
   was meant.
4. **Correctness against the reference,** on Deno, in a scratch copy:
   - files: an empty `sales.txt` (`top 3 units` prints nothing, exit 0; `goal units 1` prints `out of reach: 0`), no
     final newline, CRLF line ends, 2 or 4 fields, a double space, a negative or non-numeric count, an empty product
     name, a malformed line in the middle;
   - numbers: `top 01 units` (lenient: `std.int.parse` reads 1), `top -1 units` and `top 2x units` (usage),
     `goal units 45` (`plum reach 45`), `goal revenue 7110` (`fig, apple, kiwi, pear, plum reach 7110`),
     `goal revenue 7111` (`out of reach: 7110`);
   - arguments: `measures extra`, `top 3`, `goal units`, an unknown command; no run traps (exit 70).
5. **Generated TypeScript:** `deno check` the round's `out/*.ts` in a scratch copy; whatever the checker accepts must
   type-check (Toolchain, "Checked output"), function types included.
6. **Effort:** tool calls by kind, time, output tokens, std `context` calls, whether the first submit was accepted.

### Critical Files for Implementation

- /home/josua/coding_projects/alang/src/check.ts (`resolveType`, `name_`, `call`, new `apply`/`positionalCall`/`fieldPath`, `checkFn`, `binary`, `writable`, `toTypeRef`)
- /home/josua/coding_projects/alang/src/parser.ts (`type`, `pathExpr`, `tryTypeArgs`, `example`), /home/josua/coding_projects/alang/src/lexer.ts (`SYMBOLS`)
- /home/josua/coding_projects/alang/src/ast.ts, /home/josua/coding_projects/alang/src/printer.ts, /home/josua/coding_projects/alang/src/emit.ts (`ts`, `expr`), /home/josua/coding_projects/alang/src/refs.ts (`rebuild`)
- /home/josua/coding_projects/alang/src/search.ts, /home/josua/coding_projects/alang/src/interface.ts, /home/josua/coding_projects/alang/src/codebase.ts (hits, `context`), /home/josua/coding_projects/alang/src/mcp.ts (`search_type` description)
- /home/josua/coding_projects/alang/alang-specs.md (Overview, 2.4, 3, 4.1, section 4's new block, 7.1, 7.2, 7.5, 7.8, 7.10, 7.11), /home/josua/coding_projects/alang/src/card.ts, /home/josua/coding_projects/alang/docs/decisions.md
- /home/josua/coding_projects/alang/tests/check_test.ts, syntax_test.ts, emit_test.ts, accept_test.ts, spec_test.ts, queries_test.ts (same directory)
