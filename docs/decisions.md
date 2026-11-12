# Design decisions

Gaps in `alang-specs.md` that the implementation had to close. Each is decided by the six principles; the rule
numbers refer to the spec. Open points are listed at the end.

## Lexical

| Topic          | Decision                                                                                                                                                                                                            | Principle                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Comments       | None. `//`, `/*` and `#` get a dedicated diagnostic pointing to `doc`.                                                                                                                                              | 3.7: text is printed from the tree, a free comment would be lost.    |
| String escapes | Exactly `\"`, `\\`, `\n`, `\t`, and `\u{X}` (uppercase hex) for other control characters. Every other character, including non-ASCII, is written as itself; `\u{41}` is rejected. Raw control characters are rejected. | 3: every string has exactly one spelling.                            |
| Strings        | Double quotes only, closed on the same line.                                                                                                                                                                        | 3                                                                    |
| Numbers        | 4.7 is enforced both ways: `65535` and `1_000` are errors, as are leading zeros. Floats are `digits.digits`, never in exponent form; the printer expands `1e-7` to `0.0000001`. `-0` is rejected.                                                                                  | 3, 4.7                                                               |
| Negative       | `-3` is a literal. There is no unary minus on other expressions; write `0 - x`.                                                                                                                                     | 3: one form.                                                         |
| Keywords       | Section names (`doc`, `in`, `out`, `effects`, `requires`, `ensures`, `examples`, `body`, `record`, `variant`, `where`) are reserved, so `out: Unit` can never be read as a parameter.                                | 1: no lookahead needed.                                              |
| Foreign forms  | `===`, `!==`, `&&`, `\|\|`, `!`, `{`, `}`, `[`, `]`, `?`, `;`, `'`, `var`, `null`, `while`, `import`, ... have dedicated diagnostics (E0006).                                                                       | 5.7                                                                  |

## Syntax

| Topic                | Decision                                                                                                                                                                                                         | Principle                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Line breaks          | Required between statements and section entries. Inside `( )` of calls and constructs they are ignored. Indentation never matters.                                                                               | 3.7                                           |
| Parentheses          | Not stored in the tree. The printer emits exactly those that 3.5 requires (and `a - (b - c)` on the right of the same group). `(a) + b` prints as `a + b`.                                                       | 3.7                                           |
| Lambdas as operands  | Always parenthesized, since a lambda body extends as far right as possible: `(fn(x: Int): Int => x) == f`.                                                                                                     | 3.7                                           |
| `not`                | Binds looser than comparison: `not a == b` is `not (a == b)`.                                                                                                                                                    | 3.5                                           |
| `a.b.c`              | Parsed as a neutral dotted name; whether it is a local with fields or a qualified constant is resolved later. A dotted path followed by `(` is a call; if its first segment is a local, it is a method call and reported (E0302). | 3.1, 1.2                                      |
| `f<T>(...)` vs `a < b` | After a path, `<` starts type arguments only if a type list closed by `>` and followed by `(` parses; otherwise it is a comparison.                                                                             | 1.4                                           |
| Variant case names   | A case's full name is `module.Case`, so case names are unique per module across types. Written short inside the module.                                                                                          | 1.2: one name, one meaning.                   |
| `if` without `else`  | Only as a statement; an `if` that yields a value (after `let ... =`, `return`, or inside an expression) needs `else` (E0110).                                                                                   | 3.4                                           |
| Block value          | The value of a block is its last statement if that is an expression, otherwise `Unit`.                                                                                                                           | 3.4                                           |
| Definition names     | Always have a module: `fn main` is rejected, `fn hello.main` is required.                                                                                                                                        | 6.2                                           |

## Semantics and runtime

| Topic                | Decision                                                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `let ... else`       | In the `else` branch `error` is the `Err` value; for `None` it is `Unit`.                                                                      |
| `result`, `error`    | Bound by the language (in `ensures` and in `let ... else`), so they cannot name a parameter or binding (E0109). Fields may use them.          |
| `std.int.parse`      | `String -> Option<Int>`: optional `-`, decimal digits, inside the `Int` range.                                                                 |
| `Int` division       | `/` truncates toward zero, `%` has the sign of the dividend (`-7 % 2 == -1`), division by zero traps.                                          |
| `Float` arithmetic   | IEEE 754; a NaN result traps (`0.0 / 0.0`), infinities are ordinary values (`1.0 / 0.0`).                                                      |
| String order         | By Unicode scalar values, not UTF-16 code units. `std.string.length` counts scalar values.                                                     |
| Representation in TS | `Int`/`Float` → `number`, `Unit` → `null`, records → plain readonly objects with a checking constructor, variants → `{ tag, value? }`.        |
| Names in TS          | Global paths joined with `$` (`net$port$parse`), so they never collide with locals. Locals that are TS reserved words get a `$` suffix.        |
| Effects in TS        | Disappear; enforced later through Deno permissions on `main`.                                                                                  |

## Type checking

| Topic                   | Decision                                                                                                                                                                                                                                                    | Principle                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Direction               | Types flow forward only. The left operand of `==` is typed first and the right one checked against it, so `parse(...) == Ok(...)` works and `None == x` does not (E0210).                                                                                 | 1.4                                        |
| `Ok`, `Err`, `None`     | Take their type from the expected type only; without one they are an error (E0210). `Some(x)` can also take its type from `x`.                                                                                                                            | 1.4                                        |
| Explicit type arguments | Written exactly when a type parameter of the function does not occur in any parameter type (`std.list.empty<Int>()`); never otherwise (`std.list.map(...)`, E0209). The rule depends on the signature only, so each call has one spelling.               | 1.4, 3                                     |
| Generic calls           | Type parameters are bound from the arguments, left to right, without backtracking.                                                                                                                                                                         | 1.4                                        |
| Arguments               | Every parameter is named, in declaration order, none omitted, none twice (E0205–E0208). Records are built the same way.                                                                                                                                  | 4.1, 2.6                                   |
| Conversion              | None. `Int` never fits `Float`; the fix suggests `1.0` or `std.int.to_float(value: x)`.                                                                                                                                                                  | 2.6                                        |
| `+` on `String`         | Not allowed; texts join with `std.string.concat`. `+` is numeric only, since one name denotes one function.                                                                                                                                              | 2.6                                        |
| Order                   | `< <= > >=` only on `Int`, `Float`, `String`. `==` on every type without function values (E0222).                                                                                                                                                        | 3.9                                        |
| Shadowing               | A binding may not reuse a name that is visible at that point (parameters, outer `let`s, enclosing pattern bindings, lambda parameters). Sibling branches may reuse a name, e.g. `case Circle(v)` and `case Square(v)`.                                     | 2.6                                        |
| Locals vs functions     | A plain name resolves to a local first, then to a function of the module (`by: compare`). A path followed by `(` is always a call.                                                                                                                         | 1.2                                        |
| Function values         | A function name can be passed as a value (`by: std.int.compare`) if it is not generic; a generic one needs a lambda (E0210).                                                                                                                              | 3                                          |
| Discarded values        | An expression statement whose value is not used must have type `Unit` (E0217); dropping a `Result` silently is an error. A `for` used as a statement has type `Unit`; its body values must be `Unit` too.                                                 | 2.3, 5                                     |
| Function end            | The last statement of a body is literally `return` (E0218). Statements after a `return`, or after an `if`/`match` whose branches all return, are unreachable (E0218).                                                                                     | 3.4                                        |
| Blocks                  | A block's value is its last expression. A block that ends in `return` has the bottom type and fits any expected type. A value block that ends in `let` is an error.                                                                                      | 3.4                                        |
| Lambdas                 | The body is one expression; `return` and `let ... else` inside it are errors (E0219). Lambdas may read enclosing bindings.                                                                                                                                | 2.4                                        |
| `match`                 | Exhaustive over nested patterns (`Err(NotANumber)` + `Err(OutOfRange(n))`). A case covered by earlier cases is an error (E0214). A case with a value is always written with a sub-pattern, a case without one never. `match` on `Int`/`String` cannot be exhaustive. | 3.3                                        |
| Examples                | The left side calls the function the example belongs to (E0221); both sides have the same type.                                                                                                                                                           | 5                                          |
| Scopes of conditions    | `requires` sees the parameters, `ensures` the parameters and `result`, `where` the fields, examples nothing.                                                                                                                                              | 5                                          |
| Uniqueness              | Definitions, parameters, fields, and case names per module are unique; a case may not share its name with a type of the module (E0215).                                                                                                                  | 1.2                                        |
| Reserved names          | Types and cases may not be named like builtins (`Option`, `Ok`, `Unit`, ...), since those are always written short. The module `std` is reserved for the standard library (E0215).                                                                       | 1.2                                        |
| Diagnostics             | All causes are reported, one diagnostic each. An expression that failed has an error type that fits everywhere, which suppresses follow-ups; a broken pattern suppresses the exhaustiveness check of its `match` (5.6). Unknown names get a "did you mean" fix within a small edit distance. | 5.5, 5.6                                   |
| std signatures          | Kept in `src/std.ts` with function types and type variables, which the surface language cannot express yet. A test keeps them in sync with `runtime.ts`.                                                                                                  | —                                          |

## Effects

| Topic                  | Decision                                                                                                                                                                                                                                   | Principle |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| Spelling               | Effects are listed once each, in the order of the effect table (`effects: fs.read, console`); anything else is a parse error with the reordered line as fix (E0111).                                                                     | 3         |
| Calls                  | A function declares every effect of every function it calls; checking direct calls is enough, since each callee's list is checked in turn (E0230). One diagnostic per definition, at the first offending call, with the complete corrected `effects:` line as fix. | 2.1, 5.6  |
| Over-declaration       | Allowed. 2.1 asks that the caller's effects *include* the callee's. Requiring an exact list would make removing the last effectful call a signature change that ripples up to `main`, against "signature unchanged, callers follow" (6). | 2.1, 6    |
| Lambdas                | Pure: a call with effects inside a lambda is an error (E0232). Effects per element go through `for`.                                                                                                                                      | 2.4       |
| Function values        | A function passed by name (`by: compare`) must have `effects: none`, like a lambda, since function types carry no effects (E0232).                                                                                                       | 2.4       |
| Conditions, examples   | `requires`, `ensures`, `where` and examples call only pure functions (E0233). An example of a function with effects is therefore an error: it would run the effects at every acceptance.                                                 | 5.4       |
| Runtime                | `alang run` starts `main` in its own Deno process with `--no-prompt` and exactly the permissions of its effects (`fs.read` → `--allow-read`, ...). A refused operation traps (`effect`); it is not an ordinary error value.              | 2.5       |
| `std.fs.read_text`     | `String -> Result<String, std.fs.ReadError>` with cases `NotFound`, `PermissionDenied` (by the OS), `IsADirectory`, `Other: String`. std types are written in alang (`STD_TYPES_SOURCE` in `src/std.ts`).                                 | 2.3       |
| Diagnostics            | An unknown name, type or function is reported once per definition, however often it is used (5.6).                                                                                                                                       | 5.6       |

## Temporary limits

These are not language decisions, only what the implementation does not do yet.

- `if`, `match` and `for` are compiled only as a statement, as the value of `let`, and after `return`.
- `where` on a variant type is rejected (E0225); it is open which name refers to the value.
- `const` and `extern fn` are not parsed yet.
- Mandatory examples (5.1) are not checked yet.

## Open questions

- **List literals.** The grammar has none, so examples cannot easily mention a non-empty list. Options: a literal form
  `List(1, 2, 3)`, or library functions only.
- **Function types.** `std.list.sort(list, by: compare)` needs a type for a function parameter; the grammar has no
  syntax for it.
- **Form of `const` and `extern fn`.**
- **`std.text.show` of records.** Records carry no type name at runtime, so they show as `(value: 8080)`, not
  `Port(value: 8080)`.
