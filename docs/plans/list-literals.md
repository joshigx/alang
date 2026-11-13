# Plan: list literals and pure std breadth, then seven further phases

Written by the Fable planner, 2026-11-13. Branch `list-literals`, from `main`. Nothing was run or written during
planning. Every expected value below is computed by hand; where one disagrees with a stated rule, the rule wins and
the implementer reports it. "To verify" marks facts the planner did not test.

The user does not want to be asked about design decisions (2026-11-13): the main session takes every recommendation
of this plan. Decisions that change the language are marked **[language]** and listed for the user's later review.

## 0. Roadmap

Two premises of the brief do not hold in this code base, and that shapes the order:

- **std functions that take functions need no surface function types.** `src/std.ts` already has `fnType` and type
  variables; `zip` and `enumerate` can be added today.
- **std does not need `extern fn`.** std is `src/std.ts` plus `src/runtime.ts`, kept in step by a test. Decision X1
  below keeps it that way.

So std breadth comes first, and the language forms follow for libraries written in alang.

| # | Branch | Scope | Depends on |
| --- | --- | --- | --- |
| 1 | `list-literals` | List literal `[a, b]`; 30 pure functions in `std.int`, `std.string`, `std.list`; Int without negative zero | none |
| 2 | `std-maps` | Map functions, map literal, `std.float` functions, remaining text helpers | 1 (literal syntax) |
| 3 | `std-net` | HTTP client, waiting, console output without a line break, exclusive create with `AlreadyExists` | none |
| 4 | `statements` | Propagating `Result<Unit, E>` without a dummy binding; shared `match` arms | none |
| 5 | `fn-types` | Function types in user signatures, applying a function value | none |
| 6 | `const` | `const` definitions | none |
| 7 | `generics` | Type parameters on `fn` and `type` | 5 for useful generic helpers |
| 8 | `extern-fn` | `extern fn` with `target` | 5, 7 for typed bindings |

## 1. Findings that shape phase 1

- **`[` and `]` are lexer errors today.** They sit in `FOREIGN` in `src/lexer.ts` (E0006), and
  `tests/syntax_test.ts:79` asserts E0006 for `xs[0]`. Once they are symbols, the parser must raise that diagnostic
  itself.
- **Four exhaustive switches over `Expr`:** `infer` in `src/check.ts`, `printExpr` in `src/printer.ts`, `expr` inside
  `rebuild` in `src/refs.ts`, `expr` in `src/emit.ts`. `valueExpr` in `src/examples.ts` builds lists as append chains.
- **Free codes.** E0228 and E0229 are the last free checker codes before the effects block (E0230 to E0233); later
  checker codes continue at E0234. Parser codes are free from E0112. E0302, E0306 and E0404 onward are also free.
- **TypeScript inference (to verify).** For `std$list$append([$rt.Some(1)], $rt.None)` TypeScript should infer `T` as
  `Some<number>` and reject `None`. The emitter therefore annotates every list literal with its checked type.
- **Nested list types (to verify).** `tsType` prints `List<List<Int>>` as `readonly readonly number[][]`, which
  TypeScript probably rejects (TS1354). `window` and `flatten` put that type into user code. If so, change the `List`
  case of both `tsType` and `ts` in `src/emit.ts` to `ReadonlyArray<...>`.
- **`tsType` already handles function types**, so a list of lambdas emits.
- **The E0222 check for `std.text.show` is a special case by name** (`src/check.ts:877`). `std.list.contains` needs
  the same check.
- **No test uses any of the new std names** as an unknown-function example (grepped).
- **Tests that will change:** `tests/accept_test.ts` (actual values `vals.ratio`, `vals.ports`),
  `tests/spec_test.ts` (inventory 15 becomes 16 definitions), `tests/queries_test.ts` (lists of search hits gain
  entries), and the 7.9 block against `examples/server.alang`.

## 2. Phase 1 in detail

### 2.1 List literal

**Grammar** (add to the spec's grammar block; `list` joins the alternatives of `expr`):

```
list       = "[" expr { "," expr } "]" ;
```

- **Canonical text:** `[a, b, c]`, items separated by `, `, no space inside the brackets, never a line break.
- **Line breaks** inside `[ ]` are ignored on input, as inside parentheses.
- **A trailing comma** is an error (E0101, message "A list ends after its last item; remove the comma before `]`.").
- **One form (rule 3):** a literal has at least one item. The empty list stays `std.list.empty<T>()`.

**AST** (`src/ast.ts`): `| { readonly kind: "list"; readonly items: readonly Expr[] }`.

**Lexer** (`src/lexer.ts`): remove the two `FOREIGN` rows for `[` and `]`; add `"["` and `"]"` to `SYMBOLS`.

**Parser** (`src/parser.ts`):
- `primary()`: on `[`, parse the items with `skipNewlines()` after `[`, after each item and after each comma. `[]`
  parses to `items: []`, so that the checker can give the fix with the type.
- `postfix()`: after its loop, if the next token is `[`, fail with code E0006 and message "There is no index access;
  use `std.list.get(list: xs, index: i)` (4.6)." No valid text has `[` directly after an expression, so this cannot
  misfire.
- `type()`: if `[` follows a type, fail with E0006, message "A list type is written `List<T>`.",
  `expected: "List<T>"`.

**Printer** (`src/printer.ts`): `[${items.map((x) => printExpr(x, indent)).join(", ")}]`; `levelOf` stays `"atom"`.

**Checker** (`src/check.ts`, new case in `infer`, method `listLiteral`):
- `want` is the item type if `expected` is a `List<T>`, otherwise null.
- **Empty literal:** E0228, `at: "[]"`, message "The empty list is written `std.list.empty<T>()`, with its item type
  (1.4)." With a known `want`, `expected` is `std.list.empty<Int>()` (via `toTypeRef(want, this.module)`) and `fix`
  replaces `[]` by it. Without it, `expected` is `std.list.empty<T>()` and there is no fix. Return `ERROR` (5.6).
- **Non-empty:** check each item with `this.expr(item, scope, itemType)`. `itemType` starts as `want`; if null, it
  becomes the type of the first item. Return `list(itemType)`.
- Consequences, all from existing code: `[1.0, 2]` is E0204 with the fix `2.0`; `[None, Some(1)]` without an expected
  type is E0210; `let x: Int = [1]` is E0204; an effectful call in an item follows the usual effect rules.

**Emitter** (`src/emit.ts`): with `T = this.tsType(itemType)` from `this.typeOf(e)`, emit
`([a, b] satisfies ReadonlyArray<T> as ReadonlyArray<T>)`. Items evaluate left to right; an awaited call inside is
fine. An `if`, `match` or `for` as an item reaches the existing E0303.

**References** (`src/refs.ts`): `case "list": return { kind: "list", items: e.items.map(expr) }`.

**Actual values** (`src/examples.ts`): a non-empty list becomes a `list` node; the empty list stays the
`std.list.empty<T>()` call. Remove the "No list literal yet" comment.

**Server example.** Change `examples/server.alang` and the 7.9 block together (`tests/spec_test.ts` compares them
byte for byte). Three lines change; output stays the same (to verify with `alang check` and `tests/http_test.ts`):

- Third example of `server.route`, the expected side:
  `std.http.Response(status: 405, headers: [std.http.Header(name: "allow", value: "POST")], content: "")`.
- In the body of `server.route`:
  `let allow: List<std.http.Header> = [std.http.Header(name: "allow", value: "POST")]`.
- In `server.handle`, the `let line` binding and the print line become one statement:
  `std.console.print_line(text: std.string.join(parts: [request.method, " ", request.path, " -> ", std.text.show(value: response.status)], separator: ""))`.

### 2.2 Int without negative zero (semantics change)

- **Rule:** an `Int` is never `-0`.
- **`src/runtime.ts`:** the shared `int()` helper returns `r === 0 ? 0 : r`, which covers `+ - * / %`
  (`Math.trunc(-1 / 2)` is `-0` too). The same normalisation goes into `std$int$parse` and `std$float$floor`, and into
  the checked functions of 2.3.
- `Float` keeps IEEE `-0.0`.

### 2.3 Standard library

**Type**, appended to `STD_TYPES_SOURCE` after `std.http.ServeError` (`std.fs.Error` must stay first), with
`std$string$Cut` type and constructor in `runtime.ts` like `std$http$Header`:

```
type std.string.Cut
  doc: "A text cut at a separator: the part before it and the part after it."
  record:
    before: String
    after: String
  where: none
end type std.string.Cut
```

**Functions.** Append each group after the existing rows of its module in `STD`; that is also the order of the 7.8
table. Doc strings are exact. Add `const V = tvar("V")`.

| Signature | Doc |
| --- | --- |
| `std.int.min(left: Int, right: Int): Int` | The smaller of two integers. |
| `std.int.max(left: Int, right: Int): Int` | The larger of two integers. |
| `std.int.abs(value: Int): Int` | The value without its sign. |
| `std.int.checked_add(left: Int, right: Int): Option<Int>` | The sum; `None` if it is outside the Int range. |
| `std.int.checked_subtract(left: Int, right: Int): Option<Int>` | The difference; `None` if it is outside the Int range. |
| `std.int.checked_multiply(left: Int, right: Int): Option<Int>` | The product; `None` if it is outside the Int range. |
| `std.string.contains(text: String, part: String): Bool` | Whether the part occurs in the text; the empty part occurs in every text. |
| `std.string.starts_with(text: String, prefix: String): Bool` | Whether the text begins with the prefix. |
| `std.string.ends_with(text: String, suffix: String): Bool` | Whether the text ends with the suffix. |
| `std.string.find(text: String, part: String): Option<Int>` | The position of the first occurrence of the part, counted in Unicode scalar values from 0; `None` if it does not occur. |
| `std.string.cut(text: String, separator: String): Option<std.string.Cut>` | The text before and after the first occurrence of the separator; `None` if it does not occur. |
| `std.string.take(text: String, count: Int): String` | The first `count` Unicode scalar values, or the whole text if it is shorter. A negative count traps. |
| `std.string.drop(text: String, count: Int): String` | The text without its first `count` Unicode scalar values; `""` if it is shorter. A negative count traps. |
| `std.string.characters(text: String): List<String>` | The Unicode scalar values of the text, each as a text of length 1. |
| `std.string.lines(text: String): List<String>` | The lines of the text. A line ends at a line feed, and a carriage return right before it is dropped; a last line without a line break counts, and the empty text has no lines. |
| `std.string.replace(text: String, part: String, with: String): String` | The text with every occurrence of the part replaced, found from left to right without overlap. An empty part traps. |
| `std.string.to_upper(text: String): String` | The text in upper case by Unicode's rules, the same on every system. |
| `std.string.to_lower(text: String): String` | The text in lower case by Unicode's rules, the same on every system. |
| `std.list.first<T>(list: List<T>): Option<T>` | The first item; `None` for the empty list. |
| `std.list.last<T>(list: List<T>): Option<T>` | The last item; `None` for the empty list. |
| `std.list.take<T>(list: List<T>, count: Int): List<T>` | The first `count` items, or the whole list if it is shorter. A negative count traps. |
| `std.list.drop<T>(list: List<T>, count: Int): List<T>` | The list without its first `count` items; empty if it is shorter. A negative count traps. |
| `std.list.reverse<T>(list: List<T>): List<T>` | The items from last to first. |
| `std.list.concat<T>(left: List<T>, right: List<T>): List<T>` | The items of the left list followed by those of the right. |
| `std.list.flatten<T>(lists: List<List<T>>): List<T>` | The items of all the lists, in order. |
| `std.list.contains<T>(list: List<T>, item: T): Bool` | Whether the list holds an item equal to the given one. |
| `std.list.range(low: Int, high: Int): List<Int>` | The integers from `low` to `high`, both included, in ascending order; empty if `low > high`. |
| `std.list.window<T>(list: List<T>, size: Int): List<List<T>>` | Every run of `size` neighbouring items, from first to last; empty if the list is shorter. A size below 1 traps. |
| `std.list.zip<T, U, V>(left: List<T>, right: List<U>, with: (T, U) -> V): List<V>` | Combines the items of two lists pair by pair with the function. Lists of different lengths trap. |
| `std.list.enumerate<T, U>(list: List<T>, with: (Int, T) -> U): List<U>` | Applies the function to the index of every item, counting from 0, and the item. |

**Semantics the runtime must meet:**

- **Unit.** Every position and count is in Unicode scalar values, like `std.string.length`. JavaScript's `indexOf`,
  `slice` and `length` count UTF-16 units: convert the result of `indexOf` with `std$string$length(text.slice(0, i))`,
  and implement `take`, `drop` and `characters` over `Array.from(text)`.
- **Out of range (one rule).** A count above the length takes or drops everything; a negative count traps (kind
  `requires`, as in `std$random$int`, condition text `count >= 0`).
- **Empty needle (one rule).** A question has the mathematical answer: `contains`, `starts_with` and `ends_with` are
  `true`, `find` is `Some(0)`, `cut` is `Some(Cut(before: "", after: text))`. An operation that would act at every
  position traps: `replace` (condition `part != ""`), like `split` today.
- **`lines`.** `""` gives no lines; `"a"`, `"a\n"` give `["a"]`; `"a\r\nb\r\n"` gives `["a", "b"]`; `"a\n\nb"` gives
  `["a", "", "b"]`; `"\n"` gives `[""]`; `"a\r"` gives `["a\r"]`, since only a carriage return before a line feed is
  dropped.
- **`replace`.** Use `text.split(part).join(with)`; `replaceAll` would interpret `$&` in the replacement.
- **`to_upper`, `to_lower`.** `toUpperCase()` and `toLowerCase()`, never the locale forms.
- **Checked arithmetic.** `Number.isSafeInteger(r) ? Some(r === 0 ? 0 : r) : None`.
- **`window`.** A size above the length gives the empty list, a size equal to it one run; size below 1 traps
  (`size >= 1`).
- **`zip`.** Different lengths trap (kind `requires`, condition
  `std.list.length(list: left) == std.list.length(list: right)`).
- **`range`.** More than 4_294_967_295 items traps (kind `overflow`); the limit of a JavaScript array is to verify.

**Checker:** add `withoutFunctions?: readonly string[]` to `Signature` (`src/std.ts`) and `FnSig` (`src/check.ts`).
Set it to `["T"]` for `std.text.show` and `std.list.contains`, and replace the by-name check with a loop over it.
Keep the message form "`<name>` is defined for types without function values (3.9)." (E0222).

### 2.4 Implementation order

After every step: `deno task test`, `deno lint`, `deno fmt --check`, then commit with explicit paths. The run can stop
after any commit. If it must be cut short, drop step 6 (`std.list`) first; it then opens phase 2.

1. **List literals.** Lexer, AST, parser, printer, checker (E0228), emitter, refs, with their tests. Spec: grammar
   block, 7.1 (remove the "List literals" row), 7.2 (foreign forms and layout), 7.5 (new bullet), 7.11 (range becomes
   "E0201 to E0228"). `decisions.md`: Lexical "Foreign forms", new Syntax row "List literal", new Type checking row,
   remove the open question.
2. **Lists in actual values and in the server example.** `src/examples.ts`, `tests/accept_test.ts`,
   `examples/server.alang`, spec 7.9, `decisions.md` row "Actual values".
3. **Int without negative zero.** `src/runtime.ts`, test, one sentence in 7.5 "Arithmetic", a row in `decisions.md`
   "Semantics and runtime".
4. **`std.int`.** `src/std.ts`, `src/runtime.ts`, 7.8 rows, 7.1 row (drop `std.int.min`, `std.int.max`).
5. **`std.string` and `std.string.Cut`.** As step 4, plus the types block in 7.8 and the `spec_test` inventory. The
   7.1 row loses "searching text or reading its characters".
6. **`std.list` and `withoutFunctions`.** As step 4. 7.8's sentence on type parameters gains `V`. The 7.1 row for
   list helpers is replaced by what is still missing: Float functions beyond `floor`, padding and repeating text,
   character codes.
7. **Documents.** Section 2.6.

### 2.5 Tests (about 25)

`tests/syntax_test.ts`:
1. Round trip of `[1, 2, 3]`, `[[1], [2, 3]]`, `[ 1 ,\n 2 ]` (prints `[1, 2]`), a literal as argument, as the right
   side of `==`, with lambda items, and `[]`.
2. E0006 from the parser for `xs[0]`, `f(a: 1)[0]` and `let xs: Int[] = y`; E0101 for `[1, ]` and `[1 2]`.

`tests/check_test.ts`:
3. Item type from the expected type and from the first item; `[1.0, 2]` (E0204 with fix); `[None, Some(1)]` with and
   without an expected type (accepted, E0210); `let x: Int = [1]` (E0204).
4. E0228 with the fix for `let`, `return`, a concrete parameter and the right side of `==`; without a fix for
   `std.list.length(list: [])`.
5. An own-module name written in full inside a literal is E0226; an effectful call inside a literal in a pure
   function is E0230.
6. `std.list.contains` over items with function values is E0222; `std.text.show` still is.

`tests/refs_test.ts` or `tests/rename_test.ts`:
7. A call inside a literal is among the references, and a rename rewrites it.

`tests/emit_test.ts` (TypeScript-checked and run):
8. A program with a list of records, a list of cases, `std.list.append(list: [Some(1)], item: None)`, a nested list
   bound to `List<List<Int>>`, `for n: Int in [1, 2, 3] do`, and a list of two effectful calls (awaited in order).
9. An `if` as a list item is E0303.

`tests/accept_test.ts`:
10. Actual values: `vals.ratio` is `[1.0 / 0.0, -1.0 / 0.0]`; `vals.ports` is
    `[Ok(net.port.Port(value: 80)), Err(net.port.OutOfRange(0)), Err(net.port.NotANumber)]`; an empty actual list
    prints `std.list.empty<Float>()`.

New `tests/std_test.ts`, direct runtime calls with tables:
11. Negative zero: `Object.is(x, 0)` for `int_mul(0, -1)`, `int_rem(-7, 7)`, `int_div(-1, 2)`, `std$int$parse("-0")`,
    `std$float$floor(-0.0)`.
12. `min`, `max`, `abs`.
13. Checked arithmetic at ±9_007_199_254_740_991, and `checked_multiply(0, -1)` is `Some(0)` with positive zero.
14. `contains`, `starts_with`, `ends_with`, `find`, including the empty needle and `find("a😀b", "b")` is `Some(2)`.
15. `cut`: found, not found, separator twice (`"a=b=c"` gives `a` and `b=c`), empty separator.
16. `take` and `drop` on `"a😀b"` with counts 0, 2, 9, and the trap for −1.
17. `characters` (`["a", "😀", "b"]`) and the `lines` table of 2.3.
18. `replace`: `("aaa", "aa", "b")` is `"ba"`; `("a.b", ".", "$&")` is `"a$&b"`; the empty-part trap.
    `to_upper("straße")` is `"STRASSE"` (to verify).
19. `first`, `last`, `take`, `drop`, `reverse`, `concat`, `flatten`, including empty lists.
20. `contains` with records (structural), `range` (`1..3`, `2..2`, `1..0`, `-1..1`), `window` (sizes 1, 2, length,
    length + 1, the trap for 0).
21. `zip` and `enumerate`, and the trap for different lengths.
22. One alang program whose examples call every new function, accepted through `accept`; this type-checks the
    generated calls against the runtime signatures.

Existing, to adapt: `spec_test` inventory (step 5), `queries_test` hit lists, `syntax_test.ts:79` (still E0006). One
`tests/codebase_test.ts` case: a definition with a literal submitted with extra spaces is stored canonically (23).

### 2.6 Documents (step 7)

- **`alang-specs.md` 7.8:** one paragraph with the rules of 2.3 (unit, out of range, empty needle, `lines` against
  `split`, `zip`, `range`, `window`). 7.2: "several texts are joined with
  `std.string.join(parts: [a, b, c], separator: "")`".
- **`docs/decisions.md`:** a section "Text, numbers and lists in std", one row per decision of 2.7 with its principle.
- **`docs/notes.md`:** Current state (Done item 15, test count, Next: this roadmap), a review bullet listing the
  decisions of 2.7, with the language changes named first. In "From the ledger round", mark as resolved: verbosity,
  negative zero, checked arithmetic. In "From files and program I/O": the empty last part (`lines`).
- **`README.md`:** only if it shows list building.

### 2.7 Decisions of phase 1

Language changes are marked **[language]**.

| # | Recommendation | Reason by principle | Strongest alternative |
| --- | --- | --- | --- |
| L1 **[language]** | The literal is `[a, b, c]` | 3: nearly every language and `std.text.show` write it so, which concentrates the model's probability; 5.1: examples can state lists | `List(1, 2, 3)`, which needs no new symbol but looks like a case with several values (4.2) |
| L2 **[language]** | At least one item; `[]` is E0228 with the fix `std.list.empty<T>()` | 3: one spelling of the empty list; 1.4 names `std.list.empty<Int>()` for exactly this | `[]` typed from the expected type like `None`, and `std.list.empty` removed |
| L3 **[language]** | The item type comes from the expected type, otherwise from the first item | 1.4 | Unify over all items, which reads rightwards |
| L4 **[language]** | `xs[0]` and `Int[]` stay E0006, now from the parser | 4.6, 5.7 | None worth recording |
| L5 **[language]** | No trailing comma; line breaks inside brackets ignored; printed on one line | 3.7 | Allow a trailing comma on input and drop it in print |
| L6 | The append chain stays legal | 3 is about forms of the grammar, not about equal values (`1 + 1` and `2`) | A diagnostic with a fix for `append(empty, x)` |
| L7 | Actual values print literals | 1.2, 3.7: the text can be pasted into an example | Keep append chains |
| S1 **[language]** | An `Int` is never `-0` | 3.9: `x == y` then means the same value everywhere; today `1.0 / std.int.to_float(value: x)` tells them apart | Leave it and document it |
| S2 | Positions and counts are in Unicode scalar values | Overview (`String`), as `length` and string order | UTF-16 units, the host's unit |
| S3 | `take` and `drop` clamp above the length and trap below zero | 4: no length arithmetic before the call; 5.3: a negative count is a programming error | `Option` results |
| S4 | The empty-needle rule of 2.3 | 3: one rule for six functions | Trap in all of them |
| S5 | `cut` with the record `std.string.Cut` | 4: a `key=value` line is taken apart without computing positions; 4.3: a record, not a pair | Only `find` with `take` and `drop` |
| S6 | No `slice` and no `concat_all`: `take` and `drop` slice, and `std.string.join(parts: [a, b, c], separator: "")` joins several texts | 3: one form each | `std.string.concat_all(parts)` |
| S7 | `lines` follows `std.console.read_line` | 3: one notion of a line | Split at `\n` only |
| S8 | `zip` and `enumerate` take a function instead of returning pairs | 4.3: no tuples, the caller names its own record; needs no generic std type; the names of 4.6 are kept and freeze under 3.8 | Wait for phase 7 and return `List<std.list.Pair<A, B>>` |
| S9 | `zip` traps on different lengths | 5: a silent cut hides an error, and an example shows the trap at acceptance | Stop at the shorter list, as most languages do |
| S10 | `range(low, high)` includes both ends; empty if `low > high` | 4: no off-by-one; the same names and bounds as `std.random.int` | Half-open `from` and `until` |
| S11 | `contains` requires a type without function values (E0222) | 3.9 | Compare functions by identity |
| S12 | `checked_add`, `checked_subtract`, `checked_multiply` return `Option<Int>` | 2.3: an expected error is in the type | `Result<Int, std.int.Overflow>` |
| S13 | The name `find` | 3.8 freezes it; it returns an `Option`, as `find` does in Rust | `index_of` |
| S14 | Case mapping by Unicode's default rules | 2.6: no dependence on the system's language | Locale-aware mapping |

## 3. Later phases

### Phase 2: `std-maps`

- **Scope:** `std.map.empty<K, V>()`, `insert`, `get`, `remove`, `contains`, `size`, `keys`, `values`,
  `from_list(list, key, value)`, `to_list(map, with: (K, V) -> T)`; a map literal; actual values of maps as literals
  (closes a temporary limit). `std.float`: `compare`, `parse`, `round`, `ceiling`, `truncate`, `abs`, `min`, `max`,
  `sqrt`, a fixed-decimals text. Text: `pad_left`, `pad_right`, `repeat`, character codes. Lists: `any`, `all`,
  `find`.
- **M1 [language], the main decision: key types.** The runtime's `eq` and a JavaScript `Map` find keys by identity, so
  record, variant or list keys would break structural `==` (3.9). Recommendation: keys are `Int` or `String` only (a
  checker rule on `Map<K, V>`, code E0229), and `keys`, `values` and `show` go in key order, so equal maps show alike.
  Alternative: any type without functions, keyed by its `show` text, in insertion order.
- **M2 [language]: literal `["a": 1, "b": 2]`**, at least one entry, empty as `std.map.empty<K, V>()`. Reason: 5.1, as
  for lists; braces stay a foreign form (5.7). Alternative: no literal, `std.map.from_list` only.
- **M3:** a key written twice in a literal is an error for literal keys, and a trap otherwise. Alternative: the later
  entry wins.
- **Risks:** every `insert` copies the map, as `append` copies a list; `Float` rounding rules need one choice (half
  away from zero recommended).

### Phase 3: `std-net`

- **Scope:** `std.http.send(method, url, headers, content, timeout_milliseconds): Result<std.http.Response, std.http.SendError>`,
  `std.time.wait_milliseconds`, `std.console.print`, `std.fs.create_text`.
- **N1:** the client reuses `Header` and `Response`, and gets its own error type with cases `InvalidUrl`,
  `Unreachable`, `TimedOut`, `Failed: String`. Case names are unique per module, so it cannot reuse `Other` or
  `PermissionDenied` of `ServeError`. Alternative: one `std.http.Error` for server and client, as in `std.fs`.
- **N2:** the timeout is a parameter (2.6: no defaults). Redirects are followed. Alternative: a fixed timeout.
- **N3, reopening `std.fs.Error`:** recommended, before publishing. Add `AlreadyExists` together with
  `std.fs.create_text`, which creates a file only if none exists. Reasons: 3.8 and E0227 make the list final at
  publishing; both hosts report an existing file distinctly (`Deno.errors.AlreadyExists`, `EEXIST`; to verify); a
  lock file or "do not overwrite" cannot be written today. This overrides the user's choice D2, so build it in its own
  commit and list it first under "Decisions awaiting the user's review". Alternative: keep four cases, and
  `create_text` returns `Result<Bool, std.fs.Error>` with `Ok(false)` for an existing file. **Main session:** N3
  undoes a decision the user made explicitly, so ask the user before phase 3 starts. **Approved by the user on
  2026-11-13** (after the logstat round): build N3 as recommended, and add a std function that turns a
  `std.fs.Error` into text.
- **Risks:** `send` is the first runtime function that really waits; Deno and Node.js must agree on errors; tests run
  against the phase's own `std.http.serve`.

### Phase 4: `statements`

- **T1 [language], propagating `Result<Unit, E>`:** a statement `expression else return value`, allowed exactly when
  the content type is `Unit`. This adds a second line to the "Propagate an error" row of section 3. One form is kept
  by rejecting `let name: Unit = ... else return ...` with a mechanical fix, so each content type has one spelling.
  Alternative: keep the dummy binding.
- **T2 [language], shared arms:** `case Err(std.fs.PermissionDenied), Err(std.fs.IsADirectory) then`. Every
  alternative binds the same names with the same types. 3.3 holds: every case is still named, and a case added later
  is still reported. Alternative: keep one arm per case and share through a helper function.
- **Risks:** exhaustiveness, E0214 and E0227 must treat each alternative as its own pattern; the emitter binds names
  from whichever alternative matched.

### Phase 5: `fn-types`

- **F1 [language], type syntax:** `(T, U) -> V`, at least one parameter. It is the notation 7.8, the diagnostics and
  `search_type` already show. Alternative: named parameters, `(left: T, right: T) -> Order`.
- **F2 [language], applying a function value:** `by(a, b)` with positional arguments, on a local or a field of
  function type. A call with named arguments is always a definition call, so the two never collide. This departs from
  4.1; the reason is that a function type has no parameter names, as a case's value has none (4.2). Alternative: with
  named types, `by(left: a, right: b)` keeps 4.1 but gives one type many spellings, against 3.7.
- **F3:** user function types are pure (2.4); `with effects` stays the std exception. Alternative: allow it in user
  signatures, with the caller declaring the effects.
- **Risks:** `TypeRef` becomes a union, which touches `resolveType`, `printTypeRef`, `ts`, `refs.ts`, `toTypeRef`,
  `search.ts` and `interface.ts`; E0220 (method call) must stay for named arguments on a local.

### Phase 6: `const`

- **C1 [language], form:** sections `doc`, `out`, `body`, ended by `end const name`; the body is statements ending in
  `return`. No new reserved word: `value` cannot be reserved, since it names fields and parameters everywhere
  (`Port(value: 8080)`). Alternative: `out:` plus a one-expression section under a new reserved word such as `is:`.
- **C2 [language]:** a constant is referenced without parentheses, short in its module; a plain name resolves to a
  local, then a constant, then a function. It is pure, has no examples, and is evaluated once on first use; acceptance
  evaluates every constant, and a trap there rejects it (E0404). A constant that depends on itself traps (kind
  `cycle`). Alternative: eager evaluation in dependency order with a static cycle check.
- **Risks:** a new definition kind runs through the codebase (kind column, interface rule, refs, rename, `list`, MCP
  tool descriptions).

### Phase 7: `generics`

- **G1 [language]:** type parameters in the header, `fn list.util.last<T>` and `type tree.Tree<T>`; the end line names
  the path without them. It mirrors the call form `name<T>(...)`. Alternative: a `types:` section with a new reserved
  word.
- **G2 [language]:** inside a generic body, `==`, the order operators and `std.text.show` are not defined on a type
  parameter; the caller passes a function (3.9). Alternative: allow them and check every call site for function
  values, which makes the rule depend on the body, against principle 2.
- **Risks:** the largest checker change (user types gain arguments, shapes need substitution, a bare generic case
  needs an expected type like `None`). Split into functions first, types second, if one run does not hold both.

### Phase 8: `extern-fn`

- **E1 [language]:** every section of a `fn`, with `target: "<module>#<export>"` instead of `body:`, ended by
  `end extern fn name`. A pure one needs examples (5.1), which test the assumption. Alternative: inline TypeScript
  text as the target.
- **E2:** the generated code checks each result against `out` at the boundary and traps otherwise (the Overview
  already requires this for NaN). Alternative: trust the result.
- **Risks:** examples run foreign code in the tool's process with the tool's permissions; the hash covers the target's
  name, not its code; a pure extern must be synchronous.

## 4. Decisions across phases

- **X1: std stays in TypeScript** (`src/std.ts` and `src/runtime.ts`). Reason: moving it to alang needs phases 5, 7
  and 8 and gives the user nothing visible; the sync test already guards it. This departs from the brief's premise that
  std needs `extern fn`. Alternative: rewrite std as `extern fn` definitions after phase 8; revisit for self-hosting.
- **X2: Float, Map and effectful functions are not in phase 1**, so that it stays one run.
- **Playground round after phase 1** (the main session's call): a word-count task over a file, run without the
  advisor, watching whether the model uses `list("std")` and `context`.
