# Plan: phase 6, `const`

The planner wrote this on 2026-11-14, reading `std-net` at `7700807` (`main` plus phase `std-net`). The only file written was this plan; probes ran in a scratch directory (`/home/josua/.claude/jobs/7e0015cb/tmp/const-probes/`). Two `std-net` fixes landed during planning (`e6504ac`, `7a75e23`: SIGTERM and the HTTP client's `Failed` text). They touch `runtime.ts`, `toolchain.ts`, the spec, the notes and `decisions.md`, so line numbers there may have shifted, but not what this plan changes.

- **Observed:** facts from `alang check` on probe files, `deno check`, `deno run` and `node` (26.13.0) on a hand-written lazy-constant module, a `node:sqlite` migration script under Deno, and a script that measures the card, all on Deno 2.8.0.
- **To verify:** everything else, above all what `statements` and `fn-types` change before this phase is built.

The main session takes every recommendation, and nobody is asked. **[language]** marks a decision that changes the language; those are listed for the user's later review.

**Branch:** `const`, from `main` after `statements` (row 4) and `fn-types` (row 5) are merged. The phase depends on neither, but builds on both:
- `statements` adds the `propagate` and `destructure` statements, `Arm.patterns`, E0235 and E0236, and edits the card (its plan, 2.8);
- `fn-types` adds function types in signatures (`TypeRef` becomes a union), positional application of function values (`by(a, b)`), and its codes. This plan leaves it **E0237 to E0246**, ten codes after statements' highest checker code, and takes **E0247 to E0249** and **E0404**. E0405 is reserved for C6.

File:line references are at `7700807`; re-grep them after both phases merge. If statements' T5 ships, `withShortNames` and `shortenOwnNames` (named below) are `withOwnFixes` and `applyOwnFixes`. After every commit run `deno task test`, `deno lint` and `deno fmt --check`. Commit with explicit paths, never `git add -A`.

## 0. Scope

| Item | Where | Why |
| --- | --- | --- |
| `const` definitions: form, names, checking, TypeScript, acceptance | **This phase** (C1–C5, C13) | Roadmap row 6. Every round program repeats a value or a table (1.3) |
| Constants in the database and the MCP tools | **This phase** (C7–C11) | A new definition kind runs through the codebase |
| Diagnostics for habits around constants | **This phase** (C12), cuttable | 5.7. Three are observed today with a wrong fix or none (1.2) |
| The card | **This phase** (C15) | The card is how a round learns the language |
| Rejecting a pure function without parameters | **Later** (C6). E0401's message names `const` now, and E0405 is reserved | Principle 3 wants one form, but about 25 acceptance-test fixtures and the rounds' `tasks.usage` use the idiom. A round shows whether models still write it |
| A static cycle check | **Not planned** (C4) | Acceptance evaluates every constant, which finds every cycle a run can meet, and only those |
| A constant's evaluated value in queries | **Later** | `context` shows its text (C10). A value would need acceptance results in queries |
| Constants in `search_type` | **Not planned** (C9) | It answers what to call with which arguments |
| `extern fn` | Roadmap row 8 | E0199 stays for it |

## 1. Findings

### 1.1 How a definition kind flows through the toolchain

| File | What it does with kinds today | What `const` needs |
| --- | --- | --- |
| `src/lexer.ts:28-60` | `const` and `extern` are keywords already | Nothing for the keyword. SCREAMING_SNAKE at `:222-232` (C12) |
| `src/ast.ts:109-137` | `Definition = FnDef \| TypeDef` | `ConstDef` in the union |
| `src/parser.ts:156-165` | `definitionDef()`: `const` and `extern` are E0199 "`const` definitions are not supported yet." | `constDef()`. E0199 stays for `extern` |
| `src/parser.ts:186-213` | `definitionPath(kind: "fn" \| "type")`, `endDef(kind, path)` | A `"const"` kind with a snake_case path, as for `fn` |
| `src/parser.ts:431-453` | `stmt()`: a `const` statement falls to `expr()` | E0006 for `const` in a body (C12) |
| `src/printer.ts:14-33` | `printDefinition`, `printSignature`: fn or type | `printConst`. The signature leaves out `body` |
| `src/check.ts:46` | `NameResolution` is a local or a fn | A `const` resolution with the number of path segments that name the constant |
| `src/check.ts:114-125` | `Env` holds types, fns, cases | `consts: Map<string, Type>` |
| `src/check.ts:127-185` | `checkProgram`: pass 1 names (E0215 twice, builtins, `std`), pass 2 `declare()`, pass 3 `check()` | Pass 1 unchanged: a const and a fn of one full name are "defined twice". `declare()` and `check()` learn `const` |
| `src/check.ts:291-306` | `declare()` puts a fn's signature into `env.fns` | A const's `out` into `env.consts` |
| `src/check.ts:401-459` | `checkFn`: contracts, examples, body, E0218 (`:437`), E0230 | `checkConst`: the body with `out` as the return type, E0218 |
| `src/check.ts:667-717` | `name_()`: a local, else a function by `resolvePath` (a function value), else E0203 | The resolution of 2.2 |
| `src/check.ts:802-830` | `call()`: E0220 on a local head, E0201 for an unknown function | E0247 for a call of a constant |
| `src/check.ts:923-949` | `effectsOfCall`: E0232 in a lambda, E0233 outside `body`, else collected for E0230 | E0233 with its own text in a const body |
| `src/check.ts:1015-1029` | `construct()`: E0203 "Unknown type or case" | A fix to a constant's snake_case name (C12) |
| `src/emit.ts:72-85` | `emitProgram`: fn or type, then `$examples` | Constants, then `$constants` after `$examples` |
| `src/emit.ts:470-479` | A `name` resolved to a fn becomes its global; a local becomes its TS name plus fields | A constant becomes a getter call plus fields |
| `src/runtime.ts:178-193, 335-358` | `Trap`, `trap`, `runExamples` | `constant()`, `runConstants()`, `trapOrigin()`, `Constant` |
| `src/examples.ts:21-37, 81-100` | E0401 for pure fns without examples; E0402, E0403 | E0404. E0401's message for a function without parameters |
| `src/toolchain.ts:71-84, 103-107` | Acceptance: check plus E0401, emit, load, run the examples | Evaluate the constants first, from the same loaded module |
| `src/refs.ts:15, 137-141, 181-204` | `RefKind` is type, fn or case. A `name` resolved to a fn is respelled whole. `rebuild` handles fn and type | `"const"`; respell only the constant's segments; rebuild a const |
| `src/interface.ts:50-72` | fn/fn and type/type; any other pair throws a plain `Error` (`:71`) | const/const compares `out`; a kind change (C7) |
| `src/codebase.ts:139-145, 238-256` | `Hit.kind`, `Row.kind`, `Stored.kind` are `"fn" \| "type"` | `Definition["kind"]` |
| `src/codebase.ts:171-200` | `kind TEXT NOT NULL CHECK (kind IN ('fn', 'type'))`; `CREATE TABLE IF NOT EXISTS` never changes an existing table | A migration (C11) |
| `src/codebase.ts:259-264, 290-294` | `signatureTypes`, `storedHit` | The const's `out`; `const name: Type` |
| `src/codebase.ts:380-383` | `headerName` reads `fn <name>` or `type <name>` | `const` too |
| `src/codebase.ts:610-628` | `context` lists a used stored definition by its `signature` | A used constant by its text (C10) |
| `src/codebase.ts:704-720` | `searchType` skips everything but functions | Unchanged: constants stay out (C9) |
| `src/codebase.ts:1061-1072` | Replace: "The name also fixes the kind" | Fn and const share snake_case names, so a replace may change the kind (C7) |
| `src/codebase.ts:1240-1270` | `callerRule`: E0506 from `interfaceChange` | The kind-change message |
| `src/codebase.ts:1281-1293` | `lackingEffects` follows fn callers only | Unchanged: a const caller is listed, not followed |
| `src/codebase.ts:1620-1633` | `withShortNames` applies E0226 through `shortenOwnNames` | Works once `refs.ts` respells constants |
| `src/mcp.ts:84-112, 166-216` | Instructions (2,822 characters with the path; `tests/mcp_test.ts:500` keeps them below 3,000 without it); the descriptions of `context` and `list` | One phrase each |
| `src/card.ts:31-38, 103` | "A definition is a `fn` or a `type`", and `const` in "Not in alang" | K1–K5 (2.13) |
| `src/search.ts` | Type patterns over function signatures | Nothing |

**Name resolution today:**
- `name_()` (`check.ts:667-717`) tries `scope.lookup(head)` first. Then `resolvePath(path)` looks the name up in `env.fns`: one segment means the own module, more mean the path as written. A hit gives a function value (`fnType`). Otherwise the name is E0203. A field chain is read only on a local.
- `call()` (`:802-830`): a path whose head is a local is E0220; otherwise the path must name a function.
- The AST comment at `ast.ts:33-35` already foresees "a qualified constant" in a `name` node. `decisions.md` (Syntax, `a.b.c`) says that "whether it is a local with fields or a qualified constant is resolved later".

### 1.2 Today's behavior (observed with `alang check`)

- `const shop.max_items` … `end const shop.max_items` is E0199 "`const` definitions are not supported yet.", with `definition: null`.
- `const m: Int = 5` in a body is E0101 "Expected an expression, found `const`."
- `MAX_ITEMS` is E0002 "Type and variant names are written in PascalCase without underscores: `MAXITEMS`.", with the fix `MAXITEMS`. For a constant that points the wrong way.
- A pure `fn shop.limit` with `in: none`, used as `n < limit`, is E0204 "Expected `Int`, found `() -> Int`.", with no fix.
- `alang check`, `ts`, `build` and `run` all go through `accept` (read, `src/cli.ts:70-96`), and `alang db run` accepts the whole program (decisions, Database, Run). Only `alang test` builds without acceptance.

### 1.3 How programs stand in for constants today

- **The spec's blind test** (notes, "Constants are clumsy"): a pure function with `in: none` needs an example, which repeats the value. A list of three items took a 250-character example line.
- **The automated `tasks` round** (`~/coding_projects/alang-rounds/2026-11-14-tasks-auto/work/export/tasks.alang:329-340`, observed): `fn tasks.usage` has `in: none` and an example that repeats the usage text. It is called as `usage()` in five places.
- **The `std-net` round** (`~/coding_projects/alang-rounds/2026-11-14-std-net/work/export/`, observed):
  - `stock.server.count_of` holds the stock table inline: `return std.map.get(map: ["apple": 3, "pear": 0, "plum": 12], key: name)` (line 15);
  - `stock.server.parse_port` writes `"usage: stock.server <port>"` three times (lines 95, 100, 102);
  - `stock.client.parse_args` binds `let usage: String = "…"` locally and repeats it in an example (lines 113, 115).
- **Spec 7.1** teaches the idiom: "A function with `in: none` for a constant value, called as `limit()`; like every pure function it needs an example".

### 1.4 Tests that pin current behavior

- **Inventories:**
  - `tests/spec_test.ts:28` keeps only blocks whose first word is `fn` or `type`;
  - `:36-37` pins 6 definition blocks and 17 definitions;
  - `tests/card_test.ts:18-26` pins the card's program (`type temp.Problem`, `fn temp.fahrenheit`, `fn temp.main`). This plan leaves the program alone.
- **The card budget:** `tests/card_test.ts:146-149`, below 10,240 bytes and at most 160 lines.
- **Hits:** `tests/queries_test.ts:156-180` pins `list("net.port")` with the kinds `type` and `fn`. Nothing changes there.
- **Database invariants:** `tests/db_helpers.ts:116-135` checks that a row's `kind` and `signature` follow from its text. This holds for constants once `printSignature` knows them.
- **Pure functions without parameters that go through acceptance:**
  - `tests/accept_test.ts:105-113` (`m.a`, `m.b`, `m.c`: E0401 comes with type errors; codes only) and `:179-183` (`m.k`);
  - `tests/codebase_test.ts:60, 74, 175-206, 307, 325, 419, 473, 560, 598`;
  - `tests/rename_test.ts:158, 273-293`;
  - `tests/export_test.ts:171, 213, 234`;
  - `tests/mcp_test.ts:194-200, 466`.

  `tests/check_test.ts:99` (`G`) and the eight such functions in `tests/emit_test.ts` do not go through acceptance. These fixtures are why C6 defers a rejection.
- **What no test pins (grepped):**
  - E0199 for `const`;
  - "Expected a definition (`fn` or `type`)" and "Expected an expression, found";
  - the PascalCase text of E0002;
  - "found `() -> …`";
  - `interfaceChange` throwing.
- 307 tests at `7700807` (notes).

### 1.5 What `statements` and `fn-types` change for this phase

- **statements.**
  - A const body is a block like a function body, so `propagate` and `destructure` work there unchanged.
  - T3 (a `let` binds no `Unit`) is the model for C5.
  - The card after its 2.8: 158 lines and 9,630 bytes, observed by applying its texts to a scratch copy.
- **fn-types** (to verify against its plan):
  - `TypeRef` becomes a union, so `printConst`, `refs.ts` and `interface.ts` take whatever `printTypeRef`, the rebuild's `type()` and `fullType` become.
  - A constant whose type is a function type is E0248 (C5). A function type inside a constant's type is fine: a dispatch table `Map<String, (Int) -> Int>`, or a record with a function field.
  - Where fn-types resolves the head of a positional application (on a local or a field), call the resolution of 2.2, so that a function in a constant's field can be applied (`handlers.on_add(1, 2)`).
  - A function type has at least one parameter (F1). So the bare name of a function without parameters is never a valid value, which makes the E0204 fix of C12 safe.

## 2. Design

### 2.1 C1: the form [language]

```
const shop.max_items
  doc: "The most items one order may hold."
  out: Int
  body:
    return 100
end const shop.max_items
```

- **Sections.** `doc`, `out`, `body`, in this order and all present, then `end const <full name>`.
  - No new reserved word: `doc`, `out`, `body` and `const` are reserved already. `value` could not be, since it names fields everywhere (`Port(value: 8080)`).
  - The body is statements, as in a function, and its last statement is literally a `return` (E0218). So a table can be built with `let` lines, `if`, `match`, `for` and calls of pure functions.
  - The name is a value path in snake_case with a module, as for `fn`.
- **Grammar** (spec, section 3, after `type_def`):

```
const_def  = "const" path
             "doc:" string
             "out:" type
             "body:" stmt { stmt }
             "end" "const" path ;
```

- **AST** (`ast.ts`):

```ts
export interface ConstDef {
  readonly kind: "const";
  readonly path: Path;
  readonly doc: string;
  readonly out: TypeRef;
  readonly body: readonly Stmt[];
}

export type Definition = FnDef | TypeDef | ConstDef;
```

- **Parser.** `constDef()`, called from `definitionDef()`:
  1. `expectKeyword("const")`, `definitionPath("const")` (the value path of `fn`), `this.definition = name`, a line break;
  2. `docSection()`;
  3. `sectionHeader("out")`, `type()`, a line break;
  4. `sectionHeader("body")`, a line break, `block(["end"])`;
  5. `endDef("const", path)`.

  `definitionDef()`'s last message becomes "Expected a definition (`fn`, `type` or `const`), found …". `extern` keeps E0199.
- **Printer.** `printConst(def, body = true)`: `const <name>`, `doc`, `out`, then `body:` with the statements four spaces in, then `end const <name>`. `printSignature` of a const is the same without `body` (C10):

```
const shop.max_items
  doc: "The most items one order may hold."
  out: Int
end const shop.max_items
```

### 2.2 C2: names [language]

**Use.** A constant is used by its name, without parentheses: `max_items` in its own module, `shop.max_items` elsewhere (1.2). A field of a record constant follows the name: `limits.items`, `shop.limits.items`.

**Resolving a `name` node.** One helper, `resolveName(path, scope)`, called by `name_()`. Fn-types' positional application can share it. It reads left to right, as everything does (1.1):
1. **A local head.** The first segment is a local: the local and its fields. Unchanged.
2. **Readings.** Otherwise, collect every reading that fits:
   - (A) the path has at least two segments, and its first segment is a constant of the own module: that constant, and the rest as fields;
   - (B) the whole path names a constant or a function (one segment means the own module): that definition. A function gives a function value, as today;
   - (C) a shorter prefix of at least two segments is the full name of a constant: that constant, and the rest as fields.

   For one segment only (B) can fit. So a plain name is a local, then a constant, then a function; a constant and a function never share a full name (E0215 "defined twice").
3. **No reading** is E0203 "Unknown name". Its candidates now include the module's constants (short) and every constant as written from here.
4. **More than one reading** is **E0249** at the name, without a fix: "`m.c` names both the field `c` of the constant `m` of this module and the constant `m.c`; rename one of them, since a name has one meaning (2.6)." Each reading is described as "the constant `x`", "the function `x`", or "the field `c` of the constant `x`" ("the fields `c.d` of …").
5. **One reading** is used.

Readings depend on which definitions exist, not on field types, so the meaning of a name never depends on a type. An ambiguity needs one of two things, both rare:
- an own constant named like a module (`config` in `app`, beside a module `config`);
- a constant and a module with one full name (`shop.limits` beside `shop.limits.max`).

**Side table.** `NameResolution` gains `{ readonly kind: "const"; readonly name: string; readonly segments: number }`: the constant's full name, and how many leading segments of the path spell it. The rest are fields, typed with `this.field()` as for a local.

**Own module (1.2, E0226).** For (B) and (C), a constant of the own module written in full is E0226 on the constant's segments only:
- `at` is the whole name, such as `shop.limits.items`;
- the fix is `{ replace: "shop.limits", with: "limits" }`.

The node goes into `info.longForms`, so the codebase shortens it by itself (`withShortNames`).

**A local hides a constant.** A local named like a constant of its module takes the plain name (step 1). The constant is then written in full there, and that is not E0226, exactly as for a function value today (`decisions.md`, Own module names). It is not E0216: that would let adding a constant to a module break every body there that has a local of that name, the action at a distance that principle 2 forbids.

**Calls.** A call path stays a definition path; constants do not change that, with one exception. A call whose whole path is a constant is **E0247** at the call:
- message: "`limit` is a constant, not a function; it is used without parentheses: `limit`."
- with no arguments and no type arguments, the fix is `{ replace: "limit()", with: "limit" }`; otherwise there is no fix;
- the arguments are still checked, and the result is the error type.

### 2.3 C3, C5: checking

- **Declaration.** `Env.consts: Map<string, Type>`. `declare()` for a const sets `section = "out"`, then `env.consts.set(name, resolveType(def.out))`.
- **The body.** `checkConst(def)` sets `section = "body"` and `this.out = env.consts.get(name)`, then runs `this.block(def.body, new Scope(), DISCARD)`. A last statement that is not a `return` is E0218 "A constant's body ends with an explicit `return` (3.4)."
- **Pure (C3).** In `effectsOfCall`, after the lambda branch and before the `section !== "body"` branch, a const definition reports **E0233** at the call: "`std.time.now_milliseconds` has effects (time); a constant is pure, so its body calls only functions with `effects: none` (2.2)." No fix: E0230's fix rewrites an `effects:` line, which a constant does not have.
- **Type (C5).** **E0248** at `printTypeRef(def.out)`, in section `out`, without a fix, when the resolved type is:
  - `Unit`: "A constant holds a value, and `Unit` carries none (3)."
  - a function type (after fn-types): "A constant holds no function; write `fn shop.double` with parameters instead (3)."

  A function type inside another type is allowed. The constant keeps its declared type, so its uses report nothing more (5.6).
- **Names the language binds.** A constant named `result` or `error` would be hidden in `ensures` and after `let … else`. `constDef()` rejects such a name with E0109: "`error` is bound by the language and cannot name a constant."
- **Where constants may appear.** In `requires`, `ensures`, `where` and examples too, since they are pure. Examples see no locals, so a plain name there is a constant or a function.

### 2.4 C12: habit diagnostics (5.7)

Each was observed, or is the form a model brings from another language. Each gets exactly one diagnostic.

| Written | Today | Now |
| --- | --- | --- |
| `const m: Int = 5` in a body (JS, Swift, Rust) | E0101 "Expected an expression, found `const`." (observed) | **E0006** at the line: "Inside a body, a value is bound with `let`; `const` defines a constant of the module, with `doc`, `out` and `body`." Fix `{ replace: "const", with: "let" }` (parser, `stmt()`) |
| `MAX_ITEMS` (C, JS, Python, Rust, Java) | E0002, fix `MAXITEMS` (observed) | **E0002** for a word of capitals, digits and underscores with at least one underscore (`/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/`): "Constants and other values are written in snake_case: `max_items` (3.6).", fix `max_items`. `Max_Items` keeps the PascalCase fix (lexer) |
| `const shop.MaxItems` | E0199, as every `const` (observed). With only C1, E0101 "Expected a snake_case name, found `MaxItems`." | **E0002** at the name: "A constant is a value, so its name is snake_case: `max_items` (3.6).", fix `max_items` by `toSnakeCase` (parser, `constDef()`) |
| `const shop.max_items: Int = 100` (TS, Rust, Go) | E0199. With only C1, E0101 "Expected a line break, found `:`." (to verify) | **E0101** at the line: "A constant is a definition with sections, like a function: `doc`, `out` and `body`, then `end const shop.max_items`." `expected` is the full form with `doc: "..."` and `return <value>`, printed by `printConst`. No fix, since the doc is missing. The parser reads `: type = expr` after the path to build it; if that fails, the message stands without `expected` |
| `in:` in a const | E0199. With only C1, E0101 "Expected `out`, found `in`." | **E0101**: "A `const` has the sections `doc`, `out` and `body`; a value that takes parameters is a `fn`." |
| `effects:`, `requires:`, `ensures:` or `examples:` after `out` | E0199. With only C1, E0101 "Expected `body`, …" | **E0101**: "A `const` has the sections `doc`, `out` and `body` only: it is pure and needs no examples, since every acceptance evaluates it." |
| `limit()` on a constant | E0201 "Unknown function" | **E0247** (2.2) |
| `MaxItems` in a body where a constant `max_items` exists | E0203 "Unknown type or case `MaxItems`." | **E0203**: "`MaxItems` is not a type or case; the constant is `max_items`, in snake_case (3.6).", fix `max_items`. Only when `toSnakeCase` of the last segment names a constant as written there |
| A function without parameters where a value is expected: `let t: Int = std.time.now_milliseconds`, or `n < limit` | E0204 "Expected `Int`, found `() -> Int`." (observed), plus E0232 for an effectful one | **E0204** alone: "`std.time.now_milliseconds` is a function; call it: `std.time.now_milliseconds()`." The fix appends `()`. Raised in `name_()` when the function has no parameters and the expected type is known and not a function type. It returns the error type, so neither E0232 nor a mismatch follows |
| A pure function with `in: none` and `examples: none` | E0401 "`b` has `effects: none` and needs at least one example …", `expected` `b() == Int` | **E0401**, same code (C6): "`b` has no parameters and no effects, so it always gives the same value: write it as a constant, `const m.b`, which needs no example." `expected` is the const text, `printConst` of its `doc`, `out` and `body` |

### 2.5 C4, C13: TypeScript

Constants are pure, so a constant is a synchronous getter that evaluates its body once, on first use. This runtime code type-checks with `deno check` and runs on Deno and on Node.js 26 (observed, scratch `lazy/`):

```ts
// Constants whose evaluation is in progress, innermost last. Pure code is
// synchronous, so one stack serves the whole process.
const evaluating: string[] = [];
// The constant a trap first left; for a cycle, the one entered again.
const origins = new WeakMap<object, string>();

export function trapOrigin(e: unknown): string | undefined {
  return typeof e === "object" && e !== null ? origins.get(e) : undefined;
}

export function constant<T>(name: string, compute: () => T): () => T {
  let state: "new" | "busy" | "done" = "new";
  let value: T | undefined;
  return () => {
    if (state === "done") return value as T;
    if (state === "busy") {
      const chain = [...evaluating.slice(evaluating.indexOf(name)), name];
      const t = new Trap("cycle", name, name, `The constant ${name} depends on itself: ${chain.join(" -> ")}.`);
      origins.set(t, name);
      throw t;
    }
    state = "busy";
    evaluating.push(name);
    try {
      value = compute();
      state = "done";
      return value;
    } catch (e) {
      if (typeof e === "object" && e !== null && !origins.has(e)) origins.set(e, name);
      throw e;
    } finally {
      evaluating.pop();
      if (state === "busy") state = "new";
    }
  };
}
```

(The probe put `at` as `const <name>`; the plan uses the name, so that E0404's message needs no `(at …)`, 2.6.) A second `WeakMap` keeps the chain of each cycle trap for `runConstants`.

- **An emitted constant** (`DefinitionEmitter.constant(def)`; the body is `this.block(def.body, new Scope(), DISCARD)`, one level in):

```ts
export const shop$max_items: () => number = $rt.constant("shop.max_items", (): number => {
  return 100;
});
```

- **A use** is a call of the getter, then the fields: `shop$max_items()`, `shop$limits().items`. A constant defined later in the file than its user is fine, since nothing runs at load (observed).
- **The list for acceptance** comes after `$examples`, so every binding exists when the array is built. It is emitted even when empty:

```ts
export const $constants: readonly $rt.Constant[] = [
  { definition: "shop.max_items", value: shop$max_items },
];
```

- **After a trap** the state goes back to `new` (observed), so the next use traps the same way instead of reporting a false cycle.
- `runtime.ts` keeps running under plain type stripping: the code has no parameter properties (observed on Node.js).

### 2.6 C4: acceptance [language]

- **Order.** `acceptDefinitions` loads the built module once (one `load`, not one per step) and then:
  1. evaluates every constant by `runConstants`, in the order of `$constants`: definition order, which the codebase sorts by name;
  2. runs every example, as now.
- **`runConstants(constants): ConstantResult[]`** (runtime) calls each getter. A `Trap`, or a stack overflow (`isStackOverflow`, kind `stack`), becomes `{ definition, trap: TrapInfo, origin: trapOrigin(e) ?? definition, cycle: string[] | null }`; `cycle` is the chain of a `cycle` trap.
- **E0404** (`constantDiagnostics` in `examples.ts`), for each result whose trap has its own definition as `origin`:
  - A result whose trap came from another constant is that constant's E0404, reported there.
  - A `cycle` trap whose members were all reported already is the same cycle seen from another member, and is skipped.
  - Fields: code `E0404`, `definition` the constant, `section` `body`, `at` `const <name>`, no fix.
  - The message reads like E0403's: "Evaluating the constant ends in a trap (`<kind>`). <message without its final period><where>.", where `<where>` is `` (at `<at>`) `` unless the message contains `at`.
  - For example: "Evaluating the constant ends in a trap (`overflow`). Int overflow (at `9007199254740991 + 1`)." and "Evaluating the constant ends in a trap (`cycle`). The constant loop.a depends on itself: loop.a -> loop.b -> loop.a."
- **Examples after a trapping constant (5.6).** The examples still run, so unrelated failures come in the same round. `runExamples` adds `origin` from `trapOrigin` to its trap info. An example whose trap has a constant as its origin is not reported when there are E0404s, since its cause is reported already. With no E0404, every constant was evaluated and cached, so no example can trap inside one.
- Both kinds are thrown together, the E0404s first.

**Why no static cycle check (re-examined).** Principle 5 wants errors before a program runs. Here that moment is acceptance:
- Every path that runs a program accepts it first: `alang check`, `ts`, `build`, `run` and `db run` (1.2). Acceptance evaluates every constant.
- A constant has no inputs and is pure, so its evaluation is the same at acceptance and at run time. Which constants it reads, and so whether it meets itself, does not depend on order or caching.
- So acceptance reports exactly the cycles a run would meet, with no false ones, and an accepted program never traps `cycle`. The trap kind remains only as the mechanism.

The alternatives are worse:
- A static check would need the call graph through every function a constant calls, and would reject a reference on a branch the evaluation never takes.
- A cheap static check of direct constant-to-constant cycles would report the same cause twice (5.6).
- Eager evaluation in dependency order needs the same graph to order the constants.

### 2.7 `refs.ts` and `interface.ts`

- `RefKind` gains `"const"`.
- `rebuild()`, `name` case: for a `const` resolution, respell the constant's part with `spell(e, e.path.slice(0, segments), { kind: "const", full })`, then append `e.path.slice(segments)`. A const definition is rebuilt as `{ kind: "const", path, doc, out: type(def.out), body: stmts(def.body) }`. So `references`, `dependencies`, `mapReferences` (rename) and `shortenOwnNames` (E0226) work for constants.
- `interfaceChange`:
  - const and const: `sections: ["out"]` when `fullType(out)` differs; the body and the doc are not interface (C8);
  - different kinds return `kind: { from, to }` and no sections, instead of throwing. Only fn and const can meet: both are snake_case, and a type's name is PascalCase.

  `InterfaceChange` gains `readonly kind?: { readonly from: string; readonly to: string }`.

### 2.8 C7–C11: the database

- **Kinds.** `Hit.kind`, `Row.kind`, `Stored.kind` and the row casts become `Definition["kind"]`.
- **C11, the schema.** `SCHEMA` gets `CHECK (kind IN ('fn', 'type', 'const'))`. An existing database keeps its old table under `CREATE TABLE IF NOT EXISTS` and refuses a const row with "CHECK constraint failed: kind IN ('fn', 'type')" (observed). `openDatabase` migrates it after `db.exec(SCHEMA)`, with SQLite's procedure for changes that `ALTER TABLE` cannot make:
  1. `PRAGMA foreign_keys = OFF` (it cannot change inside a transaction);
  2. `BEGIN IMMEDIATE`, then read `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'definitions'` again. If it contains `'const'`, another process migrated it: `COMMIT`;
  3. otherwise `CREATE TABLE definitions_new (…)` with the new CHECK, `INSERT INTO definitions_new (hash, kind, text, signature) SELECT hash, kind, text, signature FROM definitions`, `DROP TABLE definitions`, `ALTER TABLE definitions_new RENAME TO definitions`;
  4. `PRAGMA foreign_key_check` must be empty, otherwise `ROLLBACK` and throw; `COMMIT`, then `PRAGMA foreign_keys = ON`.

  Observed on a database with the old schema, a `fn` row, `names`, `refs` and `history`:
  - the check is empty and the rows survive;
  - a const row is accepted, and foreign keys are enforced again;
  - `names` still references `definitions`;
  - the stored `sql` of the renamed table reads `CREATE TABLE "definitions" (…)`, so test it with `includes("'const'")`.
- **C9, hits.**
  - `storedHit` of a const has the `signature` `const ${name}: ${showTree(treeOfRef(def.out, module))}`, the type in full as in `storedHead`: `const shop.limits: shop.Limits`.
  - `signatureTypes` of a const is `[treeOfRef(def.out, module)]`.
  - `search` finds constants by name and doc, like everything else. `searchType` keeps skipping everything but functions.
- **C10, the queries.**
  - `definition` gives the text, and `signature` gives `printSignature` (`doc` and `out`).
  - `context(name)`: `include()` pushes a stored constant with its whole `text`, not its signature, then the types in its `out` one level deep, as for the others. `context` of a constant itself works unchanged.
- **C7, a replace that changes the kind.**
  - `plan()` keeps comparing names only. Fix its comment: names tell types from values, and a value may change between `fn` and `const`.
  - When `interfaceChange` returns `kind`, `callerRule` treats every caller outside the transaction as affected. E0506 reads: "`m.limit` changes from a `fn` to a `const`, which affects `m.f`. Submit them, adapted, in the same transaction (6.4)."
  - With the callers in the transaction, it is written. This is how a codebase moves from the `in: none` idiom to constants, in one `submit`.
- **C8.** A changed body (the value) is no interface change. Acceptance re-runs every example, so a caller whose example states the old value is rejected (E0402) and joins the transaction. See Risks for contracts.
- **`headerName`** (`codebase.ts:382`): `/^(?:fn|type|const) …/`.
- **The rest.** `rename`, `remove`, `history`, export, import and sync need nothing beyond the above: they work on texts, refs and names. `lackingEffects` lists a const caller without following it.

### 2.9 MCP (`src/mcp.ts`)

- **`list` description.** After "… `type std.fs.Kind, variant: File | Directory` for a type, with `, where: ...` unless it is none", add ", and `const shop.zones: Map<String, Int>` for a constant".
- **`context` description.** "followed by the signatures of every function and type it uses" becomes "followed by the signatures of every function and type it uses and the text of every constant it uses".
- **`search_type` description.** Unchanged: "Functions, std included, …" stays exact.
- **Instructions, point 2.** "and the signatures of everything it uses" becomes "and the signatures of everything it uses (a constant's whole text)". That is +27 characters, so `mcp_test.ts:500` stays below 3,000. Nothing else changes.

### 2.10 Effects

A constant has no `effects` section: it is pure (C3). So its getter is synchronous and never awaited, and an effectful function may read it. Reading a constant needs no permission. A function with effects cannot be passed in a const body, not even as `std.http.serve`'s handler (E0233).

### 2.11 Spec changes (exact texts)

Each change goes in the commit of its rule (section 3).

**1.1 (line 91):** "- **1.1 Fixed section order.** A function consists of `doc`, `in`, `out`, `effects`, `requires`, `ensures`, `examples`, `body`, in exactly this order, and a constant of `doc`, `out`, `body`. Every section is mandatory; an empty section is written `none`."

**Section 3 table, a new row after "Bind a value" (line 161):** "| Name a value for a whole module | `const module.name` with `doc`, `out` and `body`, used as `name` |"

**Grammar (after `type_def`, line 212):** the `const_def` production of 2.1.

**4.4:** "- **4.4 Named block ends.** Blocks end with `end if`, `end for`, `end match`, `end fn <name>`, `end type <name>` or `end const <name>`. There are no curly braces and no significant indentation."

**Section 5 table, a new row after `examples` (line 267):** "| `body` of a `const` | Its value | Evaluated at every acceptance |"

**5.1 (line 269):** "- **5.1 Examples are mandatory.** Every function with `effects: none` has at least one example. If one fails, the definition is rejected. A constant has none: every acceptance evaluates it, and a constant whose evaluation traps is rejected."

**Section 6 queries, the `context(name)` row (line 340):** "| `context(name)` | Definition plus the signatures of all functions and types it uses, and the text of the constants it uses |"

**7.1, the first row (line 467):** "| `extern fn` (not parsed yet, E0199) | Nothing yet: std is the only code that reaches TypeScript |"

**7.2, Foreign forms, at its end:** "In a body, `const` is E0006 with `let` as its fix, and a name like `MAX_ITEMS` is E0002 with the fix `max_items`."

**7.3, a new bullet after Types (after line 493), with a block** (it becomes a spec test case):

> - **Constants.** `const shop.sizes` has the sections `doc`, `out` and `body`, then `end const shop.sizes`. The body is statements, as in a function, and ends in a `return` (E0218). A constant is pure (E0233), its type is neither `Unit` nor a function type (E0248), and it has no examples: every acceptance evaluates it, and a run evaluates it once, when it is first used. It is used by its name without parentheses (`limit()` is E0247): `sizes` in its module, `shop.sizes` elsewhere.
>
> The block's fences stand at column 0, not indented under the bullet: `spec_test`'s regex is `` ^``` ``, and an indented block silently drops out of the test set.
>
> ```
> const shop.sizes
>   doc: "The sizes a shirt comes in, smallest first."
>   out: List<String>
>   body:
>     return ["S", "M", "L", "XL"]
> end const shop.sizes
>
> fn shop.is_size
>   doc: "Whether a text names one of the sizes."
>   in:
>     text: String
>   out: Bool
>   effects: none
>   requires: none
>   ensures: none
>   examples:
>     is_size(text: "M") == true
>     is_size(text: "XXL") == false
>   body:
>     return std.list.contains(list: sizes, item: text)
> end fn shop.is_size
> ```

**7.3, The own module, its last sentence:** "One exception: a function passed as a value, or a constant, whose short name is also the name of a local is written in full."

**7.5, Names (line 526):** "- **Names.** A plain name means a local first, then a constant of the own module, then a function of the own module. A path followed by `(` is always a call, so a local may share its name with a function: `let total: Int = total(items: xs)`. A local named like the first segment of a module hides calls into that module: with a parameter `net`, `net.port.parse(...)` reads as a method call (E0220). Choose another name. A dotted name without `(` is read from the left: a local and its fields; a constant of the own module and its fields (`limits.items`); a constant or a function by its full name (`shop.sizes`); or a constant by its full name and then its fields (`shop.limits.items`). A name that two of these readings fit is E0249; rename one of the definitions. A local hides a constant of its module with the same name; there, write the constant in full."

**7.3, Constants, its last sentence (commit 3, with E0401's message):** "A pure function without parameters is a constant written the long way; E0401 says so."

**7.6, Examples, its first sub-bullet (line 532; commit 3):** "  - Every function with `effects: none` has at least one example (E0401); one without parameters is a constant (7.3). A function with effects has `examples: none` (5.4)."

**7.6, Acceptance (line 534):** "- **Acceptance.** Every change evaluates every constant, then re-runs every example of the program, so a changed body or a changed constant that breaks a caller's example is rejected too. A constant whose evaluation traps is rejected with the trap (E0404), and so is one that needs its own value, directly or through the constants and functions it uses (trap `cycle`, reported once per cycle); an example that traps only because of such a constant is not reported. An example whose call breaks the function's `requires` traps (E0403)."

**7.10, the `list(module)` row (line 834):** append "; a constant's like `const shop.sizes: List<String>`".

**7.10, the `context(name)` row (line 837):** "| `context(name)` | The text and hash, and the signatures of everything it uses (std as one line or as alang text; a constant as its whole text, since examples depend on its value). Read this before a change. To call a std function or use a std type, its `signature` in a hit is enough; `context` of a function adds the types it mentions |"

**7.10, Interface changes (line 852):** "- **Interface changes.** Every section of a function except `doc`, `examples` and `body` belongs to its interface; so do a type's shape and `where`, and a constant's `out`. A constant's body, its value, does not: a caller whose example the new value breaks is rejected by that example. Removing an effect is not an interface change. `replace` may turn a function into a constant of the same name or back, which changes the interface. A change to the interface is rejected while callers outside the transaction exist (E0506). Submit them in the same transaction, adapted or unchanged."

**7.11 table:**
- after the rows of statements and fn-types: "| E0247 to E0249 | Constants: called like a function, a type without a value, a name with two meanings |"
- "| E0401 to E0403 | Missing, failing and trapping examples |" becomes "| E0401 to E0404 | Missing, failing and trapping examples, and constants that trap |"

### 2.12 `docs/decisions.md`

- **Lexical, Foreign forms:** add `MAX_ITEMS` (E0002 with the snake_case fix) and `const` in a body (E0006 with the `let` fix).
- **Syntax:** a new row "`const`": C1, the one-line form and the fn sections in a const (E0101), snake_case and E0109 for the name. The `a.b.c` row: "a local with fields, a constant with fields, or a definition by its full name; see Type checking, Names".
- **Type checking:**
  - "Locals vs functions" becomes "Names": C2's resolution, E0249, a local hiding a constant;
  - "Own module names": constants too, the fix on the constant's segments only;
  - "Function values": the E0204 fix for a function without parameters;
  - a new row "Constants": E0247, E0233 in a const body, E0248.
- **Examples and acceptance:**
  - a new row "Constants": C4 (once, lazily, all at acceptance, E0404, one diagnostic per cycle, examples after) and the reasons against a static check;
  - "Missing examples": E0401's message and `expected` for a function without parameters (C6), with E0405 reserved.
- **Semantics and runtime, Representation in TS:** constants as `$rt.constant` getters, and `$constants`.
- **Database:** a new row "Constants": C7 to C11, the migration included.
- **MCP server, Hits:** a constant's signature `const name: Type`; constants are not in `search_type`.
- **Temporary limits:** "`const` and `extern fn` are not parsed yet." becomes "`extern fn` is not parsed yet."
- **Open questions:**
  - "Form of `const` and `extern fn`." becomes "Form of `extern fn`.";
  - new: "Rejecting a pure function without parameters (C6; E0405 reserved)", and "A constant named in a contract" (Risks).

### 2.13 Card (`src/card.ts`)

Measured on a scratch copy (observed): statements' 2.8 texts applied first, then these five edits. The program is unchanged (still `temp`, 4 examples), and the card names no new code.

| Card | Lines | Bytes | Longest line |
| --- | ---: | ---: | ---: |
| Today (`7700807`) | 158 | 9,439 | 118 |
| After statements | 158 | 9,630 | 118 |
| After statements and this phase | 158 | 9,734 | 118 |
| Today plus this phase only | 158 | 9,543 | 118 |

The edits are phrase-level, so that fn-types' edits to "Not in alang" and to the lambda bullet do not collide. Re-measure after fn-types merges; if the card is over budget, shorten K2's second sentence first.

**K1**, the first Definitions bullet, rewrapped:

```
- A definition is a `fn`, a `type` or a `const` with a full name, module first: `temp.fahrenheit`, `net.port.Port`.
  `std` is reserved. `snake_case` for values, functions and modules, `PascalCase` for types and cases.
```

**K2**, the `type` bullet in two lines, then a new `const` bullet:

```
- `type`: `doc`, then `record:` (a `name: Type` per line) or `variant:` (a case per line, `Name` or `Name: Type`,
  at most one value), then `where:` (`none`, or an invariant over a record's fields), then `end type <full name>`.
- `const`: `doc`, `out: Type`, `body:` ending in `return`, then `end const <full name>`. A named value for a table
  or a limit: pure, no examples, used as `limit` (not `limit()`), not a pure `fn` with `in: none`.
```

**K3**, the keywords bullet in one line (it loses `record`, the least likely name):

```
- Keywords (section words too: `in`, `out`, `type`, `body`, `end`) name nothing, nor do `result` and `error` (E0109).
```

**K4**, the `context` bullet. It says what `context` shows of a constant. It drops "To use a std function or type its hit is enough; `context` adds the types it mentions", which the first bullet, the instructions and the `context` description all say:

```
- `context(name)` gives a definition's text (examples, body) and hash, the signatures of what it uses and the text
  of the constants it uses: read code this way, not from `export/`.
```

**K5**, "Not in alang": "No comments (the `doc` describes), `const`, `extern fn`," becomes "No comments (the `doc` describes), `extern fn`,".

## 3. Commits, in order

**Cut order** if the run must stop early: drop commit 3 (the language works without the habit messages). Commits 1, 2 and 4 are the phase.

1. **[language] Constants: syntax, checking, TypeScript, acceptance** (C1–C5, C13; E0247, E0248, E0249, E0404).
   - Source:
     - `ast.ts`, `parser.ts` (`constDef()`, `definitionPath`/`endDef` kinds, the `definitionDef()` message), `printer.ts`;
     - `check.ts` (`Env.consts`, `declare`, `checkConst`, `resolveName`, E0247, E0233 text, E0248, E0218 text, E0203 candidates, E0226 for constants);
     - `emit.ts`, `runtime.ts` (`constant`, `trapOrigin`, `runConstants`, `Constant`, `ConstantResult`, `origin` in `runExamples`);
     - `examples.ts` (`constantDiagnostics`, the origin filter), `toolchain.ts` (one load, constants first);
     - `refs.ts` (2.7), `interface.ts` (2.7);
     - `codebase.ts`: the kind types widened, and the `storedHit` and `signatureTypes` branches of 2.8 that the wider union forces, so that it compiles. Storing constants comes in commit 2; until then the old CHECK refuses them, and no test tries.
     - E0109 for a constant named `result` or `error` (C3) is part of `constDef()`.
   - Spec: 1.1, the section 3 row, the grammar, 4.4, the section 5 row, 5.1, 7.1, 7.3 (bullet, block, exception), 7.5, 7.6, the 7.11 rows.
   - `spec_test.ts:28`: keep `const` blocks too. The inventory gains 1 block and 2 definitions on whatever stands after statements and fn-types (6 and 17 at `7700807`).
   - `decisions.md`: Syntax, Type checking, Examples and acceptance, Semantics and runtime, Temporary limits, Open questions (2.12).
   - Tests 1.1–1.12.
2. **The codebase stores constants** (C7–C11).
   - `codebase.ts`: SCHEMA and the migration, hits, `context`, the kind-change message, `headerName`, the `plan()` comment.
   - `mcp.ts`: the descriptions and the phrase in the instructions (2.9).
   - Spec: the section 6 `context` row; 7.10's `list` and `context` rows and its Interface changes bullet.
   - `decisions.md`: Database, MCP server Hits.
   - Tests 2.1–2.17.
3. **Diagnostics for habits around constants** (C12, C6's message).
   - `lexer.ts` (SCREAMING_SNAKE), `parser.ts` (`const` in a body, the one-line form, the fn sections, a PascalCase name), `check.ts` (the E0204 fix in `name_()`, the E0203 fix in `construct()`), `examples.ts` (E0401's message and `expected`).
   - Spec: 7.2 Foreign forms, the last sentence of 7.3 Constants, and the 7.6 sub-bullet.
   - `decisions.md`: Lexical, Syntax, Type checking (Function values), Missing examples.
   - Tests 3.1–3.6.
4. **The card teaches constants** (K1–K5).
   - Re-measure on the card as it stands (`statements` and `fn-types` merged).
   - `decisions.md`, MCP server, Card: one sentence on what the card says about constants.
5. **Notes and the round.**
   - `notes.md`: a new item in "Current state" (C1–C16 in the review list, the test count, "Next"); mark "Constants are clumsy" resolved; add C6 to "Left for later".
   - Save the round prompt (section 7) as `~/coding_projects/alang-rounds/prompts/parcel.md`.

## 4. Tests

Accepted programs go into `check_test`'s `accepted` list (with `clean()`), which `deno check` runs at the end. Programs that run go into `emit_test`'s `PROGRAMS`, which are TypeScript-checked as a whole.

**Fixtures** (all values below computed by hand):

- **`SHOP`**, in module `shop`:
  - `const shop.max_items: Int`: `return 100`;
  - `const shop.prices: Map<String, Int>`: `let base: Int = 1500`, then `return ["S": base, "M": base, "L": base + 200, "XL": base + 400]`;
  - `type shop.Limits`: record `items: Int`, `sizes: Int`, `where: items <= max_items`;
  - `const shop.limits: Limits`: `return Limits(items: max_items, sizes: std.map.size(map: prices))`;
  - `fn shop.price(size: String, count: Int): Option<Int>`, `requires: count <= max_items`. Examples `price(size: "M", count: 2) == Some(3000)`, `price(size: "XL", count: 1) == Some(1900)`, `price(size: "XXL", count: 1) == None`, `price(size: "S", count: max_items) == Some(150_000)`. Body: `let each: Int = std.map.get(map: prices, key: size) else return None`, then `return Some(each * count)`;
  - `fn shop.fits(count: Int): Bool`. Examples `fits(count: 100) == true`, `fits(count: 101) == false`. Body: `return count <= limits.items`.
- **`WEB`**: `fn web.label(prefix: String): String`.
  - Example: `label(prefix: "max ") == "max 100 of 4 sizes"`.
  - Body: `return std.string.join(parts: [prefix, std.text.show(value: shop.max_items), " of ", std.text.show(value: shop.limits.sizes), " sizes"], separator: "")`.
- **`AMBIG`**:
  - `type x.Pair`: record `c: Int`, `d: Int`;
  - `const x.m: Pair`: `return Pair(c: 1, d: 2)`;
  - `const m.c: Int`: `return 3`;
  - `fn x.f(n: Int): Int`: example `f(n: 0) == 3`, body `return n + m.c`.
- **`LOOP`**: `const loop.a: Int` with `return b + 1`, and `const loop.b: Int` with `return a + 1`.
- **`SELF`**: `const loop.c: Int` with `return plus(n: 1)`, and `fn loop.plus(n: Int): Int` with example `plus(n: 1) == 2` and body `return n + c`.
- **`BIG`**, in this order:
  - `const big.m: Int`: `return n * 2`;
  - `const big.n: Int`: `return 9_007_199_254_740_991 + 1`;
  - `fn big.f(x: Int): Int`: example `f(x: 1) == 2`, body `return x`.
- **`KIND`**:
  - `fn m.limit`: `in: none`, `out: Int`, example `limit() == 100`, `return 100`;
  - `fn m.f(n: Int): Bool`: example `f(n: 1) == true`, body `return n < limit()`.

**Commit 1**
1. **`syntax_test`:** `SHOP` round-trips (`parseProgram` and `printProgram`), including a const body with a `let` and a map literal. `printSignature` of `shop.max_items` is the four lines of 2.1.
2. **`syntax_test`, errors:**
   - `extern fn m.x` is still E0199;
   - `const m` (no module) is E0101 "A definition name has a module: `module.m`.";
   - `end const shop.other` is E0103 with the fix `end const shop.max_items`;
   - `const m.error` is E0109 with the C3 message.
3. **`check_test`, clean:** `SHOP` plus `WEB`.
4. **`check_test`, names:**
   - `fn shop.h(max_items: Int): Int` with the body `return max_items + shop.max_items` is clean, with no E0226: the parameter hides the constant. Its example `h(max_items: 1) == 101` holds at acceptance.
   - Without the parameter, `shop.max_items` inside `shop` is one E0226 with the fix `{ replace: "shop.max_items", with: "max_items" }`.
   - `shop.limits.items` inside `shop` is one E0226, `at` `shop.limits.items`, with the fix `{ replace: "shop.limits", with: "limits" }`. `shortened()` prints `limits.items`.
5. **`check_test`, E0249:** `AMBIG` gives exactly one diagnostic, E0249 at `m.c`, with the message of 2.2.
6. **`check_test`, E0247:**
   - `return limit() + 1`, with `limit` a constant, is one E0247 at `limit()` with its fix, and `applyFix` gives a clean program;
   - `limit(x: 1)` is E0247 without a fix.
7. **`check_test`, constants:**
   - `return std.time.now_milliseconds()` in a const body is one E0233 with the const text;
   - `out: Unit` is one E0248 at `Unit`;
   - a const body ending in `let x: Int = 1` is one E0218 with the const text;
   - `max_item` where `max_items` exists is one E0203 with the fix `max_items`.
8. **`emit_test`:** `SHOP` and `WEB` in `PROGRAMS`. Their 7 examples pass (4 + 2 + 1); TS-checked. `shop$limits() === shop$limits()` is true: evaluated once.
9. **`accept_test`, cycles:**
   - `LOOP` is exactly one diagnostic: E0404, `definition` `loop.a`, `section` `body`, `at` `const loop.a`, message "Evaluating the constant ends in a trap (`cycle`). The constant loop.a depends on itself: loop.a -> loop.b -> loop.a.";
   - `SELF` is exactly one E0404, for `loop.c`, ending "loop.c -> loop.c."; the trapping example of `loop.plus` is not reported.
10. **`accept_test`, other traps:** `BIG` gives `[E0404 big.n, E0402 big.f]`. The first message is "Evaluating the constant ends in a trap (`overflow`). Int overflow (at `9007199254740991 + 1`)."; the second is "The example does not hold: `f(x: 1)` is `1`.". `big.m` gets nothing.
11. **`spec_test`:** the inventory gains 1 block and 2 definitions (7 and 19 if nothing else moved them), and the 7.3 block round-trips. In `check_test`, `clean(specBlock("const shop.sizes"))`; `accept` of it runs 2 examples.
12. **`refs_test`:** `references` of `shop.fits` holds `{ kind: "const", full: "shop.limits" }`. `dependencies` of `web.label` are `["web.label", "std.string.join", "std.text.show", "shop.max_items", "shop.limits"]`.

**Commit 2** (codebase tests on a fresh database holding `SHOP` and `WEB`, `invariants` after each)
1. **`list("shop")`** names and kinds, sorted: `shop.Limits` type, `shop.fits` fn, `shop.limits` const, `shop.max_items` const, `shop.price` fn, `shop.prices` const. The signatures of the constants are `const shop.limits: shop.Limits`, `const shop.max_items: Int` and `const shop.prices: Map<String, Int>`.
2. **`signature(shop.max_items)`** is the four lines of 2.1; `definition` is the full text.
3. **`context(shop.fits)`:** `uses` names `["shop.limits", "shop.Limits"]`, and the first `text` is the full text of `shop.limits`.
4. **`context(web.label)`:** `uses` names `["std.string.join", "std.text.show", "shop.max_items", "shop.limits", "shop.Limits"]`.
5. **`callers(shop.max_items)`** is `["shop.Limits", "shop.limits", "shop.price", "web.label"]`.
6. **Interface.** Replacing `shop.max_items` with `out: Float` and `return 100.0`, alone, is E0506: "`shop.max_items` changes its `out` section, which affects `shop.Limits`, `shop.limits`, `shop.price`, `web.label`. Submit them, adapted, in the same transaction (6.4)."
7. **A new value.** Replacing its body with `return 50` is rejected with three E0402, and no E0506:
   - `shop.fits`: "The example does not hold: `fits(count: 100)` is `false`.";
   - `shop.price`: "… `price(size: \"S\", count: max_items)` is `Some(75_000)`.";
   - `web.label`: "… `label(prefix: \"max \")` is `\"max 50 of 4 sizes\"`.".

   Nothing is written.
8. **Kind change.** On `KIND`, replacing `m.limit` by `const m.limit` (`return 100`) alone is E0506 "`m.limit` changes from a `fn` to a `const`, which affects `m.f`. Submit them, adapted, in the same transaction (6.4)." The same with `m.f` adapted (`return n < limit`) is written. The hit's kind is `const`, and `history(m.limit)` has the operations `["add", "replace"]`.
9. **Remove.** `remove(shop.max_items)` is E0507 "`shop.max_items` is still used by `shop.Limits`, `shop.limits`, `shop.price`, `web.label`. Remove or change them in the same transaction."
10. **Rename.** `rename(shop.limits → shop.order_limits)` writes `shop.fits` (`return count <= order_limits.items`) and `web.label` (`shop.order_limits.sizes`) as followers.
11. **Rename capture.** Add `fn shop.cap(count: Int): Bool` with example `cap(count: 5) == true` and body `return count <= max_items`. Then `rename(shop.max_items → shop.count)` is rejected with exactly one E0510, for `shop.cap`. `shop.price`'s `requires: count <= max_items` is captured too, but its example still names the constant, so the set comparison misses it (Risks); the test pins that as known.
12. **E0226 applied.** Adding `fn shop.g(n: Int): Int` with example `g(n: 1) == 201` and body `return n + shop.max_items + shop.limits.items` is written. `fixed` holds two E0226, and the stored body is `return n + max_items + limits.items`.
13. **Migration.** Create `<dir>/alang.db` with the old SCHEMA text (`kind IN ('fn', 'type')`) and a stored function, its names and its history. Then `Codebase.open(dir)` and add `const shop.max_items`: written. `sqlite_master`'s `sql` for `definitions` contains `'const'`, the function's history is intact, and `PRAGMA foreign_keys` is 1.
14. **`headerName`.** Adding a const whose doc holds `\r` is E0005 with `definition` `shop.bad`.
15. **Export and import.** `export/shop.alang` holds the six `shop` definitions sorted by name, one empty line apart. `importAll` into a fresh database gives the same hashes.
16. **Search.** `search("most items")` is `[shop.max_items]`. `search_type("-> Int")` lists no constant.
17. **MCP.** The `list` description contains "`const shop.zones: Map<String, Int>`", the `context` description "the text of every constant it uses", and the instructions "(a constant's whole text)". The existing length test passes.

**Commit 3**
1. **`syntax_test`:** `parseStatements("const m: Int = 5")` is E0006, `at` `const m: Int = 5`, fix `{ replace: "const", with: "let" }`. The fixed text parses.
2. **Lexer:**
   - `MAX_ITEMS` is E0002 with the fix `max_items`;
   - `HTTP_OK` gets the fix `http_ok`;
   - `Max_Items` keeps the fix `MaxItems`.
3. **Parser:**
   - `const shop.MaxItems` is E0002 with the fix `max_items`;
   - `const shop.max_items: Int = 100` is E0101 with `expected` equal to the six lines of 2.1, with `doc: "..."`;
   - `in: none` after `doc` in a const is E0101 with the C12 message;
   - `examples: none` after `out` is E0101 with the C12 message.
4. **`check_test`, E0204:**
   - `let t: Int = std.time.now_milliseconds` with `effects: time` is one E0204 with the fix `std.time.now_milliseconds()`; `applyFix` gives a clean program;
   - `n < limit`, with `limit` a pure `in: none` function, is one E0204 with the fix `limit()`.
5. **`check_test`, E0203:** `MaxItems + 1` where `max_items` is a constant is one E0203 with the fix `max_items`.
6. **`accept_test`, E0401:** `m.b` (`in: none`, `examples: none`, `return 2`) gets the C12 message, and `expected` is `const m.b\n  doc: "b."\n  out: Int\n  body:\n    return 2\nend const m.b`. The code-only pin at `:112` stays.

**Commit 4:** `card_test` passes: codes and std names exist, at most 160 lines, under 10,240 bytes.

## 5. Decisions

C continues the roadmap's C1 and C2. **[language]** marks grammar, typing or semantics changes.

| # | Recommendation | Reason by principle | Alternative |
| --- | --- | --- | --- |
| C1 [language] | `const <path>` with `doc`, `out`, `body` (statements ending in `return`), `end const <path>`; kept from the roadmap | 1.1: fixed sections, every definition has a doc; 3: the body is the one statement grammar there is, so a table can be built with `let`; no new reserved word | One-expression section under a new keyword (`is:`); the one-line `const a.b: T = v`, which has no doc (now E0101 with the full form as `expected`) |
| C2 [language] | Used without parentheses. A name resolves to a local, then (A) an own constant with fields, (B) a definition by its whole path, (C) a constant prefix with fields; two readings are E0249; a local hides a constant (written in full there, no E0226); a call of a constant is E0247 | 1.1: left to right, like locals today; 2.6: one meaning, so ambiguity is an error, not a pick; 2: a local hiding a constant means adding a constant never breaks a body | Call syntax `limit()`, which a function already is; a constant prefix always winning (silent change of meaning when a module is added) |
| C3 [language] | Pure: a call with effects in a const body is E0233 with its own text; no `effects`, no examples; `result` and `error` name no constant (E0109) | 2.2, 5.4: a value that is the same on every run; a constant evaluated at acceptance must not touch the world | `effects` on constants (evaluated when?); allowing `error` |
| C4 [language] | Evaluated once, lazily, by a getter; acceptance evaluates every constant before the examples; a trap there is E0404 (one per cause, one per cycle); a cycle traps `cycle`; examples that trap in a constant are not reported; **no static cycle check** | 5, 6.3: acceptance is the compile time of the database, and every path that runs a program accepts it first; deterministic, input-free evaluation finds exactly the cycles a run would meet; 5.6 | Eager evaluation in dependency order with a static cycle check (call graph, false positives on untaken branches, the same cause twice) |
| C5 [language] | A constant's type is not `Unit` and not a function type (E0248); function types inside it are fine | 3: `Unit` carries nothing (as T3 for `let`); a function-typed constant is a second way to write a function | Allow both |
| C6 | A pure function without parameters stays legal for now; E0401 for one without examples points to `const` with the const text as `expected`; E0405 is reserved for a later rejection | 3 wants one form, but the cost is about 25 acceptance-test fixtures (1.4) and stored programs (`tasks.usage`), for a form that means the same; the card and the spec now teach `const`, and a round shows whether models still write the idiom | Reject now (E0405), with the fixtures converted |
| C7 | `replace` may turn a `fn` into a `const` of the same name or back; that is an interface change, so callers join the transaction (E0506 with its own text) | 6.4: the migration from the idiom is one `submit`; 5.6: no internal error (`interface.ts:71` throws today) | E0505 "keeps the kind", which makes the migration a rename, an add and a remove across transactions |
| C8 | A constant's interface is its `out`; its body (the value) and doc are not | 6: like a function's body; acceptance re-runs every example, so a caller relying on the value is still checked | The value as interface, which would pull every caller into each value change |
| C9 | Hits: kind `const`, signature `const shop.limits: shop.Limits` (types in full); constants are not in `search_type` | 6.5: a hit tells how to use a definition; `search_type` answers what to call with which arguments | Constants under `-> T` patterns |
| C10 | `context` lists a used constant with its whole text; `signature(const)` is `doc` and `out` | 6.5, 5.1: the examples of a definition that uses a constant depend on its value, which only the body holds | The signature only, and a `definition` call per constant |
| C11 | The kind CHECK is widened by a migration at open (SQLite's table-rebuild procedure, observed) | 6.6: history lives only in the database, so rebuilding from the export would lose it | Rebuild from the export; drop the CHECK |
| C12 | Diagnostics for habits: `const` in a body (E0006, fix `let`), `MAX_ITEMS` (E0002, fix `max_items`), a PascalCase const name (E0002), the one-line form and fn sections (E0101), `MaxItems` naming a constant (E0203 fix), a function without parameters used as a value (E0204, fix `()`), E0401 naming `const` | 5.7, 5.5: each habit gets the alang form as fix or `expected`; 5.6: one diagnostic each | Generic E0101, E0002 with `MAXITEMS` |
| C13 | TypeScript: `export const m$c: () => T = $rt.constant("m.c", (): T => {…})`, uses call the getter; `$constants` after `$examples` | Pure code stays synchronous; no load-order problem (observed); runs on Deno and Node.js (observed) | Top-level `const` in dependency order (TDZ, needs the graph) |
| C14 | Codes: E0247 to E0249 and E0404; E0237 to E0246 left for fn-types; E0405 reserved | The brief's gap; E04xx for what acceptance finds | — |
| C15 | Card: K1–K5, +104 bytes and no lines after statements (observed); the program unchanged | The card is the round's only teaching; budget | A constant in the card's program (about 7 lines; does not fit under 160) |
| C16 | Spec: a `const` example in 7.3 (`shop.sizes` with `shop.is_size`), a spec test case | CLAUDE.md: the spec's examples are the first tests | An example in the Overview, which would change `net.port.parse` and its many pins |

## 6. Risks

- **A constant in a contract.** Changing a constant's value tightens every `requires`, `ensures` or `where` that names it, without a printed interface change (C8). Callers with effects have no examples, so they find out at run time. Recorded, not solved: a later rule could treat the body of a constant that a contract names as interface.
- **Rename capture is compared as sets.** E0510 compares the dependency sets before and after. If the new name is captured by a local in one place but still named elsewhere in the same definition (an example naming the constant), the capture is missed. This weakness exists today; constants make it likelier, since examples name them. Test 2.11 avoids the masking on purpose.
- **The migration** rewrites `definitions` on the first open of an old database, the user's playground included. It is compatible (the CHECK only widens) and keeps every row, but it cannot be undone by an older alang. The export stays the source of truth.
- **Laziness and depth.** A constant first used deep in a recursion is evaluated there. A large table could overflow the stack at run time where acceptance, from a shallow stack, did not. Rare.
- **Cost.** Every acceptance evaluates every constant, as it runs every example.
- **E0249 from a distance.** Adding a module named like an own constant makes that module's names ambiguous. Acceptance reports it, naming both readings, and nothing changes silently.
- **Two forms remain** (C6) until a round shows whether models write the idiom.
- **The card budget.** 9,734 bytes after statements and this phase, before fn-types' edits: 506 bytes left at 10,240.
- **Concurrent phases.** `statements` and `fn-types` both edit `check.ts` (`name_`, `call`), the card, spec 7.1 to 7.11 and `decisions.md`. Build after both merge, and re-grep section 1's references.
- **Fixes quote canonical text.** E0247's and E0226's fixes quote printed text, which matches canonical submissions. The E0006 and E0002 fixes quote the line as written (lexer and parser), so they match too.

## 7. Playground round

**Run** after the phase is merged:

```
scripts/playground-round.sh 2026-11-DD-parcel <head of const> ~/coding_projects/alang-rounds/prompts/parcel.md opus
```

The script builds its own work directory, worktree and MCP config under `~/coding_projects/alang-rounds/`. It runs headless, without the advisor, from an empty codebase, with the card as the only teaching. The shell allows `alang ...`, `cat`, `ls`, `printf`, `echo`, `mkdir` and `cd`, joined with `;`; exit codes show with `; echo $?`. The program needs no network and no files. Check `instructions=sent` in `done.txt`. Afterwards: `git worktree remove --force ~/coding_projects/alang-rounds/2026-11-DD-parcel/wt`.

**Prompt** (save as `parcel.md`; it does not name `const`):

> Build `parcel`, a shipping-price calculator, in alang with the alang MCP tools, in a module you name yourself. Countries are grouped into zones: zone 1 is `de`; zone 2 is `at`, `ch`, `fr` and `nl`; zone 3 is `ca` and `us`. A parcel weighs a whole number of grams from 1 to 20000. Its standard price depends on its zone and its weight bracket (up to 1000 g, up to 5000 g, up to 20000 g):
>
> | Zone | up to 1000 g | up to 5000 g | up to 20000 g |
> | --- | --- | --- | --- |
> | 1 | 4.99 | 6.99 | 14.99 |
> | 2 | 12.99 | 17.99 | 34.99 |
> | 3 | 24.99 | 39.99 | 79.99 |
>
> The services are `standard` (the price above) and `express` (twice that). Prices change, so keep the zones, the price table, the brackets and the services each in one place in the code: changing a price must be one edit. Keep the logic in pure functions with examples, and compute in whole cents. It is started as `alang db run <main> -- <command> ...`:
>
> - `table` prints `grams up to: 1000 5000 20000`, then one line per zone, `zone <n> (<countries>): <prices>`: the zone's countries in alphabetical order, separated by spaces, and its three standard prices, separated by spaces.
> - `quote <country> <grams> <service>` prints `<country> <grams> g <service>: <price> EUR`.
>
> Prices are shown with two decimals. Errors go to stderr with exit code 1, checked in this order: anything but these two command forms prints `usage: parcel table | parcel quote <country> <grams> <standard|express>`; an unknown country prints `unknown country <country>; known: <all countries in alphabetical order, separated by spaces>`; a weight that is not a whole number of at least 1 prints `not a weight: <grams>`; a weight above 20000 prints `too heavy: <grams> g, at most 20000 g`; an unknown service prints `unknown service <service>; choose standard or express`.
>
> Then run `table`, `quote de 800 standard`, `quote fr 1000 express`, `quote us 1001 standard`, `quote ch 20000 express`, `quote ch 20001 standard`, `quote uk 500 standard`, `quote de 0 standard`, `quote de 500 overnight` and `quote de 500`. Then change the zone 1 standard prices to 5.99, 7.99 and 15.99, and run `quote de 800 standard`, `quote de 5000 express` and `table` again. Show me every output and exit code.

**Expected results (hand-computed; exit code 0 unless stated):**
1. `table`:
   ```
   grams up to: 1000 5000 20000
   zone 1 (de): 4.99 6.99 14.99
   zone 2 (at ch fr nl): 12.99 17.99 34.99
   zone 3 (ca us): 24.99 39.99 79.99
   ```
2. `de 800 g standard: 4.99 EUR`
3. `fr 1000 g express: 25.98 EUR` (zone 2, up to 1000 g: 1299 × 2 = 2598)
4. `us 1001 g standard: 39.99 EUR` (zone 3, up to 5000 g)
5. `ch 20000 g express: 69.98 EUR` (zone 2, up to 20000 g: 3499 × 2 = 6998)
6. stderr `too heavy: 20001 g, at most 20000 g`, exit 1
7. stderr `unknown country uk; known: at ca ch de fr nl us`, exit 1
8. stderr `not a weight: 0`, exit 1
9. stderr `unknown service overnight; choose standard or express`, exit 1
10. stderr `usage: parcel table | parcel quote <country> <grams> <standard|express>`, exit 1
11. After the change: `de 800 g standard: 5.99 EUR`
12. `de 5000 g express: 15.98 EUR` (799 × 2 = 1598)
13. `table` as in 1, with `zone 1 (de): 5.99 7.99 15.99`

**Where constants should appear, if the card teaches them:**

| Value | Expected form | Old idiom it replaces | Natural uses |
| --- | --- | --- | --- |
| Zones | A `Map<String, Int>` constant (or zone to countries) | Inline literal in one function (std-net round), or a `fn` with `in: none` and an example repeating the map | The country check, the `known:` list (`std.map.keys`), `table` |
| Prices | A `Map<Int, List<Int>>`, `List<List<Int>>` or record constant, in cents | `in: none` function | `quote`, `table`; the price change edits it alone |
| Brackets | `List<Int>`: `[1000, 5000, 20_000]` | Literals repeated | The bracket choice, `table`'s first line, the weight limit |
| Weight limit | `Int` 20_000, perhaps computed from the brackets' last item | `20000` written in two or three places | The weight check, the `too heavy` message, perhaps a `requires` or a `where` |
| Services | `List<String>` | Literals repeated | The service check, its message, the usage line |
| Usage | `String` | A `let usage` repeated per function, or `fn usage()` (tasks round) | Every usage error |

**Checks for the analysis.** A fresh Opus agent, read-only, works like the tasks round's step 1. It lists every tool call, builds an independent Python reference, reruns only in a scratch copy, and ranks findings "fix now" or "later" with the files to touch.
1. **Teaching by the card:**
   - was `card` called first;
   - every constant: name, type, its callers (`callers`), computed or literal, a record read through a field, use in an example, a `requires` or a `where`;
   - every old idiom: pure functions with `in: none`, map or list literals inside function bodies, `20000` or the usage text written more than once.
2. **Diagnostics per submit**, with codes, and whether each `fix` or `expected` led to the right form: E0247 (`x()` on a constant), E0248, E0249, E0404, E0233 in a const body, E0006 (`const` in a body), E0002 (`MAX_ITEMS`, a PascalCase const name), E0101 (the one-line form, fn sections in a const), E0226 and `fixed`, the E0204 fix `()`, E0401 with the const hint, E0506 (a constant's type, or a `fn` turned `const`).
3. **The price change:**
   - how many submits it took, and whether the first `replace` was rejected by E0402 on examples that stated a zone-1 price;
   - whether those examples were adapted in the same transaction;
   - whether it was one edit to one constant, plus examples;
   - whether `context` was read first and showed the constant's text (check the tool result in the transcript).
4. **Correctness against the reference**, on Deno and in a scratch copy:
   - brackets: `quote de 1000 standard` 4.99, `quote de 1001 standard` 6.99, `quote de 5000 standard` 6.99, `quote de 5001 standard` 14.99, `quote de 20000 standard` 14.99 (before the change);
   - weights: `-5`, `5.5`, `abc`, the empty text, and `9999999999999999999` are each `not a weight: <text>`;
   - order of checks: `quote uk 0 overnight` is the country error, `quote de 0 overnight` the weight error, `quote de 99999 overnight` `too heavy`;
   - names: `quote DE 500 standard` is `unknown country DE; …`, `quote de 500 Standard` is `unknown service Standard; …`;
   - usage: `table x`, `quote de 500 standard extra`, `Table` and no command;
   - nothing on stderr for a success, nothing on stdout for an error, and no trap (exit 70).

   Lenient on `020000`: `std.int.parse` reads it as 20000, and the prompt leaves open whether `<grams>` echoes the text or the number.
5. **Effort:** tool calls by kind, time, output tokens, std `context` calls, and whether the first submit was accepted.
6. **Generated TypeScript:** `out/` holds one `$rt.constant(` per constant and a `$constants` list, and a `table` run evaluates each constant once.

### Critical Files for Implementation
- /home/josua/coding_projects/alang/src/check.ts (resolveName, checkConst, E0247–E0249, E0233 text, E0204 fix)
- /home/josua/coding_projects/alang/src/parser.ts, /home/josua/coding_projects/alang/src/ast.ts, /home/josua/coding_projects/alang/src/printer.ts, /home/josua/coding_projects/alang/src/lexer.ts
- /home/josua/coding_projects/alang/src/emit.ts, /home/josua/coding_projects/alang/src/runtime.ts, /home/josua/coding_projects/alang/src/examples.ts, /home/josua/coding_projects/alang/src/toolchain.ts
- /home/josua/coding_projects/alang/src/refs.ts, /home/josua/coding_projects/alang/src/interface.ts
- /home/josua/coding_projects/alang/src/codebase.ts (schema and migration, hits, context, kind change), /home/josua/coding_projects/alang/src/mcp.ts
- /home/josua/coding_projects/alang/src/card.ts, /home/josua/coding_projects/alang/alang-specs.md, /home/josua/coding_projects/alang/docs/decisions.md
- /home/josua/coding_projects/alang/tests/check_test.ts, /home/josua/coding_projects/alang/tests/accept_test.ts, /home/josua/coding_projects/alang/tests/emit_test.ts, /home/josua/coding_projects/alang/tests/codebase_test.ts, /home/josua/coding_projects/alang/tests/spec_test.ts, /home/josua/coding_projects/alang/tests/syntax_test.ts
