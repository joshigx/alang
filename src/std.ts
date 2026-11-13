// Signatures of the standard library. Each entry has an implementation in
// runtime.ts under its mangled name (`std.int.parse` -> `std$int$parse`);
// a test keeps the two in sync.

import type { Definition, Effect } from "./ast.ts";
import { parseProgram } from "./parser.ts";
import { printString } from "./printer.ts";
import {
  BOOL,
  con,
  FLOAT,
  fnType,
  INT,
  list,
  map,
  option,
  ORDER,
  result,
  showType,
  STRING,
  tvar,
  type Type,
  UNIT,
} from "./types.ts";

// Types of the standard library, written in alang. runtime.ts has the
// matching TypeScript type under the mangled name (`std$fs$Error`).
export const STD_TYPES_SOURCE = `type std.fs.Error
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
`;

export const STD_TYPES: readonly Definition[] = parseProgram(STD_TYPES_SOURCE);

export interface Signature {
  readonly name: string;
  readonly typeParams: readonly string[];
  readonly params: readonly { readonly name: string; readonly type: Type }[];
  readonly out: Type;
  readonly effects: readonly Effect[];
  readonly doc: string;
  // Type parameters that may not be bound to a type with function values,
  // since the function compares or shows values (3.9, E0222).
  readonly withoutFunctions?: readonly string[];
}

const T = tvar("T");
const U = tvar("U");
const V = tvar("V");
const A = tvar("A");
const K = tvar("K");

function sig(
  name: string,
  doc: string,
  typeParams: string[],
  params: [string, Type][],
  out: Type,
  effects: Effect[] = [],
  withoutFunctions?: string[],
): Signature {
  const signature = { name, doc, typeParams, params: params.map(([name, type]) => ({ name, type })), out, effects };
  return withoutFunctions ? { ...signature, withoutFunctions } : signature;
}

export const STD: readonly Signature[] = [
  sig("std.console.print_line", "Writes a line to the console.", [], [["text", STRING]], UNIT, ["console"]),
  sig(
    "std.console.read_line",
    "Reads the next line from the console, without its line break; `None` at the end of the input.",
    [],
    [],
    option(STRING),
    ["console"],
  ),

  sig("std.env.args", "The arguments the program was started with.", [], [], list(STRING), ["env"]),
  sig(
    "std.env.get",
    "The value of an environment variable; `None` if it is not set.",
    [],
    [["name", STRING]],
    option(STRING),
    ["env"],
  ),

  sig(
    "std.fs.read_text",
    "Reads a whole file as UTF-8 text.",
    [],
    [["path", STRING]],
    result(STRING, con("std.fs.Error")),
    ["fs.read"],
  ),
  sig(
    "std.fs.write_text",
    "Writes the text to a file as UTF-8, creating the file or replacing its content.",
    [],
    [["path", STRING], ["text", STRING]],
    result(UNIT, con("std.fs.Error")),
    ["fs.write"],
  ),
  sig(
    "std.fs.append_text",
    "Adds the text to the end of a file as UTF-8, creating the file if it is missing.",
    [],
    [["path", STRING], ["text", STRING]],
    result(UNIT, con("std.fs.Error")),
    ["fs.write"],
  ),
  sig(
    "std.fs.list_directory",
    "The names of a directory's entries, in the order of `std.string.compare`; names, not paths.",
    [],
    [["path", STRING]],
    result(list(STRING), con("std.fs.Error")),
    ["fs.read"],
  ),
  sig(
    "std.fs.kind",
    "Whether a path exists as a file or as a directory; `Err(NotFound)` if nothing is there.",
    [],
    [["path", STRING]],
    result(con("std.fs.Kind"), con("std.fs.Error")),
    ["fs.read"],
  ),
  sig(
    "std.fs.create_directory",
    "Creates a directory and its missing parents; `Ok` if it already exists.",
    [],
    [["path", STRING]],
    result(UNIT, con("std.fs.Error")),
    ["fs.write"],
  ),
  sig(
    "std.fs.remove",
    "Removes a file or an empty directory.",
    [],
    [["path", STRING]],
    result(UNIT, con("std.fs.Error")),
    ["fs.write"],
  ),

  sig(
    "std.http.serve",
    "Answers requests with the handler, one at a time, until the program gets SIGINT or SIGTERM; then `Ok(Unit)`. `Err` if it cannot listen. The handler may have effects; the caller declares them.",
    [],
    [["host", STRING], ["port", INT], [
      "handler",
      fnType([con("std.http.Request")], con("std.http.Response"), "caller"),
    ]],
    result(UNIT, con("std.http.ServeError")),
    ["net"],
  ),

  sig(
    "std.log.print_line",
    "Writes a line to the log, which is the standard error stream.",
    [],
    [["text", STRING]],
    UNIT,
    ["log"],
  ),
  sig(
    "std.random.int",
    "A random integer from `low` to `high`, both included; traps if `low > high`. Not for secrets.",
    [],
    [["low", INT], ["high", INT]],
    INT,
    ["random"],
  ),
  sig(
    "std.time.now_milliseconds",
    "The clock's time in milliseconds since 1970-01-01T00:00:00Z.",
    [],
    [],
    INT,
    ["time"],
  ),

  sig(
    "std.int.parse",
    "Reads an integer written as an optional `-` and the digits `0` to `9`; leading zeros are allowed (`007` is 7, `-0` is 0). `None` for anything else (`+`, `_`, whitespace, the empty text) and outside the Int range.",
    [],
    [["text", STRING]],
    option(INT),
  ),
  sig("std.int.to_float", "The same number as a Float.", [], [["value", INT]], FLOAT),
  sig("std.int.compare", "Orders two integers.", [], [["left", INT], ["right", INT]], ORDER),
  sig("std.int.min", "The smaller of two integers.", [], [["left", INT], ["right", INT]], INT),
  sig("std.int.max", "The larger of two integers.", [], [["left", INT], ["right", INT]], INT),
  sig("std.int.abs", "The value without its sign.", [], [["value", INT]], INT),
  sig(
    "std.int.checked_add",
    "The sum; `None` if it is outside the Int range.",
    [],
    [["left", INT], ["right", INT]],
    option(INT),
  ),
  sig(
    "std.int.checked_subtract",
    "The difference; `None` if it is outside the Int range.",
    [],
    [["left", INT], ["right", INT]],
    option(INT),
  ),
  sig(
    "std.int.checked_multiply",
    "The product; `None` if it is outside the Int range.",
    [],
    [["left", INT], ["right", INT]],
    option(INT),
  ),

  sig("std.float.floor", "The largest integer not above the value; traps outside the Int range.", [], [[
    "value",
    FLOAT,
  ]], INT),
  sig("std.float.compare", "Orders two numbers.", [], [["left", FLOAT], ["right", FLOAT]], ORDER),
  sig(
    "std.float.parse",
    "Reads a decimal number written as an optional `-`, the digits `0` to `9`, and optionally `.` and more digits (`3`, `-0.25`, `007.5`; `-0` gives `-0.0`). `None` for anything else (`+`, `.5`, `1.`, `1e3`, whitespace, the empty text) and for a number too large to be finite.",
    [],
    [["text", STRING]],
    option(FLOAT),
  ),
  sig(
    "std.float.round",
    "The nearest integer, halves away from zero (`2.5` gives 3, `-2.5` gives -3); traps outside the Int range.",
    [],
    [["value", FLOAT]],
    INT,
  ),
  sig(
    "std.float.ceil",
    "The smallest integer not below the value; traps outside the Int range.",
    [],
    [["value", FLOAT]],
    INT,
  ),
  sig(
    "std.float.trunc",
    "The value without its fraction, toward zero; traps outside the Int range.",
    [],
    [["value", FLOAT]],
    INT,
  ),
  sig("std.float.abs", "The absolute value: the value without its sign.", [], [["value", FLOAT]], FLOAT),
  sig("std.float.min", "The smaller of two numbers.", [], [["left", FLOAT], ["right", FLOAT]], FLOAT),
  sig("std.float.max", "The larger of two numbers.", [], [["left", FLOAT], ["right", FLOAT]], FLOAT),
  sig("std.float.sqrt", "The square root. A negative value traps.", [], [["value", FLOAT]], FLOAT),
  sig(
    "std.float.to_fixed",
    "Formats the value as decimal text with exactly `decimals` digits after the point (`1.5` with 2 gives `1.50`). It rounds the exact binary value, halves away from zero: `1.005`, stored just below the tie, gives `1.00` with 2, and the exact tie `0.125` gives `0.13`. Never in exponent form, and without a minus sign when only zeros show. Infinities give `Infinity` and `-Infinity`. A `decimals` below 0 or above 100 traps.",
    [],
    [["value", FLOAT], ["decimals", INT]],
    STRING,
  ),

  sig(
    "std.string.trim",
    "Removes leading and trailing whitespace, line breaks included.",
    [],
    [["text", STRING]],
    STRING,
  ),
  sig("std.string.length", "Number of Unicode scalar values.", [], [["text", STRING]], INT),
  sig("std.string.concat", "The two texts joined.", [], [["left", STRING], ["right", STRING]], STRING),
  sig("std.string.join", 'The parts joined with the separator between them; `""` for no parts.', [], [
    ["parts", list(STRING)],
    ["separator", STRING],
  ], STRING),
  sig(
    "std.string.split",
    "The parts of the text between the separators; `std.string.join` with the same separator gives the text back. An empty separator traps.",
    [],
    [["text", STRING], ["separator", STRING]],
    list(STRING),
  ),
  sig("std.string.compare", "Orders two texts by Unicode scalar values.", [], [["left", STRING], [
    "right",
    STRING,
  ]], ORDER),
  sig(
    "std.string.contains",
    "Whether the part occurs in the text; the empty part occurs in every text.",
    [],
    [["text", STRING], ["part", STRING]],
    BOOL,
  ),
  sig(
    "std.string.starts_with",
    "Whether the text begins with the prefix.",
    [],
    [["text", STRING], ["prefix", STRING]],
    BOOL,
  ),
  sig(
    "std.string.ends_with",
    "Whether the text ends with the suffix.",
    [],
    [["text", STRING], ["suffix", STRING]],
    BOOL,
  ),
  sig(
    "std.string.find",
    "The position of the first occurrence of the part, counted in Unicode scalar values from 0; `None` if it does not occur.",
    [],
    [["text", STRING], ["part", STRING]],
    option(INT),
  ),
  sig(
    "std.string.cut",
    "The text before and after the first occurrence of the separator; `None` if it does not occur.",
    [],
    [["text", STRING], ["separator", STRING]],
    option(con("std.string.Cut")),
  ),
  sig(
    "std.string.take",
    "The first `count` Unicode scalar values, or the whole text if it is shorter. A negative count traps.",
    [],
    [["text", STRING], ["count", INT]],
    STRING,
  ),
  sig(
    "std.string.drop",
    'The text without its first `count` Unicode scalar values; `""` if it is shorter. A negative count traps.',
    [],
    [["text", STRING], ["count", INT]],
    STRING,
  ),
  sig(
    "std.string.characters",
    "The Unicode scalar values of the text, each as a text of length 1.",
    [],
    [["text", STRING]],
    list(STRING),
  ),
  sig(
    "std.string.lines",
    "The lines of the text. A line ends at a line feed, and a carriage return right before it is dropped; a last line without a line break counts, and the empty text has no lines.",
    [],
    [["text", STRING]],
    list(STRING),
  ),
  sig(
    "std.string.replace",
    "The text with every occurrence of the part replaced, found from left to right without overlap. An empty part traps.",
    [],
    [["text", STRING], ["part", STRING], ["with", STRING]],
    STRING,
  ),
  sig(
    "std.string.to_upper",
    "The text in upper case by Unicode's rules, the same on every system.",
    [],
    [["text", STRING]],
    STRING,
  ),
  sig(
    "std.string.to_lower",
    "The text in lower case by Unicode's rules, the same on every system.",
    [],
    [["text", STRING]],
    STRING,
  ),
  sig(
    "std.string.repeat",
    'The text `count` times in a row; `""` for 0. A negative count traps.',
    [],
    [["text", STRING], ["count", INT]],
    STRING,
  ),
  sig(
    "std.string.pad_left",
    "The text with `fill` added before it until it is `width` Unicode scalar values long, to align text in columns; unchanged if it is that long already. A `fill` that is not exactly one Unicode scalar value traps.",
    [],
    [["text", STRING], ["width", INT], ["fill", STRING]],
    STRING,
  ),
  sig(
    "std.string.pad_right",
    "The text with `fill` added after it until it is `width` Unicode scalar values long, to align text in columns; unchanged if it is that long already. A `fill` that is not exactly one Unicode scalar value traps.",
    [],
    [["text", STRING], ["width", INT], ["fill", STRING]],
    STRING,
  ),
  sig(
    "std.string.trim_characters",
    "Strips every character that occurs in `characters` from both ends of the text, such as quotes or punctuation; `std.string.trim` strips whitespace.",
    [],
    [["text", STRING], ["characters", STRING]],
    STRING,
  ),
  sig(
    "std.string.code_points",
    "The character codes (code points) of the text: every Unicode scalar value as its number, such as 97 for `a`.",
    [],
    [["text", STRING]],
    list(INT),
  ),
  sig(
    "std.string.from_code_points",
    "The text with the given character codes (code points). A number that is not a Unicode scalar value (below 0, above 1_114_111, or from 55_296 to 57_343) traps.",
    [],
    [["code_points", list(INT)]],
    STRING,
  ),

  sig(
    "std.list.empty",
    "The empty list. A list with items is written as a literal, such as `[1, 2, 3]`.",
    ["T"],
    [],
    list(T),
  ),
  sig(
    "std.list.append",
    "The list with the item added at the end; copies the list, so appending item by item in a loop is quadratic.",
    ["T"],
    [["list", list(T)], ["item", T]],
    list(T),
  ),
  sig("std.list.length", "Number of items.", ["T"], [["list", list(T)]], INT),
  sig("std.list.get", "The item at the index, counting from 0; `None` outside the list.", ["T"], [
    ["list", list(T)],
    ["index", INT],
  ], option(T)),
  sig("std.list.map", "Applies the function to every item.", ["T", "U"], [
    ["list", list(T)],
    ["with", fnType([T], U)],
  ], list(U)),
  sig("std.list.filter", "The items for which the function is true.", ["T"], [
    ["list", list(T)],
    ["with", fnType([T], BOOL)],
  ], list(T)),
  sig("std.list.fold", "Combines the items from first to last, starting with `initial`.", ["T", "A"], [
    ["list", list(T)],
    ["initial", A],
    ["with", fnType([A, T], A)],
  ], A),
  sig("std.list.sort", "The items in the order given by the comparison; stable.", ["T"], [
    ["list", list(T)],
    ["by", fnType([T, T], ORDER)],
  ], list(T)),

  sig(
    "std.list.first",
    "The first item; `None` for the empty list.",
    ["T"],
    [["list", list(T)]],
    option(T),
  ),
  sig("std.list.last", "The last item; `None` for the empty list.", ["T"], [["list", list(T)]], option(T)),
  sig(
    "std.list.take",
    "The first `count` items, or the whole list if it is shorter. A negative count traps.",
    ["T"],
    [["list", list(T)], ["count", INT]],
    list(T),
  ),
  sig(
    "std.list.drop",
    "The list without its first `count` items; empty if it is shorter. A negative count traps.",
    ["T"],
    [["list", list(T)], ["count", INT]],
    list(T),
  ),
  sig("std.list.reverse", "The items from last to first.", ["T"], [["list", list(T)]], list(T)),
  sig(
    "std.list.concat",
    "The items of the left list followed by those of the right; copies both lists, so growing a list piece by piece in a loop is quadratic.",
    ["T"],
    [["left", list(T)], ["right", list(T)]],
    list(T),
  ),
  sig("std.list.flatten", "The items of all the lists, in order.", ["T"], [["lists", list(list(T))]], list(T)),
  sig(
    "std.list.contains",
    "Whether the list holds an item equal to the given one.",
    ["T"],
    [["list", list(T)], ["item", T]],
    BOOL,
    [],
    ["T"],
  ),
  sig(
    "std.list.range",
    "The integers from `low` to `high`, both included, in ascending order; empty if `low > high`.",
    [],
    [["low", INT], ["high", INT]],
    list(INT),
  ),
  sig(
    "std.list.window",
    "Every run of `size` neighbouring items, from first to last; empty if the list is shorter. A size below 1 traps.",
    ["T"],
    [["list", list(T)], ["size", INT]],
    list(list(T)),
  ),
  sig(
    "std.list.zip",
    "Combines the items of two lists pair by pair with the function. Lists of different lengths trap.",
    ["T", "U", "V"],
    [["left", list(T)], ["right", list(U)], ["with", fnType([T, U], V)]],
    list(V),
  ),
  sig(
    "std.list.enumerate",
    "Applies the function to the index of every item, counting from 0, and the item.",
    ["T", "U"],
    [["list", list(T)], ["with", fnType([INT, T], U)]],
    list(U),
  ),
  sig(
    "std.list.any",
    "Whether the function is true for some item; `false` for the empty list. Stops at the first item for which it is true.",
    ["T"],
    [["list", list(T)], ["with", fnType([T], BOOL)]],
    BOOL,
  ),
  sig(
    "std.list.all",
    "Whether the function is true for every item; `true` for the empty list. Stops at the first item for which it is false.",
    ["T"],
    [["list", list(T)], ["with", fnType([T], BOOL)]],
    BOOL,
  ),
  sig(
    "std.list.find",
    "The first item for which the function is true; `None` if there is none. Stops at that item.",
    ["T"],
    [["list", list(T)], ["with", fnType([T], BOOL)]],
    option(T),
  ),
  sig(
    "std.list.filter_map",
    "Applies the function to every item and keeps the values inside its `Some` results, in order: `map` and `filter` in one.",
    ["T", "U"],
    [["list", list(T)], ["with", fnType([T], option(U))]],
    list(U),
  ),
  sig(
    "std.list.take_while",
    "The items from the start for which the function is true, up to the first for which it is false. Stops there.",
    ["T"],
    [["list", list(T)], ["with", fnType([T], BOOL)]],
    list(T),
  ),
  sig(
    "std.list.drop_while",
    "Skips the items from the start for which the function is true: the rest of the list from the first item for which it is false.",
    ["T"],
    [["list", list(T)], ["with", fnType([T], BOOL)]],
    list(T),
  ),

  sig(
    "std.map.empty",
    "The empty map. A map with entries is written as a literal of `key: value` pairs, such as `[1: 10, 2: 20]`; keys are Int or String.",
    ["K", "V"],
    [],
    map(K, V),
  ),
  sig(
    "std.map.insert",
    "The map with `key` bound to `value`, replacing an earlier value of `key`. Takes time logarithmic in the size of the map, so counting or grouping item by item in `std.list.fold` is fine.",
    ["K", "V"],
    [["map", map(K, V)], ["key", K], ["value", V]],
    map(K, V),
  ),
  sig(
    "std.map.get",
    "Looks up the value of `key`; `None` if the map has no such key.",
    ["K", "V"],
    [["map", map(K, V)], ["key", K]],
    option(V),
  ),
  sig(
    "std.map.remove",
    "The map without `key`; the same map if it has no such key.",
    ["K", "V"],
    [["map", map(K, V)], ["key", K]],
    map(K, V),
  ),
  sig("std.map.contains", "Whether the map has `key`.", ["K", "V"], [["map", map(K, V)], ["key", K]], BOOL),
  sig("std.map.size", "Number of keys.", ["K", "V"], [["map", map(K, V)]], INT),
  sig(
    "std.map.keys",
    "The keys in ascending order: Int keys by value, String keys as `std.string.compare` orders them.",
    ["K", "V"],
    [["map", map(K, V)]],
    list(K),
  ),
  sig("std.map.values", "The values, in the order of their keys.", ["K", "V"], [["map", map(K, V)]], list(V)),
  sig(
    "std.map.from_list",
    "A map with an entry for every item, its key and value computed by the two functions. Two items with the same key trap; to keep the last or combine them, use `std.list.fold` with `std.map.insert`.",
    ["T", "K", "V"],
    [["list", list(T)], ["key", fnType([T], K)], ["value", fnType([T], V)]],
    map(K, V),
  ),
  sig(
    "std.map.to_list",
    "Applies the function to every key and its value, in the order of the keys.",
    ["K", "V", "T"],
    [["map", map(K, V)], ["with", fnType([K, V], T)]],
    list(T),
  ),

  sig(
    "std.option.with_default",
    "Unwraps an Option: the value inside `Some`, or `default` for `None`.",
    ["T"],
    [["option", option(T)], ["default", T]],
    T,
  ),
  sig(
    "std.option.map",
    "Applies the function to the value inside `Some`; `None` stays `None`.",
    ["T", "U"],
    [["option", option(T)], ["with", fnType([T], U)]],
    option(U),
  ),

  sig(
    "std.order.then_by",
    "Breaks ties: `first`, unless it is `Equal`; then `second`. Compares by several keys in one expression.",
    [],
    [["first", ORDER], ["second", ORDER]],
    ORDER,
  ),

  sig("std.text.show", "Text representation of any value without functions.", ["T"], [["value", T]], STRING, [], [
    "T",
  ]),
];

export const STD_BY_NAME: ReadonlyMap<string, Signature> = new Map(STD.map((s) => [s.name, s]));

// A std function on one line, for queries (`context`, `search`). Not alang
// syntax: std signatures have type parameters and function types, which the
// surface language cannot write yet.
export function signatureLine(s: Signature): string {
  const typeParams = s.typeParams.length === 0 ? "" : `<${s.typeParams.join(", ")}>`;
  const params = s.params.map((p) => `${p.name}: ${showType(p.type)}`).join(", ");
  const effects = s.effects.length === 0 ? "none" : s.effects.join(", ");
  return `fn ${s.name}${typeParams}(${params}): ${showType(s.out)}, effects: ${effects}, doc: ${printString(s.doc)}`;
}
