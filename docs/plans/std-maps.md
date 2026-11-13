# Plan: phase 2, `std-maps`

Written by the Opus planner, 2026-11-13, from `main` at `00843a9` (`list-literals` merged). At the time of planning, the `card` branch held `src/card.ts`, `tests/card_test.ts` and edits to `src/mcp.ts`, all uncommitted.

Nothing was run or written during planning. Every expected value is computed by hand; where one disagrees with a stated rule, the rule wins and the implementer reports it. "To verify" marks facts the planner did not test.

The main session takes every recommendation. **[language]** marks decisions that change the language.

**Branch:** `std-maps` from `main`. If `card` is merged by then (`src/card.ts` exists), steps 3 and 4 also edit the card; otherwise skip those edits and note it.

## 1. Findings that shape the phase

1. **`Map<K, V>` exists only as a type.** It is in `BUILTIN_TYPES` (`src/types.ts:48`, arity 2), with the helper `map(k, v)` (`types.ts:35`). No std function creates one, so its runtime form can change without breaking any program.

2. **The runtime assumes a JavaScript `Map`.**
   - `eq` (`src/runtime.ts:74`) uses `has` and `get`, which compare object keys by identity.
   - `std$text$show` (`runtime.ts:1161`) prints `{k: v}` in insertion order. That contradicts the literal (M2), and two equal maps can show differently.

3. **The emitter writes `ReadonlyMap<K, V>`**, in `tsType` (`src/emit.ts:177`) and in `ts` (`emit.ts:209`).

4. **Actual values of maps fall back to `std.text.show`.** `valueExpr` (`src/examples.ts:169`) returns `null` for a `Map`. `tests/accept_test.ts:286` asserts `{1: 2}`, and "Temporary limits" in `docs/decisions.md` records the gap.

5. **A `Map` type comes into being in three ways.**
   - A written type goes through `resolveType` (`src/check.ts:350`), which checks only the arity.
   - A std call binds type variables by `unify` and returns `substitute(sig.out)` (`check.ts:888`). So `from_list` with a key lambda that returns a record builds `Map<Point, V>` without the type ever being written.
   - The new literal.

   The `withoutFunctions` loop (`check.ts:881`) is the model for a check after unification.

6. **Four exhaustive switches over `Expr`.**
   - `infer` (`check.ts:626`), `printExpr` (`src/printer.ts:198`), `expr` inside `rebuild` (`src/refs.ts:145`) and `expr` (`emit.ts:463`); also `valueExpr` in `examples.ts`.
   - `levelOf` (`printer.ts:121`) treats every non-binary node as an atom, so a map needs no change there.

7. **The parser.**
   - `listExpr` (`src/parser.ts:625`) is where a map branches off: after `[` and the first expression, a `:` means a map. This is decidable from left to right (1.1).
   - Two messages need extending: the index-access message in `postfix` (`parser.ts:524`), and the `{` and `}` rows of `FOREIGN` (`src/lexer.ts:96–103`).

8. **E0228 and unwritable types.**
   - `listLiteral` (`check.ts:1079`) reports `[]` under an expected `Map` with the list message and no fix.
   - `toTypeRef` (`check.ts:1486`) writes `Unit` for a function type; `writable` (`check.ts:1481`) guards only E0228.
   - Not guarded: `guessTypeArgs` (`check.ts:920`, an E0209 fix can name `Unit`) and `valueExpr` (the `std.list.empty<Unit>()` note).

9. **`for` checks its iterable without an expected type** (`check.ts:1206`). So `for x: Option<Int> in [None, Some(1)]` is E0210. The test "if and for" in `tests/check_test.ts` asserts E0204 at the declared type, with a fix, for a non-literal iterable; that must stay.

10. **Free diagnostic codes** (grepped in `src/`).
    - E0229 is unused.
    - E0231 is unused but sits inside the effects block E0230–E0233; leave it.
    - E0234 onward is free, and parser codes are free from E0112.

11. **Tests that pin std lists or exact texts.**
    - `check_test`, "std signatures and runtime exports match": every `std$` export must match `STD`, so runtime helpers must not start with `std$`.
    - `tests/spec_test.ts` compares the 7.8 rows with `signatureLine`, and the types block with `STD_TYPES_SOURCE`.
    - `tests/queries_test.ts` pins:
      - `list("std").submodules`;
      - the `searchType` lists for `List<Int>, _ -> List<_>`, `List<String>, _ -> List<Int>` and `-> _`;
      - `searchText("PORT")` and `("file")`. These are substring matches, so no new doc may contain "port" (support, report, import) or "file".
    - `accept_test.ts:286`.
    - The index-access message in `tests/syntax_test.ts`, "lists: no index access…".
    - `card_test`, if merged:
      - every std name and code the card names must exist;
      - `search_type("String, String -> List<String>")` must give exactly `std.string.split`;
      - the card stays below 10,240 bytes and 160 lines. Today `src/card.ts` is 9,670 bytes including its header comment.

12. **Finding std without the spec.** The card sends the model to the query tools, and each shows little:
    - `list(module)` gives only name, kind and doc.
    - `context` of a std function gives one line (signature, effects, doc). Its `uses` holds only named types; it is `[]` for `std.list.map`.
    - `search` is a case-insensitive substring match over names and docs.

    So the prose of 7.8 is invisible in that round. **Every trap, cost and order rule must be in the doc line.** The literal forms are not std, so the card must state them, and the docs of `std.list.empty` and `std.map.empty` repeat them.

13. **Node.js runs `runtime.ts` by type stripping.** That rules out parameter properties and enums; declare class fields as `Trap` does.

14. **Names.** `default` is not a reserved word, but `then` is, so no function can be named `then`. `with:` accepts a named pure function (`with: parse_line`).

## 2. Design

### 2.1 Map values at runtime (M4, M5)

A `Map` is a persistent AVL tree ordered by key. Key order is an invariant of the value, not something applied on read. Place the class in the "built-in types" section at the top of `runtime.ts`, before `eq`:

```ts
type MapNode<K, V> = {
  readonly key: K; readonly value: V;
  readonly left: MapNode<K, V> | null; readonly right: MapNode<K, V> | null;
  readonly height: number;
};
export class SortedMap<K, V> {
  readonly root: MapNode<K, V> | null;
  readonly size: number;
  constructor(root: MapNode<K, V> | null, size: number) { this.root = root; this.size = size; }
}
```

- **Data only, no methods.** So TypeScript treats `SortedMap<string, Some<number>>` as assignable to `SortedMap<string, Option<number>>`.
- **Key order.** `keyOrder(a, b)` orders numbers by value and strings with `str_compare` (Unicode scalar values). Never use `<` on strings, or `.sort()` without a comparator.
- **Internal helpers.**
  - `node` computes the height; `balance` does single and double rotations.
  - `put(n, key, value): [node, existed]` copies the path.
  - `del(n, key): [node | null, removed]` replaces a node with two children by the minimum of its right subtree.
- **`export function map_entries<K, V>(m): (readonly [K, V])[]`** walks in order with an explicit stack. `eq`, `show`, `examples.ts` and the std functions use it.
- **`eq`.** A `SortedMap` branch before the generic object branch: equal `size`, then entries pairwise, keys with `===` and values with `eq`. Remove both `instanceof Map` branches.
- **`std$text$show`.** `["a": 1, "b": 2]` in key order; `[:]` for the empty map.
- **The literal.** `export function map_literal<K, V>(entries: ReadonlyArray<readonly [K, V]>, definition: string): SortedMap<K, V>`. A key that is already there traps: `trap("key", definition, show(key), \`The key ${show(key)} appears twice in a map literal.\`)`.
- **Costs.**
  - `get`, `contains`, `insert`, `remove`: O(log n).
  - `size`: O(1).
  - `keys`, `values`, `to_list`, `==`, `show`: O(n).
  - `from_list`: O(n log n).
- **Emitter.** `tsType` and `ts` give `${RT}.SortedMap<K, V>` for a `Map`.

### 2.2 Map literal (M2, M3)

**Grammar.** `expr` gains `| map`:

```
map        = "[" expr ":" expr { "," expr ":" expr } "]" ;
```

**Canonical text.**
- `["a": 1, "b": 2]`: every entry is `key: value`, with no space before the colon and one after it.
- Entries are separated by `, ` and printed on one line, never broken.
- Line breaks inside the brackets are ignored on input, around `:` too.
- `[:]` parses only so that E0228 can name its spelling `std.map.empty<K, V>()`, and prints as `[:]`.

**AST** (`src/ast.ts`).
- `| { readonly kind: "map"; readonly entries: readonly MapEntry[] }`, with `export interface MapEntry { readonly key: Expr; readonly value: Expr }`.
- Comment the empty case as the list one is.

**Parser.** Rename `listExpr` to `bracketExpr`.
1. After `[` and `skipNewlines`:
   - `:` then `]` is the empty map;
   - `]` alone is the empty list.
2. Parse the first expression, then `skipNewlines`.
3. A `:` there makes the literal a map; anything else keeps the list path as it is.
4. In the map loop, call `skipNewlines` around `:` and `,`.
5. Errors (E0101):
   - a comma before `]` in a map: "A map ends after its last entry; remove the comma before `]`.";
   - an entry without `:` in a map: "Every entry of a map is `key: value`.";
   - a list item followed by `:`: "A list holds items without `:`; in a map, every entry is `key: value`, the first one too."
6. The index-access message in `postfix` (E0006) becomes: "There is no index access; use `std.list.get(list: xs, index: i)` or `std.map.get(map: m, key: k)` (4.6)."
7. The lexer message for `{` and `}` (E0006) becomes: "There are no curly braces; blocks end with `end if`, `end for`, `end match`, `end fn <name>`, and a map is written `[key: value]`."

**Printer.** `[${entries.map((x) => \`${printExpr(x.key, indent)}: ${printExpr(x.value, indent)}\`).join(", ")}]`, and `[:]` for no entries.

**References** (`refs.ts`). `case "map": return { kind: "map", entries: e.entries.map((x) => ({ key: expr(x.key), value: expr(x.value) })) }`.

**Checker** (a new `mapLiteral`, called from `infer`).
- **Expected types.** `want` is `[K, V]` if `expected` is a `Map`, otherwise null.
- **The empty map `[:]`:** E0228, `at: "[:]"`, message "The empty map is written `std.map.empty<K, V>()`, with its key and value types (1.4)." It returns `ERROR`.
  - If the expected type is a `Map` whose arguments are `writable`: `expected` and the fix are `std.map.empty<String, Int>()` (via `toTypeRef`).
  - If the expected type is a `List`: the list message and its fix instead.
  - Otherwise: `expected: "std.map.empty<K, V>()"` and no fix.
- **`[]` under an expected `Map`.** `listLiteral` gives the map message and the fix `std.map.empty<K, V>()` (H6).
- **Entries.**
  - Check each key with `this.expr(key, scope, keyType)` and each value with `this.expr(value, scope, valueType)`.
  - `keyType` and `valueType` come from `want`, otherwise from the first entry.
- **An unknown bare name as a key (5.7, the habit from JavaScript object keys).** Before checking a key that is a one-segment `name` with no local and no module function of that name:
  - report E0203 at the name, with the message "Unknown name `name`; a map key is a value, so a text key is written in quotes: `"name"`.";
  - `expected` is the quoted text (`printString`), and the fix replaces the name by it;
  - that key's type is `ERROR`.
- **Wrong key type (E0229).** Only when the key type was inferred (`want` null) and `expected` does not contain the error type. Then a key type other than Int or String is E0229 at the printed literal, and the literal returns `ERROR`.
- **Duplicate literal keys (E0234).**
  - Applies to keys that are int or string literals, compared by value.
  - Reported at the later entry as printed (`"a": 2`), with the message "The key `"a"` already has an entry in this map; write each key once." There is no fix.
  - The result type stays as computed.
- **Result type:** `map(keyType, valueType)`.
- **`for` over a `Map`.** The existing E0204 message gains "; take `std.map.keys` or `std.map.to_list` of it."

**Emitter.** With `t = this.typeOf(e)`, emit `${RT}.map_literal<${tsType(K)}, ${tsType(V)}>([[k1, v1], [k2, v2]], ${JSON.stringify(this.name)})`.
- Entries are evaluated from left to right, key before value; awaited calls inside are fine.
- An `if` as a key or value reaches E0303, as in a list.

**Actual values** (`examples.ts`, the `Map` case).
- A non-empty map becomes a `map` node from `map_entries` in key order, with keys and values through `go`.
- An empty map becomes `std.map.empty<K, V>()` if both arguments are `writable`; otherwise `null`, which falls back to `show` and prints `[:]`.
- The `List` case does the same for the empty list (H5).
- Export `writable` from `check.ts`, and remove the comment that maps fall back.

### 2.3 Map keys (M1) and E0229

Add the helper `keyOk(k) = isBottom(k) || containsError(k) || k is Int || k is String`.

The message is the same at every site: "Map keys are `Int` or `String`, found `Float`; key the map by an `Int` or `String` field, or keep a `List` of records." Its `expected` is "Int or String", and there is no fix.

**Sites:**
1. **`resolveType`.** A `Map` whose first argument fails `keyOk` is reported at `printTypeRef(ref)`, and `resolveType` returns `ERROR`.
2. **`call`.** Only when `sig.typeParams.length > 0` (std calls; user signatures were checked at their own types).
   - After `out` is substituted, walk it (`con` arguments, and `fn` parameters and result) for a `Map` with a bad key.
   - If one is found, report it at the call and return `ERROR`.
   - This catches `std.map.empty<Float, Int>()` and `std.map.from_list(..., key: fn(p: Point): Point => p, ...)`.
3. **`mapLiteral`**, as described in 2.2.

**One cause, one report (5.6).**
- In `call` and in `mapLiteral`, if `expected` contains the error type, return `ERROR` without reporting E0229.
- Without this rule, `let m: Map<Point, Int> = std.map.empty<Point, Int>()` would report twice: once at the type, once at the call (which builds `Map<Point, Int>` from its own type arguments).
- Elsewhere, `ERROR` from the first report keeps `unify` from binding and so suppresses follow-ups.

### 2.4 Standard library

**Doc changes and placement.**
- Changed doc of **`std.list.empty`**: "The empty list. A list with items is written as a literal, such as `[1, 2, 3]`."
- Append `std.map` after the `std.list` rows, then `std.option`, then `std.order`, then the existing `std.text`. Append every other group after the last row of its module.
- Add `const K = tvar("K")`, and import `map` from `types.ts`.
- The 7.8 sentence on type parameters lists `T`, `U`, `V`, `A`, `K`.
- A doc that contains `""` is written in single quotes, as in phase 1.

**Maps** (all pure):

| Signature | Doc |
| --- | --- |
| `std.map.empty<K, V>(): Map<K, V>` | The empty map. A map with entries is written as a literal of `key: value` pairs, such as `[1: 10, 2: 20]`; keys are Int or String. |
| `std.map.insert<K, V>(map: Map<K, V>, key: K, value: V): Map<K, V>` | The map with `key` bound to `value`, replacing an earlier value of `key`. Takes time logarithmic in the size of the map, so counting or grouping item by item in `std.list.fold` is fine. |
| `std.map.get<K, V>(map: Map<K, V>, key: K): Option<V>` | Looks up the value of `key`; `None` if the map has no such key. |
| `std.map.remove<K, V>(map: Map<K, V>, key: K): Map<K, V>` | The map without `key`; the same map if it has no such key. |
| `std.map.contains<K, V>(map: Map<K, V>, key: K): Bool` | Whether the map has `key`. |
| `std.map.size<K, V>(map: Map<K, V>): Int` | Number of keys. |
| `std.map.keys<K, V>(map: Map<K, V>): List<K>` | The keys in ascending order: Int keys by value, String keys as `std.string.compare` orders them. |
| `std.map.values<K, V>(map: Map<K, V>): List<V>` | The values, in the order of their keys. |
| `std.map.from_list<T, K, V>(list: List<T>, key: (T) -> K, value: (T) -> V): Map<K, V>` | A map with an entry for every item, its key and value computed by the two functions. Two items with the same key trap; to keep the last or combine them, use `std.list.fold` with `std.map.insert`. |
| `std.map.to_list<K, V, T>(map: Map<K, V>, with: (K, V) -> T): List<T>` | Applies the function to every key and its value, in the order of the keys. |

**Options, order and lists:**

| Signature | Doc |
| --- | --- |
| `std.option.with_default<T>(option: Option<T>, default: T): T` | Unwraps an Option: the value inside `Some`, or `default` for `None`. |
| `std.option.map<T, U>(option: Option<T>, with: (T) -> U): Option<U>` | Applies the function to the value inside `Some`; `None` stays `None`. |
| `std.order.then_by(first: Order, second: Order): Order` | Breaks ties: `first`, unless it is `Equal`; then `second`. Compares by several keys in one expression. |
| `std.list.any<T>(list: List<T>, with: (T) -> Bool): Bool` | Whether the function is true for some item; `false` for the empty list. Stops at the first item for which it is true. |
| `std.list.all<T>(list: List<T>, with: (T) -> Bool): Bool` | Whether the function is true for every item; `true` for the empty list. Stops at the first item for which it is false. |
| `std.list.find<T>(list: List<T>, with: (T) -> Bool): Option<T>` | The first item for which the function is true; `None` if there is none. Stops at that item. |
| `std.list.filter_map<T, U>(list: List<T>, with: (T) -> Option<U>): List<U>` | Applies the function to every item and keeps the values inside its `Some` results, in order: `map` and `filter` in one. |
| `std.list.take_while<T>(list: List<T>, with: (T) -> Bool): List<T>` | The items from the start for which the function is true, up to the first for which it is false. Stops there. |
| `std.list.drop_while<T>(list: List<T>, with: (T) -> Bool): List<T>` | Skips the items from the start for which the function is true: the rest of the list from the first item for which it is false. |

**Text:**

| Signature | Doc |
| --- | --- |
| `std.string.repeat(text: String, count: Int): String` | The text `count` times in a row; `""` for 0. A negative count traps. |
| `std.string.pad_left(text: String, width: Int, fill: String): String` | The text with `fill` added before it until it is `width` Unicode scalar values long, to align text in columns; unchanged if it is that long already. A `fill` that is not exactly one Unicode scalar value traps. |
| `std.string.pad_right(text: String, width: Int, fill: String): String` | The text with `fill` added after it until it is `width` Unicode scalar values long, to align text in columns; unchanged if it is that long already. A `fill` that is not exactly one Unicode scalar value traps. |
| `std.string.trim_characters(text: String, characters: String): String` | Strips every character that occurs in `characters` from both ends of the text, such as quotes or punctuation; `std.string.trim` strips whitespace. |
| `std.string.code_points(text: String): List<Int>` | The character codes (code points) of the text: every Unicode scalar value as its number, such as 97 for `a`. |
| `std.string.from_code_points(code_points: List<Int>): String` | The text with the given character codes (code points). A number that is not a Unicode scalar value (below 0, above 1_114_111, or from 55_296 to 57_343) traps. |

**Float:**

| Signature | Doc |
| --- | --- |
| `std.float.compare(left: Float, right: Float): Order` | Orders two numbers. |
| `std.float.parse(text: String): Option<Float>` | Reads a decimal number written as an optional `-`, the digits `0` to `9`, and optionally `.` and more digits (`3`, `-0.25`, `007.5`). `None` for anything else (`+`, `.5`, `1.`, `1e3`, whitespace, the empty text) and for a number too large to be finite. |
| `std.float.round(value: Float): Int` | The nearest integer, halves away from zero (`2.5` gives 3, `-2.5` gives -3); traps outside the Int range. |
| `std.float.ceil(value: Float): Int` | The smallest integer not below the value; traps outside the Int range. |
| `std.float.trunc(value: Float): Int` | The value without its fraction, toward zero; traps outside the Int range. |
| `std.float.abs(value: Float): Float` | The absolute value: the value without its sign. |
| `std.float.min(left: Float, right: Float): Float` | The smaller of two numbers. |
| `std.float.max(left: Float, right: Float): Float` | The larger of two numbers. |
| `std.float.sqrt(value: Float): Float` | The square root. A negative value traps. |
| `std.float.to_fixed(value: Float, decimals: Int): String` | Formats the value as decimal text with exactly `decimals` digits after the point (`1.5` with 2 gives `1.50`), rounded half away from zero; never in exponent form, and without a minus sign when only zeros show. Infinities give `Infinity` and `-Infinity`. A `decimals` below 0 or above 100 traps. |

**Runtime semantics** (`runtime.ts`; TypeScript parameter names are free, so `with_default`'s parameter is `fallback`).

*Maps:*
- **`insert`:** `[root, existed] = put(...)`; the size grows by 1 unless the key existed.
- **`remove`** of a missing key returns the same object.
- **`from_list`:** for each item in order, `key(item)`, then `value(item)`, then `put`. A key that existed traps:
  - kind `key`, definition `"std.map.from_list"`, `at` the shown key;
  - message `The key ${shown} appears twice in the list given to std.map.from_list.`

*Lists, options and order:*
- **`any`, `all`, `find`, `take_while` and `drop_while`** loop and stop at the deciding item. Since the functions are pure, stopping is observable only as a trap in a later item that then does not happen.
- **`filter_map`** keeps `r.value` wherever `r.tag === "Some"`.
- **`then_by`** is `first.tag === "Equal" ? second : first`.

*Text:*
- **`repeat`:** `countAtLeastZero("std.string.repeat", count)`, then `text.repeat(count)`. A result too long for the host ends with the host's RangeError, not a trap, like `range` running out of memory.
- **`pad_left` and `pad_right`:**
  - Check `fill` first, so a bad fill traps even when nothing would be added: kind `requires`, condition `std.string.length(text: fill) == 1`.
  - Then `n = std$string$length(text)`. If `n >= width` (any width, negative ones too), return `text`.
  - Otherwise put `fill.repeat(width - n)` before or after it.
- **`trim_characters`:** a `Set` of `Array.from(characters)`, walked from both ends of `Array.from(text)`, then joined. Empty `characters` leaves the text unchanged.
- **`code_points`:** `Array.from(text, (c) => c.codePointAt(0)!)`.
- **`from_code_points`:**
  - First validate every number. One outside 0..1_114_111, or inside 55_296..57_343, traps: kind `requires`, `at` the number, message `Precondition of std.string.from_code_points violated: ${n} is not a Unicode scalar value.`
  - Then build the text with `String.fromCodePoint(...chunk)` over chunks of 4096 numbers, never with one spread of the whole list.

*Float:*
- **`compare`:** `left < right ? Less : left > right ? Greater : Equal`, so `-0.0` and `0.0` are `Equal`, as under `==`.
- **`parse`:** test `/^-?[0-9]+(\.[0-9]+)?$/`, then `Number`; `None` unless the result is finite. `"-0"` gives `-0.0`, which is a valid Float.
- **`round`, `ceil`, `trunc`:**
  - `round` computes `Math.sign(v) * Math.round(Math.abs(v))`; `ceil` uses `Math.ceil`; `trunc` uses `Math.trunc`.
  - All three go through one helper. A result that is not a safe integer traps as `floor` does: kind `overflow`, the function's name, `String(value)`, "Float outside the Int range."
  - Otherwise the helper applies `intZero` (S1). Infinities trap there.
  - To verify: `Math.round(0.49999999999999994)` is `0`.
- **`abs`:** `Math.abs`, so `abs(-0.0)` is `0.0`.
- **`min` and `max`:** `left <= right ? left : right` and `left >= right ? left : right`, so the left value wins on equality.
- **`sqrt`:** traps before `Math.sqrt` (kind `requires`, condition `value >= 0.0`), so it never reaches the NaN trap. `-0.0` passes.
- **`to_fixed`:**
  - A `decimals` outside 0..100 traps: kind `requires`, condition `0 <= decimals and decimals <= 100`.
  - `±Infinity` gives `"Infinity"` or `"-Infinity"`.
  - Otherwise, with `m = Math.abs(value)`: `digits = m < 1e21 ? m.toFixed(decimals) : BigInt(m).toString() + (decimals > 0 ? "." + "0".repeat(decimals) : "")`.
  - Prefix `-` only if `value < 0` and `digits` contains `[1-9]`.
  - `toFixed` breaks a tie toward the larger magnitude, on the exact binary value. To verify: `1.005` with 2 gives `1.00`, `0.125` with 2 gives `0.13`, `2.5` with 0 gives `3`, `-0.001` with 2 gives `0.00`.

### 2.5 Smaller changes

- **H4 [language]: `for` passes its type to a list literal.**
  - In `blockExpr`, the `for` case resolves `declared` first. If `e.iterable.kind === "list"`, the iterable is checked with `this.expr(e.iterable, scope, list(declared))`; otherwise as now.
  - So `for x: Float in [1]` is E0204 at `1` with the fix `1.0`, as `let xs: List<Float> = [1]` is.
  - `for x: Int in []` is E0228 with the fix.
  - Non-literal iterables keep E0204 at the declared type.
- **H5: empty collections whose type cannot be written.**
  - An empty actual list or map whose type holds a function type prints through `std.text.show` (`[]`, `[:]`).
  - `guessTypeArgs` returns null unless every guessed type is `writable`.
- **The card** (`src/card.ts`, if merged). The size limits are to verify by `card_test`.
  - **Step 3.** After the Lists bullet in "Expressions", add: "Maps: `["a": 1, "b": 2]` is a `Map<String, Int>`; keys are `Int` or `String` (E0229), each written once (E0234); the empty map is `std.map.empty<K, V>()`, never `[:]` (E0228). No `m["a"]`: `std.map.get` gives an `Option`." In "Not in alang", remove "Map functions (use a `List` of records; to count, sort and count runs)".
  - **Step 4.** These names exist only from step 4 on, and `card_test` checks every std name. Add to the Lambdas bullet: "an `Option` inside one is unwrapped with `std.option.with_default` or `std.list.filter_map`."

## 3. Implementation order

After every step, run `deno task test`, `deno lint` and `deno fmt --check`. Then check `git status` and commit with explicit paths, never `git add -A`. The run can stop after any commit.

**Cut order** if the run must be shortened: drop step 6 (float), then step 5 (text); they open the next phase. Step 7's program then prints counts with `std.text.show` instead of padding and fixed decimals, and the implementer pins that plain stdout in the step 7 test.

1. **Map values and `std.map`.**
   - `src/runtime.ts`: `SortedMap`, the AVL helpers, `map_entries`, `eq`, `show`, and ten `std$map$…` functions.
   - `src/std.ts`: `K`, the rows, the doc of `std.list.empty`.
   - `src/check.ts`: `keyOk`, E0229 in `resolveType` and in `call`, with the rule against a second report.
   - `src/emit.ts`: `SortedMap` in `tsType` and `ts`.
   - Adapt `accept_test.ts:286` to a `SortedMap` built with `std$map$insert`, showing `[1: 2]` (still the `show` fallback at this step).
   - Adapt `queries_test`: the submodules gain `std.map`, and `-> _` gains `std.map.empty`.
   - Spec 7.8: the rows and the sentence on type parameters.
2. **The map literal.**
   - Source files:
     - `src/ast.ts`, `src/parser.ts`, `src/lexer.ts` (the `{` message), `src/printer.ts`;
     - `src/check.ts`: `mapLiteral`, E0228 in both directions, E0234, the E0203 key hint, the message for `for` over a `Map`;
     - `src/emit.ts`, `src/refs.ts`, and `src/runtime.ts` (`map_literal`).
   - Spec:
     - the grammar block: the `map` rule and `| map` in `expr`;
     - 7.2 "Foreign forms": `{`, and index access names `std.map.get`;
     - 7.2 "Layout": "inside the brackets of a list or a map";
     - 7.5: a new bullet "Maps" that states 2.2 and 2.3;
     - 7.11: the rows "E0201 to E0229 | Names, types, calls, patterns, examples' form, the empty list or map, map keys", "E0230 to E0233 | Effects" and "E0234 | A key written twice in a map literal".
   - `decisions.md`:
     - the Lexical row "Foreign forms";
     - a new Syntax row "Map literal" (M2, M3);
     - Type checking rows "Map literals" and "Map keys" (M1, H6, the E0203 hint);
     - Semantics "Representation in TS" (`$rt.SortedMap<K, V>`, `map_literal`).
3. **Actual values, `for` over a literal, and the card's Maps bullet.**
   - `src/examples.ts`: the map literal and H5.
   - `src/check.ts`: H4, `guessTypeArgs`, and exporting `writable`.
   - `src/card.ts`: the step 3 edit only.
   - Spec 7.5, the Lists bullet: the `for` sentence. Spec 7.7, "Values as text": `["a": 1]` and `[:]`.
   - `decisions.md`:
     - Examples and acceptance, "Actual values";
     - remove the Maps bullet from "Temporary limits";
     - Type checking, "List literals", gains H4.
4. **Lists, options and order.**
   - `src/std.ts`, `src/runtime.ts`, the 7.8 rows, and the step 4 card edit.
   - `queries_test`:
     - the submodules gain `std.option` and `std.order`;
     - `List<Int>, _ -> List<_>` gains `std.list.drop_while`, `std.list.filter_map` and `std.list.take_while`;
     - `List<String>, _ -> List<Int>` gains `std.list.filter_map`.
5. **Text.** `src/std.ts`, `src/runtime.ts` and the 7.8 rows. No new text function may have the shape `String, String -> List<String>`; `card_test` pins that pattern.
6. **Float.** `src/std.ts`, `src/runtime.ts` and the 7.8 rows.
7. **One program on both hosts.**
   - A new `examples/words.alang`, which the examples loop of `accept_test` accepts.
   - A test in `tests/io_test.ts` for Deno and Node.js.
   - `README.md`: one usage line, `deno task alang run examples/words.alang -- in.txt`.
8. **Documents.**
   - Spec 7.1: remove the rows "Functions on `Map`" and "Float functions beyond `std.float.floor` …".
   - Spec 7.8 paragraphs:
     - maps: the text below;
     - the stopping rule of `any`, `all`, `find`, `take_while` and `drop_while`;
     - padding and code points;
     - the rules of float `parse`, `round` and `to_fixed`, with the binary-tie example `1.005`.
   - Spec 7.5, "Lambdas": one sentence naming `std.option.with_default` and `std.list.filter_map`.
   - `decisions.md`: a new section "Maps, options and more std", with one row per decision of section 5 not already placed.
   - `notes.md`:
     - "Current state": item 16, "Next", and the test count;
     - a review bullet that names the language changes first;
     - mark as resolved the Option and trimming items in "From the wordcount round", and the `for` and `std.list.empty<Unit>()` items in "From list literals and pure std".

**The map paragraph for 7.8** (exact):

> A `Map` is an immutable balanced search tree ordered by its keys: `Int` keys by value, `String` keys as `std.string.compare` orders them. `keys`, `values`, `to_list`, `std.text.show` and the actual values of examples follow that order, so equal maps look alike; the order of entries in a literal does not matter (`["b": 2, "a": 1] == ["a": 1, "b": 2]`). `std.map.get`, `contains`, `insert` and `remove` take time logarithmic in the size; `insert` and `remove` leave the map unchanged and build a new one that shares all but a logarithmic part of it. `size` takes constant time; `keys`, `values`, `to_list`, `==` and `show` take time linear in the size, and `from_list` n log n. So counting or grouping entry by entry in a `fold` is fine, unlike appending to a list. A key written twice in a literal is an error (E0234) if both are literals and a trap (`key`) otherwise; `from_list` traps on two items with the same key.

## 4. Tests (24 new, plus adaptations)

**`tests/std_test.ts`, step 1:**

1. **The AVL tree against a reference.**
   - A seeded generator (an LCG written in the test, not `Math.random`) runs 3,000 random inserts and removes.
   - Int keys from 0 to 199; separately, String keys from `["a", "B", "é", "😀", "\u{FFFF}", ""]` and generated ones.
   - After each operation: `size`, `keys` and `get` agree with a JavaScript `Map` sorted by the right comparator.
   - Every 100 operations: balance, order and the stored heights hold.
   - Snapshots taken every 500 operations are unchanged at the end.
2. **A table of the map functions.**
   - `insert` replacing a key keeps the size; `remove` of a missing key returns the same object.
   - `contains`, `size`, `keys`, `values`, and the order of `to_list`.
   - String keys in scalar-value order: `"\u{FFFF}"` before `"😀"`, unlike UTF-16 order.
   - `from_list` builds a map, and its duplicate traps as `["key", "std.map.from_list", "\"a\""]`.
3. **`eq` and `show`.**
   - Maps built in different insertion orders are `eq`; a different value is not.
   - `show` gives `["a": 1, "b": 2]`, `[:]`, and nested `[["a": [1]]]`.

**`tests/check_test.ts`, step 1:**

4. **E0229, one diagnostic each:**
   - `in: m: Map<Float, Int>`, at `Map<Float, Int>`, with the exact message;
   - `std.map.empty<Point, Int>()`;
   - `std.map.from_list(list: [1.5], key: fn(x: Float): Float => x, value: fn(x: Float): Int => 1)`;
   - `std.list.empty<Map<Bool, Int>>()`, at `Map<Bool, Int>`;
   - `let m: Map<Point, Int> = std.map.empty<Point, Int>()`, exactly one diagnostic, at the type.

   Clean programs (they go into `accepted`, so TypeScript checks them too):
   - `Map<String, Int>` and `Map<Int, List<Point>>` through `insert`, `get` and `to_list`;
   - `std.map.empty()` under an expected `Map<String, Int>` gets the E0209 fix `std.map.empty<String, Int>()`.

**`tests/std_test.ts`, step 1, extended in steps 4 to 6:**

5. **`MAPS_PROGRAM`.** An alang program whose examples call every new function. It is accepted through `accept`, and `deno check` passes on its output, as in phase 1's test 22.

**`tests/syntax_test.ts`, step 2:**

6. **Round trip.**
   - `["a": 1, "b": 2]`;
   - `[\n "a" : 1 ,\n "b":2\n]`, which prints canonically;
   - `[1: [2: 3]]`, `[["a": 1]]`, `[-1: 0]`, a lambda as a value, and `[:]`;
   - the tree of `["a": 1]` as data.
7. **Errors.**
   - `["a": 1, 2]`, `[1, "a": 2]`, `["a": 1, ]` and `[:1]` are E0101; the first three carry their messages.
   - `{"a": 1}` is E0006 with the new message.
   - `m["a"]` is E0006 with the new index message; update the existing assertion of that message.

**`tests/check_test.ts`, step 2:**

8. **Typing of map literals.**
   - Types come from the expected type and from the first entry.
   - `let m: Map<String, Float> = ["a": 1.0, "b": 2]` is E0204 with the fix `2.0`.
   - `std.map.size(map: ["a": None, "b": Some(1)])` is E0210; under an expected type it is clean.
   - `[1.5: 1]` without an expected type is E0229 at the literal. `let m: Map<Point, Int> = [Point(x: 1, y: 2): 1]` gives exactly one E0229.
   - E0234 for `["a": 1, "a": 2]` (at `"a": 2`), `[1: "x", 1: "y"]` and `[-1: 0, -1: 1]`; none for `[x: 1, y: 2]` with locals `x` and `y`.
   - `[name: 1]` without a local `name` is E0203 with the fix `"name"`; applied, the program is clean.
   - `for k: String in ["a": 1] do` is E0204 with the new hint.
9. **E0228 in both directions.**
   - `[:]` under `let m: Map<String, Int>` has the fix `std.map.empty<String, Int>()`; applied, clean.
   - `[]` under a `Map` gets the map fix; `[:]` under a `List` gets the list fix.
   - `std.map.size(map: [:])` has no fix, and neither has a map whose value type is a function type.

**`tests/emit_test.ts`, step 2** (TypeScript-checked and run):

10. **A `MAPS` program** with:
    - a map literal of records;
    - a `Map<String, Option<Int>>` with `None` first, under its type;
    - `std.map.insert(map: ["a": Some(1)], key: "b", value: None)`;
    - a literal whose entries call effectful functions: the output shows the key before the value, and the entries in order;
    - a computed duplicate key that traps `["key", <definition>, "\"a\""]`.

    The generated text contains `$rt.map_literal<string, $rt.Option<number>>(`.

**`tests/rename_test.ts` and `tests/codebase_test.ts`, step 2:**

11. **References and storage.**
    - A call in a map key and one in a value are references, and a rename rewrites both.
    - A map literal submitted with odd spacing and line breaks is stored canonically.

**`tests/accept_test.ts` and `tests/check_test.ts`, step 3:**

12. **Actual values of maps.**
    - A failing example of `vals.counts` (returning `["b": 2, "a": 1]`-like data) shows the actual value `["a": 1, "b": 2]`; an empty one is `std.map.empty<String, Int>()`.
    - Substituted back into the program, the result is accepted.
13. **`showValue`.**
    - A map with a record value, written from another module, and the empty map.
    - An empty `List<(Int) -> Int>` gives `[]`; an empty `Map<String, (Int) -> Int>` gives `[:]` (H5).
    - The E0209 guess offers no fix for a function type argument.
14. **`for` over a literal.**
    - `for x: Option<Int> in [None, Some(1)] do` is clean.
    - `for x: Float in [1] do` is E0204 at `1` with the fix `1.0`.
    - `for x: Int in [] do` is E0228 with the fix `std.list.empty<Int>()`.
    - The existing test "if and for" passes unchanged, and `card_test` passes if merged.

**`tests/std_test.ts`, steps 4 to 6:**

15. **`any`, `all`, `find`, `filter_map`, `take_while`, `drop_while`.**
    - Cases: the empty list, no match, every item, a match in the middle.
    - Stopping: a function that throws on items after the deciding one is never called on them.
16. **`with_default`, `option.map`, `then_by`** (all nine pairs of `Order`).
17. **`repeat`, `pad_left`, `pad_right`.**
    - `repeat` with counts 0 and 3 on `"ab"`, and the trap for −1.
    - Padding with a width below, equal to and above the length; `"😀"` counts as 1; a fill of `"😀"` works.
    - A fill of `"ab"` or `""` traps, even with width 0.
18. **`trim_characters` and code points.**
    - `trim_characters`: `("\"hi!\"", "\"!")` gives `hi`; inner characters stay; empty `characters` changes nothing; stripping everything gives `""`.
    - `code_points("a😀")` is `[97, 128_512]`, and code points round-trip.
    - −1, 1_114_112 and 55_296 trap; 200,000 code points do not overflow the stack.
19. **Float `compare`, `parse`, `abs`, `min`, `max`, `sqrt`.**
    - `parse` accepts `3`, `-0.25`, `007.5` and `-0`.
    - It rejects `+1`, `.5`, `1.`, `1e3`, ` 1`, the empty text, and `"1"` followed by 400 zeros.
    - `compare(-0.0, 0.0)` is `Equal`.
    - `sqrt(-1.0)` traps `["requires", "std.float.sqrt", "value >= 0.0"]`.
20. **`round`, `ceil`, `trunc`.**
    - 2.5 gives 3, −2.5 gives −3, 2.4 gives 2.
    - `round(-0.4)`, `ceil(-0.5)` and `trunc(-0.9)` give a positive zero (`Object.is`).
    - Traps at `2 ** 53` and at infinity.
21. **`to_fixed`.** The four values of 2.4, `1.5` with 2, `1e21` with 2, `-1e21` with 0, the infinities, and the traps for −1 and 101.

**`tests/io_test.ts`, step 7:**

22–23. **`examples/words.alang` on Deno and on Node.js**, with `in.txt` = `"The cat saw the dog.\nThe dog ran!\n"` in a temporary directory.
- The program's parts:
  - `split_words`: lines, split at `" "`, `trim_characters(characters: ".,;:!?\"()")`, `to_lower`, then filter out the empty text.
  - `tally`: a `fold` with `insert` and `with_default`, with the example `tally(words: ["b", "a", "b"]) == ["b": 2, "a": 1]`.
  - `top`: `to_list` into `Row(word, count)`, `sort` with `then_by`, `take` 3.
  - `line`: `pad_left` to width 6, and `to_fixed(share, 1)` padded to width 5.
  - `main`: `effects: fs.read, env, console`.
- Expected stdout, computed by hand:
  ```
  8 words, 5 different
       3   37.5%  the
       2   25.0%  dog
       1   12.5%  cat
  ```
- Without an argument: exit code 1 and a usage line on stderr.

**Adaptations, each in its step:** `queries_test`, `accept_test.ts:286`, the index message in `syntax_test`, and `card_test` (it must still pass).

## 5. Decisions

The prefixes are new, so that no ID is ambiguous: M (maps, continuing the roadmap's M1–M3), H (helpers and the checker), P (text), R (Float), W (docs).

| # | Recommendation | Reason by principle | Strongest alternative |
| --- | --- | --- | --- |
| M1 **[language]** (confirmed) | Map keys are `Int` or `String`; any other key type is E0229, wherever the type arises: written, in a literal, or bound by a std call | 3.9: exactly the types JavaScript compares by value and whose order is built in, so `==` and key lookup agree and maps have one order. It can be loosened later without breaking a program (3.8); tightening could not | Any type without functions, with a derived structural order on records and variants, which 3.9 rejects |
| M2 **[language]** (confirmed) | The literal `["a": 1, "b": 2]`, with at least one entry, on one line. Line breaks inside are ignored and there is no trailing comma. The first entry decides list or map. `[:]` and `[]` are E0228, with the fix chosen by the expected type | 5.1: examples can state maps. 4.4 and 5.7: braces stay foreign, and E0006 names this form. 1.1: the token after the first expression decides | `{"a": 1}`, the model's habit from Python and JSON |
| M3 **[language]** (confirmed, extended) | Two equal literal keys are E0234; computed duplicates trap (kind `key`); `from_list` traps on duplicates too | 5: a duplicate is a mistake, and an example shows the trap at acceptance; consistent with S9 (`zip`) | The later entry wins, as in most languages |
| M4 | A persistent AVL tree in key order (`$rt.SortedMap<K, V>`); `get`, `insert` and `remove` take O(log n) | 4: counting in a `fold`, the obvious program, is not quadratic; equal maps show alike | A JavaScript `Map` copied on each `insert`, which makes a `fold` quadratic |
| M5 | `keys`, `values`, `to_list`, `show` and actual values follow key order; the order of entries in a literal does not matter | 3.7: equal values print alike. L6: rule 3 is about forms, not equal values | Insertion order, which makes `==` disagree with `keys` |
| M6 | `show` prints `["a": 1]` and `[:]`; actual values print the literal, and the empty map as `std.map.empty<K, V>()` | 1.2, 3.7: the text can be pasted into an example | Keep `{a: 1}` |
| M7 | The names `insert` (replaces), `get`, `remove` (a missing key gives the same map), `contains` (of keys, with the label `key:`), `size`, `keys`, `values`, `from_list`, `to_list` | 3: the established map vocabulary; 4.1 labels remove the ambiguity of `contains` | `contains_key` and `length` |
| M8 | An unknown bare name as a map key gets E0203 with the quoted text as fix; `{` and index access name the map forms | 5.7 | The generic message for unknown names |
| H1 | `std.option.with_default`, `std.option.map`, `std.list.filter_map` | 2.4: a lambda is one expression, so unwrapping needs std, not a helper function (the wordcount round) | `unwrap_or`, Rust's name |
| H2 | `std.order.then_by(first, second)`, beyond the brief | The same gap: a comparison by two keys fits in one lambda. `then` is reserved | A named comparison function per sort, as today |
| H3 | `any`, `all`, `find`, `take_while` and `drop_while` stop at the deciding item, and their docs say so | 5.3: traps are observable, so where a function stops is part of its contract | Leave it unspecified |
| H4 **[language]** | `for x: T in [...]` passes `List<T>` to the literal | 1.4: the type stands to its left | Bind the literal with `let` first |
| H5 | An empty actual collection whose type holds a function type prints through `show`; the E0209 guess offers no such fix | 3.7: no wrong text such as `std.list.empty<Unit>()` | Keep the wrong text |
| H6 | One code, E0228, for both empty literals | 3: one rule; message and fix follow the expected type | A code of its own for `[:]` |
| P1 | `pad_left` and `pad_right` take a `fill` of one scalar value (checked first, traps otherwise); a width at or below the length leaves the text unchanged | 4: no counting of fill lengths; examples are deterministic | A fill of several characters, as in `padStart` |
| P2 | `code_points` and `from_code_points` work on lists; an invalid value traps | 3: one form for one or many characters, parallel to `characters` | `code(char)`, and `from_code` returning an `Option` |
| P3 | `trim_characters(text, characters)` strips a set from both ends; `take_while` and `drop_while` are added too | 3: the set form is what punctuation needs; the list forms are general | Only the list forms, over `characters` |
| R1 | `round` rounds halves away from zero; `to_fixed` breaks ties the same way, on the exact binary value | 4: what people expect, and what `Math.round` does not do for negatives; one rule for both | Halves to even |
| R2 | The names `ceil` and `trunc` | 3: the names of `Math`, Python and Rust, where the model's probability is. Closest-name fixes cover `ceiling` | `ceiling` and `truncate`, the roadmap's sketch |
| R3 | `parse` accepts `-?digits(.digits)?` with leading zeros, and gives `None` when the number is not finite; no exponents | 3: one exact form stated in the doc, as for `std.int.parse` | JavaScript's number syntax with exponents |
| R4 | `to_fixed` never writes exponents, writes no `-` when only zeros show, gives `Infinity` for an infinity, and traps for `decimals` outside 0..100 | 3.7: one text per shown value | Plain `toFixed` (`1e+21`, `-0.00`) |
| R5 | `sqrt` of a negative traps as `requires` (`value >= 0.0`) | 5.3: the trap names the cause, not a NaN | The NaN trap |
| W1 | Every trap, cost and order rule is in the doc line; `std.list.empty` and `std.map.empty` show their literals | 2: `context` of a std function shows only its line | Leave the rules in 7.8 |

**M1 to M3 re-examined.** All three are confirmed.
- M1 holds because loosening the key rule later is compatible and tightening is not.
- M3 is extended to `from_list`, so that one duplicate rule covers every way to build a map.
- The roadmap's "keys in key order" moves from M1 into M4 and M5: the tree makes it an invariant at no cost.
- The roadmap's risk that every `insert` copies the map is resolved by M4.

## 6. Discovery check and the playground round

**Which std functions the tools find.**

`search(word)` matches names and docs, case-insensitively. After this phase:

| Word | Hits among the new functions | Other hits |
| --- | --- | --- |
| count | `std.map.insert`, `std.string.repeat` | about nine existing docs (`take`, `drop`, `get`, `enumerate`, `lines`, `find`, `std.fs.Kind`) |
| group | `std.map.insert` | none |
| default, unwrap | `std.option.with_default` | none |
| pad, align | `std.string.pad_left`, `pad_right` | none |
| round | `std.float.round`, `std.float.to_fixed` | none |
| format | `std.float.to_fixed` | none |
| decimal | `std.float.parse`, `std.float.to_fixed` | none |
| code point | `std.string.code_points`, `from_code_points` | none; "code" alone also hits every "Unicode" doc |
| strip, trim | `std.string.trim_characters` (and `trim`) | — |
| skip | `std.list.drop_while` | none |
| tie | `std.order.then_by` | none |
| key | every `std.map` function, `then_by` | none |
| look up | `std.map.get` | none |

`search_type(pattern)`:

| Pattern | Hits |
| --- | --- |
| `Map<_, _>, _ -> Option<_>` | `std.map.get` |
| `String -> Option<Float>` | `std.float.parse` |
| `Float -> Int` | `floor`, `round`, `ceil`, `trunc` |
| `Float, Int -> String` | `std.float.to_fixed` |
| `Order, Order -> Order` | `std.order.then_by` |
| `Option<_>, _ -> _` | `with_default`, `option.map` |
| `String, Int, String -> String` | `pad_left`, `pad_right` |

`list("std")` gains the submodules `std.map`, `std.option` and `std.order`.

**Expected misses.** "dictionary" and "hash" find nothing; `list("std")` shows `std.map` instead.

**Setup of the round.**
- The playground's MCP server on the merged `main`, with the card instead of the spec, and a fresh codebase.
- No advisor, and no reading of the alang repository or of `alang-specs.md`; state this in the playground's `CLAUDE.md`.

**Prompt to paste:**

> Build `logstat`, a command-line tool in alang, using the alang MCP tools; choose the module name yourself. It is started as `alang db run <main> -- <log file>` and reads an access log in which each line is `<client> "<method> <path>" <status> <milliseconds>`, for example `10.0.0.7 "GET /index.html" 200 12.5`. A line without this shape (five fields separated by single spaces, quotes around method and path, a whole-number status, a decimal number of milliseconds) is malformed and otherwise ignored. It prints:
> 1. `requests: <n>, malformed: <m>`
> 2. one line per status code, ascending: `<status>: <count>`
> 3. the five paths with the most requests (equal counts ordered by path), one per line: the count right-aligned in 6 characters, two spaces, the average milliseconds with exactly two decimals right-aligned in 9 characters, two spaces, the path.
>
> Without an argument it prints `usage: logstat <log file>` to stderr and exits with code 1. Keep the logic in pure functions with examples. Then write a sample log of about 20 lines (a few malformed), run the tool on it, and show me the output.

**The planner's check that the planned std carries this program with one-expression lambdas** (the key lines):

```
std.list.filter_map(list: std.string.lines(text: content), with: parse_line)
std.list.fold(list: entries, initial: std.map.empty<Int, Int>(), with: fn(seen: Map<Int, Int>, e: Entry): Map<Int, Int> => std.map.insert(map: seen, key: e.status, value: std.option.with_default(option: std.map.get(map: seen, key: e.status), default: 0) + 1))
std.option.with_default(option: std.option.map(option: std.map.get(map: seen, key: e.path), with: fn(s: Stats): Stats => Stats(count: s.count + 1, total: s.total + e.milliseconds)), default: Stats(count: 1, total: e.milliseconds))
std.list.sort(list: rows, by: fn(a: Row, b: Row): Order => std.order.then_by(first: std.int.compare(left: b.count, right: a.count), second: std.string.compare(left: a.path, right: b.path)))
```

`parse_line` is a body (`let ... else return None` over `split`, `std.int.parse`, `std.float.parse` and `trim_characters(characters: "\"")`), not a workaround.

**What to observe.**
1. **Discovery.**
   - Does it call `card`, then `list("std")` and `list("std.map")`?
   - How many `context` calls does it need for parameter names?
   - Does it find `with_default`, `filter_map`, `then_by`, `pad_left` and `to_fixed` with `search`? Log the words it searches for.
2. **The literal.**
   - Does it learn the map literal from the card or from the doc of `std.map.empty`, and use it in examples (`count_statuses(...) == [200: 3, 404: 1]`)?
   - Does it write `{...}` or `[:]`, and does it recover through E0006 or E0228?
3. **The wordcount gap.** Does any helper function exist only to unwrap an `Option` or to compare by two keys? If so, which std function was missing?
4. **Costs.** Does it trust the cost stated in the doc of `insert` and fold, or does it sort and count runs as in the last round?
5. **Effort.** Diagnostics per submit (codes), number of calls, time, and whether the first try is accepted.
6. **Correctness.** Is the output right? Check by hand, especially `to_fixed` at ties of `.5` and the order of equal counts.
7. **Follow-up if discovery is chatty.** Give the std hits of `list` and `search` the signature line; today each function needs one `context` call.

### Critical Files for Implementation
- /home/josua/coding_projects/alang/src/runtime.ts
- /home/josua/coding_projects/alang/src/check.ts
- /home/josua/coding_projects/alang/src/std.ts
- /home/josua/coding_projects/alang/src/parser.ts
- /home/josua/coding_projects/alang/src/examples.ts