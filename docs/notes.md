# Notes and ideas

Running log of observations, spec gaps and ideas for later. Decisions that close a gap move to
[decisions.md](decisions.md); this file is for what is not decided or not done yet.

## Current state (2026-11-12)

Read this first when picking up the work in a new session. Update it when a phase ends.

**Branches.** Work happens on the local branch `examples`, which is not pushed. It sits on top of `effects` (local),
which sits on `type-checker` (pushed to `origin/type-checker`). `main` (= `origin/main`) has only the first slice, so
do not start from `main`. Nothing is merged yet; merging and pushing is the user's call.

**Done** (phases from CLAUDE.md, in order):

1. Thin slice: lexer, parser, canonical printer, TypeScript emitter, runtime.
2. Type checker (`src/check.ts`), with every accepted test program also checked by TypeScript.
3. Effects: static checks (2.1, 2.4, 5.4) and runtime enforcement through Deno permissions in `alang run`.
4. Mandatory examples (5.1) and the acceptance pipeline of 6.3 (`accept` in `src/toolchain.ts`, rule code in
   `src/examples.ts`). Failing examples report the actual value as alang text.

**Next:** the database (section 6), then the MCP server around its queries and operations. `accept` is the step the
database calls before it writes. `extern fn` and `const` are still unparsed and need their form decided.

**Checks before every commit:** `deno task test` (81 tests), `deno lint`, `deno fmt --check`.

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
