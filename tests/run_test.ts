// `alang db run`: the program the database holds, started like `alang run`.
// Each test runs the command line in a directory of its own, outside the
// repository, so the generated program's runtime import and the child's
// permissions are those of real use.

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assert_, assertEquals } from "./assert.ts";
import { add, CLOCK, fn, ok } from "./db_helpers.ts";
import { Codebase } from "../src/codebase.ts";
import type { Diagnostic } from "../src/diagnostic.ts";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const GREET = fn("greet.hello", {
  params: ["name: String"],
  out: "Unit",
  effects: "console",
  body: 'std.console.print_line(text: std.string.concat(left: "Hello, ", right: name))\nreturn Unit',
});
const APP_MAIN = fn("app.main", { out: "Unit", effects: "console", body: 'greet.hello(name: "world")\nreturn Unit' });
// Reads note.txt from the directory it runs in.
const TOOL_MAIN = fn("tool.main", {
  out: "Unit",
  effects: "fs.read, console",
  body: [
    'let text: String = match std.fs.read_text(path: "note.txt")',
    "  case Ok(content) then",
    "    content",
    "  case Err(reason) then",
    '    "no note.txt"',
    "end match",
    "std.console.print_line(text: text)",
    "return Unit",
  ].join("\n"),
});
const DIV = fn("calc.div", {
  params: ["a: Int", "b: Int"],
  out: "Int",
  examples: ["div(a: 6, b: 3) == 2"],
  body: "return a / b",
});
const CRASH_MAIN = fn("crash.main", {
  out: "Unit",
  effects: "console",
  body: "std.console.print_line(text: std.text.show(value: calc.div(a: 1, b: 0)))\nreturn Unit",
});

// A codebase holding `texts` in a fresh directory, and a second directory
// to run the program from. The codebase is closed: the command line opens
// its own.
async function setUp(...texts: string[]): Promise<{ dir: string; cwd: string }> {
  const tmp = await Deno.makeTempDir({ prefix: "alang-run-" });
  const dir = join(tmp, "project");
  const cwd = join(tmp, "work");
  await Deno.mkdir(cwd);
  const cb = await Codebase.open(dir, { clock: CLOCK });
  await ok(cb, texts.map(add));
  cb.close();
  return { dir, cwd };
}

async function dbRun(
  where: { dir: string; cwd: string },
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await dbRunCommand(where, "run", ...args);
}

// `alang db --dir <dir> <args>` from the directory `cwd`.
async function dbRunCommand(
  where: { dir: string; cwd: string },
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", "--allow-write", "--allow-run", CLI, "db", "--dir", where.dir, ...args],
    cwd: where.cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { code: out.code, stdout: decode(out.stdout), stderr: decode(out.stderr) };
}

// The diagnostics a refused run prints on stderr; nothing ran.
function refused(r: { code: number; stdout: string; stderr: string }): Diagnostic[] {
  assertEquals([r.code, r.stdout], [1, ""], r.stderr);
  return JSON.parse(r.stderr);
}

const outFiles = async (dir: string) =>
  (await Array.fromAsync(Deno.readDir(join(dir, "out")))).map((e) => e.name).sort();

Deno.test("db run: starts the only main, through other modules; stdout is the program's", async () => {
  const where = await setUp(GREET, APP_MAIN);
  assertEquals(await dbRun(where), { code: 0, stdout: "Hello, world\n", stderr: "" });
  // The built program and its entry stay, like those of `alang run`; the
  // acceptance file goes with the codebase.
  assertEquals(await outFiles(where.dir), ["app.main.run.ts", "app.main.ts"]);
  await Deno.remove(join(where.dir, ".."), { recursive: true });
});

Deno.test("db run: with several mains, the one named runs, with its own permissions", async () => {
  const where = await setUp(GREET, APP_MAIN, TOOL_MAIN);
  const ambiguous = refused(await dbRun(where));
  assertEquals(ambiguous.map((d) => [d.code, d.at]), [["E0304", "app.main, tool.main"]]);
  assert_(ambiguous[0].message.includes("name the one to run"), ambiguous[0].message);

  // tool.main reads from the caller's directory, not the codebase's, with
  // the read permission of its `fs.read`.
  await Deno.writeTextFile(join(where.cwd, "note.txt"), "a note");
  assertEquals(await dbRun(where, "tool.main"), { code: 0, stdout: "a note\n", stderr: "" });
  assertEquals((await dbRun(where, "app.main")).stdout, "Hello, world\n");

  const typo = refused(await dbRun(where, "app.mian"));
  assertEquals(typo.map((d) => [d.code, d.at, d.fix]), [["E0502", "run(app.mian)", {
    replace: "app.mian",
    with: "app.main",
  }]]);
  const notMain = refused(await dbRun(where, "greet.hello"));
  assertEquals(notMain.map((d) => [d.code, d.definition]), [["E0304", "greet.hello"]]);
  assert_(notMain[0].message.includes("`app.main`, `tool.main`"), notMain[0].message);
  await Deno.remove(join(where.dir, ".."), { recursive: true });
});

Deno.test("db run: a trap ends the program with code 70 and its description on stderr", async () => {
  const where = await setUp(DIV, CRASH_MAIN);
  const r = await dbRun(where);
  assertEquals([r.code, r.stdout], [70, ""]);
  assertEquals(JSON.parse(r.stderr).trap, "division");
  await Deno.remove(join(where.dir, ".."), { recursive: true });
});

Deno.test("db run: runs what the export holds, and nothing when export and database both changed", async () => {
  const where = await setUp(GREET, APP_MAIN);
  const file = join(where.dir, "export", "greet.alang");
  // A pull or a hand edit: the run imports it first.
  await Deno.writeTextFile(file, (await Deno.readTextFile(file)).replace('"Hello, "', '"Hi, "'));
  assertEquals(await dbRun(where), { code: 0, stdout: "Hi, world\n", stderr: "" });

  // An edit that does not check is not run, nor is the database's version.
  const good = await Deno.readTextFile(file);
  await Deno.writeTextFile(file, good.replace('"Hi, "', "Hi"));
  assertEquals(refused(await dbRun(where)).map((d) => d.definition), ["greet.hello"]);
  await Deno.writeTextFile(file, good);

  // The file changes again while the database no longer matches what it
  // last wrote (as after a failed write): neither side is run.
  await Deno.writeTextFile(file, (await Deno.readTextFile(file)).replace('"Hi, "', '"Hey, "'));
  const db = new DatabaseSync(join(where.dir, "alang.db"));
  db.prepare("UPDATE export_files SET hash = 'elsewhere' WHERE module = 'greet'").run();
  db.close();
  assertEquals(refused(await dbRun(where)).map((d) => [d.code, d.at]), [["E0513", "export/greet.alang"]]);
  await Deno.remove(join(where.dir, ".."), { recursive: true });
});

// Prints its arguments.
const ARGS_MAIN = fn("args.main", {
  out: "Unit",
  effects: "env, console",
  body: "std.console.print_line(text: std.text.show(value: std.env.args()))\nreturn Unit",
});

Deno.test("db run: the words after -- go to the program", async () => {
  const one = await setUp(ARGS_MAIN);
  assertEquals(await dbRun(one, "--", "a", "b c", "--"), { code: 0, stdout: '["a", "b c", "--"]\n', stderr: "" });
  assertEquals(await dbRun(one), { code: 0, stdout: "[]\n", stderr: "" });
  await Deno.remove(join(one.dir, ".."), { recursive: true });

  const several = await setUp(GREET, APP_MAIN, ARGS_MAIN);
  assertEquals(await dbRun(several, "args.main", "--", "x"), { code: 0, stdout: '["x"]\n', stderr: "" });
  // Program words before `--`, or `--` with another command, are usage errors.
  const stray = await dbRun(several, "args.main", "x");
  assertEquals([stray.code, stray.stdout], [2, ""]);
  assert_(stray.stderr.includes("run [<main>] [-- <args>...]"), stray.stderr);
  const misplaced = await dbRunCommand(several, "list", "--", "x");
  assertEquals([misplaced.code, misplaced.stdout], [2, ""]);
  await Deno.remove(join(several.dir, ".."), { recursive: true });
});
