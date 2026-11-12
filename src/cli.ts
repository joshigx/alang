// alang command line.
//
//   alang fmt <file> [--write]   print (or rewrite) the canonical text
//   alang check <file>           accept the program (6.3): report all diagnostics,
//                                including failing and missing examples (5.1)
//   alang ts <file>              print the generated TypeScript of an accepted program
//   alang build <file> [-o out]  accept, and write the generated TypeScript
//                                (default out/<name>.ts)
//   alang test <file>            build and run all examples, passing or not
//   alang run <file>             accept, then run main with exactly the Deno
//                                permissions of its effects
//   alang db ...                 queries and operations on a codebase database
//                                (section 6); see db_cli.ts
//
// Every command but fmt and test refuses a program that is not accepted:
// a definition that fails its checks does not exist (5).

import { dbMain } from "./db_cli.ts";
import { AlangError } from "./diagnostic.ts";
import { parseProgram } from "./parser.ts";
import { printProgram } from "./printer.ts";
import { Trap } from "./runtime.ts";
import { accept, build, compile, defaultOutPath, run, testExamples } from "./toolchain.ts";

const USAGE = "usage: alang <fmt|check|ts|build|test|run> <file> [--write] [-o out], or alang db ...";

async function main(args: string[]): Promise<number> {
  if (args[0] === "db") return await dbMain(args.slice(1));
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
    case "check":
      await accept(source, outPath);
      console.log("ok");
      return 0;
    case "ts":
      await accept(source, outPath);
      console.log(compile(source, "./runtime.ts").ts);
      return 0;
    case "build":
      console.log((await accept(source, outPath)).built.outPath);
      return 0;
    case "test": {
      const results = await testExamples(await build(source, outPath));
      for (const r of results) {
        const status = r.passed ? "ok  " : "FAIL";
        const why = r.passed ? "" : r.trap ? `  (trap: ${r.trap.message})` : `  (actual: ${r.actual})`;
        console.log(`${status} ${r.definition}: ${r.text}${why}`);
      }
      const failed = results.filter((r) => !r.passed).length;
      console.log(`${results.length - failed} passed, ${failed} failed`);
      return failed === 0 ? 0 : 1;
    }
    case "run":
      return (await run((await accept(source, outPath)).built)).code;
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
