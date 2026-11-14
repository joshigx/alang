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
  missingExamples,
} from "./examples.ts";
import { parseProgram } from "./parser.ts";
import { printTypeRef } from "./printer.ts";
import type { Constant, ConstantResult, Example } from "./runtime.ts";
import { runConstants, runExamples } from "./runtime.ts";

const RUNTIME_PATH = fileURLToPath(new URL("./runtime.ts", import.meta.url));

export interface Built {
  readonly defs: Definition[];
  readonly info: CheckInfo;
  readonly outPath: string;
}

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

async function emitTo(defs: Definition[], info: CheckInfo, outPath: string): Promise<Built> {
  const absOut = resolve(outPath);
  let runtimeImport = relative(dirname(absOut), RUNTIME_PATH).replaceAll("\\", "/");
  if (!runtimeImport.startsWith(".")) runtimeImport = `./${runtimeImport}`;
  await Deno.mkdir(dirname(absOut), { recursive: true });
  await Deno.writeTextFile(absOut, emitProgram(defs, info, { runtimeImport }));
  return { defs, info, outPath: absOut };
}

// Compiles `source` and writes the generated TypeScript to `outPath`,
// without running its examples (see `accept`).
export async function build(source: string, outPath: string): Promise<Built> {
  const { defs, info } = parseAndCheck(source);
  return await emitTo(defs, info, outPath);
}

export interface Accepted {
  readonly built: Built;
  readonly examples: readonly ExampleOutcome[];
}

// Acceptance (6.3): parsing, type and effect checking, mandatory examples
// (5.1), then the examples themselves. Throws an AlangError with every
// diagnostic if a step fails. The static diagnostics come in one round;
// examples run only once the program checks, since they need its code.
export async function accept(source: string, outPath: string): Promise<Accepted> {
  return await acceptDefinitions(parseProgram(source), outPath);
}

// `accept` for definitions that are already parsed, e.g. from the database.
// `checked` is the check of these very definitions, if the caller has one.
export async function acceptDefinitions(
  defs: Definition[],
  outPath: string,
  checked: CheckResult = checkProgram(defs),
): Promise<Accepted> {
  const { diagnostics, info } = checked;
  // A function that E0237 turns into a constant (its `expected`) needs no
  // example: one cause, one diagnostic (5.6).
  const toConst = new Set(diagnostics.filter((d) => d.code === "E0237" && d.expected).map((d) => d.definition));
  const missing = missingExamples(defs).filter((d) => !toConst.has(d.definition));
  const all = byDefinition(defs, [...diagnostics, ...missing]);
  if (all.length > 0) throw new AlangError(all);
  const built = await emitTo(defs, info, outPath);
  const { constants, examples } = await testProgram(built);
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

// deno-lint-ignore no-explicit-any
async function load(outPath: string): Promise<Record<string, any>> {
  // A fresh query string defeats the module cache when a file is rebuilt. A
  // counter, not the clock: two builds within one millisecond must not share
  // a module.
  return await import(`${pathToFileURL(outPath).href}?v=${++loads}`);
}

// Evaluates every constant of a built program, then runs every example, in
// this process and from one load of its module (spec, Toolchain; C4).
export async function testProgram(
  built: Built,
): Promise<{ constants: ConstantResult[]; examples: ExampleOutcome[] }> {
  const mod = await load(built.outPath);
  const constants = runConstants(mod.$constants as readonly Constant[]);
  const examples = describeResults(built.defs, built.info, runExamples(mod.$examples as readonly Example[]));
  return { constants, examples };
}

// Runs every example of a built program, its constants evaluated first.
export async function testExamples(built: Built): Promise<ExampleOutcome[]> {
  return (await testProgram(built)).examples;
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
  let runtimeImport = relative(dirname(entry), RUNTIME_PATH).replaceAll("\\", "/");
  if (!runtimeImport.startsWith(".")) runtimeImport = `./${runtimeImport}`;
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
