// The code blocks of the specification are the first test cases. Every
// complete definition must parse, and its canonical print must reproduce the
// block byte for byte, since the spec is written in canonical form.

import { assertEquals, assertThrows } from "./assert.ts";
import { parseProgram, parseStatements } from "../src/parser.ts";
import { printProgram, printStmts } from "../src/printer.ts";
import { AlangError } from "../src/diagnostic.ts";

const spec = await Deno.readTextFile(new URL("../alang-specs.md", import.meta.url));

interface Block {
  readonly lang: string;
  readonly text: string;
}

function codeBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const re = /^```(\w*)\n([\s\S]*?)^```$/gm;
  for (const m of markdown.matchAll(re)) blocks.push({ lang: m[1], text: m[2].replace(/\n$/, "") });
  return blocks;
}

const blocks = codeBlocks(spec).filter((b) => b.lang === "");
const firstWord = (b: Block) => b.text.trimStart().split(/\s/, 1)[0];
const definitionBlocks = blocks.filter((b) => firstWord(b) === "fn" || firstWord(b) === "type");
const letBlocks = blocks.filter((b) => firstWord(b) === "let");
// A `let` block that ends in an open call is the prefix example of rule 1.6.
const prefixBlocks = letBlocks.filter((b) => b.text.trimEnd().endsWith("("));
const statementBlocks = letBlocks.filter((b) => !prefixBlocks.includes(b));

Deno.test("spec: block inventory", () => {
  // Guards against blocks silently dropping out of the test set.
  assertEquals(definitionBlocks.length, 4);
  assertEquals(definitionBlocks.map((b) => parseProgram(b.text).length).reduce((a, b) => a + b), 6);
  assertEquals(statementBlocks.length, 2);
  assertEquals(prefixBlocks.length, 1);
});

for (const block of definitionBlocks) {
  const name = block.text.split("\n", 1)[0];
  Deno.test(`spec: ${name} prints canonically and round-trips`, () => {
    const tree = parseProgram(block.text);
    const printed = printProgram(tree);
    assertEquals(printed, block.text + "\n");
    assertEquals(parseProgram(printed), tree);
  });
}

for (const block of statementBlocks) {
  Deno.test(`spec: fragment \`${block.text.split("\n", 1)[0].slice(0, 40)}\` round-trips`, () => {
    const tree = parseStatements(block.text);
    const printed = printStmts(tree, "");
    assertEquals(printed, block.text);
    assertEquals(parseStatements(printed), tree);
  });
}

Deno.test("spec: the 1.6 prefix is not a complete program", () => {
  for (const block of prefixBlocks) assertThrows(() => parseStatements(block.text), AlangError);
});
