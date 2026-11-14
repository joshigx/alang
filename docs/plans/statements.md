# Plan: phase 4, `statements`

The planner wrote this on 2026-11-14 from `tasks-fixes` at `c4533b4`. That branch was still moving: five commits landed during planning. The only repository file written was this plan; probes ran in a scratch directory.

- **Observed:** facts from `deno eval`, `alang check`, `alang build` and `deno check` on Deno 2.8.0.
- **To verify:** facts that were not observed.

The main session takes every recommendation, and nobody is asked. **[language]** marks a decision that changes the language; those are listed for the user's later review.

**Branch:** `statements`, from `main` after `tasks-fixes` and `std-net` are merged (roadmap order 3, then 4). The phase depends on neither. It shares with `std-net`:
- `src/card.ts`;
- spec 7.1 and 7.4;
- `docs/decisions.md`;
- `examples/lines.alang` and its `io_test` pins.

File:line references are at `c4533b4`. Re-grep them after `std-net` merges, above all for `: Unit = .* else return` in anything `std-net` added. After every commit, run `deno task test`, `deno lint` and `deno fmt --check`. Commit with explicit paths, never `git add -A`.

## 0. Scope

| Item | Where | Why |
| --- | --- | --- |
| Propagating `Result<Unit, E>` without a dummy binding | **This phase** (T1–T5) | Roadmap row 4. Five dummy bindings in the rounds' programs, and the card teaches the idiom |
| Shared `match` arms | **This phase** (T6–T10) | Roadmap row 4. Thin evidence (see 1.3), so the round tests it |
| Taking a list apart by position | **This phase** (T11, T12), as a `let ... else` form, not as a `case` pattern | The strongest evidence of all: every round program does it with a length check plus `std.list.get` (1.4). A statement form. The logstat notes assigned it here |
| Extracting the single item of a list | **This phase, through T11**: `let [argument]: List<String> = rest else return Err(Usage)` | The tasks round's `std.string.join(parts: rest, separator: "")` is this case |
| Updating one item of a list | **This phase**, `std.list.set` (T13), one std commit | One function. Today it takes `enumerate` plus an index test (tasks round) |
| Record update (copy with one field changed) | **Later**: a new roadmap row 9, `records`, after `extern-fn`. Pull it forward when a round rebuilds a record of four or more fields to change one (T14) | Weak evidence: the tasks round rebuilt a two-field record. It is an expression form, and it interacts with `where`, E0205 and 2.6 ("every argument appears at the call") |

## 1. Findings

### 1.1 How the language handles these today

- **Statements.** `Stmt` is `let` (with `elseReturn: Expr | null`), `return` or `expr` (`src/ast.ts:98-107`). `Parser.stmt()` (`src/parser.ts:431-453`) parses `let ... else return` (lines 439-444). Any other expression is parsed without looking for `else` (line 452).
- **Today's behavior (observed):**
  - `std.fs.write_text(path: "a", text: "b")` as a statement is E0217: "The value of type `Result<Unit, std.fs.Error>` is discarded. Bind it with `let`, or propagate an error with `let ... else return`." No fix (`src/check.ts:587-604`, message at line 600).
  - The same with ` else return Err("x")` is E0101: "Expected a line break, found `else`."
  - `let w: Unit = std.fs.write_text(...) else return Err("x")` followed by `return Ok(w)` is accepted.
  - `let u: Unit = std.console.print_line(text: "a")` followed by `return u` is accepted.
- **The let-else checker** (`check.ts:532-569`):
  - it checks the value with no expected type (line 536);
  - `Option` gives `error: Unit` (539-541), and anything else that is not a `Result` is E0224 (545-553);
  - the content must fit the declared type, else E0204 (554-561).
- **The let-else emitter** (`src/emit.ts:334-349`): `const $r1 = …; if (!$rt.isPresent($r1)) { const error = …; return …; }`, then the binding. `block()` (`emit.ts:318-328`) delivers `Unit` to an `assign` or `push` sink after a last `let`, but not to a `return` sink. **Observed, a latent bug:** in a `Unit` function, `return match o` whose arm ends in `let n: Int = v` passes `alang build`, but `deno check` of the output fails ("lacks ending return"). The new statement kinds would take the same path, so commit 1 fixes it for all of them.
- **One-line `if` (observed):**
  - `if c then f(x: 1) else g(x: 1) end if` parses as an `if` with an `else` branch;
  - so does `if c then f(x: 1) else return Unit end if`;
  - `if c then let a: Int = f(x: 1) else return 0 end if` parses as a let-else inside the `then` branch, so `let` already takes the `else` greedily;
  - `end if else return Unit` is E0101.
- **A block expression before `else` (observed).** `let n: Int = match … end match else return 0` passes the checker, then the emitter rejects it with E0303 at `match o`.
- **Patterns** (`ast.ts:93-96`) are `case(path, sub)`, `bind(name)` or `literal`, and a case carries at most one value (4.2). So a pattern is a chain and binds at most one name. An `Arm` holds one `pattern` (`ast.ts:86-89`).
  - `matchExpr()` (`parser.ts:743-758`) reads `case <pattern> then`.
  - `pattern()` (760-778) rejects a top-level name with E0108.
- **Shared-arm forms (observed):**
  - `case Some(v) | None then` is E0001 "Unexpected character `|`.": `|` is neither a symbol nor in `FOREIGN` (`src/lexer.ts:90-107`); only `||` is.
  - `case None, Some(v) then` is E0101 "Expected `then`, found `,`."
  - `case None or Some(v) then` is E0101 "Expected `then`, found `or`."
  - `case Some(_) then` is E0002 "…written in snake_case: ``." with the fix `_` → `` (empty).
- **List patterns (observed).** `let [a, b]: String = xs else return None` is E0101 "Expected a snake_case name, found `[`.", and `case [a, b] then` is E0101 "Expected a PascalCase type name, found `[`."
- **Match checking** (`check.ts:1358-1402`):
  - patterns go one per arm into `pattern()` (1428-1488), then `subsumed()` (1556-1574, E0214), `catchAlls()` (1523-1553, E0227) and `missing()` (1493-1514, E0213);
  - E0227's `expected` lists the remaining cases as `case … then, case … then` (line 1543).
- **The match emitter** (`emit.ts:401-422`) turns each arm into an `if`/`else if` over `tag` tests. Binds come from `pattern()` (446-459).
- **Walkers that must learn the new nodes.** TypeScript's exhaustiveness check finds each one once the AST changes:
  - `printStmt` and the `match` printing (`src/printer.ts:104-115`, 231-238);
  - `block()`, `discarded()` and `match()` in the checker;
  - `stmt()`, `block()` and the `match` case in the emitter;
  - `rebuild()`'s `stmt` and `arm` (`src/refs.ts:111-128`), which feeds `refs`, `callers`, `context` and the rename rewriting.

  Nothing else walks statements or patterns. `interface.ts` (signatures only), `search.ts` (types), `examples.ts` (values) and the export (printer) need nothing.
- **Database.** Hashes are taken over canonical text (`codebase.ts`), so new forms only need printing. A body change is not an interface change.
  - `withShortNames` (`src/codebase.ts:1618-1633`; called at 854 for a submit and 1547 for an import) applies E0226's fix itself, for sent definitions only, and lists it under `fixed`. T5 extends it.
  - Stored definitions that are not sent are only re-checked, so a stored `let x: Unit` blocks every later submit after T3 until it is replaced. N3 of `std-net` has the same risk.
- **TypeScript (observed).** Hand-written output for all three forms passes `deno check` against `src/runtime.ts`:
  - `const $r1 = parts; if ($r1.length !== 2) {…} const a: string = $r1[0];` on a `ReadonlyArray<string>`. Deno's defaults do not set `noUncheckedIndexedAccess`.
  - One `else if` branch per pattern of a shared case.
  - `Ok(Some(n)) or Err(n)`, where `n` has a different access path in each pattern.

### 1.2 Tests that pin current behavior (at `c4533b4`)

- **Dummy bindings:**
  - `tests/http_test.ts:339` and `tests/queries_test.ts:138` have `let served: Unit = std.http.serve(...) else return Unit`;
  - `examples/lines.alang:14` has `let written: Unit = std.fs.write_text(...) else return Err(...)`;
  - `src/card.ts:51` teaches the idiom.
- **Rules that stay but get neighbours:**
  - `tests/syntax_test.ts:139-142` (E0108) and `:193-197` (E0110, the one-line `if`);
  - `tests/check_test.ts:491-494` (E0217), `:502-507` (let-else), and `:427-464` (E0227: `[at, expected]`, one remaining case each, so the expected text stays the same).
- **`examples/lines.alang` and its run:** `tests/io_test.ts:565-583`. `std-net` changes its stderr to `std.fs.describe`.
- **Spec and card:**
  - `tests/spec_test.ts:34-40`: inventory of 6 definition blocks, 16 definitions, 2 statement fragments and 1 prefix;
  - `tests/card_test.ts:146-150`: the card budget (at most 160 lines, under 10,240 bytes), every code it names must exist in `src/`, and every std name must exist.
- **What no test pins (grepped):**
  - the texts of E0217, E0227 and E0214;
  - a literal `Arm` or `Stmt` tree;
  - a `search_type` pattern with three parameters, so `std.list.set` breaks no search pin;
  - a search for "replace", "update" or "set".

### 1.3 Evidence from the rounds (read from the exports)

The playground's `alang.db.bak` was exported into scratch. `tasks.alang` is the playground's current export.

- **Dummy `Unit` bindings, five in all:**
  - ledger: `let free: Unit = check_output(...) else return Err(error)` and `let written: Unit = std.fs.write_text(...)`;
  - tasks: `let stored: Unit = store(...)` and `let written: Unit = std.fs.write_text(...)`;
  - `examples/lines.alang`: one more.

  Each needs a fresh name, since 2.6 forbids reuse.
- **Lists taken apart by position, in every program:**
  - ledger `parse_arguments`: a length check, then `get` at 0 and 1;
  - ledger `parse_entry`: `length != 2`, then two `get`s;
  - wordcount `main`: `get` at 0 and 1;
  - logstat `parse_line`: `length != 5`, then five `get`s, eight lines in all;
  - logstat `main`: `get` at 0;
  - tasks `parse_command`: `first`, `drop`, `length`, and `join(parts: rest, separator: "")` for the single item;
  - `lines.alang`: `get` at 0 and 1, which silently ignores extra arguments.
- **Shared arms.** ledger `check_output` has three arms with the same body, each rebuilding the `std.fs.Error` it matched, because E0227 forbids `case Err(other)`.
  - Its body needs the error value, which no shared case can name. Today's forms are better there, as tasks' `loaded` found by itself: `if probe == Err(std.fs.NotFound) then return Ok(Unit) end if`, then `let found: std.fs.Kind = probe else return Err(fs_problem(..., reason: error))`. That is 5 lines instead of 12.
  - The four-arm `std.fs.Error` matches (ledger, wordcount, logstat, tasks) have distinct bodies; `std.fs.describe` from `std-net` removes them.
  - So T6 serves groups of cases whose bodies do not need the payload, or need one payload that every pattern binds: states, kinds, commands. E0227's `expected` points to it where the model meets the need, and the round prompt (section 7) contains such groups.
- **Updating one item.** tasks `mark_done`: `std.list.enumerate(list: tasks, with: fn(index: Int, item: Task): Task => Task(text: item.text, done: item.done or index == number - 1))`.

### 1.4 What each part of the toolchain must learn

| Part | T1–T4 (propagate, no `Unit` let) | T6–T10 (shared cases) | T11–T12 (taking a list apart) |
| --- | --- | --- | --- |
| AST | `Stmt` kind `propagate { value, elseReturn }` | `Arm.patterns: readonly Pattern[]` (at least one), replacing `pattern` | `Stmt` kind `destructure { names, type, value, elseReturn }` |
| Lexer | — | `|` in `FOREIGN` (E0006) | — |
| Parser | `expr else return expr` in `stmt()`, unless the expression is `if`, `match` or `for`, or the `else` stands on the line of an `if`'s `then` | `or` between patterns; dedicated E0101 for `,` and for `or` inside parentheses | `let [` in `stmt()`; dedicated E0101s; `case [` E0101 in `pattern()` |
| Printer | `<expr> else return <expr>` | `case A or B then` | `let [a, b]: List<T> = <expr> else return <expr>` |
| Checker | the new statement; E0235 in `let()`/`block()`; E0217 text; uses of locals tracked for the E0235 fix | names per pattern, hidden names (E0236), flattened patterns for E0213, E0214 and E0227 | the new statement; E0204 at the type |
| Emitter | let-else without the binding; `Unit` into every non-discard sink after a last statement without value | one branch per pattern, the body repeated | length test plus indexed constants |
| refs.ts | rebuild `value`, `elseReturn` | `patterns.map(pattern)` | rebuild `type`, `value`, `elseReturn` |
| codebase.ts | T5: the E0235 fix applied itself | — | — |

## 2. Design

### 2.1 T1: propagating without a value [language]

**Form.** A statement `<expression> else return <value>`, on one line like a let-else. It is exactly `let x: Unit = <expression> else return <value>` without the name:

```
std.fs.write_text(path: path, text: text) else return Err(Unwritable(error))
check_width(width: width) else return Err(error)
```

**Parsing** (`Parser.stmt()`):
- After `const e = this.expr()`, it is a propagate if `this.isKeyword("else") && this.isKeyword("return", 1)` and:
  - `e` is not an `if`, `match` or `for`. Those keep today's E0101 "Expected a line break, found `else`.", and the `let` form stays as it is.
  - the `else` token is not on the line of the `then` that opened the enclosing `then` block.
- `ifExpr()` passes the `then` token's `line` to `block()`, and `block()` passes it to `stmt()`. So `if c then f(x: 1) else return Unit end if` keeps its observed meaning, an `if` with an `else` branch: an `else` on the line of `then` belongs to the `if`.
- An `else` not followed by `return` keeps today's E0101.

**AST:** `| { readonly kind: "propagate"; readonly value: Expr; readonly elseReturn: Expr }`.

**Canonical text:** `${printExpr(value)} else return ${printExpr(elseReturn)}`.

**Typing** (a new case in `DefChecker.block()`):
1. `v = this.expr(value, scope, null)`, as for a let-else.
2. `Option<X>` gives `error: Unit`, and `Result<X, E>` gives `error: E`.
3. Anything else that is not bottom or error is **E0224**, at the expression: "`else return` takes the content of a `Result` or an `Option`, found `Unit`; write the statement without `else return …`, and put the `else` of an `if` on a line of its own." No fix.
   - The second clause is for a non-canonical `if` whose `else` ends a `then`-branch line (`if c then` / `f(x: 1) else return Unit` / `end if`). Today that is an `if` with an `else` branch; it now reads as a propagate. It never changes meaning silently: such a statement is `Unit` (anything else was E0217 before), so it becomes this E0224.
4. If `X` is not `Unit` (and not bottom or error), it is **E0217**, at the first line of the statement: "The `String` inside `Ok` is discarded; bind it: `let name: String = … else return …`." `expected`: `let name: String = <first line of the expression> else return …`. No fix.
5. The `else` value is checked by `ret()` in a child scope that binds `error`.
6. As a statement it has the value `Unit`. As the last statement of a value block it behaves like a `let` (E0204 "…has no value…" unless `Unit` is expected); the message names the statement: "This block ends with `… else return` and has no value; …".

**Effects:** nothing new. The call is checked and marked effectful like any call (E0230, awaited).

**Uses that fit:**
- a pure validation helper returning `Result<Unit, Problem>`;
- `std.fs.write_text`, `append_text`, `remove`, `create_directory` (and `create_text` after `std-net`);
- `std.http.serve(...) else return Unit`;
- a `for` statement body, where the `return` leaves the function from inside the loop.

A lambda holds no statements, so the form cannot appear in one; conditions are expressions.

**TypeScript:**

```ts
const $r1 = (await $rt.std$fs$write_text(path, text));
if (!$rt.isPresent($r1)) {
  const error = $r1.value;          // `$rt.Unit` for an Option
  return $rt.Err(...);
}
```

**Sink fix (with this commit).** In `DefinitionEmitter.block()`, after a last statement without a value (`let`, `propagate`, `destructure`), deliver `$rt.Unit` to every non-discard sink: `assign`, `push` and **`return`**. This fixes the observed `return match` case for `let` too. Test 1.9 covers it.

### 2.2 T2, T3, T4: one form, so a `let` never binds `Unit` [language]

- **T3.** A `let name: Unit = …`, with or without `else`, is **E0235**, at the first line of the statement as printed.
  - Message: "A `let` binds no `Unit`, which carries nothing (3): write the statement without `let written: Unit = `."
  - When the name is used later in its block, the message adds ", and `Unit` where `written` is used."
  - `expected`: the first line without `let written: Unit = `.
  - `fix`: `{ replace: <at>, with: <expected> }`, **only if the name is never used**. If it is used, applying the fix would leave dangling names.
  - **No fix either** when the `let` has an `else` and its value is an `if`, `match` or `for`. Example: `let x: Unit = match o … end match else return v`, which passes the checker today. Dropping the `let` would give `… end match else return v`, which T2 makes the parser reject (E0101), and T5 would print a tree that does not parse again. The message then reads "…: bind the `match` to a `Result` or an `Option` with `let` first, then propagate that name."
  - Reported only when the `let` itself raised nothing else (its value fits `Unit`), so one cause gives one diagnostic (5.6).
- **Scope of T3.** Only `let` is affected. Patterns still bind `Unit` (`case Ok(done) then` in 7.9's server), since without `_` they cannot do otherwise. Parameters, lambda parameters, `for` variables and the names of T11 are unaffected too.
- **Implementation:**
  - `Scope` gets `used: Set<string>` and a method `use(name)` that marks the name in the scope that defines it.
  - Only `name_()` calls it, where a name expression resolves to a local. `lookup` itself marks nothing, since `bind()`'s E0216 check and the method-call check (E0220) also call it; marking those would record false uses.
  - `let()` records `{ name, at, expected }` for a `Unit` let in a list kept by `block()`.
  - After its loop, `block()` reports each with or without the fix.
  - The checker also records each fixable statement node in a new `CheckInfo.unitLets: WeakSet<Stmt>`, for T5. Fixable means unused, and not an `else` form with a block value.
- **T4: E0217 for a discarded `Result<Unit, E>` or `Option<Unit>` names the statement form:**
  - message: "The value of type `Result<Unit, std.fs.Error>` is discarded; propagate its error: `… else return …`.";
  - `expected`: `<first line of the expression> else return …`;
  - no fix, since what to return is the program's choice.

  Every other discarded type keeps today's message. After T3, "Bind it with `let`" would lead a `Unit` content straight into E0235.

### 2.3 T5: the codebase applies E0235's fix itself

`withShortNames` (`codebase.ts:1618`) becomes `withOwnFixes`:
- **`own` accepts** E0226 and **E0235 with a fix**, in sent definitions.
- **Rewrite:** the definitions are rebuilt with long forms shortened (as now) and every statement in `info.unitLets` rewritten:
  - `let x: Unit = e else return v` becomes `propagate { e, v }`;
  - `let x: Unit = e` becomes `expr { e }`.

  `refs.ts` gains `applyOwnFixes(def, info)`, which generalizes `shortenOwnNames`: `rebuild()` takes a second callback for statements.
- **Result:** the change is accepted, and its result lists the E0235 diagnostic under `fixed`.
- **Why:** both are pure spelling: same meaning, one stored form (3, 3.7). It saves the model a resend of the whole transaction for a habit; the logstat round's resend cost about 25% of its output tokens. It also lets an edited export import.
- **Limit:** like E0226, it applies to sent definitions only. A stored, unsent definition with `let x: Unit` still blocks submits until it is replaced (Risks).
- **Droppable:** cut it first if time runs out.

### 2.4 T6–T10: shared cases [language]

**T6. Form.** `case <pattern> or <pattern> … then`, at the top of a case only. Each alternative is a whole pattern, printed on one line with ` or ` between them:

```
case std.fs.PermissionDenied or std.fs.IsADirectory or std.fs.Other(message) then
case Err(NotANumber(text)) or Err(Negative(text)) then
```

- The keyword `or` already means alternation in alang. C# uses the same `and`/`or`/`not` for patterns.
- A comma inside parentheses would read as a second value (4.2).
- AST: `Arm { patterns: readonly Pattern[]; body }`.
- Parser (`matchExpr`): `patterns = [this.pattern(true)]`, then `while (this.isKeyword("or")) { this.next(); patterns.push(this.pattern(true)); }`. A name alternative is still E0108.
- A case line is one entry (3.7), from `case` to `then`, just as `a or` followed by a line break is an error in an expression. A line break after `or` (or before it) is E0101: "A `case` and all its patterns stand on one line, up to `then`." It replaces the generic "Expected a PascalCase type name, found line break."
- Printer: `case ${arm.patterns.map(printPattern).join(" or ")} then`.

**T7. Names.** Each pattern binds zero or one name (1.1).
- **Visible names.** A name is bound in the arm if every pattern of the case binds it, with equal types (`typeEquals`). If its type is the error type in some pattern, it is bound with the error type, so nothing follows (5.6).
- **Hidden names.** Any other name that a pattern binds is *hidden* in the arm:
  - A use is **E0236**, at the name, without a fix. Message: "`message` is bound by `std.fs.Other(message)` but not by every pattern of its case, so it has no value here."
  - With different types the message is: "`n` is an `Int` in `Ok(n)` and a `String` in `Err(n)`, so it has no single type here."
  - A hidden name is looked up before the module's functions, so it never silently means a function of the module.
  - Binding it again in the arm is E0216, since it stands in the pattern text (2.6).
- **Implementation:**
  - each alternative is checked by `pattern()` into its own child of the enclosing scope, which keeps E0216 against outer names;
  - visible names are then defined in the arm scope;
  - hidden ones go into a new `Scope.hidden: Map<string, string>` (name → message), which `name_()` consults before E0203;
  - a single-pattern arm behaves exactly as today.

**T8. Exhaustiveness and reachability.** `match()` flattens the patterns in text order.
- **E0213** (`missing`) is unchanged.
- **E0214** (`subsumed`): each pattern is checked against the earlier arms and the earlier patterns of its own case. A covered alternative is reported at the whole case line (`case A or A then`): "`A` is never reached; earlier cases or patterns cover it."
- **E0227** (`catchAlls`): items carry their arm, so `at` quotes the whole case line.
  - `expected` becomes **one** case: the case's patterns, with the catch-all pattern replaced by the remaining cases joined by ` or `. For one remaining case it stays as today (`case Err(OutOfRange(name)) then`); for several it reads `case Err(std.fs.PermissionDenied) or Err(std.fs.IsADirectory) or Err(std.fs.Other(name)) then`.
  - The message ends: "Write a case for each, or name them in one case with `or`."

**T9. Foreign forms (5.7).**
- **`|`** (Rust, Python, Scala, OCaml) is E0006, in `FOREIGN` after `||`.
  - Message: "`|` does not exist; patterns that share an arm are joined with `or` (`case A or B then`), and logic is `or`."
  - `at`: the line. `expected`: `or`.
  - `fix`: `{ replace: <line>, with: <line with every | outside string literals, and the spaces around it, replaced by " or "> }`. The whole line is quoted, so the fix cannot hit another `|`.
  - Write a small helper in `lexer.ts`, `outsideStrings(line, from, to)`, that tracks `"` with `\\` and `\"` escapes. The comma fix uses it too.
- **`case A, B then`** (Go, Java, Kotlin, Swift) is E0101, raised in `matchExpr` when `,` follows a pattern.
  - Message: "Patterns that share an arm are joined with `or`: `case A or B then`."
  - `fix`: the line with each top-level `, ` replaced by ` or `. Patterns hold no commas, since a case carries one value.
  - No fix if the line holds a `"`.
- **`or` inside parentheses** (`case Err(A or B) then`) is E0101 in `pattern(false)` when `or` follows a sub-pattern: "`or` joins whole patterns of a case, not the values inside one: `case Err(A) or Err(B) then`, not `case Err(A or B) then`." No fix. One form: every alternative reads alone (3, 4).

**T10. TypeScript.** Each pattern of a case becomes its own `else if` branch with its own binds, and the body is emitted again in each. That is the meaning of a shared case, and TypeScript narrows each branch as today. Each copy draws fresh temporaries from `temp()`. The price is output size, which only the TypeScript sees (Risks). This shape was observed to type-check (1.1).

### 2.5 T11, T12: taking a list apart [language]

**T11. Form:**

```
let [client, opening, closing, status_text, milliseconds_text]: List<String> = std.string.split(text: line, separator: " ") else return None
let [argument]: List<String> = rest else return Err(Usage)
```

- **Exact length.** If the list has exactly as many items as there are names, they are bound in order. Any other length returns the `else` value, in which `error` is `Unit`, as for `None`.
- **The type is the list's type.** What stands left of the colon is a list, so its type is `List<T>` (1.3, as in `let n: Int`), and each name gets `T`.
  - This is also the expected type of the value, as for a plain `let`, so a literal on the right takes its items' type from it (1.4).
  - The names count positions like 4.1's named arguments, by name and in order, not by index (4).
- **Names only.** At least one name; no literals, no nested lists, no `_`. `else return` is required, since the length can always differ.
- **Grammar:** `destructure = "let" "[" name { "," name } "]" ":" type "=" expr "else" "return" expr ;`
- **AST:** `| { readonly kind: "destructure"; readonly names: readonly string[]; readonly type: TypeRef; readonly value: Expr; readonly elseReturn: Expr }`.
- **Canonical text:** `let [a, b]: List<String> = <expr> else return <expr>`, the names separated by `, `.

**Parser** (`stmt()`, after `let`, if `[` follows). Each failure is E0101 at the line:
- Names read with `bindingName()` (E0109 for `result` and `error`).
- `[]`: "A `let [...]` names at least one item."
- A trailing comma: "A `let [...]` ends after its last name; remove the comma before `]`."
- Anything but a name in the brackets: "A `let [...]` takes a list apart into names only: `let [first, second]: List<String> = items else return ...`."
- No `else return` after the value: "A `let [...]` needs `else return ...` for a list of another length."

**Typing:**
- `declared = resolveType(type)`.
  - **It is a `List<T>`:** check the value with `this.expr(value, scope, declared)` (mismatches are E0204 as for `let`), then bind every name to `T` with `bind()` (E0216 for a duplicate or a visible name).
  - **It is not a `List`:** check the value with no expected type, then report **E0204** at the first line: "`[key, value]` is a list, so its type is a `List`: `List<String>`."
    - `expected` is `List<V>`, where `V` is the value's item type, if the value is a `List` and `V` can be written (`writable`); otherwise `List<T>`.
    - `fix`: `{ replace: "]: String =", with: "]: List<String> =" }`, only when `expected` names a written type.
    - The names are bound to the error type.
- The `else` value is checked in a scope with `error: Unit`.
- As the last statement of a value block, it behaves like a `let`.

**TypeScript:**

```ts
const $r1 = $rt.std$string$split(line, " ");
if ($r1.length !== 5) {
  const error = $rt.Unit;
  return $rt.None;
}
const client: string = $r1[0];
// … one const per name, through scope.add (TS reserved words get `$`)
```

**T12. No list patterns in `case`.** `case [a, b] then` is E0101 in `pattern()`: "A `case` takes no list apart: no set of cases covers every length without a catch-all (3.3). Use `let [first, second]: List<T> = items else return ...`, or `std.list.first` and `std.list.drop`."
- Exhaustive list patterns would need a rest pattern and a length analysis.
- Literal items, such as `["add", text]` for arguments, could never be exhaustive, since 3.3 has no catch-all.

### 2.6 T13: `std.list.set`

| Signature | Effects | Doc |
| --- | --- | --- |
| `std.list.set<T>(list: List<T>, index: Int, item: T): List<T>` | none | Updates one item: the list with the item at the index replaced, counting from 0; copies the list. An index outside the list traps; `std.list.get` tells whether it is inside. |

- **STD order:** after `std.list.get`.
- **Runtime:** `const SET_CONDITION = "0 <= index and index < std.list.length(list: list)"`. If `index < 0 || index >= list.length`, `trap("requires", "std.list.set", SET_CONDITION, \`Precondition of std.list.set violated: ${SET_CONDITION}\`)`. Otherwise `const copy = list.slice(); copy[index] = item; return copy;`.
- **Why a trap and not `Option`.** An index outside the list is a program error like `take`'s negative count (S3), since callers find the item with `get` first. An `Option` result would bring back a dummy `else` after a `get` that already checked.
- **Search.** The name is `set`, the common one (Java, Kotlin); `search("replace")`, `search("update")` and `search("set")` all find it.
- **7.8 cost paragraph:** add `set` to "leave their list unchanged and build a new one" and to "`append` and `concat` copy every item", so a `fold` that calls `set` per item is quadratic.

### 2.7 Spec changes (exact texts; each goes in the commit of its rule)

**Section 3 table (rows 163-164):**
- "Distinguish variants | `match … case … then … end match`; variants handled alike share one `case A or B then`"
- "Propagate an error | `let name: Type = expression else return …`; with nothing to bind, `expression else return …`"
- New row after it: "Take apart a list of known length | `let [a, b]: List<Type> = list else return …`"

**3.2:** "In `let … else` the expression has type `Result<T, E>` or `Option<T>`. On `Ok` or `Some` the content is bound; otherwise the function returns the `return` value. In the `else` branch the error value is called `error`. A `let` never binds `Unit`: a `Result<Unit, E>` or `Option<Unit>` is propagated by the statement `expression else return …` alone. A `List` is taken apart the same way: `let [a, b]: List<T> = expression else return …` binds the items if there are exactly as many as names; otherwise the function returns, and `error` is `Unit`."

**3.3:** "Every variant is named in a `case`; one `case` may name several, `case A or B then`, and binds a name only if each of them binds it. There is no catch-all case, so that a new variant reports every affected place as an error."

**4.6, at its end:** "…`zip`, `enumerate` and `window`, and a list of known length is taken apart by name: `let [key, value]: List<String> = parts else return …` (3.2)."

**After the `for` fragment of section 3 (line 190), a new fragment.** It becomes a spec test case: the round trip, plus a check test.

> Taking a line apart and writing a file, with the two forms of 3.2 that need no index and no dummy name:
>
> ```
> let [path, text]: List<String> = std.string.split(text: line, separator: "=") else return Err(line)
> std.fs.write_text(path: path, text: text) else return Err(std.text.show(value: error))
> ```

If `std-net` is merged, write `std.fs.describe(error: error)` instead of `std.text.show(value: error)`.

**Grammar (lines 219-229):**

```
stmt        = let | destructure | propagate | return | expr ;
let         = "let" name ":" type "=" expr [ "else" "return" expr ] ;
destructure = "let" "[" name { "," name } "]" ":" type "=" expr "else" "return" expr ;
propagate   = expr "else" "return" expr ;
...
arm         = "case" pattern { "or" pattern } "then" stmt { stmt } ;
```

**7.1, new rows:**
- "A pattern over a list's items, `case [a, b] then` (E0101) | `let [a, b]: List<T> = xs else return …` for an exact length; `std.list.first` and `std.list.drop` for the first item and the rest"
- (commit 6) "Copying a record with one field changed | Construct it again with every field named: `Task(text: task.text, done: true)`"
- The `_` row gains: "; in a shared case, a name that not every pattern binds is simply left unused"

**7.4 (lines 500-512):**
- **Statements.** "One per line: a `let`, a `return`, or an expression of type `Unit`, such as `std.console.print_line(...)`, alone or followed by `else return` (below). Any other value must be used; dropping a `Result` is an error (E0217)."
- **`let` (3.2).** Insert after "always with the type": ", which is never `Unit` (E0235): write a `Unit` expression as a statement, and `Unit` for its value; the codebase applies this fix itself (7.10)". The clause after the semicolon goes in only with T5.
- **New bullet: propagating without a value.** "A `Result<Unit, E>` or an `Option<Unit>` has nothing to bind, so it is propagated by a statement: `std.fs.write_text(path: p, text: t) else return Err(Unwritable(error))`. Its `else` and `error` work as in a `let`. A content other than `Unit` must be bound (E0217), and an expression that is no `Result` or `Option` takes no `else` (E0224). The expression is not an `if`, `match` or `for`. On one line, `if c then f(x: 1) else return v end if` keeps its meaning: an `else` on the line of `then` belongs to the `if`."
- **New bullet: taking a list apart.** "`let [method, path, status]: List<String> = std.string.split(text: line, separator: " ") else return None` binds the items in order if the list has exactly as many items as names; any other length returns the `else` value, in which `error` is `Unit`. The type is the list's (E0204, with the fix, for the item type written instead). Only names stand in the brackets, at least one, and `else return` is required (E0101). A `case` takes no list apart (E0101): no set of cases covers every length without a catch-all (3.3)."
- **`match` (3.3).** Append: "Cases handled alike share an arm: `case std.fs.PermissionDenied or std.fs.IsADirectory or std.fs.Other(message) then`." New sub-bullet: "Every pattern of a shared case is whole: `or` stands only between them, never inside parentheses (`case Err(A or B)` is E0101), and neither `|` (E0006) nor `,` (E0101) joins them. A name is bound in the arm only if every pattern binds it with the same type: `case Circle(size) or Square(size) then` binds `size`, while `message` above has no value in the arm (E0236 where it is used). A pattern that earlier cases or patterns cover is E0214."
- **E0227 sub-bullet.** Replace "Write a case for each." with "Write a case for each, or name them in one case: `case Err(std.fs.PermissionDenied) or Err(std.fs.IsADirectory) or Err(std.fs.Other(message)) then`."

**7.8:** the `std.list.set` row (`spec_test` compares the rows with `STD`) and the cost paragraph (2.6).

**7.10, Results:** with T5, "`fixed` lists E0226 and E0235, the two fixes the codebase applies itself".

**7.11 table:** after the E0234 row, add `| E0235 | A \`let\` that binds \`Unit\` |` and `| E0236 | A name that only some patterns of a shared case bind |`.

### 2.8 Card (`src/card.ts`)

Measured on a scratch copy, with the `std-net` 2.7 edits applied textually:

| Card | Lines | Bytes | Longest line |
| --- | ---: | ---: | ---: |
| Today (`c4533b4`) | 158 | 9,391 | 118 |
| With this phase | 158 | 9,582 | 118 |
| After `std-net` | 158 | 9,439 | 118 |
| After `std-net` plus this phase | 158 | 9,630 | 118 |

The program is unchanged: still `temp`, 4 examples.

**Commit 1**, the first three Bodies bullets (lines 50-54) become:

```
- One statement per line: `let`, `return`, or an expression of type `Unit`. Every other value is used (E0217).
- `let n: Int = expression`, always with the type, never `Unit` (E0235); immutable, reusing no visible name (E0216).
- `let n: Int = std.int.parse(text: t) else return Err(NotANumber(t))`: the content of `Some` or `Ok` is bound;
  otherwise the function returns the `else` value, in which `error` is the `Err` value. A `Result<Unit, E>` needs
  no `let`: `std.fs.write_text(path: p, text: t) else return Err(error)`.
```

**Commit 3** appends to that bullet: " A list of exactly two items is taken\n  apart with `let [key, value]: List<String> = parts else return None`." It also merges the program's heading and sentence into `## A complete program, accepted as it stands`, which saves 2 lines.

**Commit 4**, the last line of the `match` bullet becomes:

```
  name beside specific cases of its type is E0227; cases alike share an arm, which binds only what all of them bind:
  `case std.fs.PermissionDenied or std.fs.Other(message) then`. A `match` on `Int` or `String` is never exhaustive.
```

(E0213's message still says "use `if` instead".) The card names E0235 but not E0236. Every std name it adds (`std.fs.write_text`, `std.fs.PermissionDenied`, `std.fs.Other`) exists. Re-measure after `std-net` merges.

## 3. Commits, in order

**Cut order** if the run must stop early: drop commit 2, then commit 5. Commits 1, 3 and 4 are the phase.

1. **[language] Propagate a `Result<Unit, E>` by a statement; a `let` binds no `Unit`** (T1–T4).
   - Source:
     - `ast.ts` (`propagate`);
     - `parser.ts` (`stmt()`, the `then` line through `ifExpr()` and `block()`);
     - `printer.ts`;
     - `check.ts` (the new statement in `block()`, E0235 with `Scope.used`, E0217 text, `CheckInfo.unitLets`);
     - `emit.ts` (the statement, the sink fix);
     - `refs.ts`.
   - Adapt:
     - `examples/lines.alang:14`, `tests/http_test.ts:339`, `tests/queries_test.ts:138`;
     - every `: Unit = .* else return` that `std-net` added (re-grep `src/`, `tests/`, `examples/`, `alang-specs.md`);
     - card lines 50-54 (2.8).
   - Spec:
     - section 3 table "Propagate an error";
     - 3.2 (without the list sentence);
     - grammar `stmt`, `propagate`;
     - 7.4 Statements, `let`, and the new propagate bullet;
     - 7.11 E0235.
   - `decisions.md`:
     - Syntax: a row "Propagation statement" (T1, T2);
     - Type checking: a row "`Unit` bindings" (T3); "Discarded values" gains T4;
     - Semantics and runtime, "Representation in TS": "a statement without a value at the end of a value block delivers `Unit`".
   - Tests 1.1–1.10.
2. **The codebase applies E0235's fix itself** (T5).
   - `codebase.ts` (`withOwnFixes`), `refs.ts` (`applyOwnFixes`).
   - 7.4 and 7.10 sentences; `decisions.md` Database, "Own-module names" row extended (or a sibling row "`Unit` bindings fixed").
   - Tests 2.1–2.3.
3. **[language] Take a list of known length apart** (T11, T12).
   - Source: `ast.ts` (`destructure`), `parser.ts` (`stmt()` and `case [` in `pattern()`), `printer.ts`, `check.ts`, `emit.ts`, `refs.ts`.
   - Spec:
     - section 3 table row;
     - 3.2 list sentence;
     - 4.6;
     - grammar `destructure`;
     - the new fragment after line 190;
     - 7.1 `case [a, b]` row;
     - 7.4 new bullet.
   - `examples/lines.alang` takes its arguments apart: `let [source, target]: List<String> = std.env.args() else return Err("usage: lines <source> <target>")`.
   - Card: the let-else sentence and the program heading (2.8).
   - `decisions.md`: Syntax row "Taking a list apart" (T11, T12); Type checking row (the list type, E0204 fix).
   - Tests 3.1–3.8.
4. **[language] Cases that share an arm** (T6–T10).
   - Source:
     - `ast.ts` (`Arm.patterns`);
     - `lexer.ts` (`|`, `outsideStrings`);
     - `parser.ts` (`or`, the comma and nested-`or` messages);
     - `printer.ts`;
     - `check.ts` (names, `Scope.hidden`, E0236, flattened E0213, E0214 and E0227, E0227 `expected` and message);
     - `emit.ts` (a branch per pattern);
     - `refs.ts`.
   - Spec:
     - section 3 table "Distinguish variants";
     - 3.3;
     - grammar `arm`;
     - 7.1 `_` row;
     - 7.4 `match`;
     - 7.11 E0236.
   - Card: the `match` bullet (2.8).
   - `decisions.md`:
     - Syntax row "Shared cases" (T6, T9);
     - Type checking: rewrite the "`match`" row (T7, T8);
     - Semantics and runtime, "Representation in TS" (T10);
     - Lexical, "Foreign forms" gains `|`.
   - Tests 4.1–4.10.
5. **`std.list.set`** (T13).
   - `std.ts` and `runtime.ts`.
   - Spec 7.8: the row and the cost paragraph.
   - `decisions.md`, Text, numbers and lists in std: a row.
   - Tests 5.1–5.2.
6. **Notes and roadmap.**
   - `notes.md`:
     - item 20 in "Current state", "Next", the test count, and the review list with T1–T14;
     - mark as resolved "Propagating a `Result<Unit, E>`" (ledger round), "E0227 duplicates arms" (ledger round, with the 1.3 finding that `==` plus let-else served `check_output` better) and "Taking a list apart by position" (logstat round);
     - add "Record update" to "Left for later" with row 9.
   - Spec 7.1: the record row.
   - Add roadmap row 9 `records` to the "Next" sentence; the roadmap table itself lives in `docs/plans/list-literals.md`, section 0, and stays as written.
   - Save the round prompt (section 7) to `~/coding_projects/alang-rounds/prompts/tickets.md`, as was done for `tasks.md`.

## 4. Tests

Each language commit's programs go into `check_test`'s `accepted` list (with `clean()`), which `deno check` runs at the end. Each run test goes into `emit_test`'s `PROGRAMS`, which are TS-checked as a whole.

**Commit 1**
1. **`syntax_test`:**
   - `std.fs.write_text(path: p, text: t) else return Err(error)` round-trips through `parseStatements`/`printStmts`.
   - The same inside a multi-line `if` round-trips.
2. **`syntax_test`, one-line `if`:**
   - `if c then f(x: 1) else return Unit end if` still prints as an `if` with an `else` branch (`return Unit`);
   - `if c then f(x: 1) else g(x: 1) end if` likewise.
3. **`syntax_test`, `else` after a block:**
   - `match x\ncase A then\n1\nend match else return 0` stays E0101 "Expected a line break, found `else`.";
   - `f(x: 1) else g(x: 1)` stays E0101.
4. **`check_test`, clean programs:**
   - in a pure function: `check_width(width: w) else return Err(error)`, where `check_width` returns `Result<Unit, String>`;
   - with `fs.write`: `std.fs.write_text(...) else return Err(std.text.show(value: error))`;
   - with an `Option<Unit>`: `opt else return 0`, `opt` a parameter `Option<Unit>`;
   - in a `for` statement body;
   - in a function with `ensures`.
5. **`check_test`, errors:**
   - `std.console.print_line(text: "a") else return Unit` is one E0224;
   - `std.int.parse(text: "1") else return 0` is one E0217 whose `expected` starts `let name: Int = `;
   - an `else` value of the wrong type is E0204.
6. **`check_test`, E0235:**
   - `let w: Unit = std.fs.write_text(...) else return Err(error)` followed by `return Ok(Unit)`: one E0235 whose fix gives exactly the propagate line. The fixed program is clean.
   - The same followed by `return Ok(w)`: E0235 without a fix.
   - `let u: Unit = std.console.print_line(text: "a")`: the fix is `std.console.print_line(text: "a")`.
   - `let x: Unit = match o` (a `match` of `Unit` arms): the fix is `match o`.
   - `let x: Unit = match o` (arms of `Option<Unit>` values) `… end match else return 0`: E0235 **without** a fix, with the "bind the `match` … with `let` first" message.
   - Still clean: `case Ok(done) then`, binding `Unit`; a lambda parameter of type `Unit`.
7. **`check_test`, E0217:** a discarded `std.fs.write_text(...)` has `expected` `std.fs.write_text(path: "a", text: "b") else return …`.
8. **`emit_test`:** a program `steps2` (or an extension of `steps`) with:
   - a pure `check_width` called with the statement;
   - `main` writing two files with the statement, the second path invalid.

   It runs, and `main` returns `Err` with the second error. TS-checked.
9. **`emit_test`, the sink fix:** in a `Unit` function, `return match o` whose `Some` arm ends with `let n: Int = v`, and another arm whose last statement is a propagate. It passes `deno check` and returns `Unit` (`null`) at runtime.
10. **`rename_test` / `refs_test`:** renaming a function that is called only in a propagate statement rewrites the call, and `callers` lists the caller.

The `io_test` of `lines.alang` and the card tests pass unchanged.

**Commit 2**
1. **Submit:** `let written: Unit = std.fs.write_text(...) else return Err(error)` then `return Ok(Unit)` is accepted. `fixed` holds one E0235, and `definition` shows the propagate line.
2. **Not fixed:** the same with `return Ok(written)` is rejected with E0235 and no fix.
3. **Import:** an export file holding the old form imports, and the database text has the new form. Mixed E0226 and E0235 in one definition: both are applied.
4. **Not applied to a block value:** `let x: Unit = match o … end match else return 0` is rejected with E0235, not rewritten, and nothing is written.

**Commit 3**
1. **`syntax_test`:** `let [a, b]: List<String> = xs else return None` round-trips, with line breaks inside the brackets ignored.
2. **`syntax_test`, the E0101s:**
   - `let []: List<Int> = xs else return 0`;
   - `let [a, ]: …`;
   - `let ["x", b]: …`, `let [A]: …` and `let [[a]]: …`;
   - `let [a, b]: List<String> = xs` without `else`;
   - `case [a, b] then`.

   Each has the message of 2.5. `let [error]: …` is E0109.
3. **`check_test`, clean programs:**
   - `let [method, path, status]: List<String> = std.string.split(text: line, separator: " ") else return None`, then using `status`;
   - `let [only]: List<Int> = [1] else return 0` (the literal takes `List<Int>`);
   - `error` is `Unit`: `else return Err(error)` in a `Result<Int, Unit>` function.
4. **`check_test`, errors:**
   - `let [a, b]: String = parts else return None`, with `parts: List<String>`, is one E0204 with the fix `]: String =` → `]: List<String> =`, and the fixed program is clean;
   - a value of type `Option<String>` is E0204;
   - `let [a, a]: …` is E0216;
   - a name equal to a parameter is E0216.
5. **`emit_test`:**
   - a function `fields(line: String): Option<String>` over `split(" ")` with three names has examples for 3 items, 2, 4, and `""` (one item). It runs.
   - A `main` taking `std.env.args()` apart runs with 2 and with 3 arguments.
6. **`spec_test`:** inventory `statementBlocks.length` 2 → 3, so the new fragment round-trips automatically. **`check_test`:** `clean(fn(specBlock("let [path, text]") + "\nreturn Ok(Unit)", { params: ["line: String"], out: "Result<Unit, String>", effects: "fs.write" }))`.
7. **`io_test` (lines.alang):** add `assertEquals(await start(["in.txt", "out.txt", "extra"]), [1, "", "usage: lines <source> <target>\n"])`.
8. **refs:** renaming a function called in the value of a `let [...]` rewrites it.

**Commit 4**
1. **`syntax_test`:**
   - `case A or B then` round-trips;
   - `case Err(NotANumber) or Err(OutOfRange(n)) then` round-trips;
   - a line break after `or`, and one before `or`, are E0101 "A `case` and all its patterns stand on one line, up to `then`." (T6).
2. **`syntax_test`, foreign forms (5.7):**
   - `case A | B then` is E0006 with `at` the line and the fix `case A or B then`;
   - `case A|B then` gets the same fix;
   - `case A, B then` is E0101 with the fix `case A or B then`;
   - `case Err(A or B) then` is E0101 without a fix;
   - `a || b` is still E0006 with the fix `or`.
3. **`check_test`, clean programs:**
   - over `m.Shape` (`Circle: Int`, `Square: Int`, `Dot`): `case Circle(size) or Square(size) then size` and `case Dot then 0`;
   - over `std.fs.Error`: `case std.fs.NotFound then "missing"` and `case std.fs.PermissionDenied or std.fs.IsADirectory or std.fs.Other(message) then "unreadable"` (add the `AlreadyExists` alternative if `std-net` is merged).
4. **`check_test`, E0236:**
   - using `message` in that arm is one E0236 with the "bound by `std.fs.Other(message)`" message;
   - `case Ok(n) or Err(n)` over `Result<Int, String>` using `n` is one E0236 with the "no single type" message;
   - with a module function `message`, a use is still E0236, not a function value.
5. **`check_test`, E0216:**
   - `let message: String = "x"` inside that arm is E0216;
   - an alternative binding a parameter's name is E0216.
6. **`check_test`, E0214:**
   - `case A or A then` is one E0214;
   - `case Circle(s) then` followed by `case Circle(t) or Dot then` is one E0214.
7. **`check_test`, E0227:**
   - inside one arm, `case Err(NotANumber) or Err(e) then` after `case Ok(p) then` is E0227;
   - with several remaining cases (a match over `Result<String, std.fs.Error>` with `case Ok(t)`, `case Err(std.fs.NotFound)`, `case Err(other)`), `expected` is the single line `case Err(std.fs.PermissionDenied) or Err(std.fs.IsADirectory) or Err(std.fs.Other(name)) then` (plus `AlreadyExists` after `std-net`);
   - the two existing pins at `check_test.ts:448` and `:461` keep their `expected`.
8. **`check_test`, E0213:** a shared case that leaves `Dot` out reports `case Dot then`.
9. **`emit_test`:** a program over `Result<Option<Int>, Int>` with `case Ok(Some(n)) or Err(n) then n` and `case Ok(None) then 0`, and a three-pattern `std.fs.Error` case. Its examples pass; TS-checked.
10. **refs:** rename the type `old.Shape` (cases `Circle: Int`, `Square: Int`, `Dot`) to `fresh.Shape`. In another module, `case old.Circle(s) or old.Square(s) then` becomes `case fresh.Circle(s) or fresh.Square(s) then`, and `callers` still lists that module's function.

**Commit 5**
1. **`std_test`:** `std$list$set` replaces the first, a middle and the last item, and leaves the input unchanged. Index -1 and index `length` trap `["requires", "std.list.set", "0 <= index and index < std.list.length(list: list)"]`, also on `[]` at 0.
2. **`std_test` acceptance program** (the list-literals one): an example `set_second(xs: [1, 2, 3]) == [1, 9, 3]`. Raise its pinned example count (`std_test.ts:734`, 16 → 17) if it lands in that program.

**Every commit:** `card_test` passes: codes and std names exist, at most 160 lines, under 10,240 bytes.

## 5. Decisions

T continues no earlier series. **[language]** marks grammar or typing changes.

| # | Recommendation | Reason by principle | Alternative |
| --- | --- | --- | --- |
| T1 [language] | `<expression> else return <value>` is a statement: the expression is `Result<Unit, E>` or `Option<Unit>`, `error` as in a let-else; other content is E0217, no `Result`/`Option` is E0224 | 3: the let-else minus the name, as a `Unit` call is a `let` minus the name; 2.6: no dummy name to invent (five in the rounds); 1.1: left to right, no new keyword | A leading keyword (`check f() else …`); `let _: Unit`, which needs `_` |
| T2 [language] | The propagate's expression is not an `if`, `match` or `for`. An `else` on the line of an `if`'s `then` belongs to that `if` | 3.7: one-line `if c then f() else return v end if` keeps its observed meaning; no form today's E0101 and E0303 reject is reopened | Greedy `else` like `let`, which silently changes an accepted one-line `if` |
| T3 [language] | A `let` never binds `Unit` (E0235). The fix drops `let x: Unit = ` when `x` is unused and the statement is not an `else` form with an `if`, `match` or `for` value; otherwise there is no fix and the message says what to write instead. Only `let`: patterns, parameters and T11 names may still have type `Unit` | 3: one form per purpose, so T1 does not leave two; a pattern cannot avoid a `Unit` name without `_` | Allow both forms (two spellings, the card's old idiom lives on); forbid every `Unit` name |
| T4 | E0217 for a discarded `Result<Unit, E>`/`Option<Unit>` shows the statement form in `expected` | 5.5: the fix-adjacent hint must not lead into E0235 | Unchanged message |
| T5 | The codebase applies E0235's fix itself for sent definitions, like E0226, listed under `fixed`. Own commit, droppable | 3.7: pure spelling, one stored form; saves a resend (about 25% of the logstat round's output tokens) | Reject, as for any other diagnostic |
| T6 [language] | `case P or Q then`: alternatives only at the top of a case, each a whole pattern, ` or ` on one line | 3: one form (no nested alternatives); `or` already means alternation, and C# uses it for patterns; 4.2: a comma in parentheses reads as a second value; 3.3 kept, since every case is still named | `case P, Q` (Go, Java, Swift); `P \| Q` (Rust, Python); nested alternatives too |
| T7 [language] | A name is bound in a shared arm if every pattern binds it with equal types. Others are hidden: E0236 at a use, E0216 if rebound, looked up before module functions | 2.6 and 5.6: one meaning, a clear message instead of "unknown name"; without `_` every payload needs a name, so the rule that each pattern binds the same names would exclude every case with a value from groups (`std.fs.Other`) | Same names in every pattern (Rust's rule), which needs `_` |
| T8 | E0213, E0214 and E0227 work per pattern, flattened in text order; E0227's `expected` is one shared case, and its message names `or` | 3.3, 5.5: the diagnostic where a model reaches for a catch-all now names the form that keeps exhaustiveness | `expected` as several cases |
| T9 | `\|` is E0006 with a whole-line fix to ` or ` outside strings; `case A, B` is E0101 with a fix; `Err(A or B)` is E0101 without one | 5.7: the forms of Rust/Python and of Go/Java/Kotlin/Swift; a whole-line fix cannot hit another `\|` | E0001 for `\|` as today |
| T10 | A shared case is emitted as one TypeScript branch per pattern, the body repeated | Semantics stay obvious and TypeScript narrows each branch (observed to type-check); output size only | `if (a \|\| b)` with conditional binds |
| T11 [language] | `let [a, b]: List<T> = xs else return v`: exact length, names only (at least one), the list's type, `else` required, `error` is `Unit`; E0204 with the fix for `]: T =` | Every round program takes a list apart by position (1.3); 4: names in order instead of counting indices; 1.3: the type of what stands left of the colon; 1.4: the type is the value's expected type | The item type as annotation (`let [a, b]: String`, which reads as a `String` list pattern); a rest name; literal items |
| T12 [language] | No list patterns in `case` (E0101 naming T11, `first` and `drop`) | 3.3: no catch-all, so no list `match` can be exhaustive with literal items, and lengths need a rest pattern | `[a, ...rest]` patterns with length exhaustiveness |
| T13 | `std.list.set(list, index, item): List<T>`; an index outside the list traps (`requires`), stated in the doc (W1); it copies | 2.3: an index outside the list is a program error (S3), since callers `get` first; one function for the enumerate-plus-index idiom (tasks round) | `Option<List<T>>`; `update` with a function |
| T14 | Single-item extraction goes through T11; record update moves to a new roadmap row 9, `records`, pulled forward when a round rebuilds a record of four or more fields to change one; 7.1 names the workaround | Evidence: a two-field record (tasks); an expression form that touches `where`, E0205 and 2.6 | Design it now (`Task(task, done: true)` or `task with done: true`) |

## 6. Risks

- **E0235 breaks stored code.**
  - Any codebase holding `let x: Unit` rejects every submit after commit 1 until those definitions are replaced. With commit 2, resending them is enough.
  - The user's playground `~/coding_projects/alang-playground/export/tasks.alang` has two such bindings (`stored`, `written`), and its `alang.db.bak` holds ledger's two.
  - The round script uses fresh directories, so rounds are unaffected.
- **The one-line `if` rule** depends on token lines (T2). An `else` on the `then` line after a multi-line call inside a one-line `if` is an edge; test 1.2 pins the plain cases.
- **A non-canonical `if` changes reading.** In an `if` laid out as `if c then` / `f(x: 1) else return Unit` / `end if`, the `else` now reads as a propagate. That gives E0224 with the hint "put the `else` of an `if` on a line of its own", never a silent change (2.1, step 3). Add it to test 1.2 as a pin.
- **Output size of T10.** Nested shared cases multiply the copies. TypeScript only; watch for it in the round's `out/`.
- **Hidden names surprise.** A model may expect `message` in `case … or std.fs.Other(message) then`; E0236 says why it has no value. `case Ok(n) or Err(n)` with equal types works.
- **The exact length of T11** surprises a model that expects "at least", such as arguments with extra words. `lines.alang` now rejects a third argument, which fixes a silent ignore but is a behavior change.
- **The annotation habit.** A model writes `]: String =`; E0204 carries the fix.
- **`std.list.set` traps.** A program that calls it with an unchecked user index ends with exit 70; the round checks `start 9`.
- **Card budget.** 158 lines and 9,630 bytes after `std-net`: 2 lines and 610 bytes left. The next rule needs a cut.
- **Concurrent work.** `std-net` and this phase both edit `card.ts`, spec 7.1 and 7.4, `decisions.md`, `lines.alang` and `notes.md`, and `tasks-fixes` was still committing during planning. Build after both merge, and re-grep the references of section 1.
- **Messages and fixes quote canonical text.** The comma and `|` fixes quote the line as the model wrote it (lexer and parser `lineText`), so they match. E0235's fix quotes printed text, which matches canonical submissions. Notes, "From the ledger round", has the same caveat for E0005.

## 7. Playground round

**Run** after the phase is merged:

```
scripts/playground-round.sh 2026-11-DD-tickets <head of statements> ~/coding_projects/alang-rounds/prompts/tickets.md opus
```

The script builds its own work directory, worktree and MCP config under `~/coding_projects/alang-rounds/`. It runs headless without the advisor and starts from an empty codebase, with the card as the only teaching. No step needs a human. Afterwards: `git worktree remove --force ~/coding_projects/alang-rounds/2026-11-DD-tickets/wt`.

**Prompt** (save as `tickets.md`; it names none of the new forms):

> Build `tickets`, a command-line tracker for work tickets in alang, using the alang MCP tools; choose the module name yourself. It keeps its tickets in the file `tickets.txt` in the current directory, one ticket per line in the form `<state> | <owner> | <title>`: exactly three fields separated by ` | `, the owner and the title not empty. A state is `open`, `started`, `done`, `blocked: <reason>` or `dropped: <reason>`, the reason not empty. A missing file means no tickets yet. Tickets are numbered from 1 in file order. It is started as `alang db run <main> -- <command> ...`:
>
> - `add <owner> <title words...>`: appends an `open` ticket whose title is the words joined by single spaces, and prints `added <n>: <title>`.
> - `start <n>`, `finish <n>`, `block <n> <reason words...>` and `drop <n> <reason words...>` move ticket `n` to `started`, `done`, `blocked: <reason>` and `dropped: <reason>`, and print `<n>: <old state> -> <new state>`. A ticket can be started when it is open or blocked, finished only when it is started, blocked when it is open or started, and dropped unless it is done or dropped already. Any other move prints `cannot <command> <n>: it is <state>` and changes nothing.
> - `list`: prints one line per ticket, `<n>. [<state>] <title> (<owner>)`, then a last line `<a> active, <c> closed`, where open, started and blocked tickets are active and done and dropped ones are closed.
>
> Errors go to stderr with exit code 1: no command, an unknown one or the wrong number of arguments prints `usage: tickets add <owner> <title> | list | start <n> | finish <n> | block <n> <reason> | drop <n> <reason>`; an `<n>` that is not the number of a ticket prints `no ticket <n>`; an owner, title or reason containing `|` prints `no | allowed`; a line of `tickets.txt` not in the form above prints `tickets.txt line <k> is malformed` and changes nothing; any other file problem prints a one-line message. Keep the logic in pure functions with examples, and write `tickets.txt` from one function of its own that every command that changes it uses. Then run, in this order: add `ana fix the login page`, add `ben update the docs`, add `ana plan the release`, start 1, block 2 `waiting for review`, finish 1, finish 2, drop 3 `not needed`, start 2, list; then add a malformed line to the end of `tickets.txt` yourself, run list once more, and show the file. Show me every output and exit code.

**Expected results (hand-computed):**
1. `added 1: fix the login page`, `added 2: update the docs`, `added 3: plan the release`, each with exit 0.
2. `1: open -> started`; `2: open -> blocked: waiting for review`; `1: started -> done`.
3. `finish 2`: stderr `cannot finish 2: it is blocked: waiting for review`, exit 1.
4. `3: open -> dropped: not needed`; `2: blocked: waiting for review -> started`.
5. `list`: `1. [done] fix the login page (ana)`, `2. [started] update the docs (ben)`, `3. [dropped: not needed] plan the release (ana)`, `1 active, 2 closed`.
6. The file then holds `done | ana | fix the login page`, `started | ben | update the docs`, `dropped: not needed | ana | plan the release`.
7. After the malformed line: stderr `tickets.txt line 4 is malformed`, exit 1, and the file is unchanged.

**Where the forms should appear, if the card teaches them:**

| Form | Expected use | Old idiom it replaces |
| --- | --- | --- |
| T11 `let [state, owner, title]: List<String> = std.string.split(text: line, separator: " \| ") else return …` | Parsing a line | Length check plus three `get`s |
| T11 `let [command, number]: List<String> = args else …` | `start` and `finish` | `std.list.get` at 1, or `join(parts: rest, separator: "")` |
| T6 `case Open or Blocked(reason) then` | The four move rules | Five arms per rule, or `==` chains |
| T6 `case Done or Dropped(reason) then` | The active/closed count | Five arms |
| T1 `std.fs.write_text(...) else return Err(...)` | Inside the save function | `let written: Unit = …` |
| T1 `save(...) else return Err(...)` | In `main` | `let saved: Unit = …` |
| T13 `std.list.set(list: tickets, index: n - 1, item: …)` | A move | `enumerate` plus an index test |

**Checks for the analysis.** A fresh Opus agent, read-only, works like the tasks round's step 1. It lists every tool call, builds an independent Python reference, reruns only in a scratch copy, and ranks findings "fix now" or "later" with the files to touch.
1. **Teaching by the card:**
   - count each new form in the accepted program;
   - count each old idiom: `let <x>: Unit =`, `std.list.get` after a length check, `std.string.join(parts: rest, separator: "")`, `std.list.enumerate` with an index test, arms with identical bodies;
   - check that `card` was called first.
2. **Diagnostics per submit**, with codes, and whether each `fix` or `expected` led to the right form:
   - E0235 (and `fixed` entries carrying it, if commit 2 shipped), E0236, E0227 (did its one-line `or` `expected` lead to a shared case?), E0214;
   - E0006 for `|`; E0101 for `,`, nested `or`, `case [` and `let [...]`; E0204 for `]: String =`; E0224; E0217.
3. **Discovery of `std.list.set`.** Log every `search` and `search_type` call. Expected hits:
   - "set", "replace" and "update" → `std.list.set` (and `std.string.replace` for "replace");
   - `List<_>, Int, _ -> List<_>` → `std.list.set` only. To verify with `alang db search_type` after commit 5: by the type-variable rule `std.list.fold` should not match, since its `A` is bound to `Int` and then fails against `List<_>`.
4. **Correctness against the reference**, on Deno and in a scratch copy:
   - files: an empty file, a missing final newline, CRLF, a line with 2 or 4 fields, an empty owner or title, `blocked: ` with an empty reason, `blocked:x`, a malformed line in the middle;
   - numbers: `start 0`, `start 01`, `start -1`, `start 2x`, `start 9`;
   - arguments: `add ana` (no title), `block 1` (no reason), `list extra`, a `|` in a title, no command, an unknown command;
   - every refused move, from each of the five states;
   - the file is unchanged after every error, and no run traps (exit 70).

   Lenient on `01`: `std.int.parse` reads it as 1, and the prompt leaves it open.
5. **Effort:** tool calls by kind, time, output tokens, std `context` calls, and whether the first submit is accepted.
6. **Generated TypeScript:** the size of `out/` for the shared cases (T10), against a rough count of what the arms would have cost one by one.

### Critical Files for Implementation
- /home/josua/coding_projects/alang/src/check.ts
- /home/josua/coding_projects/alang/src/parser.ts
- /home/josua/coding_projects/alang/src/emit.ts
- /home/josua/coding_projects/alang/src/ast.ts, /home/josua/coding_projects/alang/src/printer.ts, /home/josua/coding_projects/alang/src/refs.ts, /home/josua/coding_projects/alang/src/lexer.ts
- /home/josua/coding_projects/alang/src/codebase.ts (commit 2), /home/josua/coding_projects/alang/src/std.ts and /home/josua/coding_projects/alang/src/runtime.ts (commit 5)
- /home/josua/coding_projects/alang/alang-specs.md (sections 3, 4.6, 7.1, 7.4, 7.8, 7.10, 7.11), with /home/josua/coding_projects/alang/src/card.ts and /home/josua/coding_projects/alang/docs/decisions.md
- /home/josua/coding_projects/alang/tests/check_test.ts, /home/josua/coding_projects/alang/tests/syntax_test.ts, /home/josua/coding_projects/alang/tests/emit_test.ts, /home/josua/coding_projects/alang/tests/spec_test.ts

## Addendum (main session, 2026-11-14, after the automated `tasks` round)

- **T15 `std.list.find_index`.** Add it in commit 5 next to `std.list.set`: the position (from 0) of the first item
  for which the function gives `true`, or `None`. Mirror `std.list.find`'s parameter names and doc style, and state the
  counting base in the doc line (W1). Evidence: both `tasks` rounds (manual and automated) built the same helper plus
  an identity `filter_map` to find the first malformed line. Record it with T13 in `docs/decisions.md`.
- **The round harness changed** after this plan was written: `scripts/playground-round.sh` now passes the round's
  `CLAUDE.md` through `--append-system-prompt` (under `--restricted` it was ignored) and names the allowed shell
  commands there (`alang`, `cat`, `ls`, `printf`, `echo`, `mkdir`, `cd`; joined with `;`; no `rm`, no shell
  functions). Check `instructions=sent` in the round's `done.txt`. Exit codes show with `alang db run ...; echo $?`
  (observed in the automated `tasks` round).
