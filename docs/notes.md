# Notes and ideas

Running log of observations, spec gaps and ideas for later. Decisions that close a gap move to
[decisions.md](decisions.md); this file is for what is not decided or not done yet.

## Current state (2026-11-14)

Read this first when picking up the work in a new session. Update it when a phase ends.

**Branches.** `main` holds everything below (2026-11-13: the user chose to merge; `spec` was fast-forwarded into
`main`, which contains the whole chain `type-checker`, `effects`, `examples`, `database`, `mcp`, `async`, `spec`). The
phase branches are kept as they are. Start each new phase on its own branch from `main`; pushing is the user's call.
Files and program I/O (item 14) were built on `std-io` and fast-forwarded into `main` (2026-11-13), unpushed. List
literals and pure std (item 15) were built on `list-literals` and fast-forwarded into `main` the same way. The
language card (item 16) was built on `card` and is merged into `main`. Maps, options and more std (item 17) were built
on `std-maps` and fast-forwarded into `main` too. The fixes after its playground round (item 18) were built on
`logstat-fixes` and merged. The fixes after the `tasks` round (item 19) were built on `tasks-fixes` and fast-forwarded
into `main` on 2026-11-14 by the main session, unpushed (the user had authorized the overnight run).

**Done** (phases from CLAUDE.md, in order):

1. Thin slice: lexer, parser, canonical printer, TypeScript emitter, runtime.
2. Type checker (`src/check.ts`), with every accepted test program also checked by TypeScript.
3. Effects: static checks (2.1, 2.4, 5.4) and runtime enforcement through Deno permissions in `alang run`.
4. Mandatory examples (5.1) and the acceptance pipeline of 6.3 (`accept` in `src/toolchain.ts`, rule code in
   `src/examples.ts`). Failing examples report the actual value as alang text.
5. The database (section 6), on branch `database`: `src/codebase.ts` (storage, `submit` with add / replace / remove /
   rename, the guard, the interface, remove and capture rules, the queries, export and import), `src/refs.ts`
   (references by full name, rewriting for rename), `src/interface.ts` (caller-facing interface), `src/search.ts`
   (type patterns), `src/db_cli.ts` (`alang db ...`, JSON output). Decisions in `decisions.md`, section Database.
6. Fixes from the database phase, on `database`: the checker enforces 1.2 for the own module (E0226); database and
   export stay in step when Git changes the files (`sync`, table `export_files`, E0513, `export --force`); `rename`
   takes an optional text, so a rename and an edit share one transaction.
7. The MCP server, on branch `mcp`: `src/mcp.ts` (`alang mcp [--dir <dir>]`), the queries and operations of section 6
   as tools over stdio, hand-written protocol for both MCP eras (`initialize` and the stateless 2026-07-28).
   Decisions in `decisions.md`, section MCP server; registration in the README.
8. Own-module names written in full are stored short by submit and import instead of rejected (the user's choice
   after the playground); the result lists them under `fixed`. A function value whose short name a local holds is
   written in full and not reported (the old fix broke it). Decisions in `decisions.md`, Database, Own-module names.
9. `alang db run [<main>]` (`Codebase.run`): the program the database holds, synced, accepted and started like
   `alang run`; the full name chooses among several `main` functions. Decisions in `decisions.md`, Database, Run.
10. Async output, on branch `async`: a function with effects is `async` in the TypeScript and every call to one is
    awaited (the checker marks the calls in `CheckInfo.effectful`); pure code stays synchronous. alang itself stays
    sequential. Decision in `decisions.md`, Semantics and runtime, "Effects in TS".
11. `std.http.serve`, on `async`: records `Request`, `Response`, `Header`, variant `ServeError`; one request at a
    time; ends on SIGINT/SIGTERM with `Ok(Unit)`; the handler may have effects (the one exception to E0232, marked
    `effects: "caller"` on the std function type). Runs on Deno and Node.js. `alang run` waits for the program on
    Ctrl-C. Example in `examples/server.alang`. Decisions in `decisions.md`, HTTP server.
12. After the playground's HTTP task, on branch `spec`: `definition`, `signature`, `context`, `callers` and `list` read
    std names (hash null; `list("std")`, not in `list("")`); the acceptance file exists only during an acceptance,
    and the MCP server closes on SIGINT, SIGTERM and SIGHUP; its instructions start with the path of the spec.
    Decisions in `decisions.md` (Database: Concurrency, std in queries, `list`; MCP server: Instructions, Shutdown).
13. Section 7 of `alang-specs.md` (the user asked for "everything to write alang" in the spec, 2026-11-12): a
    reference of what the implementation accepts, what is not available, the std library (a test compares it with
    `src/std.ts`), the server example (accepted in the tests), the codebase tools and the diagnostic ranges. Section
    7 restates decisions from `decisions.md`; when one changes, change both.
14. Files and program I/O in std, on branch `std-io` (plan in `docs/plans/std-io.md`; the user took every
    recommendation, D1 to D5): one error type `std.fs.Error` (renamed from `ReadError`) for all of `std.fs`;
    `write_text`, `append_text`, `list_directory`, `kind` (variant `std.fs.Kind`), `create_directory`, `remove`;
    `std.console.read_line`, `std.env.args`, `std.env.get`, `std.log.print_line`, `std.random.int`,
    `std.time.now_milliseconds`, `std.string.split`. `alang run <file> -- <args>` and `alang db run [<main>] -- <args>`
    pass arguments; `RunOptions` takes `args` and `stdin`. `main` may return `Result<Unit, String>`: an `Err` goes to
    stderr with exit code 1. Every effect now has a std function. One program gives the same output on Deno and
    Node.js (`tests/io_test.ts`). Example in `examples/lines.alang`. Decisions in `decisions.md`, Files, arguments
    and console. After its playground round ("From the ledger round"), three fixes (plan, section 7): the doc of
    `std.int.parse` states exactly what it accepts, E0005 gives the `\u{...}` form as the fix for `\r`, `\0`, `\a`,
    `\b`, `\f`, `\v` and `\e`, and overflow, division and NaN traps name the definition they occur in.
15. List literals and pure std breadth, on branch `list-literals` (phase 1 of `docs/plans/list-literals.md`; the
    main session took every recommendation, L1 to L7 and S1 to S14): the literal `[a, b, c]` (at least one item; `[]`
    is E0228 with the fix `std.list.empty<T>()`; `xs[0]` and `Int[]` are E0006 from the parser), actual values
    printed as literals, the server example shortened; an `Int` is never `-0`; `std.int` `min`, `max`, `abs` and
    checked arithmetic; `std.string` `contains`, `starts_with`, `ends_with`, `find`, `cut` (record
    `std.string.Cut`), `take`, `drop`, `characters`, `lines`, `replace`, `to_upper`, `to_lower`; `std.list` `first`,
    `last`, `take`, `drop`, `reverse`, `concat`, `flatten`, `contains`, `range`, `window`, `zip`, `enumerate`. A std
    signature's `withoutFunctions` replaces the by-name E0222 check of `std.text.show`. Lists are
    `ReadonlyArray<T>` in the generated TypeScript, and each literal carries its checked type there. Decisions in
    `decisions.md`: Syntax (List literal), Type checking (List literals), Semantics and runtime (`Int` zero),
    Examples and acceptance (Actual values), and the section Text, numbers and lists in std. Its playground round
    (`wordcount`, see "From the wordcount round") was accepted on the first try without the advisor; the two gaps it
    showed, what list operations cost and counting without a Map, are now in the spec (7.8, 7.1).
16. The language card, built on branch `card`, merged into `main` (the first layer of "Language knowledge served by the
    tool"): `src/card.ts` exports `CARD`, about 155 lines and 9 KB of Markdown with the rules every definition needs and
    one complete accepted program (`temp`), and no std listing beyond the names its rules use. The MCP tool `card`
    returns it; the instructions start by sending the model there and to `list("std")`, `search`, `search_type` and
    `context` for std, and name the spec only as the full reference. Served by a tool, not inside the instructions as
    briefed, because Claude Code cuts server instructions at 4,096 characters (see "From the card").
    `tests/card_test.ts` parses and accepts the card's program and checks every code, std name and tool call it names.
    The card restates spec section 7 and changes with it. Decisions in `decisions.md`, MCP server (Card, Instructions,
    Results, Scope).
17. Maps, options and more std, on branch `std-maps` (phase 2 of the roadmap; plan in `docs/plans/std-maps.md`, the
    main session took every recommendation of its section 5): `Map` values as a persistent AVL tree in key order
    (`$rt.SortedMap`), the ten `std.map` functions, the map literal `["a": 1, "b": 2]` (`[:]` is E0228, keys are Int
    or String, E0229, a literal key twice is E0234), actual values of maps as literals, `for` typing a literal it
    iterates, `std.list` `any`, `all`, `find`, `filter_map`, `take_while`, `drop_while`, `std.option.with_default`
    and `map`, `std.order.then_by`, `std.string` `repeat`, `pad_left`, `pad_right`, `trim_characters`,
    `code_points`, `from_code_points`, and `std.float` `compare`, `parse`, `round`, `ceil`, `trunc`, `abs`, `min`,
    `max`, `sqrt`, `to_fixed`. Every trap, cost and order rule is in the doc line (W1). `examples/words.alang` counts
    the words of a file with a Map, alike on Deno and Node.js. The card names the map literal and the unwrapping
    functions. Decisions in `decisions.md`, section Maps, options and more std, and the rows it names.
18. Fixes after the logstat round (the playground round of item 17; see "From the logstat round"), on branch
    `logstat-fixes`: the doc lines of `std.float.to_fixed` (rounds the exact binary value, `1.005` gives `1.00` with
    2, `0.125` gives `0.13`) and `std.float.parse` (`-0` gives `-0.0`) state their rules (W1); a function's hit in
    `list` and `search` carries `signature`, its one-line signature without the doc, and the card, the MCP
    instructions and the tool descriptions say so and leave `context` for examples, the body and uses. Decision in
    `decisions.md`, MCP server, Hits.
19. Fixes after the `tasks` round (see "From the tasks round"), on branch `tasks-fixes`, one commit each: the MCP
    server reopens a moved or deleted `alang.db` (E0514 for a write that fails on a moved file); the card names
    `\u{D}` for `\r`; type hits in `list` and `search` carry a one-line `signature`; the doc lines of `read_text` and
    `read_line` state their decoding; a dangling link is `NotFound` on both hosts; a lexer error in a submit names its
    definition. Also `scripts/playground-round.sh`, which runs a playground round headless (see Working conventions).
    289 tests. The plan of phase `statements` (`docs/plans/statements.md`, Opus, T1 to T15) was committed on the same
    branch.
20. `std-net`, on branch `std-net` (plan in `docs/plans/std-net.md`; the main session took every recommendation, N1
    to N11, and N3 was approved by the user on 2026-11-13), one commit per step: `std.fs.Error` gains `AlreadyExists`,
    with `std.fs.create_text`, an exclusive create (`EEXIST` maps in every fs function, so `create_directory` over a
    file, or over a dangling link at the path or on the way, is `AlreadyExists`, no longer `Other`);
    `std.fs.describe` and `std.http.describe` give errors as lower-case text; `std.console.print` writes without a
    line break; `std.time.wait`; the HTTP client `std.http.send` with `std.http.SendError` (`InvalidUrl`,
    `Unreachable`, `TimedOut`, `Failed: String`), alike on Deno and Node.js but for three host differences that 7.8
    names. `examples/probe.alang` checks URLs with a pure retry decision; `lines.alang` and `words.alang` print their
    errors through `std.fs.describe`; the card's `main` line shows `else return Err(std.fs.describe(error: error))`.
    The gaps 7.1 listed (waiting, an HTTP client, console output without a line break) are closed. Every four-arm
    `match` over `std.fs.Error` is now E0213, among them the playground's `ledger`, `wordcount`, `logstat` and
    `tasks`. Decisions in `decisions.md`: Files (Error type, `create_text`, `create_directory`, `describe`, Links,
    `print`, Waiting) and HTTP (`std.http`), renamed from "HTTP server". 307 tests. See "From std-net". After its
    playground round (see "From the std-net round"), five fixes: `alang run` passes SIGTERM on only after 500 ms,
    a connection closed without an answer has one `Failed` text, 7.8 names four host differences, the `serve` doc
    warns about blocked ports, and `std.http.describe_serve_error`. 310 tests.
21. Statements, on branch `statements` (plan in `docs/plans/statements.md` with its addendum; the main session took
    every recommendation, T1 to T15), one commit per plan step: the propagation statement `expression else return
    value` for a `Result<Unit, E>` or `Option<Unit>` (T1; an `else` on the line of an `if`'s `then` still belongs to
    the `if`, T2); a `let` of type `Unit` is E0235, with a fix when the name is unused (T3); E0217 names the statement
    for a discarded `Result<Unit, E>` (T4); submit and import apply E0235's fix themselves, listed under `fixed` (T5).
    `let [a, b]: List<T> = list else return v` takes a list of exactly that length apart (T11; `case [a, b]` is E0101,
    T12). Shared cases `case A or B then` (T6 to T10): a name not every pattern binds is E0236 where it is used, `|` is
    E0006 and `case A, B` E0101, each with a fix, and E0227's `expected` is one shared case. `std.list.set` and
    `std.list.find_index` (T13, T15). `examples/lines.alang` takes its arguments apart and propagates its write; the
    card teaches all three forms (158 lines, 9,630 bytes). On the way, a latent emitter bug: a `let` whose block value
    binds its own name inside (`let n: Int = match o` with `case Some(n)`) crashed its example; it is now assigned
    through a temporary. Record update moved to a new roadmap row 9, `records` (T14). Decisions in `decisions.md`, rows
    listed in the review list below. 339 tests. See "From statements". After its playground round (see "From the
    tickets round"), three fixes: one E0217 instead of E0217 and E0204 for a propagation statement with a content to
    bind that ends a value block, the card's `let [...]` sentence for any known length, and the round prompt in the
    plan. 340 tests.
22. Function types, on branch `fn-types` (plan in `docs/plans/fn-types.md`; the main session took every
    recommendation, F1 to F11), one commit per plan step: function types `(T, U) -> V` wherever a type is written, at
    least one parameter, nested to the right, always pure (F1, F3, F5); the forms of other languages are E0006 naming
    `(Int) -> Int`, `() -> T` and `with effects` E0101 (F6); fixes and actual values write function types,
    `std.list.empty<(Int) -> Int>()` (F8). A local, or a field of one, of function type is applied by position,
    `by(a, b)`, while named arguments or `()` always call a function defined with `fn` (F2): E0238 for a value that is
    no function or a wrong count, E0220 with the application as fix for named arguments on a function value, and E0107
    with the named call as fix for a `fn` called by position, now from the checker (F7). No `fn` returns a function
    value, also not inside a list, map, option or record (E0237, F4). `search_type` patterns write function types,
    `List<_>, (_) -> Bool -> List<_>` (F9), hits show them in full, and `context` names the types inside them. The
    spec gains `calc.first_true` (section 4), accepted with its examples; the card teaches function types,
    application and E0237 (159 lines, 9,757 bytes). Decisions in `decisions.md`, rows listed in the review list
    below. 363 tests. See "From fn-types".

23. Constants, on branch `const` (plan in `docs/plans/const.md`; the main session took every recommendation, C1 to
    C16, C6 included), one commit per plan step, after R7 of `docs/plans/records.md` as the phase's first commit
    (`726da44`: records carry their type's short name at runtime, so `std.text.show` prints `Port(value: 8080)` and a
    record with a `String` field `tag` no longer shows as a case). `const shop.max_items` with `doc`, `out` and `body`
    (statements ending in `return`), used by its name without parentheses (`limit()` is E0247), short in its module
    and in full elsewhere, with fields (`shop.limits.items`); a name is read from the left, and two readings are E0249
    (C1, C2). A constant is pure (E0233), holds a value (not `Unit`, not a function type: E0248), may hold functions
    inside (a table of measures, applied by position, as the `rank` round wanted), and has no examples: it is a getter
    evaluated once, and acceptance evaluates every constant before the examples, a trap or a cycle there being E0404
    (C3 to C5, C13). The codebase stores constants (`list` shows `const shop.limits: shop.Limits`, `context` a used
    constant's whole text, `replace` may turn a `fn` into a `const` with its callers in one submit), and a database
    made before constants is migrated when opened, its history kept (C7 to C11). Habits get the alang form (C12:
    `const` in a body, `MAX_ITEMS`, the one-line form, `n < limit` with `()` as fix), and E0401 for a pure function
    without parameters gives the constant's text (C6; such functions stay legal, E0405 is reserved). The `rank`
    follow-ups: E0237 gives a pure `fn` without parameters the constant's text and tells lookups to return the name
    and apply the function where it is used; the card says a table of functions is a `const`. The card teaches
    constants (159 lines, 9,896 bytes). The spec gains `const shop.sizes` with `shop.is_size` (7.3), accepted with its
    examples. Decisions in `decisions.md`, rows listed in the review list below. 400 tests. See "From const".

**Next (2026-11-14, overnight run, updated by the main session at ~06:15):** `std-net` (item 20), `statements`
(item 21), `fn-types` (item 22) and `const` (item 23, with R7 of `docs/plans/records.md`) are built, their rounds
analyzed and fixed, and fast-forwarded into `main` (unpushed). `const` was verified by its round `parcel` and a rerun of
`rank` (see "From the parcel round and the rank rerun"). Next: `generics` from `docs/plans/generics.md` on branch
`generics` (fresh Opus agent; split point before generic types, commit 5), its round `shop`
(`~/coding_projects/alang-rounds/prompts/shop.md`, reference `shop-reference.ts` beside it). Then `extern-fn`
(`docs/plans/extern-fn.md`, round `query`, reference `~/coding_projects/alang-rounds/prompts/query-reference.mjs`; the
user's playground MCP registration needs `--allow-run` once a codebase holds an extern, see that plan's E11). Row 9
`records` is not built (R1 of its plan; run its evidence round `fleet` before row 9's turn). All plans were written by
fresh Opus agents on 2026-11-14 and are committed. No Fable planners until the weekly reset (Sunday 2026-11-15 21:00
local); the Fable advisor is fine. The user, before going to sleep on 2026-11-14: continue with the remaining items
of the to-do list, never push, and shut the PC down when everything is finished.

**Earlier next steps (kept for reference):** `logstat-fixes` is merged into `main` (2026-11-13). The `tasks` playground round, from an empty codebase,
was started on 2026-11-14: prompt, checks and the steps after it are in `docs/plans/tasks-round.md`. When the user
reports it done, analyze it (step 1 there), fix, then build `std-net` from `docs/plans/std-net.md` (planned by Opus
on 2026-11-14; do not switch branches in this repo while a playground round runs, since the playground runs alang
from this working tree). The logstat round itself (plan of `std-maps`, section 6) is done. Then the
roadmap in `docs/plans/list-literals.md`, section 0 (2026-11-13): phase 1 (`list-literals`) is item 15, and its
playground round is done (see "From the wordcount round"). Phase 2, `std-maps`, is item 17, and its round is done
(see "From the logstat round"); then `std-net` (HTTP client, waiting, console output without a line break; N3,
reopening `std.fs.Error` with `AlreadyExists` and `std.fs.create_text`, approved by the user on 2026-11-13, which
undoes D2; the phase also adds a std function that turns a `std.fs.Error` into text, so programs drop the four-arm
`match` that ledger, wordcount and logstat each repeat), `statements`, `fn-types`, `const`, `generics`, `extern-fn`. Earlier proposed order
for the user's six goals, still standing after std breadth and the language forms libraries need: the spec served by the
MCP server (card plus `explain(code)`; the card is item 16), then the plan/build/test agent loop (needs an example time
limit, a scored task suite, a gate for language decisions), then shipping (JSR package, `alang init`, quickstart, CI;
std names freeze per 3.8), and self-hosting last. Suggested first step: goal 4 as one hand-run round of the loop.

Phase 3 of the HTTP work, an HTTP client (`std.http.fetch` or similar, on fetch), was postponed by the
user (2026-11-12); async output makes it possible now. Reconnect the playground's MCP server to pick up the merged
`main`, and watch whether the model reads std through `context` instead of the sources. Earlier: a first round with Claude Code in a playground project (`~/coding_projects/alang-playground`, ten tasks)
is done; see "From the MCP server". Claude Code connected and used every kind of tool, so the protocol works with a
real client (the official SDK client was not run). Open from that round, each the user's call: an MCP `run` tool
(`alang db run` is built; see "From db run"); recording what triggered an `import` in `history`; a tool operation for renaming a
parameter; `search_type` through `Option`/`Result`; `std.int.min`/`max` (built, item 15). `extern fn` and `const` are still unparsed
and need their form decided (`const` built, item 23).

**Checks before every commit:** `deno task test` (400 tests; the task now allows `net`, for the server tests),
`deno lint`, `deno fmt --check`.

**Working conventions** agreed with the user:

- Write in English; translate German text you encounter.
- Each phase on its own branch; commit locally with explicit paths (never `git add -A`); do not push.
- The user also commits and pushes; check `git log` and `git status` before committing.
- Decisions go to `decisions.md`, observations and ideas to this file, both as you go.
- One task, fresh agents (2026-11-13): the main session orchestrates; a Fable agent plans, a new Opus agent builds
  and reports, the main session verifies (checks, running the result) before reporting to the user. Plans go to
  `docs/plans/<phase>.md`.
- Design decisions (2026-11-13): take the recommendation instead of asking the user; in an automated run never wait
  on the user (ask the advisor when no option is clearly better, then pick one). Record each in `decisions.md`, list
  it below for review, and keep it revertible (own branch, small commits). Ask first only for pushing, publishing,
  deleting data or settings outside the repo.
- Usage limits: pause new agents at 95% of the 5-hour limit, stop at 98% of the weekly limit and of the Fable weekly
  limit (the user reports the Fable figure; `~/.claude/usage/latest.json` has the others).
- Playground rounds run headless (the user asked for it, 2026-11-14): `scripts/playground-round.sh <name> <commit>
  <prompt-file> [model]` puts an empty playground, a worktree of the commit and the results under
  `~/coding_projects/alang-rounds/<name>/`; prompts live in `~/coding_projects/alang-rounds/prompts/`. Never touch the
  user's `~/coding_projects/alang-playground`. Check `instructions=sent` in `done.txt`; a fresh Opus agent analyzes the
  transcript; remove the worktree afterwards (`git worktree remove --force <name>/wt`).

**Decisions awaiting the user's review.** All are recorded in `decisions.md` and were reported, but not explicitly
confirmed. Do not build on them as if settled; raise them if a new phase depends on one.

- Slice: section names are reserved words; variant case names are unique per module; `std.int.parse` returns
  `Option<Int>`; `not` binds looser than comparison; no unary minus except on number literals; `result` and `error`
  are reserved names.
- Type checker: explicit type arguments exactly when a type parameter is missing from the parameter types; a body
  ends with a literal `return`; discarding a non-`Unit` value is an error; sibling branches may reuse a name; `+` is
  numeric only; an example calls its own function; builtin names and the `std` module are reserved.
- Effects: over-declaring effects is allowed; functions passed by name must be pure; functions with effects cannot
  have examples (5.4); a read refused for lack of permission traps; effects are listed in table order (E0111).
- Examples: no fix for a failing example (the body may be wrong, not the example); every failing example is
  reported; a stack overflow in an example is a trap; `check`, `ts`, `build` and `run` refuse programs whose examples
  fail or are missing.
- Own-module names: the long form is an error (E0226) in the checker, reported only for a name that exists; the
  database applies the fix itself (chosen by the user, 2026-11-12). Still to confirm: a function value whose short
  name a local holds keeps its full name (the alternative was forbidding such a local, as shadowing per 2.6).
- Database: everything in `decisions.md`, section Database. The user chose (2026-11-12) automatic sync with the
  export and an optional text on `rename`; the details within them are still open for review: a conflict is
  refused (E0513) rather than resolved; a missing export directory is written, never read as every file deleted;
  library queries read the database as is while `alang db` syncs first; a submit's sync import stays when the submit
  is rejected; a pull during a submit restarts it, and one right after its commit is left for the next operation to
  report as E0513. To confirm: every `alang db` command, a plain query included, can now change the database (a
  deleted export file removes its module's definitions). Above all, references stay names, so `rename` rewrites
  callers instead of changing only a pointer (departs from 6.1); see "Database phase: open points".
- Running from the database: everything in `decisions.md`, Database, Run; above all, a failed sync refuses the run
  instead of falling back to the database (also for an export file that does not parse), examples are re-run, the
  program runs in the caller's directory, and the built files stay in `out/`.
- MCP server: everything in `decisions.md`, section MCP server; above all, no `import`/`export` tools, JSON results
  identical to `alang db`, a hand-written protocol instead of the SDK, and queries marked read-only although their
  sync can change the database.
- std library: all names and parameter names in `src/std.ts`, including `std.fs.read_text` and the cases of
  `std.fs.Error` (renamed from `ReadError`), are provisional. Rule 3.8 freezes them once published.
- Section 7 of the spec states these decisions as rules, since a model writing alang needs them; it is the
  implementation's reference, not a settled design. Also mine: std readable through the queries but left out of
  `list("")`. The MCP server's instructions naming the spec's path were kept by the user (2026-11-12).
- Async output and `std.http` (the user asked for async and a server, 2026-11-12; the details are mine): every
  function with effects becomes async, not only those that wait; the handler exception to E0232; requests one at a
  time; `host` as a parameter; the record fields (`content`, since `body` is reserved; method and query as plain
  strings); the `where` of `Response`; `Err` for a port in use but a trap for a bad header; a trap in a handler ends
  the whole server; `alang run` ignoring SIGINT while the program runs. Everything in `decisions.md`, HTTP server.
- Files and program I/O (the user chose D1 to D5, 2026-11-13; the rest is the planner's and mine): the four cases
  of `std.fs.Error` with everything else in `Other`; a path Deno guards (`/proc`) as `PermissionDenied` with the
  permission and a trap without it; the empty path as `NotFound`; `list_directory` sorted; `kind` following links
  and calling everything that is not a directory a file; `create_directory` making parents and accepting an existing
  directory; `remove` without recursion; `read_line`'s line ends and its `None` for ever after the end; impossible
  environment names as `None`; `Math.random`; the synchronous runtime functions; `--` as the separator in both
  commands, with other words before it a usage error; a test's console empty unless it gives one; the example only in
  `examples/`. Everything in `decisions.md`, Files, arguments and console.
- List literals and pure std (phase 1 of `docs/plans/list-literals.md`, 2026-11-13; the main session took every
  recommendation). Language changes first: L1 the literal `[a, b, c]`; L2 at least one item, `[]` is E0228 with the
  fix `std.list.empty<T>()`; L3 the item type from the expected type, otherwise from the first item; L4 `xs[0]` and
  `Int[]` stay E0006, now from the parser; L5 no trailing comma, line breaks inside the brackets ignored, printed on
  one line; S1 an `Int` is never `-0`. The others: L6 the append chain stays legal; L7 actual values print literals;
  S2 positions and counts in Unicode scalar values; S3 `take` and `drop` clamp above the length and trap below zero;
  S4 the empty part occurs everywhere, `replace` traps on it; S5 `cut` with the record `std.string.Cut`; S6 no
  `slice` and no `concat_all`; S7 `lines` follows `read_line`; S8 `zip` and `enumerate` take a function; S9 `zip`
  traps on different lengths; S10 `range` includes both ends; S11 `contains` needs a type without function values;
  S12 checked arithmetic returns `Option<Int>`; S13 the name `find`; S14 case mapping by Unicode's default rules.
  Mine beyond the plan: the E0228 fix only for an item type that can be written (no function type inside), else
  the fix-less form; the `range` trap names `low to high` and fires before any memory is taken; lists as
  `ReadonlyArray<T>` everywhere in the TypeScript (the plan's fallback), which also fixes a `for` that collects lists;
  E0006 for `[` after any type, also inside type arguments (`List<Int[]>`); no fix for the trailing comma.
- Fixes after the ledger round (2026-11-13, mine beyond the plan): `\0` before a digit gets no E0005 fix, since it
  is a C octal escape (`\033`) that `\u{0}` would misread; the seven C escapes add one sentence to the message
  (`` `\r` is written `\u{D}` ``). In `decisions.md`, Lexical, String escapes.
- List costs (after the wordcount round, 2026-11-13): what list functions cost, as 7.8 states it, is part of the std
  contract; the alternative was a persistent list with a cheap `append`. In `decisions.md`, Text, numbers and lists
  in std.
- The card (item 16, 2026-11-13; the brief was the main session's, these are mine): serving it through the tool
  `card` instead of inside the instructions, because of the client's 4,096-character cut; the tool answering with
  Markdown instead of JSON and without a sync; the first paragraph of the instructions; the example program `temp`
  (a variant type, a pure function with four examples, a `main` with `Result<Unit, String>`); which rules made the
  card and which codes it names. In `decisions.md`, MCP server.
- Maps, options and more std (item 17, 2026-11-13; the main session took every recommendation of
  `docs/plans/std-maps.md`). Language changes first: M1 map keys are `Int` or `String` (E0229, wherever the type
  arises); M2 the literal `["a": 1, "b": 2]` with at least one entry, on one line, `[:]` and `[]` E0228 with the fix
  chosen by the expected type (H6); M3 two equal literal keys are E0234, computed duplicates and duplicates in
  `from_list` trap (kind `key`); M8 a bare unknown name as a key gets E0203 with the quoted text as fix, and `{` and
  index access name the map forms; H4 `for x: T in [...]` passes `List<T>` to the literal. The others: M4 the AVL
  tree and its costs; M5 key order everywhere; M6 `show` and actual values as literals; M7 the names; H1
  `with_default`, `option.map`, `filter_map`; H2 `then_by`; H3 the stopping rule; H5 empty collections with function
  types print through `show`, and the E0209 guess offers no such type; P1 to P3 padding, code points, trimming; R1 to
  R5 Float rounding, `parse`, `to_fixed`, `sqrt`; W1 every rule in the doc line. Mine beyond the plan: E0234 skipped
  for a key that failed its type; the `for` hint only for a `Map`; `[:]` may hold a line break; `words.alang` keeps
  its top three fixed. In `decisions.md`, Maps, options and more std, "Beyond the plan".
- Hits with signatures (item 18, 2026-11-13; the brief was the main session's, the shape is mine): a separate
  `signature` field on function hits only, the `search_type` line cut before its doc, rather than the whole line in
  place of `doc` or a form without `fn <name>`; types get none; `search_type` keeps its shape; search does not read
  the signature. In `decisions.md`, MCP server, Hits.
- Fixes after the `tasks` round (item 19, 2026-11-14; the brief was the main session's, the details the implementer's):
  types now get a `signature` too (`type std.fs.Error, variant: NotFound | ...`, cases joined by ` | `, the `where`
  as written); the MCP server checks the database file's identity before each call and reopens it (history in the
  moved file stays there), with the new code E0514 only when a write fails on a file that really moved; only `\r`
  on the card, the other C escapes left to E0005's fix; a dangling link is `NotFound` for reading and writing on both
  hosts and no target is created (POSIX would create it, but Deno cannot resolve a link without the read
  permission), `create_directory` over one is `Other`, `remove` removes the link; a lexer error in an add names the
  definition from its first line. In `decisions.md`: MCP server (Hits, the moved database), Database (Which text
  failed), Files (Links).
- The overnight run (2026-11-14): the main session merged `tasks-fixes` into `main` itself, and the plan of
  `statements` (T1 to T15, all taken as recommended) will be built without the user's review. Its T3 makes a `let`
  of type `Unit` an error (E0235): the user's playground export `tasks.alang` has two such lines and is refused on its
  next acceptance until they change (T5 lets the codebase fix them on the next submit).
- std-net (item 20, 2026-11-14; the main session took every recommendation of `docs/plans/std-net.md`). The change
  that breaks programs first: N3, `std.fs.Error` gains `AlreadyExists` (approved by the user on 2026-11-13; every
  existing four-arm `match` is now E0213), with `std.fs.create_text`, and `EEXIST` maps in every fs function, so
  `create_directory` over a file is `AlreadyExists` instead of `Other`. The others: N1 the four cases of
  `SendError`, with `Unreachable` read from Deno's message text; N2 the timeout as a parameter covering the whole
  exchange, 20 redirects followed; N4 the two `describe` functions and their texts; N5 `send`'s five parameters
  and the reuse of `Response`; N6 the program's mistakes trap (method, GET or HEAD content, the nine headers HTTP
  manages, a timeout below 1); N7 the response headers as fetch iterates them, `content-encoding` and
  `content-length` dropped after decompression, a status outside 200 to 599 `Failed`; N8 the Fetch standard's bad
  ports as `InvalidUrl`; N9 `print`; N10 `wait(milliseconds:)`; N11 `text/plain; charset=utf-8` for request
  content. Mine beyond the plan: a dangling link at the path is `AlreadyExists` for `create_text` (both hosts, also
  with `fs.write` alone, probed), and for `create_directory` at the path and on the way, while a file on the way
  stays `Other` (the asymmetry `mkdir -p` has too); port 0 is `InvalidUrl` as well, beyond Node.js's list; a
  redirect to a blocked port stays a host difference (Node.js `Failed`, Deno follows it), documented instead of
  following redirects by hand; 204, 205 and 304 responses get content `""`; the request header check shares
  `checkHeader` with the server, its message naming a request or a response header; `ServeError` keeps
  `std.text.show` (until the round's fixes, next bullet). In `decisions.md`: Files (Error type, `create_text`, `create_directory`, `describe`, Links,
  `print`, Waiting, Synchronous, Left out) and HTTP (`std.http`).
- Fixes after the std-net round (2026-11-14; the brief was the main session's, the details the implementer's):
  `alang run` passes SIGTERM on only if the program still runs 500 ms later (one timer at a time, armed again after
  it fires, so a second SIGTERM to the tool alone still reaches a slow server; after a group SIGTERM a program that
  needs more than 500 ms is ended by the passed-on signal); the fixed text `the server closed the connection without
  answering`, used only while no response has arrived (a body cut short keeps the host's message), and Deno's
  `error sending request ...: ` start stripped from other `Failed` texts; `describe_serve_error`'s texts `address
  already in use` (the system's text for `EADDRINUSE`) and `permission denied`; the test server and
  `examples/server.alang` showing `ServeError` through it. In `decisions.md`, HTTP (`std.http`): `alang run`,
  `SendError`, `describe`, `describe_serve_error`, Bad ports, Host differences left.
- Statements (item 21, 2026-11-14; the main session took every recommendation of `docs/plans/statements.md`, T1 to
  T15, built without the user's review). Language changes first: T1 the propagation statement `expression else return
  value` for a `Result<Unit, E>` or `Option<Unit>`; T2 not after an `if`, `match` or `for`, and an `else` on the line
  of an `if`'s `then` belongs to that `if`; T3 a `let` never binds `Unit` (E0235, with a fix only when the name is
  unused and the rest parses; patterns, parameters and `let [...]` names may still be `Unit`); T6 shared cases `case A
  or B then`, whole patterns on one line; T7 a name is bound in a shared arm only if every pattern binds it with one
  type, any other is hidden (E0236 at a use, E0216 if bound again, before the module's functions); T11 `let [a, b]:
  List<T> = list else return v`, exact length, names only, the list's type (E0204 with a fix for the item type); T12
  no list patterns in `case`. The others: T4 E0217 names the propagation statement for a discarded `Result<Unit, E>`;
  T5 the codebase applies E0235's fix itself; T8 E0213, E0214 and E0227 per pattern, E0227's `expected` one shared
  case; T9 `|` E0006 and `case A, B` E0101 with fixes, `Err(A or B)` E0101 without; T10 one TypeScript branch per
  pattern; T13 `std.list.set` traps outside the list; T14 record update left to roadmap row 9 `records`; T15
  `std.list.find_index`. Mine beyond the plan: E0235 is not held back by an E0226 inside the same `let`, so submit
  applies both fixes in one round; E0236 is reported once per name and definition; a one-pattern case keeps E0214's
  old message; E0235 for a block value with `else` has no `expected`; the comma fix turns only the commas between
  `case` and `then` into `or`, and its `expected` is `or`, as for `|`; the `|` fix also turns a `||` on that line into
  `or`; a name with the error type in any pattern of a shared case is bound with the error type; a function value
  written in full whose short name a shared case hides is not E0226 (its fix would give E0236); the message for `?`
  names the propagation statement; the MCP instructions name the new `fixed` entry; a `let` with an `if`, `match` or
  `for` value is emitted through a temporary; the plan's `main` over `std.env.args()` (test 3.5) is `lines.alang`'s io
  test, not a second program. In `decisions.md`: Lexical (Foreign forms), Syntax (Propagation statement, Taking a list
  apart, Shared cases), Semantics and runtime (Representation in TS), Type checking (Discarded values, `Unit`
  bindings, Taking a list apart, Blocks, `match`), Database (`Unit` bindings fixed), MCP server (Instructions), Text,
  numbers and lists in std (`set`, `find_index`, Stopping).
- Fixes after the tickets round (2026-11-14; the brief was the main session's, the details mine): a propagation
  statement whose content is not `Unit`, as the last line of a block that needs a value, is one E0217 instead of
  E0217 and E0204, and the block's value is the error type; its message "The `T` inside `Ok` is discarded, and
  `… else return` has no value: bind it, `let name: T = … else return …`, and end the block with `name`." (`Some`
  for an `Option`), and its `expected` of two lines, `let name: T = <expression> else return …` and `name`, with the
  `else` value left as `…` like the one-line form. A `Unit` content there keeps E0204 alone, and E0224 at a block's
  end still comes with E0204 (left for later). In `decisions.md`, Type checking (Discarded values).
- Function types (item 22, 2026-11-14; the main session took every recommendation of `docs/plans/fn-types.md`, F1 to
  F11, built without the user's review). Language changes first: F1 function types `(T, U) -> V` wherever a type is
  written, at least one parameter, nested to the right, on one line, `->` a lexer symbol; F2 a local or a field of one
  of function type is applied by position, `by(a, b)`, while named arguments or `()` always call a function defined
  with `fn` (the first argument decides, as in `payload()`); F3 user function types are pure, `with effects` stays the
  mark of `serve`'s handler (E0101 in user code); F4 no `fn` returns a function value, also not inside a list, map,
  option, record or variant (E0237 at `out`), with E0222 in its examples suppressed; F5 no zero-parameter function
  types (`() -> T` is E0101). The others: F6 the foreign forms `(Int) => Int`, `(x: Int) -> Int`, `Int -> Int`,
  `fn(Int) -> Int` as E0006 without fixes, passed on through the type-argument backtracking except `fn`; F7 E0238
  for a value that is no function or a wrong count, E0220 with the application as fix for named arguments on a
  function value, E0107 for a `fn` called by position moved to the checker, with the named call as fix; F8 function
  types written in fixes and actual values (H5 left for zero-parameter types only); F9 `search_type` patterns with
  function types, a whole pattern in parentheses read as the top-level form; F10 a generic function stays no value
  (E0210); F11 records and cases may hold function values (no `==`, `show`, `contains`). Mine beyond the plan: the
  named call that E0107 checks quotes the written application (`call()` takes the `at`), so a long own-module name
  in it is E0226 at `m.twice(1)` beside E0107; the E0107 and E0220 fixes only when the text is one line; E0238 at the
  whole application; a named call on a function value marks the local used; `fieldPath` reports nothing, so a
  dotted target whose chain fails is the method-call E0220; E0511 "A function type has `->` after its parameters."
  for a pattern's function type without `->`; `std.list.append` is a hit of `List<_>, (_) -> Bool -> List<_>` (its
  `T` bound to a function pattern, as the rules give it; the plan's hand-made list left it out); E0237 is reported
  beside E0202 for `out: (Rowz) -> Int` (two causes); the overview row, the card's lambda bullet and its "Not in
  alang" line change in commit 1 already, and application joins them in commit 2, so each commit's docs are true.
  In `decisions.md`: Syntax (`a.b.c`, Function types, Applying a function value), Type checking (List literals,
  Locals vs functions, Function values, Function results, std signatures), Effects (Function values), Examples and
  acceptance (Actual values), Database (`search(type)`); the open question "Function types" is closed.
- F4 kept after the `rank` round (2026-11-14, the main session's decision on the analysis's recommendation): nothing
  is loosened now; the `const` phase is the loosening (E0237 points a function without parameters to `const`, the
  card says where a table of functions goes, `rank` is rerun). Reasons: 5.1 with 3.9 (E0401 would need an exemption
  too), principle 3 (two ways), 3.8 (loosening later breaks nothing). In `decisions.md`, Type checking (Function
  results); details in "From the rank round".
- Records in `show` (R7 of `docs/plans/records.md`, 2026-11-14, built as the first commit of phase `const`; the main
  session took the recommendation). A std output change: records carry their type's short name at runtime, through a
  `WeakMap` that each record constructor and the runtime's places that build std records fill, so `std.text.show`
  prints `Port(value: 8080)` and a record with a `String` field `tag` no longer shows as a case; equality untouched. A
  program that shows a record prints differently now; in the tests only the `NET_STDOUT` pin changed. In
  `decisions.md`, Semantics and runtime (Records in `show`, Representation in TS).

- Constants (item 23, 2026-11-14; the main session took every recommendation of `docs/plans/const.md`, C1 to C16,
  built without the user's review). Language changes first: C1 the form `const shop.max_items` with `doc`, `out` and
  `body` (statements ending in `return`), a snake_case name with a module, `result` and `error` naming no constant
  (E0109); C2 a constant is used without parentheses (`limit()` is E0247, with a fix), and a dotted name whose head
  is no local is read from the left (an own constant and its fields, a constant or function by its whole path, a
  constant prefix and its fields), two readings being E0249 without a fix, and a local hiding a constant of its
  module (written in full there, not E0226); C3 pure (E0233 with its own message), no `effects` and no examples; C4
  evaluated once, lazily, every constant at acceptance before the examples, a trap there E0404 at the constant it
  came from, once per cause and once per cycle, examples that trap inside one unreported, and no static cycle check;
  C5 not `Unit` and not a function type (E0248), function types inside allowed. The others: C6 a pure function
  without parameters stays legal, E0401 gives it the constant's text (E0405 reserved); C7 `replace` may turn a `fn`
  into a `const` of the same name or back, an interface change (E0506 "changes from a `fn` to a `const`"); C8 a
  constant's interface is its `out`, not its value; C9 hits `const name: Type`, constants not in `search_type`; C10
  `context` gives a used constant's whole text, `signature` its `doc` and `out`; C11 a database made before
  constants is migrated on open by SQLite's table rebuild, its history kept; C12 the habit diagnostics (`const` in a
  body E0006, `MAX_ITEMS` E0002, a PascalCase name E0002, the one-line form and a fn's sections E0101, `n < limit`
  E0204 with `()`, `MaxItems` E0203); C13 constants as `$rt.constant` getters and `$constants`; C14 the codes E0247
  to E0249 and E0404; C15 the card (K1 to K5); C16 the spec's `shop.sizes`. Mine beyond the plan: a constant, or a
  field of one, is applied by position like a local's field (`ops.double(2)`, the plan predated fn-types), named
  arguments on it are E0220 with the application as fix, and a constant applied as a function (`limit(1)`) is E0238;
  E0247 only when no local takes the name; the `rank` follow-ups (E0237 gives a pure `fn` without parameters and contracts
  whose result is no function itself the constant's text, and then E0401 is not reported beside it; for other functions it
  adds "For a lookup, return the name and apply the function where it is used; a table of functions is a `const`.")
  as their own commit after commit 1, so the cut order cannot drop them; K5 (`const` out of the card's "Not in
  alang") in commit 1, so each commit's docs are true; E0404 leaves out `(at …)` when the trap's location is the
  constant itself (a stack overflow); E0401 keeps the form of an example where no constant says the same (a result of
  `Unit` or a function type, or a contract), so no `expected` points to a form the checker rejects; `alang test` evaluates the constants before the examples too (one load); E0203
  names a constant only for a bare `MaxItems`, without a value; the tests in two new files, `tests/const_test.ts`
  and `tests/const_db_test.ts`, with their own TypeScript check, instead of spread over the plan's eight files. In
  `decisions.md`: Lexical (Foreign forms), Syntax (`const`, `a.b.c`), Semantics and runtime (Representation in TS),
  Type checking (Names, Own module names, Constants, Function values, Function results), Examples and acceptance
  (Constants, Missing examples), Database (`context`, Constants), MCP server (Hits, Card), Temporary limits, Open
  questions (Form of `extern fn`, Rejecting a pure function without parameters, A constant named in a contract).

## Database phase: open points (2026-11-12)

The plan of this phase is built; `decisions.md` (Database) records every point. Still open:

- **Rename departs from 6.1** ("changes only the pointer; no caller needs to be adapted"). References stay names, so
  `rename` rewrites the callers and each gets a new version. Needs the user's confirmation, or a decision to move to
  hash-linked storage (the recorded alternative).
- **Earlier decisions this phase leans on**, still awaiting the user's review:
  - Case names are unique per module, so moving a variant type renames its cases.
  - Over-declared effects are allowed, which is why removing an effect is compatible.
  - Examples call their own function, so `rename` rewrites them.
- **Diagnostic codes E0501 to E0513** are in use: stale hash, unknown name, name exists, not one definition, name
  differs, interface change, remove with callers, name touched twice, invalid new name, rename capture, malformed
  type pattern, definition in the wrong export file, export and database both changed.

## From the database (2026-11-12)

- **Capture is only possible through locals.** A call path always means a module function, and a new name that
  exists is E0503, so the only way a rename can change what a reference denotes is a local binding with the new
  name (function values) or with the new module's first segment (method-call reading). E0510 covers both.
- **Every submit loads, parses and accepts the whole program**, and the write compares every name with the snapshot.
  Fine for the prototype; a large codebase wants a cached parsed program and acceptance limited to the changed
  definitions and their dependents (see "Examples as a regression net").
- **Queries parse on demand.** `list`, `search` and `context` parse stored texts to read `doc` lines and case lists.
  A `doc` column, or a cache of parsed definitions per hash (texts never change), would remove that.
- **The export can lag behind the database**, when its write fails after the commit. The sync now redoes the write
  at the next operation (decisions, Sync), so it is no longer lost; the failed submit still throws.
- **Import trusts file names for modules only.** A hand-edited export may hold non-canonical text; import accepts it
  and stores the canonical form, so the next export rewrites the file. A check mode ("is the export canonical?") would
  suit CI.
- **`search(type)` cannot express function types**, since alang has none (open question). A std parameter like
  `with: (T) -> U` only matches `_`. Resolved (item 22, F9): a pattern writes function types,
  `List<_>, (_) -> Bool -> List<_>`.
- **`refs` rows depend on the text alone** once cases are stored by their own name, which is what makes reusing a
  version (revert, remove then add) safe without recomputing anything.

## From the MCP server (2026-11-12)

- **Run against Claude Code, not the official SDK client.** The tests drive the server with my own reading of the
  protocol, in process and over stdio. Claude Code connected and used queries, `add`, `replace`, `rename`, `remove`
  and `submit` in the playground, which settles the protocol for that client. The official TypeScript SDK client was
  not run, since downloading it was not permitted in the session.
- **MCP changed shape in 2026-07-28.** The `initialize` handshake is gone; each request names its version in
  `_meta`, and `server/discover` replaces the handshake. The server serves both eras, so it works with clients from
  before and after. When the old era is dropped by clients, `initialize` and the legacy result shapes can go.
- **Texts arrive JSON-escaped.** The model reads a definition as a JSON string with `\n` and indentation spaces inside
  it, and writes one the same way as a tool argument. Results are kept identical to `alang db` for now; if the model
  stumbles over indentation, a result form with the canonical text as its own text block would be the fix.
- **The spec is not reachable through the server.** A model that only has the MCP server (no repository) learns the
  syntax from `context` results and diagnostics alone. The spec, or a short syntax card, could be an MCP resource.
- **The module cache grows per submit.** Each acceptance imports a freshly written module that is never unloaded
  (see "From mandatory examples"). In a long-running server that is one module per submit; a worker or subprocess
  per acceptance would release them.
- **No time limit on examples.** A submit with an exponential example blocks the server, and with it every later
  tool call (calls run one at a time). The same subprocess would bring a timeout.
- **The hash is the only state the model keeps.** A rejected change returns `current`, an accepted one `written` with
  the new hashes, so a model can chain changes without re-reading. Whether it does so in practice is worth watching.
- **First contact (playground, task "overview").** The model used the tools (the first query's sync imported the
  seeded export) and summarized all five definitions correctly, rule 5.1 included. It told the user that
  `export/*.alang` is "a generated copy, so don't edit it by hand", taken from the server's instructions, which called
  the export generated. That contradicts the export as source of truth (hand edits and pulls are read back); the
  instructions now describe the export as the database's copy for Git, read back before each call.
- **Playground, tasks "is_privileged" and "parse_or_default".** Both accepted, with good choices the rules did not
  force: `is_privileged` takes a `Port`, not an `Int`; examples sit at the boundary (1023, 1024); `parse_or_default`
  reuses `parse` through `let ... else`. The first try of `parse_or_default` wrote `net.port.parse` inside `net.port`
  and was rejected (E0226); with the fix in the diagnostic it recovered in one step. First evidence for the own-module
  rule awaiting review: the long form is what an LLM writes by habit. Decided (the user, 2026-11-12): submit and
  import now shorten it themselves and list it under `fixed`, since the stored text and hash are the same either
  way, while a rejection costs a whole transaction. The instructions now state rule 1.2 as well. Watch in the next
  round whether the model still writes the long form, and whether it reads `fixed` or ignores it.
- **The E0226 fix was not always right.** The notes called it unambiguous; it is not where a function is passed as a
  value and a local holds its short name (`by: m.backwards` with a parameter `backwards`): `by: backwards` means the
  parameter (E0204), so the program had no accepted spelling short of renaming the parameter. Calls, types, cases
  and patterns cannot be captured (a path before `(` is always a call; locals are never PascalCase). The checker now
  accepts the full name there. The same capture is what E0510 reports for renames; a rename could now write the full
  name instead of refusing, which is not built.
- **Playground, task "rename a parameter".** Renaming `text` of `net.port.parse` to `source` went through as one
  transaction with its caller (4 calls); the diff is exactly the change, and it kept `std.int.parse(text: source)`,
  where `text` is std's parameter. Not yet known whether E0506 was hit or the callers were read in advance. A
  parameter rename is as mechanical as a definition rename, yet the model has to send every caller's full text; a
  tool operation for it (rewriting callers like `rename` does) would scale where twenty callers would not.
- **Playground, task "clamp with swapped bounds".** Accepted, and the model rewrote the `ensures` for both orders
  without being told, dropped the `requires`, and mirrored the three examples with swapped bounds. It swapped by
  self-recursion: there is no reassignment, and std has no `std.int.min`/`max` (only `parse`, `to_float`,
  `compare`), which would have made the body one line (they exist since item 15). Not exercised, but close: contracts are compared as printed,
  so dropping a `requires`, a pure loosening, would have pulled every caller into the transaction (E0506) had there
  been any. A proof of implication (5.2) would let loosened `requires` and tightened `ensures` pass.
- **Playground, task "rename a type".** `ParseError` to `PortError` in one call; history as designed (`rename` with
  the old name, `follow` for `parse`, a hashless `rename` for the old name), and the model explained correctly why
  `parse_or_default` did not change. The export diff looks larger than the change, since a renamed definition moves
  to its new sorted place in the module file; a reviewer reading `git diff` sees a deletion and an insertion.
- **Playground, task "greet and main".** Accepted in one transaction: `std.string.concat` found (not `+`),
  `examples: none` for the effectful function, short names inside the module, and it offered (did not do) the split
  into a pure `greeting` with examples and a thin `greet`, as the spec advises. Then it wanted to run the program and
  could not: the server has no way to run code, and `alang` is not on the PATH. Deeper gap: `alang run` takes one
  file, so a `main` that uses several modules cannot be run from the database at all. Options: `alang db run`
  (assemble the program from the database, run `main` with the permissions of its effects), and later an MCP `run`
  tool, which would be the first tool with real effects.
- **Playground, task "remove with a caller".** The model checked first, then asked the user what should happen to
  `parse_or_default` (inline or remove too) instead of deciding; both went in one transaction. Afterwards it noticed
  `PortError` was unused and asked again rather than tidying up. Then the export file was restored from Git (as a
  pull would): the next query's sync imported both definitions with their old hashes (texts byte-identical, so the
  stored versions are reused) and history operation `import`. Undo through Git works without any tool support.
- **The model answers from memory after the codebase changed.** After the restore through Git, asked "which
  functions in net.port can turn text into a Port?", the model made no tool call and answered "none", from its own
  removal a minute earlier; it also called `PortError` unused although `parse` used it again. Nothing had told it
  that the codebase changes outside the conversation. The instructions now say so and ask for a fresh query when
  answering about the current state. A further step, not built: when a sync imports something, add a block to the
  result naming what changed outside the conversation. That only helps once the model makes a call, and only in the
  server process that did the import (here the import happened in a second process, from a manual check).
- **With the instruction, it queries.** After reconnecting, the same question got two tool calls and the right
  answer; the model said it checked instead of repeating itself, found the `import` in `history`, and asked whether
  the restore was intended. Two flaws remained. It pictured export and database as copies synced by occasional
  imports ("the export files might restore them on the next import, so you may want to re-export"), so the
  instructions now say that both directions are automatic and that it never exports or imports. And it guessed the
  import happened "around when alang was reconnected" (it was a manual check from another process): `history`
  records `import` but not what triggered it. Recording the source (the sync of a query or submit, `alang db import`,
  and the file) would let a model explain an import instead of guessing.
- **Playground, task "String to Int".** Found `std.int.parse` in three calls, explained `Option` against the
  `Result` of `net.port.parse`, and ruled out `std.string.length`. `search_type` matches the result type exactly, so
  `String -> Int` misses `Option<Int>` and the model searched again; matching through `Option`/`Result` (as Hoogle
  does) would find it at once. The freshness instruction showed up in the answer ("these signatures come from that
  fresh search"); watch whether that persists in a session without a stale answer to correct.
- **Playground, task "stale hash".** The user edited `doc` in `export/math.alang` by hand after the model had read
  `math.clamp`. The model's `replace` (with the old hash) first synced, importing the edit, and was rejected with
  E0501; it rebuilt the change on `current` without another query, kept the user's doc line, and asked before
  fixing two typos in it. It did not re-read before writing despite the freshness instruction, and needed not to:
  the instruction keeps answers current, the guard (6.7) keeps writes safe.
- **The model reports hashes to the user.** Both answers ended with "Its new hash is ...". Harmless, but the hash is
  for the model's next call, not for the user; the instructions could say so if it gets noisy.
- **E0513's message names commands** (`alang db import`, `export --force`) that the server's instructions tell the
  model not to run. A model with a shell may still run them; the diagnostic could carry a hint that it is for the user.
- **Playground, task "HTTP server"** ("a simple http server on localhost that shows hello world in the browser").
  Accepted in two `add` calls: a pure `web.respond` with two examples (`/` and `/favicon.ico`) and `web.main`, which
  serves it on `localhost:8080` and prints the `Err` case. The model ran it, checked it with curl (200,
  `Hello, world`) and stopped it (see "From db run"); its report named what it had not tried (a browser, the error
  path). Two harmless flaws: the handler is a lambda that only calls `respond` (`handler: fn(request: ...) =>
  respond(request: request)`) where `handler: respond` would do, perhaps because the signature reads
  `(std.http.Request) -> std.http.Response with effects`; and `Listening on` is printed before `serve` knows the port
  is free (see "From async output and std.http").
- **std cannot be read through the tools.** `search "http"` listed the `std.http` types with their docs, and
  `search_type` found `serve` on the third try (a pattern matches the parameter count exactly, so
  `_ -> Result<Unit, ServeError>` missed it). But the fields of `Request` and `Response` were out of reach:
  `context`, `definition`, `signature` and `list std.http` answer E0502 ("There is no definition
  `std.http.Request`") for a name `search` has just returned. The spec does not describe `std.http` either, so the
  model grepped the repository and read `src/std.ts`; a model with only the server would have had to guess the fields
  from diagnostics. Not built: answer these queries for std names too. std types already exist as alang text (in
  `src/std.ts`); std functions do not, since they are in effect `extern fn`, whose form is undecided, but `signature`
  can give the line `search_type` prints, and `list std.http` can list the module. Done (branch `spec`): all of
  these, and `context(std.http.serve)` gives the line and the fields of the four types it involves.

## From db run (2026-11-12)

- **The MCP `run` tool is not built.** `Codebase.run` takes the `RunOptions` of `alang run`, so the tool would be a
  thin layer, but it needs more than that: piped output returned as the result (stdout and stderr apart, with the
  exit code); a time limit, since tool calls run one at a time and a program that never ends would block every later
  call; stdin closed; a working directory (the codebase's, presumably, since the model has no other); and annotations
  that say it is neither read-only nor closed-world. It would be the first tool whose effects reach outside the
  codebase, so a client should ask the user before each call. The README's registration line would need
  `--allow-run`.
- **Exit code 1 means two things.** Diagnostics end `db run` with 1, and so does a program that crashes with a
  JavaScript error (a stack overflow, see "From mandatory examples"). A trap is 70. alang programs cannot choose
  their exit code yet, so only a crash collides; once they can (a std function, or `main` returning a code), the
  tool's own codes need a range of their own.
- **Two runs of one `main` share files.** `out/<main>.ts` is a stable path, so two processes running the same `main`
  at once may overwrite each other's build; with an unchanged database both write the same text. Per-run files would
  close this but leave nothing to look at afterwards.
- **Every run re-runs every example.** Fine for the playground; for a large codebase the same limit to changed
  definitions as for submits (see "Examples as a regression net") would apply, or a run could trust the database.
- **Stale acceptance files.** The playground's `out/` holds three `accept-<pid>-1.ts` from MCP server processes that
  ended without `close()`. Not checked why; a guess is that the client killed the server instead of closing its
  stdin, so the `finally` never ran. Harmless, but they pile up; the server could close on SIGTERM, or opening a
  codebase could remove the files of processes that no longer exist.
- **Running a file from anywhere.** `deno task alang run x.alang` resolves `x.alang` from the repository root, since
  `deno task` runs in its config's directory. `deno install --global ... -n alang src/cli.ts` gives an `alang`
  command that works from any directory and needs no reinstall after changes (README). `alang run` then writes
  `out/` into the current directory; a temporary directory would leave no trace, but the generated TypeScript is
  useful to look at.
- **The playground now knows `db run`.** Its `CLAUDE.md` names `alang db run` (the user installed `alang`). Watch in
  the next round whether the model runs a program after writing a `main`, and whether it reads the JSON on stderr
  when a run is refused.
- **It does run them.** After writing the HTTP server, the model started `db run web.main` in the background on its
  own, but through `deno run ... src/cli.ts`: it told the user `alang` was not on its PATH without having checked (it
  was, in `~/.deno/bin`, where its `deno` came from). A refused run has not happened yet. It stopped the server by
  finding the program's own process (`out/web.main.run.ts`) and sending it SIGINT; `serve` returned `Ok` and both
  processes ended with 0. SIGINT sent to the `alang` process alone would have done nothing, since `alang run` ignores
  it while the program runs (Ctrl-C in a terminal reaches both, and the program should get it once); SIGTERM is
  passed on. A model that signals the PID it started (`kill -INT $!`) would see the server keep running. The tool
  cannot tell a terminal's SIGINT from one sent to it alone; passing on SIGTERM if the program is still running a
  moment after a SIGINT would cover both, or the playground's `CLAUDE.md` could say to stop a program with SIGTERM.
- **Every MCP session leaves an acceptance file.** The fourth `out/accept-<pid>-1.ts` is from the server of the HTTP
  task (written at its last `add`, no server process left afterwards). So it is not an occasional crash: the client
  ends the server in a way that skips `close()`, most likely SIGTERM, which Deno answers by exiting at once. A
  SIGTERM listener in `mcpMain` that closes the codebase would fix it. Done (branch `spec`): closing stdin cleaned
  up, but SIGINT, SIGTERM and SIGHUP each left the file (checked). The file is now removed right after each
  acceptance, which covers SIGKILL too, and the server closes on the three signals.

## From async output and std.http (2026-11-12)

- **Deep recursion with effects no longer overflows.** Every `await` unwinds the JavaScript stack, so a function
  with effects that recurses 200,000 times runs to the end; before async output it crashed with a stack overflow.
  The price is memory: each pending call waits for the next. Pure recursion still overflows (see "From mandatory
  examples"); self tail calls turned into loops would fix both.
- **A trap ends the whole server.** That is the language's rule (5.3), but a server faces untrusted input: an
  `Int` overflow on a number from a query, or a header value echoed with a line break, ends the program for every
  client. Validating input is the programmer's job, as everywhere in alang; a per-request trap boundary (500, keep
  serving) would be a language decision, since it makes traps catchable in one place.
- **Routing is by exact path only.** std has no `starts_with`, `split` or query parsing, so `/users/42` cannot be
  taken apart, and `query` is one raw string. The next std functions a server wants: `std.string.split`,
  `std.string.starts_with`, and a query reader returning `List<std.http.Header>`-like pairs (or a `Map`, once maps
  have functions). Since items 14 and 15, `split`, `starts_with` and `cut` exist; a query reader does not.
- **Handler examples are long.** A `Request` needs all five fields, headers as `std.list.empty<std.http.Header>()`;
  one example line of `examples/server.alang` is ~200 characters. List literals (item 15) shorten it somewhat;
  so would a pure helper in the user's module. It is still the strongest part of the design: the server's logic is
  tested at acceptance, before any request.
- **Content is text only.** No binary bodies (images, files); the runtime decodes UTF-8. Bytes would need a byte
  type, which alang does not have.
- **The program cannot see that it listens.** `serve` prints nothing and returns only at the end, so a program
  that announces its address prints before knowing the port is free, and port 0 (any free port) is useless. A
  callback or a `serve` variant reporting the bound address would fix it; tests pick a free port beforehand.
- **`net` is all or nothing.** `--allow-net` grants every host and port. A capability (recorded alternative)
  could grant exactly `127.0.0.1:8080`.
- **The handler exception is std-only.** A user function cannot take a function with effects, since user code has
  no function types. If function types arrive, the `with effects` mark needs a surface form. Decided (item 22,
  F3): user function types are pure, so `with effects` stays std's mark and is E0101 in user code.
- **Adding an effect to a handler** is an interface change, and `main` passes the handler by name, so it is a
  caller: the change pulls `main` into the transaction (E0506), where it must declare the effect. Consistent with
  calls, not tested separately.
- **The Node.js path is tested end to end** (requests, SIGTERM, a port in use); the in-process tests (one at a
  time, traps, headers) run on Deno only. `EACCES` is mapped on both hosts but not run, since it needs a port
  below 1024 without root.
- **One handler at a time is slow** for a handler that waits (a file read, later an outgoing request). Concurrency
  would be a language feature with its own rules; the queue is where it would start. Since item 20 the outgoing
  request exists: `std.http.send` or `std.time.wait` in a handler holds every other request, and a handler that
  sends to its own server waits for itself until its timeout (7.8 says both).
- **`std.text.show` prints a whole Float without its fraction.** `std.text.show(value: 2.0)` gives `2`, as
  JavaScript prints the number, so a `Float` and an `Int` look alike in output. Found while writing section 7 of the
  spec, which states it as is. Printing `2.0` (the alang literal) would match the canonical text and the actual
  values of failing examples; it is a change of std behaviour, so not made unasked.

## From the export sync (2026-11-12)

- **Deleting an export file deletes a module.** With the export as source of truth, a file removed by a pull, or by
  hand, removes its module's definitions at the next sync (history keeps them). Only a missing export directory is
  read as "not written yet". A typo in `--dir` is therefore harmless, but `rm export/net.port.alang` is not.
- **The MCP server must sync before queries.** `Codebase` queries are synchronous and read the database as it is; the
  command line calls `sync()` first. A long-running server has to do the same per request, or its answers go stale
  after a pull (the guard would still catch the stale hash at submit, one round trip later). Done: `mcp.ts` syncs
  before every query.
- **Every operation reads every export file.** Fine for the prototype, like accepting the whole program per submit.
  A large codebase could compare file modification times first and hash only the files that changed.
- **A pull during a submit is caught, with one window left.** After acceptance the submit compares the export again
  and starts over if a file changed; each write first checks that its file still holds what the codebase last wrote
  or read. Between that check and the rename of the new file there is no lock, since files have no compare-and-swap;
  a pull landing in those microseconds is overwritten. A lock file honoured by Git hooks would be the only full fix.
- **A pull right after a commit ends as E0513**, at the next operation, although the submit reported success. The
  result could say which files it left alone; it does not yet, since the next operation explains it.
- **`OpenOptions.during`** is a hook for tests (stages `accepted` and `committed`), the only way to put a pull inside
  a submit deterministically.
- **A rejected submit can still change the database**, through the import of its sync. That is deliberate (the files
  are the truth), but it means "a rejected transaction changes nothing" holds only for an export in step.
- **E0513 has no automatic fix.** Which side should win is the user's call; an LLM caller should report it rather than
  run `import` or `export --force` on its own.

## From rename with text (2026-11-12)

- **A spurious interface change came with renames.** Renaming a type and replacing a function whose signature names it,
  in one transaction, reported E0506 for the function's callers: the replace was compared with the version before the
  rename. Both `replace` and `rename` with text now compare with the renamed form. Found while building the latter.
- **6.1's table says `rename` changes only the pointer.** With text it changes the definition too, so the operation
  table of section 6 no longer describes `rename` fully. If the spec is revised for "References stay names", this is
  a good moment to document the optional text as well.
- **An MCP tool for rename** should expose the text as an optional argument; an LLM that wants to rename and edit will
  otherwise submit two transactions, and the second needs the hash the first returned. Done: `rename` has `text`.

## From the spec reference (2026-11-12)

- **A blind test.** A fresh agent that read only `alang-specs.md` (not the sources, without running anything) wrote
  three programs: list and text helpers, a file reader that tells a missing file from other read errors, and a shop
  with a record with `where`, a discount variant, a total by `fold` and an HTTP route. All three were accepted by
  `alang check` on the first try, examples included. It listed 17 points where it was unsure; those with an answer
  in the implementation are now in section 7 (how `show` prints cases and numbers, operator grouping, `join` and
  `trim`, constants need examples, no `match` in conditions, no `_`, locals named like functions or modules, the
  working directory, file order, long lines, examples that break `requires`).
- **A name after nested cases is a catch-all.** `case Err(std.fs.NotFound)` followed by `case Err(other)` is
  accepted: exhaustiveness is met, and no earlier case covers `Err(other)` entirely. But `other` stands for every
  remaining case of `std.fs.ReadError`, so a case added later is not reported there, which is what 3.3 forbids a
  catch-all for. The blind agent read 3.3 strictly and listed every case. Options: reject a name in a position
  where an earlier case of the same `match` named a specific case (list them all), or accept it as now. Decided
  (the user, 2026-11-12): rejected, E0227, with the cases to write as `expected`. The blind programs and every
  example program still check.
- **Examples that cannot fail.** Not knowing how `show` prints `std.fs.IsADirectory`, the agent wrote
  `error_line(problem: std.fs.IsADirectory) == std.text.show(value: std.fs.IsADirectory)`: the expected side computes
  what the body computes, so the example passes whatever `show` does. Section 7.7 now gives the text; such examples
  are hard to detect in general.
- **A parameter named like a module** hides calls into it: with a parameter `words`, `words.count(...)` is E0220, a
  method call. Inside module `words` the short form avoids it, but a natural name such as `net` or `config` blocks
  calls into that module. The diagnostic could say that the local hides the module.
- **Constants are clumsy.** A function with `in: none` stands in for `const`, but needs an example, which repeats
  the value (a list of three items took a 250-character example line). `const` would need none (5.1 covers
  functions). Resolved (item 23): `const` needs no example, and E0401 gives a pure function without parameters the
  constant's text.

## From files and program I/O (2026-11-13)

- **Bun and Windows are untested.** Bun takes the Node.js path (`process.getBuiltinModule`) but is not installed
  here. On Windows, the tests of links, file modes and `/proc` are skipped, and nothing else was tried.
- **The hosts differ on guarded paths.** Deno refuses `/proc/version` even with `--allow-read` ("Requires all
  access"), so `std.fs.read_text` gives `Err(PermissionDenied)` there; Node.js reads it. The same program can thus
  give different results on the two hosts, against runtime neutrality. Only the system's pseudo files are affected.
- **Deno refuses the empty path itself**, before the permission check and without an error code ("Empty path is
  not allowed"). The runtime maps an empty path to `NotFound`, which Node.js reports as ENOENT; without that, it was
  `Other` on Deno only.
- **`--allow-env` comes with the arguments.** A program that only reads `std.env.args()` declares `env` and may then
  read every environment variable. The alternative of D4 (`std.program.args` under the same effect) would not
  change that; only an effect of its own, outside the closed table of 2.2, would.
- **Collecting lines is quadratic.** `std.list.append` copies the list, so a recursion that reads every line with
  `std.console.read_line` and appends it takes time proportional to the square of the line count. `split` of a
  whole file does not have the problem.
- **No path helpers.** Joining with `std.string.concat` and `/` works on every system; a parent directory, a file
  name or an extension cannot be taken apart without searching text, which std lacks. Since item 15, `std.string.cut`
  and `find` can take a path apart, by hand.
- **File logic has no examples** (5.4): every function that touches a file has `examples: none`. The shape that
  works is a thin `main` around pure functions with examples, as in `examples/lines.alang` (`sorted`).
- **The cases of `std.fs.Error` cannot grow.** E0227 forbids a catch-all and 3.8 freezes signatures, so a case added
  later would break every `match`. A finer classification (not a directory, already exists, not empty) needs a new
  type and new function names. One case was added before publishing anyway (item 20, N3: `AlreadyExists`), and it
  broke every such `match`, as foreseen.
- **A text ending in a line break** splits into an empty last part (`split("a\n", "\n")` is `a` and `""`). Every
  program reading lines must drop it; a `lines` function in std breadth could. Resolved (item 15):
  `std.string.lines` adds no empty last line.
- **The MCP server has no `run` tool.** One would need `args` and a closed stdin (`RunOptions.stdin`), so that a
  program waiting for input does not hang the server.

## From list literals and pure std (2026-11-13)

- **A `for` does not type a literal it iterates.** In `for x: Option<Int> in [None, Some(1)] do`, the declared type
  stands left of the list, yet the literal gets no expected type and `None` first is E0210. Passing
  `List<declared>` as the expected type would follow 1.4; it would also change where a wrong declared type is
  reported (today E0204 at the declared type, with a fix). Resolved (item 17, H4): a literal gets `List<declared>`;
  a non-literal iterable keeps E0204 at the declared type.
- **An empty actual list of function values** would print as `std.list.empty<Unit>()`: `toTypeRef` writes every
  non-named type as `Unit`. A non-empty one falls back to `std.text.show`. Rare, since examples cannot compare
  function values (E0222); the E0228 fix avoids the same mistake by offering no fix for such item types. Resolved
  (item 17, H5): such an empty list or map prints through `std.text.show` (`[]`, `[:]`), and the E0209 guess offers
  no type argument that holds a function type. Since item 22 (F8) only a function type without parameters has
  no written form; every other is written (`std.list.empty<(Int) -> Int>()`).
- **`std.list.range` is limited by memory, not by its trap.** The trap fires above 4_294_967_295 items, the length
  limit of a JavaScript array (checked: `new Array(2 ** 32 - 1)` works, `2 ** 32` is "Invalid array length"), but
  filling even a tenth of that exhausts memory first, with the host's own error, not a trap.
- **Collecting lines is no longer quadratic** when a file is read whole: `std.string.lines(text: content)` instead
  of appending each `read_line`.
- **E0228 quotes `[]` as printed.** Like every diagnostic it quotes canonical text, so `[ ]` or `[` and `]` on two
  lines are quoted as `[]`; the fix's `replace` then does not occur in the submitted text literally.

## From the ledger round (2026-11-13)

The playground round of the files and program I/O phase: the `ledger` task of `docs/plans/std-io.md`, section 6.
The three defects it showed are fixed on `std-io` (plan, section 7).

- **Accepted on the first try.** One submit of 14 definitions was accepted; no diagnostic appeared over MCP.
- **Discovery was not tested.** The model read the whole spec and used no query tool, so neither discovery
  (`list("std")`, `search`, `context`) nor the D5 names were put to the test.
- **The advisor confounds the result.** The playground model also consulted the advisor, so the first-try
  acceptance is not the model's alone. Run the next round without it.

Left for later:

- **`AlreadyExists` and an exclusive create.** An `AlreadyExists` case together with a function that creates a file
  only if none exists. `std.fs.Error` keeps its four cases, as the user decided in D2; settle this before
  publishing, since 3.8 freezes the cases. Resolved (item 20): `AlreadyExists` and `std.fs.create_text` (N3, the
  user's approval of 2026-11-13 reopened D2).
- **Checked arithmetic.** An overflow traps, so a program cannot turn it into a message. Resolved (item 15):
  `std.int.checked_add`, `checked_subtract` and `checked_multiply` return `Option<Int>`.
- **E0227 duplicates arms.** When every case but one is handled alike, each of them still needs its own arm.
  Resolved (item 21): shared cases `case A or B then`, and E0227's `expected` names the remaining cases in one such
  case. The planner found that `check_output` itself is served better by `==` plus a let-else (5 lines instead of
  12), since its body needs the error value that no shared case can name.
- **Propagating a `Result<Unit, E>`** takes a dummy binding: `let x: Unit = ... else return Err(error)`. Resolved
  (item 21): the statement `expression else return ...`, and a `let` of type `Unit` is E0235.
- **Verbosity** from the missing list literals, the two-argument `std.string.concat` and no `std.string.lines`.
  Resolved (item 15): list literals, `std.string.join(parts: [a, b, c], separator: "")` for several texts, and
  `std.string.lines`.
- **`cat` instead of the query tools.** The model read `export/*.alang` with `cat`; this belongs to the phase that
  serves the spec through the MCP server.
- **Negative zero.** `std.int.parse("-0")`, `0 * -1` and `-7 % 7` give JavaScript's `-0`. `std.text.show` prints it
  as `0` and `==` treats it as 0, but `std.int.to_float` of it is `-0.0`, and `1.0 / that` is `-Infinity`. A general
  Int issue: normalizing `-0` to `0` in the Int operations and `parse` would close it. Resolved (item 15): an `Int`
  is never `-0`; the runtime normalizes every Int result.
- **A fix's `replace` text can match elsewhere.** The E0005 fix replaces `\r`, which also occurs inside an escaped
  backslash (`\\r`). This holds for every E0005 fix; a fix located by position would not have it.

## From the wordcount round (2026-11-13)

The playground round of phase 1 (`list-literals`): a model wrote a `wordcount` tool through the MCP tools.

- **Accepted on the first try.** One submit of 13 definitions was accepted; no diagnostic appeared. 10 tool calls,
  3 min 50 s. The advisor was not called, so the result is the model's own.
- **The spec instead of the tools.** The model read the whole spec and used no query tool. To learn what list
  operations cost, it grepped alang's own `src/runtime.ts`; the costs are now in 7.8 and in the doc lines of
  `std.list.append` and `std.list.concat`.
- **List literals took.** They appear in bodies and in examples. Every empty list was written
  `std.list.empty<T>()`, so E0228 never fired.
- **std breadth was used.** 13 of the 30 new std functions appear in the program.
- **Counting by sort and runs.** Without a Map, the model counted words by sorting them and counting runs of equal
  neighbours. 7.1 now names this way, in the row "Functions on `Map`".

Left for later, each with its phase of the roadmap (`docs/plans/list-literals.md`, section 0):

- **Unwrapping an `Option` inside a lambda** needed a helper function of its own, since a lambda is one expression
  and `match` or `if` cannot stand inside an expression (E0303). `std.list.filter_map` (or similar) and Option
  helpers such as `std.option.with_default` would remove it. Phase `std-maps`, next to `any`, `all` and `find`.
  Resolved (item 17): `std.option.with_default`, `std.option.map` and `std.list.filter_map`.
- **Trimming a given set of characters took seven `let` lines**, since `std.string.trim` removes whitespace only.
  `take_while` and `drop_while`, or a trim that takes the characters, belong to phase `std-maps` ("remaining text
  helpers"). Resolved (item 17): `std.string.trim_characters`, and `std.list.take_while` and `drop_while`.
- **No std way to turn a `std.fs.Error` into text**, so every program repeats the same four-arm `match`. Phase
  `std-net`, which reopens `std.fs.Error` anyway (N3). Resolved (item 20): `std.fs.describe`.
- **Discovery through the tools is untested for the second round.** The playground's `CLAUDE.md` and the MCP
  instructions (`SPEC_LINE` in `src/mcp.ts`) send the model to the full spec, whose 7.8 lists all of std, so
  `list("std")` and `context` add nothing. The phase that serves the spec through the MCP server; to test discovery,
  replace the spec pointer with a short card. Built (item 16): the instructions now send the model to `card`; the
  playground's `CLAUDE.md` still has to follow.
- **A byte order mark cannot be written readably.** `"\u{FEFF}"` is E0005 ("`\u{...}` is only for control
  characters"), and its fix inserts the invisible character itself. An open language question for 7.2: allow
  `\u{...}` for invisible format characters too. Listed in `decisions.md`, Open questions.

## From the card (2026-11-13)

- **Clients cut server instructions.** Claude Code passes at most 4,096 characters of an MCP server's instructions,
  and of a tool description that loads up front, to the model (2,048 before v2.1.296); a tool description loaded
  through tool search gets 16,384. `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` (from v2.1.280) replaces both limits.
  Sources: code.claude.com/docs/en/mcp.md ("Tool search for MCP server authors") and the Claude Code changelog;
  whether instructions from `server/discover` are cut the same way is not documented. The instructions were 2,454
  characters before the card and are 2,694 now; card and instructions together would be over 11,000. So the card
  is a tool. If the round shows that the model skips `card`, the options are raising the limit in the playground and
  serving the card in the instructions (a small change to `INSTRUCTIONS` and its tests), or a short core of the
  card in the instructions.
- **`_` as a pattern is E0002 with an empty name**: "written in snake_case: ``". The message could name `_` and
  say that every value in a pattern gets a name.
- **`if` inside an argument or a lambda passes `checkProgram`**; E0303 comes from the emitter during acceptance, so
  `alang check` and the tools report it, but only after every check of the program has passed.
- **One-line `if`.** `if c then return a end if` on one line is accepted and stored on three lines; the card points
  to its program instead of showing the one-line form.
- **Keywords name nothing, fields included.** A record field `in` or `type` fails with "A record has at least one
  field"; `result` and `error` work as fields, as 7.2 says.

## From std-maps (2026-11-13)

- **A non-empty list or map of function values shows as JavaScript source.** `showValue` falls back to
  `std.text.show` for a value without an alang form, and `show` of a function value is `String(fn)`, the generated
  TypeScript of the lambda. Only reachable in an actual value, since examples cannot compare function values
  (E0222); an empty one now prints `[]` or `[:]` (H5). Since item 22 (F4) no actual value holds a function
  value, as no `fn` returns one; the fallback stays as a guard.
- **The card is at 157 of its 160 lines** (9,279 bytes of 10,240) after the two edits of this phase. The next rule
  on it needs a line taken out elsewhere, or a higher guard. (158 lines and 9,372 bytes after item 18.)
- **A duplicate map key is reported at the later entry** (`"a": 2`), which is canonical text; like E0228, a fix
  located by quoted text could match the wrong place, but E0234 has no fix.
- **Discovery is still the open question for the next round** (plan, section 6): every new rule is in a doc line,
  but `context` of a std function is one call per function. Checked against the plan's table with `alang db search`:
  every word finds what it predicts except two. "look up" finds nothing, since the doc of `std.map.get` says "Looks
  up" (the substring "look" finds it); "tie" also finds `std.float.to_fixed`, through "Infinities" (since item 18
  through "tie" itself; rerun after item 18, every word finds what it found before). `search_type` gives exactly the
  plan's hits for all seven patterns.
- **A mistyped local as a map key gets the quote fix.** `[nmae: 1]` with a local `name` is E0203 with the fix
  `"nmae"`, not the closest-name fix `name`, since the hint applies to every unknown one-segment name (as planned).
  A key is far more often meant as text than as a misspelled local, but both readings fit the message.
- **The plan's `logstat` key lines are accepted** (checked in a scratch program, not a test): a lambda nested in the
  lambda of a `fold`, a record-valued `Map` updated through `std.option.map` and `with_default`, `with: parse_line`
  passed to `filter_map`, and a sort by two keys with `then_by`.

## From the logstat round (2026-11-13)

The playground round of `std-maps` (its plan, section 6): a fresh Opus session wrote a log summarizer, `logstat`,
through the MCP tools only, with the card instead of the spec and without the advisor.

- **Accepted after one wrong example.** The first submit failed one example (E0402; the model's own arithmetic in the
  expected value), and one resubmit was accepted: 13 definitions, 46 tool calls (`card` 1, `list` 15, `context` 23,
  `submit` 2), 3 min 27 s. No reads of the repository or the spec. The output is byte-identical to a Python reference
  on Deno and Node.js, and 13 edge-case logs agree as well.
- **The card worked for syntax and maps.** The map literal appears in 5 examples, never `{}` or `[:]`; `then_by` and
  `with_default` were used; counting with `fold` and `std.map.insert` was trusted from the documented costs, with no
  sort-and-count.
- **Confounded: the codebase was not fresh.** The playground database still held `ledger`, `wordcount` and others,
  and the model copied its fs error handling from `ledger.fs_problem`. So the round does not show that the card alone
  teaches `main` and fs errors. The next round should start from an empty codebase.
- **Discovery was `list` plus `context` per function.** The model called `card` first, then found std through `list`
  (15 calls) and `context` (23, 21 of them on std). 20 of the 21 std answers had `uses: []` and gave nothing beyond the
  signature line, and about 9 parameter lists were guessed from the `list` docs alone. Fixed (item 18): function hits
  carry their signature.
- **`search` and `search_type` were unused**, so the search word table of the plan is still untested by a model.
- **A slip worth knowing.** The model rejected negative numbers by checking the parsed value, so `-0` passed as a
  status and as milliseconds: `std.int.parse("-0")` is 0 by design (7.8), and 0 is not negative.
- **Two doc lines broke W1.** Edge tests showed that `std.float.to_fixed` rounds the exact binary value (`2.675`,
  `1.005` and `1.115` give `2.67`, `1.00` and `1.11` with 2 decimals, while the exact ties `0.125` and `0.625` give
  `0.13` and `0.63`), and that `std.float.parse("-0")` gives `-0.0`. Both were decided (R3, R4) and in 7.8's prose, but
  not in the doc lines, which are all a model reading std through the tools sees. Fixed (item 18), docs only;
  reproduced on Deno and Node.js before the change.
- **`-0.0` does not show.** `std.text.show` of the `-0.0` from `std.float.parse("-0")` prints `0`, and a failing
  example prints the actual value `Some(0.0)`; only `1.0 / x` giving `-Infinity` reveals the sign. Not changed.

What item 18 changed: the two doc lines; a `signature` field on every function hit of `list` and `search`
(`fn std.option.with_default<T>(option: Option<T>, default: T): T, effects: none`); the card, the MCP instructions and
the tool descriptions saying that hits carry it and that `context` is for examples, the body and uses (for a std
function only the types it mentions). Size of the MCP `list` results, in characters, before and after:

| Query | Before | After |
| --- | ---: | ---: |
| `list("")` | 59 | 59 |
| `list("std")` | 309 | 309 |
| `list("std.console")` | 411 | 580 |
| `list("std.env")` | 370 | 519 |
| `list("std.float")` | 2,355 | 3,254 |
| `list("std.fs")` | 1,680 | 2,450 |
| `list("std.http")` | 1,186 | 1,363 |
| `list("std.int")` | 1,488 | 2,258 |
| `list("std.list")` | 4,737 | 7,239 |
| `list("std.log")` | 234 | 312 |
| `list("std.map")` | 1,957 | 2,902 |
| `list("std.option")` | 419 | 627 |
| `list("std.order")` | 276 | 370 |
| `list("std.random")` | 265 | 348 |
| `list("std.string")` | 5,092 | 7,378 |
| `list("std.text")` | 220 | 295 |
| `list("std.time")` | 241 | 314 |
| Total | 21,299 | 30,577 (+44%) |

**Success metric for the next round:** std `context` calls drop from 21 to near zero, left only for examples or
uses.

Left for later:

- **No std way to turn a `std.fs.Error` into text.** The third program with the same four-arm `match`. Planned as
  N3 in phase `std-net`. Resolved (item 20): `std.fs.describe` (N4 of that plan).
- **Taking a list apart by position.** `case [a, b, c, d, e]` (or similar) would replace lines of `std.list.get` that
  cannot fail after a length check. Phase `statements`. Resolved (item 21): `let [a, b, c, d, e]: List<String> = parts
  else return ...` (T11); a `case` takes no list apart (T12).
- **Cheaper recovery after a rejected submit.** The resend of all 13 definitions after one failing example cost about
  25% of the round's output tokens. A way to resend only the failing definitions (or to keep the accepted part of a
  transaction) would cut it.

## From the tasks round (2026-11-14)

The playground round after `logstat-fixes` (`docs/plans/tasks-round.md`): a fresh Opus session wrote a to-do list,
`tasks`, through the MCP tools from an empty codebase, without the advisor. A fresh Opus agent analyzed it; its files
(Python reference written from the prompt, an 88-case runner with results on Deno and Node.js, the call table) are in
`~/coding_projects/alang-rounds/2026-11-14-tasks-manual/analysis/`.

- **The card alone was enough.** `list("")` was empty, so there was nothing to copy. `main` with
  `Result<Unit, String>`, the effects in table order and the card's `else return Err(...)` idiom were right the first
  time; the cases of `std.fs.Error` came from one `context` call. No diagnostic about `main`, effects or files.
- **std `context` calls: 2 (logstat round: 21)**, both only to learn a type's cases or fields (`std.fs.Error`,
  `std.string.Cut`). Signatures in function hits worked: 25 std functions called, every parameter name right.
- **`search` and `search_type` unused** for the third round in a row; discovery was eight module `list` calls (21 KB).
- **Correct.** All specified behavior matches the reference (81 of 88 cases agree; the rest are choices the prompt
  leaves open, plus the two alang issues below). Alignment right for 9, 10, 99 and 100 tasks; the file stays
  byte-identical after a malformed line for every command; no trap in 88 cases.
- **Effort.** 26 tool calls (alang 16: `card` 1, `list` 10, `context` 2, `submit` 3; Bash 7, Write 2, ToolSearch 1),
  21 definitions with 61 examples, 49k output tokens (35.6k without the incident below), 9 min 23 s (about 4 min 43 s
  without it). The first submit was rejected with E0005 for `\r` in an example; the fix helped, and the resend cost 18%
  of the output tokens.
- **The incident.** The user trashed the fresh `alang.db` 19 s after the MCP reconnect, while the server held it open.
  The server kept answering queries from the moved file and failed every write as "internal error". The model
  diagnosed it with 4 Bash calls, wrote two memory files into the playground's Claude memory
  (`~/.claude/projects/-home-josua-coding-projects-alang-playground/memory/alang-readonly-db.md` and its
  `MEMORY.md`), and waited for a reconnect. Those files load in every later playground session; removing them is the
  user's call. Automated rounds (`scripts/playground-round.sh`) do not see them.
- **Correction to the plan:** no `export.bak` exists; the old export files went to the Trash.
- **Two alang issues the reference found:** a file with bytes that are not UTF-8 is read with U+FFFD and silently
  rewritten (the doc line of `read_text` did not say so), and a dangling link gave `Other` ("Too many levels of
  symbolic links") on Deno but `NotFound` on Node.js.
- **The model's report** said `add write   the report` joined the spaces; the shell did that before the program ran.
- **Still forced by the language:** two dummy `Unit` bindings, `std.string.join(parts: rest, separator: "")` to take
  the one item out of a list, updating one task through `std.list.enumerate` with an index test, and the fourth
  four-arm `match` on `std.fs.Error` (`tasks.file_message`; `std.fs.describe` in `std-net` removes it, and after N3 it
  is E0213 in the user's playground export).

What item 19 changed (`tasks-fixes`): the MCP server reopens a moved or deleted `alang.db` (E0514 when a write fails
on a moved file); the card names `\u{D}` for `\r`; type hits in `list` and `search` carry a one-line `signature`
(`type std.fs.Error, variant: NotFound | ...`); the doc lines of `read_text` and `read_line` state their decoding; a
dangling link is `NotFound` on both hosts (writing through one creates no target, since Deno cannot resolve a link
without the read permission); a lexer error in a submit names its definition.

**Automated rerun** (the first round of `scripts/playground-round.sh`: headless Opus 5.5, no advisor,
`--restricted`, the same prompt, against `9d88f38` on `tasks-fixes`; folder
`~/coding_projects/alang-rounds/2026-11-14-tasks-auto/`, analysis by a fresh Opus agent):

- **First submit accepted**, no diagnostic: 16 definitions, 41 examples, 24 tool calls (`card` 1, `list` 10,
  `submit` 1, Bash 11, Read 1), 14.2k output tokens, 2 min 21 s, $0.68.
- **std `context` calls: 0.** The four cases of `std.fs.Error` came from the new type signature in the hit.
- **`search` and `search_type` unused** for the fourth round; ten module `list` calls (22 KB). With a std this small,
  browsing is rational.
- **Correct** as the manual round: 81 of 88 cases agree with the reference (wording of file messages, the documented
  dangling-link rule, the known U+FFFD rewrite); Deno and Node.js now agree on all 88 (manual program rerun on
  `9d88f38`: 88 too, the dangling-link fix).
- **Not exercised:** the `\r` card line (no CR example this time, so the accepted first submit is not to its credit),
  lexer naming, the database reopen.
- **Harness flaw, fixed:** under `--restricted` the round's `CLAUDE.md` never reached the model (no "do not read the
  repo" rule, no `search` nudge, no allowed-command list; one Bash call with `rm` and a shell function was denied).
  The script now passes it with `--append-system-prompt` and records `instructions=sent` in `done.txt`.
- **Same idiom twice:** both sessions found the first malformed line with a helper plus an identity `filter_map`;
  `std.list.find_index` added to the `statements` plan (T15). Resolved (item 21).
- One run per condition: run-to-run variance (the missing CR example) drives part of the difference to the manual
  round, along with no user, no CLAUDE.md, no memory files and a shorter system prompt.

Left for later:

- **Cheaper recovery from a mechanical rejection.** 21 definitions resent to change two characters. Either submit
  accepts the C escapes and stores `\u{D}`, reported under `fixed` as own-module names are (by position in the lexer,
  which avoids the `\\r` trap of text fixes), or a submit keeps its accepted part. No phase covers it.
- **Invalid UTF-8 as an error.** A program cannot tell a decoded U+FFFD from a real one; N3 in `std-net` reopens
  `std.fs.Error` and would be the place. A language decision; not taken, in item 20 either (a sixth case would
  break every `match` again).
- **`std.list.set` (or update) and a record-update form.** No phase yet; the `statements` planner judges them.
  Resolved (item 21) for `std.list.set` (T13); record update went to a new roadmap row 9, `records` (T14; see "From
  statements"). The two dummy `Unit` bindings and taking the one item out of a list are resolved too (T1, T11).
- **Writing to a real link loop from a write-only program** is `NotFound` on Deno and `Other` on Node.js; the one
  host difference left in `std.fs`.

## From std-net (2026-11-14)

Item 20, built from `docs/plans/std-net.md` in the overnight run. Host facts, on Deno 2.8.0 and Node.js 26.13.0,
observed with `deno run` and `node` scripts and in-process servers unless marked:

| Situation | Deno | Node.js |
| --- | --- | --- |
| Exclusive create (`createNew` / flag `wx`) on a file, a directory, a link to a file, a dangling link | `EEXIST`, with `-A`, `--allow-read --allow-write` and `--allow-write` alone | `EEXIST` |
| Exclusive create through a dangling link on the way (`nowhere/a.txt`) | `ENOENT`, all three permission sets | `ENOENT` |
| Recursive `mkdir` over a file / with a file on the way | `EEXIST` / `ENOTDIR` | `EEXIST` / `ENOTDIR` |
| Recursive `mkdir` over a dangling link, at the path or on the way | `EEXIST` | `ENOENT` (the runtime makes it `EEXIST`) |
| fetch: connection refused | `TypeError`, no code: "…client error (Connect): tcp connect error: Connection refused (os error 111)" | "fetch failed", `cause.code` `ECONNREFUSED` |
| fetch: name does not resolve | "…client error (Connect): dns error: failed to lookup address information…" | `cause.code` `ENOTFOUND` |
| fetch: nobody answers the connect (10.255.255.1) | not probed | `UND_ERR_CONNECT_TIMEOUT` after 10 s |
| fetch without `--allow-net` | `NotCapable`, "Requires net access to …" | — |
| fetch: `ftp:`, `u:p@` in the URL | "Url scheme 'ftp' not supported"; credentials ignored | "fetch failed"; `TypeError` for credentials |
| fetch to a bad port (25) / to port 0 | connects | cause "bad port" / `ECONNREFUSED` (its list starts at 1) |
| fetch: the server reads the request and closes without answering | sends it a second time, POST too (both at the same millisecond); "error sending request from 127.0.0.1:<ephemeral> for <url> (<address>): client error (SendRequest): connection closed before message completed" | sends it once; "fetch failed", cause "other side closed" (`UND_ERR_SOCKET`) |
| fetch: the server answers bytes that are not HTTP | "error sending request from …: client error (SendRequest): invalid HTTP version parsed" | "fetch failed", cause "Response does not match the HTTP/1.1 protocol (Expected HTTP/, RTSP/ or ICE/)" |
| fetch: a body cut short (`content-length` 10, 3 bytes; or a chunked body), then closed | `r.text()` fails: "error reading a body from connection" | `r.text()` fails: "terminated", cause a length mismatch or "Invalid EOF state" |
| Redirect to `file:///etc/hostname` | "Fetch failed: Can not redirect to a non HTTP(s) url" | cause "URL scheme must be a HTTP(S) scheme" |
| Redirect to a bad port | followed | cause "bad port" |
| Redirect loop | "Maximum number of redirects (20) reached", after 21 requests | cause "redirect count exceeded" |
| `HTTP_PROXY` set | used: the listener named there got `GET http://example.invalid/... HTTP/1.1` | not used by default |
| Waiting for headers, for more content | not probed | 300 s each (`headersTimeout`, `bodyTimeout` default `3e5` in the bundled undici; read, not observed) |
| Method "GE T", a header value with `\n`, GET with a body | `TypeError` | `TypeError` |
| Request header `host` / `content-length: 99` | replaced / ignored | replaced / fails |
| Request headers `transfer-encoding`, `keep-alive`, `upgrade`, `expect` | sent | fail (`UND_ERR_INVALID_ARG` / `UND_ERR_NOT_SUPPORTED`) |
| Response headers | lowercase and sorted, repeats joined `, `, one `set-cookie` per cookie; `connection` and `content-length` exposed | the same |
| A response header value with the byte 0xE9 | `é` | `é` |
| Compressed response | decompressed; drops `content-encoding` and `content-length`, also when the program set `accept-encoding: gzip` | decompressed; keeps both, the length being the compressed one |
| Status 299 | accepted | accepted |
| POST with body `""` | — | sends `content-type: text/plain;charset=UTF-8` and length 0 |

Default request headers differ (Deno: user agent `Deno/2.8.0`, `accept-encoding: gzip,br`; Node.js: `node`,
`gzip, deflate`, `sec-fetch-mode`); only the server sees them. The rows before "fetch: connection refused" and the
plan's rows are from the planner's probes; the link, redirect, proxy, port 0, connect-timeout and permission rows
were probed again or first by the implementer. The closed-connection, non-HTTP and cut-body rows are from the
std-net round's analysis (`probe_close.py`) and the fixes after it.

- **The link decision.** The task brief asked whether `create_text` over a dangling link can be `AlreadyExists` on
  both hosts for a program with `fs.write` alone. It can: an exclusive create never follows a link, and Deno does
  not answer ELOOP there as it does for a plain open. So the plan's doc stands; `create_text` calls
  `refuseDanglingLink` nowhere. `create_directory` over such a link became `AlreadyExists` with the `EEXIST`
  mapping, at the path and on the way, while a file on the way stays `Other`; Deno cannot tell where the link is
  without `fs.read`, so that asymmetry stays and is stated (Links row, 7.7, the doc line).
- **A third host difference.** The plan named two (Node.js's limits, Deno's proxy); a redirect to a blocked port
  is the third: Node.js refuses it, Deno follows it. Following redirects by hand would close it but repeats fetch's
  redirect rules (method changes, dropped headers); 7.8 states it instead.
- **Port 0** is `InvalidUrl` by the runtime's own choice: Node.js's list of bad ports starts at 1, and it tries
  port 0 and is refused. The test compares the rest of `BAD_PORTS` with Node.js's answers.
- **A handler that sends to its own server** waits for itself: the inner `send` timed out after its 300 ms (302 ms
  measured), then the outer request was answered (in-process on Deno). 7.8 says so.
- **`error:` as a label** works: `std.fs.describe(error: error)` in an `else` branch passes the checker (plan
  finding 8; a test in `check_test.ts`).
- **The card** is 158 lines and 9,439 bytes (+48), within the brief's budget.
- **The playground's exports** with a four-arm `match` over `std.fs.Error` (`ledger`, `wordcount`, `logstat`,
  `tasks`) fail E0213 since N3, so the round of this phase starts from an empty codebase (plan, section 7).
- **Checked once by hand, not in the tests:** `examples/probe.alang` on both hosts against `localhost` with nothing
  listening, `http://name.invalid/` and a URL of an in-process `std.http.serve`. Both printed `failed: cannot reach
  the server` twice and `200`, and exited right after the last line. On Node.js, `localhost` has two addresses and
  fetch fails with an `AggregateError` cause whose `code` is still `ECONNREFUSED`; the name gives `ENOTFOUND`.

## From the std-net round (2026-11-14)

The playground round of item 20: automated with `scripts/playground-round.sh` (headless Opus 5.5, no advisor,
`--restricted`, an empty codebase), against `7700807` on `std-net`; folder
`~/coding_projects/alang-rounds/2026-11-14-std-net/`. The task: a stock server on `std.http.serve` and a client on
`std.http.send` that retries, prints a prompt line, and writes a report only if it does not exist yet, run against
each other. A fresh Opus agent analyzed it; its files (a Python reference and fake servers, a runner on Deno and
Node.js, the call table, the signal and closed-connection probes) are in `analysis/` there.

- **Correct on both hosts.** All 16 server requests and 14 client cases the prompt specifies agree with the
  reference (the 400 bodies and the text after `failed:` are left open by the prompt); exit codes, stderr and the
  report bytes agree exactly. No trap in 27 client cases and 32 raw requests. No regression.
- **The cheapest round so far.** 21 tool calls (`card` 1, `list` 9, `submit` 2, Bash 8, TaskStop 1), both submits
  accepted without a diagnostic (16 definitions, 44 examples), 91.7 s, 10.7k output tokens (75% in the two submits),
  $0.59.
- **std `context` calls: 0.** `search` and `search_type` unused for the fifth round in a row; discovery was nine
  `list` calls (25.2 KB). `list("std.http")` alone is now 4,215 characters (1,363 in the logstat round).
- **Every new std function used:** `create_text` (with `AlreadyExists` tested by `==`), `std.fs.describe`,
  `std.http.describe`, `print` (the prompt reached the pipe before the request), `wait(500)` and `send`, with the
  right method, `""` content, `std.list.empty<std.http.Header>()`, no `host` header and the 2000 ms timeout.
- **Evidence for `statements`:** two dummy `Unit` bindings (`written`, `served`; T1 to T5) and a five-arm `match`
  in the pure `should_retry` whose bodies repeat (two arms `true`, three `false`; T6 to T10). Built (item 21).
- **What it found:** a group SIGTERM ended the server under `alang db run` with exit 143; the `Failed` text of a
  connection closed without an answer carried Deno's ephemeral port and differed by host; Deno sent such a request
  twice; the server listened on port 6000, which its own client refused as `invalid URL`; `ServeError` got a
  hand-written three-arm `match` for its message; and a `2>` redirect was denied without the round's `CLAUDE.md`
  saying so.

What the fixes after it changed (on `std-net`, one commit each):

- `e6504ac`: `alang run` passes SIGTERM on only if the program still runs 500 ms later, so a group SIGTERM ends a
  server with exit 0; tests send SIGTERM to the group and to the tool alone (Decisions: HTTP, `alang run`).
- `7a75e23`: a connection the server closes before answering is `Failed("the server closed the connection without
  answering")` on both hosts, and Deno's `error sending request from ... for ... (...): ` start is stripped from
  other `Failed` texts; 7.8 and the host table record that Deno sends such a request twice (four host differences).
- `e55e99a`: the doc line of `std.http.serve` says that clients built on fetch refuse the blocked ports.
- `a2665ca`: `std.http.describe_serve_error` (`address already in use`, `permission denied`, the host's message);
  `examples/server.alang` and 7.9 use it.
- `77473ef`: the round's `CLAUDE.md` says that redirections are refused and how to see an exit code.

**Confirmation rerun** against `439acae` (all fixes; folder `~/coding_projects/alang-rounds/2026-11-14-std-net-2/`,
checked by the main session from the result and the transcript, no analysis agent): correct on the three runs and
two extra error cases, 19 tool calls (`card` 1, `list` 9, `submit` 2, Bash 5, Read 1, TaskStop 1), both submits
accepted without a diagnostic, no denied command (the redirection line worked), 85 s, $0.49. The server was again
started in the background and stopped with TaskStop.

Left for later:

- **L1, percent-encoding.** std has no URL encoder or decoder, so the client joined the item raw: `apple&x=1` and
  `apple#y` printed `3`, and the server does not decode `?item=app%6Ce` (404). Not counted against the model.
  Proposed as a new roadmap row (`std.url.*` or `std.http.query_value`); the roadmap itself is not changed here.
- **L2, a `SendError` case for a closed connection.** It would let a program retry on it, but a fifth case breaks
  every `match` over `SendError` (E0213); the fixed `Failed` text covers showing it for now.
- **L4, SIGINT to the tool's PID alone is swallowed** (the server still answered after 4 s), by design: passing it
  on would deliver a terminal's Ctrl-C twice, and a delayed pass-on would break the graceful double Ctrl-C. Document
  at most.
- **L5, no readiness signal for `serve`.** A program cannot say "listening" after the port is bound (the round's
  server printed its line before `serve`, also when the port was taken); low priority.
- **L6, `invalid URL` for a valid URL on a blocked port.** The text is decided (N4, N8); the `serve` doc line now
  warns instead.
- **The size of `list("std.http")`,** about 4.2 KB with long doc lines at `7700807`, and larger since the
  `serve` doc sentence and `describe_serve_error`; it grows with every std function in the module, and the round
  read it whole.
- **The runtime's own status text** (`The server answered with status 600, outside 200 to 599.`) starts in upper
  case and ends with a period, unlike the texts of `describe` and the new closed-connection text; the plan fixed it
  verbatim, so it stays until a std phase revisits the texts.

## From statements (2026-11-14)

Built from `docs/plans/statements.md` at `9ba84a8` (after `std-net`). What the build observed that is not decided:

- **The plan predated `std-net`.** Only four dummy `Unit` bindings were left to convert (`examples/lines.alang`, the
  servers in `tests/http_test.ts` and `tests/queries_test.ts`, the card); `probe`, `server`, `words` and the
  `io_program` programs had none. The suite accepting every example and test program is the real confirmation.
- **A `let` may share its name with a pattern inside its own value.** `let n: Int = match o` with `case Some(n) then
  n` passes the checker, since the `let`'s name is visible only after it (2.6), but the emitter assigned to the
  pattern's TypeScript constant and the example crashed with a JavaScript `TypeError` (not a trap). Fixed in the
  emitter (`5b9943e`). Open: whether 2.6 ("every name has exactly one meaning in a body") should reject it instead
  (E0216); today sibling branches may reuse a name, and this is close to that.
- **E0235 and E0226 in one `let`.** With the plan's "nothing else raised" gate, `let x: Unit =
  std.console.print_line(text: m.word())` reported only E0226; after the codebase shortened the name, the re-check
  found E0235 and the submit was rejected. E0226 is now not counted as another cause, so both are reported and fixed
  in one round.
- **`lines.alang` refuses a third argument** (exact length, T11), where it used to ignore it; the io test pins it.
- **Stored code with `let x: Unit`** (the user's playground export `tasks.alang` has two, its `alang.db.bak` ledger's
  two) is refused on its next acceptance until those definitions are resent; T5 then fixes them on the submit. Rounds
  start from empty codebases and are unaffected.
- **Card budget.** 158 lines and 9,630 bytes (+191 over `std-net`); the test allows 160 lines and under 10,240 bytes,
  so 2 lines and 609 bytes remain, and the next two phases plan about 190 bytes. The program's heading and sentence
  were merged into `## A complete program, accepted as it stands` to fit.
- **Output size of shared cases** (T10): each pattern copies the body. Nothing measured yet; the `tickets` round's
  `out/` will show it. Closed: shared and separate arms compile to identical TypeScript (see "From the tickets
  round").

Left for later:

- **Record update** (copying a record with one field changed): a new roadmap row 9, `records`, after `extern-fn`, to
  pull forward when a round rebuilds a record of four or more fields to change one (T14). The tasks round rebuilt a
  two-field record. 7.1 names the workaround. The roadmap table in `docs/plans/list-literals.md` and the "Next"
  paragraph above are left as they are.
- **The `tickets` round** (the plan's section 7; its prompt is saved at
  `~/coding_projects/alang-rounds/prompts/tickets.md`) tests whether the card teaches the three forms and
  `std.list.set` is found. Run; see "From the tickets round".

## From the tickets round (2026-11-14)

The playground round of item 21: automated with `scripts/playground-round.sh` (headless Opus 5.5, no advisor,
`--restricted`, an empty codebase), against `9624226` on `statements`; folder
`~/coding_projects/alang-rounds/2026-11-14-tickets/`. The task: `tickets`, a command-line tracker for work tickets in
a text file, with moves between five states (the plan's section 7). A fresh Opus agent analyzed it; its report, the
call table, a Python reference, the runner and the probes are in `analysis/` there.

- **Correct.** All 68 cases the prompt fixes and its 11-run sequence (file bytes included) agree with the reference;
  no trap in 92 cases, and the file is unchanged after all 57 exit-1 runs. `finish 2` printed its refusal on stdout
  with exit 0: a prompt ambiguity (the prompt said a refused move "prints" its text, like a successful one, and left
  it out of the error list), disclosed by the model; the saved prompt is changed, and the plan quotes it (below).
  No regression.
- **The propagation statement taken up fully:** 2 sites, as the plan predicted, and 0 dummy `Unit` bindings, where
  earlier rounds had 2.
- **`let [...]` and shared cases not used.** `parse_line` checks a length of 3, then calls `std.list.get` three times
  (a rewrite with `let [first, owner, title]` is accepted in scratch). States are compared as strings with
  `std.list.contains` at 4 sites, which loses exhaustiveness. `std.list.set` and `find_index` are used once each,
  found by `list("std.list")`.
- **Effort.** 17 tool calls (`card` 1, `list` 7, `search` 2, `submit` 2, Bash 3, Read 1, Edit 1); 0 `context`; the
  first `search` calls in six rounds, two exact-name lookups; `search_type` unused. 26 definitions, 73 examples;
  211 s, 28.2k output tokens, $1.01.
- **The first submit was rejected** with E0217 and E0204 from one cause: a match arm of `let outcome: Outcome = match
  command` ended with `move_ticket(...) else return Err(error)`, and E0217's `expected`, applied, gave E0204 again.
  Resending all 26 definitions cost 36.7% of the output tokens (17.8k without it) and 64 s.
- **Shared cases cost no extra TypeScript:** shared and separate arms compile to byte-identical TypeScript (2,013
  bytes each, `analysis/probes/shared.alang` and `separate.alang`), which closes the note on the output size of
  shared cases under "From statements".

What the fixes after it changed (on `statements`, one commit each):

- `3beb41c`: a propagation statement whose content is not `Unit`, as the last line of a block that needs a value, is
  one E0217 (no E0204 beside it), whose `expected` has two lines, the `let` and the bound name; applied, the
  program is clean (Decisions: Type checking, Discarded values).
- `16e76da`: the card says that a list of known length is taken apart by name with `let [...]` when it has exactly
  as many items as names, where it said "a list of exactly two items" (158 lines, 9,673 bytes; 566 bytes remain).
- `1471396`: the plan's section 7 quotes the changed round prompt, in which a refused move is an error (stderr,
  exit 1), and says why.

**Confirmation rerun** against `f0d9ecb` (the fixes above, and the saved prompt with the refused move made an error;
folder `~/coding_projects/alang-rounds/2026-11-14-tickets-2/`, checked by the main session from the result, the
transcript and the export, no analysis agent): the whole sequence right, `finish 2` on stderr with exit 1, the
malformed line refused with the file unchanged. One submit, accepted without a diagnostic; 15 tool calls (`card` 1,
`list` 7, `search` 1, `submit` 1, Bash 3, Read 1, Write 1); 166 s, $0.76. The forms: 13 propagate statements, no
`let x: Unit`; `let [state_text, owner, title]` parses a line (the card's new wording; the first round used a length
check and three `get`s); one shared case (`case Open or Started then`); `std.list.set` and `find_index` as before.
One run per condition, so variance may explain part of the difference.

Left for later:

- **Shared cases on the card.** Its only shared-case example sits in the E0227 sentence, met only when reaching for
  a catch-all. If the next round again uses none, move a shared case into the card's example program (a decision on
  the card's budget). A `match` cannot sit inside a lambda, so the active count would have needed a helper.
- **A rejected transaction is resent whole:** 36.7% of the output here, 18% in the manual `tasks` round. No phase
  covers it (database and MCP).
- **Test-then-unwrap with a dummy default** in `parse_file` (`if bad != None then let index: Int =
  std.option.with_default(option: bad, default: 0)`), and an identity `filter_map`: style, observe.
- **`search_type` with a function type,** such as `(_) -> Bool`, is E0511 today, while `_` matches it; `fn-types` F9
  addresses it. Discovery read whole modules (7 `list` calls, 23 KB). Resolved (item 22): the pattern
  `List<_>, (_) -> Bool -> List<_>` finds `filter`, `drop_while`, `take_while`, `map` (and `append`).
- **E0224 and E0204 from one cause** (found while fixing E0217): `std.int.abs(value: n) else return 0` as the last
  line of a match arm in `let value: Int = match o` gives E0224 ("write the statement without `else return …`") and
  E0204, though following E0224 alone gives a clean program. The same shape as the E0217 fix; left, since the brief
  kept the other paths as they were.

## From fn-types (2026-11-14)

Built from `docs/plans/fn-types.md` (written at `7700807`, before `statements`) on `fn-types`, from `main` at
`47634f6`. What the build observed that is not decided:

- **The plan predated `statements`.** Its hidden-name lookup `isHidden` is `Scope.hiddenWhy` here; an application
  resolves its target through `name_()`, so a name a shared case hides is E0236 and a use is marked, as planned.
  Its file:line references were re-grepped; nothing else had moved in a way that mattered.
- **Two of the plan's hand-made expectations were off.** `by(None)` with `by: (Int, Int) -> Order` is E0238 and
  E0204 (`None` is checked against `Int`), so the test uses `pick: (Option<Int>, Int) -> Int`, where it is E0238
  alone. `List<_>, (_) -> Bool -> List<_>` also finds `std.list.append` (its `T` bound to the function pattern), by
  the same rule that makes `List<_>, Int -> _` find it; kept, since a type variable binds any pattern.
- **E0107 moved from the parser to the checker.** `f(1)` now parses, so `alang fmt` prints it and an export file
  holding it imports up to the check; `xs.map(f)` is E0220 now (a better message, a changed code). In a named call,
  a later unnamed argument keeps the parser's E0107 "Every argument carries its parameter name".
- **`context` follows function types** (`namedTypes` recurses). No existing pin changed: a server's `main` already
  listed `std.http.Request` and `Response` through its handler (probed).
- **A local beside a module function of the same name.** With `count: Int` and `fn m.count(n: Int)`, `count(1)` is
  E0238 about the local; the message does not mention that `count(n: 1)` would call the function. A hint there is
  cheap if a round shows the confusion.
- **Applying a call's result** (`make(n: 1)(2)`, not planned) gets the parser's generic "Expected a line break,
  found `(`."
- **Card budget.** 159 lines and 9,757 bytes (+84, as the plan measured); the test allows 160 lines and under
  10,240 bytes, so 1 line and 482 bytes remain for `const` and later phases.
- **The `rank` round** (the plan's section 7; prompt and reference saved by the main session) tests whether the
  card teaches the forms; nothing in the earlier rounds used a user function parameter.

Left for later:

- **F4 revisited in `const` and `generics`:** a table of functions as a constant (no examples, so F4's reason does
  not apply) and a `fn` returning a function (`compose`). Loosening E0237 breaks no program. The `const` part is done
  (item 23): a constant may hold functions, and F4 stays for `fn`.
- **Generic functions as values (F10):** E0210 stays even where an expected function type would fix the type
  arguments (`let n: (List<Int>) -> Int = std.list.length`); instantiation belongs to `generics`.

## From the rank round (2026-11-14)

The playground round of item 22: automated with `scripts/playground-round.sh` (headless Opus 5.5, no advisor,
`--restricted`, an empty codebase), against `3e0ff8e` on `fn-types`; folder
`~/coding_projects/alang-rounds/2026-11-14-rank/`. The task: `rank`, a command-line tool that ranks the products of a
shop by three measures (`units`, `price`, `revenue`) with the commands `measures`, `top`, `bottom` and `goal` (the
plan's section 7). A fresh Opus agent analyzed it; its report, the call table, the correctness cases, the F4
alternatives and the scripts are in `analysis/` there.

- **Correct where the prompt decides.** All 14 prompt steps match the reference byte for byte; 53 of 64 cases match.
  Of the 11 differences, 5 are open in the prompt (argument vs file order, CRLF, `-0`), 4 come from the `Int` range
  (±(2^53−1) against the reference's float64), and 2 are the model's overflow traps (exit 70: `units * price` beyond
  the range, and `goal` summing every value before checking). `deno check` of `out/*.ts` passes.
- **No function-type form in the accepted program.** Submit 1 had the planned design: a table of measures, a
  `List<Measure>` whose field `value: (Product) -> Int` holds lambdas, returned from `fn rank.measures`. It hit E0237
  (and E0221 on the example `std.list.length(list: measures()) == 3`), and the model turned the formulas into data
  (`factors: List<Column>`, multiplied in `rank.value`), so a fourth measure is one table line only if it is a product
  of columns. E0237 cost a redesign but few tokens (submit 1 held 6 definitions, 812 output tokens); its advice (a
  `let` or a map literal where the function is applied) was not taken, and it names no place for a table read in
  three places.
- **The expensive rejection was E0204** in `main` (`load()`, a `Result`, as an `if` branch where a `List<Product>` is
  expected): fixed in one step, but resending all 24 definitions cost 8,323 tokens, 33.7% of the output. The third
  round where the whole-transaction resend is the largest single cost (tickets 36.7%, tasks 18%).
- **Effort.** 21 tool calls (`card` 1, `list` 5, `search` 4, all exact-name lookups, `submit` 3, Bash 6, Write 1,
  Edit 1); 193 s, 24.7k output tokens, $1.00. `search_type` and `context` unused, so F9 has no round evidence.
- **One denied command:** a zsh `for` loop over the runs; loops are not on the harness's allowlist, and the round's
  `CLAUDE.md` did not name them.
- **F4 alternatives** (in `analysis/alternatives/`, each checked and run on the 14 steps): (a) F4 loosened, a record
  with a function field returned from a `fn`, is E0237 and E0401 today; (b) `const rank.measures` is a sketch, not
  checkable yet; (c) a variant with one `match` in `value` over a data table and (d) the table as a `let` in `main`,
  passed down, are both accepted, 14 of 14. `const` legalises the table, not lookups that return a `Measure`
  (`find_measure(): Option<Measure>` stays E0237).

**Decision on F4** (the main session, on the analysis's recommendation): keep F4 and loosen nothing now; the `const`
phase is the loosening. There E0237's message and `expected` point a function without parameters to `const`, add
"return the name; apply the function where it is used", the card says where a table of functions goes, and `rank` is
rerun. Reasons: 5.1 with 3.9 (loosening F4 for `fn` would also need an exemption from E0401, since a type holding a
function has no `==`); principle 3 (a table as a `fn` now and as a `const` next would be two ways); 3.8 (loosening
later breaks nothing). Caveat: one run. In `decisions.md`, Type checking (Function results), and in the review list.
Done in `const` (item 23): E0237's message and `expected` (`10c6d30`) and the card (`7964510`); the rerun of `rank`
is the main session's.

What the fixes after it changed (on `fn-types`, one commit each):

- `0a2be3a`: the round's `CLAUDE.md` names loops among the refused shell commands ("`rm`, loops such as `for`, shell
  functions, scripts").
- `4d0913a`: the card says "No `fn` returns one, even in a list or record (E0237)." (159 lines, 9,783 bytes; 456
  bytes remain).
- `3f78816`: E0221 reads "An example's left side is a call of the function it belongs to: `measures(…) == …` (5.1).",
  where "An example calls the function it belongs to, `measures`." read like a complaint about calling it; the test
  pins the message.

Left for later:

- **The whole-transaction resend** (database and MCP; no phase covers it): 33.7% here, 36.7% in tickets, 18% in
  tasks.
- **A hint in `mismatch()`** when the content of a `Result` or `Option` would fit the expected type: bind it by a
  statement of its own (no fix). Optional; the model coped in one step.
- **Prompt gaps** for the round's prompt and reference: argument vs file order, CRLF, `-0`, the bounds of `n` and
  `amount`.
- **`std.int.parse` gives the same `None`** for not-a-number and too-large.
- **F4 for functions with parameters** (`compose`): `generics`.

## From const (2026-11-14)

Built from `docs/plans/const.md` (written at `7700807`, before `statements` and `fn-types`) on `const`, from `main` at
`09209c1`, after R7 of `docs/plans/records.md`. What the build observed that is not decided:

- **The plan predated `statements` and `fn-types`.** Its `withShortNames`/`shortenOwnNames` are `withOwnFixes` and
  `applyOwnFixes`. fn-types' `apply()` sent every target whose head is no local to `positionalCall`, so a function in
  a constant's field would have been E0201; it now goes through `name_()` when any reading is a constant, and
  `refs.ts` respells an application's target (its comment said "never a reference"), so `callers`, `remove`,
  `rename` and the E0226 fix see a constant used only as an application's target.
- **Calls never read a constant's fields as a method.** A call path that names a function calls it even if an own
  constant with fields could read it too (`config.load(path: p)` beside a constant `config`); only a name without
  `(`, and an application, can be E0249.
- **Two of the plan's expectations were ordered differently.** E0402s of one submit come in the codebase's order,
  sorted by name (`shop.fits` before `shop.price`), and a rename's result lists the old and the new name, both as
  `rename` (as it always did).
- **Rename capture through constants** (the plan's Risks): with `shop.cap` reading `max_items`, renaming
  `shop.max_items` to `shop.count` is one E0510 for `shop.cap`; `shop.price`'s `requires` is captured too but missed,
  since its example still names the constant and the sets compare equal. Pinned as known in `const_db_test`.
- **The migration on a real database.** A copy of the `rank` round's `work/` (24 definitions, 141 refs, its
  history) opened with the new code: the table was rebuilt, `PRAGMA foreign_key_check` empty, `integrity_check` ok,
  `list` and `history` unchanged, and adding `const rank.limit` was written and exported. A second open does nothing.
- **The `rank` round's alternative (b)**, `const rank.measures` holding lambdas in a `List<Measure>`, is accepted as
  written and runs `measures`, `top`, `bottom` and `goal` as the reference does (probed, not a test).
- **Node.js runs constants.** A generated module with constants, imported by `node` (26.13.0, type stripping),
  evaluates each once and shows a record constant as `Limits(items: 100, sizes: 4)` (probed).
- **The E0204 fix for a generic function without parameters** (`let xs: List<Int> = std.list.empty`) gives
  `std.list.empty()`, which is then E0209 for its type argument: two steps where one would do. The fix could take the
  type arguments from the expected type, as E0209's guess does.
- **Card budget.** 159 lines and 9,896 bytes (+113 for this phase, R7 nothing); 1 line and 344 bytes remain under
  the test's 160 lines and 10,240 bytes. The keywords bullet lost `record`, and the `context` bullet the sentence on
  std hits.

Left for later:

- **C6: rejecting a pure function without parameters** (E0405 reserved): after a round shows whether models still
  write the idiom; about 25 test fixtures and stored programs (`tasks.usage`) use it.
- **A constant's evaluated value in queries:** `context` shows its text; the value would need acceptance results in
  queries.
- **A constant named in a contract** tightens the contract when its value changes, without an interface change
  (decisions, Open questions).
- **Rounds:** `parcel` (`~/coding_projects/alang-rounds/prompts/parcel.md`) and the rerun of `rank`, the main
  session's.

## From the parcel round and the rank rerun (2026-11-14)

Two automated rounds against `06560bf` on `const` (headless Opus 5.5, no advisor, empty codebase), analyzed together by
one fresh Opus agent; folders `~/coding_projects/alang-rounds/2026-11-14-parcel/` and `.../2026-11-14-rank-2/`, each
with `analysis/` (the reports were condensed into `report.md` by the main session).

- **`parcel` (the round of `const`): all correct, the cheapest round so far.** 13 of 13 expected results, 37 of 37 edge
  cases against a Python reference, no trap; 13 calls (card 1, list 7, submit 1, replace 1, Bash 3), one submit of 15
  definitions accepted as sent, the price change one `replace`; 85 s, 10.1k output tokens, $0.52. Five constants
  learned from the card alone (the prompt never says `const`): `zones`, `brackets`, `prices`, `services` (a list of
  records with a factor, so "express is twice" is data too) and `sample`, a fixture record for the examples. No pure
  `in: none` function. The real constants are read only by `main`, which passes them on as one record, so no example
  stated a real price, the price change caused no E0402, and the plan's check 3 was not exercised.
- **`rank` rerun: the table of functions now works.** The first run lost its `List<Measure>` with `value: (Product) ->
  Int` to E0237; the rerun wrote it as `const rank.measures` and passed at the first submit, 0 formulas encoded as
  data. E0237 never fired: the card's "a table of them is a `const`" taught the form first. One `let` of function type
  and one application by position; `found.value(product)` would also have checked. One derived `in: none` function
  (`measure_lines`) whose example repeats the table: evidence for C6/E0405, one case in two rounds. 20 calls, 145 s,
  18.5k output tokens, $0.81 (first run $1.00); 14 of 14 prompt steps; one model trap in `rank.reach` when a running
  sum passes 2^53−1 (`std.int.checked_add` exists).
- **No regressions.** No evidence yet for E0247–E0249, E0404, E0401 or the R7 record names (every `show` argument was an
  `Int`).
- **Fixed (main session):** the round's `CLAUDE.md` names `>>` among the refused redirections and points to the file
  tools (the rerun's one denied command was `printf ... >> sales.txt`).

Left for later:

- **The whole-transaction resend** after a rejection was the largest single cost again (37.8% of the output in the
  rerun; 36.7%, 33.7% and 18% before). A database/MCP decision; no phase covers it.
- **C6/E0405:** whether to reject or hint a pure `in: none` function toward `const`; one case so far.
- **A round that reaches what these could not:** E0402 on a constant change whose examples state real values,
  `context` before `replace`, the new codes, and `show` of a record (R7).
- **A field-application example on the card** (`m.value(p)`), if more unneeded `let`s appear; the card has 1 line and
  344 bytes left.

## Spec observations

- `config.load_port` (section 2) uses `LoadError`, `FileUnreadable`, `InvalidPort` and `std.fs.read_text` /
  `std.fs.ReadError` without defining them. It parses, but cannot type-check on its own. Either define them in the
  spec or mark the block as an excerpt.
- The two `let` fragments in sections 3 and 4 use free names (`paths`, `names`); they are excerpts of a body.
- The grammar has no syntax for function types, which the std library needs (`std.list.sort(by: ...)`). The list
  literal is in the grammar since item 15. Resolved (item 22): `type` has the form `(T, U) -> V`, and `expr` an
  `apply`.
- The grammar has no way to declare a generic function or a generic type. Only builtins are generic.
- 5.5 shows a diagnostic with a `fix`; the spec does not say whether a fix may span several places.
- The grammar excerpt has no `"(" expr ")"`, although 3.5 requires parentheses, and does not say how `* / %` group
  among themselves (from the left). Section 7.5 now states both; the grammar itself is the user's sketch.

## Not enforced yet (planned phases)

- Nesting depth limit (4.8).
- Static proof of conditions (5.2) and prefix checkability (1.6) — separate projects.

## Ideas

- **Prefix checker (1.6):** the recursive descent parser already knows, at each failure point, what it expected.
  Collecting the expected-token set at the end of input is a cheap first approximation of 1.6.
- **Parser error recovery:** the parser stops at the first error. Since definitions start with `fn`/`type` at line
  start, it could resynchronize per definition and report one diagnostic per broken definition (5.6).
- **Records at runtime** carry no type name, so `std.text.show` prints `(value: 8080)` instead of
  `Port(value: 8080)`. A non-enumerable symbol tag on records would fix this without affecting equality. Done (R7 of
  `docs/plans/records.md`): the constructor registers the short type name in a `WeakMap`, so equality is untouched.
- **Lexer:** `List<Int>= x` lexes `>=` as one token. Harmless with canonical spacing, but a corner case.
- **Language knowledge served by the tool** (the user's idea, 2026-11-12: once the compiler ships, should the model
  read a spec file or a database of specs and examples?). My recommendation: the server serves the language as it
  serves code, in three layers. A short card of the rules every definition needs, in the instructions, always
  loaded. Rules on demand, keyed by diagnostic code and rule number (an `explain(code)` tool, or the rule's text in
  the diagnostic), so the model reads exactly the rule it broke. Examples as a real alang codebase, found with
  `search` and `context`: accepted definitions cannot be wrong or stale, unlike prose. Knowledge served by the
  compiler matches its version. The spec file stays as the design document and the source the card and rule texts
  are generated from (as the std table already is). Tools only, so the Scope decision holds. The playground can
  measure it: first-try acceptance and calls per task, full spec against card plus rules on demand. The first layer
  is built (item 16), as the tool `card` rather than in the instructions, since clients cut instructions; it is
  written by hand and checked by tests, not generated from the spec. The `explain(code)` layer and examples as a
  codebase remain.

## From the type checker (2026-11-12)

- **Function types are needed in user code.** Without syntax for them, a lambda cannot be bound with `let`, stored in
  a record, or taken as a parameter by a user function. Only std functions can be higher-order. Testing `==` on
  function values needed a function reference (`g == g`) because nothing else can produce one. Resolved (item 22):
  function types are written in user code and applied by position.
- **List literals are needed for examples.** `calc.sorted` in the tests needs a 170-character example built from
  `std.list.append` chains. This hits rule 5.1 (mandatory examples) directly: list-heavy functions get unreadable
  examples. Resolved by list literals (item 15).
- **Self-verifying fixes.** The checker could apply each suggested `fix` to the definition text and re-check it, and
  only offer fixes that make the diagnostic go away. For an LLM caller a verified fix is worth much more than a
  guess.
- **Errors appear one layer at a time.** `return totl` with `out: Float` reports only the unknown name (5.6); after the
  fix the `Int`/`Float` mismatch appears. Inherent to suppressing follow-ups, but a checker that also re-checks with
  the fix applied (see above) could report the next layer right away.
- **Quoted locations can be ambiguous.** 5.5 locates a diagnostic by quoted text. `return 0` can occur several times
  in one definition. Options: quote the whole statement, add an occurrence index, or include the enclosing `case`.
- **`error` for `None`.** In `let ... else` on an `Option`, `error` is bound to `Unit`. Not binding it at all would be
  cleaner, but then using it would be an "unknown name" instead of a clear message.
- **Locals vs module functions.** A local named like a function of the module wins over it as a value. A stricter
  rule (forbid the clash) would break locality: adding a function could break unrelated bodies.
- **Expression-position `if`/`match`/`for`** could now be emitted anywhere by hoisting into temporaries (types are
  known); evaluation order requires hoisting the sibling expressions to the left as well.
- **`std.text.show` of strings** uses JSON quoting, not alang's escape rules; it should print canonical alang text.
- **Diagnostics for the 4.8 depth limit** would naturally live in the checker's block walk.
- **Checked output is a real guard.** Emitting every accepted test program and running `deno check` over all of them
  found three emitter bugs the hand-picked end-to-end programs missed (literal `===` rejected by TypeScript, `error`
  typed `E | Unit`, `for` inside a branch typed `unknown[]`). A fourth surfaced later: a local initialized with a
  variant case was narrowed by TypeScript to that case, so a `match` on it failed to type-check (fixed by emitting
  cases as `({ tag: ... } satisfies T as T)`). Keep adding every new `clean(...)` case there; a
  generator of random well-typed programs would push this further.
- **The std library is provisional.** Rule 3.8 freezes published signatures, so names and parameter names in
  `src/std.ts` (`with:`, `left:`/`right:`, `std.string.concat`, ...) should be reviewed before anything is
  "published".

## From the effect checker (2026-11-12)

- **std covers two of eight effects.** Only `console` (`std.console.print_line`) and `fs.read` (`std.fs.read_text`)
  have functions. `fs.write`, `net`, `time`, `random`, `env`, `log` need std functions, and each needs a host
  function in `runtime.ts` that works on Deno and Node.js alike. Resolved (2026-11-13, `std-io`): every effect has a
  function now (`net` through `std.http.serve`).
- **`time`, `random`, `log`, `console` are not enforced at runtime.** Deno has no permission for them, so only the
  checker guards them. An `extern fn` that reads the clock without declaring `time` goes unnoticed.
- **`log` vs `console`.** Both end up on the process output. The spec should say what `log` writes to (stderr?
  structured lines?) so the two stay distinguishable. Resolved (2026-11-13, `std-io`): `std.log.print_line` writes
  plain lines to stderr, `std.console.print_line` to stdout.
- **Over-declared effects are allowed** (decision). A linter-style hint ("`console` is declared but nothing triggers
  it") would still help readers; it is not an error because of signature stability.
- **Permissions are all-or-nothing per effect.** `--allow-read` grants every path. The recorded capability
  alternative in the spec would allow `--allow-read=<dir>`; effect labels cannot express that.
- **`extern fn`** is the place where 2.5 matters most and where the runtime enforcement is the only guard. It needs
  its form decided (open since the slice) before it can be tested.
- **Examples for effectful functions** are now rejected by 5.4. The spec's "To revisit later" has two alternatives
  (fixed answers, capabilities); with E0233 in place, such examples fail loudly instead of running effects.
- **The run entry file** (`out/<name>.run.ts`) exits with code 70 on a trap. Node.js would need its own entry if
  programs should be started there too; the generated module itself is runtime-neutral. Resolved: the entry finds `Deno.exit` or
  `process.exit` itself, and the tests start it with `node` (`http_test.ts`, `io_test.ts`).
- **Examples run with the tool's permissions.** The checker runs examples in its own process, which has broad
  permissions. That is safe only while purity is checked; an `extern fn` declared `effects: none` could do IO at
  every acceptance. Running examples in a subprocess without permissions would close this.
- **Case names in `std.fs` are taken.** Case names are unique per module, so `std.fs.NotFound` and `std.fs.Other`
  belong to `ReadError`; a later `WriteError` in `std.fs` cannot reuse them. Either give each error type its own
  module (`std.fs.read.NotFound`) or revisit the per-module rule for std. Resolved (2026-11-13, `std-io`, the user's choice D2): one
  type, `std.fs.Error`, for every `std.fs` function.
- **Under-declared effects surface one layer at a time.** When a callee gains an effect, only its direct callers
  report E0230; their callers report after those are fixed. Transactions (6.4) will want the whole chain at once:
  the checker could compute the transitive closure and list every definition that needs the effect.
- **Fix locations.** Every fix now applies inside its quoted `at` within its `section` (asserted in the tests). Worth
  stating in the spec, since 5.5 leaves open how a tool applies a fix.

## From mandatory examples (2026-11-12)

- **Over-declaring an effect sidesteps 5.1.** A pure function declared `effects: console` needs no example, and by 5.4
  may not have one. Over-declaration is allowed for signature stability (decisions, Effects), so this loophole is real.
  A hint "declared but never triggered" (see the effect notes) would also catch it.
- **Deep recursion overflows the JavaScript stack.** Recursion is the only way to repeat (3), but V8 has no tail calls,
  so a correct recursion over ~10k steps overflows. Examples report it as a `stack` trap; `alang run` still crashes with
  a JavaScript stack trace. The emitter could turn self tail calls into loops, and the run entry could turn a stack
  overflow into a trap.
- **Examples have no time limit.** An exponential recursion (`fib(n: 40)`) blocks acceptance. Running examples in a
  subprocess with a timeout would fix this, the permissions issue (effects notes), and the module cache below.
- **Module cache.** Each acceptance imports a freshly written module, which is never unloaded. A long-running database
  or MCP server will grow by one module per acceptance; a worker or subprocess per acceptance would release them.
- **Callers' examples after a change.** With the database, `replace` keeps callers if the signature is unchanged
  (section 6). A changed body can still break a caller's example, so acceptance must re-run the examples of every
  definition that depends on the changed one, transitively.
- **Long lists are unreadable.** An actual value of type `List<T>` prints as a chain of `std.list.append` calls
  (`vals.ports` in the tests). Resolved (item 15): actual values print list literals.
- **`expected` of E0401 mixes types into value positions** (`twice(n: Int) == Int`). An LLM might copy it literally;
  watch for this once the MCP server is used. Alternative: a placeholder spelling, or none.
- **No structured field for the actual value.** 5.5 fixes the fields of a diagnostic, so the actual value of E0402 sits
  inside `message`. A caller that wants to compare it must parse the message. An `actual` field, or a general `data`
  field, would be cleaner.
- **`std.text.show` and the tool now disagree.** The tool prints values from their static type (`Port(value: 8080)`,
  alang string escapes); `std.text.show` at runtime has no types (`(value: 8080)`, JSON quoting). The emitter knows the
  static type at every `show` call and could pass a type descriptor, so both share one printer. Records agree since
  R7 (the tool adds the module outside it). Strings still differ: `std.text.show(value: "a\u{1B}é")` gives
  `"a\u001bé"` (JSON), an actual value `"a\u{1B}é"` (observed 2026-11-14).
- **Examples as a regression net.** Since all examples run at every acceptance, the whole program's examples act as its
  test suite. For a large codebase only the examples of changed definitions and their dependents need to run.
