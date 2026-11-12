# Notes and ideas

Running log of observations, spec gaps and ideas for later. Decisions that close a gap move to
[decisions.md](decisions.md); this file is for what is not decided or not done yet.

## Current state (2026-11-12)

Read this first when picking up the work in a new session. Update it when a phase ends.

**Branches.** Work happens on the local branch `database`, branched from `examples` (local, phase 4 committed),
which sits on `effects` (local), which sits on `type-checker` (pushed to `origin/type-checker`). `main`
(= `origin/main`) has only the first slice, so do not start from `main`. Nothing is merged yet; merging and pushing
is the user's call.

**Done** (phases from CLAUDE.md, in order):

1. Thin slice: lexer, parser, canonical printer, TypeScript emitter, runtime.
2. Type checker (`src/check.ts`), with every accepted test program also checked by TypeScript.
3. Effects: static checks (2.1, 2.4, 5.4) and runtime enforcement through Deno permissions in `alang run`.
4. Mandatory examples (5.1) and the acceptance pipeline of 6.3 (`accept` in `src/toolchain.ts`, rule code in
   `src/examples.ts`). Failing examples report the actual value as alang text.

**In progress: the database (section 6).** See "Database phase: plan" below for the design and the order of work.

- Step 1 done: `src/codebase.ts` (`Codebase.open`, `submit` with add / replace / remove, the guard, the interface
  and remove rules, `definition` and `callers`), `src/interface.ts` (caller-facing interface), `src/refs.ts`
  (references by full name). Decisions are in `decisions.md`, section Database.
- Step 2 done: the queries `signature`, `context`, `list`, `searchText`, `searchType` (patterns in `src/search.ts`),
  `history`.
- Next: step 3, export and import.

**After the database:** the MCP server around its queries and operations (its own phase). `extern fn` and `const`
are still unparsed and need their form decided.

**Checks before every commit:** `deno task test` (113 tests), `deno lint`, `deno fmt --check`.

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
- std library: all names and parameter names in `src/std.ts`, including `std.fs.read_text` and the cases of
  `std.fs.ReadError`, are provisional. Rule 3.8 freezes them once published.

## Database phase: plan (2026-11-12)

Designed with a review, not yet confirmed by the user. Record each point in `decisions.md` when it is built, and
report the first one (rename) prominently, since it departs from the wording of 6.1.

**Hash and references.**

- The hash of a definition is a digest of its canonical text: sha-256 of the printer's output (never the submitted
  text), hex, shortened (planned: 16 characters, with a collision check on insert).
- References stay names, as written in the text. Reasons: the `text` column holds canonical text and rows never
  change, and the text contains the definition's own name, so no design storing that text makes `rename`
  pointer-only. The guard (6.7) needs a hash that changes exactly when the text a query returned would change. The
  recommended source of truth, the export in Git, holds names anyway.
- Consequence: `rename` rewrites every caller, and each caller gets a new version. 6.1's "rename changes only the
  pointer" becomes "the tool rewrites the callers".
- Recorded alternative: a hash-linked (Unison-style) model, where references go through hashes internally. A
  callee's change re-hashes all transitive callers, so a guard goes stale although their text did not change.
  Recursion needs cycles hashed jointly, and the stored text cannot be the canonical text with names.

**Tables.** As in the spec (Storage), with these differences:

- `definitions(hash, kind, text, signature)`: one row per version, never changed. `signature` is
  `printSignature(def)`.
- `names(name, hash)`: the current pointer.
- `history(name, hash, changed_at, operation, other_name)`: `hash` is NULL for a removal. `operation` is one of add,
  replace, rename, remove, follow (a caller rewritten by a rename) or import. `other_name` holds the other side of a
  rename. `history(name)` follows renames back.
- `refs(from_hash, to_name)`, not `to_hash`: references in the text are names, so after replacing only B's body,
  `callers(B)` must still list A, whose row did not change. Insert in text order, so that `ORDER BY rowid` gives
  first-use order for `context`.
- Only `names`, `definitions.text` and `history` are primary. `refs` and `signature` are derived and rebuilt on
  import.

**Operations.**

- `submit(changes)`. A change is one of `add(text)`, `replace(name, hash, text)`, `rename(name, hash, to)` and
  `remove(name, hash)`. Single operations are one-change transactions.
- Each submission is parsed on its own and must be exactly one definition. For `replace`, its name and kind must
  match the operation. Each name appears at most once per transaction, counting both sides of a rename.
- Result: `{ ok: true, written: [{ name, hash | null, operation }] }` or `{ ok: false, diagnostics, current }`. A
  guard mismatch and an `add` of an existing name return the current text and hash in `current`.
- Steps:
  1. Check the guards against a snapshot.
  2. Apply renames first, rewriting with the check info of the accepted current program.
  3. Apply add, replace and remove on that.
  4. Apply the interface rule (below) and the remove rule.
  5. Accept the whole resulting program with `acceptDefinitions`. This re-runs every example, so a caller's example
     that a changed body breaks is reported.
  6. Compute texts, hashes and refs, using the accepted check info.
  7. Run one SQLite transaction (`BEGIN IMMEDIATE`) that rechecks the guards.
  8. Rewrite the export files of the affected modules.
- Serialize submits with a promise queue, since acceptance writes `out/accept.ts`.
- Interface rule (spec: "if replace changes the signature, it is rejected and names the affected callers"):
  - The caller-facing interface is not the `signature` query. Comparing that would reject adding an example to a
    function with callers.
  - For a fn, the interface is `in` (names, types, order), `out`, and added effects. Removing an effect is compatible,
    since over-declaration is allowed.
  - For a type, the interface is its shape: kind, fields, and cases with payloads, in order. `doc`, `requires`,
    `ensures`, `where` and `examples` are not part of it; changes there are caught by acceptance and examples.
  - An interface change with callers outside the transaction is rejected (E0506), listing them. For added effects,
    list all transitive callers that lack them, stopping at callers that already declare them or are in the
    transaction. Rename followers do not count as part of the transaction.
- Remove: rejected while callers exist outside the transaction (E0507). It ignores self-references (recursion, and
  a function's own examples) and callers removed in the same transaction. `callers(name)` also leaves out the
  definition itself.
- Rename, built last:
  - Rewrite the renamed definition and every definition that references it, with `mapReferences`. A variant type
    that moves to another module moves its cases too, so map `old.module.Case` to `new.module.Case`.
  - Validate the new name by printing and parsing.
  - Re-accept the result, and assert that each rewritten definition depends on exactly the old dependencies mapped
    through the rename. This catches capture by a local (`by: g` when a local `g` exists) or by a same-named
    definition in the target module (E0510).
- Diagnostic codes, range E05xx:
  - E0501 stale hash
  - E0502 unknown name, with a closest-name fix
  - E0503 name exists
  - E0504 not exactly one definition
  - E0505 name or kind differs from the operation
  - E0506 interface change with callers outside
  - E0507 remove with callers
  - E0508 name touched twice
  - E0509 invalid new name
  - E0510 rename changes what a reference denotes
  - E0511 malformed type pattern in `search(type)` (added in step 2)
  - `at` quotes the operation, e.g. `replace(net.port.parse, <hash>)`.

**Queries.**

- Every query returns the hash it read. Unknown names throw `AlangError` (E0502).
- `definition(name)`: name, hash and text.
- `signature(name)`: name, hash and the signature text.
- `context(name)`:
  - The text plus the signatures of what it uses, in first-use order.
  - Also the types that appear in those signatures, one level deep. To call B you must build its argument types.
  - std functions as one-line signatures from `src/std.ts`, and std types as alang text.
- `callers(name)`, sorted.
- `list(module)`: definitions whose module is exactly `module` (name, hash, kind, doc), plus the names of its
  direct submodules.
- `search(text)`: case-insensitive matches in names and `doc`, std included.
- `search(type)`:
  - Patterns like `String -> Result<Int, _>` and `String, Int -> Bool`.
  - `_` matches any type, and a one-segment name matches a user type by its last segment.
  - std type variables match anything, and std is included (hash null).
- `history(name)`.

**Storage and export.**

- `Codebase.open(dir)` uses `dir/alang.db` (via the built-in `node:sqlite`, `DatabaseSync`; works without
  permissions for `:memory:`), `dir/export/` and `dir/out/`. The clock is injectable for tests.
- Export: one file per module, `export/<module>.alang`, definitions sorted by name, written with `printProgram`. Only
  affected modules are rewritten after each transaction, and a file whose module became empty is deleted.
- Import: rebuild the database from `export/*.alang`, with whole-program acceptance and history operation `import`.
  Import does not write the export.
- Invariant to test: export, then import into a fresh database, gives the same name-to-hash map.

**Order of work.**

1. Storage, `add` / `replace` / `remove`, the guard and transactions.
2. The queries.
3. Export and import.
4. `rename`.
5. A thin CLI (`alang db ...`, JSON output).

Stop after the database. The MCP server is its own phase.

**Tests to write early:**

- Callers survive a body-only replace (above).
- A rejected transaction leaves the tables and `export/` untouched.
- A recursive function can be removed.
- The export/import invariant.
- Rename keeps what each reference denotes.

**Earlier decisions this phase leans on**, still awaiting the user's review:

- Case names are unique per module, so moving a variant type renames its cases.
- Over-declared effects are allowed, which is why removing an effect is compatible.
- Examples call their own function, so `rename` must rewrite them.

## From the database (2026-11-12)

- **1.2 is not enforced for the own module.** The checker accepts `net.port.Port` written inside `net.port`, although
  1.2 says names of the same module are written short. Two spellings give two texts and two hashes for one meaning.
  The interface rule compares full names, so it is not fooled; the checker should still reject the long form, with
  the short form as fix.
- **Every submit loads, parses and accepts the whole program**, and the write compares every name with the snapshot.
  Fine for the prototype; a large codebase wants a cached parsed program and acceptance limited to the changed
  definitions and their dependents (see "Examples as a regression net").
- **Queries parse on demand.** `list`, `search` and `context` parse stored texts to read `doc` lines and case lists.
  A `doc` column, or a cache of parsed definitions per hash (texts never change), would remove that.
- **`search(type)` cannot express function types**, since alang has none (open question). A std parameter like
  `with: (T) -> U` only matches `_`.
- **`refs` rows depend on the text alone** once cases are stored by their own name, which is what makes reusing a
  version (revert, remove then add) safe without recomputing anything.

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
- Database, hashes, queries, MCP server (section 6).

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
  typed `E | Unit`, `for` inside a branch typed `unknown[]`). Keep adding every new `clean(...)` case there; a
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
