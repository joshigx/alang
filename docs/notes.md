# Notes and ideas

Running log of observations, spec gaps and ideas for later. Decisions that close a gap move to
[decisions.md](decisions.md); this file is for what is not decided or not done yet.

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

- Effect checking (2.1, 2.2), pure lambdas (2.4), pure conditions (5.4). The std table already carries effects and
  the checker sees every call site, so this is a small step on top of the type checker.
- Mandatory examples for pure functions (5.1).
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
- **Reserve the `std` namespace.** User definitions named `std.*` are accepted today and would collide with the
  runtime.
- **Locals vs module functions.** A local named like a function of the module wins over it as a value. A stricter
  rule (forbid the clash) would break locality: adding a function could break unrelated bodies.
- **Expression-position `if`/`match`/`for`** could now be emitted anywhere by hoisting into temporaries (types are
  known); evaluation order requires hoisting the sibling expressions to the left as well.
- **`std.text.show` of strings** uses JSON quoting, not alang's escape rules; it should print canonical alang text.
- **Diagnostics for the 4.8 depth limit** would naturally live in the checker's block walk.
