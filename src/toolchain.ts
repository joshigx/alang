// Building, testing and running alang source with Deno. This file is part of
// the tool, not of generated programs, so it may use Deno APIs.

import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Definition, Effect, FnDef } from "./ast.ts";
import { EFFECTS, headerWord, pathText } from "./ast.ts";
import { AlangError, type Diagnostic, diagnostic } from "./diagnostic.ts";
import { type CheckInfo, checkProgram, type CheckResult } from "./check.ts";
import { emitProgram } from "./emit.ts";
import {
  constantDiagnostics,
  describeResults,
  exampleDiagnostics,
  type ExampleOutcome,
  isolationDiagnostics,
  type IsolationFailure,
  missingExamples,
  noRunPermission,
} from "./examples.ts";
import { parseProgram } from "./parser.ts";
import { printTypeRef } from "./printer.ts";
import type { Constant, ConstantResult, Example, ExampleResult, TrapInfo } from "./runtime.ts";
import { decode_value, runConstants, runExamples } from "./runtime.ts";

const RUNTIME_PATH = fileURLToPath(new URL("./runtime.ts", import.meta.url));

export interface Built {
  readonly defs: Definition[];
  readonly info: CheckInfo;
  readonly outPath: string;
  // The absolute directory the targets of its externs are relative to (2.2).
  readonly base: string;
}

export interface AcceptOptions {
  // The directory a target is relative to (2.2): the codebase's, or the
  // file's. Default: the current directory.
  readonly base?: string;
  // How long the separate process may run; tests shorten it. Default: 30 s.
  readonly limitMs?: number;
  // Run in a separate process although there is no extern; for tests of the
  // process alone.
  readonly isolate?: boolean;
}

const LIMIT_MS = 30_000;

// Parses and type-checks `source`; throws an AlangError with all
// diagnostics if it does not check.
function parseAndCheck(source: string): { defs: Definition[]; info: CheckInfo } {
  const defs = parseProgram(source);
  const { diagnostics, info } = checkProgram(defs);
  if (diagnostics.length > 0) throw new AlangError(diagnostics);
  return { defs, info };
}

// Parses, checks and emits `source`, without running its examples.
export function compile(source: string, runtimeImport: string): { defs: Definition[]; ts: string } {
  const { defs, info } = parseAndCheck(source);
  return { defs, ts: emitProgram(defs, info, { runtimeImport }) };
}

// A module specifier for `path` in a file of the directory `from`: relative,
// with `/`, starting with `.`.
function specifier(from: string, path: string): string {
  const r = relative(from, path).replaceAll("\\", "/");
  return r.startsWith(".") ? r : `./${r}`;
}

async function emitTo(defs: Definition[], info: CheckInfo, outPath: string, options: AcceptOptions): Promise<Built> {
  const absOut = resolve(outPath);
  const base = resolve(options.base ?? ".");
  const runtimeImport = specifier(dirname(absOut), RUNTIME_PATH);
  await Deno.mkdir(dirname(absOut), { recursive: true });
  await Deno.writeTextFile(absOut, emitProgram(defs, info, { runtimeImport }));
  return { defs, info, outPath: absOut, base };
}

// Compiles `source` and writes the generated TypeScript to `outPath`,
// without running its examples (see `accept`).
export async function build(source: string, outPath: string, options: AcceptOptions = {}): Promise<Built> {
  const { defs, info } = parseAndCheck(source);
  return await emitTo(defs, info, outPath, options);
}

export interface Accepted {
  readonly built: Built;
  readonly examples: readonly ExampleOutcome[];
}

// Acceptance (6.3): parsing, type and effect checking, mandatory examples
// (5.1), then the examples themselves. Throws an AlangError with every
// diagnostic if a step fails. The static diagnostics come in one round;
// examples run only once the program checks, since they need its code.
export async function accept(source: string, outPath: string, options: AcceptOptions = {}): Promise<Accepted> {
  return await acceptDefinitions(parseProgram(source), outPath, undefined, options);
}

// `accept` for definitions that are already parsed, e.g. from the database.
// `checked` is the check of these very definitions, if the caller has one.
export async function acceptDefinitions(
  defs: Definition[],
  outPath: string,
  checked: CheckResult = checkProgram(defs),
  options: AcceptOptions = {},
): Promise<Accepted> {
  const { diagnostics, info } = checked;
  // A function that E0237 turns into a constant (its `expected`) needs no
  // example: one cause, one diagnostic (5.6).
  const toConst = new Set(diagnostics.filter((d) => d.code === "E0237" && d.expected).map((d) => d.definition));
  const missing = missingExamples(defs).filter((d) => !toConst.has(d.definition));
  const all = byDefinition(defs, [...diagnostics, ...missing]);
  if (all.length > 0) throw new AlangError(all);
  const built = await emitTo(defs, info, outPath, options);
  const { constants, examples } = await testProgram(built, options);
  // An example that traps inside a trapping constant has its cause reported
  // already (5.6); without an E0404 every constant was evaluated, so no
  // example can trap inside one.
  const trapped = constantDiagnostics(constants);
  const shown = trapped.length === 0 ? examples : examples.filter((o) => o.trap?.origin === undefined);
  const failed = [...trapped, ...exampleDiagnostics(shown)];
  if (failed.length > 0) throw new AlangError(failed);
  return { built, examples };
}

// Diagnostics grouped by the order of their definitions; stable within one.
function byDefinition(defs: readonly Definition[], diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const order = new Map(defs.map((d, i) => [pathText(d.path), i]));
  const rank = (d: Diagnostic) => (d.definition === null ? -1 : order.get(d.definition) ?? defs.length);
  return [...diagnostics].sort((a, b) => rank(a) - rank(b));
}

let loads = 0;

// Imports a built program into the tool's own process. Never for a program
// with an `extern fn`: its modules are foreign code, which would run with
// the tool's permissions (E10, `testProgram`).
// deno-lint-ignore no-explicit-any
async function load(outPath: string): Promise<Record<string, any>> {
  // A fresh query string defeats the module cache when a file is rebuilt. A
  // counter, not the clock: two builds within one millisecond must not share
  // a module.
  return await import(`${pathToFileURL(outPath).href}?v=${++loads}`);
}

interface Results {
  readonly constants: ConstantResult[];
  readonly examples: ExampleResult[];
}

const hasExtern = (defs: readonly Definition[]) => defs.some((d) => d.kind === "fn" && d.target !== null);

// Evaluates every constant of a built program, then runs every example,
// from one load of its module (spec, Toolchain; C4): in this process, or,
// for a program with an `extern fn`, in a separate one without permissions
// (E10). Throws an AlangError (E0406 to E0408) if that process gives no
// results.
export async function testProgram(
  built: Built,
  options: AcceptOptions = {},
): Promise<{ constants: ConstantResult[]; examples: ExampleOutcome[] }> {
  const { constants, examples } = options.isolate === true || hasExtern(built.defs)
    ? await runIsolated(built, options.limitMs ?? LIMIT_MS)
    : await runHere(built);
  return { constants, examples: describeResults(built.defs, built.info, examples) };
}

async function runHere(built: Built): Promise<Results> {
  const mod = await load(built.outPath);
  const constants = runConstants(mod.$constants as readonly Constant[]);
  const examples = runExamples(mod.$examples as readonly Example[]);
  return { constants, examples };
}

// Runs every example of a built program, its constants evaluated first.
export async function testExamples(built: Built, options: AcceptOptions = {}): Promise<ExampleOutcome[]> {
  return (await testProgram(built, options)).examples;
}

// ---- foreign code at acceptance (E10, E11) ----

// The flags of the separate process: no `--allow-*` at all; no project
// configuration; nothing fetched while the modules load (a remote import is
// refused, a package comes only from Deno's cache).
const ISOLATED_FLAGS = ["--no-prompt", "--no-config", "--no-lock", "--no-remote", "--cached-only", "--quiet"];

// Runs the constants and examples of `built` in a Deno process without
// permissions, which reports over stdout through `run_isolated` (runtime.ts).
// The process is stopped after `limitMs`. Every acceptance loads the
// modules afresh, so a changed target module is tested as it is now.
async function runIsolated(built: Built, limitMs: number): Promise<Results> {
  const context = { defs: built.defs, base: built.base, limitMs };
  // Never a fallback to this process, which has the tool's permissions.
  if (Deno.permissions.querySync({ name: "run", command: Deno.execPath() }).state !== "granted") {
    throw new AlangError([noRunPermission(built.defs)]);
  }
  const entry = built.outPath.replace(/\.ts$/, ".check.ts");
  // Written into the entry only: foreign code, which cannot read files, cannot
  // learn it, so it cannot forge a report.
  const marker = crypto.randomUUID();
  const program = basename(built.outPath);
  await Deno.writeTextFile(
    entry,
    [
      `// Generated by alang: runs the externs' checks, the constants and the examples of ${program} without permissions.`,
      `import { run_isolated } from ${JSON.stringify(specifier(dirname(entry), RUNTIME_PATH))};`,
      `import { $constants, $examples, $externs } from ${JSON.stringify(`./${program}`)};`,
      "",
      `run_isolated($externs, $constants, $examples, ${JSON.stringify(marker)});`,
      // A module may leave a timer running; the report is complete.
      "Deno.exit(0);",
      "",
    ].join("\n"),
  );
  try {
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", ...ISOLATED_FLAGS, entry],
      cwd: dirname(entry),
      stdin: "null",
      // Never the tool's own stdout, which is the MCP channel.
      stdout: "piped",
      stderr: "piped",
      env: { NO_COLOR: "1" },
    }).spawn();
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // It has ended meanwhile.
      }
    }, limitMs);
    let output: Deno.CommandOutput;
    try {
      output = await child.output();
    } finally {
      clearTimeout(timer);
    }
    const report = readReport(new TextDecoder().decode(output.stdout), marker);
    const stderr = new TextDecoder().decode(output.stderr);
    if (report.done !== null) {
      const results = parseResults(report.done, built.defs);
      if (results === null) {
        throw new AlangError(isolationDiagnostics({ kind: "failed", code: output.code, stderr: MALFORMED }, context));
      }
      if (results.kind === "missing") throw new AlangError(isolationDiagnostics(results, context));
      return results;
    }
    const failure: IsolationFailure = killed
      ? { kind: "killed", last: report.last }
      : { kind: "failed", code: output.code, stderr };
    throw new AlangError(isolationDiagnostics(failure, context));
  } finally {
    await Deno.remove(entry).catch((e) => {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    });
  }
}

const MALFORMED = "its report was malformed";

// The lines of the process's report, found by its marker anywhere in a line
// (a module may print without a line break before it).
export function readReport(stdout: string, marker: string): {
  last: { kind: "constant" | "example"; index: number } | null;
  done: string | null;
} {
  let last: { kind: "constant" | "example"; index: number } | null = null;
  let done: string | null = null;
  for (const line of stdout.split("\n")) {
    const i = line.indexOf(`${marker} `);
    if (i < 0) continue;
    const said = line.slice(i + marker.length + 1);
    const start = /^start (constant|example) (\d+)$/.exec(said);
    if (start) last = { kind: start[1] as "constant" | "example", index: Number(start[2]) };
    else if (said.startsWith("done ")) done = said.slice("done ".length);
  }
  return { last, done };
}

// The results in a `done` line, checked against the program: the report
// crosses from foreign code, so anything unexpected is no result (null).
function parseResults(
  done: string,
  defs: readonly Definition[],
): (Results & { kind: "results" }) | Extract<IsolationFailure, { kind: "missing" }> | null {
  let json: unknown;
  try {
    json = JSON.parse(done);
  } catch {
    return null;
  }
  const isString = (x: unknown): x is string => typeof x === "string";
  const isTrap = (x: unknown): x is TrapInfo => {
    if (x === null || typeof x !== "object") return false;
    const t = x as Record<string, unknown>;
    return isString(t.kind) && (t.definition === null || isString(t.definition)) && isString(t.at) &&
      isString(t.message) && (t.origin === undefined || isString(t.origin));
  };
  if (json === null || typeof json !== "object") return null;
  const { missing, constants, examples } = json as Record<string, unknown>;
  if (!Array.isArray(missing) || !Array.isArray(constants) || !Array.isArray(examples)) return null;
  if (missing.length > 0) {
    const externs = new Map(
      defs.flatMap((d) => (d.kind === "fn" && d.target !== null ? [[pathText(d.path), d.target] as const] : [])),
    );
    const valid = missing.every((m) =>
      m !== null && typeof m === "object" && externs.get(m.definition) === m.target &&
      Array.isArray(m.functions) && m.functions.every(isString)
    );
    return valid ? { kind: "missing", missing } : null;
  }
  const constantCount = defs.filter((d) => d.kind === "const").length;
  const exampleCount = defs.reduce((n, d) => n + (d.kind === "fn" ? d.examples.length : 0), 0);
  if (constants.length !== constantCount || examples.length !== exampleCount) return null;
  const fields = (x: unknown): Record<string, unknown> =>
    x !== null && typeof x === "object" ? x as Record<string, unknown> : {};
  const validConstant = (x: unknown) => {
    const c = fields(x);
    return isString(c.definition) && (c.trap === null || isTrap(c.trap)) &&
      (c.origin === null || isString(c.origin)) &&
      (c.cycle === null || (Array.isArray(c.cycle) && c.cycle.every(isString)));
  };
  const validExample = (x: unknown) => {
    const e = fields(x);
    return isString(e.definition) && isString(e.text) && typeof e.passed === "boolean" &&
      (e.trap === null || isTrap(e.trap));
  };
  if (!constants.every(validConstant) || !examples.every(validExample)) return null;
  try {
    return {
      kind: "results",
      constants: constants as ConstantResult[],
      examples: (examples as ExampleResult[]).map((e) => ({ ...e, actual: decode_value(e.actual) })),
    };
  } catch {
    // A map with a key twice.
    return null;
  }
}

// The function a program starts at (spec, section 1): a function named
// `main` with `in: none`, and `out: Unit` or `out: Result<Unit, String>`
// (an `Err` ends the program with its message and exit code 1). With
// `name`, the `main` of that full name, for a program with several (a
// codebase of many modules).
export function findMain(defs: readonly Definition[], name?: string): FnDef {
  const mains = defs.filter((d): d is FnDef => d.kind === "fn" && d.path[d.path.length - 1] === "main");
  const chosen = name === undefined ? mains : mains.filter((m) => pathText(m.path) === name);
  if (chosen.length !== 1) {
    const names = mains.map((m) => pathText(m.path));
    const known = names.length === 0 ? "" : ` The \`main\` functions are ${names.map((n) => `\`${n}\``).join(", ")}.`;
    throw new AlangError(diagnostic({
      code: "E0304",
      definition: name ?? null,
      at: name ?? (names.join(", ") || "<program>"),
      message: name !== undefined
        ? `\`${name}\` is not a \`main\` function; a program starts at a function named \`main\`.${known}`
        : chosen.length === 0
        ? "The program has no `main` function."
        : `The program has more than one \`main\` function; name the one to run.${known}`,
    }));
  }
  const main = chosen[0];
  if (main.params.length !== 0 || !MAIN_OUT.includes(printTypeRef(main.out))) {
    throw new AlangError(diagnostic({
      code: "E0305",
      definition: pathText(main.path),
      at: `${headerWord(main)} ${pathText(main.path)}`,
      message: "`main` has `in: none`, and `out: Unit` or `out: Result<Unit, String>`.",
    }));
  }
  return main;
}

// What `main` may return; built-in types are always written short.
const MAIN_OUT = ["Unit", "Result<Unit, String>"];

// Deno permissions per effect (spec, Toolchain). Effects without an entry
// need no permission.
const PERMISSIONS: Partial<Record<Effect, string>> = {
  "fs.read": "--allow-read",
  "fs.write": "--allow-write",
  "net": "--allow-net",
  "env": "--allow-env",
};

export function permissionsFor(effects: readonly Effect[]): string[] {
  return EFFECTS.filter((e) => effects.includes(e) && PERMISSIONS[e]).map((e) => PERMISSIONS[e]!);
}

export interface RunOptions {
  // "piped" collects the output instead of passing it through.
  readonly stdio?: "inherit" | "piped";
  readonly cwd?: string;
  // Grant the permissions of these effects instead of main's own. For tests
  // of the runtime enforcement only.
  readonly effects?: readonly Effect[];
  // The full name of the `main` to start, if the program has several.
  readonly main?: string;
  // The program's arguments (`std.env.args`), passed on unchanged.
  readonly args?: readonly string[];
  // Text the program reads from the console; then its input ends. Without
  // it, the program reads the tool's console, or nothing if `stdio` is
  // "piped", so that a test never waits on a terminal.
  readonly stdin?: string;
}

// Writes the entry file that starts main (`out/<name>.run.ts`) and returns
// its path. `name` chooses among several `main` functions (see `findMain`).
export async function writeEntry(built: Built, name?: string): Promise<string> {
  const main = findMain(built.defs, name);
  const entry = built.outPath.replace(/\.ts$/, ".run.ts");
  const fn = main.path.join("$");
  const runtimeImport = specifier(dirname(entry), RUNTIME_PATH);
  // A main with effects is async (see emit.ts); awaiting a plain value is
  // harmless, so one call fits both. A `Result` main is read: `.tag` on a
  // `Unit` main would not type-check, so the two forms differ.
  const call = printTypeRef(main.out) === "Unit" ? [`  await ${fn}();`] : [
    `  const outcome = await ${fn}();`,
    '  if (outcome.tag === "Err") {',
    "    console.error(outcome.value);",
    "    exit(1);",
    "  }",
  ];
  await Deno.writeTextFile(
    entry,
    [
      `// Generated by alang. Starts ${pathText(main.path)}; a trap ends the program with a diagnostic` +
      (call.length === 1 ? "." : ", an `Err` with its message."),
      `import { Trap } from ${JSON.stringify(runtimeImport)};`,
      `import { ${fn} } from ${JSON.stringify(`./${basename(built.outPath)}`)};`,
      "",
      "const host = globalThis as { Deno?: { exit(code: number): never }; process?: { exit(code: number): never } };",
      "function exit(code: number): void {",
      "  if (host.Deno) host.Deno.exit(code);",
      "  host.process?.exit(code);",
      "}",
      "",
      "try {",
      ...call,
      "} catch (e) {",
      "  if (!(e instanceof Trap)) throw e;",
      "  console.error(JSON.stringify({ trap: e.kind, definition: e.definition, at: e.at, message: e.message }));",
      "  exit(70);",
      "}",
      "",
    ].join("\n"),
  );
  return entry;
}

// Runs the program's main in a separate Deno process that has exactly the
// permissions main declares as effects, so that code doing more than its
// effects (an extern function, rule 2.5) fails at runtime.
export async function run(built: Built, options: RunOptions = {}): Promise<Deno.CommandOutput> {
  const main = findMain(built.defs, options.main);
  const entry = await writeEntry(built, options.main);
  const permissions = permissionsFor(options.effects ?? main.effects);
  const stdio = options.stdio ?? "inherit";
  // The arguments follow the entry as they are: Deno passes everything after
  // the script to the program, a `--` included.
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--no-prompt", ...permissions, entry, ...(options.args ?? [])],
    cwd: options.cwd,
    stdin: options.stdin !== undefined ? "piped" : stdio === "piped" ? "null" : "inherit",
    stdout: stdio,
    stderr: stdio,
  }).spawn();
  // Written while the program runs, so that neither waits for the other. A
  // program that ends without reading it all breaks the pipe; that is fine.
  const feeding = options.stdin === undefined ? Promise.resolve() : feed(child.stdin, options.stdin);
  // A Ctrl-C in the terminal reaches the program itself (same process
  // group), which may end on its own terms: a server answers the requests
  // in progress and returns from `std.http.serve`. The tool waits for that
  // instead of ending first. A SIGTERM is passed on only if the program
  // still runs 500 ms later: one sent to the whole group has reached the
  // program already, and passing it on at once would be a second signal,
  // which ends a server before it returns. One sent to the tool alone
  // reaches the program late, but reaches it; a further one after that is
  // passed on the same way, so the second signal still ends a slow server.
  const waitForProgram = () => {};
  let passing: ReturnType<typeof setTimeout> | undefined;
  const passOn = () => {
    passing ??= setTimeout(() => {
      passing = undefined;
      try {
        child.kill("SIGTERM");
      } catch {
        // The program has ended meanwhile.
      }
    }, 500);
  };
  const listening: [Deno.Signal, () => void][] = [];
  for (const [signal, listener] of [["SIGINT", waitForProgram], ["SIGTERM", passOn]] as const) {
    try {
      Deno.addSignalListener(signal, listener);
      listening.push([signal, listener]);
    } catch {
      // SIGTERM cannot be listened to on Windows.
    }
  }
  try {
    return await child.output();
  } finally {
    for (const [signal, listener] of listening) Deno.removeSignalListener(signal, listener);
    clearTimeout(passing);
    await feeding;
  }
}

async function feed(stdin: WritableStream<Uint8Array>, text: string): Promise<void> {
  const writer = stdin.getWriter();
  try {
    await writer.write(new TextEncoder().encode(text));
    await writer.close();
  } catch {
    // The program ended first.
  }
}

export function defaultOutPath(sourcePath: string): string {
  const base = sourcePath.replace(/^.*[\\/]/, "").replace(/\.alang$/, "");
  return join("out", `${base}.ts`);
}
