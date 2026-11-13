# Plan: files and program I/O in std (branch `std-io`)

Written by the Fable planner, 2026-11-13. Probes were read-only, on Deno 2.8.0 and Node.js 26.13.0; Bun is not
installed. The user's answers to D1 to D5 (section 5) are recorded at the end; where they differ from a
recommendation, the answer wins.

## 0. Findings that shape the plan

- **One error type is forced.** `check.ts` `declare()` reports E0215 for a case name used twice in a module, and it
  runs over `STD_TYPES`. A second variant in `std.fs` cannot reuse `NotFound`, `PermissionDenied` or `Other`.
- **The case list is final once published.** E0227 forbids a catch-all and 3.8 freezes signatures, so a case added
  later breaks every `match`.
- **A text cannot be taken apart today.** std has `trim`, `length`, `concat`, `join` and `compare` only. Without
  `std.string.split`, "read a file, transform it, write it" is not expressible, so the plan pulls that one function
  forward (D3).
- **stdin already reaches the program.** `Deno.Command(...).spawn()` inherits stdin (probed with `cat`).
- **Synchronous reads work on both hosts.** `Deno.stdin.readSync` and `fs.readSync(0, ...)` read lines from a pipe and
  from a pty.
- **Deno guards some paths beyond the flags.** With `--allow-read`, `/proc/version` and `/sys/...` fail with
  `NotCapable: Requires all access`. Without the flag the same path says `Requires read access`. Today's `read_text`
  turns both into the "needs `fs.read`" trap; Node.js has no such guard.
- **Both hosts decode alike.** A byte order mark stays as U+FEFF and an invalid byte becomes U+FFFD in `read_text` on
  Deno and Node.js.
- **`--` passes through.** `deno task` and `deno run <script>` hand `--` to the script unchanged.
- **Nothing was written during planning.** Write-side OS codes were not observed (Deno's `/proc` guard intercepted the
  write probes). "P" marks a probed fact and "E" an expected one; the alang-level result is the spec and the tests
  settle the host codes.

## 1. Standard library

### 1.1 Types (`STD_TYPES_SOURCE`, in this order, before the http types)

`std.fs.Error` replaces `std.fs.ReadError` and stays first, because `tests/queries_test.ts` reads `STD_TYPES[0]`. Both
texts are canonical (checked with the printer).

```
type std.fs.Error
  doc: "Why a file or directory operation failed. Other carries the host's message, which differs between runtimes: show it, do not compare it."
  variant:
    NotFound
    PermissionDenied
    IsADirectory
    Other: String
  where: none
end type std.fs.Error

type std.fs.Kind
  doc: "What a path names. Everything that is not a directory counts as a file."
  variant:
    File
    Directory
  where: none
end type std.fs.Kind
```

- **Why one type, four cases (3.3, 3.8, 2.3):** every case is a promise that all hosts classify alike, and each one
  lengthens every exhaustive `match`. ENOTDIR, EEXIST and ENOTEMPTY therefore go to `Other`.
- **Cost:** none compared with today for `read_text` callers, since the cases are unchanged.

### 1.2 Functions (order in `STD`, which is the order of the 7.8 table)

Insert rows 1–3 after `std.console.print_line`, rows 5–10 after `std.fs.read_text`, rows 11–13 after
`std.http.serve`, and row 14 after `std.string.join`. The doc lines are exact.

| # | Signature | Effects | Doc |
| --- | --- | --- | --- |
| 1 | `std.console.read_line(): Option<String>` | console | Reads the next line from the console, without its line break; `None` at the end of the input. |
| 2 | `std.env.args(): List<String>` | env | The arguments the program was started with. |
| 3 | `std.env.get(name: String): Option<String>` | env | The value of an environment variable; `None` if it is not set. |
| 4 | `std.fs.read_text(path: String): Result<String, std.fs.Error>` (existing, type renamed) | fs.read | unchanged |
| 5 | `std.fs.write_text(path: String, text: String): Result<Unit, std.fs.Error>` | fs.write | Writes the text to a file as UTF-8, creating the file or replacing its content. |
| 6 | `std.fs.append_text(path: String, text: String): Result<Unit, std.fs.Error>` | fs.write | Adds the text to the end of a file as UTF-8, creating the file if it is missing. |
| 7 | `std.fs.list_directory(path: String): Result<List<String>, std.fs.Error>` | fs.read | The names of a directory's entries, in the order of `std.string.compare`; names, not paths. |
| 8 | `std.fs.kind(path: String): Result<std.fs.Kind, std.fs.Error>` | fs.read | Whether a path exists as a file or as a directory; `Err(NotFound)` if nothing is there. |
| 9 | `std.fs.create_directory(path: String): Result<Unit, std.fs.Error>` | fs.write | Creates a directory and its missing parents; `Ok` if it already exists. |
| 10 | `std.fs.remove(path: String): Result<Unit, std.fs.Error>` | fs.write | Removes a file or an empty directory. |
| 11 | `std.log.print_line(text: String): Unit` | log | Writes a line to the log, which is the standard error stream. |
| 12 | `std.random.int(low: Int, high: Int): Int` | random | A random integer from `low` to `high`, both included; traps if `low > high`. Not for secrets. |
| 13 | `std.time.now_milliseconds(): Int` | time | The clock's time in milliseconds since 1970-01-01T00:00:00Z. |
| 14 | `std.string.split(text: String, separator: String): List<String>` | none | The parts of the text between the separators; `std.string.join` with the same separator gives the text back. An empty separator traps. |

Why this set, by principle:

- **One module per effect (1):** `fs`, `env`, `console`, `log`, `time`, `random`. The name is guessable from the
  effect a function needs.
- **Uniform parameters (4.1):** `path` and `text` everywhere in `std.fs`.
- **`kind` instead of `exists` plus `is_directory` (3):** one function answers both questions.
  `std.fs.kind(path: p) == Err(std.fs.NotFound)` is the existence test, and a three-arm `match` (`Ok(std.fs.File)`,
  `Ok(std.fs.Directory)`, `Err(reason)`) walks a tree. Both forms type-check.
- **`append_text`:** without it a journal needs `fs.read` and rewrites the whole file.
- **`create_directory`:** `write_text` into a missing directory is `Err(NotFound)`, with no workaround.
- **`remove`:** the effect `fs.write` is defined as "creating, changing and deleting"; no workaround exists.
- **Units and bounds visible at the call (2, 4):** `now_milliseconds`; `low`/`high` both included, as in `math.clamp`.
- **Left out deliberately:** rename and copy (read plus write covers text); recursive remove (dangerous; recursion
  over `list_directory` does it); binary data (no byte type), metadata, path helpers (`concat` with `/` works on every
  system); `print` without a line break, waiting (`time`); an exit function (see D1).
- **All eight effects now have a function.**

### 1.3 Semantics: situation to result

Shared by all seven `std.fs` functions (one helper):

| Situation | Result | Seen |
| --- | --- | --- |
| Deno lacks the flag of the effect (`NotCapable`, "Requires read/write access") | trap `effect`, definition = the std function, `at` = the path | P read, stat, readDir; E write |
| Deno guards the path although the flag is there (`NotCapable`, message contains "all access": `/proc/...`, `/sys/...`) | `Err(PermissionDenied)`; without the flag the same path traps | P |
| Nothing at the path, or the parent directory is missing (ENOENT), also `""` | `Err(NotFound)` | P reads, mkdir, remove; E writes |
| The OS refuses (EACCES, EPERM) | `Err(PermissionDenied)` | P reads; E writes |
| A directory where a file is needed (EISDIR) | `Err(IsADirectory)` | P read; E write |
| Anything else: the path runs through a file (ENOTDIR), a file in the way (EEXIST), a directory that is not empty (ENOTEMPTY), disk full | `Err(Other(host message))` | P ENOTDIR and EEXIST; E the rest |
| No file system (neither `Deno` nor `process`) | trap `effect` | as today |

The guarded-path rule follows 2.5 and 5.3: a trap means the program does more than `main` declares, and here it does
not.

Per function:

| Function | Deno | Node.js and Bun (`process.getBuiltinModule("node:fs")`) | Specifics |
| --- | --- | --- | --- |
| `read_text` | `readTextFileSync(path)` | `readFileSync(path, "utf8")` | Invalid bytes read as U+FFFD; a byte order mark stays as U+FEFF (P, both). |
| `write_text` | `writeTextFileSync(path, text)` | `writeFileSync(path, text)` | Exactly the text's UTF-8 bytes: no line break added, no byte order mark. An existing file is replaced without a question. Links are followed. |
| `append_text` | `writeTextFileSync(path, text, { append: true })` | `appendFileSync(path, text)` | Creates the file if missing; the other cases as `write_text`. |
| `list_directory` | `[...readDirSync(path)].map((e) => e.name)` | `readdirSync(path)` | Sorted with `str_compare` (same order on every host, 3.7). Hidden entries included, no `.` or `..`, not recursive. An empty directory is `Ok` of the empty list. A file is `Err(Other)` (P). |
| `kind` | `statSync(path).isDirectory` | `statSync(path).isDirectory()` | Follows links; a broken link is `Err(NotFound)`. `/dev/null` is `File` (P: neither file nor directory on both hosts). |
| `create_directory` | `mkdirSync(path, { recursive: true })` | the same | An existing directory is `Ok(Unit)` (P). A file at the path is `Err(Other)` (P on Deno). Needs only `--allow-write` (P). |
| `remove` | `removeSync(path)` | `rmSync(path)`; on code `ERR_FS_EISDIR` or `EISDIR`, `rmdirSync(path)` | Removes a link itself, not its target. A directory with entries is `Err(Other)` and stays (E). |

The other functions:

| Function | Semantics | Deno | Node.js and Bun |
| --- | --- | --- | --- |
| `read_line` | Waits for a line. A line ends at `\n`; a `\r` directly before it is dropped too. An empty line is `Some("")`. A last line without a line break is returned, then `None`, and `None` again on every later call. Bytes decode as UTF-8 with U+FFFD for invalid ones (`new TextDecoder("utf-8", { ignoreBOM: true })`). A console that cannot be read counts as ended. No permission exists, so no trap. | `Deno.stdin.readSync(buffer)`, `null` = end | `fs.readSync(0, buffer)`, `0` = end; on `EAGAIN`, `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)` and retry (defensive, not observed) |
| `args` | The words after `--`, unchanged, without the program's name. Checker-enforced only: no permission exists. | `[...Deno.args]` | `process.argv.slice(2)` (holds for a file entry) |
| `get` | `None` if unset; `Some("")` if set to empty. A name no variable can have (empty, with `=` or NUL: Deno throws `TypeError`, P) is `None`. Without `--allow-env`: trap `effect` (P), "Reading environment variables needs the effect `env` on `main`." | `Deno.env.get(name)` | `Object.hasOwn(process.env, name) ? process.env[name] : undefined` (P: `process.env["toString"]` is a function) |
| `log.print_line` | One line to stderr; `std.console.print_line` stays on stdout. | `console.error(text)` | the same |
| `now_milliseconds` | An `Int` from the system clock. | `Date.now()` | the same |
| `random.int` | `low > high` traps (`requires`); more than 2^53 − 1 values traps (`overflow`). | `low + Math.min(count - 1, Math.floor(Math.random() * count))` | the same |
| `split` | `split("a,b,,c", ",")` gives `a`, `b`, `""`, `c`. `split("", ",")` gives one empty part and `split(",", ",")` two. A separator that does not occur gives the text as one part. `separator == ""` traps (`requires`); characters belong to the next phase. | `text.split(separator)` | the same |

- **Module state for `read_line`:** `consolePending: Uint8Array` and `consoleEnded: boolean` in `runtime.ts`, with a
  4096-byte read buffer. It is the only reader of stdin.
- **All new runtime functions are synchronous.** Generated code awaits them, as it does `read_text`.
- **Bun** takes the Node.js path and stays untested; record that in `notes.md`.

The helper (the mapping is load-bearing; `DenoFs` and `NodeFs` are structural types of exactly the members in the
tables):

```ts
function onFiles<T>(name: string, effect: "fs.read" | "fs.write", path: string,
  onDeno: (deno: DenoFs) => T, onNode: (fs: NodeFs) => T): Result<T, std$fs$Error> {
  const host = globalThis as Host;
  try {
    if (host.Deno) return Ok(onDeno(host.Deno));
    if (host.process) return Ok(onNode(host.process.getBuiltinModule("node:fs")));
  } catch (e) {
    const err = e as { name?: string; code?: string; message?: string };
    if (err.name === "NotCapable" && /\ball access\b/.test(String(err.message))) return Err({ tag: "PermissionDenied" });
    if (err.name === "NotCapable" || err.code === "ERR_ACCESS_DENIED") return trap("effect", name, path, NEEDS[effect]);
    if (err.code === "ENOENT") return Err({ tag: "NotFound" });
    if (err.code === "EACCES" || err.code === "EPERM") return Err({ tag: "PermissionDenied" });
    if (err.code === "EISDIR") return Err({ tag: "IsADirectory" });
    return Err({ tag: "Other", value: String(err.message ?? e) });
  }
  return trap("effect", name, path, "This runtime has no file system.");
}
```

`NEEDS["fs.read"]` is "Reading files and directories needs the effect `fs.read` on `main`." `NEEDS["fs.write"]` is
"Creating, changing and deleting files needs the effect `fs.write` on `main`." `read_text` moves onto the helper.

## 2. Toolchain

- **Syntax (3: one rule for both commands).** `alang run <file> [-o out] [-- <args>...]` and
  `alang db [--dir <dir>] run [<main>] [-- <args>...]`. The first `--` ends alang's own words; everything after it
  goes to the program unchanged, a further `--` included.
- **`src/cli.ts`.** Split `args` at the first `--` before any other parsing (`rest.indexOf("-o")` must not see program
  words). `--` with a command other than `run` is a usage error (exit 2). For `run`, a word before `--` that is not
  `-o <out>` is a usage error (exit 2) whose text says that program arguments go after `--`. Update `USAGE` and the
  header comment.
- **`src/db_cli.ts`.** After the `--dir` handling, split at the first `--`; a `--` with a command other than `run` is a
  usage error. The arity of `run` stays `[0, 1]` for the words before `--`. `case "run"` becomes
  `cb.run(a, { args })`. Update `DB_USAGE` and the header comment.
- **`src/toolchain.ts`, `RunOptions`.** Add `args?: readonly string[]` and `stdin?: string` (text the program reads,
  then the input ends). Child arguments: `["run", "--no-prompt", ...permissions, entry, ...args]`; do not insert a
  `--`. Child stdin: `"piped"` if `stdin` is given (write the text, close, ignore a broken pipe); else `"null"` when
  `stdio` is `"piped"`, so a test never waits on a terminal; else `"inherit"`.
- **`src/codebase.ts`.** `Codebase.run` passes `RunOptions` through already; only its comment changes.
- **Permissions.** `permissionsFor` and the Toolchain table stay. `env` grants `--allow-env`, also to a program that
  only reads arguments. `console`, `log`, `time` and `random` need no flag.
- **Exit codes.** 0: `main` returned. 1: `main` returned `Err` (step 5); the tool's refused runs (diagnostics as JSON
  on stderr) and a JavaScript crash keep 1 as well. 2: usage. 70: trap. The collision on 1 stays, and stderr tells
  the cases apart; record it under Open questions.
- **MCP server.** No change: it has no `run` tool, and examples never call effectful std (5.4). Note for a later `run`
  tool: it needs `args` and a closed stdin.

## 3. Implementation order

After every step run `deno task test`, `deno lint` and `deno fmt --check`, and commit with explicit paths. The 7.8
table and the types block of `alang-specs.md` change in the same step as `src/std.ts`, because `tests/spec_test.ts`
compares them.

**Step 1: shared error type** (D2). Rename `std.fs.ReadError` to `std.fs.Error` with the new doc line in
`src/std.ts`, `src/runtime.ts` (`std$fs$Error`), `tests/check_test.ts`, `tests/emit_test.ts`, `tests/accept_test.ts`,
`tests/queries_test.ts`, `tests/refs_test.ts`, `tests/db_helpers.ts`, `alang-specs.md` line 187 (the user's sketch),
7.4 and 7.8, `docs/decisions.md` (Effects row; `context` row). Fallback if declined: keep the name `ReadError` and use
it for every fs function; nothing else changes.

**Step 2: files.** `src/std.ts`: rows 5–10 and `std.fs.Kind`. `src/runtime.ts`: `Host`, `DenoFs`, `NodeFs`,
`onFiles`, `std$fs$Kind`, six functions, `read_text` on the helper. Spec 7.8. Existing tests that break:
`tests/spec_test.ts` inventory (14 definitions become 15), `tests/queries_test.ts` `searchText("file")`.

**Step 3: program input** (D4). `src/std.ts` and `src/runtime.ts`: rows 1–3. `src/toolchain.ts`, `src/cli.ts`,
`src/db_cli.ts` and the `src/codebase.ts` comment as in section 2. Existing tests that break, both in
`tests/queries_test.ts`: `list("std").submodules` gains `std.env` (and `std.log`, `std.random`, `std.time` in step
4); `names("-> _")` now also finds `std.console.read_line` and `std.env.args` (and `std.time.now_milliseconds` in
step 4).

**Step 4: `split`, log, clock, random** (rows 11–14; D3, D5). Fallback without `split`: `examples/lines.alang`
becomes a plain copy tool and the playground task waits. Fallback without rows 11–13: leave them out and keep their
words in the 7.1 row.

**Step 5: ending with an error** (D1; build only as the user decided). `findMain` accepts `out: Unit` or exactly
`out: Result<Unit, String>`. The E0305 message becomes "`main` has `in: none`, and `out: Unit` or
`out: Result<Unit, String>`." `writeEntry` emits the plain `await` for a `Unit` main. For a `Result` main it emits
`const outcome = await main();`; on `outcome.tag === "Err"` it calls `console.error(outcome.value)` and exits with 1
through the same `Deno.exit` / `process.exit` pair as the trap branch. The two entry forms must differ: `.tag` on a
`Unit` result does not type-check. Spec Overview sentence on `main` (the user's sketch) and 7.7.

**Step 6: example and documents.** `examples/lines.alang`, exactly this text (canonical, type-checks against the
proposed signatures; example values computed in JavaScript):

```
fn lines.main
  doc: "Writes the lines of the file named by the first argument, sorted, to the file named by the second."
  in: none
  out: Result<Unit, String>
  effects: fs.read, fs.write, env
  requires: none
  ensures: none
  examples: none
  body:
    let args: List<String> = std.env.args()
    let source: String = std.list.get(list: args, index: 0) else return Err("usage: lines <source> <target>")
    let target: String = std.list.get(list: args, index: 1) else return Err("usage: lines <source> <target>")
    let text: String = std.fs.read_text(path: source) else return Err(std.string.concat(left: "cannot read the source: ", right: std.text.show(value: error)))
    let written: Unit = std.fs.write_text(path: target, text: sorted(text: text)) else return Err(std.string.concat(left: "cannot write the target: ", right: std.text.show(value: error)))
    return Ok(Unit)
end fn lines.main

fn lines.sorted
  doc: "The lines of a text in order, each ended by a line break; empty lines are dropped."
  in:
    text: String
  out: String
  effects: none
  requires: none
  ensures: none
  examples:
    sorted(text: "pear\napple\n\nfig\n") == "apple\nfig\npear\n"
    sorted(text: "b\na") == "a\nb\n"
    sorted(text: "") == ""
  body:
    let all: List<String> = std.string.split(text: text, separator: "\n")
    let kept: List<String> = std.list.filter(list: all, with: fn(line: String): Bool => line != "")
    let ordered: List<String> = std.list.sort(list: kept, by: std.string.compare)
    let ended: List<String> = std.list.map(list: ordered, with: fn(line: String): String => std.string.concat(left: line, right: "\n"))
    return std.string.join(parts: ended, separator: "")
end fn lines.sorted
```

Fallback if D1 is declined (also checked): rename this `main` to `lines.run`; add a `lines.main` with `out: Unit` and
`effects: fs.read, fs.write, env, log`, whose body binds `let outcome: Result<Unit, String> = run()`, matches it as a
statement (`case Ok(done) then Unit`, `case Err(message) then std.log.print_line(text: message)`) and returns `Unit`.
File order then `main`, `run`, `sorted`.

- **`alang-specs.md`:** 7.1: replace the row "Writing files, reading the console, ..." by what is still missing:
  waiting, an HTTP client, binary files, renaming and copying, console output without a line break. In the list row,
  "splitting or searching text" becomes "searching text or reading its characters". 7.7: bullets for arguments and
  `--`; ending with an error and the exit codes; files (paths relative to the start directory, `/` on every system,
  UTF-8, nothing added); "refused by the system is an `Err`; not covered by `main`'s effects is a trap"; console on
  stdout and log on stderr. 7.8: one paragraph with the fs semantics of 1.3. 7.10 Running:
  `alang db run web.main -- <args>`.
- **`docs/decisions.md`:** a new section "Files, arguments and console", modelled on "HTTP server", one row per topic
  with its principle: error type, text only, each fs function, permission against refusal with the guarded paths,
  arguments and `--`, environment, `read_line`, log, clock, random, `split`, exit, left out. Update the "Run" and
  "Command line" rows. Open questions: exit code 1 means three things.
- **`docs/notes.md`:** Current state: Done item 14, the test count, Next, a review bullet for this phase. A section
  "From files and program I/O": Bun and Windows untested; `--allow-env` granted for arguments alone; collecting many
  lines with `std.list.append` is quadratic; path helpers missing; file logic has no examples (5.4); the `Error` cases
  cannot grow. Mark "Case names in `std.fs` are taken", "std covers two of eight effects" and "`log` vs `console`" as
  resolved.
- **`README.md`:** usage lines `deno task alang run examples/lines.alang -- in.txt out.txt` and
  `... db --dir project run app.main -- <args>`.

## 4. Tests

**New file `tests/io_test.ts`**, output under `out/test/io/`:

1. **Runtime in process, Deno, one temp directory per test.** One test per fs function covering every row of 1.3.
   Read-only directory through `chmod 0o555`; links and `/proc/version` only on Linux. `list_directory` order:
   `.hidden`, `Z`, `a`, `b`, `ä`, `😀`. `write_text` bytes compared with `TextEncoder`. `env.get`: set, unset, `""`,
   `"A=B"`. `split`: the rows of 1.3, and the trap. `random.int`: 1000 draws in 3..7 hit every value; `low == high`;
   both traps. `now_milliseconds` lies between two `Date.now()` calls.
2. **One program on both hosts** (runtime neutrality). `io.main` has `effects: fs.read, fs.write, env, log, console`.
   Its body is one `std.console.print_line(text: std.text.show(value: <call>))` per call, in this order:
   `std.env.args()`; `create_directory("work/sub")` twice; `write_text("work/sub/a.txt", "first\n")`; `append_text` of
   `"second ä"` to the same file; `read_text` of it; `write_text` of `"new"` to it; `read_text` of it;
   `write_text("work/missing/a.txt", "x")`; `write_text("work/sub", "x")`; `append_text("work/b.txt", "b")`;
   `list_directory("work")`, `list_directory("work/missing")`; `kind` of `work/sub`, `work/b.txt`, `work/missing`;
   `remove("work/b.txt")` twice; `remove("work/sub/a.txt")`, `remove("work/sub")`; `list_directory("work")`;
   `env.get("ALANG_IO_TEST")`, `env.get("ALANG_IO_TEST_UNSET")`; `read_line()` three times. It ends with
   `std.log.print_line(text: "to the log")`. Run it in a fresh temp directory with args `one`, `two words`, `--flag`,
   stdin `"first ä\r\nsecond"` and `ALANG_IO_TEST=x y`: through `run(built, { stdio: "piped", cwd, args, stdin })`, and as
   `node <entry> ...` with piped stdin (skipped without Node.js, like `hasNode` in `tests/http_test.ts`). Expected
   stdout on both hosts (executed on Deno and Node.js; the fixture is `tests/io_program.ts`):
   ```
   ["one", "two words", "--flag"]
   Ok(Unit)
   Ok(Unit)
   Ok(Unit)
   Ok(Unit)
   Ok("first\nsecond ä")
   Ok(Unit)
   Ok("new")
   Err(NotFound)
   Err(IsADirectory)
   Ok(Unit)
   Ok(["b.txt", "sub"])
   Err(NotFound)
   Ok(Directory)
   Ok(File)
   Err(NotFound)
   Ok(Unit)
   Err(NotFound)
   Ok(Unit)
   Ok(Unit)
   Ok([])
   Some("x y")
   None
   Some("first ä")
   Some("second")
   None
   ```
   Expected stderr: `to the log`.
3. **Permission traps.** One small program per function, run with `effects: ["console"]`: exit 70, trap `effect`,
   `definition` naming the function. Covered: `write_text`, `append_text`, `create_directory`, `remove`,
   `list_directory`, `kind`, `env.get`. Positive cases: a `main` with only `fs.write, console` creates, writes,
   appends and removes under exactly `--allow-write`; `std.env.args()` works without `--allow-env`. Linux only: with
   `fs.read`, `read_text("/proc/version")` is `Err(PermissionDenied)`; without it, a trap.
4. **Exit (step 5).** A `Result` main returning `Err("no input")` gives exit 1 and stderr `no input`, on Deno and
   Node.js; `Ok(Unit)` gives 0. `findMain` accepts `Unit` and `Result<Unit, String>`. It rejects (E0305, untested
   today) `Int`, `Result<Unit, Int>`, `Result<String, String>`, `Option<Unit>` and a `main` with a parameter.

**Changed files:**

- `tests/check_test.ts`: a table-driven E0230 test. For each of the twelve effectful functions,
  `one(fn(call + "\nreturn 0"), "E0230").fix?.with` equals `effects: <effect>`. The existing "std signatures and
  runtime exports match" test covers the new functions by itself.
- `tests/emit_test.ts`: add to `PROGRAMS` the fixture of point 2 and a program that names `std.fs.Kind` and
  `std.fs.Error` in a `let` and matches `Ok(std.fs.File)`, `Ok(std.fs.Directory)` and `Err(reason)` (a variant type
  missing from `runtime.ts` is caught only by `deno check` of such a program). Add the entry of a `Result` main to the
  `deno check` list.
- `tests/accept_test.ts`: `alang run <file> -- a "b c" --x` prints the arguments; `alang run <file> a` is exit 2 with
  the `--` hint; `-o out -- a` still works; stdin piped into `alang run` reaches `read_line`; "every file in
  examples/" covers `lines.alang` by itself.
- `tests/run_test.ts`: `db run -- a b` with one `main`; `db run tool.main -- a b`; `db run a b` is exit 2.
- `tests/queries_test.ts` and `tests/spec_test.ts`: the expectations named in steps 1–3.

The test task's permissions (`--allow-read --allow-write --allow-run --allow-env --allow-net`) suffice;
`Deno.env.set` needs `--allow-env`.

## 5. Decisions

**Decided by the planner (implementation level):** the runtime functions are synchronous; `--` is the separator in
both commands; stdin handling as in section 2; guarded paths are `Err(PermissionDenied)`; ENOTDIR, EEXIST and
ENOTEMPTY are `Other`; `list_directory` gives sorted names; `kind` follows links; `create_directory` creates parents
and accepts an existing directory; `remove` takes a file, a link or an empty directory; `read_line` line ends and end
of input as in 1.3; invalid environment names are `None`; `Math.random`; the tool's exit codes stay; no MCP change;
the example lives in `examples/` only.

**For the user:**

- **D1. Ending with an error touches the language.** Recommended: `main` has `out: Unit` or
  `out: Result<Unit, String>`; `Err(message)` writes the message to stderr and ends with exit code 1. Reasons: errors
  stay values (2.3); `let ... else return Err(...)` works in `main`, where every I/O error ends up; otherwise `main`
  needs nested `match` blocks against 4.8 (3.2); no function that never returns (2.6, 4); no ninth effect (2.2).
  Alternatives: `out: Int` as the exit code (full control, but magic numbers); `std.process.exit(code)` (no effect in
  the closed table covers it, and with `effects: none` an example would end the tool's own process). Open sub-point:
  the tool's refusals also exit with 1.
- **D2. One error type for all of `std.fs`.** Recommended: `std.fs.Error` (renamed from `ReadError`) with the four
  cases, final per 3.8; the rename edits line 187 of the user's sketch. Alternatives: keep the name `ReadError` for
  all seven functions; more cases (`NotADirectory`, `AlreadyExists`, `NotEmpty`), each frozen and present in every
  exhaustive `match`. Leans on rules still awaiting review: case names unique per module (forces a shared type); a
  missing permission traps, an OS refusal is an `Err`; the program runs in the caller's directory; functions with
  effects have no examples.
- **D3. `std.string.split` now.** Recommended: yes, this one function; without it the example and the playground task
  are impossible. Alternative: wait for the std breadth phase and ship I/O that can only copy.
- **D4. Arguments belong to `env`.** Recommended: `std.env.args()` with effect `env`, as the spec's effect table says;
  it must be an effect, since examples run in the tool's process with the tool's arguments (2.2). Consequence:
  `--allow-env` is granted to a program that only reads arguments. Alternative: a module of its own
  (`std.program.args`) under the same effect.
- **D5. Names, provisional until published (3.8), and the cheap extras.** `std.fs.kind` instead of `exists`;
  `list_directory` and `create_directory`; `std.env.get`; `std.log.print_line`; `std.time.now_milliseconds`;
  `std.random.int(low, high)`. Confirm that log, clock and random go in now, or defer them.

## 6. Playground task

**Before the round:** check out `std-io` in the alang repository and reconnect the playground's MCP server. Add one
line to `/home/josua/coding_projects/alang-playground/CLAUDE.md`: "Arguments for the program go after `--`:
`alang db run ledger.main -- in.txt out.txt`." A reference solution of eight definitions type-checks against the
proposed signatures. If D1 is declined, drop the exit-code clauses from the prompt.

**Prompt to paste:**

> Add a small command-line tool in a new module `ledger`. Usage: `ledger <input> <output>`. The input file has one
> entry per line in the form `name,amount`, where the amount is a whole number and may be negative, for example
> `rent,-900`. Empty lines are ignored. The tool writes the output file with the valid entries sorted by name, one per
> line in the same form, followed by a last line `total,<sum of the amounts>`. Every line that is not a valid entry is
> reported on stderr as `skipped: <the line>`. If an argument is missing, or a file cannot be read or written, the
> tool says why on stderr and ends with a non-zero exit code. It also refuses to overwrite an output file that already
> exists. Put the logic in pure functions with examples. Then create a sample input with a few valid and invalid
> lines, run the tool, and show me the output file, what went to stderr and the exit code; do the same for an input
> file that does not exist.

**What to observe:**

1. **Discovery.** Does it use `list("std")`, `list("std.fs")`, `search` or `context(std.fs.write_text)`, read the 7.8
   table, or guess? Record every guessed name that fails (E0201), such as `std.fs.exists`, `std.process.args` or
   `std.console.error`; they are evidence for D5.
2. **First-try acceptance per definition, and which diagnostics appear:** E0230 (`env` or `log` missing on `main`),
   E0111 (effect order), E0217 (a dropped `Result` of `write_text`), E0227 or E0213 (a `match` over `std.fs.Error`),
   E0210, E0305, E0402 (the empty last part that `split` gives for a text ending in a line break).
3. **Shape.** Pure `parse`, `report` and `skipped` functions with examples and a thin `main`? Does `main` use
   `out: Result<Unit, String>` with `let ... else return Err(...)`, or nested `match` blocks?
4. **The existence test.** `std.fs.kind(...) == Err(std.fs.NotFound)`, a `match`, or an attempt to read the output
   file?
5. **Running.** Does it pass the paths after `--`, report the exit code, and read stderr apart from stdout? How does
   it create the sample file (the shell, or an alang program)?
6. **Gaps it names** (no `Map`, no line numbers, no list literals): input for the std breadth phase.
7. **Bookkeeping.** The number of tool calls, and whether it reads `fixed`.

## User's answers to D1 to D5

Answered 2026-11-13; the user took every recommendation:

- **D1:** `main` may have `out: Result<Unit, String>`; `Err(message)` goes to stderr and the exit code is 1. Build
  step 5.
- **D2:** rename `std.fs.ReadError` to `std.fs.Error`, one type for all of `std.fs`, the four cases unchanged.
- **D3:** add `std.string.split` in this phase.
- **D4/D5:** all names as proposed (`std.env.args` under `env`, `std.fs.kind`, `list_directory`, `create_directory`,
  ...), and log, clock and random go in now.

## 7. Fixes from the playground round (2026-11-13)

The ledger task (section 6) succeeded with one accepted submit of 14 definitions and no diagnostic, but the model
read the whole spec and used no query tool, so discovery and the D5 names were not tested. An analysis of the session
found three small defects, fixed in this batch on `std-io`, one commit each:

1. **`std.int.parse` doc.** The doc line in `src/std.ts` and the 7.8 row say only "Reads a decimal integer". The
   runtime accepts an optional `-` and decimal digits inside the `Int` range, leading zeros included (`"007"` is 7,
   `"-0"` is 0), and rejects `+`, `_` and whitespace, unlike alang's own literals (4.7, 7.2). State exactly that in
   the doc line and the 7.8 row (same commit; `tests/spec_test.ts` compares them). Do not change what it accepts.
2. **E0005 for an unknown escape** (`src/lexer.ts`, the `else` branch that reports "Unknown escape") has no `fix`.
   For the common C escapes give `expected` and `fix: { replace, with }` with the `\u{...}` form: `\r` → `\u{D}`,
   `\0` → `\u{0}`, `\a` → `\u{7}`, `\b` → `\u{8}`, `\f` → `\u{C}`, `\v` → `\u{B}`, `\e` → `\u{1B}`. Other unknown
   escapes keep today's message without a fix. Do not add new escapes to the language.
3. **Arithmetic traps name no definition.** `int`, `int_div`, `int_rem` and `float` in `src/runtime.ts` pass
   `definition: null`, while contract, `where` and `match` traps (emitted in `src/emit.ts`) pass the definition's
   name. Make the emitted calls pass the definition's full name so an overflow, a division by zero or a NaN trap
   names its definition. This changes the emitted TypeScript at every arithmetic site: check the emit tests, keep
   runtime neutrality, and stop at the definition name if adding the expression text gets costly. Own commit.

Left for later (recorded in `docs/notes.md`, "From the ledger round"): an `AlreadyExists` case together with an
exclusive-create function (`std.fs.Error` keeps four cases as the user decided in D2; settle before publishing, 3.8);
checked arithmetic (an overflow cannot become a message); E0227 forcing duplicated arms when every case but one is
handled alike; a dummy `let x: Unit = ... else return Err(error)` to propagate a `Result<Unit, E>`; verbosity from
missing list literals, two-argument `concat` and no `std.string.lines`; the model reading `export/*.alang` with `cat`
instead of the query tools (belongs to the served-spec phase).
