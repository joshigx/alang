// The codebase as a database (section 6, Storage): one SQLite file holding
// every version of every definition, the current name pointers, who uses
// whom, and the history.
//
// A version's hash is a digest of its canonical text. References stay names,
// as written in the text; see docs/decisions.md (Database) for why this
// departs from 6.1's "references go through the hash".
//
// Every change goes through `submit`, a transaction of one or more changes
// that is accepted as a whole (6.3, 6.4) or leaves the database untouched.

import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Definition, Effect } from "./ast.ts";
import { pathText } from "./ast.ts";
import { closest } from "./check.ts";
import { AlangError, type Diagnostic, diagnostic } from "./diagnostic.ts";
import { casesOf, interfaceChange } from "./interface.ts";
import { parseProgram } from "./parser.ts";
import { printDefinition, printSignature } from "./printer.ts";
import { dependencies } from "./refs.ts";
import { acceptDefinitions, type Accepted } from "./toolchain.ts";

// ---- data ----

export type Operation = "add" | "replace" | "remove" | "rename" | "follow" | "import";

export type Change =
  | { readonly op: "add"; readonly text: string }
  | { readonly op: "replace"; readonly name: string; readonly hash: string; readonly text: string }
  | { readonly op: "remove"; readonly name: string; readonly hash: string };

// A definition as a query returns it.
export interface Version {
  readonly name: string;
  readonly hash: string;
  readonly text: string;
}

export interface Written {
  readonly name: string;
  // Null for a removal.
  readonly hash: string | null;
  readonly operation: Operation;
}

export type SubmitResult =
  | {
    readonly ok: true;
    readonly written: readonly Written[];
    // Replaced by the very same text: accepted, nothing written.
    readonly unchanged: readonly string[];
  }
  | {
    readonly ok: false;
    readonly diagnostics: readonly Diagnostic[];
    // The current versions behind a stale hash (E0501) or an existing name
    // (E0503), so the caller can retry without another query (6.7).
    readonly current: readonly Version[];
  };

export const HASH_LENGTH = 16;

// The hash of a version: sha-256 of its canonical text, hex, shortened.
export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, HASH_LENGTH);
}

// `definitions`, `names` and `history` are primary; `refs` and
// `definitions.signature` are derived from the text. `refs.to_name` is the
// full name a version refers to (a variant case by its own name), inserted in
// text order so that rowid order is first-use order.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS definitions (
  hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('fn', 'type')),
  text TEXT NOT NULL,
  signature TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS names (
  name TEXT PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE REFERENCES definitions (hash)
);
CREATE TABLE IF NOT EXISTS refs (
  from_hash TEXT NOT NULL REFERENCES definitions (hash),
  to_name TEXT NOT NULL,
  PRIMARY KEY (from_hash, to_name)
);
CREATE INDEX IF NOT EXISTS refs_to_name ON refs (to_name);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  hash TEXT REFERENCES definitions (hash),
  changed_at TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('add', 'replace', 'remove', 'rename', 'follow', 'import')),
  other_name TEXT
);
CREATE INDEX IF NOT EXISTS history_name ON history (name);
`;

interface Current {
  readonly name: string;
  readonly hash: string;
  readonly text: string;
  readonly def: Definition;
}

// A change that passed its own checks, ready to be applied.
interface Planned {
  readonly op: "add" | "replace" | "remove";
  readonly name: string;
  readonly at: string;
  // Null for a removal.
  readonly def: Definition | null;
  // The hash the database must still hold for `name`; null for an add.
  readonly guard: string | null;
}

// A version to store.
interface Row {
  readonly name: string;
  readonly op: "add" | "replace";
  readonly hash: string;
  readonly kind: "fn" | "type";
  readonly text: string;
  readonly signature: string;
  readonly refs: readonly string[];
}

export interface OpenOptions {
  // Source of `history.changed_at`; tests pass a fixed clock.
  readonly clock?: () => Date;
}

const RETRIES = 3;

function operationText(change: Change, name: string | null): string {
  switch (change.op) {
    case "add":
      return `add(${name ?? "..."})`;
    case "replace":
    case "remove":
      return `${change.op}(${change.name}, ${change.hash})`;
  }
}

function list(names: Iterable<string>): string {
  return [...names].map((n) => `\`${n}\``).join(", ");
}

function rejected(diagnostics: readonly Diagnostic[], current: readonly Version[] = []): SubmitResult {
  return { ok: false, diagnostics, current };
}

// ---- the codebase ----

export class Codebase {
  // Submits run one at a time: acceptance writes one file in `out/`.
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly dir: string,
    private readonly db: DatabaseSync,
    private readonly clock: () => Date,
  ) {}

  // Opens (or creates) the codebase in `dir`: `dir/alang.db`, with generated
  // TypeScript in `dir/out/`.
  static async open(dir: string, options: OpenOptions = {}): Promise<Codebase> {
    await Deno.mkdir(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, "alang.db"));
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(SCHEMA);
    return new Codebase(dir, db, options.clock ?? (() => new Date()));
  }

  close(): void {
    this.db.close();
  }

  private get acceptPath(): string {
    return join(this.dir, "out", "accept.ts");
  }

  // ---- reading ----

  private snapshot(): Map<string, Current> {
    const rows = this.db.prepare(
      "SELECT n.name, n.hash, d.text FROM names n JOIN definitions d ON d.hash = n.hash ORDER BY n.name",
    ).all() as { name: string; hash: string; text: string }[];
    return new Map(rows.map((r) => [r.name, { ...r, def: parseProgram(r.text)[0] }]));
  }

  private names(): Map<string, string> {
    const rows = this.db.prepare("SELECT name, hash FROM names ORDER BY name").all() as {
      name: string;
      hash: string;
    }[];
    return new Map(rows.map((r) => [r.name, r.hash]));
  }

  private unknownName(name: string, at: string): Diagnostic {
    const near = closest(name, this.names().keys());
    return diagnostic({
      code: "E0502",
      definition: name,
      at,
      message: `There is no definition \`${name}\`.` + (near ? ` Did you mean \`${near}\`?` : ""),
      fix: near ? { replace: name, with: near } : null,
    });
  }

  // The current version of `name`; throws E0502 if there is none.
  definition(name: string): Version {
    const row = this.db.prepare(
      "SELECT n.hash, d.text FROM names n JOIN definitions d ON d.hash = n.hash WHERE n.name = ?",
    ).get(name) as { hash: string; text: string } | undefined;
    if (!row) throw new AlangError(this.unknownName(name, `definition(${name})`));
    return { name, hash: row.hash, text: row.text };
  }

  // The definitions that use `name`, sorted, with the hash of `name` read.
  callers(name: string): { name: string; hash: string; callers: string[] } {
    const { hash, text } = this.definition(name);
    return { name, hash, callers: this.callersOf(name, parseProgram(text)[0]) };
  }

  // Current definitions that refer to `name` (or, for a variant type, to one
  // of its cases), sorted, without `name` itself.
  private callersOf(name: string, def: Definition): string[] {
    const targets = [name, ...casesOf(def)];
    const rows = this.db.prepare(
      `SELECT DISTINCT n.name FROM refs r JOIN names n ON n.hash = r.from_hash
       WHERE r.to_name IN (${targets.map(() => "?").join(", ")}) AND n.name <> ? ORDER BY n.name`,
    ).all(...targets, name) as { name: string }[];
    return rows.map((r) => r.name);
  }

  // ---- changing ----

  // Applies `changes` as one transaction (6.3, 6.4): all of them, or none.
  submit(changes: readonly Change[]): Promise<SubmitResult> {
    const run = this.queue.then(() => this.apply(changes));
    this.queue = run.catch(() => {});
    return run;
  }

  private async apply(changes: readonly Change[], attempt = 1): Promise<SubmitResult> {
    const current = this.snapshot();

    // 1. Each change on its own: one definition per text, the guards.
    const planned: Planned[] = [];
    const diagnostics: Diagnostic[] = [];
    const shown: Version[] = [];
    const touched = new Set<string>();
    for (const change of changes) {
      const p = this.plan(change, current, touched, diagnostics, shown);
      if (p) planned.push(p);
    }
    if (diagnostics.length > 0) return rejected(diagnostics, shown);

    // 2. The program after the transaction.
    const next = new Map([...current].map(([name, c]) => [name, c.def]));
    for (const p of planned) {
      if (p.def) next.set(p.name, p.def);
      else next.delete(p.name);
    }

    // 3. Callers outside the transaction must not be broken by it.
    const members = new Set(planned.map((p) => p.name));
    for (const p of planned) diagnostics.push(...this.callerRule(p, current, members));
    if (diagnostics.length > 0) return rejected(diagnostics);

    // 4. Acceptance of the whole resulting program (6.3). It re-runs every
    // example, so a caller whose example a changed body breaks is reported.
    const defs = [...next.keys()].sort().map((name) => next.get(name)!);
    let accepted: Accepted;
    try {
      accepted = await acceptDefinitions(defs, this.acceptPath);
    } catch (e) {
      if (e instanceof AlangError) return rejected(e.diagnostics);
      throw e;
    }

    // 5. Rows from the accepted trees: their check info is keyed by node.
    const rows: Row[] = [];
    const unchanged: string[] = [];
    for (const p of planned) {
      if (p.op === "remove" || !p.def) continue;
      const text = printDefinition(p.def);
      const hash = hashText(text);
      if (p.op === "replace" && hash === p.guard) {
        unchanged.push(p.name);
        continue;
      }
      const refs = dependencies(p.def, accepted.built.info);
      rows.push({ name: p.name, op: p.op, hash, kind: p.def.kind, text, signature: printSignature(p.def), refs });
    }

    // 6. One SQLite transaction. Another process may have written since the
    // snapshot; then the accepted program is not what would be stored, so
    // start over (its guards then report what changed).
    const changedAt = this.clock().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = this.names();
      if (now.size !== current.size || [...current].some(([name, c]) => now.get(name) !== c.hash)) {
        this.db.exec("ROLLBACK");
        if (attempt >= RETRIES) throw new Error("The codebase keeps changing during acceptance.");
        return await this.apply(changes, attempt + 1);
      }
      const history = this.db.prepare(
        "INSERT INTO history (name, hash, changed_at, operation, other_name) VALUES (?, ?, ?, ?, NULL)",
      );
      for (const row of rows) {
        this.store(row);
        this.db.prepare("INSERT OR REPLACE INTO names (name, hash) VALUES (?, ?)").run(row.name, row.hash);
        history.run(row.name, row.hash, changedAt, row.op);
      }
      for (const p of planned) {
        if (p.op !== "remove") continue;
        this.db.prepare("DELETE FROM names WHERE name = ?").run(p.name);
        history.run(p.name, null, changedAt, "remove");
      }
      this.db.exec("COMMIT");
    } catch (e) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw e;
    }
    const written = planned.flatMap((p): Written[] => {
      if (p.op === "remove") return [{ name: p.name, hash: null, operation: p.op }];
      const row = rows.find((r) => r.name === p.name);
      return row ? [{ name: p.name, hash: row.hash, operation: p.op }] : [];
    });
    return { ok: true, written, unchanged };
  }

  // Checks one change on its own; pushes its diagnostics and returns null if
  // it fails.
  private plan(
    change: Change,
    current: ReadonlyMap<string, Current>,
    touched: Set<string>,
    diagnostics: Diagnostic[],
    shown: Version[],
  ): Planned | null {
    let def: Definition | null = null;
    if (change.op !== "remove") {
      let defs: Definition[];
      try {
        defs = parseProgram(change.text);
      } catch (e) {
        if (!(e instanceof AlangError)) throw e;
        diagnostics.push(...e.diagnostics);
        return null;
      }
      if (defs.length !== 1) {
        const found = defs.length === 0 ? "none" : list(defs.map((d) => pathText(d.path)));
        diagnostics.push(diagnostic({
          code: "E0504",
          definition: change.op === "replace" ? change.name : null,
          at: operationText(change, change.op === "replace" ? change.name : null),
          message: `\`${change.op}\` takes the text of exactly one definition; this text defines ${found}.`,
        }));
        return null;
      }
      def = defs[0];
    }

    const name = change.op === "add" ? pathText(def!.path) : change.name;
    const at = operationText(change, name);
    if (touched.has(name)) {
      diagnostics.push(diagnostic({
        code: "E0508",
        definition: name,
        at,
        message: `\`${name}\` is changed twice in this transaction; submit one change per name.`,
      }));
      return null;
    }
    touched.add(name);

    const cur = current.get(name);
    if (change.op === "add") {
      if (cur) {
        diagnostics.push(diagnostic({
          code: "E0503",
          definition: name,
          at,
          message: `\`${name}\` already exists; use \`replace\` with its hash (under \`current\`) to change it.`,
        }));
        shown.push({ name, hash: cur.hash, text: cur.text });
        return null;
      }
      return { op: "add", name, at, def, guard: null };
    }

    if (!cur) {
      diagnostics.push(this.unknownName(name, at));
      return null;
    }
    if (cur.hash !== change.hash) {
      diagnostics.push(diagnostic({
        code: "E0501",
        definition: name,
        at,
        message: `\`${name}\` has changed since hash \`${change.hash}\` was read; its current version is ` +
          "under `current`.",
        fix: { replace: change.hash, with: cur.hash },
      }));
      shown.push({ name, hash: cur.hash, text: cur.text });
      return null;
    }
    // The name also fixes the kind: functions are snake_case, types PascalCase.
    if (change.op === "replace" && def && pathText(def.path) !== name) {
      diagnostics.push(diagnostic({
        code: "E0505",
        definition: name,
        at,
        message: `The text defines \`${pathText(def.path)}\`, not \`${name}\`; \`replace\` keeps the name of a ` +
          "definition.",
        expected: `${cur.def.kind} ${name}`,
      }));
      return null;
    }
    return { op: change.op, name, at, def, guard: change.hash };
  }

  // The rules that protect callers outside the transaction: a replace may not
  // change the interface they use (E0506), and a remove may not take away a
  // definition they use (E0507).
  private callerRule(p: Planned, current: ReadonlyMap<string, Current>, members: ReadonlySet<string>): Diagnostic[] {
    if (p.op === "add") return [];
    const before = current.get(p.name)!.def;
    const outside = (names: Iterable<string>) => [...names].filter((n) => !members.has(n));

    if (p.op === "remove") {
      const callers = outside(this.callersOf(p.name, before));
      if (callers.length === 0) return [];
      return [diagnostic({
        code: "E0507",
        definition: p.name,
        at: p.at,
        message: `\`${p.name}\` is still used by ${list(callers)}. Remove or change them in the same transaction.`,
      })];
    }

    const change = interfaceChange(before, p.def!);
    const affected = new Set<string>();
    if (change.sections.length > 0) { for (const c of outside(this.callersOf(p.name, before))) affected.add(c); }
    if (change.addedEffects.length > 0) {
      for (const c of this.lackingEffects(p.name, before, change.addedEffects, current, members)) affected.add(c);
    }
    if (affected.size === 0) return [];
    const what = [
      ...(change.sections.length > 0 ? [`changes its ${list(change.sections)} section`] : []),
      ...(change.addedEffects.length > 0 ? [`adds the effects ${list(change.addedEffects)}`] : []),
    ].join(" and ");
    return [diagnostic({
      code: "E0506",
      definition: p.name,
      at: p.at,
      message: `\`${p.name}\` ${what}, which affects ${list([...affected].sort())}. ` +
        "Submit them, adapted, in the same transaction (6.4).",
    })];
  }

  // Callers that would have to declare `effects` once `name` does: direct
  // callers that lack one of them, and in turn their callers. The walk stops
  // at callers that declare them all and at members of the transaction. A
  // type's `where` that calls `name` is listed, but has no callers to follow.
  private lackingEffects(
    name: string,
    def: Definition,
    effects: readonly Effect[],
    current: ReadonlyMap<string, Current>,
    members: ReadonlySet<string>,
  ): string[] {
    const found: string[] = [];
    const seen = new Set([name]);
    const queue: [string, Definition][] = [[name, def]];
    while (queue.length > 0) {
      const [n, d] = queue.shift()!;
      for (const caller of this.callersOf(n, d)) {
        if (seen.has(caller) || members.has(caller)) continue;
        seen.add(caller);
        const cd = current.get(caller)!.def;
        if (cd.kind === "fn" && effects.every((e) => cd.effects.includes(e))) continue;
        found.push(caller);
        if (cd.kind === "fn") queue.push([caller, cd]);
      }
    }
    return found;
  }

  // Stores a version unless it exists. Equal hashes must mean equal texts.
  private store(row: Row): void {
    const existing = this.db.prepare("SELECT text FROM definitions WHERE hash = ?").get(row.hash) as
      | { text: string }
      | undefined;
    if (existing) {
      if (existing.text !== row.text) throw new Error(`Hash collision on ${row.hash}.`);
      return;
    }
    this.db.prepare("INSERT INTO definitions (hash, kind, text, signature) VALUES (?, ?, ?, ?)").run(
      row.hash,
      row.kind,
      row.text,
      row.signature,
    );
    const ref = this.db.prepare("INSERT OR IGNORE INTO refs (from_hash, to_name) VALUES (?, ?)");
    for (const to of row.refs) ref.run(row.hash, to);
  }
}
