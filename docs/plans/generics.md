# Plan: phase 7, `generics`

The planner wrote this on 2026-11-14 from branch `std-net` at `9ba84a8` (`main` plus phase `std-net`). Its `src/` is
that of `77473ef`, but for three lines of `src/runtime.ts`. While planning, an uncommitted `statements` build was in
progress in the same worktree. So every file:line below is at `9ba84a8`, read from a snapshot
(`/home/josua/.claude/jobs/7e0015cb/tmp/generics-probes/snapshot/`, made with `git archive 9ba84a8`). The only file
written was this plan; probes ran in `/home/josua/.claude/jobs/7e0015cb/tmp/generics-probes/`.

- **Observed:** facts from `alang check` on probe files, `deno check` and `deno run` of hand-written TypeScript in the
  emitter's shape (`ts/probe.ts`; Deno 2.8.0, TypeScript 6.0.3), and scripts that measure the card (`card/`) and
  compute the round's expected output (`round/reference.ts`).
- **To verify:** facts that were not observed, mostly because they need the code of `statements`, `fn-types` or
  `const`, or of this phase.

The main session takes every recommendation, and nobody is asked. **[language]** marks a decision that changes the
language; those are listed for the user's later review.

**Branch:** `generics`, from `main` after `statements` (row 4), `fn-types` (row 5) and `const` (row 6) are merged.
This plan builds on their plans: `docs/plans/statements.md`, `docs/plans/fn-types.md`, `docs/plans/const.md`.
- Those phases rewrite `Parser.stmt()`, `TypeRef` (a union with a `function` kind), `name_()`, `call()`,
  `Definition` (adds `ConstDef`) and `rebuild()`.
- So re-grep every reference below by the function name given.
- After every commit, run `deno task test`, `deno lint` and `deno fmt --check`. Commit with explicit paths, never
  `git add -A`.

## 0. Scope

| Item | Where | Why |
| --- | --- | --- |
| Generic functions: `fn util.last<T>`, type parameters inside the body, calls (G1, G3–G6, G12) | **This phase**, commits 1 and 2 | Roadmap row 7; std already has type variables and a call algorithm for them |
| No `==`, order or `show` on a type parameter, except against a value built from literals and cases (G2) | **This phase**, commit 1 | Roadmap G2, made usable for `p == None` |
| A case names its type arguments where nothing gives its type: `None<Int>`, `Leaf<Int>` (G7) | **This phase**, commit 3 | Without it, no example can pass a bare `None` or `Leaf` to a generic function (1.1, the trace) |
| A generic function passed by name, `with: std.list.length` (G9; fn-types' F10) | **This phase**, commit 4, cuttable | F10 deferred it here |
| Generic types: `type tree.Tree<T>` (G8) | **This phase**, commit 5; **the split point** | Roadmap row 7 |
| Diagnostics for habits around generic headers (5.7) | **This phase**, commit 6, cuttable | Bounds, `end fn f<T>` |
| Generic constants | **Not planned** (G11) | A constant has one value of one type |
| Bounds (traits), variance, type parameters that take arguments, phantom type parameters | **Not planned** | 2.6 rules out traits; there is no subtyping; E0250 rules out phantoms |
| A `fn` that returns a function, `compose` | **Not planned**: fn-types' F4 stays (G10) | Its reason does not depend on generics |
| A one-letter `search_type` pattern as a variable; naming type parameters in the `search_type` description | **Later** | No round has used `search_type` in five rounds (notes, "From the std-net round") |

**Split.** This is one phase with a split point before commit 5. Commits 1–4 give generic functions, case type
arguments and generic function values. Commit 5 adds generic types on the same machinery: shapes with parameters,
substitution, constructions.

The machinery is shared: the rigid type kind, `info.instances`, the hiding rule, E0250 and the TypeScript generics are
built once, in commit 1. fn-types and const each fit four code commits in one run, and this phase has five.

If the run cannot finish commit 5, the main session merges commits 1–4 as `generics`. It then takes 2.10, the commit 5
entries of 2.14–2.16 and the commit 5 tests as phase `generic-types`, briefed from this plan. Until commit 5, the card
and the spec claim no generic types (7.1 lists them as not available yet). The round (section 7) works with or without
commit 5.

## 1. Findings

### 1.1 How the language handles generics today

**Syntax (observed).**
- `fn util.last<T>` is E0101 "Expected a line break, found `<`." at `fn util.last<T>`, and so is `type tree.Box<T>`.
  - `definitionPath()` (`src/parser.ts:188-194`) reads the path, then `expectNewline()` fails.
- `T` in a signature without a header is E0202 "Unknown type `T`.", without a fix (`resolveType`, `src/check.ts:351-390`).
- `return Dot<Int>` is E0102 "Comparisons do not chain; combine them with `and`."
  - `pathExpr()` (`parser.ts:587-604`) builds a construction as soon as it reads a typename, so `<` reads as a
    comparison.

**The machinery std already has.**
- `Type` has `var` (`src/types.ts:14`), with `substitute`, `freeVars` and `unify` (`types.ts:146-197`).
- `FnSig.typeParams` (`check.ts:94-101`) and std's `Signature.typeParams` (`src/std.ts:105-115`).
- **`call()`** (`check.ts:802-886`):
  - explicit type arguments are written exactly when a type parameter occurs in no parameter type (E0209, `:839-859`);
  - arguments are checked left to right (`:862-877`). A parameter type without free variables is the argument's
    expected type; otherwise the argument is checked with none and unified.
  - `guessTypeArgs` (`:951-959`) gives E0209's fix from the expected type;
  - `withoutFunctions` (`:888-894`) gives E0222;
  - `badMapKey` (`:896-907`) checks map keys after binding.
- **`name_()`** (`:667-717`) rejects a generic function as a value: E0210 "The generic function `x` cannot be passed as a
  value; wrap it in a lambda." (`:682-688`).
- **`builtinConstruct()`** (`:1064-1108`): `Ok`, `Err` and `None` take their type from the expected type. Without one
  they are E0210, "...Bind it with `let name: Option<...> = None` first, or put the side with a known type first."
  (`:1093-1096`). `Some(x)` takes its type from `x`.
- **`binary()`** (`:1220-1286`): `==`/`!=` is E0222 when the left type holds a function (`:1228-1235`); order is E0211
  (`:1237-1252`).
- **`std.ts:777-782` `signatureHead`** already prints `fn std.list.last<T>(list: List<T>): Option<T>, effects: none`.
  That is the line every `list` hit shows a model. Its comment (`std.ts:768-770`) says the header is not alang syntax
  yet.

**User types know no parameters.**
- `TypeShape` (`check.ts:102-104`) has no type parameters.
- `resolveType` reports E0209 "`X` takes no type arguments." for a user type with arguments (`:385-389`).
- `field()` (`:723-741`), `construct()` (`:961-1034`), `casePayload()` (`:1037-1062`) and `casesOf()` (`:1405-1426`)
  read shapes as they are.
- Pass 1 of `checkProgram` (`:145-177`) registers type names only.

**Why the body's type parameters cannot be `var`.** This was hand-traced on `call()`.
- Take `fn m.f<T>(xs: List<T>): Int` with the body `return std.list.first(list: xs)`. With `T` as `var`:
  - `first`'s `T` binds to the user's `var T`;
  - `out` is `Option<var T>`, and `freeVars(out).size !== 0` returns `ERROR` (`check.ts:896`);
  - `ERROR` fits everything, so the wrong `return` is accepted silently, and the generated TypeScript fails `deno check`.
- Worse, `unify` would bind the user's `T` wherever it reaches a callee's parameter type, since std reuses the names
  `T` and `U`.
- So a type parameter inside its own definition must be a kind of its own, which `unify` treats as a constant (2.2).

**`typeEquals` has `default: return true`** (`types.ts:111`). A new kind would fit any other value of its kind unless
it gets a case. Readers of `Type` with a `default` are not flagged by TypeScript. The full list is in 2.2.

**Emitter.**
- `tsType` (`src/emit.ts:159-190`) throws on `var` (`default`), and writes a user `con` without its arguments (`:186`).
- `ts()` (`:192-218`) appends arguments.
- `type()` (`:226-262`) and `fn()` (`:264-298`) write no type parameters.
- A case construction is `({ tag } satisfies <T> as <T>)`, with `<T>` from the type's name only (`:491-512`).
- A call passes only written type arguments (`:483-490`).

**Database.**
- `src/refs.ts:91-95` reads every non-builtin one-segment type path as `<module>.<Name>`. So a `T` would become a
  reference to `m.T`: a dependency on a name that may not exist.
- `src/interface.ts:32-37` (`fullType`) and `src/search.ts:37-42` (`treeOfRef`) read type paths the same way.
- In `src/codebase.ts`:
  - `storedHead` (`:270-275`) writes no `<T>`;
  - `typeHead`'s comment says "Types have no type parameters" (`:280`);
  - `headerName` (`:380-383`) requires the line to end after the path, so it misses `fn util.last<T>`;
  - `signatureTypes` (`:260-265`).
- E0510 (`:1189-1224`) says "A local binding probably has the new name".

**Examples.** `valueExpr` (`src/examples.ts:119-201`) reads a shape's field and payload types as they are. A generic
type's actual values would fall back to `std.text.show`.

**TypeScript (observed, `ts/probe.ts`).** Hand-written output in the planned shape passes `deno check` and runs. It
has:
- generic variant and record types, with a record constructor `pair$Pair<A, B>` checking a `where`;
- a recursive `tree$insert<T>` and `tree$to_list<T>`, with cases written `({ tag: "Leaf" } satisfies tree$Tree<T> as
  tree$Tree<T>)`;
- `$rt.std$list$empty<T>()` and list literals annotated with `T`;
- a lambda over `T`;
- a module type `m$T` beside a type parameter `T`;
- calls with explicit TypeScript type arguments (`util$last<number>(...)`, `tree$insert<number>(...)`);
- `$rt.std$list$map(xss, util$last)` without them (TypeScript infers the higher-order call);
- `$rt.std$list$length<number>` as a value;
- `$examples` with generic calls.

`$rt.std$text$show` is not generic in TypeScript (`value: unknown`), so the emitter must never add type arguments to a
std function value (observed: `std$text$show<number>` would not type-check).

### 1.2 Tests that pin current behavior (at `9ba84a8`)

- **No test pins a generic header being rejected** (grepped `<T>`, `generic` and `Unknown type` in `tests/`).
  - The only `<T>` texts are std hit lines, `queries_test.ts:281`, which stay.
  - `assert.ts` has a TypeScript generic.
- **`src/card.ts:104`** lists "generic definitions" under "Not in alang". After fn-types, that line reads
  "..., tuples, generic definitions, concurrency." `card_test.ts:146-150` caps the card at 160 lines and under 10,240
  bytes.
- **`check_test.ts:244-249`:** `let s: List<Int> = std.list.map(list: xs, with: std.text.show)` is E0210. It flips to
  E0204 in commit 4 (G9): `std.text.show` is instantiated at `Int`, so the call is a `List<String>`.
- **fn-types' planned test 1.4** (`let f: (List<Int>) -> Int = std.list.length` is E0210) becomes clean in commit 4.
- **E0210 code pins stay** (codes only; no test pins E0210's text, grepped): `check_test.ts:231` (`None == ...`),
  `:556` (`[None, Some(1)]` in a std call) and `:713` (the map literal).
- **E0222 pins stay** (G2b does not apply, since a name stands on both sides): `check_test.ts:184` (`g == g`), `:597`
  (`[g] == [g]`), `:601`, `:609`.
- **`spec_test.ts:36-37`:** the inventory of definition blocks gains 1 block and 1 definition in commit 1, and 1 block
  and 3 definitions in commit 5. Count on whatever `statements`, `fn-types` and `const` leave: their plans give 8 blocks
  and 20 definitions.
- **Non-generic output is unchanged.** Every new text (`<T>` in headers, `<...>` on constructions, TypeScript type
  arguments) appears only for generic definitions. So no printed text, no hash and no `emit_test` output of today's
  programs changes. To verify, by the suite after commit 1.

### 1.3 Evidence from the rounds

No round program wanted a generic definition.
- **Observed** with `grep` over the exports of `2026-11-14-std-net`, `std-net-2`, `tasks-auto` and the playground's
  `tasks.alang`.
- Each module has one to three record types.
- No helper is duplicated per type. Each program parses one kind of line and prints one kind of row.

The closest evidence is std:
- the one cross-program helper, the first malformed line, which both `tasks` rounds built with an identity
  `filter_map`, became `std.list.find_index` (statements' T15; notes, "From the tasks round");
- the rounds use std's generic functions fluently (`std.list.empty<std.http.Header>()`, `filter_map`, `find`);
- the spec's blind test (notes, "From the spec reference") wrote "list and text helpers".

So the evidence is thin, as `statements` 1.3 found for shared arms. The round of section 7 must create the need, as
fn-types' round did: two files of different record types that are parsed and printed the same way.

The notes also record the gap itself: "The grammar has no way to declare a generic function or a generic type. Only
builtins are generic." (Spec observations).

### 1.4 What each part of the toolchain must learn

| Part | Commit 1 (functions) | Commit 3 (case type arguments) | Commit 5 (types) |
| --- | --- | --- | --- |
| AST | `FnDef.typeParams: readonly string[]` | `construct.typeArgs: readonly TypeRef[]` | `TypeDef.typeParams` |
| Parser | header `<T, U>` after the path; E0101s | `Leaf<Int>` after a typename path | header on `type` |
| Printer | `fn util.last<T>`; end line without | `Leaf<Int>(...)` | `type tree.Tree<T>` |
| types.ts | kind `rigid`; `typeEquals`, `showType`; `generalize` | — | — |
| Checker | `resolveType` with letters; rigid map; E0215, E0250, E0202, E0203; G2; `writable`; `instances` | `builtinConstruct` and E0209/E0210 | shapes with parameters; `field`, `casesOf`, `construct`; arity E0209 |
| Emitter | `function f<T>`; `ts`/`tsType` for letters; type arguments at user generic calls | builtins unchanged | `type X<T>`, constructor `X<A, B>`, constructions with type arguments |
| refs.ts | letters are no references; `typeParams` carried | construction type arguments rebuilt | `typeParams` of types |
| interface.ts | letters by position | — | shapes by position |
| search.ts | `treeOfRef(t, module, letters)` gives `var` | — | — |
| codebase.ts | `storedHead`, `signatureTypes`, `headerName`, `searchType` | — | `typeHead` |
| examples.ts | — | — | `valueExpr` substitutes |

### 1.5 What `statements`, `fn-types` and `const` change for this phase

- **`statements`.**
  - `Stmt` gains `propagate` and `destructure`, whose `type` is a `TypeRef` that may name a letter.
  - `Arm.pattern` becomes `Arm.patterns`.
  - `Scope` gains `used` and `hidden`.
  - The codes E0235 and E0236.
  - Card: the Bodies and `match` bullets.
  - `std.list.set` and `find_index` (T13, T15) are generic std functions, so nothing new.
- **`fn-types`.**
  - `TypeRef` is `{ kind: "type"; path; args } | { kind: "function"; params; out }`. A letter is a `type` reference
    with one segment, so `(T, T) -> Bool` works inside a generic header with no extra case.
  - `apply` (`by(a, b)`) gives function-typed parameters of type parameters (`test(item)`).
  - E0237 (F4) and E0238.
  - `writable`/`toTypeRef` learn function types (F8). This phase adds letters there.
  - `search.ts`'s `TypeTree` gets a `fn` kind (F9).
  - F10 leaves generic function values to this phase (G9).
- **`const`.**
  - `Definition` adds `ConstDef` (no type parameters), with `resolveName` for names.
  - C6's E0401 text tells a pure function without parameters to become a constant. It must not say so for a generic
    one, since a constant cannot be generic (G11): skip the hint when `typeParams` is not empty.
  - Codes E0247–E0249 and E0404; E0405 is reserved.
- **Codes.** Statements took E0235–E0236; fn-types E0237–E0238 (const left it E0237–E0246); const E0247–E0249.
  **This phase takes only E0250**, and every other diagnostic reuses a code by its concern (2.14, 7.11). E0251 upward
  stay free.

## 2. Design

### 2.1 G1, G3: the header [language]

**Form.** Type parameters follow the definition's name in `<...>`, as type arguments follow a call's name
(`std.list.empty<Int>()`). The end line names the definition without them:

```
fn util.contains_by<T>
  ...
end fn util.contains_by
```

- **G3. A type parameter is one capital letter**, `A` to `Z`, each at most once (E0215).
  - It is the form std's signatures and every hit already show (`T`, `U`, `V`, `A`, `K`).
  - One letter cannot collide with a builtin name, which is never one letter, or with TypeScript's global generic
    names (`ReadonlyArray`, `Promise`), so the emitter writes it as it is.
  - One form concentrates the model's choices (3).
- **Grammar** (section 3; type definitions in commit 5):

```
fn_def      = "fn" path [ type_params ]
              ...
type_params = "<" Letter { "," Letter } ">" ;
```

- **AST:** `FnDef.typeParams: readonly string[]`, `[]` for a definition without them. It is required, not optional, so
  that TypeScript finds both producers: `fnDef()` and `refs.ts` `rebuild()`.
- **Parser.**
  - In `fnDef()`, after `definitionPath("fn")`: `const typeParams = this.isSymbol("<") ? this.typeParams() : [];`.
  - `typeParams()` reads `<`, then a `typename` token, then `,` and further ones, then `>`.
  - Messages (E0101, `at` the line):
    - `<>`: "A definition's type parameters are capital letters in `<...>`: `fn util.last<T>`; without any, write the
      name alone.";
    - a token that is not a one-letter typename (`<Item>`, `<t>`, `<1>`): "A type parameter is one capital letter, such
      as `T` or `K` (3); `Item` is not one.";
    - `<T,>`: "A list of type parameters ends after its last letter; remove the comma before `>`."
  - A missing `>` keeps the generic "Expected `>`, found …".
  - `endDef()` is unchanged: the end line has no `<`. A `<` there is E0101 "Expected a line break, found `<`." until
    commit 6 gives it E0103 with a fix.
- **Printer:** `printFn` writes `` `fn ${name}${typeParams.length ? `<${typeParams.join(", ")}>` : ""}` `` and
  `` `end fn ${name}` ``. `printSignature` is the same header. With `[]`, the text is unchanged, so no hash changes.

### 2.2 G6: a type parameter inside its definition [language]

**Meaning.** Inside the definition that declares it, `T` is one fixed but unknown type.
- It equals only itself: `A` does not fit `B`, and `T` does not fit `Int`.
- It has no fields, cases or arithmetic.
- It may stand anywhere a type stands: parameters, `out`, `let`, `for`, a `let [...]`, lambda parameters and results,
  function types, and type arguments (`std.list.empty<T>()`, `Option<T>`).
- There is no variance: alang has no subtyping, so `Tree<A>` fits `Tree<B>` exactly when `A` and `B` are the same type.

**types.ts.** A new kind and two helpers:

```ts
// A type parameter of the definition being checked, inside that definition
// (G6): fixed but unknown, equal only to itself. Callers see the same
// parameter as a `var`, which a call binds.
| { readonly k: "rigid"; readonly name: string }

export const rigid = (name: string): Type => ({ k: "rigid", name });
// The signature as callers see it: each rigid parameter becomes a variable.
export function generalize(t: Type): Type { /* rigid -> var by name, through con args and fn params/out */ }
```

**Every reader of `Type`, by hand**, since those with a `default` are not flagged:

| Function | File | Change |
| --- | --- | --- |
| `typeEquals` | types.ts:96 | `case "rigid": return a.name === (b as typeof a).name;` (the `default` would say true) |
| `showType` | types.ts:124 | `case "rigid": return t.name;` (TypeScript flags it) |
| `unify` | types.ts:179 | none: `default` calls `typeEquals`, so a rigid parameter in a pattern is a constant |
| `substitute`, `freeVars`, `containsError`, `containsFn` | types.ts | none: a rigid type is a leaf that is no variable, error or function |
| `writable`, `toTypeRef` | check.ts:1630, 1635 | a rigid type is writable and is written as its letter (`{ kind: "type", path: [name], args: [] }`) |
| `keyOk`, `badMapKey` | check.ts:1603 | none: a rigid key is not `Int`/`String`, so E0229 (2.5) |
| `casesOf`, `field` | check.ts:1405, 723 | none: `T` has no cases (E0214) and no fields (E0212) |
| `tsType` | emit.ts:159 | `case "rigid": return t.name;` (the `default` throws) |
| `treeOfType` | search.ts:44 | `case "rigid": return { k: "var", name: t.name };` (never reached today; for safety) |
| `valueExpr` | examples.ts:125 | none: actual values never have a rigid type (G12) |

**Checker.** `DefChecker` keeps `typeParams = def.kind === "fn" ? def.typeParams : []` (types in commit 5), and
`rigidOf: Subst`, which maps each letter to `rigid(letter)`.
- **`resolveType`** checks, before `BUILTIN_TYPES` and `resolvePath`: a one-segment path that is one of the letters is
  `rigid(letter)`. With type arguments it is E0209 "`T` is a type parameter and takes no type arguments." In the
  `examples` section it is E0202 (G12).
- **`declare()`** resolves parameters and `out` as today. Then `env.fns.set(name, { name, typeParams: def.typeParams,
  params: params.map((p) => ({ name: p.name, type: generalize(p.type) })), out: generalize(out), effects })`. A caller,
  the function itself included, sees `var`s and binds them per call, as for std.
- **`checkFn()`** gives the parameter scope `substitute(p.type, this.rigidOf)`, sets `this.out =
  substitute(sig.out, this.rigidOf)`, and binds `result` in `ensures` the same way.
- **A recursive call** binds the callee's `var T` to the caller's `rigid T`, as any call would. A call at another type
  (`repeat(item: [item], ...)`) works too: every call instantiates afresh.
- **`call()`** records `info.instances.set(e, sig.typeParams.map((tp) => subst.get(tp)!))` for every call of a generic
  function, std or user, once its type is known.
  - The new `CheckInfo` field: `readonly instances: WeakMap<Expr, readonly Type[]>`. The type arguments are in the
    order of the signature's type parameters, for generic calls and, from commit 4, generic function values.
- **`guessTypeArgs`** works for user signatures unchanged: it unifies `out` with the expected type, so E0209 on
  `none_list()` with `let xs: List<Int>` gives the fix `none_list<Int>()`. Inside a generic body,
  `let xs: List<T> = []` gives E0228 with the fix `std.list.empty<T>()`, since a letter is writable.

**Effects and contracts.** Nothing new.
- A generic function declares its effects like any other, and with effects it is `async` in the TypeScript.
- A function-typed parameter over `T` is pure (fn-types F3).
- `requires`, `ensures` and `where` see `T` like the body does, so `requires: std.list.length(list: list) > 0` works;
  G2 limits what they can say about a `T` value.

### 2.3 G4: a type parameter hides its letter in its definition [language]

A type, record or case of the module whose name is one of the letters is written in full throughout that definition
(`m.T`, `m.T(n: 1)`, `case m.T then`).
- That spelling is not E0226: the short form would mean the type parameter.
- The short form in a construction or a pattern is **E0203**, at the construction or pattern, with the full form as
  fix: "`T` is a type parameter of `keep` here; the record `m.T` of this module is written in full in it: `m.T(n:
  1)`." For a case, "the case `m.T`".
- In a type, the short form is the type parameter.

**Implementation.**
- `shortForm()` (`check.ts:278-289`) returns early when the path has the own module and its last segment is a letter,
  so the full name is the only spelling and is not recorded in `longForms`. This is how the codebase stores it too.
- `construct()` and `pattern()` report the E0203 for a one-segment path that is a letter, before resolving it.
- **Without a module definition of that letter**, `T(n: 1)` or `case T then` is E0203 without a fix: "`T` is a type
  parameter of `keep`, not a record or case; a value of it comes from a parameter."

**Why hiding, not E0215.** A type parameter is local to its definition, like a local binding, and a local hides a
module function of its name (decisions.md, "Locals vs functions"). const's C2 decided the same for constants.
- With E0215, adding a one-letter type to a module would break every generic definition of that module using that
  letter, which is the action at a distance principle 2 rules out.
- One-letter type names occur in the test suite (`m.P`, `m.R`, `m.V`), so the clash is not imaginary.

### 2.4 G5: every type parameter is used; each once

- **E0215** for a letter written twice: "Type parameter `T` is declared twice.", `at` the header line.
- **E0250** for a letter that occurs in no parameter type and not in `out`, `at` the header line (`fn m.f<T, U>`).
  - It is reported in `declare()`, and it counts the letters *written* in the parameter and `out` type references
    (`TypeRef`s, function types included), not the resolved types.
  - A type that fails elsewhere becomes the error type, and its letters would vanish. So `fn m.keys_of<K, V>(map:
    Map<K, V>): List<K>` gives E0229 alone, never E0250 for `V` with a fix that deletes it (5.6).
  - Message: "`U` occurs in no parameter type and not in `out`, so no call could give it a meaning; remove it from
    `<...>`."
  - `fix`: `{ replace: "fn m.f<T, U>", with: "fn m.f<T>" }`, which is the header without it, and the bare name if none
    remains. The header occurs once in the text, since the end line has no `<`.
- A letter that occurs only in `out` is fine: calls write it explicitly (`none_list<Int>()`), as for `std.list.empty`.
- For types (commit 5): "`T` occurs in no field." or "…in no case."

### 2.5 G2, G2b: equality, order and text on a type parameter [language]

**G2 (kept from the roadmap).** A value whose type holds a type parameter (`T`, `List<T>`, `Option<T>`) has no `==`,
`!=`, `std.text.show` or `std.list.contains`, and no order.
- A type parameter may stand for a type with function values, which 3.9 gives no equality or text.
- The function takes what it needs as a parameter (`same: (T, T) -> Bool`, `by: (T, T) -> Order`, `show: (T) ->
  String`), as 3.9 already does for the order of every type but `Int`, `Float` and `String`.
- The alternative, allowing them and checking every call site for function values, makes a function's interface
  depend on its body, against principle 2. It also equals declaring a bound, which is a trait (2.6).

**G2b (new).** `==` and `!=` work on any type, a type parameter or a function type included, when one side is *built
only from literals and cases*:
- a literal;
- a construction whose value or fields are such;
- a list or map literal of such;
- `std.list.empty<...>()` or `std.map.empty<...>()`.

For example `option == None`, `tree == Leaf`, `result == Err(std.fs.NotFound)`, `items == std.list.empty<T>()`.
- Such a side holds no value of a type parameter and no function, which come only from names, calls and lambdas.
- Structural equality never compares a part that one side lacks, so no such value is ever compared. It compares the
  case, the length or the literal parts (`$rt.eq`, `runtime.ts:208-228`: key count and tag come first).
- Why: the idioms the card and the rounds use (`args == std.list.empty<String>()`, `probe == Err(std.fs.NotFound)`)
  stay valid in generic code. Without G2b, `fn(p: Option<T>): Bool => p == None` would need a helper function with a
  `match`, since a lambda holds no `match`.
- It loosens E0222 for function types too (`handler == None`). Loosening breaks no program (3.8).

**Implementation.**
- `binary()`, for `==`/`!=`:
  - `const l = …`;
  - `if ((containsFn(l, …) || holdsRigid(l)) && !builtOfLiterals(e.left) && !builtOfLiterals(e.right))` report E0222.
- `holdsRigid(t)` walks `con` args and `fn` params and result. Record fields need no walk: a type parameter enters a
  type only through its arguments.
- `builtOfLiterals(e)` is a syntactic predicate over the cases listed. It recognizes the two std calls through
  `info.calls`.
- Messages (E0222, `at` the comparison):
  - for a type parameter: "`==` compares values of `T`, a type parameter, which may stand for a type with function
    values (3.9). Compare with a function taken as a parameter, such as `same: (T, T) -> Bool`, or tell cases apart
    with `match`." (with `!=` for `!=`);
  - for a function type: the message as today.
- **`withoutFunctions`** (`call()`, `:888-894`): `t !== undefined && (containsFn(t, …) || holdsRigid(t))`. For a rigid
  type the message is "`std.text.show` is defined for types without function values (3.9), and `T` is a type
  parameter, which may stand for one; take what you need of `T` as a function parameter, such as `show: (T) ->
  String` or `same: (T, T) -> Bool`." (`std.list.contains` likewise, by its written name).
- **Order:** E0211's text already ends "compare `T` with a function returning `Order` (3.9)" (`:1243-1248`), so it is
  unchanged. Arithmetic on `T` is E0211 "`+` is defined for Int and Float, found `T`.", unchanged too.
- **Map keys:** `Map<K, V>` with `K` a type parameter is E0229, wherever it arises (`resolveType`, `badMapKey` after a
  call such as `std.map.empty<T, Int>()`). The message for a rigid key: "Map keys are `Int` or `String`, found `K`, a
  type parameter, which may stand for any type; key the map by `Int` or `String`." A generic function over map values
  still works: `Map<String, V>`.

### 2.6 G12: examples of generic functions

- **An example calls the function at concrete types**, chosen by its arguments or written type arguments:
  `contains_by(list: [1, 2], item: 3, same: ...) == false`, `none_list<Int>() == std.list.empty<Int>()`.
- **The letters name nothing in `examples`:** E0202 "`T` is a type parameter of `none_list`, which an example cannot
  name: an example calls the function at concrete types, such as `Int` (5.1)."
  - An example is emitted outside the function (`$examples`), where a TypeScript `T` would be unbound.
  - E0202's existing de-duplication by message makes two `T`s in one example one diagnostic.
- **One example, at one type, satisfies 5.1** (E0401 unchanged). By G2 the body cannot inspect a value of `T`, so a
  second item type shows nothing that the first does not. The spec's examples use `Int` and `String` where it reads
  well.
- **Actual values** (E0402) print with the call's static type, which is concrete. Generic types need `valueExpr` to
  substitute (commit 5).

### 2.7 G16: TypeScript

- **Functions:** `export function util$last<T>(list: ReadonlyArray<T>): $rt.Option<T> {`, and `async` likewise. The
  letters are written as they are (G3).
- **`ts(TypeRef)`:** a one-segment path that is a letter of the definition is the letter, before `this.resolve()`
  (which would give `m$T`).
- **`tsType`:** `rigid` is the letter. A user `con` with arguments is `` `${globalRef}<${args.join(", ")}>` `` (`:186`
  writes the name alone today).
- **Calls of user generic functions** get explicit TypeScript type arguments from `info.instances`:
  `util$last<number>(...)`, `util$repeat<T>(item, …)` inside a generic body.
  - This follows the precedent of list literals, which carry their checked type, since TypeScript's inference differs
    from alang's left-to-right binding (`None` against `Some<number>`, empty arrays).
  - Calls of std functions keep today's form, the written type arguments only, since std's TypeScript signatures do
    not always mirror alang's type parameters (`std$text$show(value: unknown)`).
- **Examples** are calls like any other, so `actual: () => util$last<number>(...)`.
- **Runtime:** no change. Type parameters are erased; `$rt.eq` and `std$text$show` are structural.

### 2.8 G13–G15: the database

- **refs.ts (G14).**
  - `rebuild()`'s `type` (`:91-95`) leaves a one-segment path that is one of the definition's letters unchanged and
    records no reference. That depends on the text alone, as `dependencies` promises (`:38-41`): inside a generic
    definition, a short letter always means its type parameter (G4).
  - `rebuild()` carries `typeParams` into the rebuilt definition.
  - **Rename** needs nothing new. Renaming `m.X` to `m.T` where `m.keep<T>` uses `X` respells it `T`. That now means
    the type parameter, so the dependency on `m.T` is lost, and E0510 fires through the existing comparison. Its
    message becomes "…A local binding or a type parameter probably has the new name; …".
  - Renaming a type parameter is not a database `rename`. It is a `replace` of the definition, and no interface change
    (below).
- **interface.ts (G13).**
  - `fullType(t, module, letters)` writes a letter as `#<position>` (`#0`, `#1`). Renaming `<T>` to `<E>` throughout
    therefore changes nothing in `in`, `out` or the shape. Adding, removing or reordering a letter changes them, since
    every letter occurs there (E0250).
  - Contracts (`requires`, `ensures`, `where`) stay compared as printed (`interface.ts:16-17`). One that names a letter
    (`fn(x: T): Bool => …`, `std.list.empty<T>()`) changes when the letter is renamed, so such a rename is an
    interface change. That is conservative and rare; normalizing letters inside printed contracts is left for later.
  - No new section name is needed.
- **search.ts (G15).**
  - `treeOfRef(t, module, letters = [])` gives `{ k: "var", name }` for a letter.
  - A stored function's type parameters then match like a std signature's: any type, the same one at each occurrence
    (`matchesType`, `:131-142`).
  - Callers: `signatureTypes`, `storedHead`, `typeHead` and `searchType` (`codebase.ts:260-288`, `:706-721`) pass the
    definition's letters.
  - `namedTypes` skips `var`s, so `context`'s second level never lists a `util.T`.
- **Hits and signatures (G15).**
  - `storedHead` writes `fn ${name}${letters}(...)`, the form of std's `signatureHead`:
    `fn util.contains_by<T>(list: List<T>, item: T, same: (T, T) -> Bool): Bool, effects: none`.
  - `typeHead` writes `type ${name}<T>, ...` (commit 5); its comment at `:280` changes.
  - `signature` and `definition` print the header through the printer.
  - `context` lists a used generic definition by its stored `signature`, which has the header.
- **`headerName`** (`codebase.ts:380-383`): `/^(?:fn|type|const) ([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?:<[^>]*>)?\s*$/`.
  `const` is from const's plan; a `<...>` after a const is a parse error anyway.
- **MCP:** no description changes. Hits carry the header by themselves. `search_type`'s description does not explain
  std's type variables today, and the rounds do not use it (Scope).

### 2.9 G7: a case names its type arguments where nothing gives them [language]

**The gap (traced).** Take `size(tree: Leaf) == 0`, `insert(tree: Leaf, item: 1, by: …)` or `first_some(first: None,
second: Some(1))`.
- The first argument's parameter type still holds an unbound variable, so `call()` checks it with no expected type, and
  the bare case is E0210.
- An example has no `let` to escape through. So the natural first example of every function over a generic type, and
  of every generic function over `Option<T>`, cannot be written.
- Spec 1.4's remedy is to write the type argument.

**Rule.** A case is written with its type's type arguments exactly when neither the expected type nor its value
gives them:
- **The expected type gives them** when it is the case's type (`let o: Option<Int> = None`, `f(x: 1) == None`).
- **The value gives them** when the case's value type names every type parameter of its type (`Some(x)`, `Node(b)`).
  Then the value is checked without an expected type, as `Some(x)` is today, and its type binds them.
- **Otherwise** the case names them, all of them, in the order of its type's parameters: `None<Int>`, `Leaf<Int>`,
  `Ok<Int, String>(1)`, `Err<Int, String>("bad")`.

It is the rule of explicit type arguments on a call (7.5, E0209), applied where the type's information can come
from: the expected type, then the value, then the text.

**Spelling (commit 3).**
- **Grammar:** `construct = TypePath [ "<" type { "," type } ">" ] [ "(" ( arg { "," arg } | expr ) ")" ] ;`.
- **AST:** `construct.typeArgs: readonly TypeRef[]`.
- **Parser:** in `pathExpr()`, after a typename segment and before `payload()`, the type list parses like
  `tryTypeArgs()` (`parser.ts:607-624`), but is not required to be followed by `(`.
  - A `<` after a construction can never start a valid comparison: cases and records have no order (E0211), and a
    chain is E0102.
  - So the lookahead succeeds only on text that is an error today. The only E0102 pins (`syntax_test.ts:84-86`) have
    names, not typenames, on the left, so they stay.
- **Printer:** `Leaf<Int>`, `Ok<Int, String>(1)`.
- **refs.ts:** rebuilds the type arguments, so `Leaf<net.port.Port>` refers to `net.port.Port`.
- **Emitter:** a builtin case ignores them (`$rt.None`). A user case takes its TypeScript type from the construction's
  checked type (commit 5).

**Checking** (`builtinConstruct` in commit 3; user cases in commit 5).
- **Written but given (E0209).** With an expected type of the case's type: "`None` takes its type from what is expected
  here; remove `<Int>`." With a value that gives them: "`Some` takes its type from its value; remove `<Int>`." Both
  have the fix `{ replace: "None<Int>", with: "None" }`, the construction without `<...>`.
- **Wrong count (E0209):** "`None` is a case of `Option<T>`, which takes 1 type argument." No fix.
- **On a case of a type without parameters** (`Less<Int>`, `Unit<Int>`, `Dot<Int>`), E0209 with the fix removing
  them: "`Dot` is a case of `Shape`, which takes no type arguments."
- **On a record**, E0209 with the same fix: "A record takes its type arguments from its fields; remove `<Int, String>`."
- **From commit 3, `construct()` handles user constructions too.** Before commit 5 no user type has parameters, so any
  `<...>` on a user case or record is E0209 with the fix removing it ("`Dot` is a case of `Shape`, which takes no type
  arguments.", or the record text above). Nothing is accepted and then ignored.
- **Missing (E0210)**, `at` the construction.
  - Message: "The type of `Leaf` cannot be determined here; types flow from left to right (1.4). Write its type
    arguments, `Leaf<T>` with a type for `T`, or put the side with a known type first."
  - `expected`: the construction with its type's parameter letters, `Leaf<T>`, `None<T>`, `Ok<T, E>(1)`. No fix.
  - This replaces today's E0210 text for `Ok`, `Err` and `None` (no test pins it).
- **After an E0209,** the construction is checked as if `<...>` were absent, so nothing follows from it (5.6).
- **Written and needed:** the type arguments are resolved (letters included, so `None<T>` works in a generic body). The
  value is checked against the substituted value type, and the result is `con(owner, args)`.

**Consequences.**
- `None<Int> == f(x: 1)` becomes valid beside `f(x: 1) == None`, where `None == f(x: 1)` is E0210 today. That is two
  orders of one comparison, as `a == b` and `b == a` always were.
- `[None<Int>, Some(1)]` without an expected type becomes valid.
- A record never takes type arguments: E0250 makes every parameter occur in a field, and fields are typed left to
  right (2.10).

### 2.10 G8: generic types [language] (commit 5)

**Form.** `type tree.Tree<T>`, the same `type_params` as functions (G3), and `end type tree.Tree`. Each letter occurs in
a field or in a case's value (E0250). Inside the definition, the letters are rigid types. So are the fields in `where`.
A recursive use carries its arguments: `Node: Branch<T>`, `left: Tree<T>`.

**Grammar:** `type_def = "type" path [ type_params ] …`. **AST:** `TypeDef.typeParams`. The parser, printer and
`refs.ts` change as for functions.

**Shapes.**
- `TypeShape` gains `typeParams: readonly string[]`. Field and case types are stored generalized, with `var` for the
  letters.
- Pass 1 registers it with the name (`check.ts:171-176`), so arity checks never depend on definition order.
- `resolveType` checks arity for user types:
  - E0209 "`Tree` takes 1 type argument: `Tree<T>`." for `Tree` or `Tree<Int, Int>`, at the type;
  - E0209 "`Point` takes no type arguments." as today.
- One helper gives a type's instantiated parts: `shapeSubst(t)` = `Map(shape.typeParams[i] -> t.args[i])`.
  - `field()` substitutes the field's type.
  - `casesOf()` substitutes each payload, so `pattern()`, `missing()`, `subsumed()` and `catchAlls()` see `Branch<Int>`
    or `Branch<T>` with no change of their own.

**Constructions** (`construct()`, `casePayload()`).
- **Record** `Pair(left: 1, right: "a")`:
  - with an expected type of the same type, its arguments give the field types;
  - otherwise the fields are checked left to right as a call's arguments are: a field type without free variables is
    the expected type, otherwise the value is checked without one and unified.
  - The result is `con(name, args)`.
  - A field value of type `ERROR` leaves a parameter unbound; the result is then `ERROR`, with nothing reported (5.6).
  - Type arguments written on a record are E0209 (2.9).
- **Case** of a generic variant: G7. Its expected type, its value, or its written type arguments give the type;
  otherwise E0210.
  - With an expected type of another type, it is E0204, "Expected `Int`, found a case of `Tree<T>`.", as
    `builtinConstruct` reports for `Option`.
- So the field or value that fixes the parameters should come first, as `item` comes first in the spec's `Branch`. The
  spec says so (2.14).

**Equality and functions.** `containsFn` (`types.ts:78-94`) needs no change. It checks a type's arguments, then the
fields as declared, where the letters are `var`s and never functions. So `Pair<(Int) -> Int, Int>` holds a function,
and `Pair<Int, String>` does not.

**TypeScript** (observed, `ts/probe.ts`):
- `export type tree$Tree<T> = | { readonly tag: "Leaf" } | { readonly tag: "Node"; readonly value: tree$Branch<T> };`;
- a record: `export type m$Pair<A, B> = {...}` and `export function m$Pair<A, B>($fields: m$Pair<A, B>): m$Pair<A, B>`,
  with its `where`;
- a construction of a generic record with explicit TypeScript arguments from its checked type,
  `m$Pair<number, string>({ ... })`;
- a case `({ tag: "Leaf" } satisfies tree$Tree<number> as tree$Tree<number>)`, the type written by `tsType` of the
  construction's checked type, not by its name (`emit.ts:507-510`).

**Elsewhere.**
- **examples.ts:** `valueExpr` substitutes a shape's field and payload types with the value's type arguments, so an
  actual value prints `Node(Branch(item: 2, left: Leaf, right: Leaf))`. A pasted actual value always has an expected
  type (the left side), so it never needs `Leaf<Int>`.
- **Hits:** `type tree.Tree<T>, variant: Leaf | Node: tree.Branch<T>`.
- **Interface:** `shapeKey` writes letters by position (G13).

### 2.11 G9: a generic function passed by name [language] (commit 4)

A generic function, std or user, passed by name takes its type arguments from the function type expected there. That
type's parameter types must be known at that point (1.4):
- `std.list.map(list: groups, with: std.list.length)`;
- `let f: (List<Int>) -> Option<Int> = last`;
- a user parameter `test: (Row) -> Bool`.

**Mechanism.**
1. **The hint.** In `call()`'s argument loop, an argument whose parameter type still holds free variables gets a hint
   when:
   - its value is a `name` expression;
   - the parameter type is a function type;
   - every parameter type of it is free of variables.

   Example: `with: (T) -> U` after `list:` has bound `T`, which gives `(List<Int>) -> U`. The value is then checked
   through `name_(e, scope, null, hint)` instead of `expr(e, scope, null)`, and the type is recorded in `info.types` as
   `expr()` does.
2. **The target.** In `name_()`, for a generic function, the target is `expected` if it is a function type, else the
   hint. An `expected` type never holds variables (`call()` passes only closed parameter types), and a hint's
   parameters are closed by construction.
3. **Instantiation** uses a substitution of its own, `s = new Map()`, so std's reuse of `T` and `U` cannot collide with
   the enclosing call's:
   - the counts must agree;
   - unify each of the function's parameter types (its own `var`s) with the target's parameter type;
   - unify `out` with the target's result when that has no free variables;
   - every type parameter must be bound.
   - The value's type is then `fnType(params.map(substitute), substitute(out))`, recorded in `info.instances`.
4. **Back in `call()`**, `unify(pt, t, subst)` binds the remaining variables (`U := Option<Int>`).
5. **Checks** in their existing order:
   - effects first (E0232, as today);
   - then `withoutFunctions` on `s` (E0222 with 2.5's texts: `with: std.text.show` over a list of functions, or over
     `List<T>` in a generic body).
6. **Failures.**
   - No target: **E0210** "The generic function `last` cannot be passed here: its type arguments come from the
     parameter types of a function type expected at this point (1.4), and none is known. Wrap it in a lambda, or bind
     it with `let` and a function type first."
   - A target that does not unify: **E0204** "Expected `(Int) -> Option<Int>`, found `last`, a generic function of type
     `(List<T>) -> Option<T>`.", `expected` the target.
7. **TypeScript:** the bare global (`util$last`, `$rt.std$list$length`). TypeScript instantiates it from context
   (observed for both, `ts/probe.ts` `b`, `e`, `f`), and std function values must not get type arguments (1.1).

**Why.** Today a function name is a value unless it is generic (decisions, "Function values"). That is two rules the
model must check per function, and a lambda for every generic one, std's too:
`with: fn(g: List<Int>): Int => std.list.length(list: g)`. With G9, "a pure function's name is a value" holds for all,
and the card's lambda sentence is already true as it stands. Types still flow from the left. Where nothing to the left
fixes the parameters, E0210 says so.

### 2.12 G10, G11: functions as results, constants

- **G10: F4 stays.** No `fn` returns a function value (E0237), generic or not.
  - The reason, that its examples could not compare its result, does not depend on generics. So `compose<A, B, C>`
    stays a lambda at the use site.
  - F4 checks the declared `out` only. A call that binds `T` to a function type (`last(list: [double])`, an
    `Option<(Int) -> Int>`) stays legal in a body, as for std; its example would be E0222.
- **G11: a constant is not generic.**
  - It has one value, evaluated once (const C4), so it has one type.
  - Its type may use generic types with arguments (`out: Tree<Int>`, `return Leaf`).
  - A header `const m.c<T>` is E0101 (commit 6): "A constant has one type and takes no type parameters; a value for
    every type is a `fn` with a type parameter, such as `fn m.empty<T>`."
  - A function with `in: none` and a type parameter stays a function, called with its type argument
    (`none_list<Int>()`), and C6's "write it as a constant" hint skips it (1.5).

### 2.13 Habit diagnostics (commit 6, cuttable; 5.7)

| Written | Without commit 6 | With it |
| --- | --- | --- |
| `fn m.f<T: Ord>`, `fn m.f<T extends Ord>`, `fn m.f<T: Eq + Show>` (Rust, TypeScript, Java) | E0101 "Expected `>`, found `:`." | **E0006** at the line: "A type parameter takes no bounds: alang has no traits (2.6). Take what the function needs of `T` as a parameter, such as `same: (T, T) -> Bool` or `by: (T, T) -> Order`." No fix |
| `end fn util.last<T>` | E0101 "Expected a line break, found `<`." | **E0103**: "The block end names the definition without its type parameters: `end fn util.last`.", `expected` and fix `{ replace: "end fn util.last<T>", with: "end fn util.last" }` (as for `end type`) |
| `case Leaf<Int> then` | E0101 "Expected `then`, found `<`." | **E0101**: "A pattern takes no type arguments; the `match` subject gives them: `case Leaf then`." |
| `const m.c<T>` | E0101 "Expected a line break, found `<`." | **E0101**, the text of G11 |

### 2.14 Spec changes (exact texts; each goes in the commit of its rule)

**Commit 1.**
- **Grammar** (section 3): replace the line `fn_def     = "fn" path` with `fn_def     = "fn" path [ type_params ]`, and
  add after `type_def`'s production:

```
type_params = "<" Letter { "," Letter } ">" ;
```

- **3.9, appended:** "A type parameter (7.3) may stand for any type, one with function values included. So the
  values of a type parameter have no built-in equality, order or text, and a generic function takes what it needs as
  a function parameter. A comparison with a value built only from literals and cases, such as `option == None`, meets
  no value of a type parameter and no function, so it works on every type."
- **7.1, new rows:**
  - "| Generic types, `type m.Pair<A, B>` (E0101) | A generic function over the parts, or a type for each use |"
    (deleted in commit 5).
  - "| Bounds on a type parameter (`<T: Ord>`), and `==`, `<` or `std.text.show` on its values (E0222, E0211) | Take a
    function as a parameter: `same: (T, T) -> Bool`, `by: (T, T) -> Order`, `show: (T) -> String`; compare with a
    value built from literals and cases (`option == None`), or tell cases apart with `match` |"
- **7.3, a new bullet after "Types"**, then a block with its fences at column 0 (const's plan: `spec_test`'s regex is
  `` ^``` ``):

> - **Generic functions.** A function takes type parameters after its name: `fn util.contains_by<T>`, `fn
>   util.pair_up<A, B>`. Each is one capital letter, written once (E0215), and each occurs in a parameter type or in
>   `out` (E0250); the end line names the function without them. Inside the definition a type parameter is a type like
>   any other, written wherever a type is (`let item: T`, `fn(x: T): Bool => …`, `std.list.empty<T>()`), and it equals
>   only itself. A call binds the type parameters from its arguments, as for std (7.5). Since a type parameter may
>   stand for a type with function values, its values have no `==`, order or `std.text.show` (3.9; E0222, E0211): the
>   function takes what it needs as a parameter, as `contains_by` takes `same`. A type, record or case of the module
>   that has one of the letters as its name is written in full inside the definition (`m.T`), and that is not E0226;
>   written short in a construction or a pattern, it is E0203.

```
fn util.contains_by<T>
  doc: "Whether the list holds an item for which same holds together with item."
  in:
    list: List<T>
    item: T
    same: (T, T) -> Bool
  out: Bool
  effects: none
  requires: none
  ensures: none
  examples:
    contains_by(list: ["a", "b"], item: "b", same: fn(x: String, y: String): Bool => x == y) == true
    contains_by(list: [1, 2], item: 3, same: fn(x: Int, y: Int): Bool => x == y) == false
  body:
    return std.list.any(list: list, with: fn(x: T): Bool => same(x, item))
end fn util.contains_by
```

- **7.3, Uniqueness:** "Definition names, parameters, fields, the type parameters of a definition, and case names
  within a module are unique (E0215)."
- **7.3, the own module, last sentence:** "One exception: a function passed as a value whose short name is also the name
  of a local, and a type, record or case named like a type parameter of the definition, are written in full."
- **7.5, Explicit type arguments (1.4), appended:** "This holds for your own generic functions too: `fn
  m.none_list<T>`, with `in: none`, is called `none_list<Int>()`."
- **7.5, Comparison and logic:** after "`==` and `!=` work on every type without functions, by structure (3.9)." insert
  "On a type that holds a function or a type parameter, they work only against a value built from literals and cases,
  such as `None`, `Err(std.fs.NotFound)` or `std.list.empty<T>()` (E0222)."
- **7.6, Examples, a new sub-bullet after the first:** "  - An example of a generic function calls it at concrete
  types: `contains_by(list: [1, 2], item: 3, same: …) == false`. A type parameter cannot be written in `examples`
  (E0202). One example type is enough, since the body cannot look into a value of a type parameter (3.9)."
- **7.8, intro:** "Type parameters (`T`, `U`, `V`, `A`, `K`) are bound from the arguments." becomes "Type parameters
  (`T`, `U`, `V`, `A`, `K`) are bound from the arguments, as for your own generic functions (7.3)."
- **7.10, `list(module)` row:** after "`fn std.string.split(...)`," insert "a generic one's like `fn
  util.contains_by<T>(list: List<T>, item: T, same: (T, T) -> Bool): Bool, effects: none`,".
- **7.10, `search_type(pattern)` row, appended:** "A type parameter, std's or your own, matches any type, the same one
  at each occurrence: `List<Int> -> Option<Int>` finds `std.list.first`."
- **7.10, Interface changes, appended:** "Renaming a type parameter throughout its definition (`<T>` to `<E>`) is not
  an interface change, unless a `requires`, `ensures` or `where` names it; adding, removing or reordering one is."
- **7.11:** a row "| E0250 | A type parameter that the signature does not use |" after the rows of the earlier phases.

**Commit 3.**
- **1.4:** "…it is written explicitly: `std.list.empty<Int>()`." becomes "…it is written explicitly:
  `std.list.empty<Int>()`, `None<Int>`."
- **Grammar:** the `construct` line of 2.9.
- **7.5, Types flow from left to right (1.4)**, the whole bullet:

  "**Types flow from left to right (1.4).** `Ok`, `Err` and `None` take their type from what is expected at that point:
  the type of a `let`, a parameter, `out` at a `return`, or the left side of `==`. `Some(x)` can also take its type
  from `x`. Where neither gives it, the case names its type arguments: `None<Int>`, `Ok<Int, String>(1)`. Without
  them it is an error (E0210), and where the expected type or the value gives them, writing them is one (E0209, with
  the fix). So `first_some(first: None<Int>, second: Some(2))`, but `let o: Option<Int> = None`. A record takes its
  type from its fields, never from written type arguments."

**Commit 4.** In 7.5 "Function values" (fn-types' text):
- "or the name of a pure function that is not generic (`by: std.int.compare`, `with: double`; E0232 for one with
  effects, E0210 for a generic one, which needs a lambda)" becomes "or the name of a pure function (`by:
  std.int.compare`, `with: double`; E0232 for one with effects)".
- Insert after that sentence: "A generic function takes its type arguments from the function type expected there,
  whose parameter types are known at that point (1.4): `std.list.map(list: groups, with: std.list.length)`, `let f:
  (List<Int>) -> Option<Int> = last`. Where none is known it is E0210; wrap it in a lambda."

**Commit 5.**
- **Grammar:** `type_def   = "type" path [ type_params ]`.
- **7.1:** delete the "Generic types" row.
- **7.3, a new bullet after "Generic functions"**, then the block:

> - **Generic types.** A type takes type parameters the same way: `type tree.Tree<T>`, written with its arguments
>   wherever it is used (`Tree<Int>`, `Tree<T>`; E0209 without them). Each type parameter occurs in a field or a case
>   (E0250). A record takes its type arguments from its fields, read from left to right; a case from what is expected
>   there, or from its value when that names every type parameter (`Node(branch)`), and otherwise it names them:
>   `Leaf<Int>` (7.5). So the field that fixes the type comes first, as `item` does in `Branch`.

```
type tree.Tree<T>
  doc: "A binary tree: a leaf, or a node with an item and a tree on either side."
  variant:
    Leaf
    Node: Branch<T>
  where: none
end type tree.Tree

type tree.Branch<T>
  doc: "A node of a tree: its item, and the trees left and right of it."
  record:
    item: T
    left: Tree<T>
    right: Tree<T>
  where: none
end type tree.Branch

fn tree.items<T>
  doc: "The items of the tree from left to right."
  in:
    tree: Tree<T>
  out: List<T>
  effects: none
  requires: none
  ensures: none
  examples:
    items(tree: Leaf<Int>) == std.list.empty<Int>()
    items(tree: Node(Branch(item: "b", left: Leaf, right: Node(Branch(item: "c", left: Leaf, right: Leaf))))) == ["b", "c"]
  body:
    let parts: List<List<T>> = match tree
      case Leaf then
        std.list.empty<List<T>>()
      case Node(branch) then
        [items(tree: branch.left), [branch.item], items(tree: branch.right)]
    end match
    return std.list.flatten(lists: parts)
end fn tree.items
```

  By hand: `items(Leaf)` is `flatten([])`, which is `[]`. The second tree is `Node(b, Leaf, Node(c, Leaf, Leaf))`, so the
  parts are `[[], ["b"], ["c"]]`, which flatten to `["b", "c"]`.
  - Typing of the second example: `Node`'s value names `T`, so `Branch(...)` is checked without an expected type.
  - `item: "b"` binds `T := String`. `left` then expects `Tree<String>`, so `Leaf` is typed.
- **7.5, Types flow:** after "`None<Int>`, `Ok<Int, String>(1)`" add ", and so does a case of your own generic type:
  `Leaf<Int>`".
- **7.10, `list(module)` row:** after the `type std.fs.Kind` example insert ", a generic one's like `type tree.Tree<T>,
  variant: Leaf | Node: tree.Branch<T>`".

**Commit 6.** 7.2, Foreign forms, appended: "Bounds on a type parameter (`<T: Ord>`, `<T extends Ord>`) are E0006,
naming the function parameter that replaces them."

### 2.15 Card (`src/card.ts`)

Measured on a frozen copy (`card/stages.ts`, observed).
- The input is the card at `9ba84a8` with statements' 2.8, fn-types' 2.8 (commits 2 and 3) and const's K1–K5 applied
  as text.
- The result was then measured after each commit of this phase that touches the card.

| Card | Lines | Bytes | Longest line |
| --- | ---: | ---: | ---: |
| After `statements`, `fn-types`, `const` | 159 | 9,818 | 118 |
| After commit 1 | 159 | 9,798 (−20) | 118 |
| After commit 3 | 159 | 9,795 (−23 in all) | 118 |
| After commit 5 | 159 | 9,803 (−15 in all) | 118 |

At no commit is the card larger than before the phase. Re-measure on the merged card; if it differs, keep each
commit's net growth at or below zero.

**Commit 1** (generic functions):
- Definitions, after the `const` bullet, one line:

```
- Generic: `fn util.last<T>`, one capital letter per type parameter, `end fn util.last`. A `T` has no `==` (E0222).
```

- "Not in alang": "tuples, generic definitions, concurrency" becomes "tuples, generic types, concurrency".
- **Cut 1:** "Each hit holds its signature (parameters, result, effects; fields or cases) and doc." becomes "Each hit
  holds its signature and doc." The first hit shows what a signature holds.
- **Cut 2:** the Bodies bullet's last two lines become one: "  end it: return early from an `if` without `else`, then
  `return`. Nest at most two blocks deep (4.8)."
  - This drops "(see `fahrenheit` below)", since the program follows right after.
  - It keeps the depth rule, shortened from "Keep to two nested blocks; deeper code becomes a function." That is a
    decision (G17), since the card is a round's only teaching.
- **Cut 3:** "  floats `1.0`, `0.25`. Also `true`, `false` and `Unit`." becomes "  floats `1.0`, `0.25`." Every
  language has `true` and `false`, and the program shows `Ok(Unit)`.

**Commit 3** (case type arguments): the `Ok`/`Err`/`None` bullet becomes

```
- `Ok`, `Err` and `None` take their type from what is expected (a `let`, a parameter, `out`, the left side of
  `==`): `f(x: 1) == None`. Where a generic parameter leaves it open, they name it: `None<Int>` (E0210).
```

**Commit 5** (generic types):
- The Generic bullet becomes

```
- Generic: `fn util.last<T>`, `type util.Pair<A, B>`, one capital letter per type parameter, `end fn util.last`.
  A `T` has no `==` (E0222).
```

- "Not in alang" loses "generic types" and takes two lines:

```
No comments (the `doc` describes), `extern fn`, imports, `var`, assignment, `null`, exceptions, `while` (use
recursion), `?`, braces, `;`, `'`, `===`, `&&`, `||`, `!`, tuples, concurrency. Most get E0006, naming the alang form.
```

- The `Ok`/`Err`/`None` bullet becomes

```
- `Ok`, `Err`, `None` and a generic type's `Leaf` take their type from what is expected (a `let`, a parameter,
  `out`, the left side of `==`): `f(x: 1) == None`. Where a generic parameter leaves it open: `Leaf<Int>` (E0210).
```

The card names E0222 and E0210, which exist, and no new std name. Its program is unchanged.

### 2.16 `docs/decisions.md` and `docs/notes.md`

`decisions.md`:
- **Syntax:**
  - a new row "Generic definitions" (G1, G3, the parser messages; commit 1; types in commit 5);
  - a new row "Case type arguments" (G7's spelling and the lookahead; commit 3);
  - "`f<T>(...)` vs `a < b`" gains: "after a construction, `<` starts type arguments if a type list closed by `>`
    parses, since cases and records have no order" (commit 3).
- **Type checking:**
  - a new row "Type parameters" (G2, G2b, G4, G5, G6, G12; commit 1);
  - "Explicit type arguments" gains user functions;
  - "`Ok`, `Err`, `None`" is rewritten with G7 (commit 3);
  - "Function values" is rewritten with G9 (commit 4);
  - "Order" and "Map keys" name type parameters;
  - "std signatures" becomes: "`src/std.ts` keeps them as data; their header and function types are alang syntax now";
  - a new row "Generic types" (G8; commit 5).
- **Semantics and runtime, Representation in TS:** a sentence for G16.
- **Database:**
  - "Interface" (letters by position);
  - "`search(type)`" (a stored function's type parameters match as std's do);
  - "Hits": the sentence "Types have no type parameters, so none appear." is replaced by the generic forms.
- **Effects:** nothing.

`notes.md` (commit 7):
- an item in "Current state", the test count, "Next", and the review list G1–G19;
- mark resolved "The grammar has no way to declare a generic function or a generic type" (Spec observations);
- add to "Left for later": one-letter `search_type` pattern variables, a `search_type` description that names type
  parameters, and bounds if a round asks for them twice.

## 3. Commits, in order

**Cut order** if the run must stop early: drop commit 6, then commit 4. If commit 5 cannot be finished, stop after
commit 4 (or 3) and leave commit 5 as phase `generic-types` (section 0). Commits 1, 2 and 3 are the phase. Commit 2
must not be cut once commit 1 is in: without it, the database records a reference `m.T` for every letter.

1. **[language] Generic functions** (G1–G6, G12, G16; E0250).
   - Source:
     - `ast.ts` (`FnDef.typeParams`); `parser.ts` (`fnDef`, `typeParams()`); `printer.ts` (`printFn`);
     - `types.ts` (`rigid`, `generalize`, `typeEquals`, `showType`);
     - `check.ts`:
       - `resolveType`, `declare`, `checkFn`, `shortForm`, `construct` and `pattern` (E0203), E0215, E0250, E0202
         texts;
       - `binary` (G2, G2b), `holdsRigid`, `builtOfLiterals`, `withoutFunctions`, E0229 text;
       - `writable`, `toTypeRef`;
       - `CheckInfo.instances` in `call()`;
     - `emit.ts` (`fn`, `ts`, `tsType`, the `call` case);
     - `refs.ts` (`typeParams` carried, so the tree stays whole; the reference rule comes in commit 2);
     - the comments at `types.ts:1-3`, `std.ts:768-770`.
   - Spec: the commit 1 texts of 2.14. Card: commit 1 of 2.15. `decisions.md`: Syntax, Type checking, Representation in
     TS. `spec_test.ts`: inventory +1 block, +1 definition. Tests 1.1–1.14.
2. **Generic functions in the database** (G13–G15).
   - Source:
     - `refs.ts` (letters are no references);
     - `codebase.ts` (`storedHead`, `signatureTypes`, `searchType`, `headerName`, the E0510 text);
     - `interface.ts` (`fullType` with letters);
     - `search.ts` (`treeOfRef` with letters, `treeOfType` `rigid`).
   - Spec: the 7.10 sentences of commit 1 move here if commit 1 is committed alone. `decisions.md`: Database. Tests
     2.1–2.7.
3. **[language] A case names its type arguments where nothing gives them** (G7).
   - Source: `ast.ts` (`construct.typeArgs`); `parser.ts` (`pathExpr`); `printer.ts`; `refs.ts`; `check.ts`
     (`builtinConstruct`, and `construct()` for user cases and records, E0209 and E0210 texts); `emit.ts` (nothing for
     builtins; the field exists).
   - Spec, card, `decisions.md`: the commit 3 texts. Tests 3.1–3.6.
4. **Generic function values** (G9).
   - Source: `check.ts` (`call()`'s hint, `name_()`'s instantiation, E0210 and E0204 texts).
   - Spec 7.5 and `decisions.md` "Function values". Flip `check_test.ts:244-249` to E0204, and fn-types' test of
     `std.list.length` to clean. Tests 4.1–4.6.
5. **[language] Generic types** (G8). **The split point.**
   - Source:
     - `ast.ts` (`TypeDef.typeParams`); `parser.ts` (`typeDef`); `printer.ts` (`printType`);
     - `check.ts`: pass 1, `TypeShape.typeParams`, `resolveType` arity, `field`, `casesOf`, `construct`, user cases in
       G7, E0250 for types;
     - `emit.ts` (`type`, record constructor, constructions, `tsType` with arguments);
     - `examples.ts` (`valueExpr`); `refs.ts`; `interface.ts` (`shapeKey`); `codebase.ts` (`typeHead`).
   - Spec, card, `decisions.md`: the commit 5 texts. `spec_test.ts`: +1 block, +3 definitions. Tests 5.1–5.12.
6. **Habit diagnostics** (2.13). `parser.ts` (bounds, `end fn f<T>`, `case Leaf<Int>`, `const m.c<T>`). Spec 7.2.
   `decisions.md` Lexical, "Foreign forms". Tests 6.1–6.4.
7. **Notes and the round.**
   - `notes.md` (2.16).
   - Save the round prompt (section 7) as `~/coding_projects/alang-rounds/prompts/shop.md`, and the reference script
     beside it as `shop-reference.ts`. The main session copies it from `round/reference.ts` in the probe directory; if
     that is gone, check 4 of the analysis builds its own.

## 4. Tests

Each language commit's programs go into `check_test`'s `accepted` list (with `clean()`), which `deno check` runs at the
end. Each run test goes into `emit_test`'s `PROGRAMS`, which are type-checked as a whole.
- `check_test.ts`'s `fn()` helper (`:29-54`) gains `typeParams?: string`, which gives the header `fn m.f<${typeParams}>`.
- Expected values were computed by hand.

**Fixtures.**
- **`UTIL`**, module `util`:
  - `fn util.last<T>(list: List<T>): Option<T>`. Examples `last(list: [1, 2, 3]) == Some(3)`, `last(list: ["a"]) ==
    Some("a")`, `last(list: std.list.empty<Int>()) == None`. Body `return std.list.get(list: list, index:
    std.list.length(list: list) - 1)`.
  - `fn util.count_if<T>(list: List<T>, test: (T) -> Bool): Int`, with `ensures: result <= std.list.length(list:
    list)`. Examples `count_if(list: [1, 5, 9], test: fn(n: Int): Bool => n > 2) == 2`, `count_if(list: ["a", ""],
    test: fn(s: String): Bool => s == "") == 1`. Body `let kept: List<T> = std.list.filter(list: list, with: fn(item:
    T): Bool => test(item))`, then `return std.list.length(list: kept)`.
  - `fn util.repeat<T>(item: T, count: Int): List<T>`, with `requires: count >= 0` and `ensures: std.list.length(list:
    result) == count`. Examples `repeat(item: "x", count: 3) == ["x", "x", "x"]`, `repeat(item: 7, count: 0) ==
    std.list.empty<Int>()`. Body `if count == 0 then` / `return std.list.empty<T>()` / `end if`, then `return
    std.list.concat(left: [item], right: repeat(item: item, count: count - 1))`.
  - `fn util.none_list<T>`, with `in: none` and `out: List<T>`. Example `none_list<Int>() == std.list.empty<Int>()`.
    Body `return std.list.empty<T>()`.
- **`HIDE`**, module `m`:
  - `type m.T` (record `n: Int`);
  - `fn m.keep<T>(item: T, tag: m.T): T`, example `keep(item: 1, tag: m.T(n: 2)) == 1`, body `return item`.
- **`TREE`**: the spec block of commit 5, plus `fn tree.insert<T>(tree: Tree<T>, item: T, by: (T, T) -> Order):
  Tree<T>`.
  - Examples:
    - `insert(tree: Leaf<Int>, item: 2, by: std.int.compare) == Node(Branch(item: 2, left: Leaf, right: Leaf))`;
    - `insert(tree: insert(tree: Leaf<String>, item: "b", by: std.string.compare), item: "a", by:
      std.string.compare) == Node(Branch(item: "b", left: Node(Branch(item: "a", left: Leaf, right: Leaf)), right:
      Leaf))`.
  - Body: `let grown: Tree<T> = match tree`, with:
    - `case Leaf then Node(Branch(item: item, left: Leaf, right: Leaf))`;
    - `case Node(branch) then` an `if by(item, branch.item) == Less then` that rebuilds the branch with
      `insert(tree: branch.left, …)`, `else` with `insert(tree: branch.right, …)`;

    then `return grown`.
  - By hand: inserting `"b"` gives `Node(b, Leaf, Leaf)`; then `"a"`, with `compare("a", "b") == Less`, goes left.
  - The shape (an `if … else … end if` as a `match` arm's value under a `let`) builds and passes `deno check` today in
    a non-generic program (observed, `today/match_if_value.alang`).
- **`PAIR`**: `type m.Pair<A, B>` (record `left: A`, `right: B`).

**Commit 1**
1. **`syntax_test`:** `UTIL` round-trips (`parseProgram`/`printProgram`) and `printSignature` of `util.last` starts
   `fn util.last<T>\n`. `fn m.f<A, B>` prints `<A, B>`. A definition without type parameters prints as before (any
   existing round-trip passes).
2. **`syntax_test`, E0101** with the messages of 2.1: `fn m.f<>`, `fn m.f<Item>`, `fn m.f<t>`, `fn m.f<T,>`.
   `end fn util.last<T>` is E0101 "Expected a line break, found `<`." (pinned until commit 6).
3. **`check_test`, clean:** `UTIL`; `HIDE`, with no E0226 (`shortened(HIDE)` equals its print).
4. **`check_test`, rigid:** `fn(..., { typeParams: "A, B", params: ["a: A", "b: B"], out: "A" })` with `return b` is
   one E0204 at `b`, "Expected `A`, found `B`." This pins the `typeEquals` fix.
5. **`check_test`, the capture trace of 1.1:** `typeParams: "T"`, `params: ["xs: List<T>"]`, `out: "Int"`, `return
   std.list.first(list: xs)` is one E0204 "Expected `Int`, found `Option<T>`." (with `T` as a `var` it would pass as
   `ERROR`).
6. **`check_test`, E0215 and E0250:**
   - `<T, T>` is one E0215 at `fn m.f<T, T>`;
   - `<T>` with `params: ["x: Int"]` is one E0250 with the fix `{ replace: "fn m.f<T>", with: "fn m.f" }`, and
     `applyFix` gives a clean program;
   - `<T, U>` with `x: T` is E0250 with the fix to `fn m.f<T>`;
   - a letter only in `out` (`none_list`) is clean;
   - `fn m.keys_of<K, V>(map: Map<K, V>): List<K>` (body `return std.list.empty<K>()`) is exactly one diagnostic,
     E0229 at `Map<K, V>`.
7. **`check_test`, E0202:**
   - a non-generic `fn util.first_of` with `list: List<T>` is one E0202 "Unknown type `T`; a type parameter is declared
     after the definition's name: `fn util.first_of<T>`.", `expected` `fn util.first_of<T>`;
   - `none_list` with the example `none_list<T>() == std.list.empty<T>()` is one E0202 with the examples text.
8. **`check_test`, E0203 (hiding):** `HIDE` with `let t: m.T = T(n: 1)` added to `keep`'s body is one E0203 with the
   fix `{ replace: "T(n: 1)", with: "m.T(n: 1)" }`. A non-generic `fn m.g(tag: m.T)` in module `m` is still E0226.
   Without `type m.T`, `return T` in `fn m.id<T>(x: T): T` is one E0203 without a fix, with the text of 2.3.
9. **`check_test`, G2:**
   - `<T>`, `a: T`, `b: T`, `out: Bool`: `return a == b` is one E0222 with 2.5's text; `!=` likewise;
   - `return std.text.show(value: a)` (`out: String`) is one E0222 with the rigid text;
   - `return std.list.contains(list: [a], item: b)` is one E0222;
   - `return [a] == [b]` is E0222;
   - `return a < b` is one E0211 whose message contains "with a function returning `Order`";
   - `return a + b` is one E0211.
10. **`check_test`, G2b clean:**
    - `return o == None` (`o: Option<T>`);
    - `return xs == std.list.empty<T>()` (`xs: List<T>`);
    - `return r == Err(std.fs.NotFound)` (`r: Result<T, std.fs.Error>`);
    - non-generic, `return f == None` with `f: Option<(Int) -> Int>`.

    Still E0222: `return o == Some(a)`. The pins `g == g` and `[g] == [g]` stay.
11. **`check_test`, E0229:** `fn m.count<K>(keys: List<K>): Map<K, Int>` is one E0229 at `Map<K, Int>` with the rigid
    text.
12. **`check_test`, calls:**
    - `let xs: List<Int> = none_list()` (with `UTIL`) is one E0209 with the fix `none_list<Int>()`;
    - `util.last<Int>(list: [1])` is E0209 with the fix `util.last(list: [1])`;
    - inside a generic body, `let ys: List<T> = []` is E0228 with the fix `std.list.empty<T>()`;
    - `let zs: List<T> = std.list.empty<T>()` is clean.
13. **`emit_test`:** `UTIL` in `PROGRAMS`, TypeScript-checked; its 8 examples pass (3 + 2 + 2 + 1), with `count_if`'s
    `ensures` checked at each return.
    - `mod.util$last([1, 2, 3])` is `{ tag: "Some", value: 3 }`, and `mod.util$repeat("x", 2)` is `["x", "x"]`.
    - The text contains `export function util$last<T>(list: ReadonlyArray<T>): $rt.Option<T> {` and
      `util$repeat<T>(item, $rt.int_sub(count, 1, "util.repeat"))`.
14. **`spec_test`:** inventory +1 block, +1 definition. `check_test`: `clean(specBlock("fn util.contains_by"))`, and
    `accept` runs its 2 examples.

**Commit 2** (codebase tests on a fresh database holding `UTIL`; `invariants` after each)
1. **Hit:** the `list("util")` entry of `util.last` has the signature `fn util.last<T>(list: List<T>): Option<T>,
   effects: none`.
2. **References:** `dependencies` of `util.last` is `["util.last", "std.list.empty", "std.list.get",
   "std.list.length"]`, with no `util.T`.
3. **`search_type`:**
   - `names("List<Int> -> Option<Int>")` is `["std.list.first", "std.list.last", "util.last"]`;
   - `names("List<Int> -> Option<String>")` is `[]`;
   - `names("List<_>, (_) -> Bool -> Int")` is `["util.count_if"]` (to verify against fn-types' F9 patterns;
     cuttable if F9 was cut).
4. **Interface:** add `fn util.tail_of(xs: List<Int>): Option<Int>`, which calls `last`.
   - Replacing `util.last` with every `T` renamed `E` alone is written, with no E0506.
   - Replacing it with `list: List<Int>` and `out: Option<Int>` (no letter, the `"a"` example dropped so that it
     checks) alone is E0506 naming `in` and `out`.
5. **Capture:** add `type m.X` (record `n: Int`) and `fn m.keep<T>(item: T, tag: X): T` with the example `keep(item:
   1, tag: X(n: 2)) == 1`. `rename(m.X → m.T)` is rejected with one E0510 for `m.keep`, whose message contains "or a
   type parameter".
6. **`headerName`:** an add of `fn util.bad<T>` whose doc holds `\r` is E0005 with `definition` `util.bad`.
7. **`context(util.tail_of)`:** `uses` names `util.last`, and its text starts `fn util.last<T>`.

**Commit 3**
1. **`syntax_test`:** `None<Int>`, `Ok<Int, String>(1)` and `Err<Int, String>("x")` round-trip through
   `parseExpression`/`printExpr`. `n < Limit` and `n < (limit)` still parse as comparisons.
2. **`check_test`, clean:**
   - `fn util.first_some<T>(first: Option<T>, second: Option<T>): Option<T>`, body `if first == None then` / `return
     second` / `end if` / `return first`, with the examples `first_some(first: Some(1), second: Some(2)) == Some(1)`,
     `first_some(first: None<Int>, second: Some(2)) == Some(2)` and `first_some(first: None<String>, second: None) ==
     None` (the second `None` takes `Option<String>` from the left);
   - `return std.list.length(list: [None<Int>, Some(1)])`;
   - `return None<Int> == std.list.first(list: [1])` (`out: Bool`);
   - in a generic body, `let o: Option<T> = None` and `return first_some(first: None<T>, second: o)`.
3. **`check_test`, E0209:**
   - `let o: Option<Int> = None<Int>` with the fix `None`;
   - `return Some<Int>(1)` (`out: Option<Int>`) with the fix `Some(1)`;
   - `return Less<Int>` (`out: Order`);
   - `None<Int, Int>` without a fix;
   - on user types (before commit 5): `return Dot<Int>` over `m.Shape` (`Dot`, `Circle: Int`) is one E0209 with the fix
     `Dot`, and `return Point<Int>(x: 1, y: 2)` (`POINT`) is one E0209 with the fix `Point(x: 1, y: 2)`.

   `applyFix` gives clean programs for the first two and the last two.
4. **`check_test`, E0210:**
   - `return std.option.with_default(option: None, default: 0)` is one E0210, `expected` `None<T>`, and its message
     contains "Write its type arguments";
   - `return std.list.length(list: [Ok(1)])` has `expected` `Ok<T, E>(1)`.
5. **`emit_test`:** `first_some` in `PROGRAMS`; its 3 examples pass, and it is type-checked.
6. **refs:** a construction `None<net.port.Port>` in `m.f` makes `callers("net.port.Port")` list `m.f`.

**Commit 4**
1. **`check_test`, clean (with `UTIL`):**
   - `let xss: List<List<Int>> = [[1], [2, 3]]`, then `let lasts: List<Option<Int>> = std.list.map(list: xss, with:
     util.last)`;
   - `let f: (List<Int>) -> Option<Int> = util.last`;
   - `let g: (List<Int>) -> Int = std.list.length` (fn-types' pin flips).
2. **`check_test.ts:244-249` flips:** `let s: List<Int> = std.list.map(list: xs, with: std.text.show)` is one E0204,
   "Expected `List<Int>`, found `List<String>`.".
3. **`check_test`, E0222:** `std.list.map(list: fs, with: std.text.show)` with `fs: List<(Int) -> Int>` is one E0222 at
   `std.text.show`.
4. **`check_test`, E0210 and E0204:**
   - `let h: Int = util.last` is one E0210 with 2.11's text;
   - `let k: (Int) -> Option<Int> = util.last` is one E0204 with `expected` `(Int) -> Option<Int>`.
5. **`check_test`, generic body:** `fn m.lasts<T>(groups: List<List<T>>): List<Option<T>>` with `return
   std.list.map(list: groups, with: util.last)` is clean.
6. **`emit_test`:** `m.lasts` with the example `lasts(groups: [[1], [2, 3]]) == [Some(1), Some(3)]` passes; it is
   TypeScript-checked, and the emitted text passes `util$last` bare.

**Commit 5**
1. **`syntax_test`:** `TREE` and `PAIR` round-trip. `printSignature` of `tree.Tree` starts `type tree.Tree<T>\n`.
   `type m.Box<>` and `type m.Box<Item>` are E0101.
2. **`check_test`, clean:** `TREE`, with its 4 examples run by `accept`; `PAIR` with:
   - `let p: Pair<Int, String> = Pair(left: 1, right: "a")`;
   - `return Pair(left: 1, right: "a").right` (`out: String`);
   - `let q: Pair<Option<Int>, Int> = Pair(left: None, right: 1)`;
   - `return Pair(left: None<Int>, right: 1).right` (`out: Int`).
3. **`check_test`, E0204:** `let a: Int = p.right` (`p: Pair<Int, String>`) is one E0204, "Expected `Int`, found
   `String`.".
4. **`check_test`, E0209:**
   - a field `p: Pair<Int>` is one E0209 "`Pair` takes 2 type arguments: `Pair<A, B>`.";
   - a field `p: Pair` gives the same;
   - `Pair<Int, String>(left: 1, right: "a")` is E0209 with the fix `Pair(left: 1, right: "a")`;
   - `let t: Tree<Int> = Node<Int>(Branch(item: 1, left: Leaf, right: Leaf))` is one E0209 with the fix removing
     `<Int>`.
5. **`check_test`, E0210:**
   - `return Pair(left: None, right: 1).right` is one E0210 at `None`;
   - `return std.list.length(list: [Leaf])` (module `tree`) has `expected` `Leaf<T>`.
6. **`check_test`, E0250:** `type m.Box<T>` (record `n: Int`) is one E0250 with the fix `{ replace: "type m.Box<T>",
   with: "type m.Box" }`.
7. **`check_test`, `match`:** over `Tree<Int>` with only `case Leaf then` is one E0213, `expected` `case Node(_) then`.
8. **`check_test`, E0222 and E0229:**
   - `Pair(left: g, right: 1) == Pair(left: g, right: 1)` (with `G`) is E0222;
   - `type m.Index<K>` with a field `entries: Map<K, Int>` is one E0229.
9. **`accept_test`, actual value:** `TREE` with `insert`'s first example changed to `== Leaf` gives one E0402, "The
   example does not hold: `insert(tree: Leaf<Int>, item: 2, by: std.int.compare)` is `Node(Branch(item: 2, left:
   Leaf, right: Leaf))`.".
10. **`emit_test`:** `TREE` in `PROGRAMS`, TypeScript-checked.
    - `mod.tree$items(<the second example's tree>)` is `["b", "c"]`.
    - The text contains `export type tree$Tree<T> =`, `satisfies tree$Tree<number> as tree$Tree<number>` (in
      `$examples`) and `tree$Branch<T>({`.
11. **Database:**
    - `list("tree")`, sorted, gives `tree.Branch`, `tree.Tree`, `tree.insert`, `tree.items`, with the signatures
      `type tree.Branch<T>, record: item: T, left: tree.Tree<T>, right: tree.Tree<T>`, `type tree.Tree<T>, variant:
      Leaf | Node: tree.Branch<T>`, and `fn tree.items<T>(tree: tree.Tree<T>): List<T>, effects: none`;
    - `names("Tree<_> -> List<_>")` is `["tree.items"]`;
    - replacing `tree.Tree<T>` with every `T` renamed `E` alone is written;
    - replacing `tree.Branch` with `left` before `item` is E0506 naming `record`.
12. **`spec_test`:** inventory +1 block, +3 definitions; `clean(specBlock("type tree.Tree"))`, and `accept` runs its 2
    examples.

**Commit 6**
1. `fn m.f<T: Ord>` and `fn m.f<T extends Ord>` are E0006 with 2.13's text.
2. `end fn util.last<T>` is E0103 with the fix to `end fn util.last`; `applyFix` parses.
3. `case Leaf<Int> then` is E0101 with 2.13's text.
4. `const m.c<T>` is E0101 with G11's text.

**Every commit:** `card_test` passes (codes and std names exist, at most 160 lines, under 10,240 bytes).

## 5. Decisions

G continues the roadmap's G1 and G2 (`docs/plans/list-literals.md`, section 3). Both were re-examined against the code
and kept:
- **G1** because every `list` hit of std already prints `fn std.list.last<T>(...)`, so the model meets this header
  before it writes one. It also mirrors the call form `empty<Int>()`. A `types:` section would need a new reserved word
  and a section with no `none` form.
- **G2** because the alternative makes a function's interface depend on its body (principle 2). G2b keeps the
  equality idioms the rounds use.

Some decisions this phase builds on still await the user's review (notes, "Decisions awaiting the user's review"):
- explicit type arguments exactly when a type parameter is missing from the parameter types, extended by G7 to cases;
- case names unique per module, so a generic type's cases are module names (`tree.Leaf`);
- examples call their own function (G12);
- a function value whose short name a local holds is written in full, which G4 extends to type parameters.

| # | Recommendation | Reason by principle | Alternative |
| --- | --- | --- | --- |
| G1 [language] | Type parameters after the name in the header, `fn util.last<T>`, `type tree.Tree<T>`; the end line without them | 1.1: the parameters stand before every section that uses them; 3: the form std's hits and calls already show | A `types:` section with a new reserved word |
| G2 [language] | A value of a type parameter (also inside `List<T>` and the like) has no `==`, `!=`, order, `std.text.show` or `std.list.contains` (E0222, E0211); a function parameter replaces them; a type parameter is no map key (E0229) | 3.9: a type parameter may hold function values; 2: the rule depends on the signature, not the body; 2.6: no traits | Allow them and check each call site's instantiation (body-dependent); bounds |
| G2b [language] | `==`/`!=` work on any type when one side is built only from literals, cases and empty collections (`option == None`, `items == std.list.empty<T>()`); this loosens E0222 for function types too | 3.9: no value of a type parameter and no function is ever compared; keeps the rounds' idioms in generic code, where a lambda cannot hold a `match`; 3.8: loosening breaks nothing | Strict G2: a helper with `match` for every `== None` |
| G3 [language] | A type parameter is one capital letter, unique per header (E0215) | 3: one form, the one std shows; no collision with builtins or TypeScript globals | Any PascalCase name (`Item`), with mangling in TypeScript |
| G4 [language] | A type parameter hides the module's type, record or case of its letter in its definition; that one is written in full there (not E0226), and the short form in a construction or pattern is E0203 with the fix | 2: adding a one-letter type to a module breaks no generic definition (as locals hide functions, and const's C2); 2.6: one meaning per name in a definition | E0215 for the clash |
| G5 [language] | Every type parameter occurs in a parameter type or `out` (a field or case for types), E0250 with a fix removing it; one only in `out` means explicit type arguments at calls | 1.4: a parameter nothing can bind has no meaning; 5.5: a mechanical fix | Phantom parameters, written at every call |
| G6 [language] | Inside its definition a type parameter is a rigid type, equal only to itself; no variance | 1.4, 5.6: the body is checked once for every type; a `var` there would bind silently (1.1's trace) | Check the body per instantiation |
| G7 [language] | A case writes its type's arguments exactly when neither the expected type nor its value gives them (`None<Int>`, `Leaf<Int>`, `Ok<Int, String>(1)`); E0209 with a fix where they are given; records never; E0210 names the form | 1.4: "written explicitly" where the left does not determine it; 3: one spelling per position; 5.1: makes `size(tree: Leaf<Int>) == 0` writable at all | Type arguments on the call when an argument needs them (`size<Int>(tree: Leaf)`), which makes E0209 depend on the arguments; a generic `empty<Int>()` function per case, which leaves two spellings where an expected type exists |
| G8 [language] | Generic types: arguments wherever the type is written (E0209); fields and payloads substituted; a record typed by its fields left to right, a case by G7 | 1.4, 4.1: as calls and their arguments | Inference from the right |
| G9 [language] | A generic function passed by name takes its type arguments from the function type expected there, whose parameter types must be known to the left; else E0210; resolves fn-types' F10 | 3: "a pure function's name is a value" without an exception; 1.4: from the left only | Keep E0210 and the lambda (fn-types' F10 as it stood) |
| G10 [language] | fn-types' F4 stays: no `fn` returns a function value, generic or not; a call may still bind `T` to a function type | 5.1, 3.9: its examples still could not compare the result | Exempt generic functions |
| G11 [language] | A constant is not generic (E0101 for `const m.c<T>`); its type may use generic types with arguments | 3: one value, evaluated once (const C4), has one type | Generic constants instantiated per use, which are functions |
| G12 | An example calls at concrete types; type parameters name nothing in `examples` (E0202); one instantiation satisfies 5.1 | 5.1: an example is a value; parametricity (G2) makes one type enough; the emitted example has no TypeScript `T` | Require two instantiations |
| G13 | Renaming a type parameter throughout is no interface change, unless a contract names it (contracts stay compared as printed); adding, removing or reordering one is (letters compared by position) | 6.4: callers never write the letter | Any change to the header is an interface change; normalizing letters inside contracts too |
| G14 | Type parameters are no references; a rename whose new name a letter would capture is E0510, whose text names type parameters | 6.1: references are names of definitions; the existing comparison finds the capture | A side table of letter references |
| G15 | A stored function's type parameters match in `search_type` as std's do; hits show `<T>` as std's do | 3: one notation for std and user code | Letters as named types |
| G16 | TypeScript generics, letters unmangled; explicit type arguments at calls of user generic functions and on generic constructions, from the checker; std calls and all function values as today | Checked output: TypeScript never infers differently from alang (the precedent of list literals); std's TypeScript signatures differ from alang's | Leave all inference to TypeScript |
| G17 | Card: per commit, net growth below zero (−20, −23, −15 bytes in all), 159 lines. Cuts: what a hit holds, the pointer to the program, "Also `true`, `false` and `Unit`"; the depth rule kept but shortened | The card is the round's only teaching; each cut is shown elsewhere (the first hit, the program) | Cut the depth rule (4.8 is not enforced) |
| G18 | One phase; split point before generic types (commit 5) | The machinery is built once in commit 1; earlier phases fit four code commits per run | Two phases from the start |
| G19 | One new code, E0250; every other diagnostic reuses a code of its concern | 5.5: codes group by concern; E0251 upward stay free | A code per new message |

## 6. Risks

- **The checker change is the largest yet.** Every `Type` reader needs `rigid` (2.2's table), including those whose
  `default` hides a missing case. Test 1.4 (`A` against `B`) and test 1.5 (the trace) pin the two failures that would
  otherwise pass silently.
- **G7's rule depends on position.** The same case is `Leaf` in one argument and `Leaf<Int>` in another. E0209 and
  E0210 both carry the spelling, and E0209 has a fix. A model that writes `Leaf<Int>` everywhere gets E0209 with fixes;
  one that writes `Leaf` everywhere gets E0210 at the first argument. The round's check 2 counts both.
- **Field order matters for inference** (`item` first in `Branch`). A model that puts `left: Tree<T>` first needs
  `Leaf<Int>` in examples. That works, but it reads worse. The spec bullet says so; watch it in the round.
- **G2b is syntactic.** `option == None` passes, while `option == none_value` with a local `none_value: Option<T>` is
  E0222. The message names the literal form.
- **Generic function values (G9)** rely on TypeScript inferring higher-order calls (observed for `map` with
  `util$last` and `std$list$length`). A std function whose TypeScript signature is not generic in the same way could
  fail `deno check`. The suite type-checks every program, so it would show; the fallback is a lambda.
- **Interface churn.** Making a non-generic function generic changes `in`/`out` and needs its callers in the
  transaction (E0506), although they stay valid. That is conservative and recorded.
- **Statements, fn-types and const are not built yet.** Their AST and checker changes (`TypeRef` union, `apply`,
  `ConstDef`, `resolveName`, `Arm.patterns`) are assumed as planned. Re-grep section 1 after they merge.
  - `std.list.find_index` (T15) is not needed by this plan: the spec block uses `std.list.any`.
- **The card budget.** 159 lines and 9,803 bytes after commit 5. One line and 436 bytes are left for `extern-fn`.
- **Two forms for a constant-like generic value.** `fn m.none_list<T>` (in: none) beside `std.list.empty<T>()` is
  legal; C6's hint skips generic functions, and the round shows whether models write such helpers.

## 7. Playground round

**Run** after the phase is merged:

```
scripts/playground-round.sh 2026-11-DD-shop <head of generics> ~/coding_projects/alang-rounds/prompts/shop.md opus
```

- The script builds the empty playground, a worktree of the commit and the MCP config under
  `~/coding_projects/alang-rounds/`. It passes the round's `CLAUDE.md`: the shell allows `alang`, `cat`, `ls`,
  `printf`, `echo`, `mkdir` and `cd`, joined with `;`, with no redirections, and files are written with the session's
  file tools.
- It runs headless without the advisor, from an empty codebase, taught only by `card` and the std queries.
- Check `instructions=sent` in `done.txt`. Afterwards: `git worktree remove --force
  ~/coding_projects/alang-rounds/2026-11-DD-shop/wt`.

**Prompt** (save as `shop.md`; it names no generic form):

> Build `shop`, a command-line tool in alang that prints the tables of a small shop, using the alang MCP tools; choose
> the module name yourself. It reads two files in the current directory.
>
> - `products.txt` holds one product per line, `<code> <name> <price>`: exactly three fields separated by single
>   spaces, the code and the name words without spaces, the price a whole number of cents, 0 or more.
> - `orders.txt` holds one order per line, `<order> <code> <quantity>`: exactly three fields separated by single
>   spaces, the quantity a whole number of at least 1, and the code that of a product.
>
> It is started as `alang db run <main> -- <command>`:
>
> - `products` prints the products sorted by code, as a table with the columns `code`, `name` and `price`. It reads only
>   `products.txt`.
> - `orders` prints the orders in file order, as a table with the columns `order`, `product` (the product's name),
>   `quantity` and `total` (the quantity times the price).
> - `top <n>` prints the `n` products with the largest revenue (the sum of the totals of their orders), largest first
>   and equal revenues by name, as a table with the columns `product`, `units` (the sum of their quantities) and
>   `revenue`; all products if there are fewer than `n`.
>
> A table is a line of the column titles, then one line per row. Every column is as wide as its longest cell, its
> title included; cells are joined by two spaces; text is padded with spaces on the right, numbers and money on the
> left. Money is shown in euros with two decimals: 50 cents as `0.50`, 1250 as `12.50`.
>
> Errors go to stderr with exit code 1, checked in this order, `products.txt` fully before `orders.txt`:
>
> - anything but these three command forms, or an `n` that is not a whole number of at least 1, prints `usage: shop
>   products | orders | top <n>`;
> - a file that cannot be read prints `cannot read <file>: <reason>`, the reason in words such as `no such file or
>   directory`;
> - the first line of a file not in its form prints `<file> line <k> is malformed`;
> - an order whose code is no product's prints `orders.txt line <k> names unknown product <code>`.
>
> Reading a file and finding its first malformed line is the same for both files, and so is printing a table: write
> each once, for every kind of row. Keep the logic in pure functions with examples.
>
> Then, in the current directory:
>
> 1. Run `products` before any file exists.
> 2. Create `products.txt` with the lines `p3 plum 20`, `p1 apple 50`, `p4 fig 90`, `p2 pear 45`, `p5 kiwi 150`, and
>    run `products`.
> 3. Run `orders` before `orders.txt` exists.
> 4. Create `orders.txt` with the lines `o1 p1 3`, `o2 p3 10`, `o3 p1 2`, `o4 p4 4`, `o5 p3 15`, `o6 p2 8`. Run
>    `orders`, `top 2`, `top 9`, `top 0`, `top`, `stock`, and no command at all.
> 5. Add the line `o7 p9 1` to the end of `orders.txt`, and run `orders` and `products`.
> 6. Add the line `p6 lime` to the end of `products.txt`, and run `products` and `top 2`.
>
> Show me every output and exit code.

**Expected results.** Computed by hand and observed equal from `round/reference.ts` in the probe directory.
- Revenues: plum 25 units, 500; fig 4, 360; pear 8, 360; apple 5, 250; kiwi 0, 0. Fig and pear tie, so fig comes first
  by name.
- Exit code 0 unless stated. No line ends in a space, since every last column is right-aligned.

1. `products` without files: stderr `cannot read products.txt: no such file or directory`, exit 1.
2. `products`:
   ```
   code  name   price
   p1    apple   0.50
   p2    pear    0.45
   p3    plum    0.20
   p4    fig     0.90
   p5    kiwi    1.50
   ```
3. `orders` without `orders.txt`: stderr `cannot read orders.txt: no such file or directory`, exit 1.
4. `orders`:
   ```
   order  product  quantity  total
   o1     apple           3   1.50
   o2     plum           10   2.00
   o3     apple           2   1.00
   o4     fig             4   3.60
   o5     plum           15   3.00
   o6     pear            8   3.60
   ```
5. `top 2`:
   ```
   product  units  revenue
   plum        25     5.00
   fig          4     3.60
   ```
6. `top 9`: the same title, then `plum        25     5.00`, `fig          4     3.60`, `pear         8     3.60`,
   `apple        5     2.50`, `kiwi         0     0.00`.
7. `top 0`, `top`, `stock` and no command: stderr `usage: shop products | orders | top <n>`, exit 1 each.
8. After `o7 p9 1`: `orders` gives stderr `orders.txt line 7 names unknown product p9`, exit 1. `products` gives the
   table of step 2, exit 0.
9. After `p6 lime`: `products` and `top 2` both give stderr `products.txt line 6 is malformed`, exit 1.

**Where the new forms should appear, if the card teaches them:**

| Form | Expected use | Old idiom it replaces |
| --- | --- | --- |
| A generic function `parse_lines<T>(file: String, text: String, parse: (String) -> Option<T>): Result<List<T>, String>` | Both files, with `parse_product` and `parse_order` passed by name | Two copies of the line loop, or a non-generic `first_malformed(lines, valid: (String) -> Bool)` followed by a second parse |
| `p == None` inside a lambda over `Option<T>` (G2b), or `std.list.find_index` | Finding the first malformed line | A helper with a `match` per type |
| A generic record `Column<T>` (title, alignment, `cell: (T) -> String`) and `table<T>(rows: List<T>, columns: List<Column<T>>): List<String>` | The three tables | Three table functions, or rows converted to `List<List<String>>` first and one non-generic `table` (count this route separately: it is a legitimate design without generics) |
| A case with type arguments, `None<Int>` or `Ok<...>` / `Err<...>` in an example | Examples of the generic helpers (`parse_lines(file: "a", text: "", parse: …) == Ok(std.list.empty<Product>())` needs none) | — |
| A generic function passed by name (G9) | `std.list.map(list: …, with: some_generic)` | A wrapping lambda |
| E0222 on `==` over `T`, E0250, E0210 at a bare case, E0209 on a redundant `<...>` | — | — |

**Checks for the analysis.** A fresh Opus agent, read-only, works like the `tasks` round's step 1: it lists every tool
call, builds an independent reference (or reuses `shop-reference.ts`), reruns only in a scratch copy, and ranks
findings "fix now" or "later" with the files to touch.
1. **Teaching by the card.**
   - Was `card` called first?
   - Count each form of the table in the accepted program, and each old idiom: duplicated parse loops, three table
     functions, string-row tables, helpers duplicated per record type.
   - Did the model write a generic definition without being told the word?
2. **Diagnostics per submit**, with codes, and whether each `fix`, `expected` or message led to the right form in one
   resubmit:
   - E0101 on the header (`<Item>`, bounds), E0222 (G2, and whether the text led to a function parameter or a literal
     comparison), E0211 on `T`;
   - E0210 at a bare case and E0209 on a redundant `<Int>` (G7: how many of each, and did the fixes converge?);
   - E0250, E0202 (a letter in `examples`, or `T` without a header), E0203/E0226 (G4), E0229 (a `Map<K, …>` attempt).
3. **Discovery:** every `list`, `search` and `search_type` call; whether a generic std signature in a hit was read as
   the model of its own header.
4. **Correctness against the reference,** on Deno, in a scratch copy:
   - files: empty `products.txt` and `orders.txt` (`products` prints only `code  name  price`; `top 3` only `product
     units  revenue`); CRLF line ends; no final newline; a double space (`products.txt line 1 is malformed`);
     quantity 0 (`orders.txt line 1 is malformed`); a price of `123456` (`1234.56`, widening the column);
   - numbers: `top 01` is lenient (`std.int.parse` reads 1); `top -1` and `top 2x` print usage;
   - stdout empty on every error and stderr empty on every success; no trap (exit 70).
5. **Generated TypeScript:** `deno check` the round's `out/*.ts` in a scratch copy, generic functions and types
   included (the "Checked output" promise of the Toolchain section).
6. **Effort:** tool calls by kind, time, output tokens, std `context` calls, and whether the first submit was accepted.

### Critical Files for Implementation

- /home/josua/coding_projects/alang/src/check.ts (`resolveType`, `declare`, `checkFn`, `shortForm`, `call`, `name_`,
  `construct`, `builtinConstruct`, `binary`, `field`, `casesOf`, `writable`, `toTypeRef`; new `holdsRigid`,
  `builtOfLiterals`, `instances`)
- /home/josua/coding_projects/alang/src/types.ts (`rigid`, `generalize`, `typeEquals`, `showType`)
- /home/josua/coding_projects/alang/src/parser.ts (`fnDef`, `typeDef`, `typeParams`, `pathExpr`), /home/josua/coding_projects/alang/src/ast.ts, /home/josua/coding_projects/alang/src/printer.ts
- /home/josua/coding_projects/alang/src/emit.ts (`fn`, `type`, `ts`, `tsType`, calls, constructions)
- /home/josua/coding_projects/alang/src/refs.ts, /home/josua/coding_projects/alang/src/interface.ts, /home/josua/coding_projects/alang/src/search.ts, /home/josua/coding_projects/alang/src/codebase.ts (`storedHead`, `typeHead`, `signatureTypes`, `headerName`, `searchType`, E0510), /home/josua/coding_projects/alang/src/examples.ts (`valueExpr`)
- /home/josua/coding_projects/alang/alang-specs.md (1.4, 3.9, grammar, 7.1, 7.2, 7.3, 7.5, 7.6, 7.8, 7.10, 7.11), /home/josua/coding_projects/alang/src/card.ts, /home/josua/coding_projects/alang/docs/decisions.md
- /home/josua/coding_projects/alang/tests/check_test.ts, syntax_test.ts, emit_test.ts, accept_test.ts, spec_test.ts, queries_test.ts, codebase_test.ts, rename_test.ts (same directory)
