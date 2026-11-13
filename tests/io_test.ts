// Files and program I/O in std: the runtime in this process (Deno), one
// temporary directory per test, then compiled programs as their own
// processes, for the program's input and the permission traps.

import { join } from "node:path";
import { assert_, assertEquals } from "./assert.ts";
import {
  Err,
  None,
  Ok,
  Some,
  std$env$get,
  std$fs$append_text,
  std$fs$create_directory,
  type std$fs$Error,
  std$fs$kind,
  std$fs$list_directory,
  std$fs$read_text,
  std$fs$remove,
  std$fs$write_text,
  Unit,
} from "../src/runtime.ts";
import { accept, type Built, run, type RunOptions } from "../src/toolchain.ts";

const OUT = new URL("../out/test/io/", import.meta.url).pathname;
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

// Links, /proc and file modes as tested here exist on Linux; root ignores
// file modes, so they are tested only if they hold.
const LINUX = Deno.build.os === "linux";
const MODES = LINUX && await (async () => {
  const probe = await Deno.makeTempFile({ prefix: "alang-io-mode-" });
  await Deno.chmod(probe, 0o000);
  const holds = await Deno.readTextFile(probe).then(() => false, () => true);
  await Deno.remove(probe);
  return holds;
})();

const NOT_FOUND = Err<std$fs$Error>({ tag: "NotFound" });
const DENIED = Err<std$fs$Error>({ tag: "PermissionDenied" });
const IS_A_DIRECTORY = Err<std$fs$Error>({ tag: "IsADirectory" });

// The tag of an `Other`, whose host message differs between runtimes.
function other(r: { tag: string; value?: unknown }): string {
  return r.tag === "Err" && (r.value as std$fs$Error).tag === "Other" ? "Other" : JSON.stringify(r);
}

async function inTemp(body: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "alang-io-" });
  try {
    await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

// Runs `body` while `path` has the given mode, then restores it.
async function withMode(path: string, mode: number, body: () => void): Promise<void> {
  const before = (await Deno.stat(path)).mode! & 0o777;
  await Deno.chmod(path, mode);
  try {
    body();
  } finally {
    await Deno.chmod(path, before);
  }
}

Deno.test("io: read_text reads UTF-8 and reports why it cannot", async () => {
  await inTemp(async (dir) => {
    const file = join(dir, "a.txt");
    await Deno.writeFile(file, new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0xff, 0x0a]));
    // A byte order mark stays; an invalid byte reads as U+FFFD.
    assertEquals(std$fs$read_text(file), Ok("﻿a�\n"));
    assertEquals(std$fs$read_text(join(dir, "missing.txt")), NOT_FOUND);
    assertEquals(std$fs$read_text(join(dir, "missing", "a.txt")), NOT_FOUND);
    assertEquals(std$fs$read_text(""), NOT_FOUND);
    assertEquals(std$fs$read_text(dir), IS_A_DIRECTORY);
    assertEquals(other(std$fs$read_text(join(file, "x"))), "Other");
    if (MODES) await withMode(file, 0o000, () => assertEquals(std$fs$read_text(file), DENIED));
    // Deno guards /proc although the read permission is there: refused by
    // the system, not by the program's effects.
    if (LINUX) assertEquals(std$fs$read_text("/proc/version"), DENIED);
  });
});

Deno.test("io: write_text writes exactly the text's bytes, replacing what was there", async () => {
  await inTemp(async (dir) => {
    const file = join(dir, "a.txt");
    assertEquals(std$fs$write_text(file, "first, long"), Ok(Unit));
    assertEquals(std$fs$write_text(file, "ä\n😀"), Ok(Unit));
    // No line break added, no byte order mark, nothing left of the old content.
    assertEquals(await Deno.readFile(file), new TextEncoder().encode("ä\n😀"));
    assertEquals(std$fs$write_text(file, ""), Ok(Unit));
    assertEquals(await Deno.readTextFile(file), "");
    assertEquals(std$fs$write_text(join(dir, "missing", "a.txt"), "x"), NOT_FOUND);
    assertEquals(std$fs$write_text("", "x"), NOT_FOUND);
    assertEquals(std$fs$write_text(dir, "x"), IS_A_DIRECTORY);
    assertEquals(other(std$fs$write_text(join(file, "x"), "x")), "Other");
    if (MODES) {
      await withMode(dir, 0o555, () => assertEquals(std$fs$write_text(join(dir, "b.txt"), "x"), DENIED));
      if (LINUX) assertEquals(std$fs$write_text("/proc/version", "x"), DENIED);
    }
    if (LINUX) {
      // A link is followed: the target changes.
      await Deno.symlink(file, join(dir, "link"));
      assertEquals(std$fs$write_text(join(dir, "link"), "through the link"), Ok(Unit));
      assertEquals(await Deno.readTextFile(file), "through the link");
    }
  });
});

Deno.test("io: append_text adds to the end, creating a missing file", async () => {
  await inTemp(async (dir) => {
    const file = join(dir, "log.txt");
    assertEquals(std$fs$append_text(file, "one\n"), Ok(Unit));
    assertEquals(std$fs$append_text(file, "two ä"), Ok(Unit));
    assertEquals(await Deno.readFile(file), new TextEncoder().encode("one\ntwo ä"));
    assertEquals(std$fs$append_text(join(dir, "missing", "a.txt"), "x"), NOT_FOUND);
    assertEquals(std$fs$append_text("", "x"), NOT_FOUND);
    assertEquals(std$fs$append_text(dir, "x"), IS_A_DIRECTORY);
    assertEquals(other(std$fs$append_text(join(file, "x"), "x")), "Other");
    if (MODES) await withMode(dir, 0o555, () => assertEquals(std$fs$append_text(join(dir, "b.txt"), "x"), DENIED));
  });
});

Deno.test("io: list_directory gives the names in the order of std.string.compare", async () => {
  await inTemp(async (dir) => {
    // Created out of order. U+FF5A sorts before the emoji by scalar value,
    // after it by UTF-16 code unit.
    for (const name of ["😀", "b", "ｚ", ".hidden", "ä", "a"]) await Deno.writeTextFile(join(dir, name), "");
    await Deno.mkdir(join(dir, "Z"));
    await Deno.writeTextFile(join(dir, "Z", "inner"), "");
    // Hidden entries included, no `.` or `..`, not recursive.
    assertEquals(std$fs$list_directory(dir), Ok([".hidden", "Z", "a", "b", "ä", "ｚ", "😀"]));
    assertEquals(std$fs$list_directory(join(dir, "Z")), Ok(["inner"]));
    await Deno.mkdir(join(dir, "empty"));
    assertEquals(std$fs$list_directory(join(dir, "empty")), Ok([]));
    assertEquals(std$fs$list_directory(join(dir, "missing")), NOT_FOUND);
    assertEquals(std$fs$list_directory(""), NOT_FOUND);
    assertEquals(other(std$fs$list_directory(join(dir, "a"))), "Other");
    if (MODES) await withMode(dir, 0o000, () => assertEquals(std$fs$list_directory(dir), DENIED));
  });
});

Deno.test("io: kind tells a file from a directory, following links", async () => {
  await inTemp(async (dir) => {
    const file = join(dir, "a.txt");
    await Deno.writeTextFile(file, "");
    assertEquals(std$fs$kind(file), Ok({ tag: "File" }));
    assertEquals(std$fs$kind(dir), Ok({ tag: "Directory" }));
    assertEquals(std$fs$kind(join(dir, "missing")), NOT_FOUND);
    assertEquals(std$fs$kind(""), NOT_FOUND);
    assertEquals(other(std$fs$kind(join(file, "x"))), "Other");
    if (LINUX) {
      // Neither a file nor a directory to the host, a file to alang.
      assertEquals(std$fs$kind("/dev/null"), Ok({ tag: "File" }));
      await Deno.symlink(dir, join(dir, "to_dir"));
      assertEquals(std$fs$kind(join(dir, "to_dir")), Ok({ tag: "Directory" }));
      await Deno.symlink(join(dir, "nothing"), join(dir, "broken"));
      assertEquals(std$fs$kind(join(dir, "broken")), NOT_FOUND);
    }
  });
});

Deno.test("io: create_directory creates the missing parents and accepts an existing directory", async () => {
  await inTemp(async (dir) => {
    const deep = join(dir, "a", "b", "c");
    assertEquals(std$fs$create_directory(deep), Ok(Unit));
    assert_((await Deno.stat(deep)).isDirectory);
    assertEquals(std$fs$create_directory(deep), Ok(Unit));
    await Deno.writeTextFile(join(dir, "file"), "");
    assertEquals(other(std$fs$create_directory(join(dir, "file"))), "Other");
    assertEquals(other(std$fs$create_directory(join(dir, "file", "sub"))), "Other");
    assertEquals(std$fs$create_directory(""), NOT_FOUND);
    if (MODES) await withMode(dir, 0o555, () => assertEquals(std$fs$create_directory(join(dir, "new")), DENIED));
  });
});

Deno.test("io: remove takes a file, a link or an empty directory", async () => {
  await inTemp(async (dir) => {
    const file = join(dir, "a.txt");
    await Deno.writeTextFile(file, "kept");
    await Deno.mkdir(join(dir, "full"));
    await Deno.writeTextFile(join(dir, "full", "x"), "");
    // A directory with entries stays.
    assertEquals(other(std$fs$remove(join(dir, "full"))), "Other");
    assertEquals(std$fs$list_directory(join(dir, "full")), Ok(["x"]));
    assertEquals(std$fs$remove(join(dir, "missing")), NOT_FOUND);
    assertEquals(std$fs$remove(""), NOT_FOUND);
    if (MODES) await withMode(dir, 0o555, () => assertEquals(std$fs$remove(file), DENIED));
    if (LINUX) {
      // The link goes, its target stays.
      await Deno.symlink(file, join(dir, "link"));
      assertEquals(std$fs$remove(join(dir, "link")), Ok(Unit));
      assertEquals(await Deno.readTextFile(file), "kept");
    }
    assertEquals(std$fs$remove(file), Ok(Unit));
    assertEquals(std$fs$remove(join(dir, "full", "x")), Ok(Unit));
    assertEquals(std$fs$remove(join(dir, "full")), Ok(Unit));
    assertEquals(std$fs$list_directory(dir), Ok([]));
  });
});

Deno.test("io: env.get reads a variable; None if it is not set or cannot exist", () => {
  Deno.env.set("ALANG_IO_GET", "a value");
  Deno.env.set("ALANG_IO_EMPTY", "");
  try {
    assertEquals(std$env$get("ALANG_IO_GET"), Some("a value"));
    assertEquals(std$env$get("ALANG_IO_EMPTY"), Some(""));
    assertEquals(std$env$get("ALANG_IO_UNSET"), None);
    // Names no variable can have.
    assertEquals(std$env$get(""), None);
    assertEquals(std$env$get("A=B"), None);
    assertEquals(std$env$get("A\0B"), None);
  } finally {
    Deno.env.delete("ALANG_IO_GET");
    Deno.env.delete("ALANG_IO_EMPTY");
  }
});

// ---- programs: input and the permissions of main's effects ----

// A `main` in module `name` with the given body.
function mainWith(name: string, effects: string, body: string[]): string {
  return [
    `fn ${name}.main`,
    '  doc: "Runs the steps of a test."',
    "  in: none",
    "  out: Unit",
    `  effects: ${effects}`,
    "  requires: none",
    "  ensures: none",
    "  examples: none",
    "  body:",
    ...body.map((line) => `    ${line}`),
    `end fn ${name}.main`,
  ].join("\n");
}

// A `main` that binds `call` and prints it.
function mainCalling(name: string, effects: string, type: string, call: string): string {
  return mainWith(name, effects, [
    `let outcome: ${type} = ${call}`,
    "std.console.print_line(text: std.text.show(value: outcome))",
    "return Unit",
  ]);
}

const UNIT_RESULT = "Result<Unit, std.fs.Error>";

// Each needs its effect; started with `console` only, each traps.
const NEEDING: [string, string, string, string][] = [
  ["std.fs.read_text", "fs.read", "Result<String, std.fs.Error>", 'std.fs.read_text(path: "a.txt")'],
  ["std.fs.write_text", "fs.write", UNIT_RESULT, 'std.fs.write_text(path: "a.txt", text: "x")'],
  ["std.fs.append_text", "fs.write", UNIT_RESULT, 'std.fs.append_text(path: "a.txt", text: "x")'],
  ["std.fs.create_directory", "fs.write", UNIT_RESULT, 'std.fs.create_directory(path: "a")'],
  ["std.fs.remove", "fs.write", UNIT_RESULT, 'std.fs.remove(path: "a.txt")'],
  ["std.fs.list_directory", "fs.read", "Result<List<String>, std.fs.Error>", 'std.fs.list_directory(path: ".")'],
  ["std.fs.kind", "fs.read", "Result<std.fs.Kind, std.fs.Error>", 'std.fs.kind(path: "a.txt")'],
  ["std.env.get", "env", "Option<String>", 'std.env.get(name: "HOME")'],
];

// The module of the `main` that calls a std function.
const moduleFor = (fn: string) => fn.split(".").pop()!;

let builds = 0;
async function program(...texts: string[]): Promise<Built> {
  return (await accept(texts.join("\n\n"), `${OUT}program_${builds++}.ts`)).built;
}

async function runIn(
  built: Built,
  options: Omit<RunOptions, "stdio" | "cwd"> = {},
): Promise<{ code: number; stdout: string; stderr: string; cwd: string }> {
  const cwd = await Deno.makeTempDir({ prefix: "alang-io-run-" });
  const out = await run(built, { stdio: "piped", cwd, ...options });
  return { code: out.code, stdout: decode(out.stdout), stderr: decode(out.stderr), cwd };
}

Deno.test("io: a file or environment operation outside main's effects traps", async () => {
  const built = await program(
    ...NEEDING.map(([fn, effect, type, call]) => mainCalling(moduleFor(fn), `${effect}, console`, type, call)),
  );
  for (const [fn, effect] of NEEDING) {
    const r = await runIn(built, { main: `${moduleFor(fn)}.main`, effects: ["console"] });
    assertEquals([r.code, r.stdout], [70, ""], r.stderr);
    const trap = JSON.parse(r.stderr);
    assertEquals([trap.trap, trap.definition], ["effect", fn]);
    assert_(trap.message.includes(`\`${effect}\``), trap.message);
    await Deno.remove(r.cwd, { recursive: true });
  }
});

Deno.test("io: fs.write alone creates, writes, appends and removes", async () => {
  const body = [
    'let made: Result<Unit, std.fs.Error> = std.fs.create_directory(path: "d/e")',
    'let written: Result<Unit, std.fs.Error> = std.fs.write_text(path: "d/e/f.txt", text: "a")',
    'let appended: Result<Unit, std.fs.Error> = std.fs.append_text(path: "d/e/f.txt", text: "b")',
    'let spare: Result<Unit, std.fs.Error> = std.fs.write_text(path: "d/e/g.txt", text: "x")',
    'let removed: Result<Unit, std.fs.Error> = std.fs.remove(path: "d/e/g.txt")',
    "let all: List<Result<Unit, std.fs.Error>> = std.list.append(list: std.list.append(list: std.list.append(list: std.list.append(list: std.list.append(list: std.list.empty<Result<Unit, std.fs.Error>>(), item: made), item: written), item: appended), item: spare), item: removed)",
    "std.console.print_line(text: std.text.show(value: all))",
    "return Unit",
  ];
  const r = await runIn(await program(mainWith("writer", "fs.write, console", body)));
  assertEquals([r.code, r.stdout, r.stderr], [0, "[Ok(Unit), Ok(Unit), Ok(Unit), Ok(Unit), Ok(Unit)]\n", ""]);
  assertEquals(await Deno.readTextFile(join(r.cwd, "d", "e", "f.txt")), "ab");
  assertEquals((await Array.fromAsync(Deno.readDir(join(r.cwd, "d", "e")))).map((e) => e.name), ["f.txt"]);
  await Deno.remove(r.cwd, { recursive: true });
});

Deno.test("io: a path the host guards is refused by the system with fs.read, a trap without it", async () => {
  if (!LINUX) return;
  const built = await program(
    mainCalling(
      "guarded",
      "fs.read, console",
      "Result<String, std.fs.Error>",
      'std.fs.read_text(path: "/proc/version")',
    ),
  );
  const allowed = await runIn(built);
  assertEquals([allowed.code, allowed.stdout, allowed.stderr], [0, "Err(PermissionDenied)\n", ""]);
  const refused = await runIn(built, { effects: ["console"] });
  assertEquals([refused.code, JSON.parse(refused.stderr).trap], [70, "effect"]);
  for (const r of [allowed, refused]) await Deno.remove(r.cwd, { recursive: true });
});

Deno.test("io: a program reads its arguments and the lines of its console", async () => {
  const built = await program(mainWith("input", "env, console", [
    "std.console.print_line(text: std.text.show(value: std.env.args()))",
    ...Array(6).fill("std.console.print_line(text: std.text.show(value: std.console.read_line()))"),
    "return Unit",
  ]));
  // The arguments arrive unchanged, a `--` and an empty one included. A
  // carriage return before the line feed goes too; an empty line is a line;
  // a last line without a line break is one; then the input has ended.
  const r = await runIn(built, { args: ["one", "two words", "--", "--flag", ""], stdin: "first\r\nsecond ä\n\nlast" });
  assertEquals([r.code, r.stderr], [0, ""]);
  assertEquals(r.stdout.split("\n"), [
    '["one", "two words", "--", "--flag", ""]',
    'Some("first")',
    'Some("second ä")',
    'Some("")',
    'Some("last")',
    "None",
    "None",
    "",
  ]);
  // Without input (`stdio: "piped"`), the console has ended at once; the
  // arguments need no permission.
  const bare = await runIn(built, { effects: ["console"] });
  assertEquals([bare.code, bare.stdout, bare.stderr], [0, "[]\nNone\nNone\nNone\nNone\nNone\nNone\n", ""]);
  for (const done of [r, bare]) await Deno.remove(done.cwd, { recursive: true });
});
