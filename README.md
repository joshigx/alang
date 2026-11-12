# alang

A language written and edited by LLMs, read by humans at the contract level, and transpiled to TypeScript. The
language is described in [alang-specs.md](alang-specs.md); decisions on gaps in the spec are in
[docs/decisions.md](docs/decisions.md).

## Status

Lexer, parser, canonical printer, type checker and TypeScript output work end to end, with runtime checks for
`requires`, `ensures` and `where`. Every pure function needs at least one example, and a program is accepted only if
all its examples hold (5.1). Effects are checked statically and enforced at runtime through Deno permissions. Ideas and open points are collected in [docs/notes.md](docs/notes.md).

## Usage

Requires [Deno](https://deno.com).

```sh
deno task alang fmt examples/port.alang      # canonical text
deno task alang check examples/port.alang    # accept: checks and examples, diagnostics as JSON
deno task alang ts examples/port.alang       # generated TypeScript
deno task alang test examples/port.alang     # list every example, with the actual value of failing ones
deno task alang run examples/hello.alang     # run main with the permissions of its effects
deno task test                               # test suite
```

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
| `src/runtime.ts`   | Runtime library shared by the tool and generated programs             |
| `tests/`           | Spec examples, round trip, checker rules, emitter end to end, acceptance |
