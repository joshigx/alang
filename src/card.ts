// The language card: the rules every definition needs and one complete
// accepted program, on one page. The MCP server serves it through the tool
// `card` (mcp.ts), and its instructions send the model there first; the
// standard library is left to the tools (`list`, `search`, `search_type`,
// whose hits carry each function's and type's signature).
//
// The card restates section 7 of alang-specs.md in short. When a rule there
// changes, change it here too. tests/card_test.ts parses its code, accepts
// its program and checks every code and std name it mentions.

export const CARD = `# The alang card

alang is written by LLMs and transpiled to TypeScript. Write from this card; the tools find the standard library.

## Working through the tools

- \`list("std")\` gives the std modules, \`list("std.string")\` a module's definitions. \`search("split")\` finds names
  and docs containing a text. Each hit holds its signature (parameters, result, effects; fields or cases) and doc.
- \`search_type("String, String -> List<String>")\` finds functions by signature: parameter types in order, \`_\` for
  any type; the count and the result must match.
- \`context(name)\` gives a definition's text (examples, body) and hash and the signatures of what it uses: read code
  this way, not from \`export/\`. To use a std function or type its hit is enough; \`context\` adds the types it mentions.
- \`add(text)\` adds a definition, \`replace(name, hash, text)\` replaces the version whose hash a query returned, and
  \`submit(changes)\` sends several as one transaction: definitions that use each other, or an interface change with
  its callers. Nothing is written unless all of it is accepted.
- A rejected change returns diagnostics with \`code\`, \`at\` (the quoted text), \`message\`, \`expected\` and, when the
  correction is mechanical, a \`fix\` (\`replace\` by \`with\`): apply it and send the change again.

## Definitions

- A definition is a \`fn\` or a \`type\` with a full name, module first: \`temp.fahrenheit\`, \`net.port.Port\`. \`std\` is
  reserved. \`snake_case\` for values, functions and modules, \`PascalCase\` for types and cases.
- \`fn\`: the sections \`doc: "..."\`, \`in:\`, \`out: Type\`, \`effects:\`, \`requires:\`, \`ensures:\`, \`examples:\`, \`body:\`,
  all present, in this order, then \`end fn <full name>\`. An empty section is \`none\`. \`in:\` is \`none\` or one
  \`name: Type\` per line below it.
- \`type\`: \`doc\`, then \`record:\` (one \`name: Type\` per line) or \`variant:\` (one case per line, \`Name\` or
  \`Name: Type\`, at most one value), then \`where:\` (\`none\` or an invariant over the fields; \`none\` for a variant),
  then \`end type <full name>\`.
- Names of the own module are short (\`Problem\`, \`fahrenheit\`, \`NotANumber\` in \`temp\`). All others are in full, std
  included, and enclosing or nested modules count as others. A case's full name is \`module.Case\`
  (\`std.fs.NotFound\`), so case names are unique per module. Built-ins are always short: \`Int Float Bool String
  Unit List<T> Map<K, V> Option<T> Result<T, E> Order\` and \`Some None Ok Err Less Equal Greater\`.
- Keywords, section words included (\`in\`, \`out\`, \`type\`, \`body\`, \`end\`, \`record\`), name nothing. \`result\` and
  \`error\` name no parameter or binding (E0109).
- \`main\`: \`in: none\`, \`out: Unit\` or \`out: Result<Unit, String>\` (an \`Err\` goes to stderr, exit code 1). Its I/O
  errors become text: \`let t: String = std.fs.read_text(path: p) else return Err(std.fs.describe(error: error))\`.

## Bodies

- One statement per line: \`let\`, \`return\`, or an expression of type \`Unit\`. Every other value is used (E0217).
- \`let n: Int = expression\`, always with the type, never \`Unit\` (E0235); immutable, reusing no visible name (E0216).
- \`let n: Int = std.int.parse(text: t) else return Err(NotANumber(t))\`: the content of \`Some\` or \`Ok\` is bound;
  otherwise the function returns the \`else\` value, in which \`error\` is the \`Err\` value. A \`Result<Unit, E>\` needs
  no \`let\`: \`std.fs.write_text(path: p, text: t) else return Err(error)\`. A list of known length is taken apart
  by name, \`let [key, value]: List<String> = parts else return None\`, when it has exactly as many items as names.
- \`if c then ... else ... end if\`, \`match x\` with \`case Pattern then ...\` lines and \`end match\`, and
  \`for x: T in list do ... end for\` stand as a statement, as the value of a \`let\`, or after \`return\`; never inside
  another expression or a lambda (E0303). As a value, a branch's value is its last line, an \`if\` needs \`else\`
  (E0110), and a \`for\` is the list of its body's values.
- The last line of a body is literally a \`return\` (E0218), so an \`if\` or \`match\` whose branches all return cannot
  end it: return early from an \`if\` without \`else\`, then \`return\` (see \`fahrenheit\` below). Keep to two nested
  blocks; deeper code becomes a function.
- \`match\` covers each case once (E0213, E0214). A case without a value is bare (\`case None then\`), patterns nest
  (\`case Err(NotANumber(word)) then\`), and every value gets a name, used or not: there is no \`_\`. No catch-all: a
  name beside specific cases of its type is E0227; cases alike share an arm, which binds only what all of them bind:
  \`case std.fs.PermissionDenied or std.fs.Other(message) then\`. A \`match\` on \`Int\` or \`String\` is never exhaustive.

## Expressions

- Every argument is named, in declaration order (E0107, E0205 to E0208): \`std.string.concat(left: a, right: b)\`,
  records too: \`Item(name: "x", count: 1)\`. A case's value is unnamed: \`Some(n)\`, \`Err(NotANumber(t))\`. Fields:
  \`item.name\`. No method calls (\`x.f()\`, E0220).
- Type arguments only where no argument fixes them (E0209): \`std.list.empty<Int>()\`.
- \`Ok\`, \`Err\` and \`None\` take their type from what is expected there (a \`let\`, a parameter, \`out\` at \`return\`, the
  left side of \`==\`), so the known side comes first: \`f(x: 1) == None\`, not \`None == f(x: 1)\` (E0210).
- Lists: \`[a, b, c]\`; the empty list is \`std.list.empty<T>()\`, never \`[]\` (E0228). No \`xs[0]\` and no \`Int[]\`:
  \`std.list.get\` gives an \`Option\`, the type is \`List<Int>\`.
- Maps: \`["a": 1, "b": 2]\` is a \`Map<String, Int>\`; keys are \`Int\` or \`String\` (E0229), each written once (E0234);
  the empty map is \`std.map.empty<K, V>()\`, never \`[:]\` (E0228). No \`m["a"]\`: \`std.map.get\` gives an \`Option\`.
- \`+ - * / %\` take two \`Int\` or two \`Float\`; nothing converts implicitly. \`==\` and \`!=\` work on every type without
  functions, \`< <= > >=\` on \`Int\`, \`Float\` and \`String\`; logic is \`and\`, \`or\`, \`not\`. Mixing \`+ -\` with \`* / %\`, or
  \`and\` with \`or\`, needs parentheses: \`(c * 9 / 5) + 32\`. Only a literal takes a minus (\`-3\`); write \`0 - x\`.
- Lambdas: \`fn(item: Int): Int => item * factor\`, one expression, pure (E0232), reading the bindings around them.
  A pure function's name is a value too: \`by: std.string.compare\`. A parameter, field or \`let\` may have a function
  type such as \`(Int, Int) -> Order\`, applied by position: \`by(a, b)\`. No \`fn\` returns one, even in a list or record
  (E0237). An \`Option\` inside a lambda is unwrapped with \`std.option.with_default\` or \`std.list.filter_map\`.
- Strings: double quotes, on one line. The escapes are only \`\\"\`, \`\\\\\`, \`\\n\`, \`\\t\` and \`\\u{1B}\` (uppercase hex) for
  other control characters (\`\\r\` is \`\\u{D}\`); every other character is itself (\`"é"\`). Join with \`std.string.concat\`
  or \`std.string.join(parts: [a, b], separator: "")\`, never \`+\`. A value as text: \`std.text.show(value: v)\`.
- Numbers: more than four digits are grouped with \`_\` (\`65_535\`; but \`1000\`, never \`1_000\`), no leading zeros;
  floats \`1.0\`, \`0.25\`. Also \`true\`, \`false\` and \`Unit\`.

## Effects, contracts, examples

- \`effects:\` is \`none\` or a list in this order: \`fs.read, fs.write, net, time, random, env, log, console\` (E0111).
  A function declares the effects of everything it calls (E0230).
- \`requires\` sees the parameters, \`ensures\` also \`result\`, \`where\` the fields. They call only pure functions and
  are checked at runtime; a broken one traps, as do division by zero and \`Int\` overflow.
- \`examples:\` lines \`call == expected\`, calling the function itself by its short name (E0221). A function with
  \`effects: none\` has at least one (E0401); a function with effects has \`examples: none\`. Every change runs every
  example; a failing one reports the actual value (E0402). So logic goes into pure functions with examples, and
  functions with effects stay thin.

## Not in alang

No comments (the \`doc\` describes), \`const\`, \`extern fn\`, imports, \`var\`, assignment, \`null\`, exceptions, \`while\`
(use recursion), \`?\`, braces, \`;\`, \`'\`, \`===\`, \`&&\`, \`||\`, \`!\`, tuples, generic definitions, concurrency. Most of
these get E0006, which names the alang form.

## A complete program, accepted as it stands

\`\`\`
type temp.Problem
  doc: "Why a text is not a temperature."
  variant:
    NotANumber: String
    BelowAbsoluteZero: Int
  where: none
end type temp.Problem

fn temp.fahrenheit
  doc: "Reads whole degrees Celsius and converts them to degrees Fahrenheit, rounded toward zero."
  in:
    text: String
  out: Result<Int, Problem>
  effects: none
  requires: none
  ensures: none
  examples:
    fahrenheit(text: "100") == Ok(212)
    fahrenheit(text: "-40") == Ok(-40)
    fahrenheit(text: "warm") == Err(NotANumber("warm"))
    fahrenheit(text: "-300") == Err(BelowAbsoluteZero(-300))
  body:
    let celsius: Int = std.int.parse(text: text) else return Err(NotANumber(text))
    if celsius < -273 then
      return Err(BelowAbsoluteZero(celsius))
    end if
    return Ok((celsius * 9 / 5) + 32)
end fn temp.fahrenheit

fn temp.main
  doc: "Prints every argument converted to Fahrenheit, one per line."
  in: none
  out: Result<Unit, String>
  effects: env, console
  requires: none
  ensures: none
  examples: none
  body:
    let args: List<String> = std.env.args()
    if args == std.list.empty<String>() then
      return Err("usage: temp <celsius>...")
    end if
    for text: String in args do
      let line: String = match fahrenheit(text: text)
        case Ok(degrees) then
          std.string.join(parts: [text, " C is ", std.text.show(value: degrees), " F"], separator: "")
        case Err(NotANumber(word)) then
          std.string.concat(left: "not a number: ", right: word)
        case Err(BelowAbsoluteZero(celsius)) then
          std.string.concat(left: "below absolute zero: ", right: text)
      end match
      std.console.print_line(text: line)
    end for
    return Ok(Unit)
end fn temp.main
\`\`\`
`;
