// The export (Storage): canonical text, one file per module, rewritten after
// every transaction; and the import that rebuilds the database from it.

import { join } from "node:path";
import { assert_, assertEquals } from "./assert.ts";
import {
  add,
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
import { Codebase, type SubmitResult } from "../src/codebase.ts";

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

Deno.test("export: exportAll writes every module and deletes stale files", async () => {
  const cb = await withPort();
  const expected = await files(cb);
  await Deno.writeTextFile(join(cb.dir, "export", "gone.alang"), "");
  await Deno.remove(join(cb.dir, "export", "config.alang"));
  const written = await cb.exportAll();
  assertEquals(written.map((p) => p.slice(p.lastIndexOf("/") + 1)), ["config.alang", "net.port.alang"]);
  assertEquals(await files(cb), expected);
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
