// Building, testing and running alang source with Deno. This file is part of
// the tool, not of generated programs, so it may use Deno APIs.

import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Definition, FnDef } from "./ast.ts";
import { pathText } from "./ast.ts";
import { AlangError, diagnostic } from "./diagnostic.ts";
import { checkProgram } from "./check.ts";
import { emitProgram } from "./emit.ts";
import { parseProgram } from "./parser.ts";
import type { Example, ExampleResult } from "./runtime.ts";
import { runExamples } from "./runtime.ts";

const RUNTIME_PATH = fileURLToPath(new URL("./runtime.ts", import.meta.url));

export interface Built {
  readonly defs: Definition[];
  readonly outPath: string;
}

// Parses and checks `source`; throws an AlangError with all diagnostics if
// the program is not accepted.
export function compile(source: string, runtimeImport: string): { defs: Definition[]; ts: string } {
  const defs = parseProgram(source);
  const { diagnostics, info } = checkProgram(defs);
  if (diagnostics.length > 0) throw new AlangError(diagnostics);
  return { defs, ts: emitProgram(defs, info, { runtimeImport }) };
}

// Compiles `source` and writes the generated TypeScript to `outPath`.
export async function build(source: string, outPath: string): Promise<Built> {
  const absOut = resolve(outPath);
  let runtimeImport = relative(dirname(absOut), RUNTIME_PATH).replaceAll("\\", "/");
  if (!runtimeImport.startsWith(".")) runtimeImport = `./${runtimeImport}`;
  await Deno.mkdir(dirname(absOut), { recursive: true });
  const { defs, ts } = compile(source, runtimeImport);
  await Deno.writeTextFile(absOut, ts);
  return { defs, outPath: absOut };
}

// deno-lint-ignore no-explicit-any
async function load(outPath: string): Promise<Record<string, any>> {
  // A fresh query string defeats the module cache when a file is rebuilt.
  return await import(`${pathToFileURL(outPath).href}?v=${Date.now()}`);
}

export async function testExamples(built: Built): Promise<ExampleResult[]> {
  const mod = await load(built.outPath);
  return runExamples(mod.$examples as readonly Example[]);
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

export async function run(built: Built): Promise<void> {
  const main = findMain(built.defs);
  const mod = await load(built.outPath);
  mod[main.path.join("$")]();
}

export function defaultOutPath(sourcePath: string): string {
  const base = sourcePath.replace(/^.*[\\/]/, "").replace(/\.alang$/, "");
  return join("out", `${base}.ts`);
}
