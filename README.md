# alang

A language written and edited by LLMs, read by humans at the contract level, and transpiled to TypeScript. The
language is described in [alang-specs.md](alang-specs.md), whose section 7 is the reference for writing it today
(standard library included); decisions on gaps in the spec, with their reasons, are in
[docs/decisions.md](docs/decisions.md).

## Status

Lexer, parser, canonical printer, type checker and TypeScript output work end to end, with runtime checks for
`requires`, `ensures` and `where`. Every pure function needs at least one example, and a program is accepted only if
all its examples hold (5.1). Effects are checked statically and enforced at runtime through Deno permissions. The
codebase lives in a database of definitions (section 6), reachable from the command line and as an MCP server. Ideas
and open points are collected in [docs/notes.md](docs/notes.md).

## Usage

Requires [Deno](https://deno.com).

```sh
deno task alang fmt examples/port.alang      # canonical text
deno task alang check examples/port.alang    # accept: checks and examples, diagnostics as JSON
deno task alang ts examples/port.alang       # generated TypeScript
deno task alang test examples/port.alang     # list every example, with the actual value of failing ones
deno task alang run examples/hello.alang     # run main with the permissions of its effects
deno task alang run examples/server.alang    # a web server on localhost:8080, Ctrl-C stops it
deno task alang run examples/lines.alang -- in.txt out.txt   # program arguments go after --
deno task alang run examples/words.alang -- in.txt          # count the words of a file with a Map
deno task alang run examples/probe.alang -- http://localhost:8080/   # check URLs with std.http.send
deno task alang db --dir project list        # database queries and operations (section 6), JSON out
deno task alang db --dir project run         # run the program the database holds (main's full name if several)
deno task alang db --dir project run app.main -- <args>      # with arguments for the program
deno task alang mcp --dir project            # the same as an MCP server on stdio
deno task test                               # test suite
```

`deno task` runs in this directory, so file paths are relative to it. To have an `alang` command everywhere, install
it once (it runs the sources in place, so later changes need no reinstall):

```sh
deno install --global --allow-read --allow-write --allow-run -n alang /path/to/alang/src/cli.ts
alang run hello.alang                        # writes out/hello.ts and out/hello.run.ts next to where you are
```

A file given to `alang run` must hold the whole program; a program spread over modules runs from its database with
`alang db --dir <project> run`.

## MCP server

`alang mcp` offers the queries and operations of section 6 as MCP tools (`context`, `replace`, `submit`, ...), so an
LLM reads and changes a codebase the way the spec intends. Its tool `card` returns the language card
(`src/card.ts`), the rules every definition needs on one page, and its instructions send the model there first. To
use it from Claude Code, register it with absolute paths:

```sh
claude mcp add alang -- deno run --allow-read --allow-write --allow-run /path/to/alang/src/cli.ts mcp --dir /path/to/project
```

`--allow-run` lets acceptance run the examples of a program with an `extern fn` in a separate process without
permissions. The project directory holds `alang.db`, `export/` (one canonical file per module, for Git) and `out/`;
it is created if missing.

## Layout

| Path               | Content                                                               |
| ------------------ | --------------------------------------------------------------------- |
| `src/lexer.ts`     | Tokens; enforces name spelling, number grouping, escapes              |
| `src/parser.ts`    | Syntax tree (`src/ast.ts`)                                            |
| `src/printer.ts`   | Canonical text                                                        |
| `src/check.ts`     | Type and effect checker; types in `src/types.ts`, std in `src/std.ts` |
| `src/emit.ts`      | TypeScript output                                                     |
| `src/examples.ts`  | Mandatory examples (5.1); actual values as alang text                 |
| `src/toolchain.ts` | Acceptance (6.3), building and running with Deno                      |
| `src/codebase.ts`  | The codebase database (6): storage, transactions, queries, export     |
| `src/db_cli.ts`    | `alang db`: the database on the command line                          |
| `src/mcp.ts`       | `alang mcp`: the database as an MCP server                            |
| `src/card.ts`      | The language card the MCP server serves; section 7 in short           |
| `src/runtime.ts`   | Runtime library shared by the tool and generated programs             |
| `tests/`           | Spec examples, round trip, checker rules, emitter end to end, acceptance |
