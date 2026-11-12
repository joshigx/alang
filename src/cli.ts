// alang command line.
//
//   alang fmt <file> [--write]   print (or rewrite) the canonical text
//   alang check <file>           report all diagnostics
//   alang ts <file>              print the generated TypeScript
//   alang build <file> [-o out]  write the generated TypeScript (default out/<name>.ts)
//   alang test <file>            build and run all examples
//   alang run <file>             build, then run main with exactly the Deno
//                                permissions of its effects

import { AlangError } from "./diagnostic.ts";
import { checkProgram } from "./check.ts";
import { parseProgram } from "./parser.ts";
import { printProgram } from "./printer.ts";
import { Trap } from "./runtime.ts";
import { build, compile, defaultOutPath, run, testExamples } from "./toolchain.ts";

const USAGE = "usage: alang <fmt|check|ts|build|test|run> <file> [--write] [-o out]";

async function main(args: string[]): Promise<number> {
  const [command, file, ...rest] = args;
  if (!command || !file) {
    console.error(USAGE);
    return 2;
  }
  const source = await Deno.readTextFile(file);
  const outFlag = rest.indexOf("-o");
  const outPath = outFlag >= 0 ? rest[outFlag + 1] : defaultOutPath(file);

  switch (command) {
    case "fmt": {
      const text = printProgram(parseProgram(source));
      if (rest.includes("--write")) await Deno.writeTextFile(file, text);
      else console.log(text.trimEnd());
      return 0;
    }
    case "check": {
      const { diagnostics } = checkProgram(parseProgram(source));
      if (diagnostics.length > 0) throw new AlangError(diagnostics);
      console.log("ok");
      return 0;
    }
    case "ts":
      console.log(compile(source, "./runtime.ts").ts);
      return 0;
    case "build":
      console.log((await build(source, outPath)).outPath);
      return 0;
    case "test": {
      const results = await testExamples(await build(source, outPath));
      for (const r of results) {
        const status = r.passed ? "ok  " : "FAIL";
        console.log(`${status} ${r.definition}: ${r.text}${r.trap ? `  (trap: ${r.trap})` : ""}`);
      }
      const failed = results.filter((r) => !r.passed).length;
      console.log(`${results.length - failed} passed, ${failed} failed`);
      return failed === 0 ? 0 : 1;
    }
    case "run":
      return (await run(await build(source, outPath))).code;
    default:
      console.error(USAGE);
      return 2;
  }
}

try {
  Deno.exit(await main(Deno.args));
} catch (e) {
  if (e instanceof AlangError) {
    console.error(JSON.stringify(e.diagnostics, null, 2));
    Deno.exit(1);
  }
  if (e instanceof Trap) {
    console.error(JSON.stringify({ trap: e.kind, definition: e.definition, at: e.at, message: e.message }, null, 2));
    Deno.exit(70);
  }
  throw e;
}
