# alang: Specification Sketch

Nov 12, 2026 · @Josua Lucas

## Overview

alang is written and edited by LLMs, read by humans mainly at the contract level, and transpiled to TypeScript. This sketch defines only the language core, organized by six design principles and, for now, without concurrency and asynchronous calls. The semantics are defined independently of the target language, so that further targets remain possible. Section 7 states what the implementation accepts today: the gaps the sketch leaves open, the standard library, and what does not exist yet.

There are four kinds of definitions. Each has a full name of the form `module.path.name`.

| Definition | Content |
| --- | --- |
| `fn` | Function with contract, examples and body |
| `type` | Record or variant, with an optional invariant |
| `const` | Named, immutable value |
| `extern fn` | Signature of a function in the target language, with `target` instead of `body` |

A program starts at a function named `main` with `in: none`, and `out: Unit` or `out: Result<Unit, String>`; an `Err` ends the program with its message on stderr and exit code 1. The smallest complete program:

```
fn hello.main
  doc: "Prints a greeting to the console."
  in: none
  out: Unit
  effects: console
  requires: none
  ensures: none
  examples: none
  body:
    std.console.print_line(text: "Hello, world")
    return Unit
end fn hello.main
```

The built-in types have a fixed meaning. A trap ends the program with a diagnostic, cannot be caught, and always indicates a programming error.

| Type | Meaning |
| --- | --- |
| `Int` | Integer from −(2^53 − 1) to 2^53 − 1, a `number` in TypeScript; overflow is a trap |
| `Float` | Floating-point number per IEEE 754, 64 bit, without NaN; a NaN result is a trap, including from an `extern fn` |
| `Bool` | `true` or `false` |
| `String` | Sequence of Unicode scalar values |
| `Unit` | Exactly one value, written `Unit`; the result of functions that return nothing |
| `List<T>`, `Map<K, V>` | Immutable collections |
| `Option<T>` | `Some(T)` or `None` |
| `Result<T, E>` | `Ok(T)` or `Err(E)` |

Two types and one function as a complete example:

```
type net.port.Port
  doc: "A valid TCP port number."
  record:
    value: Int
  where: 1 <= value and value <= 65_535
end type net.port.Port

type net.port.ParseError
  doc: "Reasons why a text is not a port number."
  variant:
    NotANumber
    OutOfRange: Int
  where: none
end type net.port.ParseError

fn net.port.parse
  doc: "Reads a TCP port number from decimal text."
  in:
    text: String
  out: Result<Port, ParseError>
  effects: none
  requires: none
  ensures: none
  examples:
    parse(text: "8080") == Ok(Port(value: 8080))
    parse(text: "0") == Err(OutOfRange(0))
    parse(text: "abc") == Err(NotANumber)
  body:
    let n: Int = std.int.parse(text: text) else return Err(NotANumber)
    if n < 1 or n > 65_535 then
      return Err(OutOfRange(n))
    end if
    return Ok(Port(value: n))
end fn net.port.parse
```

## 1. Writable from left to right

At every point in the text, everything needed for the next token already stands before it. Reason: an LLM produces token after token and cannot take anything back.

- **1.1 Fixed section order.** A function consists of `doc`, `in`, `out`, `effects`, `requires`, `ensures`, `examples`, `body`, in exactly this order. Every section is mandatory; an empty section is written `none`.
- **1.2 No imports.** There is no import statement. Names from the same module are written short, all others fully qualified (`std.int.parse`). Built-in types and their variants (`Int`, `Ok`, `None`) are always written short.
- **1.3 Type before value.** Every binding states its type before the expression: `let n: Int = …`. Parameters and the result of a lambda always carry types.
- **1.4 Types flow forward only.** The type of an expression follows from the expected type and the text to its left. If a type argument cannot be determined this way, it is written explicitly: `std.list.empty<Int>()`.
- **1.5 Declaration before use.** In a body, a name is visible only after its `let` line. The order of definitions among each other has no meaning (see 6.2).
- **1.6 Prefix checkability.** For every program prefix it is decidable whether it can be continued to a valid program. The checker returns the set of permitted next tokens.

Rule 1.6 makes it possible to exclude invalid tokens during generation. After the following prefix only `text:` is permitted, because `std.int.parse` has exactly this parameter:

```
let n: Int = std.int.parse(
```

## 2. Locality

To change a definition correctly, its own text and the signatures of the definitions it uses are sufficient. Reason: the context window is the model's scarcest resource.

- **2.1 Effects in the signature.** `effects` lists every effect a function triggers directly or through calls. The checker requires that the caller's effects include those of every callee.
- **2.2 Closed set of effects.** Only the effects in the table below exist. `effects: none` means: equal inputs always produce the same result.
- **2.3 Errors in the type.** There are no exceptions and no `null`. Expected errors appear as `Result<T, E>` in the result type, missing values as `Option<T>`.
- **2.4 Pure lambdas.** Lambdas passed to functions have no effects. Effects per element go through `for`.
- **2.5 Trust boundary.** The effects of an `extern fn` are declared, not checked. Every `extern fn` is thereby recognizable as an unchecked assumption.
- **2.6 No action at a distance.** Constructs whose behaviour is determined elsewhere are not part of the language (second table).

| Effect | Covers |
| --- | --- |
| `fs.read` | Reading files and directories |
| `fs.write` | Creating, changing and deleting files |
| `net` | Network access |
| `time` | Reading the clock, waiting |
| `random` | Random values |
| `env` | Environment variables and program arguments |
| `log` | Log output |
| `console` | Reading from and writing to the console |

| Not available | Instead |
| --- | --- |
| Global mutable state | Pass values as parameters |
| Inheritance, interfaces, traits, overloading | Variants and `match`; one name denotes exactly one function |
| Implicit conversion | Explicit call, such as `std.int.to_float` |
| Default values for parameters | Every argument appears at the call |
| Macros, reflection, annotations | Ordinary functions |
| Shadowing of names | Every name has exactly one meaning in a body |

A function with an effect. Whoever calls it must declare `fs.read` itself:

```
fn config.load_port
  doc: "Reads the port number from a configuration file."
  in:
    path: String
  out: Result<net.port.Port, LoadError>
  effects: fs.read
  requires: none
  ensures: none
  examples: none
  body:
    let raw: String = std.fs.read_text(path: path) else return Err(FileUnreadable(error))
    let trimmed: String = std.string.trim(text: raw)
    let port: net.port.Port = net.port.parse(text: trimmed) else return Err(InvalidPort(error))
    return Ok(port)
end fn config.load_port
```

## 3. Exactly one way to write it

For every purpose the grammar permits exactly one form, and every definition has exactly one textual representation. Reason: equivalent variants spread the model's probability; a single form concentrates it.

| Purpose | Only form |
| --- | --- |
| Bind a value | `let name: Type = expression` |
| Branch | `if … then … else … end if` |
| Distinguish variants | `match … case … then … end match` |
| Propagate an error | `let name: Type = expression else return …` |
| Transform a collection | `std.list.map`, `std.list.filter`, `std.list.fold` |
| Effect per element | `for name: Type in list do … end for` |
| Repeat until a condition holds | Recursion |
| Call a function | `module.name(parameter: value)` |
| Combine logically | `and`, `or`, `not` |
| Compare values | `a == b`, for every type without function values |
| Value as text | `std.text.show(value: value)` |
| Sort | `std.list.sort(list: list, by: compare)` |

- **3.1 No method calls.** The form `x.f()` does not exist. The dot separates only module paths and record fields.
- **3.2 Propagating errors.** In `let … else` the expression has type `Result<T, E>` or `Option<T>`. On `Ok` or `Some` the content is bound; otherwise the function returns the `return` value. In the `else` branch the error value is called `error`.
- **3.3 Exhaustive `match`.** Every variant has its own `case`. There is no catch-all case, so that a new variant reports every affected place as an error.
- **3.4 Expressions with a value.** `if`, `match` and `for` are expressions; the value of a branch is its last expression. `for` yields the list of these values in the order of the elements. A function always ends with an explicit `return`.
- **3.5 Mandatory parentheses.** Arithmetic binds tighter than comparison, comparison tighter than logic. Mixing `+ -` with `* / %`, or `and` with `or`, requires parentheses.
- **3.6 Spelling of names.** `snake_case` applies to values, functions and modules, `PascalCase` to types and variants. The lexer enforces this.
- **3.7 Canonical text.** Line breaks separate entries and statements; indentation and other whitespace have no meaning. What is stored is the syntax tree, and its text output is always the same: one statement per line, two spaces per level.
- **3.8 Stable library.** A published signature never changes. New behaviour gets a new name.
- **3.9 Shared operations without traits.** Equality (`==`, `!=`) and text representation (`std.text.show`) are built in for every type without function values and follow solely from the structure of the type. Only `Int`, `Float` and `String` have a built-in order. For all other types a comparison function with the result `Order` (`Less`, `Equal`, `Greater`) is passed explicitly. Because there is no NaN, `x == x` holds for every value.

Reading files and collecting the results, with `for` as an expression per 3.4 instead of a lambda with an effect:

```
let contents: List<Result<String, std.fs.Error>> = for path: String in paths do
  std.fs.read_text(path: path)
end for
```

Grammar excerpt (EBNF, line breaks omitted):

```
definition = fn_def | type_def | const_def | extern_def ;

fn_def     = "fn" path
             "doc:" string
             "in:" ( "none" | param { param } )
             "out:" type
             "effects:" ( "none" | effect { "," effect } )
             "requires:" ( "none" | expr )
             "ensures:" ( "none" | expr )
             "examples:" ( "none" | example { example } )
             "body:" stmt { stmt }
             "end" "fn" path ;

type_def   = "type" path
             "doc:" string
             ( "record:" param { param } | "variant:" case { case } )
             "where:" ( "none" | expr )
             "end" "type" path ;

param      = name ":" type ;
case       = TypeName [ ":" type ] ;
example    = call "==" expr ;
type       = TypePath [ "<" type { "," type } ">" ] ;

stmt       = let | return | expr ;
let        = "let" name ":" type "=" expr [ "else" "return" expr ] ;
return     = "return" expr ;
for        = "for" name ":" type "in" expr "do" stmt { stmt } "end" "for" ;

expr       = if | match | for | lambda | call | construct | list
           | binary | unary | field | literal | name ;
if         = "if" expr "then" stmt { stmt } [ "else" stmt { stmt } ] "end" "if" ;
match      = "match" expr arm { arm } "end" "match" ;
arm        = "case" pattern "then" stmt { stmt } ;
pattern    = TypePath [ "(" ( pattern | name ) ")" ] | literal ;
lambda     = "fn" "(" param { "," param } ")" ":" type "=>" expr ;
call       = path [ "<" type { "," type } ">" ] "(" [ arg { "," arg } ] ")" ;
arg        = name ":" expr ;
construct  = TypePath [ "(" ( arg { "," arg } | expr ) ")" ] ;
list       = "[" expr { "," expr } "]" ;
```

## 4. Nothing to count, nothing to simulate

No construct requires counting positions or tracking mutable state across several lines. Reason: LLMs are weak at exact counting and at following state step by step.

- **4.1 Named arguments.** Every argument carries its parameter name, in declaration order. This also applies to records: `Port(value: 8080)`.
- **4.2 Variants carry at most one value.** It is written without a name: `Err(OutOfRange(n))`. Several values belong in a record.
- **4.3 No tuples.** Composite values are records with named fields.
- **4.4 Named block ends.** Blocks end with `end if`, `end for`, `end match`, `end fn <name>` or `end type <name>`. There are no curly braces and no significant indentation.
- **4.5 No assignment.** Every binding is immutable. An intermediate result gets a new name.
- **4.6 No index access.** The form `list[i]` does not exist. `std.list.get(list: xs, index: i)` returns `Option<T>`; for neighbours and positions there are `first`, `last`, `zip`, `enumerate` and `window`.
- **4.7 Grouped numbers.** Integer literals with more than four digits carry `_` as a thousands separator: `65_535`, `1_000_000`.
- **4.8 Limited depth.** Blocks are nested at most two levels deep. Anything deeper becomes its own function.

The sum of the lengths of all names, without a counter, an index or a mutable variable:

```
let lengths: List<Int> = std.list.map(list: names, with: fn(name: String): Int => std.string.length(text: name))
let total: Int = std.list.fold(list: lengths, initial: 0, with: fn(sum: Int, item: Int): Int => sum + item)
```

## 5. Verification inside the definition

Every definition carries its own checks, and a definition that does not satisfy them is not stored. Reason: writing costs an LLM almost nothing; what is expensive are unnoticed errors.

| Section | Statement | Check |
| --- | --- | --- |
| `requires` | Condition on the inputs | At every call |
| `ensures` | Condition on `result` and the inputs | At every `return` |
| `where` | Invariant of every value of a type | At every construction |
| `examples` | Call and expected value | Executed at every acceptance |

- **5.1 Examples are mandatory.** Every function with `effects: none` has at least one example. If one fails, the definition is rejected.
- **5.2 Proved or checked.** Conditions made of comparisons, linear integer arithmetic and `and`, `or`, `not` are proved statically by the checker. All others become runtime checks. The database records `proved` or `checked` for each condition.
- **5.3 A violation is a trap.** A condition violated at runtime ends the program with a diagnostic.
- **5.4 Conditions are pure.** `requires`, `ensures`, `where` and `examples` call only functions with `effects: none`.
- **5.5 Diagnostics are data.** Every diagnostic is a record with fixed fields and a ready-made fix. The location is given as quoted text, not as line and column.
- **5.6 One diagnostic per cause.** Follow-up errors are suppressed.
- **5.7 Foreign habits.** For common forms from other languages (`var`, `===`, `x.map(…)`, `?`, curly braces) there are dedicated diagnostics that name the form used here.

A contract that the checker proves completely per 5.2. The invariant of `Port` in `net.port.parse` is proved as well, because the `if` check comes before the construction.

```
fn math.clamp
  doc: "Limits value to the range from low to high."
  in:
    value: Int
    low: Int
    high: Int
  out: Int
  effects: none
  requires: low <= high
  ensures: low <= result and result <= high
  examples:
    clamp(value: 5, low: 0, high: 10) == 5
    clamp(value: -3, low: 0, high: 10) == 0
    clamp(value: 42, low: 0, high: 10) == 10
  body:
    if value < low then
      return low
    end if
    if value > high then
      return high
    end if
    return value
end fn math.clamp
```

A diagnostic per 5.5 for a wrongly named parameter:

```json
{
  "code": "E0207",
  "definition": "net.port.parse",
  "section": "body",
  "at": "std.int.parse(txt: text)",
  "message": "Unknown parameter name `txt`.",
  "expected": "text: String",
  "fix": {
    "replace": "std.int.parse(txt: text)",
    "with": "std.int.parse(text: text)"
  }
}
```

## 6. Codebase as a database

The unit of storage is the individual definition, not the file; reading and changing happen through queries and transactions. Reason: LLMs change code more often than they write it from scratch, and need targeted access for that instead of text search.

- **6.1 Two identities.** Every definition has a name and a hash of its syntax tree. References to other definitions go through the hash internally; the name is a changeable pointer to it.
- **6.2 No files, no order.** Modules are name prefixes. Text is an output of the database, not its source.
- **6.3 Atomic acceptance.** Every change passes through parsing, type and effect checking, contract checking and examples. If one step fails, the database stays unchanged and the diagnostics are returned.
- **6.4 Transactions.** Several definitions can be submitted together, for example a changed signature along with all adapted callers.
- **6.5 Locality guarantee.** `context(name)` returns everything needed to change `name` correctly. This is the checkable form of principle 2.
- **6.6 History.** Every earlier hash remains retrievable.
- **6.7 Hash as a guard.** Every query returns the hash of the version it read. `replace`, `rename` and `remove` require that hash; if it no longer matches, the change is rejected and the current version is returned. Hashes are never written in code: the model copies one from a query result and refers to definitions by name.

Queries:

| Query | Result |
| --- | --- |
| `signature(name)` | All sections except `body` |
| `definition(name)` | Complete canonical text |
| `context(name)` | Definition plus the signatures of all functions and types it uses |
| `callers(name)` | Definitions that use `name` |
| `search(type)` | Functions with a matching signature, such as `String -> Result<Int, _>` |
| `search(text)` | Matches in names and `doc` lines |
| `list(module)` | Names and `doc` lines of a module |
| `history(name)` | Earlier hashes with timestamps |

Changes:

| Operation | Effect |
| --- | --- |
| `add(definition)` | Creates a new definition |
| `replace(name, hash, definition)` | Replaces the version with this hash; if the signature is unchanged, all callers follow automatically |
| `rename(old, hash, new)` | Changes only the pointer; no caller needs to be adapted |
| `remove(name, hash)` | Is rejected as long as callers exist |

If `replace` changes the signature, it is rejected and names the affected callers. They then belong in the same transaction.

## Storage

The codebase is one SQLite file; text is the interface the LLM reads and writes, not the storage format. The LLM never edits files: it passes definition text as an argument to the operations of section 6.

The path of a change:

1. The LLM calls `context(name)` and receives canonical text plus the hash.
2. It generates the new definition as text and calls `replace(name, hash, text)`.
3. The tool parses the text, checks types, effects and contracts, runs the examples and computes the new hash.
4. Only if everything passes does it write to the database, in a single transaction. Otherwise nothing changes and the diagnostics are returned.

Layout on disk:

```
project/
  alang.db      SQLite file with the codebase
  export/       canonical text, one file per module, for Git and review
  out/          generated TypeScript
```

| Table | Columns | Purpose |
| --- | --- | --- |
| `definitions` | `hash`, `kind`, `text`, `signature` | One row per version, never changed |
| `names` | `name`, `hash` | The changeable pointer of rule 6.1 |
| `refs` | `from_hash`, `to_hash` | Who uses whom; answers `callers(name)` |
| `history` | `name`, `hash`, `changed_at` | Earlier versions per rule 6.6 |

The `text` column holds the canonical text itself. Because of rule 3.7 every syntax tree has exactly one text, so the tree is parsed on demand and needs no separate serialization.

A SQLite file cannot be diffed or merged in Git. An export command therefore writes all definitions as canonical text, one file per module and sorted by name. Two options exist for the source of truth:

| Source of truth | Consequence |
| --- | --- |
| The database | The export is only a view and a backup; history lives in the database, not in Git |
| The export in Git | The database is rebuilt from it on checkout; review, CI and branches work as usual |

Recommended for the prototype is the export in Git. Rule 6.2 then describes the LLM's view: it still works only through queries and transactions.

## Toolchain

The transpiler is written in TypeScript and runs on Deno. Target language and tool language are thereby the same, so examples run in the same process as the checker and on the real target semantics.

- **One runtime library.** `std.*`, the overflow check for `Int` and the NaN check exist once and are shared by the checker and by generated programs.
- **Effects enforced at runtime.** A program is started with exactly the Deno permissions that its `main` declares as effects (table below). This also catches an `extern fn` whose TypeScript code does more than its declared effects (rule 2.5).
- **Checked output.** The test suite type-checks the generated TypeScript, to verify that whatever the checker accepts is never rejected by TypeScript.
- **Runtime-neutral output.** Generated code does not depend on Deno, so alang programs also run on Node.js and Bun.

| Effect | Deno permission |
| --- | --- |
| `fs.read` | `--allow-read` |
| `fs.write` | `--allow-write` |
| `net` | `--allow-net` |
| `env` | `--allow-env` |
| `time`, `random`, `log`, `console` | None needed |

## Recorded alternative: capabilities instead of effect labels

The decision is effect labels per 2.1; capabilities remain recorded as an alternative. With capabilities, access is a value: whoever wants to read a file needs a `std.fs.Reader` as a parameter. `main` receives all capabilities from the runtime and passes them on; the `effects` section would disappear.

```
in:
  files: std.fs.Reader
  path: String
body:
  let raw: String = std.fs.read_text(reader: files, path: path) else return Err(FileUnreadable(error))
```

| Criterion | Label (chosen) | Capability |
| --- | --- | --- |
| Statement | Which kind of effect | Which resource, restrictable for example to one directory |
| Mechanism | Separate effect checker | Only type system and parameters |
| Testing | A substitute needs an extra mechanism | Pass a fake; examples also for functions with effects |
| New effect deep down | Signatures of all callers change | Signatures and call sites change |
| Lambdas | Stay pure per 2.4 | Could capture capabilities; needs an extra rule |
| In the generated TypeScript | Disappears completely | Real parameters |

A switch pays off as soon as functions with effects should get examples or access has to be restricted to individual resources.

## To revisit later

Two points are decided for now and will be re-evaluated after first experience.

**Examples for functions with effects.** For now `examples: none` per 5.1 stays. Functions with effects should stay thin and hand their logic to pure functions. Two alternatives are noted:

| Alternative | Idea | Price |
| --- | --- | --- |
| Fix the answers | The example specifies what an `extern fn` returns | New syntax; the checker must replace external functions; sequences of several steps get complicated |
| Capabilities | The example passes a fake, such as a rebuilt file system | Change of the effect model, see the recorded alternative |

The first alternative as a sketch:

```
examples:
  given std.fs.read_text(path: "port.txt") == Ok("8080")
  load_port(path: "port.txt") == Ok(Port(value: 8080))
```

**Body length.** There is no upper limit. The database logs the length of every body; a limit is set only once the error rate measurably rises beyond a certain length.

## 7. Reference for writing alang

Sections 1 to 6 are the design. This section states what the implementation accepts today, in enough detail to write a definition that is accepted on the first try: the gaps the sketch leaves open, the standard library, the codebase tools, and what does not exist yet. The reasons are in `docs/decisions.md`; some of these decisions still await review and may change. A code in brackets is the diagnostic (5.5) that a rule produces.

### 7.1 Not available yet

These forms are common in other languages but do not exist in alang. Write the form in the right column instead.

| Not available | Instead |
| --- | --- |
| `const` and `extern fn` (not parsed yet) | A function with `in: none` for a constant value, called as `limit()`; like every pure function it needs an example |
| Functions on `Map` | A `List` of records |
| `std.list.first`, `last`, `zip`, `enumerate`, `window` (named in 4.6) | `std.list.get`, `std.list.fold`, recursion, or a helper function of your own |
| `if`, `match` or `for` inside another expression, such as an argument, or in `requires`, `ensures` or `where` (E0303) | Bind it with `let` first, or `return` it; in a condition, call a pure function that holds the `match` |
| `where` on a variant type (E0225) | A record around it, or a check in the functions |
| Function types in your own signatures | Only std functions take functions (`with`, `by`, `handler`) |
| Waiting, an HTTP client, binary files, renaming and copying files, console output without a line break | Nothing yet. A text file is copied or renamed with `std.fs.read_text`, `std.fs.write_text` and `std.fs.remove`; the console and the log take whole lines |
| Static proofs (5.2) and prefix checking (1.6) | Every `requires`, `ensures` and `where` is checked at runtime |
| The depth limit (4.8) | Not enforced yet; keep to it anyway |
| Concurrency | Everything runs in order; `std.http.serve` answers one request at a time |
| A wildcard pattern `_` | Every value in a pattern gets a name, used or not: `case Ok(done) then` |

### 7.2 Text

- **Comments.** There are none. `//`, `/*` and `#` are errors (E0006); a definition is described in its `doc`.
- **Strings.** Double quotes, closed on the same line. The escapes are exactly `\"`, `\\`, `\n`, `\t`, and `\u{1B}` (uppercase hex) for other control characters. Every other character, non-ASCII included, is written as itself: `"é"`, never `"\u{E9}"`. An unknown escape is an error (E0005); for `\r`, `\0`, `\a`, `\b`, `\f`, `\v` and `\e` the fix is the `\u{...}` form, such as `\u{D}` for `\r` (not for `\0` before a digit, a C octal escape such as `\033`). Texts are joined with `std.string.concat`; `+` is for numbers only.
- **Numbers.** An integer with more than four digits is grouped in threes with `_` (`65_535`, `1_000_000`); `65535`, `1_000` and leading zeros are errors (4.7). A float is written `digits.digits` (`1.0`, `0.25`), never `1.`, `.5` or `1e3`. A negative number is a literal (`-3`, `-0.5`). There is no minus in front of other expressions; write `0 - x`.
- **Other values.** `true`, `false`, and `Unit`, the one value of the type `Unit`.
- **Reserved words.** `fn`, `type`, `const`, `extern`, `end`, `doc`, `in`, `out`, `effects`, `requires`, `ensures`, `examples`, `body`, `record`, `variant`, `where`, `none`, `let`, `else`, `return`, `if`, `then`, `match`, `case`, `for`, `do`, `and`, `or`, `not`, `true`, `false`. `result` (in `ensures`) and `error` (after `let ... else`) are bound by the language. They cannot name a parameter or a binding (E0109), but a field may use them.
- **Foreign forms.** `===`, `!==`, `&&`, `||`, `!`, `{`, `}`, `?`, `;`, `'`, index access `xs[0]`, the list type `Int[]`, `var`, `null`, `while`, `import` and others get a diagnostic that names the alang form (E0006, 5.7).
- **Layout.** A line break separates statements and section entries. Inside the parentheses of a call or a construction and inside the brackets of a list, line breaks are ignored. Indentation has no meaning; the stored text uses two spaces per level (3.7) and never breaks a line, so a long example stays on one line.
- **Files.** In a file given to `alang check` or `alang run`, the order of definitions has no meaning (6.2). The stored text and the export sort them by name, with one empty line between them.

### 7.3 Definitions and names

- **Every name has a module.** Write `fn hello.main`, never `fn main`. The module `std` is reserved for the standard library (E0215).
- **Sections.** As in 1.1 and the grammar. `in:` is `none` or one `name: Type` per line. `effects:` is `none` or a list in the order of the effect table (2.2), each effect once: `effects: fs.read, console` (otherwise E0111, with the corrected line).
- **Types.** `record:` lists fields and `variant:` lists cases; a case carries at most one value (`OutOfRange: Int`, 4.2). `where:` is an invariant over the fields of a record; a variant has `where: none`.
- **Cases belong to the module.** A case's full name is `module.Case`, not `module.Type.Case`. So two types of one module cannot share a case name, and a case cannot share its name with a type of its module (E0215). Outside its module, a case is written in full: `std.fs.NotFound`, `net.port.OutOfRange`.
- **The own module is written short (1.2).** Inside `net.port`, write `parse`, `Port` and `OutOfRange`. Names from any other module are written in full, std included: `std.http.Request`, `std.http.AddressInUse`. Enclosing and nested modules count as other modules. An own-module name written in full is E0226; the codebase stores it short by itself and lists it under `fixed`. One exception: a function passed as a value whose short name is also the name of a local is written in full.
- **Built-ins are always short.** `Int`, `Float`, `Bool`, `String`, `Unit`, `List`, `Map`, `Option` (`Some`, `None`), `Result` (`Ok`, `Err`) and `Order` (`Less`, `Equal`, `Greater`). No type or case may take one of these names (E0215).
- **Uniqueness.** Definition names, parameters, fields, and case names within a module are unique (E0215).

### 7.4 Bodies

- **Statements.** One per line: a `let`, a `return`, or an expression of type `Unit`, such as `std.console.print_line(...)`. Any other value must be used; dropping a `Result` is an error (E0217).
- **The end.** The last statement of a body is literally a `return` (E0218). Nothing may follow a `return`, or an `if` or `match` whose branches all return (E0218). So an `if` or `match` whose branches all return cannot end a body either. Write `if c then return a end if` and then `return b`, or bind the value of the `if` or `match` with `let` and return that.
- **`let` (3.2).** `let n: Int = expression`, always with the type. In `let n: Int = std.int.parse(text: s) else return Err(NotANumber)`, the expression is a `Result` or an `Option` (E0224). On `Ok` or `Some`, its content is bound. Otherwise the function returns the `else` value, in which `error` is the `Err` value, or `Unit` for `None`.
- **No shadowing (2.6).** A binding may not reuse a name that is visible at that point: a parameter, an earlier `let`, or a pattern or lambda variable (E0216). Sibling branches may use the same name.
- **`if`.** `if condition then ... else ... end if`. Without `else`, only as a statement (E0110). The value of a branch is its last expression.
- **`match` (3.3).** `match subject` is followed by `case Pattern then ...` lines and `end match`. Every case is covered (E0213), without a catch-all, and no case may be one that earlier cases already cover (E0214).
  - A case without a value is matched bare: `case None then`.
  - A case with a value always takes a sub-pattern, either a name or a nested case: `case Some(n) then`, `case Err(OutOfRange(n)) then`, `case Err(std.fs.NotFound) then`.
  - A `match` on `Int` or `String` can never be exhaustive (E0213); use `if`.
  - A name may not stand for the remaining cases. After `case Err(std.fs.NotFound) then`, a `case Err(other) then` would be a catch-all, so a case added to `std.fs.Error` later would go unreported; it is rejected (E0227). Write a case for each. A name with no specific case beside it (`case Err(e) then` alone) binds the whole value, as usual.
  - A branch may hold `let` statements before its value.
- **`for` (3.4).** `for name: Type in list do ... end for`. As a statement, its body has type `Unit`. As a value, it is the list of the body's values; this is how effects per element are collected.
- **Where `if`, `match` and `for` stand.** As a statement, as the value of a `let`, or after `return`. Not yet inside another expression (E0303).

### 7.5 Expressions

- **Calls and construction (4.1).** Every argument is named, in declaration order, with none left out and none given twice (E0205 to E0208): `std.string.concat(left: a, right: b)`, `Port(value: 8080)`. A case's value has no name: `Some(n)`, `Err(OutOfRange(n))`. Fields are read with a dot (`request.path`). There are no method calls (`x.f()`, E0220).
- **Lists.** `[1, 2, 3]` is a `List<Int>`. A list literal has at least one item; the stored text separates the items with `, ` and keeps them on one line, and a comma before `]` is an error (E0101). The item type comes from the expected type (a `let`, a parameter, `out` at a `return`, the left side of `==`), otherwise from the first item, and every other item must have it: `[1.0, 2]` is an error (E0204), and so is `[None, Some(1)]` without an expected type (E0210). The empty list is `std.list.empty<Int>()`; `[]` is an error whose fix names the item type when the expected type gives it (E0228). There is no index access (`xs[0]`) and no `Int[]` (E0006): use `std.list.get(list: xs, index: 0)` and `List<Int>`.
- **Explicit type arguments (1.4).** They are written exactly when a type parameter of the function occurs in no parameter type, and never otherwise (E0209): `std.list.empty<Int>()`, but `std.list.map(list: xs, with: ...)`.
- **Types flow from left to right (1.4).** `Ok`, `Err` and `None` take their type from what is expected at that point: the type of a `let`, a parameter, `out` at a `return`, or the left side of `==`. Without an expected type they are an error (E0210); `Some(x)` can also take its type from `x`. So the side with a known type comes first: `parse(text: "1") == Ok(...)`, not `None == x`.
- **Arithmetic.** `+ - * / %` work on two `Int` or two `Float`; nothing is converted implicitly (`std.int.to_float`). `Int` division truncates toward zero, and `%` takes the sign of the dividend (`-7 % 2 == -1`). Division by zero and leaving the `Int` range trap. An `Int` is never negative zero: `0 * -1` and `-1 / 2` are `0`, while a `Float` keeps IEEE's `-0.0`. A `Float` result that is NaN traps (`0.0 / 0.0`); infinities are ordinary values.
- **Comparison and logic.** `==` and `!=` work on every type without functions, by structure (3.9). `< <= > >=` work only on `Int`, `Float` and `String` (E0211); other types are ordered by a function that returns `Order`. The logical operators are `and`, `or` and `not`. `not` binds more loosely than comparison: `not a == b` means `not (a == b)`. Mixing `+ -` with `* / %`, or `and` with `or`, needs parentheses (3.5). Within `* / %`, or within `+ -`, operators group from the left without them: `12 * 5 / 4` is `(12 * 5) / 4`. Parentheses that 3.5 does not require are dropped from the stored text. `==` compares variant values too (`outcome == Err(std.fs.NotFound)`); to branch on several cases, use `match`.
- **Lambdas (2.4).** `fn(item: Int): Int => item * factor` has typed parameters, a result type, and one expression as its body: no `let` and no `return` (E0219). It has no effects (E0232) and may read the bindings around it. A lambda used as an operand is put in parentheses.
- **Function values.** Where a std function takes a function, a function name can be passed instead of a lambda (`by: std.int.compare`, `with: double`). The function must be pure (E0232) and not generic; a generic one needs a lambda (E0210). The exception is the `handler` of `std.http.serve`, which may have effects; the caller then declares them (E0230).
- **Names.** A plain name means a local first, then a function of the own module. A path followed by `(` is always a call, so a local may share its name with a function: `let total: Int = total(items: xs)`. A local named like the first segment of a module hides calls into that module: with a parameter `net`, `net.port.parse(...)` reads as a method call (E0220). Choose another name.

### 7.6 Contracts and examples

- **Scopes.** `requires` sees the parameters, `ensures` the parameters and `result`, and `where` the fields. Conditions and examples call only pure functions (E0233).
- **Examples (5.1).** Each line is `call == expected`. The call is to the function itself, by its short name (E0221), and both sides have the same type.
  - Every function with `effects: none` has at least one example (E0401). A function with effects has `examples: none` (5.4).
  - An example holds if both sides are equal (3.9). A failing one is reported with the actual value as alang text (E0402). A trapping one is reported with the trap (E0403); this includes a stack overflow from recursion without a base case.
- **Acceptance.** Every change re-runs every example of the program, so a changed body that breaks a caller's example is rejected too. An example whose call breaks the function's `requires` traps (E0403).
- **Shape of a program.** Logic goes into pure functions with examples. Functions with effects stay thin and call them; see the server in 7.9.

### 7.7 Effects and running

- **Declaration (2.1).** `effects` includes the effects of every function that is called, directly or as a handler (E0230, with the corrected line). Declaring more than needed is allowed.
- **Running.** `main` runs in its own process with exactly the Deno permissions of its effects (Toolchain); an operation without permission traps. The program runs in the directory it was started from, so a relative path such as `notes.txt` is read from there. A trap ends the program with exit code 70 and a diagnostic as JSON on stderr.
- **Arguments.** `alang run <file> -- <args>` and `alang db run [<main>] -- <args>`: the words after the first `--` reach the program unchanged through `std.env.args()`, a further `--` included, without the program's name. Any other word before `--` is refused with exit code 2: `alang run` takes only `-o <out>` there, `alang db run` only the name of a `main`. `std.env.args` needs the effect `env`, like `std.env.get`.
- **Files.** A path is relative to the directory the program was started in and uses `/` on every system. Files hold UTF-8 text, read and written exactly: `std.fs.write_text` and `std.fs.append_text` add nothing (no line break, no byte order mark), and a byte order mark a file starts with stays in the text that `std.fs.read_text` returns.
- **Refused or not allowed.** What the system refuses (a missing file, a file mode, a directory where a file belongs) is an `Err` of `std.fs.Error`, for the program to handle. What `main`'s effects do not cover traps, as above.
- **Console and log.** `std.console.print_line` writes to stdout and `std.log.print_line` to stderr, so output and log separate in a pipe. `std.console.read_line` reads stdin line by line.
- **Ending with an error.** `main` has `out: Unit` or `out: Result<Unit, String>` (E0305). With the `Result`, `let ... else return Err(...)` works in `main`, where every I/O error ends up: `Err(message)` writes the message to stderr and ends the program with exit code 1. The exit codes are 0 when `main` returned (`Unit` or `Ok`), 1 for an `Err` from `main` and also when the tool refuses a program (its diagnostics as JSON on stderr), 2 for a command line the tool does not understand, and 70 for a trap.
- **Values as text.** `std.text.show` gives `42`, `2.5`, `"a\"b"` (quoted), `Some(3)`, `Less`, `Unit`, `["a", "b"]` for a list, and `(x: 1, y: -2)` for a record, without its type name. A case shows without its module: `PermissionDenied`, `Other("disk full")`. Numbers show without `_` grouping (`12345`), and a whole `Float` without its fraction: `2.0` gives `2`.

### 7.8 Standard library

This is everything std holds today. Type parameters (`T`, `U`, `A`) are bound from the arguments. A type such as `(T) -> U` is a function parameter; pass a lambda or a function name (7.5). `with effects` marks the one parameter that takes a function with effects. The codebase tools read std like the codebase itself, without a hash (7.10).

| Function | Effects | Meaning |
| --- | --- | --- |
| `std.console.print_line(text: String): Unit` | console | Writes a line to the console. |
| `std.console.read_line(): Option<String>` | console | Reads the next line from the console, without its line break; `None` at the end of the input. |
| `std.env.args(): List<String>` | env | The arguments the program was started with. |
| `std.env.get(name: String): Option<String>` | env | The value of an environment variable; `None` if it is not set. |
| `std.fs.read_text(path: String): Result<String, std.fs.Error>` | fs.read | Reads a whole file as UTF-8 text. |
| `std.fs.write_text(path: String, text: String): Result<Unit, std.fs.Error>` | fs.write | Writes the text to a file as UTF-8, creating the file or replacing its content. |
| `std.fs.append_text(path: String, text: String): Result<Unit, std.fs.Error>` | fs.write | Adds the text to the end of a file as UTF-8, creating the file if it is missing. |
| `std.fs.list_directory(path: String): Result<List<String>, std.fs.Error>` | fs.read | The names of a directory's entries, in the order of `std.string.compare`; names, not paths. |
| `std.fs.kind(path: String): Result<std.fs.Kind, std.fs.Error>` | fs.read | Whether a path exists as a file or as a directory; `Err(NotFound)` if nothing is there. |
| `std.fs.create_directory(path: String): Result<Unit, std.fs.Error>` | fs.write | Creates a directory and its missing parents; `Ok` if it already exists. |
| `std.fs.remove(path: String): Result<Unit, std.fs.Error>` | fs.write | Removes a file or an empty directory. |
| `std.http.serve(host: String, port: Int, handler: (std.http.Request) -> std.http.Response with effects): Result<Unit, std.http.ServeError>` | net | Answers requests with the handler, one at a time, until the program gets SIGINT or SIGTERM; then `Ok(Unit)`. `Err` if it cannot listen. The handler may have effects; the caller declares them. |
| `std.log.print_line(text: String): Unit` | log | Writes a line to the log, which is the standard error stream. |
| `std.random.int(low: Int, high: Int): Int` | random | A random integer from `low` to `high`, both included; traps if `low > high`. Not for secrets. |
| `std.time.now_milliseconds(): Int` | time | The clock's time in milliseconds since 1970-01-01T00:00:00Z. |
| `std.int.parse(text: String): Option<Int>` | none | Reads an integer written as an optional `-` and the digits `0` to `9`; leading zeros are allowed (`007` is 7, `-0` is 0). `None` for anything else (`+`, `_`, whitespace, the empty text) and outside the Int range. |
| `std.int.to_float(value: Int): Float` | none | The same number as a Float. |
| `std.int.compare(left: Int, right: Int): Order` | none | Orders two integers. |
| `std.int.min(left: Int, right: Int): Int` | none | The smaller of two integers. |
| `std.int.max(left: Int, right: Int): Int` | none | The larger of two integers. |
| `std.int.abs(value: Int): Int` | none | The value without its sign. |
| `std.int.checked_add(left: Int, right: Int): Option<Int>` | none | The sum; `None` if it is outside the Int range. |
| `std.int.checked_subtract(left: Int, right: Int): Option<Int>` | none | The difference; `None` if it is outside the Int range. |
| `std.int.checked_multiply(left: Int, right: Int): Option<Int>` | none | The product; `None` if it is outside the Int range. |
| `std.float.floor(value: Float): Int` | none | The largest integer not above the value; traps outside the Int range. |
| `std.string.trim(text: String): String` | none | Removes leading and trailing whitespace, line breaks included. |
| `std.string.length(text: String): Int` | none | Number of Unicode scalar values. |
| `std.string.concat(left: String, right: String): String` | none | The two texts joined. |
| `std.string.join(parts: List<String>, separator: String): String` | none | The parts joined with the separator between them; `""` for no parts. |
| `std.string.split(text: String, separator: String): List<String>` | none | The parts of the text between the separators; `std.string.join` with the same separator gives the text back. An empty separator traps. |
| `std.string.compare(left: String, right: String): Order` | none | Orders two texts by Unicode scalar values. |
| `std.string.contains(text: String, part: String): Bool` | none | Whether the part occurs in the text; the empty part occurs in every text. |
| `std.string.starts_with(text: String, prefix: String): Bool` | none | Whether the text begins with the prefix. |
| `std.string.ends_with(text: String, suffix: String): Bool` | none | Whether the text ends with the suffix. |
| `std.string.find(text: String, part: String): Option<Int>` | none | The position of the first occurrence of the part, counted in Unicode scalar values from 0; `None` if it does not occur. |
| `std.string.cut(text: String, separator: String): Option<std.string.Cut>` | none | The text before and after the first occurrence of the separator; `None` if it does not occur. |
| `std.string.take(text: String, count: Int): String` | none | The first `count` Unicode scalar values, or the whole text if it is shorter. A negative count traps. |
| `std.string.drop(text: String, count: Int): String` | none | The text without its first `count` Unicode scalar values; `""` if it is shorter. A negative count traps. |
| `std.string.characters(text: String): List<String>` | none | The Unicode scalar values of the text, each as a text of length 1. |
| `std.string.lines(text: String): List<String>` | none | The lines of the text. A line ends at a line feed, and a carriage return right before it is dropped; a last line without a line break counts, and the empty text has no lines. |
| `std.string.replace(text: String, part: String, with: String): String` | none | The text with every occurrence of the part replaced, found from left to right without overlap. An empty part traps. |
| `std.string.to_upper(text: String): String` | none | The text in upper case by Unicode's rules, the same on every system. |
| `std.string.to_lower(text: String): String` | none | The text in lower case by Unicode's rules, the same on every system. |
| `std.list.empty<T>(): List<T>` | none | The empty list. |
| `std.list.append<T>(list: List<T>, item: T): List<T>` | none | The list with the item added at the end. |
| `std.list.length<T>(list: List<T>): Int` | none | Number of items. |
| `std.list.get<T>(list: List<T>, index: Int): Option<T>` | none | The item at the index, counting from 0; `None` outside the list. |
| `std.list.map<T, U>(list: List<T>, with: (T) -> U): List<U>` | none | Applies the function to every item. |
| `std.list.filter<T>(list: List<T>, with: (T) -> Bool): List<T>` | none | The items for which the function is true. |
| `std.list.fold<T, A>(list: List<T>, initial: A, with: (A, T) -> A): A` | none | Combines the items from first to last, starting with `initial`. |
| `std.list.sort<T>(list: List<T>, by: (T, T) -> Order): List<T>` | none | The items in the order given by the comparison; stable. |
| `std.text.show<T>(value: T): String` | none | Text representation of any value without functions. |

The std types, written in alang:

```
type std.fs.Error
  doc: "Why a file or directory operation failed. Other carries the host's message, which differs between runtimes: show it, do not compare it."
  variant:
    NotFound
    PermissionDenied
    IsADirectory
    Other: String
  where: none
end type std.fs.Error

type std.fs.Kind
  doc: "What a path names. Everything that is not a directory counts as a file."
  variant:
    File
    Directory
  where: none
end type std.fs.Kind

type std.http.Header
  doc: "One header of a request or response."
  record:
    name: String
    value: String
  where: none
end type std.http.Header

type std.http.Request
  doc: "A request as the server received it: method in capitals, path and query as sent (query without the question mark), header names in lowercase and sorted, content (the body) as UTF-8 text."
  record:
    method: String
    path: String
    query: String
    headers: List<Header>
    content: String
  where: none
end type std.http.Request

type std.http.Response
  doc: "The answer to a request. Statuses 204, 205 and 304 carry no content. Without a content-type header, content is sent as text/plain in UTF-8."
  record:
    status: Int
    headers: List<Header>
    content: String
  where: 200 <= status and status <= 599 and (content == "" or (status != 204 and status != 205 and status != 304))
end type std.http.Response

type std.http.ServeError
  doc: "Why the server could not start listening."
  variant:
    AddressInUse
    PermissionDenied
    Other: String
  where: none
end type std.http.ServeError

type std.string.Cut
  doc: "A text cut at a separator: the part before it and the part after it."
  record:
    before: String
    after: String
  where: none
end type std.string.Cut
```

`std.http.serve` returns only when serving ends: with `Ok(Unit)` after SIGINT or SIGTERM, or with `Err` if it cannot listen. Code after it runs after the server has stopped. It prints nothing itself. A request's header names arrive in lowercase and sorted. Without a `content-type` header, content is sent as `text/plain; charset=utf-8`. A trap in a handler ends the whole program; that request gets status 500.

Every `std.fs` function reports a failure the same way. Nothing at the path, a missing parent directory and the empty path are `NotFound`. A refusal by the system is `PermissionDenied`: a file mode, and on Deno also a path it guards beyond its permissions, such as `/proc/version`. A directory where a file is needed is `IsADirectory`. Anything else is `Other` with the host's message, which differs between runtimes: a path that runs through a file, a file where `create_directory` wants a directory, a directory with entries for `remove`, a full disk. An operation outside `main`'s effects traps instead. `write_text` replaces a file without asking; `write_text` and `append_text` follow links, `remove` removes a link itself. `list_directory` gives names, hidden ones included, without `.` and `..`, not recursive; for a file it is `Other`. `kind` follows links (a broken one is `NotFound`), and everything that is not a directory is a `File`, `/dev/null` included; `std.fs.kind(path: p) == Err(std.fs.NotFound)` tests whether a path exists. `create_directory` creates the missing parents and is `Ok` for an existing directory.

`std.console.read_line` ends a line at a line feed and drops a carriage return right before it. An empty line is `Some("")`, and a last line without a line break is returned too; after that, every call is `None`. Invalid UTF-8 reads as U+FFFD. `std.env.get` is `None` for a variable that is not set and for a name no variable can have (empty, or with `=`), and `Some("")` for one set to the empty text. `std.random.int` traps if `low > high` and if the range holds more than 2^53 − 1 values. `std.string.split(text: "a,b,,c", separator: ",")` gives `"a"`, `"b"`, `""`, `"c"`; the empty text gives one empty part, and a text that ends in the separator ends in an empty part (`"x\n"` split at `"\n"` gives `"x"` and `""`).

### 7.9 A complete program

An HTTP server in the recommended shape. `route` is pure and has examples, `handle` is a thin function with an effect, and `main` passes `handle` by name. `alang db run server.main` starts it, and Ctrl-C ends it.

```
fn server.route
  doc: "Answers / with a greeting and POST /echo with the request's content; anything else is not found."
  in:
    request: std.http.Request
  out: std.http.Response
  effects: none
  requires: none
  ensures: none
  examples:
    route(request: std.http.Request(method: "GET", path: "/", query: "", headers: std.list.empty<std.http.Header>(), content: "")) == std.http.Response(status: 200, headers: std.list.empty<std.http.Header>(), content: "Hello from alang")
    route(request: std.http.Request(method: "POST", path: "/echo", query: "", headers: std.list.empty<std.http.Header>(), content: "hi")) == std.http.Response(status: 200, headers: std.list.empty<std.http.Header>(), content: "hi")
    route(request: std.http.Request(method: "GET", path: "/echo", query: "", headers: std.list.empty<std.http.Header>(), content: "")) == std.http.Response(status: 405, headers: [std.http.Header(name: "allow", value: "POST")], content: "")
    route(request: std.http.Request(method: "GET", path: "/nope", query: "", headers: std.list.empty<std.http.Header>(), content: "")) == std.http.Response(status: 404, headers: std.list.empty<std.http.Header>(), content: "Not found")
  body:
    let no_headers: List<std.http.Header> = std.list.empty<std.http.Header>()
    if request.path == "/" then
      return std.http.Response(status: 200, headers: no_headers, content: "Hello from alang")
    end if
    if request.path == "/echo" then
      if request.method == "POST" then
        return std.http.Response(status: 200, headers: no_headers, content: request.content)
      end if
      let allow: List<std.http.Header> = [std.http.Header(name: "allow", value: "POST")]
      return std.http.Response(status: 405, headers: allow, content: "")
    end if
    return std.http.Response(status: 404, headers: no_headers, content: "Not found")
end fn server.route

fn server.handle
  doc: "Answers a request through route and prints one line about it."
  in:
    request: std.http.Request
  out: std.http.Response
  effects: console
  requires: none
  ensures: none
  examples: none
  body:
    let response: std.http.Response = route(request: request)
    std.console.print_line(text: std.string.join(parts: [request.method, " ", request.path, " -> ", std.text.show(value: response.status)], separator: ""))
    return response
end fn server.handle

fn server.main
  doc: "Serves on http://localhost:8080 until Ctrl-C."
  in: none
  out: Unit
  effects: net, console
  requires: none
  ensures: none
  examples: none
  body:
    std.console.print_line(text: "Serving on http://localhost:8080; Ctrl-C stops.")
    let served: Result<Unit, std.http.ServeError> = std.http.serve(host: "localhost", port: 8080, handler: handle)
    let text: String = match served
      case Ok(done) then
        "Stopped."
      case Err(reason) then
        std.string.concat(left: "Cannot serve: ", right: std.text.show(value: reason))
    end match
    std.console.print_line(text: text)
    return Unit
end fn server.main
```

### 7.10 Working with the codebase

Section 6 in practice. `alang mcp` offers the queries and operations as tools for an LLM, and `alang db` offers them on the command line with the same JSON results.

| Query | Result |
| --- | --- |
| `list(module)` | The module's definitions (name, hash, kind, doc) and submodules; without a module, the codebase's top level; `std` for the library |
| `search(text)` | Definitions whose name or `doc` contains the text, std included |
| `search_type(pattern)` | Functions by signature, such as `String -> Option<Int>`, `Int, Int -> Bool`, or `-> Unit` for none. `_` matches any type; `Port` matches by last segment. The parameter count and the result type must match exactly, so `String -> Int` does not find `std.int.parse` |
| `context(name)` | The text and hash, and the signatures of everything it uses (std as one line or as alang text). Read this before a change |
| `definition(name)`, `signature(name)` | The text, or every section but `body` |
| `callers(name)` | The definitions that use it |
| `history(name)` | Every version with time and operation (`add`, `replace`, `remove`, `rename`, `follow`, `import`) |

| Operation | Effect |
| --- | --- |
| `add(text)` | Adds a definition; E0503 if the name exists |
| `replace(name, hash, text)` | Replaces the version with this hash |
| `remove(name, hash)` | Removes it; rejected while callers exist (E0507) |
| `rename(name, hash, to, text?)` | Renames it and rewrites every caller; with `text`, it also changes the definition |
| `submit(changes)` | Several of the above as one transaction (6.4) |

- **The hash is a guard (6.7).** Copy it from the last query or change result. A stale hash is rejected (E0501) together with the current version in `current`; redo the change on that version. Never write a hash into code.
- **Results.** `ok: true` lists `written` (name, new hash, operation), `unchanged`, and, if present, `fixed`. `ok: false` lists `diagnostics` and `current`, and nothing was written.
- **Interface changes.** Every section of a function except `doc`, `examples` and `body` belongs to its interface; so do a type's shape and `where`. Removing an effect is not an interface change. A change to the interface is rejected while callers outside the transaction exist (E0506). Submit them in the same transaction, adapted or unchanged.
- **Departures from section 6.** References are stored as names, not hashes, so `rename` rewrites every caller, and each caller gets a new version (6.1). `search(type)` is `search_type`. std can be read but not changed, and has no history.
- **Export.** `export/<module>.alang` holds each module as canonical text for Git, and it is the source of truth. The database and the export follow each other automatically. If both changed, E0513 is reported, and which side wins is the user's call.
- **Running.** `alang db run` runs the program the database holds. If there are several `main` functions, name one: `alang db run web.main` (E0304). Arguments for the program go after `--`: `alang db run web.main -- <args>`.

### 7.11 Diagnostics

Every diagnostic has the fields of 5.5: `code`, `definition`, `section`, `at` (the quoted text), `message`, `expected` and `fix`. `fix` is present when the correction is mechanical. The code says where a diagnostic comes from:

| Codes | Concern |
| --- | --- |
| E0001 to E0006 | Characters, names, numbers, strings, foreign forms |
| E0101 to E0199 | Syntax and section order |
| E0201 to E0228 | Names, types, calls, patterns, examples' form, the empty list |
| E0230 to E0233 | Effects |
| E0301 to E0305 | Code generation and `main` |
| E0401 to E0403 | Missing, failing and trapping examples |
| E0501 to E0513 | Codebase operations |
