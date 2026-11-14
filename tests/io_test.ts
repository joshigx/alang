// Files and program I/O in std: the runtime in this process (Deno), one
// temporary directory per test, then compiled programs as their own
// processes, for the program's input and the permission traps.

import { join } from "node:path";
import { assert_, assertEquals, assertThrows } from "./assert.ts";
import { ENDING_PROGRAM, IO_ARGS, IO_ENV, IO_PROGRAM, IO_STDERR, IO_STDIN, IO_STDOUT } from "./io_program.ts";
import {
  Err,
  None,
  Ok,
  Some,
  std$env$get,
  std$fs$append_text,
  std$fs$create_directory,
  std$fs$create_text,
  type std$fs$Error,
  std$fs$kind,
  std$fs$list_directory,
  std$fs$read_text,
  std$fs$remove,
  std$fs$write_text,
  std$int$parse,
  std$random$int,
  std$string$join,
  std$string$split,
  std$time$now_milliseconds,
  std$time$wait,
  Trap,
  Unit,
} from "../src/runtime.ts";
import { accept, type Built, findMain, run, type RunOptions, writeEntry } from "../src/toolchain.ts";
import { AlangError } from "../src/diagnostic.ts";
import { parseProgram } from "../src/parser.ts";

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
const ALREADY_EXISTS = Err<std$fs$Error>({ tag: "AlreadyExists" });

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

Deno.test("io: create_text creates a file only if nothing is at the path", async () => {
  await inTemp(async (dir) => {
    const file = join(dir, "a.txt");
    assertEquals(std$fs$create_text(file, "ä\n😀"), Ok(Unit));
    assertEquals(await Deno.readFile(file), new TextEncoder().encode("ä\n😀"));
    // Never overwrites: the second call finds the file, which stays.
    assertEquals(std$fs$create_text(file, "again"), ALREADY_EXISTS);
    assertEquals(await Deno.readTextFile(file), "ä\n😀");
    assertEquals(std$fs$create_text(dir, "x"), ALREADY_EXISTS);
    assertEquals(std$fs$create_text(join(dir, "missing", "a.txt"), "x"), NOT_FOUND);
    assertEquals(std$fs$create_text("", "x"), NOT_FOUND);
    assertEquals(other(std$fs$create_text(join(file, "x"), "x")), "Other");
    if (MODES) await withMode(dir, 0o555, () => assertEquals(std$fs$create_text(join(dir, "b.txt"), "x"), DENIED));
    if (LINUX) {
      // A link is something at the path, followed or not; it stays.
      await Deno.symlink(file, join(dir, "link"));
      await Deno.symlink(join(dir, "nothing"), join(dir, "broken"));
      for (const link of ["link", "broken"]) {
        assertEquals(std$fs$create_text(join(dir, link), "x"), ALREADY_EXISTS, link);
        assert_((await Deno.lstat(join(dir, link))).isSymlink, link);
      }
      assertEquals(await Deno.readTextFile(file), "ä\n😀");
      assertEquals(std$fs$list_directory(dir), Ok(["a.txt", "broken", "link"]));
    }
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
    // A file at the path is already there; a file as a parent is in the way.
    assertEquals(std$fs$create_directory(join(dir, "file")), ALREADY_EXISTS);
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

// A link whose target is missing names nothing, alike on every host and
// with every permission (the tasks round, 2026-11-14: on Deno it was `Other`,
// "Too many levels of symbolic links"; on Node.js a write created the target).
Deno.test("io: a dangling link is NotFound, but already there for creating; remove takes the link", async () => {
  if (!LINUX) return;
  await inTemp(async (dir) => {
    const at = (name: string) => join(dir, name);
    await Deno.symlink("target.txt", at("dangling"));
    await Deno.symlink("dangling", at("chain"));
    await Deno.symlink("missing", at("nowhere"));
    await Deno.symlink("loop2", at("loop"));
    await Deno.symlink("loop", at("loop2"));
    for (const path of [at("dangling"), at("chain"), join(at("nowhere"), "a.txt")]) {
      assertEquals(std$fs$read_text(path), NOT_FOUND, path);
      // Not followed: the target is not created.
      assertEquals(std$fs$write_text(path, "x"), NOT_FOUND, path);
      assertEquals(std$fs$append_text(path, "x"), NOT_FOUND, path);
      assertEquals(std$fs$kind(path), NOT_FOUND, path);
      assertEquals(std$fs$list_directory(path), NOT_FOUND, path);
      // At the path or on the way, as `mkdir -p` says "File exists".
      assertEquals(std$fs$create_directory(path), ALREADY_EXISTS, path);
    }
    assertEquals(std$fs$create_directory(join(at("nowhere"), "sub")), ALREADY_EXISTS);
    // create_text never follows a link: one at the path is there; through
    // one on the way there is no parent.
    assertEquals(std$fs$create_text(at("dangling"), "x"), ALREADY_EXISTS);
    assertEquals(std$fs$create_text(at("chain"), "x"), ALREADY_EXISTS);
    assertEquals(std$fs$create_text(join(at("nowhere"), "a.txt"), "x"), NOT_FOUND);
    assertEquals(std$fs$list_directory(dir), Ok(["chain", "dangling", "loop", "loop2", "nowhere"]));
    // A loop is not missing: Other, whatever the operation.
    assertEquals(other(std$fs$read_text(at("loop"))), "Other");
    assertEquals(other(std$fs$write_text(at("loop"), "x")), "Other");
    assertEquals(other(std$fs$kind(at("loop"))), "Other");
    // remove takes the link itself.
    assertEquals(std$fs$remove(at("dangling")), Ok(Unit));
    assertEquals(std$fs$remove(at("loop")), Ok(Unit));
    assertEquals(std$fs$list_directory(dir), Ok(["chain", "loop2", "nowhere"]));
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

Deno.test("io: int.parse reads an optional - and the digits 0 to 9, as its doc says", () => {
  assertEquals(std$int$parse("42"), Some(42));
  assertEquals(std$int$parse("-17"), Some(-17));
  // Leading zeros are allowed, unlike in a literal (4.7).
  assertEquals(std$int$parse("007"), Some(7));
  const zero = std$int$parse("-0");
  assert_(zero.tag === "Some" && zero.value === 0, JSON.stringify(zero));
  assertEquals(std$int$parse("9007199254740991"), Some(Number.MAX_SAFE_INTEGER));
  assertEquals(std$int$parse("-9007199254740991"), Some(-Number.MAX_SAFE_INTEGER));
  for (const text of ["+1", "1_000", " 1", "1 ", "1\n", "", "-", "--1", "1.0", "0x10", "\u0661", "9007199254740992"]) {
    assertEquals(std$int$parse(text), None, JSON.stringify(text));
  }
  assertEquals(std$int$parse("-9007199254740992"), None);
});

Deno.test("io: split is the inverse of join", () => {
  assertEquals(std$string$split("a,b,,c", ","), ["a", "b", "", "c"]);
  assertEquals(std$string$split("", ","), [""]);
  assertEquals(std$string$split(",", ","), ["", ""]);
  assertEquals(std$string$split("abc", ","), ["abc"]);
  assertEquals(std$string$split("a::b::", "::"), ["a", "b", ""]);
  assertEquals(std$string$split("ä😀ä", "😀"), ["ä", "ä"]);
  for (const text of ["a,b,,c", "", ",", "abc", "line\n"]) {
    assertEquals(std$string$join(std$string$split(text, ","), ","), text);
  }
  const trap = assertThrows(() => std$string$split("abc", ""), Trap);
  assertEquals([trap.kind, trap.definition], ["requires", "std.string.split"]);
});

Deno.test("io: random.int draws from low to high, both included", () => {
  const seen = new Set<number>();
  for (let i = 0; i < 1000; i++) {
    const n = std$random$int(3, 7);
    assert_(Number.isSafeInteger(n) && 3 <= n && n <= 7, String(n));
    seen.add(n);
  }
  assertEquals([...seen].sort(), [3, 4, 5, 6, 7]);
  assertEquals(std$random$int(-4, -4), -4);
  const reversed = assertThrows(() => std$random$int(2, 1), Trap);
  assertEquals([reversed.kind, reversed.definition], ["requires", "std.random.int"]);
  // More values than an Int can count.
  const wide = assertThrows(() => std$random$int(-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), Trap);
  assertEquals([wide.kind, wide.definition], ["overflow", "std.random.int"]);
  const widest = std$random$int(0, Number.MAX_SAFE_INTEGER - 1);
  assert_(Number.isSafeInteger(widest) && widest >= 0, String(widest));
});

Deno.test("io: now_milliseconds is the clock's time", () => {
  const before = Date.now();
  const now = std$time$now_milliseconds();
  const after = Date.now();
  assert_(Number.isSafeInteger(now) && before <= now && now <= after, `${before} ${now} ${after}`);
});

Deno.test("io: wait waits, at least the time it is given", async () => {
  const start = performance.now();
  assertEquals(await std$time$wait(50), Unit);
  const waited = performance.now() - start;
  assert_(waited >= 49, `${waited} ms`);
  assertEquals(await std$time$wait(0), Unit);
  let refused: unknown = null;
  await std$time$wait(-1).catch((e) => (refused = e));
  assert_(refused instanceof Trap, String(refused));
  assertEquals([refused.kind, refused.definition, refused.at], ["requires", "std.time.wait", "milliseconds >= 0"]);
});

Deno.test("io: a wait longer than setTimeout holds is a chain of timers", async () => {
  // Each timer records its delay and fires at once.
  const delays: number[] = [];
  const original = globalThis.setTimeout;
  globalThis.setTimeout = ((done: () => void, delay: number) => {
    delays.push(delay);
    done();
    return 0;
  }) as unknown as typeof setTimeout;
  try {
    assertEquals(await std$time$wait(5_000_000_000), Unit);
  } finally {
    globalThis.setTimeout = original;
  }
  assertEquals(delays, [2_147_483_647, 2_147_483_647, 705_032_706]);
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
  ["std.fs.create_text", "fs.write", UNIT_RESULT, 'std.fs.create_text(path: "a.txt", text: "x")'],
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
    'let created: Result<Unit, std.fs.Error> = std.fs.create_text(path: "d/e/h.txt", text: "c")',
    'let spare: Result<Unit, std.fs.Error> = std.fs.write_text(path: "d/e/g.txt", text: "x")',
    'let removed: Result<Unit, std.fs.Error> = std.fs.remove(path: "d/e/g.txt")',
    "let all: List<Result<Unit, std.fs.Error>> = [made, written, appended, created, spare, removed]",
    "std.console.print_line(text: std.text.show(value: all))",
    "return Unit",
  ];
  const r = await runIn(await program(mainWith("writer", "fs.write, console", body)));
  assertEquals([r.code, r.stdout, r.stderr], [0, "[Ok(Unit), Ok(Unit), Ok(Unit), Ok(Unit), Ok(Unit), Ok(Unit)]\n", ""]);
  assertEquals(await Deno.readTextFile(join(r.cwd, "d", "e", "f.txt")), "ab");
  assertEquals(await Deno.readTextFile(join(r.cwd, "d", "e", "h.txt")), "c");
  const names = (await Array.fromAsync(Deno.readDir(join(r.cwd, "d", "e")))).map((e) => e.name).sort();
  assertEquals(names, ["f.txt", "h.txt"]);
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

async function hasNode(): Promise<boolean> {
  const node = await new Deno.Command("node", { args: ["--version"], stdout: "null", stderr: "null" }).output()
    .catch(() => null);
  return node?.success ?? false;
}

// The same program gives the same output on both hosts: runtime neutrality.
for (const host of ["deno", "node"] as const) {
  Deno.test(`io: files, arguments, environment, console and log alike on every host (${host})`, async () => {
    if (host === "node" && !(await hasNode())) return;
    const built = await program(IO_PROGRAM);
    const cwd = await Deno.makeTempDir({ prefix: "alang-io-host-" });
    for (const [name, value] of Object.entries(IO_ENV)) Deno.env.set(name, value);
    try {
      let out: Deno.CommandOutput;
      if (host === "deno") {
        out = await run(built, { stdio: "piped", cwd, args: IO_ARGS, stdin: IO_STDIN });
      } else {
        const child = new Deno.Command("node", {
          args: [await writeEntry(built), ...IO_ARGS],
          cwd,
          stdin: "piped",
          stdout: "piped",
          stderr: "piped",
        }).spawn();
        const writer = child.stdin.getWriter();
        await writer.write(new TextEncoder().encode(IO_STDIN));
        await writer.close();
        out = await child.output();
      }
      assertEquals([out.code, decode(out.stdout), decode(out.stderr)], [0, IO_STDOUT, IO_STDERR]);
      // What the program left behind.
      assertEquals((await Array.fromAsync(Deno.readDir(cwd))).map((e) => e.name), ["work"]);
    } finally {
      for (const name of Object.keys(IO_ENV)) Deno.env.delete(name);
      await Deno.remove(cwd, { recursive: true });
    }
  });
}

// Every std.fs function on links, as a program sees them, on both hosts:
// `Other` messages differ between hosts and are left out.
const LINK_CALLS = [
  'std.fs.read_text(path: "dangling")',
  'std.fs.write_text(path: "dangling", text: "x")',
  'std.fs.append_text(path: "dangling", text: "x")',
  'std.fs.kind(path: "dangling")',
  'std.fs.list_directory(path: "dangling")',
  'std.fs.create_directory(path: "dangling")',
  'std.fs.write_text(path: "chain", text: "x")',
  'std.fs.write_text(path: "nowhere/a.txt", text: "x")',
  'std.fs.create_directory(path: "nowhere/sub")',
  'std.fs.read_text(path: "loop")',
  'std.fs.write_text(path: "loop", text: "x")',
  'std.fs.write_text(path: "good", text: "through the link")',
  'std.fs.create_text(path: "dangling", text: "x")',
  'std.fs.create_text(path: "nowhere/a.txt", text: "x")',
  'std.fs.create_text(path: "good", text: "x")',
  'std.fs.remove(path: "dangling")',
];
const linksMain = (name: string, effects: string, calls: string[]) =>
  mainWith(name, effects, [
    ...calls.map((call) => `std.console.print_line(text: std.text.show(value: ${call}))`),
    "return Unit",
  ]);
const LINK_RESULTS = [
  "Err(NotFound)",
  "Err(NotFound)",
  "Err(NotFound)",
  "Err(NotFound)",
  "Err(NotFound)",
  "Err(AlreadyExists)",
  "Err(NotFound)",
  "Err(NotFound)",
  "Err(AlreadyExists)",
  "Err(Other)",
  "Err(Other)",
  "Ok(Unit)",
  "Err(AlreadyExists)",
  "Err(NotFound)",
  "Err(AlreadyExists)",
  "Ok(Unit)",
];

for (const host of ["deno", "node"] as const) {
  Deno.test(`io: links behave alike on every host and with fs.write alone (${host})`, async () => {
    if (!LINUX || (host === "node" && !(await hasNode()))) return;
    // Without fs.read only writing is possible: those calls.
    const writing = LINK_CALLS.flatMap((call, i) =>
      /write_text|append_text|create_text|create_directory|remove/.test(call) ? [i] : []
    );
    const built = await program(
      linksMain("links", "fs.read, fs.write, console", LINK_CALLS),
      linksMain("writing", "fs.write, console", writing.map((i) => LINK_CALLS[i])),
    );
    for (
      const [main, expected] of [
        ["links.main", LINK_RESULTS],
        // Deno without fs.read cannot tell a loop from a dangling link.
        ["writing.main", writing.map((i) => host === "deno" && i === 10 ? "Err(NotFound)" : LINK_RESULTS[i])],
      ] as const
    ) {
      const cwd = await Deno.makeTempDir({ prefix: "alang-io-links-" });
      try {
        await Deno.writeTextFile(join(cwd, "real.txt"), "r");
        for (
          const [link, target] of [
            ["dangling", "target.txt"],
            ["chain", "dangling"],
            ["nowhere", "missing"],
            ["loop", "loop2"],
            ["loop2", "loop"],
            ["good", "real.txt"],
          ]
        ) await Deno.symlink(target, join(cwd, link));
        const out = host === "deno" ? await run(built, { stdio: "piped", cwd, main }) : await new Deno.Command("node", {
          args: [await writeEntry(built, main)],
          cwd,
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
        }).output();
        assertEquals([out.code, decode(out.stderr)], [0, ""], main);
        const shown = decode(out.stdout).replaceAll(/Other\("[^\n]*"\)/g, "Other");
        assertEquals(shown.split("\n"), [...expected, ""], main);
        // No target was created; the link to a file was followed.
        const names = (await Array.fromAsync(Deno.readDir(cwd))).map((e) => e.name).sort();
        assertEquals(names, ["chain", "good", "loop", "loop2", "nowhere", "real.txt"], main);
        assertEquals(await Deno.readTextFile(join(cwd, "real.txt")), "through the link", main);
      } finally {
        await Deno.remove(cwd, { recursive: true });
      }
    }
  });
}

// What the doc lines of read_text and read_line say about decoding: bytes
// that are not UTF-8 become U+FFFD (one per maximal invalid sequence), a byte
// order mark at the start stays, line ends stay in a file; alike on both hosts.
const DECODING_PROGRAM = mainWith("decoding", "fs.read, console", [
  'let text: String = std.fs.read_text(path: "in.txt") else return Unit',
  "std.console.print_line(text: std.text.show(value: std.string.code_points(text: text)))",
  ...Array(2).fill([
    "std.console.print_line(text: std.text.show(value: std.option.map(option: std.console.read_line(), " +
    "with: fn(line: String): List<Int> => std.string.code_points(text: line))))",
  ]).flat(),
  "return Unit",
]);
// A byte order mark, an invalid byte, CR LF, a truncated sequence, an
// overlong one, and a byte order mark inside the text.
const UNDECODABLE = [
  0xef,
  0xbb,
  0xbf,
  0x61,
  0xff,
  0x62,
  0x0d,
  0x0a,
  0xe2,
  0x82,
  0x41,
  0xc0,
  0xaf,
  0x0a,
  0x63,
  0xef,
  0xbb,
  0xbf,
];
for (const host of ["deno", "node"] as const) {
  Deno.test(`io: read_text and read_line decode alike, as their docs say (${host})`, async () => {
    if (host === "node" && !(await hasNode())) return;
    const built = await program(DECODING_PROGRAM);
    const cwd = await Deno.makeTempDir({ prefix: "alang-io-decoding-" });
    try {
      await Deno.writeFile(join(cwd, "in.txt"), new Uint8Array(UNDECODABLE));
      // The console gets bytes, which `RunOptions.stdin` (a text) cannot hold:
      // started by hand, on Deno with the permission of its effects.
      const entry = await writeEntry(built);
      const child = new Deno.Command(host === "deno" ? Deno.execPath() : "node", {
        args: host === "deno" ? ["run", "--allow-read", entry] : [entry],
        cwd,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const writer = child.stdin.getWriter();
      await writer.write(new Uint8Array(UNDECODABLE));
      await writer.close();
      const out = await child.output();
      assertEquals([out.code, decode(out.stderr)], [0, ""]);
      assertEquals(decode(out.stdout).split("\n"), [
        "[65279, 97, 65533, 98, 13, 10, 65533, 65, 65533, 65533, 10, 99, 65279]",
        "Some([65279, 97, 65533, 98])",
        "Some([65533, 65, 65533, 65533])",
        "",
      ]);
    } finally {
      await Deno.remove(cwd, { recursive: true });
    }
  });
}

// ---- ending with an error ----

for (const host of ["deno", "node"] as const) {
  Deno.test(`io: a main that returns Err ends with its message and exit code 1 (${host})`, async () => {
    if (host === "node" && !(await hasNode())) return;
    const built = await program(ENDING_PROGRAM);
    const entry = await writeEntry(built);
    const start = async (args: string[]) => {
      const out = host === "deno"
        ? await run(built, { stdio: "piped", args })
        : await new Deno.Command("node", { args: [entry, ...args], stdin: "null", stdout: "piped", stderr: "piped" })
          .output();
      return [out.code, decode(out.stdout), decode(out.stderr)];
    };
    assertEquals(await start([]), [1, "> ", "no input\n"]);
    assertEquals(await start(["given"]), [0, "> given\n", ""]);
  });
}

Deno.test("io: main returns Unit or Result<Unit, String>, and takes nothing (E0305)", () => {
  const main = (out: string, params = "  in: none") =>
    parseProgram(
      ENDING_PROGRAM.replace("  out: Result<Unit, String>", `  out: ${out}`).replace("  in: none", params),
    );
  assertEquals(findMain(main("Unit")).out.path, ["Unit"]);
  assertEquals(findMain(main("Result<Unit, String>")).out.path, ["Result"]);
  for (const out of ["Int", "Result<Unit, Int>", "Result<String, String>", "Option<Unit>"]) {
    const e = assertThrows(() => findMain(main(out)), AlangError);
    assertEquals([e.diagnostic.code, e.diagnostic.message], [
      "E0305",
      "`main` has `in: none`, and `out: Unit` or `out: Result<Unit, String>`.",
    ], out);
  }
  const withParam = assertThrows(() => findMain(main("Unit", "  in:\n    text: String")), AlangError);
  assertEquals(withParam.diagnostic.code, "E0305");
});

Deno.test("io: examples/lines.alang sorts the lines of a file into another", async () => {
  const source = await Deno.readTextFile(new URL("../examples/lines.alang", import.meta.url));
  const built = (await accept(source, `${OUT}lines.ts`)).built;
  const cwd = await Deno.makeTempDir({ prefix: "alang-io-lines-" });
  try {
    await Deno.writeTextFile(join(cwd, "in.txt"), "pear\napple\n\nfig");
    const start = async (args: string[]) => {
      const out = await run(built, { stdio: "piped", cwd, args });
      return [out.code, decode(out.stdout), decode(out.stderr)];
    };
    assertEquals(await start(["in.txt", "out.txt"]), [0, "", ""]);
    assertEquals(await Deno.readTextFile(join(cwd, "out.txt")), "apple\nfig\npear\n");
    assertEquals(await start(["in.txt"]), [1, "", "usage: lines <source> <target>\n"]);
    assertEquals(await start(["missing.txt", "out.txt"]), [
      1,
      "",
      "cannot read the source: no such file or directory\n",
    ]);
    assertEquals(await start(["in.txt", "no/such/dir.txt"]), [
      1,
      "",
      "cannot write the target: no such file or directory\n",
    ]);
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

// The program the std-maps phase was built for: a Map counted in a fold,
// sorting by two keys, padding and fixed decimals, alike on both hosts.
for (const host of ["deno", "node"] as const) {
  Deno.test(`io: examples/words.alang counts the words of a file (${host})`, async () => {
    if (host === "node" && !(await hasNode())) return;
    const source = await Deno.readTextFile(new URL("../examples/words.alang", import.meta.url));
    const built = (await accept(source, `${OUT}words_${host}.ts`)).built;
    const entry = await writeEntry(built);
    const cwd = await Deno.makeTempDir({ prefix: "alang-io-words-" });
    try {
      await Deno.writeTextFile(join(cwd, "in.txt"), "The cat saw the dog.\nThe dog ran!\n");
      const start = async (args: string[]) => {
        const out = host === "deno" ? await run(built, { stdio: "piped", cwd, args }) : await new Deno.Command("node", {
          args: [entry, ...args],
          cwd,
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
        })
          .output();
        return [out.code, decode(out.stdout), decode(out.stderr)];
      };
      assertEquals(await start(["in.txt"]), [
        0,
        "8 words, 5 different\n     3   37.5%  the\n     2   25.0%  dog\n     1   12.5%  cat\n",
        "",
      ]);
      assertEquals(await start([]), [1, "", "usage: words <file>\n"]);
      assertEquals(await start(["missing.txt"]), [1, "", "cannot read the file: no such file or directory\n"]);
    } finally {
      await Deno.remove(cwd, { recursive: true });
    }
  });
}
