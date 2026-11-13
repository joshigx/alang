// alang command line.
//
//   alang fmt <file> [--write]   print (or rewrite) the canonical text
//   alang check <file>           accept the program (6.3): report all diagnostics,
//                                including failing and missing examples (5.1)
//   alang ts <file>              print the generated TypeScript of an accepted program
//   alang build <file> [-o out]  accept, and write the generated TypeScript
//                                (default out/<name>.ts)
//   alang test <file>            build and run all examples, passing or not
//   alang run <file> [-o out] [-- <args>...]
//                                accept, then run main with exactly the Deno
//                                permissions of its effects; the words after
//                                the first `--` go to the program unchanged
//                                (`std.env.args`)
//   alang db ...                 queries and operations on a codebase database
//                                (section 6), and running the program it
//                                holds; see db_cli.ts
//   alang mcp [--dir <dir>]      the same queries and operations as an MCP
//                                server on stdio; see mcp.ts
//
// Every command but fmt and test refuses a program that is not accepted:
// a definition that fails its checks does not exist (5).

import { dbMain } from "./db_cli.ts";
import { AlangError } from "./diagnostic.ts";
import { mcpMain } from "./mcp.ts";
import { parseProgram } from "./parser.ts";
import { printProgram } from "./printer.ts";
import { Trap } from "./runtime.ts";
import { accept, build, compile, defaultOutPath, run, testExamples } from "./toolchain.ts";

const USAGE = "usage: alang <fmt|check|ts|build|test> <file> [--write] [-o out], " +
  "alang run <file> [-o out] [-- <args>...], alang db ..., or alang mcp";

function usage(problem?: string): number {
  if (problem) console.error(problem);
  console.error(USAGE);
  return 2;
}

async function main(args: string[]): Promise<number> {
  if (args[0] === "db") return await dbMain(args.slice(1));
  if (args[0] === "mcp") return await mcpMain(args.slice(1));
  // The first `--` ends the tool's own words; what follows is the program's,
  // a further `--` included.
  const split = args.indexOf("--");
  const own = split < 0 ? args : args.slice(0, split);
  const programArgs = split < 0 ? [] : args.slice(split + 1);
  const [command, file, ...rest] = own;
  if (!command || !file) return usage();
  if (split >= 0 && command !== "run") return usage("`--` passes arguments to the program; only `alang run` takes it.");
  if (command === "run") {
    // Only `-o <out>` may come between the file and `--`.
    if (rest[0] === "-o" && rest.length < 2) return usage("`-o` needs the path of the output file.");
    const stray = rest[0] === "-o" ? rest[2] : rest[0];
    if (stray !== undefined) {
      return usage(`\`${stray}\` is not an option of \`alang run\`; arguments for the program go after \`--\`.`);
    }
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
      return (await run((await accept(source, outPath)).built, { args: programArgs })).code;
    default:
      return usage();
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
