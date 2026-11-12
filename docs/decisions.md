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
| `Int` division       | Planned: `/` truncates toward zero, `%` has the sign of the dividend, division by zero traps. Not emitted until the type checker can tell `Int` from `Float`. |
| String order         | By Unicode scalar values, not UTF-16 code units. `std.string.length` counts scalar values.                                                     |
| Representation in TS | `Int`/`Float` → `number`, `Unit` → `null`, records → plain readonly objects with a checking constructor, variants → `{ tag, value? }`.        |
| Names in TS          | Global paths joined with `$` (`net$port$parse`), so they never collide with locals. Locals that are TS reserved words get a `$` suffix.        |
| Effects in TS        | Disappear; enforced later through Deno permissions on `main`.                                                                                  |

## Temporary limits of the slice

These are not language decisions, only what the first implementation does not do yet.

- No type checker. `+ - *` share one runtime operation for `Int` and `Float`: NaN traps, and an integral result outside
  the `Int` range traps. `/` and `%` are rejected until types are known.
- `if`, `match` and `for` are compiled only as a statement, as the value of `let`, and after `return`.
- `where` on a variant type is not emitted.
- `const` and `extern fn` are not parsed yet.
- Call arguments are mapped by position, relying on rule 4.1 (declaration order); the checker will verify the order.

## Open questions

- **List literals.** The grammar has none, so examples cannot easily mention a non-empty list. Options: a literal form
  `List(1, 2, 3)`, or library functions only.
- **Function types.** `std.list.sort(list, by: compare)` needs a type for a function parameter; the grammar has no
  syntax for it.
- **Form of `const` and `extern fn`.**
- **`std.text.show` of records.** Records carry no type name at runtime, so they show as `(value: 8080)`, not
  `Port(value: 8080)`.
