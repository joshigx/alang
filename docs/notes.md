# Notes and ideas

Running log of observations, spec gaps and ideas for later. Decisions that close a gap move to
[decisions.md](decisions.md); this file is for what is not decided or not done yet.

## Current state (2026-11-12)

Read this first when picking up the work in a new session. Update it when a phase ends.

**Branches.** Work happens on the local branch `mcp`, branched from `database` at `f5dde7e`, which
sits on `examples` (local, phase 4 committed), which sits on `effects` (local), which sits on `type-checker` (pushed
to `origin/type-checker`). `main` (= `origin/main`) has only the first slice, so do not start from `main`. Nothing is
merged yet; merging and pushing is the user's call.

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

**Next:** use the MCP server from Claude Code on a real alang project and record what goes wrong (CLAUDE.md: the
language gets tested on its actual user). Not yet checked against an official MCP client (see "From the MCP
server"). `extern fn` and `const` are still unparsed and need their form decided.

**Checks before every commit:** `deno task test` (163 tests), `deno lint`, `deno fmt --check`.

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
- Own-module names: the long form is an error (E0226), reported only for a name that exists.
- Database: everything in `decisions.md`, section Database. The user chose (2026-11-12) automatic sync with the
  export and an optional text on `rename`; the details within them are still open for review: a conflict is
  refused (E0513) rather than resolved; a missing export directory is written, never read as every file deleted;
  library queries read the database as is while `alang db` syncs first; a submit's sync import stays when the submit
  is rejected; a pull during a submit restarts it, and one right after its commit is left for the next operation to
  report as E0513. To confirm: every `alang db` command, a plain query included, can now change the database (a
  deleted export file removes its module's definitions). Above all, references stay names, so `rename` rewrites
  callers instead of changing only a pointer (departs from 6.1); see "Database phase: open points".
- MCP server: everything in `decisions.md`, section MCP server; above all, no `import`/`export` tools, JSON results
  identical to `alang db`, a hand-written protocol instead of the SDK, and queries marked read-only although their
  sync can change the database.
- std library: all names and parameter names in `src/std.ts`, including `std.fs.read_text` and the cases of
  `std.fs.ReadError`, are provisional. Rule 3.8 freezes them once published.

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

- **Not yet run against an official client.** The tests drive the server with my own reading of the protocol, in
  process and over stdio. A pass with the official TypeScript SDK client (or Claude Code itself) is still open; it
  was not run here because downloading the SDK was not permitted in the session.
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
- **E0513's message names commands** (`alang db import`, `export --force`) that the server's instructions tell the
  model not to run. A model with a shell may still run them; the diagnostic could carry a hint that it is for the user.

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

## Spec observations

- `config.load_port` (section 2) uses `LoadError`, `FileUnreadable`, `InvalidPort` and `std.fs.read_text` /
  `std.fs.ReadError` without defining them. It parses, but cannot type-check on its own. Either define them in the
  spec or mark the block as an excerpt.
- The two `let` fragments in sections 3 and 4 use free names (`paths`, `names`); they are excerpts of a body.
- The grammar has no list literal and no syntax for function types; both are needed by the std library
  (`std.list.sort(by: ...)`) and by examples that mention non-empty lists.
- The grammar has no way to declare a generic function or a generic type. Only builtins are generic.
- 5.5 shows a diagnostic with a `fix`; the spec does not say whether a fix may span several places.

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
