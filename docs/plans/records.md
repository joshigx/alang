# Plan: roadmap row 9, `records`

The planner wrote this on 2026-11-14. It read the repository at `47634f6`, where `main`, `statements` and `fn-types` all
point. That commit is `f0d9ecb` plus one notes commit. The worktree `overnight` meanwhile held an uncommitted `fn-types`
build, so every file:line below is at `47634f6`, read from a snapshot (`git archive 47634f6`, extracted to
`/home/josua/.claude/jobs/7e0015cb/tmp/records-probes/snapshot/`). The only file written outside the scratch directory
is this plan. Probes are in `/home/josua/.claude/jobs/7e0015cb/tmp/records-probes/`.

- **Observed:** facts from `alang check` and `alang run` of probe files against the snapshot, `deno check` and
  `deno run` of hand-written TypeScript in the emitter's shape (Deno 2.8.0), a script that walks the parsed round
  programs (`count.ts`), and R7 applied to a second copy of the snapshot with its test suite run (4.1).
- **To verify:** facts that were not observed.

The main session takes every recommendation, and nobody is asked. **[language]** marks a decision that changes the
language; those are listed for the user's later review. Codes: **E0270 and E0271 are reserved** for the deferred form
(2.2). E0272 to E0279 stay free for the planner who builds it. R7 needs no code.

**Verdict.**
- **Do not build the record update now.** Row 9 stays where it is, after `extern-fn`.
- **Build one small, separate, cuttable commit (R7):** records carry their type's name at runtime. It fixes an observed
  misprint of `std.text.show` and closes the open question about how records show.
- **Count record copies in every round's analysis (R8).** Also run one evidence round, `fleet` (section 7), before row
  9's turn comes. Then decide the row by the trigger (section 3).

## 0. Scope

| Item | Where | Why |
| --- | --- | --- |
| Record update, a copy of a record with some fields changed | **Not now** (R1). The form for later is in 2.2 (R2–R4); the trigger is in section 3 (R5) | Three copies in five automated rounds, of records with 2 and 3 fields, all accepted without a diagnostic (1.3). The T14 trigger (four or more fields) could not fire: no round program defined such a record, and neither will the queued rounds |
| `std.text.show` of records: the type name, and the misprint of a record with a `String` field `tag` | **Now** (R7), one commit, outside the row's verdict, cuttable | Observed bug: `Label(tag: "a", value: 1)` shows `a(1)` (1.2). No round showed a record, so only the bug justifies building it now. The name comes free with the fix |
| Counting record copies in round analyses | **Now** (R8), no code | The trigger needs data that analyses do not collect today |
| Evidence round `fleet` on today's language | **Before row 9's turn**, any free slot (R6) | It is the only way to see whether copies cost anything, and which update form a model reaches for |
| Dedicated diagnostics (5.7) for `{...x, f: v}`, `T(...x, f: v)`, `x with f: v`, `x.copy(f: v)` | **Not now** (R9) | No round wrote one (1.3); they belong with the form |
| E0205's wording for records ("argument ... at the call") | **Not now** (R9) | No round met E0205 |

## 1. Findings

### 1.1 How records work today (at `47634f6`)

- **Syntax.** `construct` holds a path and a `Payload`: `null`, named `args`, or one unnamed `value` (`src/ast.ts:44`,
  `:81-84`).
  - `pathExpr()` (`src/parser.ts:637-653`) builds a construction as soon as it reads a type name.
  - `payload()` (`:762-773`) reads named arguments if `(` is followed by `name :`, and otherwise one value.
  - The printer writes `pathText(path) + printPayload(...)` (`src/printer.ts:220-221`).
- **Checking.** `construct()` (`src/check.ts:1156-1229`):
  - for a record, a payload that is not named arguments is E0223;
  - otherwise `matchArgs()` (`:941-995`) treats the fields as parameters: E0207 for an unknown field (fixed to the
    closest free field), E0206 for one given twice, E0205 for a missing one, E0208 for the order;
  - each field value is then checked against its field's type.
  - E0205's message speaks of calls even for a record: "Missing argument `text`; every argument appears at the call,
    there are no default values (2.6)." (`:976-985`).
  - `field()` (`:918-936`) gives E0212 for an unknown field read.
- **TypeScript.** `type()` (`src/emit.ts:226-262`) emits a type alias and a checking constructor,
  `export function m$Task($fields: m$Task): m$Task`.
  - With a `where`, it destructures the fields and traps (`trap("where", ...)`). It then returns `$fields` unchanged
    (`:260`).
  - A construction is `m$Task({ text: …, done: … })` (`:521-541`), so the `where` is checked at every construction
    (spec section 5, "At every construction").
- **Values at runtime.** A record is a plain object of its fields, and a case is `{ tag, value? }`.
  - `eq` (`src/runtime.ts:208-227`) compares `Object.keys`.
  - `std$text$show` (`:2017-2035`) tells the two apart by a `string` property `tag`. So a record with a `String` field
    `tag` is shown as a case (1.2).
  - Actual values of examples are printed from the static type instead (`src/examples.ts:183-193`), so they show
    `Port(value: 8080)` (decisions, Actual values).
- **std records.** `std$http$Header`, `std$http$Request`, `std$http$Response` (with its `where`) and `std$string$Cut`
  have constructors (`runtime.ts:771-774`, `:776-785`, `:787-807`, `:1628-1631`).
  - The runtime also builds such records itself, as object literals: the `Request` and its `Header`s in `serve` on
    Deno (`:904-910`) and on Node.js (`:970-978`), the `Response` and its `Header`s in `send` (`:1338-1344`), and the
    `Cut` in `std$string$cut` (`:1652`).
- **References and rename.** `rebuild()` (`src/refs.ts:95-229`) spells a construction's type through
  `info.constructs` (`:177-186`). It copies field names as plain strings (`payload`, `:120-124`), so a field is no
  reference.
  - There is no rename operation for a field.
  - A field changes by `replace` of its type, which is an interface change (decisions, Interface rule: "for a type its
    shape (record or variant, fields, cases with payloads, in order) and `where`"). So callers outside the transaction
    are E0506.
  - Every construction that names the old field is E0207, with the closest field as its fix; a read `x.old` is E0212.
- **Tests that pin record behaviour:**
  - `tests/check_test.ts:207`, `:213`, `:216-218` (E0205–E0208, E0207 on `Point(x: 1, z: 2)`);
  - `:274-278` (E0223);
  - `tests/http_test.ts:826-848` (`NET_STDOUT`: six `std.text.show` lines of `send` results, records shown as
    `Ok((status: 200, headers: [(name: …, value: …)], …))`);
  - `tests/std_test.ts:224` (an actual `Cut`, printed from its type, unaffected).
- **Spec.**
  - 7.1 (`alang-specs.md:488`) names the workaround: "Copying a record with one field changed | Construct it again with
    every field named: `Task(text: task.text, done: true)`".
  - 7.7 (`:561`) says a record shows "`(x: 1, y: -2)` … without its type name".
  - 2.6's table (`:131`): "Default values for parameters | Every argument appears at the call".
  - 3.3 (`:177`): "There is no catch-all case, so that a new variant reports every affected place as an error."

### 1.2 Probes (observed against the snapshot)

**What a model's update habits get today.** Each probe returns the form from `m.finish(task: Task): Task`, where
`Task` is `text: String, done: Bool` with `where: text != ""` (`records-probes/forms/`):

| Written | Diagnostic |
| --- | --- |
| `Task(text: task.text, done: true)` | none (accepted) |
| `Task(...task, done: true)` (JS order) | E0101 "Expected an expression, found `.`." |
| `Task(..task, done: true)` | E0101 "Expected an expression, found `.`." |
| `Task(done: true, ..task)` (Rust) | E0107 "Every argument carries its parameter name: `name: value`." |
| `{...task, done: true}` (JS) | E0006, the braces message, which names blocks and the map literal |
| `task with done: true` (C#) | E0101 "Expected a line break, found `with`." |
| `task with (done: true)` | the same |
| `task.copy(done: true)` (Kotlin) | E0220, the method-call message |
| `Task(task, done: true)` (Python's `replace`) | E0101 "Expected `)`, found `,`." |
| `Task(done: true)` | E0205 "Missing argument `text`; …", `expected` `text: String`, no fix |

None of these points to the 7.1 workaround.

**`std.text.show` misprints a record with a `String` field `tag`** (`records-probes/show/show.alang`, run with
`alang run`). With `type m.Label` (`tag: String`, `value: Int`) and `type m.Only` (`tag: String`):

| Value | Shown today | 7.7 says |
| --- | --- | --- |
| `Label(tag: "a", value: 1)` | `a(1)` | `(tag: "a", value: 1)` |
| `Only(tag: "b")` | `b` | `(tag: "b")` |
| `[Some(Only(tag: "c"))]` | `[Some(c)]` | `[Some((tag: "c"))]` |

**Strings differ too, but not as part of this row.** `std.text.show(value: "a\u{1B}é")` gives `"a\u001bé"` (JSON),
while an actual value prints `"a\u{1B}é"`.

**TypeScript of an update (`records-probes/ts/update.ts`, `deno check` and `deno run`).**
- `m$Task({ ...task, done: true })` through the checking constructor type-checks.
- It keeps the field order (`text,done,tag`) and is `eq` to the full construction.
- It traps on the `where` when an update breaks it (`{ ...t, text: "" }`).
- `m$Pair<number, string>({ ...pair, right: "b" })` works for a generic record, and TypeScript rejects a wrong field
  type in both forms (two `@ts-expect-error` lines hold).
- A `WeakMap` from record object to short type name, filled by the constructor, makes `show` print
  `Task(text: "a", done: true, tag: "x")` and `Some(Task(…))` correctly. It leaves `Object.keys` and `eq` untouched.

### 1.3 Evidence from the rounds

`count.ts` walks the parsed exports with the snapshot's parser. What it counts:
- constructions with named fields of a record type defined in the same file, plus `std.http.Response`, split into
  bodies and examples;
- a **copy**: a construction in which some field `f` is given as `x.f`, read directly from one plain name `x`. It does
  not resolve types, so a copy between two record types (a conversion) is counted too; the table separates them by
  hand.
- a **swap?**: a field given as `x.g` from a source `x` of a copy. None was found.

| Round (automated, headless Opus) | Record types (fields) | Constructions: bodies / examples | Copies of the own type | Conversions |
| --- | --- | --- | --- | --- |
| `2026-11-14-tasks-auto` | `Outcome` 2, `Task` 2 | 9 / 39 | 1: `run_done`, `Task(text: task.text, done: true)`, 1 field copied, 1 given | 0 |
| `2026-11-14-std-net` (two modules) | `Config` 3 | 2 / 7 | 0 | 0 |
| `2026-11-14-std-net-2` (two modules) | `Config` 3 | 2 / 7 | 0 | 0 |
| `2026-11-14-tickets` | `Move` 2, `Outcome` 3, `Ticket` 3 (`where: owner != "" and title != ""`) | 9 / 34 | 1: `move_ticket`, `Ticket(state: state, owner: ticket.owner, title: ticket.title)`, 2 copied, 1 given | 0 |
| `2026-11-14-tickets-2` | `MoveRequest` 2, `NewTicket` 2, `Outcome` 3, `Ticket` 3 (same `where`) | 11 / 39 | 1: `apply_move`, the same line, 2 copied, 1 given | 1: `add_ticket`, `Ticket(state: Open, owner: new.owner, title: new.title)` from a `NewTicket` |
| **Total** | largest record: **3 fields** | **33 / 126** | **3** | 1 |

- **Cost: none seen.** `tasks-auto` and `tickets-2` were accepted on the first submit without a diagnostic. `tickets`'
  one rejected submit was E0217/E0204 from a propagation statement, not a record. No round analysis mentions records.
- **Not counted:** the manual rounds' programs, which live in the user's playground and were not read. They are
  `ledger`, `wordcount`, `logstat` and the manual `tasks`. The notes ("From the tasks round") say only that the manual
  `tasks` updated its 2-field `Task` inside `std.list.enumerate`.
- **`std.text.show` in the rounds:** 29 calls, every one on an `Int` (`count`, `index + 1`, `number`, `port`,
  `response.status`, lengths). No round showed a record.
- **The T14 trigger was untestable.** "A round rebuilds a record of four or more fields to change one" needs such a
  record, and no round program defined one.
  - The queued rounds will not either: `rank` (`Sale`, 3 fields), `shop` (`Product` 3, `Order` 3, `Column` 3; from the
    two references in `~/coding_projects/alang-rounds/prompts/`) and `parcel` (tables, no records needed) read data and
    never change a record.
  - So without section 7 the row has no exit.

## 2. Verdict, and the form for later

### 2.1 Why not now (R1)

- **Benefit seen so far:** three copies of one or two fields.
  - `Ticket(...ticket, state: state)` would save 31 of 62 characters, once in each `tickets` round;
    `Task(...task, done: true)` would save 8 of 33.
  - No diagnostic, rejected submit or wrong value came from a copy.
- **Price:**
  - a new expression form through parser, printer, checker, emitter and `refs.ts`;
  - a card line, on a card at its cap (about 159 lines and 9.86 KB after `fn-types`, `const` and `generics`; the test
    allows 160 lines and 10,240 bytes);
  - a second way to build a record from a record (principle 3);
  - and the loss of one check (next item).
- **What the form gives up.** Today a field added to a record makes every construction of it E0205, rebuilds included.
  So the model revisits each copy site, as 3.3's missing catch-all makes a new variant report "every affected place".
  - An update copies the new field silently. That is right for most updates, but wrong where the new field should change
    with the others, such as an `updated` time or a version.
  - It is the record analogue of a catch-all. It is worth its price only where copies are wide and frequent, and the
    evidence shows neither yet.
- **2.6 itself is not in the way.** The fields an update does not name come from a value written at the site, not from
  defaults declared elsewhere, so nothing acts at a distance.

### 2.2 The form to build when the trigger fires (R2–R4)

Only the decisions; file:line, card text and spec texts are left to the planner who builds it, since `fn-types`,
`const`, `generics` and `extern-fn` rewrite `construct()`, `TypeRef`, the record constructor and the card first.

**Form [language]: `Ticket(...ticket, state: Started)`.** It is the construction with an optional source: the type,
then `...` and the record to copy, then the fields that change.
- **Grammar:** `construct = TypePath [ "(" ( "..." expr { "," arg } | arg { "," arg } | expr ) ")" ]`, with `...` a
  new symbol. The form without fields parses, so that the checker can give E0270 with its fix.

Candidates, decided by mechanics first:

| Candidate | Verdict |
| --- | --- |
| `Ticket(...ticket, state: s)` | **Chosen.** One construction form with an optional source, so the type is written first, as at every other construction (spec 1.3, type before value; 4.1). Left to right (1.1): the writer decides "copy" at the first token after `(`, and from there the permitted tokens are the type's fields (1.6). The source comes first, as in JS/TS `{...ticket, state: s}`, the habit of the target language, and as in Python's `{**d, "k": v}`. Inside parentheses, so it is never ambiguous |
| `ticket with state: s` | **Rejected: ambiguous.** In an argument list, `f(a: t with x: 1, b: 2)` cannot tell whether `b: 2` is a second field or the next argument without types, against 1.6. `with` is also a parameter name of 15 std functions (`std.list.map`, `filter`, `fold`, `zip`, `enumerate`, `any`, `all`, `find`, `find_index`, `filter_map`, `take_while`, `drop_while`, `std.map.to_list`, `std.option.map`, `std.string.replace`), and a keyword would break those published signatures (3.8) |
| `ticket with (state: s)` | Second choice. Unambiguous, and `with` stays a name, since a name never follows an expression. But it is a new postfix operator beside the construction, and it hides the type, which a reader of a contract then looks up. The evidence round decides between the two if a model writes `with` unprompted |
| `Ticket(ticket, state: s)` | Rejected: an unnamed value inside a record's parentheses reads as a case's value (4.2), and 4.1 names every argument |
| `Ticket(state: s, ..ticket)` (Rust) | Rejected: the source comes after the fields it completes. It gets a dedicated E0101 with a fix that moves it first as `...ticket` |
| `Ticket(from: ticket, state: s)` | Rejected: `from` would collide with a field named `from`, which is legal today |

**Rules [language].**
- **The source.** Exactly one, written first, any expression but `if`, `match` or `for` (E0303 as for other operands).
  - It is checked with the record's type as its expected type. A source of another type is E0204 ("Expected `Task`,
    found `Ticket`"): a conversion between two types names every field.
  - A source on a variant type or on a case (`Some(...x)`) is E0223.
  - Two sources, or a source after a field, are E0101.
- **The fields given.** Named, in declaration order, each once, each known: E0206, E0207 (closest-field fix) and E0208
  as today. E0205 does not apply.
- **E0270 [language]: an update that gives no field**, `Task(...task)`. Message: "`Task(...task)` changes no field;
  write `task`." Fix: the source alone.
- **E0271 [language]: an update that gives every field.** Message: "Every field of `Task` is given, so nothing is
  copied from `task`; build it without `...task`." Fix: the construction without `...task, `. At the overlap, the two
  forms collapse into one (3).
- **The full construction stays legal** after the form exists (R4), on the precedent of L6 (the append chain beside list
  literals): rule 3 concerns forms of the grammar.
  - A full construction that copies fields is still the one form for "build a record from values". It keeps E0205's
    report at every site when a field is added, which is sometimes the point.
  - Banning it would need a heuristic: copied fields from a local of the same type, which also misfires on
    coincidences.
  - T3 (`let x: Unit`, forbidden and fixed by the codebase) is the other precedent. It does not apply: that form had no
    property of its own.
  - The card teaches the update for copies, and 7.1's row goes.
- **`where`.** The update is a construction, so the constructor checks the invariant at runtime (5, 5.3), as the TS
  probe shows. A static proof (5.2) is out of scope as everywhere.
- **Generics (after `generics` commit 5).** The result has the source's type, `Pair<Int, String>`. The given fields are
  checked against the field types under the source's type arguments, so an update never changes a type argument. Type
  arguments written on it are E0209, as on any record (generics G7).
- **Evaluation and TypeScript.** The source is evaluated first, then the given fields from left to right:
  `m$Task({ ...task, done: true })`, through the checking constructor (observed: type-checks, keeps field order, traps
  on the `where`).
- **Printing.** `Task(...task, done: true)` on one line, `...` written directly before the source.
- **References and rename.** `rebuild()` rebuilds the source like any expression. A field renamed by `replace` makes
  only the updates that name it E0207, and the updates that do not name it stay valid. An added field makes no update
  site an error (2.1).
- **Foreign forms (5.7), with the build:**
  - `{...x, f: v}` gets a sentence in the braces message;
  - `..x` gets the `...` fix;
  - `x with f: v` gets an E0101 naming the form.

### 2.3 What the later build touches (by function name)

- **Code:**
  - `ast.ts` (`construct` gains `source: Expr | null`, or a payload kind `update`);
  - `lexer.ts` (`...`);
  - `parser.ts` (`payload()`);
  - `printer.ts`;
  - `check.ts` (`construct()`, `matchArgs()` without E0205 for an update);
  - `emit.ts` (the construct case);
  - `refs.ts` (`rebuild()`'s construct case).
  - `examples.ts`, `interface.ts` and `search.ts` need nothing: values, signatures and types do not change.
- **Spec:** the grammar's `construct` line, the section 3 table (a row "Copy a record with some fields changed"), 4.1,
  7.1 (remove the copy row), 7.5 (a sentence), 7.11 (E0270, E0271).
- **Card.** One sentence beside `Item(name: "x", count: 1)` in the Expressions bullet. The build must name what it cuts
  so that the card's net growth is at most 0 bytes.
- **`decisions.md`:** a Syntax row and a Type checking row.

## 3. The trigger (R5)

Build row 9 when any of these is observed. Look at it in every round's analysis (R8) and in the evidence round
(section 7).

1. **Natural width.** In a round whose task was not written to test records, a construction copies three or more fields
   from a value of its own type. That is a record of four or more fields with at most two changed: T14's trigger, stated
   in what an analysis can count.
2. **Cost.** In any round, a copy costs something:
   - a rejected submit caused by a diagnostic at a construction that copies (E0204, E0205, E0206, E0207, E0208);
   - or a wrong value from a copy, such as a field read into another field (`swap?` in `count.ts`, or a mismatch with
     the reference).
3. **Habit.** In any round, a model writes an update form unprompted, in any submit, accepted or not: `...x` or `..x`
   in a construction, `{...x}`, `x with`, `x.copy(`, `Type(x, …)`. The form it wrote is evidence for the spelling (2.2).

The evidence round counts only for 2 and 3, since its task makes wide copies by design. Until the trigger fires, the 7.1
row stays the answer.

## 4. R7: records carry their type's name at runtime (build now) [language]

One commit, **"Show a record with its type name"**. It goes on its own branch from `main` after the phase in progress
merges, or into the next fixes branch, and is cuttable: if it is dropped, record the misprint (1.2) in the notes instead. It does not
touch the card (the card does not say how records show): **net card growth 0 bytes**.

### 4.1 Design

- **`src/runtime.ts`, new, before the std records:**

  ```ts
  // The type name of every record its constructor built, without the module
  // (as a case shows), for std.text.show (3.9). Kept beside the object, so the
  // object, its fields, `eq` and spreading are untouched. Every record the
  // runtime builds itself goes through `record` too.
  const RECORD_NAMES = new WeakMap<object, string>();
  export function record<T extends object>(name: string, fields: T): T {
    RECORD_NAMES.set(fields, name);
    return fields;
  }
  ```

- **std constructors:**
  - `std$http$Header`, `std$http$Request` and `std$string$Cut` end with `return record("Header", $fields);`,
    `return record("Request", $fields);` and `return record("Cut", $fields);`;
  - `std$http$Response` ends, after its `where` check, with `return record("Response", $fields);`.
- **Records the runtime builds without a constructor** (re-grep `received = {`, `({ name, value })` and
  `{ before:`). Each object literal is wrapped in `record(…)`. The `where` of `Response` already holds there: `send`
  answers a status outside 200 to 599 with `Failed`, and gives `""` as content for 204, 205 and 304.
  - `serve` on Deno: the `Request` and each `Header` in its `headers` map;
  - `serve` on Node.js: the same;
  - `send`: each `Header` in `received` and the `Response` in `Ok(…)`;
  - `std$string$cut`: the `Cut`.
- **`std$text$show`**, the object branch, with the record test before the case test:

  ```ts
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const fields = () => Object.entries(obj).map(([k, v]) => `${k}: ${std$text$show(v)}`).join(", ");
    const name = RECORD_NAMES.get(obj);
    if (name !== undefined) return `${name}(${fields()})`;
    if (typeof obj.tag === "string") return "value" in obj ? `${obj.tag}(${std$text$show(obj.value)})` : obj.tag;
    // Only a record no constructor built, such as one an extern fn returns.
    return `(${fields()})`;
  }
  ```

  The comment above it becomes: "Text representation (rule 3.9). A record shows as its construction, with the short
  type name its constructor registered; a case as its tag and value."
- **`src/emit.ts`, `type()`:** the record constructor's last line becomes
  `return ${RT}.record(${JSON.stringify(def.path[def.path.length - 1])}, $fields);` instead of `return $fields;`.
- **With `generics` commit 5**, whichever lands second adapts the same line inside the generic constructor
  `m$Pair<A, B>($fields: m$Pair<A, B>)`. The name carries no type arguments (`Pair(left: 1, right: "a")`), as a case
  shows `Some(3)`.
- **With the other planned phases:**
  - **`const`:** nothing changes. Its plan (C13) emits a constant as a `$rt.constant` getter that evaluates the
    construction, so the constructor registers the value (to verify when both are built).
  - **`fn-types`:** nothing changes. F11 lets records hold function values, and such records have no `show` (E0222).
  - **`generics`:** G9 makes `with: std.text.show` legal, passing `$rt.std$text$show` itself as a value. A registry
    serves that unchanged, while a type descriptor per `show` call would need a wrapper there: one more reason for the
    registry.
- **The short name, not the full one.** `show` has no module to write from, and cases already show without their module
  (7.7). Actual values keep the module outside it (`net.port.Port(value: 80)`), since they are pasted into examples.
- **`WeakMap`, not a property on the object.** Nothing about the value changes: keys, spreading (a later update
  re-registers through the constructor) and `eq`.
  - It needs one runtime module instance, and today's loading gives that. Generated code imports the runtime by a
    path relative to `RUNTIME_PATH` (`src/toolchain.ts:17`, `:42-45`), the same file `examples.ts` imports.
  - Only the H5 fallback of actual values calls `show` from `examples.ts`, and it never meets a record that has a name.
    Before `fn-types` no record can hold a function, and after it no function returns one (F4).
  - The alternative is a non-enumerable `Symbol.for("alang.record")` property, which works across module instances.

**Checked in scratch (observed).** R7 was applied as written to a copy of the snapshot
(`records-probes/snapshot-r7/`): `record`, the four constructors, seven object literals at the four places the runtime
builds records, `show` and the emitter line.
- `show.alang` then prints `Label(tag: "a", value: 1)`, `Only(tag: "b")` and `[Some(Only(tag: "c"))]`.
- `deno task test`: 338 passed and 2 failed, both "send: one client program gives the same outcomes on every host"
  (Deno and Node.js), which is the `NET_STDOUT` pin.
- With the pin changed as in 4.3, `tests/http_test.ts` passes on both hosts (26 passed).
- `deno check`, `deno lint` and `deno fmt --check` are clean on the changed files.

### 4.2 Exact texts

**Spec 7.7, "Values as text".** Replace "…and `[:]` for the empty map, and `(x: 1, y: -2)` for a record, without its
type name. A case shows without its module: `PermissionDenied`, `Other("disk full")`. …" with:

> …and `[:]` for the empty map, and `Point(x: 1, y: -2)` for a record. A record or a case shows without its module:
> `Port(value: 8080)`, `PermissionDenied`, `Other("disk full")`. …

The rest of the bullet stays.

**`decisions.md`, Semantics and runtime, "Representation in TS".** Replace "records → plain readonly objects with a
checking constructor," with:

> records → plain readonly objects with a checking constructor, which registers the object with its type's short name
> in a `WeakMap` of the runtime (`$rt.record`) for `std.text.show`, leaving the object, its fields and `==` untouched
> (the runtime registers the std records it builds itself),

**`decisions.md`, a new row in Semantics and runtime:**

> | Records in `show` | **(2026-11-14, R7 of `docs/plans/records.md`.)** `std.text.show` gives a record as its
> construction with its type's short name, `Port(value: 8080)`, as it gives a case without its module (`Other("x")`);
> nested std records too: `Ok(Response(status: 200, headers: [Header(name: "a", value: "b")], content: ""))`. So every
> value `show` gives reads as alang, and records show as actual values print them, less the module. Before, records
> carried no name at runtime: they showed as `(value: 8080)`, and a record with a `String` field `tag` was taken for a
> case (`Label(tag: "a", value: 1)` showed `a(1)`). Alternatives: a marker without the name, keeping `(value: 8080)`; a
> type descriptor passed by the emitter at every `show` call, so that `show` and actual values share one printer
> (module names and alang string escapes too), which is larger and needs a wrapper wherever `std.text.show` is passed
> by name (generics G9). | 3, 3.9 |

**`decisions.md`, Open questions:** remove the bullet "**`std.text.show` of records.** …".

**`notes.md`:**
- "Ideas", the bullet "**Records at runtime**": append " Done (R7 of `docs/plans/records.md`): the constructor
  registers the short type name in a `WeakMap`, so equality is untouched."
- "From mandatory examples", the bullet "**`std.text.show` and the tool now disagree.**": append

  > Records agree since R7 (the tool adds the module outside it). Strings still differ:
  > `std.text.show(value: "a\u{1B}é")` gives `"a\u001bé"` (JSON), an actual value `"a\u{1B}é"` (observed 2026-11-14).
- "Current state": the item, and R7 in the review list as a std output change.

### 4.3 Tests (with the commit)

1. **The misprint** (`emit_test` `PROGRAMS`, or a run test). Module `m` with `Label` (`tag: String`, `value: Int`) and
   `Only` (`tag: String`) prints, one line each:
   - `Label(tag: "a", value: 1)` (today `a(1)`);
   - `Only(tag: "b")` (today `b`);
   - `[Some(Only(tag: "c"))]` (today `[Some(c)]`).

   An example of an identity function, `keep(label: Label(tag: "a", value: 1)) == Label(tag: "a", value: 1)`, still
   holds, so equality is unchanged.
2. **Another module's record shows short.** `geo.Point(x: 1, y: -2)` shown from module `app` gives
   `Point(x: 1, y: -2)`.
3. **One test per std record type**, since a missed runtime site falls back silently to the old form:
   - `Cut`: `std.text.show(value: std.string.cut(text: "a=b=c", separator: "="))` gives
     `Some(Cut(before: "a", after: "b=c"))`.
   - `Header` and `Response` built in alang: `std.http.Header(name: "a", value: "b")` gives
     `Header(name: "a", value: "b")`, and
     `std.http.Response(status: 204, headers: std.list.empty<std.http.Header>(), content: "")` gives
     `Response(status: 204, headers: [], content: "")`.
   - `Response` and `Header` from `send`: in `tests/http_test.ts` `NET_STDOUT`, each `Ok((status:` becomes
     `Ok(Response(status:` and each `(name: ` becomes `Header(name: `, in the six `Ok` lines. The first becomes
     `'Ok(Response(status: 200, headers: [Header(name: "connection", value: "close"), Header(name: "content-length", value: "5"), Header(name: "set-cookie", value: "a=1"), Header(name: "set-cookie", value: "b=2"), Header(name: "x-a", value: "2, 3"), Header(name: "x-b", value: "1")], content: "hello"))'`.
     Split the longer strings with `+`, as the existing ones are split; both hosts stay byte-identical.
   - `Request` and `Header` from `serve`: a handler that answers `std.text.show(value: request)` for
     `GET /x?a=1`. On Deno and on Node.js, the content starts with
     `Request(method: "GET", path: "/x", query: "a=1", headers: [Header(name: `. The rest depends on the client's
     headers.
4. **Runtime unit (`std_test`):** `rt.std$text$show({ tag: "Some", value: 1 })` is still `Some(1)`, and
   `rt.std$text$show(rt.std$string$Cut({ before: "a", after: "b" }))` is `Cut(before: "a", after: "b")`.
5. **Unchanged:** every E0402 actual value (printed from types) and every `show` of a non-record.

Checks: `deno task test`, `deno lint`, `deno fmt --check`. The card test passes unchanged.

## 5. Decisions

R continues no earlier series. **[language]** marks grammar, typing or built-in behaviour changes.

| # | Recommendation | Reason by principle | Alternative |
| --- | --- | --- | --- |
| R1 | Do not build the record update now; row 9 stays after `extern-fn` | Three copies of 1–2 fields in five rounds, no cost seen (1.3); a new form costs card bytes at the cap and one form per purpose (3), and gives up E0205's report at every copy site (2.1) | Build it now as designed in 2.2 |
| R2 [language], for later | `Type(...source, field: value)`: the construction with an optional source, first | 1.1 and 1.6: the type and then the copy decided at the first token, the fields known from there; one construction form (3, 4.1); the JS/TS order and token (5.7, target-language habit); never ambiguous inside parentheses | `source with (field: value)`; `source with field: value` (ambiguous in argument lists, `with` is a std parameter name); Rust's `..source` last |
| R3 [language], for later | The source has the record's type (E0204); fields given by name, in order, once (E0206–E0208); none given is E0270 (fix: the source), all given is E0271 (fix: drop the source); the constructor re-checks `where`; a generic update keeps the source's type | 4.1; 3 at the overlap of both forms; 5 and 5.3, every construction checks the invariant; 1.4, types flow from the source | Allow `Type(...x)` and full updates; type-changing updates of generic records (Haskell) |
| R4 [language], for later | The full construction stays legal beside the update; the card teaches the update for copies, and 7.1's copy row goes | L6 precedent: rule 3 concerns grammar forms. The full form keeps E0205's report at every site when a field is added (the 3.3 analogue), which is sometimes wanted; a ban needs a heuristic | T3-style: an error with a codebase fix for a full construction that copies from a local of its type |
| R5 | The trigger: a copy of three or more fields in a round not written for records, a rejected submit or wrong value caused by a copy, or an update form written unprompted | Observable in a transcript and an export; T14's trigger restated so that it can fire | T14's wording as it stands, which no queued round can meet |
| R6 | Run the evidence round `fleet` (section 7) on today's language before row 9's turn; it counts only for the cost and habit parts of the trigger | 5: measure the cost of a workaround before adding a form; the only way to see which form a model reaches for | Wait for natural evidence (none is queued) |
| R7 [language] | Records carry their type's short name at runtime (`WeakMap` filled by the constructor, and by the runtime for the std records it builds); `std.text.show` prints `Port(value: 8080)`. One commit now, cuttable | 3.9: `show` follows the type's structure, and a `String` field `tag` made a record show as a case (observed); 3: `show` then reads as alang and agrees with actual values on records | A marker only, keeping `(value: 8080)`; a type descriptor per `show` call (one printer for `show` and actual values, larger, and a wrapper for `show` passed by name after G9) |
| R8 | Every round's analysis counts record constructions, copies, their field counts and swaps with `count.ts` (copy it to `~/coding_projects/alang-rounds/prompts/count-records.ts`) | The trigger needs the data | Count by eye |
| R9 | No 5.7 diagnostics for update forms, and no change to E0205's record wording, before the form exists | No round wrote an update form or met E0205 (1.3); a message pointing to the 7.1 workaround would be replaced by the form | Add them now |

## 6. Risks

- **The row may wait forever.** Rounds pick small records. The evidence round (R6) and the counting (R8) are the
  mitigation. If they show no cost and no habit, the 7.1 row is the answer, which is a legitimate outcome.
- **R7, a missed runtime site** silently keeps the old `(…)` form for that record. One test per std record type (4.3,
  test 3) covers every site there is today; a later std record must use `record(…)` (say so in the comment above
  `RECORD_NAMES`).
- **R7 and `extern-fn` (row 8).** A record that an `extern fn`'s TypeScript returns is a plain object, so it would show
  without its name, and a `String` field `tag` would misprint again. Recommend to row 8's planner that a returned record
  pass through its type's constructor. That also checks its `where` at the trust boundary (2.5).
- **R7 changes program output.** A program that shows a record now prints its name. None of the rounds or examples do.
  In the tests only `NET_STDOUT` does: observed by running the suite with R7, two failures, both that pin (4.1).
- **R7's cost:** one `WeakMap.set` per record construction. The suite ran in about the same time (18 s), but nothing was
  measured (to verify). The map holds objects weakly.
- **R7 and module instances.** If a later change made generated code and `examples.ts` load two copies of the runtime,
  only the H5 fallback of actual values would miss names, and it meets no named record today (4.1).
- **The deferred form, if built.** Adding a field no longer flags update sites (2.1). The card must say when to write a
  full construction instead. A model may also try `...` in a case or a list (`[...xs, x]`), which needs its own E0101
  messages.

## 7. Evidence round `fleet` (R6)

**Run** against the head of `main` when a round slot is free, before row 9's turn:

```
scripts/playground-round.sh 2026-11-DD-fleet <head of main> ~/coding_projects/alang-rounds/prompts/fleet.md opus
```

- The script builds the empty playground, a worktree of the commit and the MCP config under
  `~/coding_projects/alang-rounds/`, and passes the round's `CLAUDE.md`: the shell allows `alang`, `cat`, `ls`,
  `printf`, `echo`, `mkdir` and `cd`, joined with `;`, with no redirections; it runs `alang db run <main> -- <args>`
  and shows exit codes with `; echo $?`.
- It runs headless without the advisor, from an empty codebase, taught only by `card` and the std queries.
- Check `instructions=sent` in `done.txt`. Afterwards:
  `git worktree remove --force ~/coding_projects/alang-rounds/2026-11-DD-fleet/wt`.
- A reference that computes every output below is at
  `/home/josua/.claude/jobs/7e0015cb/tmp/records-probes/round/fleet-reference.ts`. Copy it to
  `~/coding_projects/alang-rounds/prompts/fleet-reference.ts` with the prompt.

**Prompt** (save as `fleet.md`; it names no update form and no record):

> Build `fleet`, a command-line tool in alang that keeps track of a company's vehicles, using the alang MCP tools; choose the module name yourself. It keeps the vehicles in the file `fleet.txt` in the current directory, one vehicle per line in the form `<plate> | <model> | <city> | <driver> | <km> | <state>`: exactly six fields separated by ` | `. The plate, the model and the city are words without spaces; the driver is a name without spaces, or `-` for none; `km` is the distance driven so far, a whole number of 0 or more; the state is `ready`, `servicing` or `retired`. A missing file means no vehicles yet. Vehicles keep the order of the file, and new ones go at the end. It is started as `alang db run <main> -- <command> ...`:
>
> - `add <plate> <model> <city>` adds a vehicle with no driver, 0 km and the state `ready`, and prints `added <plate>`.
> - `assign <plate> <driver>` makes the driver the vehicle's driver, replacing any other, and prints `<plate>: driver <driver>`.
> - `drive <plate> <km> <city>` records a trip: it adds `km` to the vehicle's distance, moves the vehicle to the city, and prints `<plate>: <old city> -> <city>, <new distance> km`.
> - `service <plate>` sets the state to `servicing` and leaves the vehicle without a driver; `ready <plate>` sets the state back to `ready`; `retire <plate>` sets the state to `retired` and leaves the vehicle without a driver. Each prints `<plate>: <old state> -> <new state>`.
> - `list` prints one line per vehicle, `<plate> <model> in <city>, <km> km, <state>, driver <driver>` (`driver -` for none), then a last line `<n> vehicles, <total> km`, the total being the sum of all distances.
>
> A retired vehicle accepts no command but `list`. `drive` needs the state `ready` and a driver, `service` needs `ready`, and `ready` needs `servicing`; `assign` and `retire` need `ready` or `servicing`. A refused command changes nothing. Errors go to stderr with exit code 1, checked in this order: no command, an unknown one or the wrong number of arguments prints `usage: fleet add <plate> <model> <city> | assign <plate> <driver> | drive <plate> <km> <city> | service <plate> | ready <plate> | retire <plate> | list`; a `<km>` that is not a whole number of at least 1 prints `not a distance: <km>`; an argument containing `|`, or the driver `-`, prints `not allowed: <argument>`; a line of `fleet.txt` not in the form above prints `fleet.txt line <k> is malformed`, and any other file problem a one-line message; `add` with a plate that exists prints `<plate> exists`, and any other command with a plate that names no vehicle prints `no vehicle <plate>`; a command the state does not allow prints `cannot <command> <plate>: it is <state>`, and `drive` for a ready vehicle without a driver prints `cannot drive <plate>: no driver`. Keep the logic in pure functions with examples, and write `fleet.txt` from one function of its own that every command that changes it uses. Then run, in this order: `add AB-123 van berlin`, `add CD-456 truck hamburg`, `add AB-123 car munich`, `drive AB-123 120 potsdam`, `assign AB-123 ana`, `drive AB-123 120 potsdam`, `drive AB-123 35 berlin`, `service AB-123`, `drive AB-123 10 potsdam`, `assign CD-456 ben`, `retire CD-456`, `assign CD-456 cem`, `ready AB-123`, `list`; show the file; then add the line `EF-789 | bus | bonn` to the end of `fleet.txt` yourself, run `list` once more, and show the file again. Show me every output and exit code.

Each paragraph and bullet of the prompt is one line, so that it can be saved as it stands.

**Expected results** (hand-computed, confirmed by the reference; exit 0 unless stated):
1. `added AB-123`; `added CD-456`.
2. `add AB-123 car munich`: stderr `AB-123 exists`, exit 1.
3. `drive AB-123 120 potsdam` (no driver yet): stderr `cannot drive AB-123: no driver`, exit 1.
4. `AB-123: driver ana`; `AB-123: berlin -> potsdam, 120 km`; `AB-123: potsdam -> berlin, 155 km`.
5. `AB-123: ready -> servicing` (and AB-123 has no driver now).
6. `drive AB-123 10 potsdam`: stderr `cannot drive AB-123: it is servicing`, exit 1. The state is checked before the
   driver.
7. `CD-456: driver ben`; `CD-456: ready -> retired`.
8. `assign CD-456 cem`: stderr `cannot assign CD-456: it is retired`, exit 1.
9. `AB-123: servicing -> ready`.
10. `list`:
    ```
    AB-123 van in berlin, 155 km, ready, driver -
    CD-456 truck in hamburg, 0 km, retired, driver -
    2 vehicles, 155 km
    ```
11. The file: `AB-123 | van | berlin | - | 155 | ready` and `CD-456 | truck | hamburg | - | 0 | retired`, one per
    line. A final line break is the model's choice.
12. After the added line: `list` gives stderr `fleet.txt line 3 is malformed`, exit 1, and the file is unchanged, with
    the third line still at its end.

Extra cases for the analysis, from the file of step 11:
- `drive AB-123 0 x` gives `not a distance: 0`, and `drive AB-123 5x x` gives `not a distance: 5x`.
- `assign AB-123 -` gives `not allowed: -`, and `add a|b van x` gives `not allowed: a|b`.
- `retire CD-456` and `service CD-456` give `cannot … CD-456: it is retired`.
- `ready AB-123` gives `cannot ready AB-123: it is ready`, and `service XY-1` gives `no vehicle XY-1`.
- `drive AB-123 10 potsdam` gives `cannot drive AB-123: no driver`.
- `list x` and no command give the usage line.

Each of these is exit 1, with the file unchanged and no trap (exit 70). Lenient on `007` as a distance: `std.int.parse`
reads it as 7, and the prompt leaves it open.

**Where copies should appear.** The natural design is a 6-field record with five copy sites:

| Command | Fields given | Fields copied |
| --- | --- | --- |
| `assign` | driver | 5 |
| `drive` | km, city | 4 |
| `service` | state, driver | 4 |
| `ready` | state | 5 |
| `retire` | state, driver | 4 |

A model may instead use a helper per field (`with_state`) or a variant for the state that carries the driver; record
which.

**Checks for the analysis.** A fresh Opus agent, read-only, works like the tickets round's. It lists every tool call,
compares against the reference in a scratch copy, and ranks findings "fix now" or "later".
1. **Copies:** run `count.ts` (R8) over the export and give each copy site's fields, copied and given counts, and any
   `swap?`. Check that `card` was called first.
2. **Habit (trigger 3).** Search every `submit` text in the transcript, accepted or rejected, for an update form:
   - `...` or `..` inside a construction, `{...`, ` with `, `.copy(`, `Vehicle(vehicle,`.
   - Quote each, with the diagnostic it got. This decides the spelling of R2 if the row is built.
3. **Cost (trigger 2):**
   - every diagnostic at a construction that copies (E0204, E0205, E0206, E0207, E0208), with the submit it rejected
     and the output tokens of the resend;
   - every wrong value from a copy (an example failing with E0402 on a copied field, or a mismatch with the reference);
   - the share of submitted text taken by copy constructions (characters).
4. **Correctness** against the reference: the twelve expected results, the extra cases, the file unchanged after every
   error, no exit 70.
5. **Effort:** tool calls by kind, time, output tokens, std `context` calls, and whether the first submit was accepted.
6. **Verdict line for row 9:** whether trigger 2 or 3 fired, quoting the evidence.

### Critical files

- For R7:
  - `/home/josua/coding_projects/alang/src/runtime.ts` (`record`, `RECORD_NAMES`, `std$text$show`, the four std
    constructors, `serve` on Deno and Node.js, `send`, `std$string$cut`);
  - `/home/josua/coding_projects/alang/src/emit.ts` (`type()`, the record constructor's last line);
  - `/home/josua/coding_projects/alang/tests/http_test.ts` (`NET_STDOUT`, a `serve` test of `Request`),
    `/home/josua/coding_projects/alang/tests/emit_test.ts`, `/home/josua/coding_projects/alang/tests/std_test.ts`;
  - `/home/josua/coding_projects/alang/alang-specs.md` (7.7), `/home/josua/coding_projects/alang/docs/decisions.md`
    (Representation in TS, the new row, Open questions), `/home/josua/coding_projects/alang/docs/notes.md`.
- For the deferred form: `src/ast.ts`, `src/lexer.ts`, `src/parser.ts` (`payload()`), `src/printer.ts`, `src/check.ts`
  (`construct()`, `matchArgs()`), `src/emit.ts` (the construct case), `src/refs.ts` (`rebuild()`), `src/card.ts`.
- Scratch, for the main session to copy: `/home/josua/.claude/jobs/7e0015cb/tmp/records-probes/count.ts` and
  `/home/josua/.claude/jobs/7e0015cb/tmp/records-probes/round/fleet-reference.ts`.
