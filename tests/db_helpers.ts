// Shared fixtures for the database tests: the spec programs as single
// definitions, a function builder, and a fresh codebase per test.

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertEquals } from "./assert.ts";
import type { Definition } from "../src/ast.ts";
import { checkProgram } from "../src/check.ts";
import { type Change, Codebase, hashText, type SubmitResult } from "../src/codebase.ts";
import type { Diagnostic } from "../src/diagnostic.ts";
import { parseProgram } from "../src/parser.ts";
import { printDefinition, printSignature } from "../src/printer.ts";
import { dependencies } from "../src/refs.ts";

const spec = await Deno.readTextFile(new URL("../alang-specs.md", import.meta.url));
const specBlock = (firstLine: string): string => {
  const m = [...spec.matchAll(/^```\w*\n([\s\S]*?)^```$/gm)].find((m) => m[1].startsWith(firstLine + "\n"));
  if (!m) throw new Error(`spec block not found: ${firstLine}`);
  return m[1];
};
// The single definitions of a spec block, as canonical texts.
const texts = (source: string): string[] => parseProgram(source).map(printDefinition);

export const [PORT, PARSE_ERROR, PARSE] = texts(specBlock("type net.port.Port"));
export const [LOAD_PORT] = texts(specBlock("fn config.load_port"));
export const LOAD_ERROR = `type config.LoadError
  doc: "Why the configuration could not be loaded."
  variant:
    FileUnreadable: std.fs.Error
    InvalidPort: net.port.ParseError
  where: none
end type config.LoadError`;

// A function `<module>.<name>` with the given sections.
export function fn(
  name: string,
  o: { params?: string[]; out: string; effects?: string; examples?: string[]; body: string },
): string {
  const short = name.slice(name.lastIndexOf(".") + 1);
  return [
    `fn ${name}`,
    `  doc: "${short}."`,
    o.params ? ["  in:", ...o.params.map((p) => `    ${p}`)].join("\n") : "  in: none",
    `  out: ${o.out}`,
    `  effects: ${o.effects ?? "none"}`,
    "  requires: none",
    "  ensures: none",
    o.examples ? ["  examples:", ...o.examples.map((e) => `    ${e}`)].join("\n") : "  examples: none",
    "  body:",
    ...o.body.split("\n").map((l) => `    ${l}`),
    `end fn ${name}`,
  ].join("\n");
}

export const CLOCK = () => new Date("2026-11-12T10:00:00.000Z");

export async function fresh(): Promise<Codebase> {
  return await Codebase.open(await Deno.makeTempDir({ prefix: "alang-db-" }), { clock: CLOCK });
}

// Closes a test codebase after checking what it stored (see `invariants`).
export async function done(cb: Codebase): Promise<void> {
  invariants(cb);
  cb.close();
  await Deno.remove(cb.dir, { recursive: true });
}

export const add = (text: string): Change => ({ op: "add", text });

export async function ok(cb: Codebase, changes: Change[]): Promise<Extract<SubmitResult, { ok: true }>> {
  const r = await cb.submit(changes);
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics, null, 2));
  return r;
}

export async function fails(cb: Codebase, changes: Change[]): Promise<Extract<SubmitResult, { ok: false }>> {
  const r = await cb.submit(changes);
  if (r.ok) throw new Error(`expected a rejection, got ${JSON.stringify(r)}`);
  return r;
}

export const codes = (ds: readonly Diagnostic[]) => ds.map((d) => d.code);
// The hash of a stored definition (std entries have none).
export function hashOf(cb: Codebase, name: string): string {
  const { hash } = cb.definition(name);
  if (hash === null) throw new Error(`${name} has no hash`);
  return hash;
}

// Every row of every table, for "a rejected transaction changes nothing".
export function dump(cb: Codebase): Record<string, unknown[]> {
  const db = new DatabaseSync(join(cb.dir, "alang.db"), { readOnly: true });
  try {
    const all = (sql: string) => db.prepare(sql).all().map((r) => ({ ...r }));
    return {
      definitions: all("SELECT * FROM definitions ORDER BY hash"),
      names: all("SELECT * FROM names ORDER BY name"),
      refs: all("SELECT rowid, * FROM refs ORDER BY rowid"),
      history: all("SELECT * FROM history ORDER BY id"),
    };
  } finally {
    db.close();
  }
}

export async function withPort(): Promise<Codebase> {
  const cb = await fresh();
  await ok(cb, [PORT, PARSE_ERROR, PARSE, LOAD_PORT, LOAD_ERROR].map(add));
  return cb;
}

// The body of net.port.parse with its condition reordered: same behaviour.
export const PARSE_REORDERED = PARSE.replace("if n < 1 or n > 65_535 then", "if n > 65_535 or n < 1 then");

// What every database must satisfy, whatever happened to it:
// - every stored version is canonical text, and its hash, kind and
//   signature follow from that text;
// - the current program checks, and each current version's `refs` rows are
//   its dependencies in that program, in order of first use.
export function invariants(cb: Codebase): void {
  const t = dump(cb) as {
    definitions: { hash: string; kind: string; text: string; signature: string }[];
    names: { name: string; hash: string }[];
    refs: { from_hash: string; to_name: string }[];
  };
  const byHash = new Map<string, Definition>();
  for (const row of t.definitions) {
    const defs = parseProgram(row.text);
    assertEquals(defs.length, 1, row.text);
    assertEquals(printDefinition(defs[0]), row.text);
    assertEquals(hashText(row.text), row.hash);
    assertEquals(defs[0].kind, row.kind);
    assertEquals(printSignature(defs[0]), row.signature);
    byHash.set(row.hash, defs[0]);
  }
  const current = t.names.map((n) => byHash.get(n.hash)!);
  const { diagnostics, info } = checkProgram(current);
  assertEquals(diagnostics, []);
  for (const n of t.names) {
    const stored = t.refs.filter((r) => r.from_hash === n.hash).map((r) => r.to_name);
    assertEquals(stored, dependencies(byHash.get(n.hash)!, info), `refs of ${n.name}`);
  }
}
