# Notes and ideas

Running log of observations, spec gaps and ideas for later. Decisions that close a gap move to
[decisions.md](decisions.md); this file is for what is not decided or not done yet.

## Current state (2026-11-13)

Read this first when picking up the work in a new session. Update it when a phase ends.

**Branches.** `main` holds everything below (2026-11-13: the user chose to merge; `spec` was fast-forwarded into
`main`, which contains the whole chain `type-checker`, `effects`, `examples`, `database`, `mcp`, `async`, `spec`). The
phase branches are kept as they are. Start each new phase on its own branch from `main`; pushing is the user's call.

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

**Next:** proposed order for the user's six goals (2026-11-13; the merge is done, the rest awaits the user's
choice): file and program I/O in std (fs write/list/exists/remove, arguments, env, clock, console input), then std
breadth (text splitting and searching, `int.min`/`max`, Map functions, list helpers, the HTTP client) and the
language forms libraries need (`extern fn`, `const`, function types, list literals, generic definitions), then the
spec served by the MCP server (card plus `explain(code)`, generated from the spec), then the plan/build/test agent
loop (needs an example time limit, a scored task suite, a gate for language decisions), then shipping (JSR package,
`alang init`, quickstart, CI; std names freeze per 3.8), and self-hosting last. Suggested first step: goal 4 as one
hand-run round of the loop.

Phase 3 of the HTTP work, an HTTP client (`std.http.fetch` or similar, on fetch), was postponed by the
user (2026-11-12); async output makes it possible now. Reconnect the playground's MCP server to pick up the merged
`main`, and watch whether the model reads std through `context` instead of the sources. Earlier: a first round with Claude Code in a playground project (`~/coding_projects/alang-playground`, ten tasks)
is done; see "From the MCP server". Claude Code connected and used every kind of tool, so the protocol works with a
real client (the official SDK client was not run). Open from that round, each the user's call: an MCP `run` tool
(`alang db run` is built; see "From db run"); recording what triggered an `import` in `history`; a tool operation for renaming a
parameter; `search_type` through `Option`/`Result`; `std.int.min`/`max`. `extern fn` and `const` are still unparsed
and need their form decided.

**Checks before every commit:** `deno task test` (195 tests; the task now allows `net`, for the server tests),
`deno lint`, `deno fmt --check`.

**Working conventions** agreed with the user:

- Write in English; translate German text you encounter.
- Each phase on its own branch; commit locally with explicit paths (never `git add -A`); do not push.
- The user also commits and pushes; check `git log` and `git status` before committing.
- Decisions go to `decisions.md`, observations and ideas to this file, both as you go.

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
  `with: (T) -> U` only matches `_`.
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
  `compare`), which would have made the body one line. Not exercised, but close: contracts are compared as printed,
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
  have functions).
- **Handler examples are long.** A `Request` needs all five fields, headers as `std.list.empty<std.http.Header>()`;
  one example line of `examples/server.alang` is ~200 characters. List literals (open question) would shorten it;
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
  no function types. If function types arrive, the `with effects` mark needs a surface form.
- **Adding an effect to a handler** is an interface change, and `main` passes the handler by name, so it is a
  caller: the change pulls `main` into the transaction (E0506), where it must declare the effect. Consistent with
  calls, not tested separately.
- **The Node.js path is tested end to end** (requests, SIGTERM, a port in use); the in-process tests (one at a
  time, traps, headers) run on Deno only. `EACCES` is mapped on both hosts but not run, since it needs a port
  below 1024 without root.
- **One handler at a time is slow** for a handler that waits (a file read, later an outgoing request). Concurrency
  would be a language feature with its own rules; the queue is where it would start.
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
  functions).

## Spec observations

- `config.load_port` (section 2) uses `LoadError`, `FileUnreadable`, `InvalidPort` and `std.fs.read_text` /
  `std.fs.ReadError` without defining them. It parses, but cannot type-check on its own. Either define them in the
  spec or mark the block as an excerpt.
- The two `let` fragments in sections 3 and 4 use free names (`paths`, `names`); they are excerpts of a body.
- The grammar has no list literal and no syntax for function types; both are needed by the std library
  (`std.list.sort(by: ...)`) and by examples that mention non-empty lists.
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
  `Port(value: 8080)`. A non-enumerable symbol tag on records would fix this without affecting equality.
- **Lexer:** `List<Int>= x` lexes `>=` as one token. Harmless with canonical spacing, but a corner case.
- **Language knowledge served by the tool** (the user's idea, 2026-11-12: once the compiler ships, should the model
  read a spec file or a database of specs and examples?). My recommendation: the server serves the language as it
  serves code, in three layers. A short card of the rules every definition needs, in the instructions, always
  loaded. Rules on demand, keyed by diagnostic code and rule number (an `explain(code)` tool, or the rule's text in
  the diagnostic), so the model reads exactly the rule it broke. Examples as a real alang codebase, found with
  `search` and `context`: accepted definitions cannot be wrong or stale, unlike prose. Knowledge served by the
  compiler matches its version. The spec file stays as the design document and the source the card and rule texts
  are generated from (as the std table already is). Tools only, so the Scope decision holds. The playground can
  measure it: first-try acceptance and calls per task, full spec against card plus rules on demand.

## From the type checker (2026-11-12)

- **Function types are needed in user code.** Without syntax for them, a lambda cannot be bound with `let`, stored in
  a record, or taken as a parameter by a user function. Only std functions can be higher-order. Testing `==` on
  function values needed a function reference (`g == g`) because nothing else can produce one.
- **List literals are needed for examples.** `calc.sorted` in the tests needs a 170-character example built from
  `std.list.append` chains. This hits rule 5.1 (mandatory examples) directly: list-heavy functions get unreadable
  examples.
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
  function in `runtime.ts` that works on Deno and Node.js alike.
- **`time`, `random`, `log`, `console` are not enforced at runtime.** Deno has no permission for them, so only the
  checker guards them. An `extern fn` that reads the clock without declaring `time` goes unnoticed.
- **`log` vs `console`.** Both end up on the process output. The spec should say what `log` writes to (stderr?
  structured lines?) so the two stay distinguishable.
- **Over-declared effects are allowed** (decision). A linter-style hint ("`console` is declared but nothing triggers
  it") would still help readers; it is not an error because of signature stability.
- **Permissions are all-or-nothing per effect.** `--allow-read` grants every path. The recorded capability
  alternative in the spec would allow `--allow-read=<dir>`; effect labels cannot express that.
- **`extern fn`** is the place where 2.5 matters most and where the runtime enforcement is the only guard. It needs
  its form decided (open since the slice) before it can be tested.
- **Examples for effectful functions** are now rejected by 5.4. The spec's "To revisit later" has two alternatives
  (fixed answers, capabilities); with E0233 in place, such examples fail loudly instead of running effects.
- **The run entry file** (`out/<name>.run.ts`) exits with code 70 on a trap. Node.js would need its own entry if
  programs should be started there too; the generated module itself is runtime-neutral.
- **Examples run with the tool's permissions.** The checker runs examples in its own process, which has broad
  permissions. That is safe only while purity is checked; an `extern fn` declared `effects: none` could do IO at
  every acceptance. Running examples in a subprocess without permissions would close this.
- **Case names in `std.fs` are taken.** Case names are unique per module, so `std.fs.NotFound` and `std.fs.Other`
  belong to `ReadError`; a later `WriteError` in `std.fs` cannot reuse them. Either give each error type its own
  module (`std.fs.read.NotFound`) or revisit the per-module rule for std.
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
  (`vals.ports` in the tests). List literals (open question) would make both examples and diagnostics readable.
- **`expected` of E0401 mixes types into value positions** (`twice(n: Int) == Int`). An LLM might copy it literally;
  watch for this once the MCP server is used. Alternative: a placeholder spelling, or none.
- **No structured field for the actual value.** 5.5 fixes the fields of a diagnostic, so the actual value of E0402 sits
  inside `message`. A caller that wants to compare it must parse the message. An `actual` field, or a general `data`
  field, would be cleaner.
- **`std.text.show` and the tool now disagree.** The tool prints values from their static type (`Port(value: 8080)`,
  alang string escapes); `std.text.show` at runtime has no types (`(value: 8080)`, JSON quoting). The emitter knows the
  static type at every `show` call and could pass a type descriptor, so both share one printer.
- **Examples as a regression net.** Since all examples run at every acceptance, the whole program's examples act as its
  test suite. For a large codebase only the examples of changed definitions and their dependents need to run.
