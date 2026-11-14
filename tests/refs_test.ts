// References resolved to full names (src/refs.ts), on the spec programs.
// They feed the database's `refs` table and the rewriting done by `rename`.

import { assertEquals } from "./assert.ts";
import type { Definition } from "../src/ast.ts";
import { pathText } from "../src/ast.ts";
import { checkProgram } from "../src/check.ts";
import { parseProgram } from "../src/parser.ts";
import { printDefinition } from "../src/printer.ts";
import { dependencies, mapReferences, references } from "../src/refs.ts";

const spec = await Deno.readTextFile(new URL("../alang-specs.md", import.meta.url));
const specBlock = (firstLine: string): string => {
  const m = [...spec.matchAll(/^```\w*\n([\s\S]*?)^```$/gm)].find((m) => m[1].startsWith(firstLine + "\n"));
  if (!m) throw new Error(`spec block not found: ${firstLine}`);
  return m[1];
};

const SOURCE = specBlock("type net.port.Port") + "\n" + specBlock("fn config.load_port") + `
type config.LoadError
  doc: "Why the configuration could not be loaded."
  variant:
    FileUnreadable: std.fs.Error
    InvalidPort: net.port.ParseError
  where: none
end type config.LoadError
`;

const defs = parseProgram(SOURCE);
const { diagnostics, info } = checkProgram(defs);
const byName = (name: string): Definition => defs.find((d) => pathText(d.path) === name)!;

Deno.test("refs: the spec programs check", () => {
  assertEquals(diagnostics, []);
});

Deno.test("refs: dependencies in order of first use, cases by their own name", () => {
  assertEquals(dependencies(byName("net.port.parse"), info), [
    "net.port.Port",
    "net.port.ParseError",
    "net.port.parse", // its examples call it
    "net.port.OutOfRange",
    "net.port.NotANumber",
    "std.int.parse",
  ]);
  assertEquals(dependencies(byName("config.load_port"), info), [
    "net.port.Port",
    "config.LoadError",
    "std.fs.read_text",
    "config.FileUnreadable",
    "std.string.trim",
    "net.port.parse",
    "config.InvalidPort",
  ]);
  assertEquals(dependencies(byName("config.LoadError"), info), ["std.fs.Error", "net.port.ParseError"]);
  assertEquals(dependencies(byName("net.port.Port"), info), []);
});

Deno.test("refs: references keep duplicates and kinds", () => {
  const refs = references(byName("config.load_port"), info);
  assertEquals(refs.filter((r) => r.full === "net.port.Port").length, 2);
  assertEquals(refs.find((r) => r.full === "config.InvalidPort")?.kind, "case");
  assertEquals(refs.find((r) => r.full === "net.port.parse")?.kind, "fn");
});

Deno.test("refs: mapReferences with identity targets reprints the same text", () => {
  for (const def of defs) assertEquals(printDefinition(mapReferences(def, info, (r) => r.full)), printDefinition(def));
});

Deno.test("refs: moving a definition rewrites its references from the new module", () => {
  const parse = byName("net.port.parse");
  const target = (r: { full: string }) => (r.full === "net.port.parse" ? "net.read" : r.full);
  const moved = printDefinition(mapReferences(parse, info, target, ["net", "read"]));
  assertEquals(
    moved.split("\n").slice(0, 5).join("\n"),
    'fn net.read\n  doc: "Reads a TCP port number from decimal text."\n  in:\n    text: String\n  out: Result<net.port.Port, net.port.ParseError>',
  );
  assertEquals(moved.includes('read(text: "0") == Err(net.port.OutOfRange(0))'), true);
  assertEquals(moved.includes("return Ok(net.port.Port(value: n))"), true);
  assertEquals(moved.endsWith("end fn net.read"), true);
  // A caller in another module keeps its spelling style: full name.
  const caller = printDefinition(mapReferences(byName("config.load_port"), info, target));
  assertEquals(caller.includes("net.read(text: trimmed)"), true);
});

// A function called only in a propagation statement (T1).
const PROPAGATING = `fn checks.positive
  doc: "Whether a number is positive."
  in:
    n: Int
  out: Result<Unit, String>
  effects: none
  requires: none
  ensures: none
  examples:
    positive(n: 1) == Ok(Unit)
  body:
    if n < 1 then
      return Err("not positive")
    end if
    return Ok(Unit)
end fn checks.positive

fn sizes.area
  doc: "The area of a rectangle of positive sides."
  in:
    width: Int
    height: Int
  out: Result<Int, String>
  effects: none
  requires: none
  ensures: none
  examples:
    area(width: 2, height: 3) == Ok(6)
  body:
    checks.positive(n: width) else return Err(error)
    return Ok(width * height)
end fn sizes.area`;

Deno.test("refs: a call in a propagation statement is a reference and is rewritten", () => {
  const program = parseProgram(PROPAGATING);
  const checked = checkProgram(program);
  assertEquals(checked.diagnostics, []);
  const area = program.find((d) => pathText(d.path) === "sizes.area")!;
  assertEquals(dependencies(area, checked.info), ["sizes.area", "checks.positive"]);
  const target = (r: { full: string }) => (r.full === "checks.positive" ? "checks.above_zero" : r.full);
  const renamed = printDefinition(mapReferences(area, checked.info, target));
  assertEquals(renamed.includes("    checks.above_zero(n: width) else return Err(error)\n"), true);
});
