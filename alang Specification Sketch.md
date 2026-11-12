# alang: Specification Sketch

Nov 12, 2026

## Overview

alang is written and edited by LLMs, read by humans mainly at the contract level, and transpiled to TypeScript. This sketch defines only the language core, organized by six design principles and, for now, without concurrency and asynchronous calls. The semantics are defined independently of the target language, so that further targets remain possible.

There are four kinds of definitions. Each has a full name of the form `module.path.name`.

| Definition | Content |
| --- | --- |
| `fn` | Function with contract, examples and body |
| `type` | Record or variant, with an optional invariant |
| `const` | Named, immutable value |
| `extern fn` | Signature of a function in the target language, with `target` instead of `body` |

A program starts at a function named `main` with `in: none` and `out: Unit`. The smallest complete program:

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
let contents: List<Result<String, std.fs.ReadError>> = for path: String in paths do
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

expr       = if | match | for | lambda | call | construct
           | binary | unary | field | literal | name ;
if         = "if" expr "then" stmt { stmt } [ "else" stmt { stmt } ] "end" "if" ;
match      = "match" expr arm { arm } "end" "match" ;
arm        = "case" pattern "then" stmt { stmt } ;
pattern    = TypePath [ "(" ( pattern | name ) ")" ] | literal ;
lambda     = "fn" "(" param { "," param } ")" ":" type "=>" expr ;
call       = path [ "<" type { "," type } ">" ] "(" [ arg { "," arg } ] ")" ;
arg        = name ":" expr ;
construct  = TypePath [ "(" ( arg { "," arg } | expr ) ")" ] ;
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
