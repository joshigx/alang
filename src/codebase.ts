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
// After each transaction the export (`export/<module>.alang`, canonical text
// for Git and review) of the affected modules is rewritten; `importAll`
// rebuilds the database from it, and `sync` keeps the two in step when Git
// changes the files.

import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Definition, Effect, FnDef, TypeDef, TypeRef } from "./ast.ts";
import { moduleOf, pathText } from "./ast.ts";
import { checkProgram, type CheckResult, closest } from "./check.ts";
import { AlangError, type Diagnostic, diagnostic } from "./diagnostic.ts";
import { casesOf, interfaceChange } from "./interface.ts";
import { parseProgram } from "./parser.ts";
import { printDefinition, printExpr, printSignature, printString } from "./printer.ts";
import { applyOwnFixes, dependencies, mapReferences, type Ref } from "./refs.ts";
import { matchesFn, namedTypes, parseFnPattern, showTree, treeOfRef, treeOfType, type TypeTree } from "./search.ts";
import { signatureHead, signatureLine, STD, STD_BY_NAME, STD_TYPES } from "./std.ts";
import { acceptDefinitions, type Accepted, findMain, run as runBuilt, type RunOptions } from "./toolchain.ts";
import { BUILTIN_TYPES, type Type } from "./types.ts";

// ---- data ----

export type Operation = "add" | "replace" | "remove" | "rename" | "follow" | "import";

export type Change =
  | { readonly op: "add"; readonly text: string }
  | { readonly op: "replace"; readonly name: string; readonly hash: string; readonly text: string }
  | { readonly op: "remove"; readonly name: string; readonly hash: string }
  // With `text`, the definition is changed too: the text is its new version,
  // under the new name.
  | {
    readonly op: "rename";
    readonly name: string;
    readonly hash: string;
    readonly to: string;
    readonly text?: string;
  };

// The string fields of each change; a rename may also have "text".
const CHANGE_FIELDS: Record<Change["op"], readonly string[]> = {
  add: ["text"],
  replace: ["name", "hash", "text"],
  remove: ["name", "hash"],
  rename: ["name", "hash", "to"],
};

// The changes of a transaction as JSON (`alang db submit`, the MCP tool
// `submit`): an array of objects such as `{"op": "add", "text": ...}`. Throws
// an Error naming the first malformed change.
export function parseChanges(json: unknown): Change[] {
  if (!Array.isArray(json)) throw new Error("submit takes a JSON array of changes.");
  return json.map((c, i) => {
    const op = c?.op as Change["op"];
    const needed = Object.hasOwn(CHANGE_FIELDS, op) ? CHANGE_FIELDS[op] : null;
    const fields = needed && (op === "rename" && c.text !== undefined ? [...needed, "text"] : needed);
    if (!fields || !fields.every((f) => typeof c[f] === "string")) {
      throw new Error(
        `submit: change ${i} is not one of ${JSON.stringify(CHANGE_FIELDS)} with string fields ` +
          '(a rename may add "text").',
      );
    }
    return Object.fromEntries([["op", op], ...fields.map((f) => [f, c[f]])]) as Change;
  });
}

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
    // Diagnostics whose fix the codebase applied itself (E0226 and E0235,
    // see `withOwnFixes`); only present if there are any. Where they point, the
    // stored text differs from the text sent.
    readonly fixed?: readonly Diagnostic[];
  }
  | {
    readonly ok: false;
    readonly diagnostics: readonly Diagnostic[];
    // The current versions behind a stale hash (E0501) or an existing name
    // (E0503), so the caller can retry without another query (6.7).
    readonly current: readonly Version[];
  };

export type SyncResult =
  | {
    readonly ok: true;
    // Modules whose file was rewritten from the database.
    readonly exported: readonly string[];
    // Names the export changed in the database.
    readonly imported: readonly Written[];
  }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export type ExportResult =
  | { readonly ok: true; readonly files: readonly string[] }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

// A definition as `context` lists what it uses: a signature, or a std entry
// (hash null).
export interface Used {
  readonly name: string;
  readonly hash: string | null;
  readonly text: string;
}

// An entry of `list` and `search`; std entries have no hash. Each carries its
// signature on one line without the doc, so that a listing shows how to call
// each function and build or match each type without a `context` call per
// name: a function's line is `fn name(params): Out, effects: ...`, the line
// `search_type` gives up to its doc; a type's mirrors its sections, `type
// name, record: field: T, ...` or `type name, variant: A | B: T`, and adds
// `, where: ...` unless the where is `none`.
export interface Hit {
  readonly name: string;
  readonly hash: string | null;
  readonly kind: Definition["kind"];
  readonly signature: string;
  readonly doc: string;
}

export interface HistoryEntry {
  readonly name: string;
  // Null for a removal, and for the old name of a rename.
  readonly hash: string | null;
  readonly changed_at: string;
  readonly operation: Operation;
  // The other name of a rename.
  readonly other_name: string | null;
}

export const HASH_LENGTH = 16;

// The hash of a version: sha-256 of its canonical text, hex, shortened.
export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, HASH_LENGTH);
}

// `definitions`, `names` and `history` are primary; `refs` and
// `definitions.signature` are derived from the text. `refs.to_name` is the
// full name a version refers to (a variant case by its own name), inserted in
// text order so that rowid order is first-use order. `export_files` holds,
// per module, the hash of what its export file held when the codebase last
// wrote or read it, which tells which side changed when file and database
// differ (see `sync`).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS definitions (
  hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('fn', 'type', 'const')),
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
CREATE TABLE IF NOT EXISTS export_files (
  module TEXT PRIMARY KEY,
  hash TEXT NOT NULL
);
`;

interface Current {
  readonly name: string;
  readonly hash: string;
  readonly text: string;
  readonly def: Definition;
}

// A change that passed its own checks, ready to be applied.
interface Planned {
  readonly op: "add" | "replace" | "remove" | "rename";
  readonly name: string;
  readonly at: string;
  // The submitted definition; null for a removal and a rename without text.
  readonly def: Definition | null;
  // The hash the database must still hold for `name`; null for an add.
  readonly guard: string | null;
  // The new name of a rename.
  readonly to: string | null;
}

// A definition rewritten by a rename: the renamed one under its new name, or
// a follower (a caller) under its own.
interface Rewritten {
  readonly from: string;
  readonly name: string;
  readonly def: Definition;
  readonly renamed: boolean;
  // Its dependencies before the rename, mapped through it: what it must
  // still refer to afterwards.
  readonly expected: ReadonlySet<string>;
}

// A version to store.
interface Row {
  readonly name: string;
  readonly op: Operation;
  // The old name of a rename.
  readonly other?: string;
  readonly hash: string;
  readonly kind: Definition["kind"];
  readonly text: string;
  readonly signature: string;
  readonly refs: readonly string[];
}

// A current definition as read from the tables.
interface Stored {
  readonly name: string;
  readonly hash: string;
  readonly kind: Definition["kind"];
  readonly text: string;
  readonly signature: string;
  readonly def: Definition;
}

// The types in the caller-facing part of a definition's signature: `in` and
// `out` of a function or a constant, the fields or case payloads of a type.
function signatureTypes(def: Definition): TypeTree[] {
  const module = moduleOf(def.path);
  if (def.kind === "fn") {
    const tree = (t: TypeRef) => treeOfRef(t, module, def.typeParams);
    return [...def.params.map((p) => tree(p.type)), tree(def.out)];
  }
  if (def.kind === "const") return [treeOfRef(def.out, module)];
  if (def.shape.kind === "record") return def.shape.fields.map((f) => treeOfRef(f.type, module));
  return def.shape.cases.flatMap((c) => (c.payload ? [treeOfRef(c.payload, module)] : []));
}

// A stored function's signature on one line without the doc, its types in
// full (as a caller outside its module writes them), its type parameters
// after the name: the stored counterpart of `signatureHead` (G15).
function storedHead(name: string, def: FnDef): string {
  const module = def.path.slice(0, -1);
  const full = (t: TypeRef) => showTree(treeOfRef(t, module, def.typeParams));
  const params = def.params.map((q) => `${q.name}: ${full(q.type)}`).join(", ");
  const effects = def.effects.length === 0 ? "none" : def.effects.join(", ");
  const letters = def.typeParams.length === 0 ? "" : `<${def.typeParams.join(", ")}>`;
  return `fn ${name}${letters}(${params}): ${full(def.out)}, effects: ${effects}`;
}

// A type's signature on one line without the doc, std and stored alike: its
// sections in order, field and case types in full as in `storedHead`, cases
// separated by `|`, and the where as the definition writes it (it reads the
// fields), left out when it is `none`. Types have no type parameters.
function typeHead(name: string, def: TypeDef): string {
  const module = moduleOf(def.path);
  const full = (t: TypeRef) => showTree(treeOfRef(t, module));
  const shape = def.shape.kind === "record"
    ? `record: ${def.shape.fields.map((f) => `${f.name}: ${full(f.type)}`).join(", ")}`
    : `variant: ${def.shape.cases.map((c) => (c.payload ? `${c.name}: ${full(c.payload)}` : c.name)).join(" | ")}`;
  return `type ${name}, ${shape}${def.where ? `, where: ${printExpr(def.where, "")}` : ""}`;
}

// The `list` and `search` entry of a stored definition; a constant's line is
// `const name: Type`, the type in full as in `storedHead` (C9).
function storedHit(r: Stored): Hit {
  const signature = r.def.kind === "fn"
    ? storedHead(r.name, r.def)
    : r.def.kind === "const"
    ? `const ${r.name}: ${showTree(treeOfRef(r.def.out, moduleOf(r.def.path)))}`
    : typeHead(r.name, r.def);
  return { name: r.name, hash: r.hash, kind: r.kind, signature, doc: r.def.doc };
}

// ---- the standard library in queries ----
//
// std is not stored in the database: its entries come from std.ts and have no
// hash. Queries read them like stored definitions; operations refuse them.

const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

const STD_TYPE_BY_NAME: ReadonlyMap<string, Definition> = new Map(STD_TYPES.map((d) => [pathText(d.path), d]));

const STD_HITS: readonly Hit[] = [
  ...STD.map((s): Hit => ({ name: s.name, hash: null, kind: "fn", signature: signatureHead(s), doc: s.doc })),
  ...STD_TYPES.map((d): Hit => {
    const name = pathText(d.path);
    return { name, hash: null, kind: "type", signature: typeHead(name, d as TypeDef), doc: d.doc };
  }),
].sort(byName);

interface StdEntry {
  // A type as alang text; a function as its signature on one line, since std
  // functions have no alang body (and some of their types no surface syntax).
  readonly text: string;
  // Full names of the types its signature mentions, in order of first use,
  // those of a function parameter included.
  readonly types: readonly string[];
  // The cases of a variant type, which callers use instead of the type.
  readonly cases: readonly string[];
}

function stdEntry(name: string): StdEntry | null {
  const fn = STD_BY_NAME.get(name);
  if (fn) {
    const types: string[] = [];
    for (const t of [...fn.params.map((p) => p.type), fn.out]) stdTypeNames(t, types);
    return { text: signatureLine(fn), types, cases: [] };
  }
  const type = STD_TYPE_BY_NAME.get(name);
  if (type) {
    const types: string[] = [];
    for (const t of signatureTypes(type)) namedTypes(t, types);
    return { text: printDefinition(type), types, cases: casesOf(type) };
  }
  return null;
}

// Full names of the non-builtin types in a std signature type, looking into
// function types too (`serve`'s handler takes a Request).
function stdTypeNames(t: Type, into: string[]): void {
  if (t.k === "con") {
    if (!BUILTIN_TYPES.has(t.name) && !into.includes(t.name)) into.push(t.name);
    for (const a of t.args) stdTypeNames(a, into);
  } else if (t.k === "fn") {
    for (const p of t.params) stdTypeNames(p, into);
    stdTypeNames(t.out, into);
  }
}

export interface OpenOptions {
  // Source of `history.changed_at`; tests pass a fixed clock.
  readonly clock?: () => Date;
  // Called during a submit once the program is accepted and once it is
  // committed; tests change export files there, as a pull would.
  readonly during?: (stage: "accepted" | "committed") => Promise<void> | void;
}

const RETRIES = 3;

// Codebases opened by this process, for unique acceptance files.
let opened = 0;

function operationText(change: Change, name: string | null): string {
  switch (change.op) {
    case "add":
      return `add(${name ?? "..."})`;
    case "replace":
    case "remove":
      return `${change.op}(${change.name}, ${change.hash})`;
    case "rename":
      return `rename(${change.name}, ${change.hash}, ${change.to})`;
  }
}

// The name an add's text gives in its first line (`fn net.port.parse`,
// `type net.port.Port`, `const shop.sizes`), read without the lexer, which may
// be what failed; null if that line is not such a header.
function headerName(text: string): string | null {
  const first = text.trimStart().split("\n", 1)[0];
  return /^(?:fn|type|const) ([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?:<[^>]*>)?\s*$/.exec(first)?.[1] ?? null;
}

function list(names: Iterable<string>): string {
  return [...names].map((n) => `\`${n}\``).join(", ");
}

function rejected(diagnostics: readonly Diagnostic[], current: readonly Version[] = []): SubmitResult {
  return { ok: false, diagnostics, current };
}

// The file a database handle has open, so that a long-running server notices
// when `alang.db` is moved, deleted or replaced under it. `ino` is null where
// the host has none (Windows); then only a missing file counts.
interface FileId {
  readonly dev: number;
  readonly ino: number | null;
}

function openDatabase(path: string): { db: DatabaseSync; file: FileId } {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  migrateKinds(db);
  const { dev, ino } = Deno.statSync(path);
  return { db, file: { dev, ino } };
}

// The definitions table as it is created today (in SCHEMA), under a name to
// copy into.
const DEFINITIONS_NEW = `CREATE TABLE definitions_new (
  hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('fn', 'type', 'const')),
  text TEXT NOT NULL,
  signature TEXT NOT NULL
)`;

const definitionsSql = (db: DatabaseSync): string =>
  (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'definitions'").get() as { sql: string })
    .sql;

// A database made before constants (C11) checks `kind IN ('fn', 'type')`,
// which `CREATE TABLE IF NOT EXISTS` never changes, so it would refuse every
// constant. It is migrated on open by SQLite's procedure for changes that
// ALTER TABLE cannot make: a new table, the rows copied, the old one dropped
// and the new one renamed, with foreign keys off (they cannot change inside a
// transaction) and checked before the commit. Every row and the history are
// kept; only the CHECK widens. Another process may migrate at the same time,
// so the test is repeated inside the transaction.
function migrateKinds(db: DatabaseSync): void {
  if (definitionsSql(db).includes("'const'")) return;
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!definitionsSql(db).includes("'const'")) {
        db.exec(DEFINITIONS_NEW);
        db.exec(
          "INSERT INTO definitions_new (hash, kind, text, signature) SELECT hash, kind, text, signature FROM definitions",
        );
        db.exec("DROP TABLE definitions");
        db.exec("ALTER TABLE definitions_new RENAME TO definitions");
        const broken = db.prepare("PRAGMA foreign_key_check").all();
        if (broken.length > 0) throw new Error(`migrating the definitions table broke references: ${broken.length}`);
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

// SQLite refuses every write to a database file that was moved or deleted
// while it was open (SQLITE_READONLY_DBMOVED); reads still answer from the
// old file. node:sqlite in Deno reports only the message, which a read-only
// file gives too, so `movedDiagnostic` also looks at the file.
const READONLY = /attempt to write a readonly database/;

// ---- the codebase ----

export class Codebase {
  // Submits run one at a time: acceptance writes one file in `out/`.
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly dir: string,
    private db: DatabaseSync,
    private file: FileId,
    private readonly clock: () => Date,
    private readonly during: OpenOptions["during"],
  ) {
    this.acceptPath = join(dir, "out", `accept-${Deno.pid}-${++opened}.ts`);
  }

  // Opens (or creates) the codebase in `dir`: `dir/alang.db`, the export in
  // `dir/export/`, generated TypeScript in `dir/out/`.
  static async open(dir: string, options: OpenOptions = {}): Promise<Codebase> {
    await Deno.mkdir(dir, { recursive: true });
    const { db, file } = openDatabase(join(dir, "alang.db"));
    return new Codebase(dir, db, file, options.clock ?? (() => new Date()), options.during);
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
    this.removeAcceptFile();
  }

  // Whether `dir/alang.db` is no longer the file this codebase has open: it
  // was moved (say, to the Trash), deleted or replaced by another file.
  moved(): boolean {
    let now: Deno.FileInfo;
    try {
      now = Deno.statSync(join(this.dir, "alang.db"));
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return true;
      throw e;
    }
    return now.dev !== this.file.dev || now.ino !== this.file.ino;
  }

  // If `dir/alang.db` was moved, deleted or replaced, closes the old handle
  // and opens `dir/alang.db` as `open` does: a new database if the file is
  // gone, which the next sync fills from `export/` as on a fresh start (the
  // history of the old file stays in that file). Returns whether it did. The
  // MCP server calls it before each tool call; a short-lived `alang db`
  // command does not need it.
  async reopenIfMoved(): Promise<boolean> {
    if (!this.moved()) return false;
    if (this.db.isOpen) this.db.close();
    await Deno.mkdir(this.dir, { recursive: true });
    ({ db: this.db, file: this.file } = openDatabase(join(this.dir, "alang.db")));
    return true;
  }

  // The diagnostic for a write that failed because the database file was
  // moved or deleted while it was open (see READONLY); null for any other
  // error. Nothing was written: the transaction rolled back, and the export
  // follows only a commit.
  movedDiagnostic(e: unknown): Diagnostic | null {
    if (!(e instanceof Error) || !READONLY.test(e.message) || !this.moved()) return null;
    const path = join(this.dir, "alang.db");
    return diagnostic({
      code: "E0514",
      at: path,
      message: `The database file \`${path}\` was moved or deleted while the server ran, so nothing was written. ` +
        "The next call opens it again, filled from `export/`; then send the change again.",
    });
  }

  // Acceptance writes the program here and runs its examples from it. One
  // file per open codebase, so that two processes (or two instances) on one
  // directory never run each other's program. It exists only while an
  // acceptance runs (they run one at a time, through the queue): a process
  // that is killed, as MCP clients end their servers, leaves nothing behind
  // unless it dies during one.
  private readonly acceptPath: string;

  private async acceptHere(defs: Definition[], checked: CheckResult): Promise<Accepted> {
    try {
      return await acceptDefinitions(defs, this.acceptPath, checked);
    } finally {
      this.removeAcceptFile();
    }
  }

  private removeAcceptFile(): void {
    try {
      Deno.removeSync(this.acceptPath);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
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
    if (stdEntry(name)) {
      return diagnostic({
        code: "E0502",
        definition: name,
        at,
        message: `\`${name}\` belongs to the standard library, which the codebase does not store: it can be read, ` +
          "but it has no history and cannot be replaced, removed or renamed.",
      });
    }
    const near = closest(name, [...this.names().keys(), ...STD_HITS.map((h) => h.name)]);
    return diagnostic({
      code: "E0502",
      definition: name,
      at,
      message: `There is no definition \`${name}\`.` + (near ? ` Did you mean \`${near}\`?` : ""),
      fix: near ? { replace: name, with: near } : null,
    });
  }

  // The current row of `name`; throws E0502, located at the query, if there is none.
  private row(name: string, query: string): Stored {
    const row = this.db.prepare(
      "SELECT n.hash, d.kind, d.text, d.signature FROM names n JOIN definitions d ON d.hash = n.hash WHERE n.name = ?",
    ).get(name) as { hash: string; kind: Definition["kind"]; text: string; signature: string } | undefined;
    if (!row) throw new AlangError(this.unknownName(name, `${query}(${name})`));
    return { name, ...row, def: parseProgram(row.text)[0] };
  }

  // Current rows whose name starts with `prefix` (all for ""), sorted by name.
  private rowsUnder(prefix: string): Stored[] {
    const rows = this.db.prepare(
      `SELECT n.name, n.hash, d.kind, d.text, d.signature FROM names n JOIN definitions d ON d.hash = n.hash
       WHERE n.name GLOB ? ORDER BY n.name`,
    ).all(`${prefix}*`) as { name: string; hash: string; kind: Definition["kind"]; text: string; signature: string }[];
    return rows.map((r) => ({ ...r, def: parseProgram(r.text)[0] }));
  }

  // ---- queries (section 6); each returns the hash it read ----

  // The queries answer for std names too, with hash null: a std type as its
  // alang text, a std function as its signature on one line (`stdEntry`).

  // The complete canonical text.
  definition(name: string): { name: string; hash: string | null; text: string } {
    const std = stdEntry(name);
    if (std) return { name, hash: null, text: std.text };
    const { hash, text } = this.row(name, "definition");
    return { name, hash, text };
  }

  // Every section except `body`.
  signature(name: string): { name: string; hash: string | null; signature: string } {
    const std = stdEntry(name);
    if (std) return { name, hash: null, signature: std.text };
    const { hash, signature } = this.row(name, "signature");
    return { name, hash, signature };
  }

  // The definitions that use `name`, sorted.
  callers(name: string): { name: string; hash: string | null; callers: string[] } {
    const std = stdEntry(name);
    if (std) return { name, hash: null, callers: this.usersOf(name, std.cases) };
    const { hash, def } = this.row(name, "callers");
    return { name, hash, callers: this.callersOf(name, def) };
  }

  // The text of `name` and the signatures of everything it uses (6.5), in
  // order of first use: functions, types, constants (each with its whole
  // text, C10), and the type of each case used. Then
  // the types that appear in those signatures, one level deep, since calling
  // a function means building its arguments. std functions come as one line
  // (`signatureLine`), std types as alang text; both have no hash. For a std
  // name, what it uses are the types in its signature.
  context(name: string): { name: string; hash: string | null; text: string; uses: Used[] } {
    const std = stdEntry(name);
    let hash: string | null = null;
    let text: string;
    let used: readonly string[];
    if (std) {
      text = std.text;
      used = std.types;
    } else {
      ({ hash, text } = this.row(name, "context"));
      const refs = this.db.prepare("SELECT to_name FROM refs WHERE from_hash = ? ORDER BY rowid").all(hash) as {
        to_name: string;
      }[];
      used = refs.map((r) => r.to_name);
    }
    const uses: Used[] = [];
    const seen = new Set([name]);
    const include = (full: string): TypeTree[] | null => {
      const owner = this.ownerOfCase(full) ?? full;
      if (seen.has(owner)) return null;
      seen.add(owner);
      const std = STD_BY_NAME.get(owner);
      if (std) {
        uses.push({ name: owner, hash: null, text: signatureLine(std) });
        return [...std.params.map((p) => treeOfType(p.type)), treeOfType(std.out)];
      }
      const stdType = STD_TYPES.find((d) => pathText(d.path) === owner);
      if (stdType) {
        uses.push({ name: owner, hash: null, text: printDefinition(stdType) });
        return signatureTypes(stdType);
      }
      const row = this.db.prepare(
        "SELECT n.hash, d.kind, d.text, d.signature FROM names n JOIN definitions d ON d.hash = n.hash WHERE n.name = ?",
      ).get(owner) as { hash: string; kind: Definition["kind"]; text: string; signature: string } | undefined;
      if (!row) return null;
      // A constant with its whole text: the examples of what uses it depend
      // on its value, which only the body holds (C10).
      uses.push({ name: owner, hash: row.hash, text: row.kind === "const" ? row.text : row.signature });
      return signatureTypes(parseProgram(row.text)[0]);
    };
    const level2: string[] = [];
    for (const u of used) for (const t of include(u) ?? []) namedTypes(t, level2);
    for (const t of level2) include(t);
    return { name, hash, text, uses };
  }

  // The type a case belongs to, among the current and std types of the
  // case's module; null if `full` is not a case.
  private ownerOfCase(full: string): string | null {
    const module = full.slice(0, full.lastIndexOf("."));
    const types = [
      ...STD_TYPES.filter((d) => pathText(d.path.slice(0, -1)) === module),
      ...this.rowsUnder(`${module}.`).filter((r) => r.kind === "type" && r.name.lastIndexOf(".") === module.length)
        .map((r) => r.def),
    ];
    const owner = types.find((d) => casesOf(d).includes(full));
    return owner ? pathText(owner.path) : null;
  }

  // The definitions of `module` itself (name, hash, kind, a function's
  // signature, doc; see `Hit`) and the names of its direct submodules.
  // `list("")` gives the top-level modules of the codebase (std not among
  // them), and works on an empty codebase too; `list("std")` and below list
  // the standard library. Any other unknown module is E0502.
  list(module: string): { module: string; definitions: Hit[]; submodules: string[] } {
    const prefix = module === "" ? "" : `${module}.`;
    const definitions: Hit[] = [];
    const submodules = new Set<string>();
    const entries = module === "std" || module.startsWith("std.")
      ? STD_HITS.filter((h) => h.name.startsWith(prefix))
      : this.rowsUnder(prefix).map(storedHit);
    for (const e of entries) {
      const rest = e.name.slice(prefix.length);
      if (rest.includes(".")) submodules.add(prefix + rest.slice(0, rest.indexOf(".")));
      else definitions.push(e);
    }
    if (definitions.length === 0 && submodules.size === 0 && module !== "") {
      const modules = new Set(
        [...this.rowsUnder(""), ...STD_HITS].flatMap((r) => {
          const segments = r.name.split(".");
          return segments.slice(1).map((_, i) => segments.slice(0, i + 1).join("."));
        }),
      );
      const near = closest(module, modules);
      throw new AlangError(diagnostic({
        code: "E0502",
        at: `list(${module})`,
        message: `There is no module \`${module}\`.` + (near ? ` Did you mean \`${near}\`?` : ""),
        fix: near ? { replace: module, with: near } : null,
      }));
    }
    return { module, definitions, submodules: [...submodules] };
  }

  // Definitions and std entries whose name or `doc` contains `text`, ignoring
  // case, sorted by name; the signature is shown, not searched.
  searchText(text: string): Hit[] {
    const needle = text.toLowerCase();
    const hit = (h: Hit) => h.name.toLowerCase().includes(needle) || h.doc.toLowerCase().includes(needle);
    return [
      ...this.rowsUnder("").map(storedHit),
      ...STD_HITS,
    ].filter(hit).sort(byName);
  }

  // Functions, std included, whose signature matches a type pattern such as
  // `String -> Result<Int, _>` (see search.ts), sorted by name. Each comes
  // with its signature on one line.
  searchType(pattern: string): { name: string; hash: string | null; line: string }[] {
    const p = parseFnPattern(pattern);
    const found: { name: string; hash: string | null; line: string }[] = [];
    for (const r of this.rowsUnder("")) {
      if (r.def.kind !== "fn") continue;
      const types = signatureTypes(r.def);
      if (!matchesFn(p, types.slice(0, -1), types[types.length - 1])) continue;
      found.push({ name: r.name, hash: r.hash, line: `${storedHead(r.name, r.def)}, doc: ${printString(r.def.doc)}` });
    }
    for (const s of STD) {
      if (!matchesFn(p, s.params.map((q) => treeOfType(q.type)), treeOfType(s.out))) continue;
      found.push({ name: s.name, hash: null, line: signatureLine(s) });
    }
    return found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  // Every version `name` had, oldest first, with the current hash (null if
  // removed). A name that came from a rename continues with the history of
  // its old name before the rename.
  history(name: string): { name: string; hash: string | null; entries: HistoryEntry[] } {
    if (stdEntry(name)) throw new AlangError(this.unknownName(name, `history(${name})`));
    const entries = this.historyOf(name, Number.MAX_SAFE_INTEGER);
    if (entries.length === 0) {
      const known = this.db.prepare("SELECT DISTINCT name FROM history").all() as { name: string }[];
      const near = closest(name, known.map((k) => k.name));
      throw new AlangError(diagnostic({
        code: "E0502",
        definition: name,
        at: `history(${name})`,
        message: `\`${name}\` never existed.` + (near ? ` Did you mean \`${near}\`?` : ""),
        fix: near ? { replace: name, with: near } : null,
      }));
    }
    const current = this.db.prepare("SELECT hash FROM names WHERE name = ?").get(name) as { hash: string } | undefined;
    return { name, hash: current?.hash ?? null, entries };
  }

  private historyOf(name: string, before: number): HistoryEntry[] {
    // A rename back (a -> b -> a) reaches the same rows twice.
    const rows = new Map(this.historyRows(name, before).map((r) => [r.id, r]));
    return [...rows.values()].sort((a, b) => a.id - b.id).map(({ id: _, ...e }) => e);
  }

  // Rows of `name` before row `before`, and for each rename that brought the
  // name, the rows of the old name before that rename.
  private historyRows(name: string, before: number): (HistoryEntry & { id: number })[] {
    const rows = this.db.prepare(
      "SELECT id, name, hash, changed_at, operation, other_name FROM history WHERE name = ? AND id < ? ORDER BY id",
    ).all(name, before) as unknown as (HistoryEntry & { id: number })[];
    const earlier = rows
      .filter((r) => r.operation === "rename" && r.hash !== null && r.other_name !== null)
      .flatMap((r) => this.historyRows(r.other_name!, r.id));
    return [...earlier, ...rows];
  }

  // Current definitions that refer to `name` (or, for a variant type, to one
  // of its cases), sorted, without `name` itself.
  private callersOf(name: string, def: Definition): string[] {
    return this.usersOf(name, casesOf(def));
  }

  // The current definitions other than `name` that refer to it or to one of
  // its cases, sorted.
  private usersOf(name: string, cases: readonly string[]): string[] {
    const targets = [name, ...cases];
    const rows = this.db.prepare(
      `SELECT DISTINCT n.name FROM refs r JOIN names n ON n.hash = r.from_hash
       WHERE r.to_name IN (${targets.map(() => "?").join(", ")}) AND n.name <> ? ORDER BY n.name`,
    ).all(...targets, name) as { name: string }[];
    return rows.map((r) => r.name);
  }

  // ---- running ----

  // Runs the program the codebase holds (spec, Toolchain): brings the
  // database in step with the export, accepts the whole program like any
  // change (6.3), writes it to `out/<main>.ts` with its entry
  // `out/<main>.run.ts` (both stay, like those of `alang run`), and starts
  // `main` in its own process with exactly the permissions of its effects.
  // `name` is the full name of the `main` to start, needed only if there are
  // several. The program's working directory is the caller's, not the
  // codebase's. Throws an AlangError and runs nothing if the sync fails (an
  // export file that does not parse or check, or E0513: the files contradict
  // the database, so neither side is run), if there is no such `main`, or if
  // the program is not accepted. `options` go to the run as they are: the
  // program's arguments and console input among them.
  async run(name?: string, options: Omit<RunOptions, "main"> = {}): Promise<Deno.CommandOutput> {
    const synced = await this.sync();
    if (!synced.ok) throw new AlangError(synced.diagnostics);
    if (name !== undefined && !this.names().has(name)) throw new AlangError(this.unknownName(name, `run(${name})`));
    const defs = [...this.snapshot().values()].map((c) => c.def);
    const main = pathText(findMain(defs, name).path);
    const { built } = await acceptDefinitions(defs, join(this.dir, "out", `${main}.ts`));
    return await runBuilt(built, { ...options, main });
  }

  // ---- changing ----

  // Applies `changes` as one transaction (6.3, 6.4): all of them, or none.
  submit(changes: readonly Change[]): Promise<SubmitResult> {
    const run = this.queue.then(() => this.apply(changes));
    this.queue = run.catch(() => {});
    return run;
  }

  private async apply(changes: readonly Change[], attempt = 1): Promise<SubmitResult> {
    // 0. The database follows the export first, so that the export written
    // at the end does not drop what Git brought in. What this imports stays,
    // even if the transaction is rejected.
    const synced = await this.syncNow();
    if (!synced.ok) return rejected(synced.diagnostics);
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

    // 2. The program after the transaction: renames first, with their
    // followers, then the other changes on top. A replace of a follower wins
    // over the rewrite, and so does the text of a rename.
    const renames = planned.filter((p) => p.op === "rename");
    const rewritten = renames.length > 0 ? this.rewriteForRenames(renames, current) : new Map<string, Rewritten>();
    const next = new Map([...current].map(([name, c]) => [name, c.def]));
    for (const r of rewritten.values()) {
      if (r.renamed) next.delete(r.from);
      next.set(r.name, r.def);
    }
    for (const p of planned) {
      if (p.op === "rename") {
        if (p.def) next.set(p.to!, p.def);
        continue;
      }
      if (p.def) next.set(p.name, p.def);
      else next.delete(p.name);
    }

    // 2b. Own-module names the texts wrote in full are shortened, and
    // `let name: Unit = ` is dropped, before the rules below compare
    // contracts as printed. Each submitted definition is the one in the
    // program under its name, so it is swapped for its fixed form; the check
    // info of acceptance is keyed by node.
    const sent = new Set(planned.flatMap((p) => (p.def ? [pathText(p.def.path)] : [])));
    const short = withOwnFixes([...next.keys()].sort().map((name) => next.get(name)!), sent);
    const { defs, fixed } = short;
    if (fixed.length > 0) {
      const byName = new Map(defs.map((d) => [pathText(d.path), d]));
      for (const [i, p] of planned.entries()) if (p.def) planned[i] = { ...p, def: byName.get(pathText(p.def.path))! };
    }
    const rejectedAfter = (ds: readonly Diagnostic[]) => rejected([...fixed, ...ds]);

    // 3. Callers outside the transaction must not be broken by it. Only what
    // the caller wrote is inside: renamed definitions and followers are
    // rewritten mechanically, not adapted; a rename with text is written.
    const members = new Set(planned.filter((p) => p.op !== "rename" || p.def).map((p) => p.name));
    for (const p of planned) diagnostics.push(...this.callerRule(p, current, members, rewritten));
    if (diagnostics.length > 0) return rejectedAfter(diagnostics);
    if (renames.length > 0) {
      const captured = this.captures(rewritten, renames, defs, members);
      if (captured.length > 0) return rejectedAfter(captured);
    }

    // 4. Acceptance of the whole resulting program (6.3). It re-runs every
    // example, so a caller whose example a changed body breaks is reported.
    let accepted: Accepted;
    try {
      accepted = await this.acceptHere(defs, short.checked);
    } catch (e) {
      if (e instanceof AlangError) return rejectedAfter(e.diagnostics);
      throw e;
    }

    // 5. Rows from the accepted trees: their check info is keyed by node.
    const rows: Row[] = [];
    const unchanged: string[] = [];
    const row = (name: string, op: Operation, def: Definition, other?: string): Row => {
      const text = printDefinition(def);
      const refs = dependencies(def, accepted.built.info);
      return { name, op, other, hash: hashText(text), kind: def.kind, text, signature: printSignature(def), refs };
    };
    for (const p of planned) {
      if (p.op === "rename") {
        const r = rewritten.get(p.name)!;
        rows.push(row(r.name, "rename", p.def ?? r.def, r.from));
      } else if (p.def) {
        const r = row(p.name, p.op, p.def);
        if (p.op === "replace" && r.hash === p.guard) unchanged.push(p.name);
        else rows.push(r);
      }
    }
    for (const r of rewritten.values()) if (!r.renamed && !members.has(r.from)) rows.push(row(r.name, "follow", r.def));

    // A file Git changed during acceptance (a pull) is not in the accepted
    // program, and the export written below would drop it. Start over: the
    // sync at the start imports it, and the guards report what it changed.
    await this.during?.("accepted");
    const drift = await this.compareExport();
    if (drift.ahead.length + drift.changed.length + drift.conflicts.length > 0) {
      return await this.again(changes, attempt);
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
        return await this.again(changes, attempt);
      }
      const history = this.db.prepare(
        "INSERT INTO history (name, hash, changed_at, operation, other_name) VALUES (?, ?, ?, ?, ?)",
      );
      const unname = this.db.prepare("DELETE FROM names WHERE name = ?");
      // Pointers that go away: old names of renames, removed names.
      for (const p of renames) unname.run(p.name);
      for (const p of planned) if (p.op === "remove") unname.run(p.name);
      for (const r of rows) {
        this.store(r);
        this.db.prepare("INSERT OR REPLACE INTO names (name, hash) VALUES (?, ?)").run(r.name, r.hash);
        history.run(r.name, r.hash, changedAt, r.op, r.other ?? null);
      }
      for (const p of planned) if (p.op === "remove") history.run(p.name, null, changedAt, "remove", null);
      // The old name's entry comes after the new one's, so that `history` of
      // the new name, which continues with the old name's entries before the
      // rename, does not list the rename twice.
      for (const p of renames) history.run(p.name, null, changedAt, "rename", p.to);
      this.db.exec("COMMIT");
    } catch (e) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw e;
    }
    const written = [
      ...planned.flatMap((p): Written[] => {
        if (p.op === "remove") return [{ name: p.name, hash: null, operation: p.op }];
        if (p.op === "rename") {
          const to = rows.find((r) => r.name === p.to)!;
          return [{ name: p.name, hash: null, operation: p.op }, { name: to.name, hash: to.hash, operation: p.op }];
        }
        const r = rows.find((r) => r.name === p.name);
        return r ? [{ name: p.name, hash: r.hash, operation: p.op }] : [];
      }),
      ...rows.filter((r) => r.op === "follow").map((r): Written => ({
        name: r.name,
        hash: r.hash,
        operation: "follow",
      })),
    ];

    // 7. The export of the affected modules (Storage). The database has
    // committed; if writing fails, the next sync writes the files. A file
    // that changed since the check above is left alone; the next sync
    // reports it (E0513), since both sides changed.
    await this.during?.("committed");
    await this.exportModules(written.map((w) => moduleName(w.name)));
    return { ok: true, written, unchanged, ...(fixed.length > 0 ? { fixed } : {}) };
  }

  // Starts a submit over because the codebase or its export changed while it
  // was accepted.
  private again(changes: readonly Change[], attempt: number): Promise<SubmitResult> {
    if (attempt >= RETRIES) throw new Error("The codebase keeps changing during acceptance.");
    return this.apply(changes, attempt + 1);
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
    const text = change.op === "remove" ? undefined : change.text;
    if (text !== undefined) {
      let defs: Definition[];
      try {
        defs = parseProgram(text);
      } catch (e) {
        if (!(e instanceof AlangError)) throw e;
        // The lexer reads the whole text before the parser reads a header,
        // so its diagnostics (and those of a broken header) name no
        // definition; in a transaction of many texts, the change's name, or
        // an add's header, tells which one it is.
        const named = change.op === "add" ? headerName(text) : change.name;
        diagnostics.push(
          ...e.diagnostics.map((d) => (d.definition === null && named ? { ...d, definition: named } : d)),
        );
        return null;
      }
      if (defs.length !== 1) {
        const found = defs.length === 0 ? "none" : list(defs.map((d) => pathText(d.path)));
        diagnostics.push(diagnostic({
          code: "E0504",
          definition: change.op === "add" ? null : change.name,
          at: operationText(change, change.op === "add" ? null : change.name),
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
      return { op: "add", name, at, def, guard: null, to: null };
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
    // Only the name is compared. It tells types (PascalCase) from values
    // (snake_case); a value may change between `fn` and `const`, which is an
    // interface change for its callers (C7).
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
    if (change.op === "rename") return this.planRename(change, cur, def, at, current, touched, diagnostics, shown);
    return { op: change.op, name, at, def, guard: change.hash, to: null };
  }

  // The checks of a rename that need no other change: the new name is free,
  // valid for the kind, and not in `std` (E0509); a text defines the new
  // name (E0505).
  private planRename(
    change: Extract<Change, { op: "rename" }>,
    cur: Current,
    def: Definition | null,
    at: string,
    current: ReadonlyMap<string, Current>,
    touched: Set<string>,
    diagnostics: Diagnostic[],
    shown: Version[],
  ): Planned | null {
    const { name, to } = change;
    const invalid = (why: string) => {
      diagnostics.push(diagnostic({
        code: "E0509",
        definition: name,
        at,
        message: `\`${to}\` cannot be the new name of \`${name}\`: ${why}`,
      }));
      return null;
    };
    if (to === name) return invalid("it is the current name.");
    if (to.split(".")[0] === "std") return invalid("the module `std` is reserved for the standard library.");
    // The new name must survive printing and parsing as the name of this kind.
    try {
      const reparsed = parseProgram(printDefinition({ ...cur.def, path: to.split(".") }));
      if (reparsed.length !== 1 || pathText(reparsed[0].path) !== to) return invalid("it is not a valid name.");
    } catch (e) {
      if (!(e instanceof AlangError)) throw e;
      return invalid(e.diagnostic.message);
    }
    if (touched.has(to)) {
      diagnostics.push(diagnostic({
        code: "E0508",
        definition: to,
        at,
        message: `\`${to}\` is changed twice in this transaction; submit one change per name.`,
      }));
      return null;
    }
    touched.add(to);
    const taken = current.get(to);
    if (taken) {
      diagnostics.push(diagnostic({
        code: "E0503",
        definition: to,
        at,
        message: `\`${to}\` already exists; its current version is under \`current\`.`,
      }));
      shown.push({ name: to, hash: taken.hash, text: taken.text });
      return null;
    }
    if (def && pathText(def.path) !== to) {
      diagnostics.push(diagnostic({
        code: "E0505",
        definition: name,
        at,
        message: `The text defines \`${pathText(def.path)}\`, not \`${to}\`; the text of a \`rename\` is the ` +
          "definition under its new name.",
        expected: `${cur.def.kind} ${to}`,
      }));
      return null;
    }
    return { op: "rename", name, at, def, guard: change.hash, to };
  }

  // Rewrites the renamed definitions and every definition that refers to them
  // (6.1: references are names, so a rename rewrites its callers). All renames
  // of the transaction go through one mapping; a variant type that changes
  // module takes its cases along. Keyed by the old name; a caller whose text
  // does not change is left out.
  private rewriteForRenames(
    renames: readonly Planned[],
    current: ReadonlyMap<string, Current>,
  ): Map<string, Rewritten> {
    const { info } = checkProgram([...current.values()].map((c) => c.def));
    const moves = new Map<string, string>();
    for (const r of renames) {
      moves.set(r.name, r.to!);
      const from = moduleName(r.name);
      const to = moduleName(r.to!);
      if (from === to) continue;
      for (const c of casesOf(current.get(r.name)!.def)) moves.set(c, `${to}${c.slice(from.length)}`);
    }
    const target = (ref: Ref) => moves.get(ref.full) ?? ref.full;
    const affected = new Set<string>();
    for (const r of renames) {
      affected.add(r.name);
      for (const c of this.callersOf(r.name, current.get(r.name)!.def)) affected.add(c);
    }
    const out = new Map<string, Rewritten>();
    for (const from of [...affected].sort()) {
      const cur = current.get(from)!;
      const renamed = renames.some((r) => r.name === from);
      const path = renamed ? moves.get(from)!.split(".") : cur.def.path;
      const def = mapReferences(cur.def, info, target, path);
      if (!renamed && printDefinition(def) === cur.text) continue;
      const expected = new Set(dependencies(cur.def, info).map((d) => moves.get(d) ?? d));
      out.set(from, { from, name: pathText(path), def, renamed, expected });
    }
    return out;
  }

  // A rename must not change what a rewritten definition refers to: a new
  // name can be captured by a local binding (`by: g` with a local `g`, or
  // `path.parse(...)` with a parameter `path`). Checks the program after the
  // transaction and reports E0510 for every rewritten definition whose
  // references differ from the expected ones or that no longer checks; then
  // the other definitions' diagnostics of the same check, if any.
  private captures(
    rewritten: ReadonlyMap<string, Rewritten>,
    renames: readonly Planned[],
    defs: readonly Definition[],
    members: ReadonlySet<string>,
  ): Diagnostic[] {
    const { diagnostics, info } = checkProgram(defs);
    const checked = [...rewritten.values()].filter((r) => !members.has(r.from));
    const names = new Set(checked.map((r) => r.name));
    const found: Diagnostic[] = [];
    for (const r of checked) {
      const actual = new Set(dependencies(r.def, info));
      const lost = [...r.expected].filter((d) => !actual.has(d));
      const gained = [...actual].filter((d) => !r.expected.has(d));
      const broken = diagnostics.find((d) => d.definition === r.name);
      if (lost.length === 0 && gained.length === 0 && !broken) continue;
      const rename = renames.find((p) => p.name === r.from) ??
        renames.find((p) => r.expected.has(p.to!)) ?? renames[0];
      const why = broken
        ? `it no longer checks: ${broken.message} (at \`${broken.at}\`)`
        : `it would no longer refer to ${list(lost)}` + (gained.length > 0 ? `, but to ${list(gained)}` : "");
      found.push(diagnostic({
        code: "E0510",
        definition: r.name,
        at: rename.at,
        message: `The rename changes what \`${r.name}\` refers to: ${why}. A local binding or a type parameter ` +
          "probably has the new name; choose another new name, or rename that binding first.",
      }));
    }
    if (found.length === 0) return [];
    return [...found, ...diagnostics.filter((d) => d.definition === null || !names.has(d.definition))];
  }

  // The rules that protect callers outside the transaction: a replace may not
  // change the interface they use (E0506), and a remove may not take away a
  // definition they use (E0507).
  private callerRule(
    p: Planned,
    current: ReadonlyMap<string, Current>,
    members: ReadonlySet<string>,
    rewritten: ReadonlyMap<string, Rewritten>,
  ): Diagnostic[] {
    if (p.op === "add" || (p.op === "rename" && !p.def)) return [];
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

    // Compared with what the renames of the transaction make of it, so that
    // a renamed type in its signature, or its own new name, is no change.
    const change = interfaceChange(rewritten.get(p.name)?.def ?? before, p.def!);
    const affected = new Set<string>();
    if (change.sections.length > 0 || change.kind) {
      for (const c of outside(this.callersOf(p.name, before))) affected.add(c);
    }
    if (change.addedEffects.length > 0) {
      for (const c of this.lackingEffects(p.name, before, change.addedEffects, current, members)) affected.add(c);
    }
    if (affected.size === 0) return [];
    // A `fn` that becomes a `const` (C7): how every caller writes it changes.
    const what = change.kind ? `changes from a \`${change.kind.from}\` to a \`${change.kind.to}\`` : [
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
  // With `refresh`, the derived columns of an existing version are computed
  // again (import).
  private store(row: Row, refresh = false): void {
    const existing = this.db.prepare("SELECT text FROM definitions WHERE hash = ?").get(row.hash) as
      | { text: string }
      | undefined;
    if (existing && existing.text !== row.text) throw new Error(`Hash collision on ${row.hash}.`);
    if (existing && !refresh) return;
    if (existing && this.derivedMatches(row)) return;
    if (existing) {
      this.db.prepare("UPDATE definitions SET signature = ? WHERE hash = ?").run(row.signature, row.hash);
      this.db.prepare("DELETE FROM refs WHERE from_hash = ?").run(row.hash);
    } else {
      this.db.prepare("INSERT INTO definitions (hash, kind, text, signature) VALUES (?, ?, ?, ?)").run(
        row.hash,
        row.kind,
        row.text,
        row.signature,
      );
    }
    const ref = this.db.prepare("INSERT OR IGNORE INTO refs (from_hash, to_name) VALUES (?, ?)");
    for (const to of row.refs) ref.run(row.hash, to);
  }

  // Whether the stored derived columns of `row`'s version equal `row`'s.
  private derivedMatches(row: Row): boolean {
    const stored = this.db.prepare("SELECT signature FROM definitions WHERE hash = ?").get(row.hash) as {
      signature: string;
    };
    const refs = (this.db.prepare("SELECT to_name FROM refs WHERE from_hash = ? ORDER BY rowid").all(row.hash) as {
      to_name: string;
    }[]).map((r) => r.to_name);
    return stored.signature === row.signature && refs.length === row.refs.length &&
      refs.every((r, i) => r === row.refs[i]);
  }

  // ---- export and import (Storage) ----

  private get exportDir(): string {
    return join(this.dir, "export");
  }

  // The export file of exactly `module` as the database would write it: its
  // definitions' canonical texts, sorted by name; null if it has none.
  private moduleFile(module: string): string | null {
    const rows = this.db.prepare(
      "SELECT n.name, d.text FROM names n JOIN definitions d ON d.hash = n.hash WHERE n.name GLOB ? ORDER BY n.name",
    ).all(`${module}.*`) as { name: string; text: string }[];
    const texts = rows.filter((r) => r.name.lastIndexOf(".") === module.length).map((r) => r.text);
    return texts.length === 0 ? null : texts.join("\n\n") + "\n";
  }

  // Notes what the file of `module` holds now that the codebase wrote or
  // read it (null: no file).
  private recordFile(module: string, content: string | null): void {
    if (content === null) this.db.prepare("DELETE FROM export_files WHERE module = ?").run(module);
    else {
      this.db.prepare("INSERT OR REPLACE INTO export_files (module, hash) VALUES (?, ?)").run(
        module,
        hashText(content),
      );
    }
  }

  private recordedFiles(): Map<string, string> {
    const rows = this.db.prepare("SELECT module, hash FROM export_files").all() as { module: string; hash: string }[];
    return new Map(rows.map((r) => [r.module, r.hash]));
  }

  private currentModules(): Set<string> {
    const rows = this.db.prepare("SELECT name FROM names").all() as { name: string }[];
    return new Set(rows.map((r) => moduleName(r.name)));
  }

  // Rewrites the export files of `modules` from the current names: one file
  // per module, `export/<module>.alang`, its definitions sorted by name. A
  // module without definitions loses its file. Unless `force`, a file that
  // changed since the codebase last wrote or read it is not overwritten but
  // skipped: someone else changed it, so both sides changed.
  private async exportModules(
    modules: Iterable<string>,
    force = false,
  ): Promise<{ files: string[]; skipped: string[] }> {
    await Deno.mkdir(this.exportDir, { recursive: true });
    const recorded = this.recordedFiles();
    const files: string[] = [];
    const skipped: string[] = [];
    for (const module of new Set(modules)) {
      const path = join(this.exportDir, `${module}.alang`);
      const content = this.moduleFile(module);
      if (!force) {
        const now = await fileHash(path);
        if (now !== (content === null ? null : hashText(content)) && now !== (recorded.get(module) ?? null)) {
          skipped.push(module);
          continue;
        }
      }
      if (content === null) {
        await Deno.remove(path).catch((e) => {
          if (!(e instanceof Deno.errors.NotFound)) throw e;
        });
        this.recordFile(module, null);
        continue;
      }
      // Written next to the file and renamed, so a reader never sees half a file.
      await Deno.writeTextFile(`${path}.tmp`, content);
      await Deno.rename(`${path}.tmp`, path);
      this.recordFile(module, content);
      files.push(path);
    }
    return { files, skipped };
  }

  // Writes the whole export and deletes the files of modules that no longer
  // exist. Returns the paths written. It first brings the database in step
  // with the export (`sync`), so files changed by Git are imported, not
  // overwritten; `force` skips that and lets the database win.
  exportAll(options: { readonly force?: boolean } = {}): Promise<ExportResult> {
    const run = this.queue.then(async (): Promise<ExportResult> => {
      if (!options.force) {
        const synced = await this.syncNow();
        if (!synced.ok) return { ok: false, diagnostics: synced.diagnostics };
      }
      const modules = new Set([...this.currentModules(), ...this.recordedFiles().keys()]);
      for (const file of await exportFiles(this.exportDir)) modules.add(file.slice(0, -".alang".length));
      const { files, skipped } = await this.exportModules([...modules].sort(), options.force);
      return skipped.length > 0 ? { ok: false, diagnostics: bothChanged(skipped) } : { ok: true, files };
    });
    this.queue = run.catch(() => {});
    return run;
  }

  // Brings database and export in step; the export in Git is the source of
  // truth (Storage). Per module it compares the file (F), the file the
  // database would write (D) and what the file held when last written or
  // read (R):
  //
  //   F = D            in step
  //   F = R, D ≠ R     the database is ahead (a write failed): write the file
  //   D = R, F ≠ R     the file changed (pull, checkout, edit): import
  //   otherwise        both changed: refused (E0513)
  //
  // A missing export directory has not been written yet; it is not read as
  // every file deleted. Submits and `exportAll` call this first; queries
  // read the database as it is, so a caller that wants them fresh calls it
  // before (the command line does).
  sync(): Promise<SyncResult> {
    const run = this.queue.then(() => this.syncNow());
    this.queue = run.catch(() => {});
    return run;
  }

  private async syncNow(): Promise<SyncResult> {
    const first = await this.compareExport();
    if (first.conflicts.length > 0) return { ok: false, diagnostics: bothChanged(first.conflicts) };
    // Written before the import, which reads every file. A file that
    // changed in between is skipped, and both sides have changed.
    const ahead = await this.exportModules(first.ahead);
    if (ahead.skipped.length > 0) return { ok: false, diagnostics: bothChanged(ahead.skipped) };
    if (first.changed.length === 0) return { ok: true, exported: first.ahead, imported: [] };
    const imported = await this.importFrom(this.exportDir);
    if (!imported.ok) return { ok: false, diagnostics: imported.diagnostics };
    // Files that are not canonical (order, layout) are rewritten now, so
    // that the sync ends with every file as the database would write it.
    const after = await this.compareExport();
    const rewritten = await this.exportModules(after.ahead);
    if (rewritten.skipped.length > 0) return { ok: false, diagnostics: bothChanged(rewritten.skipped) };
    return { ok: true, exported: [...new Set([...first.ahead, ...after.ahead])].sort(), imported: imported.written };
  }

  // Sorts the modules of database, export and records by which side
  // changed (see `sync`); records the modules found in step. Without an
  // export directory the records describe nothing: it was never written.
  private async compareExport(): Promise<{ ahead: string[]; changed: string[]; conflicts: string[] }> {
    try {
      await Deno.stat(this.exportDir);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
      this.db.exec("DELETE FROM export_files");
    }
    const files = new Map<string, string>();
    for (const file of await exportFiles(this.exportDir)) {
      files.set(file.slice(0, -".alang".length), hashText(await Deno.readTextFile(join(this.exportDir, file))));
    }
    const recorded = this.recordedFiles();
    const modules = [...new Set([...this.currentModules(), ...files.keys(), ...recorded.keys()])].sort();
    const ahead: string[] = [];
    const changed: string[] = [];
    const conflicts: string[] = [];
    for (const module of modules) {
      const content = this.moduleFile(module);
      const f = files.get(module) ?? null;
      const d = content === null ? null : hashText(content);
      const r = recorded.get(module) ?? null;
      if (f === d) {
        if (r !== f) this.recordFile(module, content);
      } else if (f === r) ahead.push(module);
      else if (d === r) changed.push(module);
      else conflicts.push(module);
    }
    return { ahead, changed, conflicts };
  }

  // Rebuilds the current names from the export (`export/*.alang`, or the
  // files in `from`): the export is the source of truth (Storage). The whole
  // program is accepted first; then names whose version differs get it, with
  // history operation `import`, and names missing from the export are
  // removed. The derived columns of every imported version are computed
  // again. The export itself is not written.
  importAll(from: string = this.exportDir): Promise<SubmitResult> {
    const run = this.queue.then(() => this.importFrom(from));
    this.queue = run.catch(() => {});
    return run;
  }

  private async importFrom(from: string): Promise<SubmitResult> {
    const defs: Definition[] = [];
    const diagnostics: Diagnostic[] = [];
    const contents = new Map<string, string>();
    for (const file of await exportFiles(from)) {
      const module = file.slice(0, -".alang".length);
      const content = await Deno.readTextFile(join(from, file));
      contents.set(module, content);
      let found: Definition[];
      try {
        found = parseProgram(content);
      } catch (e) {
        if (!(e instanceof AlangError)) throw e;
        // A parse error names no definition, so the message names the file.
        diagnostics.push(...e.diagnostics.map((d) => ({ ...d, message: `In \`${file}\`: ${d.message}` })));
        continue;
      }
      for (const def of found) {
        const name = pathText(def.path);
        if (moduleName(name) === module) {
          defs.push(def);
          continue;
        }
        diagnostics.push(diagnostic({
          code: "E0512",
          definition: name,
          at: `${def.kind} ${name}`,
          message: `\`${name}\` belongs to module \`${moduleName(name)}\`, so to the file ` +
            `\`${moduleName(name)}.alang\`, not \`${file}\`.`,
        }));
      }
    }
    if (diagnostics.length > 0) return rejected(diagnostics);

    defs.sort((a, b) => (pathText(a.path) < pathText(b.path) ? -1 : 1));
    // A file written by hand may name its own module in full, or bind
    // `Unit`; it is stored fixed, and the sync then rewrites the file.
    const { defs: program, checked, fixed } = withOwnFixes(defs, new Set(defs.map((d) => pathText(d.path))));
    let accepted: Accepted;
    try {
      accepted = await this.acceptHere(program, checked);
    } catch (e) {
      if (e instanceof AlangError) return rejected([...fixed, ...e.diagnostics]);
      throw e;
    }
    const rows = program.map((def): Row => {
      const text = printDefinition(def);
      return {
        name: pathText(def.path),
        op: "import",
        hash: hashText(text),
        kind: def.kind,
        text,
        signature: printSignature(def),
        refs: dependencies(def, accepted.built.info),
      };
    });

    const changedAt = this.clock().toISOString();
    const written: Written[] = [];
    const unchanged: string[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const before = this.names();
      const history = this.db.prepare(
        "INSERT INTO history (name, hash, changed_at, operation, other_name) VALUES (?, ?, ?, 'import', NULL)",
      );
      for (const row of rows) {
        this.store(row, true);
        if (before.get(row.name) === row.hash) {
          unchanged.push(row.name);
          continue;
        }
        this.db.prepare("INSERT OR REPLACE INTO names (name, hash) VALUES (?, ?)").run(row.name, row.hash);
        history.run(row.name, row.hash, changedAt);
        written.push({ name: row.name, hash: row.hash, operation: "import" });
      }
      const imported = new Set(rows.map((r) => r.name));
      for (const name of before.keys()) {
        if (imported.has(name)) continue;
        this.db.prepare("DELETE FROM names WHERE name = ?").run(name);
        history.run(name, null, changedAt);
        written.push({ name, hash: null, operation: "import" });
      }
      this.db.exec("COMMIT");
    } catch (e) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw e;
    }
    // The database now follows these files; from another directory, the own
    // export is behind instead, and the next sync writes it.
    if (from === this.exportDir) {
      for (const module of this.recordedFiles().keys()) if (!contents.has(module)) this.recordFile(module, null);
      for (const [module, content] of contents) this.recordFile(module, content);
    }
    return { ok: true, written, unchanged, ...(fixed.length > 0 ? { fixed } : {}) };
  }
}

// Two complaints the codebase fixes itself instead of rejecting, since each
// is pure spelling with one stored form (3.7), so text and hash are those of
// the fixed form either way: a name of a definition's own module written in
// full (E0226), whose short form means the same (1.2), and a `let` that binds
// `Unit` to an unused name (E0235 with a fix), which means the same as its
// statement without `let name: Unit = ` (3.2). Applied only when every
// diagnostic of the program's check is one of them in one of `sent` (the
// definitions whose text came with this change), since any other diagnostic
// quotes the text as sent (5.5); and only if the fixed program checks.
// Returns the program to accept, its check, and the diagnostics applied (none
// if the program is returned as it was).
function withOwnFixes(
  defs: Definition[],
  sent: ReadonlySet<string>,
): { defs: Definition[]; checked: CheckResult; fixed: Diagnostic[] } {
  const checked = checkProgram(defs);
  const { diagnostics, info } = checked;
  const own = (d: Diagnostic) =>
    (d.code === "E0226" || (d.code === "E0235" && d.fix !== null)) && d.definition !== null &&
    sent.has(d.definition);
  if (diagnostics.length === 0 || !diagnostics.every(own)) return { defs, checked, fixed: [] };
  const names = new Set(diagnostics.map((d) => d.definition));
  const shortened = defs.map((def) => (names.has(pathText(def.path)) ? applyOwnFixes(def, info) : def));
  const again = checkProgram(shortened);
  if (again.diagnostics.length > 0) return { defs, checked, fixed: [] };
  return { defs: shortened, checked: again, fixed: diagnostics };
}

// E0513 for each module whose file and database both changed.
function bothChanged(modules: readonly string[]): Diagnostic[] {
  return modules.map((module) =>
    diagnostic({
      code: "E0513",
      at: `export/${module}.alang`,
      message: `\`export/${module}.alang\` and the database have both changed since the file was last ` +
        "written or read. Run `alang db import` to take the files (the database's versions stay in its " +
        "history), or `alang db export --force` to overwrite the files with the database.",
    })
  );
}

// The hash of a file's content; null if there is no file.
async function fileHash(path: string): Promise<string | null> {
  try {
    return hashText(await Deno.readTextFile(path));
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}

// The module of a full name: everything before the last segment.
function moduleName(full: string): string {
  return full.slice(0, full.lastIndexOf("."));
}

// Names of the `.alang` files directly in `dir`, sorted; none if it does not exist.
async function exportFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && entry.name.endsWith(".alang")) files.push(entry.name);
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  return files.sort();
}
