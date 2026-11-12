// The export (Storage): canonical text, one file per module, rewritten after
// every transaction; the import that rebuilds the database from it; and the
// sync that keeps the two in step when Git changes the files.

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assert_, assertEquals } from "./assert.ts";
import {
  add,
  CLOCK,
  codes,
  done,
  dump,
  fails,
  fn,
  fresh,
  hashOf,
  LOAD_ERROR,
  LOAD_PORT,
  ok,
  PARSE,
  PARSE_ERROR,
  PARSE_REORDERED,
  PORT,
  withPort,
} from "./db_helpers.ts";
import { type Change, Codebase, type SubmitResult, type SyncResult } from "../src/codebase.ts";

// File name -> content of every file in `dir/export`.
async function files(cb: Codebase): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    for await (const e of Deno.readDir(join(cb.dir, "export"))) {
      out[e.name] = await Deno.readTextFile(join(cb.dir, "export", e.name));
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

async function synced(cb: Codebase): Promise<Extract<SyncResult, { ok: true }>> {
  const r = await cb.sync();
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics, null, 2));
  return r;
}

// A submit whose export write fails after the commit: the database is ahead.
async function failedWrite(cb: Codebase, changes: Change[]): Promise<void> {
  const dir = join(cb.dir, "export");
  await Deno.chmod(dir, 0o555);
  try {
    await cb.submit(changes);
    throw new Error("the export was written");
  } catch (e) {
    if (!(e instanceof Deno.errors.PermissionDenied)) throw e;
  } finally {
    await Deno.chmod(dir, 0o755);
  }
}

// Forgets which files the codebase wrote, as in a database from before
// `export_files`.
function forget(cb: Codebase): void {
  const db = new DatabaseSync(join(cb.dir, "alang.db"));
  db.exec("DELETE FROM export_files");
  db.close();
}

async function imported(cb: Codebase, from?: string): Promise<Extract<SubmitResult, { ok: true }>> {
  const r = await cb.importAll(from);
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics, null, 2));
  return r;
}

Deno.test("export: one canonical file per module, definitions sorted by name", async () => {
  const cb = await withPort();
  assertEquals(await files(cb), {
    "config.alang": `${LOAD_ERROR}\n\n${LOAD_PORT}\n`,
    "net.port.alang": `${PARSE_ERROR}\n\n${PORT}\n\n${PARSE}\n`,
  });
  // A replace rewrites the module's file.
  await ok(cb, [{ op: "replace", name: "net.port.parse", hash: hashOf(cb, "net.port.parse"), text: PARSE_REORDERED }]);
  assertEquals((await files(cb))["net.port.alang"], `${PARSE_ERROR}\n\n${PORT}\n\n${PARSE_REORDERED}\n`);
  await done(cb);
});

Deno.test("export: a rejected transaction leaves the files untouched", async () => {
  const cb = await withPort();
  const before = await files(cb);
  await fails(cb, [{ op: "remove", name: "net.port.parse", hash: hashOf(cb, "net.port.parse") }]);
  const typeError = PARSE.replace("return Ok(Port(value: n))", "return Ok(n)");
  await fails(cb, [{ op: "replace", name: "net.port.parse", hash: hashOf(cb, "net.port.parse"), text: typeError }]);
  assertEquals(await files(cb), before);
  await done(cb);
});

Deno.test("export: a module that loses its last definition loses its file", async () => {
  const cb = await withPort();
  await ok(cb, [
    { op: "remove", name: "config.load_port", hash: hashOf(cb, "config.load_port") },
    { op: "remove", name: "config.LoadError", hash: hashOf(cb, "config.LoadError") },
  ]);
  assertEquals(Object.keys(await files(cb)), ["net.port.alang"]);
  await done(cb);
});

Deno.test("export: a forced exportAll writes every module and deletes stale files", async () => {
  const cb = await withPort();
  const expected = await files(cb);
  await Deno.writeTextFile(join(cb.dir, "export", "gone.alang"), "");
  await Deno.remove(join(cb.dir, "export", "config.alang"));
  const r = await cb.exportAll({ force: true });
  assert_(r.ok);
  assertEquals(r.files.map((p) => p.slice(p.lastIndexOf("/") + 1)), ["config.alang", "net.port.alang"]);
  assertEquals(await files(cb), expected);
  assertEquals(await synced(cb), { ok: true, exported: [], imported: [] });
  await done(cb);
});

Deno.test("export: without force, exportAll takes changed files first", async () => {
  const cb = await withPort();
  await Deno.writeTextFile(join(cb.dir, "export", "gone.alang"), "");
  await Deno.remove(join(cb.dir, "export", "config.alang"));
  const r = await cb.exportAll();
  assert_(r.ok);
  assertEquals(Object.keys(await files(cb)), ["net.port.alang"]);
  assertEquals(cb.list("").submodules, ["net"]);
  assertEquals(cb.history("config.load_port").entries.map((e) => [e.operation, e.hash === null]), [
    ["add", false],
    ["import", true],
  ]);
  await done(cb);
});

Deno.test("import: export, then import into a fresh database, gives the same names and hashes", async () => {
  const cb = await withPort();
  await ok(cb, [{ op: "replace", name: "net.port.parse", hash: hashOf(cb, "net.port.parse"), text: PARSE_REORDERED }]);
  const other = await fresh();
  const r = await imported(other, join(cb.dir, "export"));
  assertEquals(r.written.map((w) => w.operation), Array(5).fill("import"));
  assertEquals(dump(other).names, dump(cb).names);
  // Derived data is rebuilt: callers and context work on the imported codebase.
  assertEquals(other.callers("net.port.parse").callers, ["config.load_port"]);
  assertEquals(other.context("config.load_port"), cb.context("config.load_port"));
  // And the import's own export reproduces the files byte for byte.
  await other.exportAll();
  assertEquals(await files(other), await files(cb));
  await done(cb);
  await done(other);
});

Deno.test("import: an edited export updates changed names and removes missing ones", async () => {
  const cb = await withPort();
  const extra = fn("app.one", { out: "Int", examples: ["one() == 1"], body: "return 1" });
  await ok(cb, [add(extra)]);
  const dir = join(cb.dir, "export");
  // As after a checkout: one module edited, one gone.
  await Deno.writeTextFile(join(dir, "net.port.alang"), `${PARSE_ERROR}\n\n${PORT}\n\n${PARSE_REORDERED}\n`);
  await Deno.remove(join(dir, "app.alang"));
  const r = await imported(cb);
  assertEquals(r.written.map((w) => [w.name, w.hash === null]), [["net.port.parse", false], ["app.one", true]]);
  assertEquals(r.unchanged, ["config.LoadError", "config.load_port", "net.port.ParseError", "net.port.Port"]);
  assertEquals(hashOf(cb, "net.port.parse"), r.written[0].hash);
  const history = cb.history("net.port.parse").entries.map((e) => e.operation);
  assertEquals(history, ["add", "import"]);
  assertEquals(cb.history("app.one").entries.map((e) => [e.operation, e.hash === null]), [
    ["add", false],
    ["import", true],
  ]);
  // Importing again changes nothing.
  const before = dump(cb);
  assertEquals((await imported(cb)).written, []);
  assertEquals(dump(cb), before);
  await done(cb);
});

Deno.test("import: a broken export is rejected and changes nothing", async () => {
  const cb = await withPort();
  const dir = join(cb.dir, "export");
  const before = dump(cb);

  // A definition in the wrong file.
  await Deno.writeTextFile(join(dir, "net.alang"), PORT.replaceAll("net.port.Port", "net.port.Other") + "\n");
  let r = await cb.importAll();
  assert_(!r.ok);
  assertEquals(codes(r.diagnostics), ["E0512"]);
  await Deno.remove(join(dir, "net.alang"));

  // A parse error, and a program that does not check.
  await Deno.writeTextFile(join(dir, "app.alang"), "fn app.x\n  doc: 1\n");
  r = await cb.importAll();
  assert_(!r.ok);
  assertEquals(r.diagnostics[0].code.startsWith("E01"), true, JSON.stringify(r.diagnostics));
  await Deno.writeTextFile(
    join(dir, "app.alang"),
    fn("app.x", { out: "Int", examples: ["x() == 1"], body: "return y" }) + "\n",
  );
  r = await cb.importAll();
  assert_(!r.ok);
  assertEquals(codes(r.diagnostics), ["E0203"]);

  assertEquals(dump(cb), before);
  await done(cb);
});

Deno.test("import: an empty or missing export gives an empty codebase", async () => {
  const cb = await fresh();
  assertEquals((await imported(cb)).written, []);
  assertEquals(dump(cb).names, []);
  await done(cb);
});

// ---- keeping database and export in step ----

Deno.test("sync: files changed by Git are imported before a submit, not overwritten", async () => {
  const cb = await withPort();
  await ok(cb, [add(fn("app.one", { out: "Int", examples: ["one() == 1"], body: "return 1" }))]);
  const portHash = hashOf(cb, "net.port.Port");
  const parseHash = hashOf(cb, "net.port.parse");
  const config = (await files(cb))["config.alang"];
  const dir = join(cb.dir, "export");
  // As after a pull: one module edited, one new, one gone.
  const two = fn("extra.two", { out: "Int", examples: ["two() == 2"], body: "return 2" });
  await Deno.writeTextFile(join(dir, "net.port.alang"), `${PARSE_ERROR}\n\n${PORT}\n\n${PARSE_REORDERED}\n`);
  await Deno.writeTextFile(join(dir, "extra.alang"), `${two}\n`);
  await Deno.remove(join(dir, "app.alang"));
  // A change to the edited module, with a hash the pull left current.
  const port = PORT.replace("A valid TCP port number.", "A TCP port number from 1 to 65535.");
  await ok(cb, [{ op: "replace", name: "net.port.Port", hash: portHash, text: port }]);
  assertEquals(await files(cb), {
    "config.alang": config,
    "extra.alang": `${two}\n`,
    "net.port.alang": `${PARSE_ERROR}\n\n${port}\n\n${PARSE_REORDERED}\n`,
  });
  assertEquals(cb.history("net.port.parse").entries.map((e) => e.operation), ["add", "import"]);
  // A hash read before the pull is stale for what the pull changed (6.7).
  const stale = await fails(cb, [{ op: "remove", name: "net.port.parse", hash: parseHash }]);
  assertEquals(codes(stale.diagnostics), ["E0501"]);
  assertEquals(stale.current[0].text, PARSE_REORDERED);
  await done(cb);
});

Deno.test("sync: a write that failed after the commit is redone, not undone", async () => {
  const cb = await withPort();
  const before = await files(cb);
  await failedWrite(cb, [
    { op: "replace", name: "net.port.parse", hash: hashOf(cb, "net.port.parse"), text: PARSE_REORDERED },
  ]);
  assertEquals(await files(cb), before);
  assertEquals((await synced(cb)).exported, ["net.port"]);
  assertEquals((await files(cb))["net.port.alang"], `${PARSE_ERROR}\n\n${PORT}\n\n${PARSE_REORDERED}\n`);
  assertEquals(cb.history("net.port.parse").entries.map((e) => e.operation), ["add", "replace"]);
  await done(cb);
});

Deno.test("sync: file and database both changed is refused until the files are imported", async () => {
  const cb = await withPort();
  await failedWrite(cb, [
    { op: "replace", name: "net.port.parse", hash: hashOf(cb, "net.port.parse"), text: PARSE_REORDERED },
  ]);
  const port = PORT.replace("A valid TCP port number.", "A TCP port number from 1 to 65535.");
  await Deno.writeTextFile(join(cb.dir, "export", "net.port.alang"), `${PARSE_ERROR}\n\n${port}\n\n${PARSE}\n`);
  const before = dump(cb);
  const r = await fails(cb, [add(fn("app.one", { out: "Int", examples: ["one() == 1"], body: "return 1" }))]);
  assertEquals(codes(r.diagnostics), ["E0513"]);
  assertEquals(r.diagnostics[0].at, "export/net.port.alang");
  const exported = await cb.exportAll();
  assert_(!exported.ok);
  assertEquals(codes(exported.diagnostics), ["E0513"]);
  assertEquals(dump(cb), before);
  // Import takes the files; the database's version stays in its history.
  await imported(cb);
  assertEquals(cb.definition("net.port.Port").text, port);
  assertEquals(cb.definition("net.port.parse").text, PARSE);
  assertEquals(cb.history("net.port.parse").entries.map((e) => e.operation), ["add", "replace", "import"]);
  assertEquals(await synced(cb), { ok: true, exported: [], imported: [] });
  await done(cb);
});

Deno.test("sync: a fresh clone, an export without database, is imported on first use", async () => {
  const cb = await withPort();
  const clone = await Deno.makeTempDir({ prefix: "alang-db-" });
  await Deno.mkdir(join(clone, "export"));
  for (const [name, text] of Object.entries(await files(cb))) {
    await Deno.writeTextFile(join(clone, "export", name), text);
  }
  const other = await Codebase.open(clone, { clock: CLOCK });
  const r = await synced(other);
  assert_(r.ok);
  assertEquals([r.exported, r.imported.length], [[], 5]);
  assertEquals(dump(other).names, dump(cb).names);
  assertEquals(await synced(other), { ok: true, exported: [], imported: [] });
  await done(cb);
  await done(other);
});

Deno.test("sync: a database that has no record of its files", async () => {
  // As a database from before the records: files in step are just recorded;
  // a file that differs has no known direction and is refused.
  const cb = await withPort();
  forget(cb);
  assertEquals(await synced(cb), { ok: true, exported: [], imported: [] });
  forget(cb);
  await Deno.writeTextFile(
    join(cb.dir, "export", "net.port.alang"),
    `${PARSE_ERROR}\n\n${PORT}\n\n${PARSE_REORDERED}\n`,
  );
  const r = await cb.sync();
  assert_(!r.ok);
  assertEquals(codes(r.diagnostics), ["E0513"]);
  await imported(cb);
  assertEquals(cb.definition("net.port.parse").text, PARSE_REORDERED);
  await done(cb);
});

Deno.test("sync: a missing export directory is written, not read as every file deleted", async () => {
  const cb = await withPort();
  const before = await files(cb);
  await Deno.remove(join(cb.dir, "export"), { recursive: true });
  assertEquals((await synced(cb)).exported, ["config", "net.port"]);
  assertEquals(await files(cb), before);
  assertEquals(cb.list("").submodules, ["config", "net"]);
  await done(cb);
});

Deno.test("sync: a file that does not parse refuses a submit and names the file", async () => {
  const cb = await withPort();
  const before = dump(cb);
  const merged = `<<<<<<< HEAD\n${PARSE_ERROR}\n=======\n${PORT}\n>>>>>>> branch\n`;
  await Deno.writeTextFile(join(cb.dir, "export", "net.port.alang"), merged);
  const r = await fails(cb, [add(fn("app.one", { out: "Int", examples: ["one() == 1"], body: "return 1" }))]);
  assert_(r.diagnostics[0].message.startsWith("In `net.port.alang`: "), JSON.stringify(r.diagnostics));
  assertEquals(dump(cb), before);
  await done(cb);
});

Deno.test("sync: an imported file that is not canonical is rewritten", async () => {
  const cb = await withPort();
  const canonical = await files(cb);
  await Deno.writeTextFile(join(cb.dir, "export", "net.port.alang"), `${PORT}\n\n\n${PARSE}\n\n${PARSE_ERROR}`);
  const r = await synced(cb);
  assert_(r.ok);
  assertEquals([r.exported, r.imported], [["net.port"], []]);
  assertEquals(await files(cb), canonical);
  await done(cb);
});
