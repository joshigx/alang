// Shared fixtures for the database tests: the spec programs as single
// definitions, a function builder, and a fresh codebase per test.

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Change, Codebase, type SubmitResult } from "../src/codebase.ts";
import type { Diagnostic } from "../src/diagnostic.ts";
import { parseProgram } from "../src/parser.ts";
import { printDefinition } from "../src/printer.ts";

const spec = await Deno.readTextFile(new URL("../alang-specs.md", import.meta.url));
const specBlock = (firstLine: string): string => {
  const m = [...spec.matchAll(/^```\n([\s\S]*?)^```$/gm)].find((m) => m[1].startsWith(firstLine + "\n"));
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
    FileUnreadable: std.fs.ReadError
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

export async function done(cb: Codebase): Promise<void> {
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
export const hashOf = (cb: Codebase, name: string) => cb.definition(name).hash;

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
