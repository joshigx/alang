# alang

A language written and edited by LLMs, read by humans at the contract level, and transpiled to TypeScript. The
language is described in [alang-specs.md](alang-specs.md); decisions on gaps in the spec are in
[docs/decisions.md](docs/decisions.md).

## Status

Lexer, parser, canonical printer, type checker and TypeScript output work end to end, with runtime checks for
`requires`, `ensures` and `where`, and executable examples. Effects are not checked yet. Ideas and open points are
collected in [docs/notes.md](docs/notes.md).

## Usage

Requires [Deno](https://deno.com).

```sh
deno task alang fmt examples/port.alang      # canonical text
deno task alang check examples/port.alang    # type check, diagnostics as JSON
deno task alang ts examples/port.alang       # generated TypeScript
deno task alang test examples/port.alang     # run all examples
deno task alang run examples/hello.alang     # run main
deno task test                               # test suite
```

## Layout

| Path             | Content                                                       |
| ---------------- | ------------------------------------------------------------- |
| `src/lexer.ts`   | Tokens; enforces name spelling, number grouping, escapes      |
| `src/parser.ts`  | Syntax tree (`src/ast.ts`)                                    |
| `src/printer.ts` | Canonical text                                                |
| `src/check.ts`   | Type checker; types in `src/types.ts`, std in `src/std.ts`    |
| `src/emit.ts`    | TypeScript output                                             |
| `src/runtime.ts` | Runtime library shared by the tool and generated programs     |
| `tests/`         | Spec examples, round trip, checker rules, emitter end to end  |
