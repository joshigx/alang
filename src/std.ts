// Signatures of the standard library. Each entry has an implementation in
// runtime.ts under its mangled name (`std.int.parse` -> `std$int$parse`);
// a test keeps the two in sync.

import type { Definition, Effect } from "./ast.ts";
import { parseProgram } from "./parser.ts";
import { BOOL, con, FLOAT, fnType, INT, list, option, ORDER, result, STRING, tvar, type Type, UNIT } from "./types.ts";

// Types of the standard library, written in alang. runtime.ts has the
// matching TypeScript type under the mangled name (`std$fs$ReadError`).
export const STD_TYPES_SOURCE = `type std.fs.ReadError
  doc: "Why a file could not be read."
  variant:
    NotFound
    PermissionDenied
    IsADirectory
    Other: String
  where: none
end type std.fs.ReadError
`;

export const STD_TYPES: readonly Definition[] = parseProgram(STD_TYPES_SOURCE);

export interface Signature {
  readonly name: string;
  readonly typeParams: readonly string[];
  readonly params: readonly { readonly name: string; readonly type: Type }[];
  readonly out: Type;
  readonly effects: readonly Effect[];
  readonly doc: string;
}

const T = tvar("T");
const U = tvar("U");
const A = tvar("A");

function sig(
  name: string,
  doc: string,
  typeParams: string[],
  params: [string, Type][],
  out: Type,
  effects: Effect[] = [],
): Signature {
  return { name, doc, typeParams, params: params.map(([name, type]) => ({ name, type })), out, effects };
}

export const STD: readonly Signature[] = [
  sig("std.console.print_line", "Writes a line to the console.", [], [["text", STRING]], UNIT, ["console"]),

  sig(
    "std.fs.read_text",
    "Reads a whole file as UTF-8 text.",
    [],
    [["path", STRING]],
    result(STRING, con("std.fs.ReadError")),
    ["fs.read"],
  ),

  sig("std.int.parse", "Reads a decimal integer; `None` if the text is not one.", [], [["text", STRING]], option(INT)),
  sig("std.int.to_float", "The same number as a Float.", [], [["value", INT]], FLOAT),
  sig("std.int.compare", "Orders two integers.", [], [["left", INT], ["right", INT]], ORDER),

  sig("std.float.floor", "The largest integer not above the value; traps outside the Int range.", [], [[
    "value",
    FLOAT,
  ]], INT),

  sig("std.string.trim", "Removes leading and trailing whitespace.", [], [["text", STRING]], STRING),
  sig("std.string.length", "Number of Unicode scalar values.", [], [["text", STRING]], INT),
  sig("std.string.concat", "The two texts joined.", [], [["left", STRING], ["right", STRING]], STRING),
  sig("std.string.join", "The parts joined with the separator between them.", [], [
    ["parts", list(STRING)],
    ["separator", STRING],
  ], STRING),
  sig("std.string.compare", "Orders two texts by Unicode scalar values.", [], [["left", STRING], [
    "right",
    STRING,
  ]], ORDER),

  sig("std.list.empty", "The empty list.", ["T"], [], list(T)),
  sig("std.list.append", "The list with the item added at the end.", ["T"], [["list", list(T)], ["item", T]], list(T)),
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

  sig("std.text.show", "Text representation of any value without functions.", ["T"], [["value", T]], STRING),
];

export const STD_BY_NAME: ReadonlyMap<string, Signature> = new Map(STD.map((s) => [s.name, s]));
