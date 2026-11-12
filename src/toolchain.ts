// Building, testing and running alang source with Deno. This file is part of
// the tool, not of generated programs, so it may use Deno APIs.

import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Definition, Effect, FnDef } from "./ast.ts";
import { EFFECTS, pathText } from "./ast.ts";
import { AlangError, type Diagnostic, diagnostic } from "./diagnostic.ts";
import { type CheckInfo, checkProgram } from "./check.ts";
import { emitProgram } from "./emit.ts";
import { describeResults, exampleDiagnostics, type ExampleOutcome, missingExamples } from "./examples.ts";
import { parseProgram } from "./parser.ts";
import type { Example } from "./runtime.ts";
import { runExamples } from "./runtime.ts";

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
  const defs = parseProgram(source);
  const { diagnostics, info } = checkProgram(defs);
  const all = byDefinition(defs, [...diagnostics, ...missingExamples(defs)]);
  if (all.length > 0) throw new AlangError(all);
  const built = await emitTo(defs, info, outPath);
  const examples = await testExamples(built);
  const failed = exampleDiagnostics(examples);
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

// Runs every example of a built program, in this process (spec, Toolchain).
export async function testExamples(built: Built): Promise<ExampleOutcome[]> {
  const mod = await load(built.outPath);
  return describeResults(built.defs, built.info, runExamples(mod.$examples as readonly Example[]));
}

export function findMain(defs: readonly Definition[]): FnDef {
  const mains = defs.filter((d): d is FnDef => d.kind === "fn" && d.path[d.path.length - 1] === "main");
  if (mains.length !== 1) {
    throw new AlangError(diagnostic({
      code: "E0304",
      at: mains.map((m) => pathText(m.path)).join(", ") || "<program>",
      message: mains.length === 0
        ? "The program has no `main` function."
        : "The program has more than one `main` function; name the one to run.",
    }));
  }
  const main = mains[0];
  const isUnit = main.out.path.length === 1 && main.out.path[0] === "Unit";
  if (main.params.length !== 0 || !isUnit) {
    throw new AlangError(diagnostic({
      code: "E0305",
      definition: pathText(main.path),
      at: `fn ${pathText(main.path)}`,
      message: "`main` has `in: none` and `out: Unit`.",
    }));
  }
  return main;
}

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
}

// Writes the entry file that starts main (`out/<name>.run.ts`) and returns its path.
export async function writeEntry(built: Built): Promise<string> {
  const main = findMain(built.defs);
  const entry = built.outPath.replace(/\.ts$/, ".run.ts");
  const fn = main.path.join("$");
  let runtimeImport = relative(dirname(entry), RUNTIME_PATH).replaceAll("\\", "/");
  if (!runtimeImport.startsWith(".")) runtimeImport = `./${runtimeImport}`;
  await Deno.writeTextFile(
    entry,
    [
      `// Generated by alang. Starts ${pathText(main.path)}; a trap ends the program with a diagnostic.`,
      `import { Trap } from ${JSON.stringify(runtimeImport)};`,
      `import { ${fn} } from ${JSON.stringify(`./${basename(built.outPath)}`)};`,
      "",
      "try {",
      `  ${fn}();`,
      "} catch (e) {",
      "  if (!(e instanceof Trap)) throw e;",
      "  console.error(JSON.stringify({ trap: e.kind, definition: e.definition, at: e.at, message: e.message }));",
      "  const host = globalThis as { Deno?: { exit(code: number): never }; process?: { exit(code: number): never } };",
      "  if (host.Deno) host.Deno.exit(70);",
      "  host.process?.exit(70);",
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
  const main = findMain(built.defs);
  const entry = await writeEntry(built);
  const permissions = permissionsFor(options.effects ?? main.effects);
  const stdio = options.stdio ?? "inherit";
  return await new Deno.Command(Deno.execPath(), {
    args: ["run", "--no-prompt", ...permissions, entry],
    cwd: options.cwd,
    stdout: stdio,
    stderr: stdio,
  }).output();
}

export function defaultOutPath(sourcePath: string): string {
  const base = sourcePath.replace(/^.*[\\/]/, "").replace(/\.alang$/, "");
  return join("out", `${base}.ts`);
}
