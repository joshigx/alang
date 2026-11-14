# Plan: phase 8, `extern-fn`

The planner wrote this on 2026-11-14 from branch `statements` at `f0d9ecb`: `main`, plus phase `statements`, with `std-net` merged. Commits kept landing during planning (`47634f6`, then `fn-types` from `89a13d0` up to `3e0ff8e`), so every file:line below is at `f0d9ecb`, read from a snapshot made with `git archive f0d9ecb` (`/home/josua/.claude/jobs/7e0015cb/tmp/extern-fn-probes/snapshot/`). The only file written was this plan. Probes ran in `/home/josua/.claude/jobs/7e0015cb/tmp/extern-fn-probes/`.

- **Observed:** facts from `deno run` and `deno check` on hand-written TypeScript in the shape the emitter would produce (Deno 2.8.0, TypeScript 6.0.3), from `node` (26.13.0), from `alang build` of the snapshot, and from scripts that measure the card and the MCP instructions. Each is marked O1 to O16 in 1.5.
- **To verify:** facts that were not observed, mostly because they need the code of `fn-types`, `const`, `generics` or this phase.

The main session takes every recommendation, and nobody is asked. **[language]** marks a decision that changes the language; those are listed for the user's later review.

**Branch:** `extern-fn`, from `main` after `statements` (row 4), `fn-types` (row 5), `const` (row 6) and `generics` (row 7) are merged. This plan builds on their plans (`docs/plans/statements.md`, `fn-types.md`, `const.md`, `generics.md`), each assumed built as planned:
- `fn-types` makes `TypeRef` a union with a `function` kind, adds `containsFn` and E0237 (no `fn` returns a function value, F4);
- `const` adds `ConstDef`, `$constants`, `runConstants`, one module load per acceptance (constants, then examples), E0404, and reserves E0405;
- `generics` adds type parameters to the `fn` header (G1), rigid types, `info.instances`, generic types with arguments, and E0250.

Re-grep every reference below by the function name given. After every commit run `deno task test`, `deno lint` and `deno fmt --check`. Commit with explicit paths, never `git add -A`.

**Codes.** This phase takes **E0260** and **E0261** (checker), and **E0406 to E0408** (acceptance). E0262 to E0269 stay free. E0199 ("not supported yet") loses its last use.

## 0. Scope

| Item | Where | Why |
| --- | --- | --- |
| `extern fn`: form, parsing, printing, checking (E1, E3, E4, E6, E7) | **This phase**, commit 1 | Roadmap row 8; the spec names the fourth kind of definition and leaves its form open (CLAUDE.md) |
| Acceptance of a program with an extern in a separate process without permissions (E10, E11) | **This phase**, commit 2, before any foreign code can run | The roadmap's first risk; today's acceptance would run foreign code with the tool's permissions and with stale module code (1.2) |
| The boundary: arguments copied out, results checked and rebuilt, traps (E2, E5, E8, E9) | **This phase**, commit 3 | Roadmap E2; the Overview already requires the NaN check for an extern |
| Externs in the database and the MCP tools (E13, E14) | **This phase**, commit 4 | A function kind runs through hits, `context`, `replace` and the instructions |
| The card (E17) | **This phase**, commit 5 | The card is how a round learns the language |
| Inline TypeScript as the target | **Not planned** (E1's alternative) | One-line strings with escapes cannot hold real code, and allow no imports |
| `npm:`, `jsr:`, `https:` or `node:` targets | **Not planned** (E3) | Not runnable on every host, or need the network; a module imports them itself |
| Generic externs; function values across the boundary | **Later** (E6, E7) | Nothing to check a type parameter against; callbacks are a second boundary. Loosening later breaks no program (3.8) |
| The module's code under the hash and in `history` | **Later** (E15) | The export in Git holds the code beside the text; acceptance retests it every time |
| `context` showing the module's text | **Later** (E19) | The text is one file read away; a query that reads arbitrary files needs its own rules |
| Console, log, clock and random use of a pure extern caught at acceptance | **Later** (Risks) | Output could be attributed per example from the separate process; no permission covers the other two |
| Examples for effectful externs ("Fix the answers", spec, To revisit later) | **Not planned** | A language change of its own |
| std as `extern fn` definitions | **Not planned** (roadmap X1 stays) | std stays in TypeScript; nothing in this phase needs it moved |

## 1. Findings

### 1.1 How a function kind flows through the toolchain (at `f0d9ecb`)

An extern is a function: it is declared, called, effect-checked, searched, renamed and stored exactly as a `fn`, and only its code comes from elsewhere. So this plan represents it as a `FnDef` with a `target` (E13), and every site that tests `kind === "fn"` includes externs unless marked otherwise. TypeScript flags none of these, since the kind stays `"fn"`.

| Site | What it does | With an extern |
| --- | --- | --- |
| `src/lexer.ts:28-60` | `extern` is a keyword (`:32`); `target` is not | Unchanged; `target` stays unreserved (E4) |
| `src/ast.ts:123-134` | `FnDef` | Gains `readonly target: string \| null` (E13) |
| `src/parser.ts:156-165` | `definitionDef()`: `extern` is E0199 (`:161-163`) | `externDef()`; E0199 goes |
| `src/parser.ts:188-215` | `definitionPath(kind)`, `endDef(kind, path)` | An `"extern fn"` end form, with E0103 across the two |
| `src/parser.ts:273-327` | `fnDef()`; the `examples` list stops at `body` or end of text (`:316-319`) | Shared with `externDef()`; for an extern it stops at `target` followed by `:` |
| `src/printer.ts:14-16, 31-33, 35-50` | `printDefinition`, `printSignature`, `printFn` | Header `extern fn`, `target:` in place of `body:`; the signature leaves `target` out |
| `src/check.ts:325-340` | `declare()` puts the `FnSig` into `env.fns` | Same |
| `src/check.ts:429-432, 435-490` | `check()` → `checkFn`: contracts, examples, body (`:468`), E0218 (`:469-472`), E0230 (`:473-488`) | No body, no E0218, no E0230; E0260 and E0261 instead |
| `src/check.ts:1128-1141` | `effectsOfCall`: E0232, E0233; the declared effects at `:1136` | Same; an extern has no body, so nothing is collected |
| `src/emit.ts:72-85` | `emitProgram`: fn or type (`:80`), then `$examples` (`:81`) | `e.fn(def)` branches to a wrapper; target imports and shapes at the top; a `$externs` list |
| `src/emit.ts:264-288` | `fn(def)`: `async` iff effects, requires, ensures | The wrapper reuses the contract lines |
| `src/emit.ts:305-315` | `examples(def)` | Same |
| `src/emit.ts:~504` | A function value resolves to its global | Same: the wrapper |
| `src/examples.ts:21-37` | `missingExamples`: E0401 for a pure `fn` without examples | Same; const's C6 hint ("write it as a constant") skips externs |
| `src/examples.ts:56-81` | `describeResults` pairs results with examples in definition order | Same order as the emitter, since both include externs |
| `src/toolchain.ts:40-47` | `emitTo`: the runtime import relative to the out file | Also the target imports, relative to the out file (E3) |
| `src/toolchain.ts:65-84` | `accept`, `acceptDefinitions` | Take `AcceptOptions` (`base`, `limitMs`, `isolate`); a program with an extern runs isolated (E10) |
| `src/toolchain.ts:96-107` | `load()` imports the built module into the tool's process; `testExamples` | The boundary of the sandbox: never called for a program with an extern |
| `src/toolchain.ts:114-141` | `findMain` | Same; an extern named `main` is a `main` like any other |
| `src/toolchain.ts:221-224` | The comment claims runtime permissions catch an extern doing more than its effects | True only beyond `main`'s effects; rewritten |
| `src/cli.ts:60-62, 71-94` | File commands: `out/<name>.ts` relative to the current directory | Pass `base`, the file's directory |
| `src/codebase.ts:139-145, 238-257` | `Hit.kind`, `Row.kind`, `Stored.kind` | Unchanged: `"fn"` |
| `src/codebase.ts:170-200` | `kind TEXT NOT NULL CHECK (kind IN ('fn', 'type'))` (const widens it) | Unchanged; no migration (E13) |
| `src/codebase.ts:259-264` | `signatureTypes` | Same |
| `src/codebase.ts:270-275, 290-294` | `storedHead`, `storedHit` | The line starts `extern fn` |
| `src/codebase.ts:380-383` | `headerName` reads `fn <name>` or `type <name>` | Also `extern fn <name>` |
| `src/codebase.ts:428, 486-508` | `acceptPath`, `acceptHere`, `removeAcceptFile` | `base: this.dir`; also removes the entry `accept-…check.ts` |
| `src/codebase.ts:599-640` | `context`: a used stored definition by its `signature` | Same; an extern's signature starts `extern fn` |
| `src/codebase.ts:705-720` | `searchType` skips everything but `kind === "fn"` (`:710`) | Externs are found |
| `src/codebase.ts:795-800` | `run()` accepts into `out/<main>.ts` | `base: this.dir` |
| `src/codebase.ts:1061-1072` | E0505's `expected` is `${kind} ${name}` | Prints `fn` for an extern; use the header |
| `src/codebase.ts:1281-1293` | `lackingEffects` follows `fn` callers (`:1289-1291`) | Same; an extern calls nothing in a body |
| `src/codebase.ts:160-162` | `hashText`: sha-256 of the canonical text | Same: the text holds `target`, not the module's code (E15) |
| `src/codebase.ts:1377-1530, 1669-1680` | `exportModules`, `exportAll`, `sync`/`syncNow`, `compareExport`, `importAll`/`importFrom`; `exportFiles` reads only `*.alang` | Unchanged: they work on texts. A `.ts` file in `export/` is ignored, never deleted |
| `src/search.ts:37-65, 131-150` | `treeOfRef`, `showTree`, `matchesFn` over a function's parameters and result | Unchanged: an extern's types are those of a `fn` |
| `src/refs.ts:205-218` | `rebuild()` builds a new `FnDef` field by field | Carries `target`; the target is no reference |
| `src/interface.ts:50-61` | fn/fn compares `in`, `out`, `requires`, `ensures`, added effects | Same for every pair of fn and extern; `target` is not interface (E14) |
| `src/mcp.ts:87-112` | Instructions: "never by editing files" | One phrase for the module (2.9) |
| `src/card.ts:105` | "Not in alang" lists `extern fn` | E17 |
| `tests/spec_test.ts:28` | Definition blocks are those whose first word is `fn` or `type` (const adds `const`) | Also `extern` |

### 1.2 Today's behavior

- **Parsing (read, `parser.ts:161-163`).** `extern fn m.x` is E0199 "`extern` definitions are not supported yet.", with `definition: null`. No test pins it at `f0d9ecb` (grepped `E0199` and `extern` in `tests/`). Const's test 1.2 will pin "`extern fn m.x` is still E0199" (to verify after `const`); this phase replaces that test.
- **Where examples run (read, `toolchain.ts:96-107`).** Acceptance imports the built module into the tool's own process and calls the examples there. A static import of a target module would run its top-level code at that import, for every extern, effectful ones with `examples: none` included. That happens in `accept` (`check`, `ts`, `build`, `run`), in `alang test` (`cli.ts:83`), in `acceptHere` and in `Codebase.run` (`codebase.ts:494`, `:798`), and const's `runConstants` shares the load. So the sandbox boundary is `load()`, not "the examples of pure externs".
- **The tool's permissions (read).**
  - `alang` itself: `--allow-read --allow-write --allow-run` (`README.md:41`, the `deno.json` task, the round's `bin/alang`).
  - The MCP server: `--allow-read --allow-write` (`README.md:56`, the `mcp.json` that `scripts/playground-round.sh` writes).

  Foreign code loaded there could read and write every file the user can, at every acceptance, and through `alang db run` start processes. The round's restricted shell would no longer restrict anything.
- **Stale code (observed, O10).** Re-importing a rebuilt module with a fresh query string does not re-run a dependency it imports without one. An MCP server would keep the first version of a target module for its lifetime, and test edits against the old code.
- **The rest of the file system.** `exportFiles` (`codebase.ts`, after `:1500`) reads only `*.alang`, so a `.ts` file in `export/` is ignored, never deleted (read). The out directory is relative to the current directory for file commands (`toolchain.ts:290-293`) and `<dir>/out/` for a codebase (`codebase.ts:428`, `:798`).
- **`target` as a name (observed, O14).** `examples/lines.alang:10,12` binds a local `target` (pinned by `io_test`), and the tickets round's export defines `fn tickets.target`. Reserving `target` would break both.
- **Runtime value forms (read, `runtime.ts:7-30`, `:48-55`; `emit.ts:228-262`).** `Unit` is `null`; `Option`, `Result` and `Order` are `{ tag, value? }` objects; a record is a plain object built by its constructor, which checks `where`; a case is `{ tag, value? }`; a `List` is an array; a `Map` is a `SortedMap`, a class foreign code cannot build without importing the runtime, whose path it does not know.

### 1.3 Tests that pin current behavior

- **Card:** `tests/card_test.ts:89-92` pins the tools the card names, `search_type` included, and `:113-119` the texts it shows. The budget is at `:146-149`: under 10,240 bytes and at most 160 for `CARD.split("\n").length`.
- **MCP instructions:** `tests/mcp_test.ts:500` keeps them under 3,000 characters without the spec path. `:381` and `:460` start the server as a process with `--allow-read --allow-write` only; that is how E0408 is tested (4.4).
- **Spec inventory:** `tests/spec_test.ts:34-40` (6 blocks and 17 definitions at `f0d9ecb`; the earlier phases each add theirs).
- **Nothing pins:** E0199, the text "Expected a definition (`fn` or `type`)", `interfaceChange` throwing on two kinds, or the message of E0006 for `import` (grep before changing it, to verify).

### 1.4 What `fn-types`, `const` and `generics` leave for this phase

- **fn-types.** By F3, user function values are pure and synchronous; by F4 (E0237), no `fn`, an extern included, has a function value in `out`. `containsFn` (`check.ts`, from F4) serves E0261 for `in`. A function type has the TypeScript form `((p0: A) => R)`. Its plan says the boundary check "never meets a function" (`fn-types.md`, What this phase leaves ready); E0261 makes that true for arguments too.
- **const.** `$constants` and `runConstants` move into the separate process with the examples. E0404 and the trap origins are plain data, so they cross as JSON. C6's E0401 hint skips externs. Its `definitionDef()` message becomes "Expected a definition (`fn`, `type`, `const` or `extern fn`), found …".
- **generics.** A `<` after an extern's path is E0101 (E7). G11 is the precedent: `const m.c<T>` is E0101. A non-generic extern may still use a generic type with arguments (`Tree<Int>`). Its shape substitutes the arguments into the fields, as the checker does for a construction.
- **The card** after all three: 159 lines by the test's count and 9,846 bytes (O11).

### 1.5 Probes

| # | Fact | Status |
| --- | --- | --- |
| O1 | Deno 2.8.0 with TypeScript 6.0.3; Node.js 26.13.0 | observed |
| O2 | `deno run --no-prompt --no-config` without any permission loads a static import of a local `.ts` module; `Deno.readTextFileSync` there throws `NotCapable` "Requires read access to "/etc/hostname", run again with the --allow-read flag"; `String.prototype.isWellFormed` is false for a lone surrogate on Deno and Node; a missing export reads as `undefined`; an `async` export returns a thenable (`p1/`) | observed |
| O3 | A `Worker` with `deno: { permissions: "none" }` needs `--unstable-worker-options` (exit 70 without it) (`p3/`) | observed |
| O4 | Node.js 26 refuses an `enum` in an imported `.ts` module (uncaught at load); Deno runs it (`p4/`). The error code `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` | observed; the code to verify |
| O5 | A child killed with SIGKILL after 700 ms: `output()` resolves with code 137, signal `SIGKILL`, and the stdout lines printed before. Without `--allow-run` and without a terminal, `Deno.permissions.querySync({ name: "run" }).state` is `"prompt"`, and `spawn()` throws `NotCapable` "Requires run access to …" (`p5/`) | observed |
| O6 | A permissionless child that runs the examples of a small built program takes 32 to 35 ms once Deno's cache holds the runtime (`p6/`) | observed |
| O7 | A tagged JSON (`{ "$float": "-0" \| "Infinity" \| "-Infinity" }`, `{ "$map": [[k, v], …] }`) round-trips ±infinity, `-0.0` (inside a map too), a `SortedMap`, nested variants and strings with quotes and emoji; `$rt.eq` holds between original and copy (`p7/`) | observed |
| O8 | With `NO_COLOR=1`, a permissionless child reports a syntax error, a throwing top level and a missing module with the module's `file://` URL on stderr, exit code 1 (`p8/`) | observed; `NO_COLOR` through `Deno.Command`'s `env` to verify |
| O9 | A prototype of the boundary (`p9/extern_rt.ts`: `Shape`, `to_host`, `from_host`, `extern_call`, `extern_call_async`) and a program in the emitter's shape pass `deno check` against the snapshot runtime and run alike on Deno, without permissions, and on Node.js. On both:<br>- `encode` and an `Option` from `decode` work;<br>- `1.5` for an `Int` traps;<br>- a JS `Map` becomes `["a": 1, "b": 2]`;<br>- a record's `where` traps through its constructor;<br>- an input list stays `3,1,2` after the module sorts its copy in place;<br>- a `Promise` from a pure extern traps;<br>- a missing export traps;<br>- an effectful extern is awaited.<br>The module caught Deno's `NotCapable` itself and returned it as `Err` | observed |
| O10 | An in-process re-import with a new query string does not see an edited dependency (`p10/`: `first 1 second 1`) | observed |
| O11 | The card after `generics`: 159 by the test's count, 9,846 bytes; after this phase's edits 158 and 9,836 (`card/stages.ts`, built on the generics planner's `card_after.md` with the `let [...]` sentence of `f0d9ecb`) | observed on that reconstruction; re-measure on the merged card |
| O12 | The MCP instructions are 2,871 characters with the snapshot's spec path | observed |
| O13 | The round's expected outputs, from `encodeURIComponent` and `decodeURIComponent` (`round/reference.mjs`) | observed; also computed by hand |
| O14 | `target` names a local in `examples/lines.alang:10,12` and a function in the tickets round's export | observed |
| O15 | A permissionless child loads a target module that statically imports a JSON file outside the project (`with { type: "json" }`) and returns its content: module loading reads files without `--allow-read` (`p11/`) | observed |
| O16 | With `--no-remote`, a static import of `http://127.0.0.1:9/x.ts` is refused before any fetch: "A remote specifier was requested: …, but --no-remote is specified.", naming the importing module's `file://` URL. Deno 2.8's `deno run --help` lists `--no-remote`, `--cached-only`, `--allow-import` (default hosts `deno.land`, `jsr.io`, `esm.sh`, …) and `--deny-import` | observed. Without `--no-remote`, whether a permissionless child downloads from the default hosts was not probed (the network probe was refused): to verify |

## 2. Design

### 2.1 E1: the form [language]

```
extern fn text.encode
  doc: "The text percent-encoded for a URL, as JavaScript's encodeURIComponent does it."
  in:
    text: String
  out: String
  effects: none
  requires: none
  ensures: none
  examples:
    encode(text: "a b&c") == "a%20b%26c"
    encode(text: "é") == "%C3%A9"
  target: "./text.ts#encode"
end extern fn text.encode
```

- **Sections.** Those of a `fn`, in its order, with `target:` in place of `body:`, then `end extern fn <full name>`. `requires` and `ensures` are checked at runtime around the call. A pure extern has examples (5.1, E0401), which test the assumption; one with effects has `examples: none` (E0233, as for a `fn`).
- **Grammar** (spec, section 3, after `const_def`):

```
extern_def = "extern" "fn" path
             "doc:" string
             "in:" ( "none" | param { param } )
             "out:" type
             "effects:" ( "none" | effect { "," effect } )
             "requires:" ( "none" | expr )
             "ensures:" ( "none" | expr )
             "examples:" ( "none" | example { example } )
             "target:" string
             "end" "extern" "fn" path ;
```

- **AST** (`ast.ts`): `FnDef` gains `readonly target: string | null`, the string as written; `null` for a `fn`, whose `body` is then non-empty. An extern has `body: []`. The field is required, so `rebuild()` and every other constructor of a `FnDef` must set it (TypeScript enforces this).
- **Parser.**
  - `definitionDef()`: on `extern`, call `externDef()`. A next token other than `fn` is E0101 (P1 below).
  - `fnDef()` becomes `functionDef(extern: boolean)`. For an extern:
    - it expects `extern` and then `fn`;
    - a `<` after the path is E0101 (P2);
    - the `examples` list stops at the keyword `body`, at the name `target` followed by `:`, or at the end;
    - `target` is read by `targetSection()`: the name `target`, `:`, one string token and a line break. `this.section = "target"` is set while it is read.
  - The end is `endDef("extern fn", path)`.
  - For a `fn`, `target:` where `body` is expected is P4.
  - `definitionDef()`'s last message: "Expected a definition (`fn`, `type`, `const` or `extern fn`), found …".

  Messages (code E0101 unless stated; `at` is the line, as for every parser error; no fix unless stated):

| # | Input | Message |
| --- | --- | --- |
| P1 | `extern type m.T`, `extern const m.c` | "Only a function is written in TypeScript: `extern fn module.name`." |
| P2 | `extern fn m.f<T>` | "An `extern fn` takes no type parameters: its result is checked against one concrete type where it returns (2.5). Write one extern per type, or keep the generic part in alang." |
| P3 | `body:` in an extern | "An `extern fn` has `target: \"./module.ts#name\"` in place of `body:`; its code is TypeScript in that module." |
| P4 | `target:` in a `fn` | "A `fn` has `body:`. A function whose code is TypeScript is an `extern fn`, with `target:` in place of `body:`." |
| P5 | `target:` followed by anything but a string | "`target` holds one string: `\"./module.ts#name\"`." |
| P6 | `end fn m.f` closing `extern fn m.f`, and the reverse | **E0103** "The block end names `fn m.f`, but the definition is `extern fn m.f`.", `expected` `end extern fn m.f`, fix `{ replace: "end fn m.f", with: "end extern fn m.f" }` |
| P7 | `import { slugify } from "./text.ts"` (lexer, E0006, existing `FOREIGN_KEYWORDS.import`) | **E0006** with the message extended: "There are no imports; write names from other modules fully qualified. Code from a TypeScript module is called through an `extern fn` with `target: \"./module.ts#name\"`." |

- **Printer.** `printFn(def, body = true)`:
  - the header is `extern fn <name>` when `def.target !== null`;
  - after `examples`, with `body` true, it prints `  target: <printString(target)>` instead of `body:` and the statements;
  - the end line is `end extern fn <name>`.

  `printSignature` (body false) leaves `target` out, as it leaves out `body`: the signature is every section but the code (6).
- **Why `target` is not reserved (E4).** Section names are reserved so that `out: Unit` is never read as a parameter (`decisions.md`, Lexical, Keywords; principle 1). `target:` stands only after `examples` of an `extern fn`, where an entry is a call (`name(`). So one token after `target` decides, as for `with effects` in std signatures. Reserving it would break `lines.alang` and `tickets.target` (O14), and every program with a local of that name. Const's C1 hit the same wall with `value` and avoided a new word. The already reserved words were considered too: `extern:` reads as "extern fn … extern:" and departs from the spec's own word, and `body: "./x.ts#f"` makes a body that is a string.

### 2.2 E3: the target and where its module lives [language]

- **Form.** `"./<path>.ts#<export>"`, matching
  `^\./(?:[A-Za-z0-9_][A-Za-z0-9_.-]*/)*[A-Za-z0-9_][A-Za-z0-9_.-]*\.ts#[A-Za-z_$][A-Za-z0-9_$]*$`.
  - A segment cannot start with `.`, so there is no `..` and no hidden directory.
  - The export is a JavaScript identifier, named explicitly even when it equals the function's short name (2.6: no defaults).
  - Only `.ts`: Deno and Node.js both load it (O2, O9), and the generated code is `.ts` already.
- **Relative to what.** The directory that holds the program:
  - the codebase's directory, where `alang.db`, `export/` and `out/` are, for the MCP server, every `alang db` command and `alang db run`;
  - the directory of the file for `alang check`, `ts`, `build`, `test` and `run <file>`.

  In a round the session's directory is the codebase's, so the file it writes as `text.ts` is `./text.ts`. An export file run directly (`alang run export/text.alang`) resolves `./text.ts` inside `export/` and gets E0406, which names the path it looked at. That is accepted, since the export is for Git and review.
- **Not allowed, E0260:** `npm:`, `jsr:`, `node:`, `http:`, `https:`, `file:` and any other scheme; absolute paths; `..`; a backslash. A package or a `node:` module is imported inside the module, where Deno resolves it. Only `node:` modules and other local modules run on every host there. Acceptance refuses a module's remote (`http:`, `https:`) imports (`--no-remote`, O16), so such a module is never accepted, and loads `npm:` and `jsr:` packages only from Deno's cache (`--cached-only`; its effect on `npm:` and `jsr:` to verify).
- **Emitted specifier.** `toolchain.ts` computes it like the runtime import (`emitTo`, `:40-47`):
  - `relative(dirname(absOut), resolve(base, path))`, with `/` separators and `./` added when it does not start with `.`;
  - `emitProgram` takes `targetImport?: (path: string) => string`, the identity by default, so `alang ts` and `compile` print the path as written.
- **Git.** The module lives in the project, beside `export/`, and is committed with it. The database stores only the `target` text (E15).

### 2.3 Checking

- **`declare()`**: unchanged; an extern's `FnSig` is a function's.
- **`checkFn`** for `def.target !== null`:
  1. **E0260** for a malformed target (2.2). Section `target`, `at` `target: "<text>"`. The first rule that fails decides the message:

| Case | Message | Fix |
| --- | --- | --- |
| A scheme (`/^[a-z][a-z0-9+.-]*:/`) | "A target names a TypeScript module of this project, such as `\"./text.ts#slugify\"`; a package or a `node:` module is imported inside that module." | none |
| Starts with `/`, has a `..` segment or a `\` | "A target stays inside the project: its path starts with `./`, from the codebase's directory (for a file command, the file's), and has no `..`." | none |
| No `#` | "A target ends with `#` and the name its module exports: `\"./text.ts#slugify\"`." `expected` `target: "<text>#<short name>"` | none |
| Valid once `./` is put in front | "A target's path starts with `./`, as a relative import does." | `{ replace: "\"<text>\"", with: "\"./<text>\"" }` |
| Not `.ts` | "A target names a `.ts` module, which Deno and Node.js both load: `\"./text.ts#slugify\"`." | none |
| Export not an identifier | "After `#` comes the name the module exports, a JavaScript identifier such as `slugify`." | none |
| Anything else | "A target's path is made of letters, digits, `_`, `-` and `.`, with `/` between directories: `\"./lib/text.ts#slugify\"`." | none |

  2. **E0261** (E6) for each parameter whose resolved type holds a function value (`containsFn`, which reaches records and cases). Section `in`, `at` the parameter as printed (`by: (Int, Int) -> Order`), no fix:
     > "`by: (Int, Int) -> Order` holds a function value, and an `extern fn` takes none: its TypeScript would call alang code with values nothing checks, and could catch its traps (2.5). Pass data, and keep the function in alang."

     `out` is E0237 already, for every function (F4).
  3. `requires`, `ensures` and `examples` as for a `fn`.
  4. No body: no `block`, no E0218, no E0230. The effects are declared, not derived (2.5).
- **Calls of externs** are calls of functions: E0230 for missing effects, E0232 and E0233 for effects in lambdas and conditions, awaiting (`info.effectful`) for an effectful extern.

### 2.4 E2, E8: the boundary

**Re-examined and kept from the roadmap, and extended.** Every result is checked against `out`. A value that does not fit traps where it enters alang, at its cause (5.3, 5.6). Trusting it would let a NaN break `x == x` (3.9), a fraction break `Int`, and a missing field surface far away. The check is deep: a shallow one would pass `[1.5]` as a `List<Int>`. Two extensions:
- **Results are rebuilt.** The value alang keeps holds exactly the declared fields and cases. Records are rebuilt through their constructor, which checks `where`. So extra properties cannot break `$rt.eq`, and later changes by the module to an object it returned cannot reach alang.
- **Arguments are copied out** (`to_host`). The module may sort or change what it gets (O9: the input stays `3,1,2`), and alang values stay immutable (4.5).

**Forms** (one per type, so the check follows from the written type alone, and a module builds every value without importing the runtime):

| alang type | Passed to TypeScript | Accepted back (otherwise a trap) | Form named in the message |
| --- | --- | --- | --- |
| `Int` | a number | a number for which `Number.isSafeInteger` holds; `-0` becomes `0` (S1) | a safe integer |
| `Float` | a number | a number that is not NaN; infinities and `-0` are values (Overview, 7.5) | a number that is not NaN |
| `Bool` | a boolean | `true` or `false` | `true` or `false` |
| `String` | a string | a string for which `isWellFormed()` holds (Overview: Unicode scalar values) | a string without lone surrogates |
| `Unit` | `null` | `null` or `undefined` (a function without `return`) | `null` or `undefined` |
| `List<T>` | a new array | an array (`Array.isArray`), each item checked | an array |
| `Map<K, V>` | a new `Map`, entries in key order | a `Map` (`instanceof Map`), keys and values checked, rebuilt in key order | a `Map` |
| `Option<T>` | `{ tag: "Some", value }` or `{ tag: "None" }` | the same | `` `{ tag: "Some", value }` or `{ tag: "None" }` `` |
| `Result<T, E>` | `{ tag: "Ok", value }` or `{ tag: "Err", value }` | the same | `` `{ tag: "Ok", value }` or `{ tag: "Err", value }` `` |
| `Order` | `{ tag: "Less" }`, `{ tag: "Equal" }` or `{ tag: "Greater" }` | the same | those three |
| a record | a new object with its fields | an object with every field (other properties dropped), rebuilt by the constructor, which checks `where` | an object with the fields `a`, `b` |
| a variant | `{ tag: "Name" }` or `{ tag: "Name", value }` | the same, the tag one of its cases | `` `{ tag: "A" }` or `{ tag: "B", value }` `` |

The brief asks for `Float` to be finite. The spec says otherwise: only NaN traps, "including from an extern fn" (Overview), and infinities are ordinary values (7.5). The spec wins.

**Runtime** (`runtime.ts`, a new part "---- extern functions ----", runtime-neutral; the prototype is `p9/extern_rt.ts`, O9):

```ts
export type Shape =
  | { readonly kind: "Int" | "Float" | "Bool" | "String" | "Unit" }
  | { readonly kind: "List"; readonly item: Shape }
  | { readonly kind: "Map"; readonly key: Shape; readonly value: Shape }
  | { readonly kind: "Option"; readonly some: Shape }
  | { readonly kind: "Result"; readonly ok: Shape; readonly err: Shape }
  // Thunks, so that a recursive type refers to its own shape.
  | { readonly kind: "record"; readonly name: string; readonly fields: () => Readonly<Record<string, Shape>>;
      // deno-lint-ignore no-explicit-any
      readonly make: (fields: any) => unknown }    // as in the probe (O9)
  | { readonly kind: "variant"; readonly name: string; readonly cases: () => Readonly<Record<string, Shape | null>> };

export function to_host(shape: Shape, value: unknown): unknown;      // a fresh copy, a Map as a JS Map
export function extern_call(definition: string, target: string, module: object, name: string,
  args: readonly unknown[], out: Shape): unknown;                    // pure: synchronous
export async function extern_call_async(/* the same */): Promise<unknown>;  // effectful: awaited
```

`Order` is a `variant` shape with the cases `Less`, `Equal`, `Greater`.

**Traps** (`definition` the extern, `at` the target text such as `./b.ts#half`, so E0403 adds no "(at …)"):

| Cause | Kind | Message |
| --- | --- | --- |
| The result does not fit | `extern` | "`./b.ts#half` returned a value that does not fit `out: Int`: `result` is 1.5, where `Int` needs a safe integer." The place is a JavaScript path: `result`, `result[2]`, `result.value`, `result.count`, `result.get("a")`, `result.keys()[0]`; the value is described as `undefined`, `null`, a number (`NaN`, `1.5`), a JSON-quoted string cut at 40 characters, `true`/`false`, "an array", "a Map", "a function", "a Promise", "an object with tag \"X\"" or "an object" |
| A thenable from a pure extern | `extern` | "`./b.ts#later` returned a Promise; an `extern fn` with `effects: none` returns its value at once." A rejection handler is attached first, so a rejected promise does not end the process later |
| An exception | `extern` | "`./b.ts#fails` threw TypeError: bad input." (name and message; a thrown non-`Error` is shown with `String`) |
| A refusal for lack of permission (`name === "NotCapable"`, or `code === "ERR_ACCESS_DENIED"`) | `effect` | "`./b.ts#peek` was refused by the host: <host message>. An `extern fn` may do only what its `effects` declare, and a program only what `main` declares (2.5)." |
| The export is missing or not a function (only after the module changed since acceptance) | `extern` | "`./b.ts#nothere` is not a function its module exports." |
| A record's `where` | `where` | the constructor's own trap, as today: "Invariant of b.Span violated: start <= end" |

### 2.5 The emitter

For a program with at least one extern, `emitProgram` writes, after the runtime import:
1. one `import * as $extN from "<specifier>";` per distinct target module, numbered in the order of first use (definition order);
2. one `const $shapeN: $rt.Shape = …;` per distinct type that crosses the boundary, keyed by its printed full type (`b.Tree`, `Map<String, Int>`, `b.Pair<Int, String>`).
   - Built-ins nest directly. A user type refers to the shapes of its fields through the thunk. A generic type's shape substitutes its arguments into its fields, as the checker does for a construction.
   - Built from the written types of the signature, and from `info.shapes` for the fields of user types (to verify the exact entry point after `generics`).

Each extern becomes a wrapper with the contract lines of `fn()`; `requires` comes before the call, `ensures` after it, on `result`:

```ts
export function text$encode(text: string): string {
  return $rt.extern_call("text.encode", "./text.ts#encode", $ext1, "encode", [text], $shape1) as string;
}

export async function files$touch(path: string): Promise<$rt.Result<$rt.Unit, string>> {
  return (await $rt.extern_call_async("files.touch", "./files.ts#touch", $ext2, "touch", [path], $shape4)) as
    $rt.Result<$rt.Unit, string>;
}
```

- An argument of type `Int`, `Float`, `Bool` or `String` is passed as it is; any other through `$rt.to_host($shapeN, x)`.
- At the end, after `$examples` (and const's `$constants`), the list of externs for acceptance, emitted even when empty:

```ts
export const $externs: readonly $rt.Extern[] = [
  { definition: "text.encode", target: "./text.ts#encode", module: $ext1, name: "encode" },
];
```

The casts make `deno check` pass whatever the module declares (O9). The runtime check is the guard; TypeScript does not compare the module's signature with alang's.

### 2.6 E10, E11: acceptance in a separate process

**When.** A program that has at least one extern, in every path that loads the built module: `acceptDefinitions` (and so `accept`, `alang check`, `ts`, `build`, `run`, `Codebase.acceptHere`, `Codebase.run`) and `testExamples` (`alang test`). A program without an extern keeps today's in-process path: no change for it and no new permission.

**Steps** (`toolchain.ts`, `runIsolated(built, options)`, replacing `load` plus `runConstants` plus `runExamples` for such a program):
1. **Modules exist.** For each distinct target module, `Deno.stat(resolve(base, path))` must find a file. Otherwise **E0406**, once per module, at its first extern, and nothing is spawned.
2. **Permission.** `Deno.permissions.querySync({ name: "run", command: Deno.execPath() }).state !== "granted"` gives **E0408** at the first extern (O5 probed the query without `command`; with it, to verify). There is never an in-process fallback.
3. **Entry.** Write `<out>.check.ts` beside the out file (`out/accept-<pid>-<n>.check.ts`, `out/<main>.check.ts`):

```ts
// Generated by alang: runs the externs' checks, the constants and the examples of accept-41-1.ts without permissions.
import { run_isolated } from "<runtime import>";
import { $constants, $examples, $externs } from "./accept-41-1.ts";

run_isolated($externs, $constants, $examples, "<marker>");
```

   The marker is a fresh `crypto.randomUUID()` per acceptance, written into the entry. Without the read permission, foreign code cannot learn it.
4. **Spawn.** `new Deno.Command(Deno.execPath(), { args: ["run", "--no-prompt", "--no-config", "--no-lock", "--no-remote", "--cached-only", "--quiet", entry], cwd: dirname(entry), stdin: "null", stdout: "piped", stderr: "piped", env: { NO_COLOR: "1" } })`.
   - No `--allow-*` flag at all. The child never writes to the tool's own stdout, which is the MCP channel.
   - `--no-config`, so a project `deno.json` changes nothing in acceptance.
   - `--no-remote` and `--cached-only`, so loading the modules fetches nothing from the network (O16). What the permissions do not cover is module loading itself: a module's static imports at fixed paths, a JSON file outside the project included, are read when it loads (O15).
5. **Time limit.** `setTimeout(() => child.kill("SIGKILL"), options.limitMs ?? 30_000)`, then `await child.output()`, which returns the lines printed before the kill (O5).
6. **Reading.** Only stdout lines that start with the marker count; everything else (a module's own `console.log`) is ignored:
   - `<marker> start constant <i>` and `<marker> start example <i>`, before each item;
   - `<marker> done <json>` at the end.

   If the process was killed, **E0407** names the last item started. Without a `done` line, **E0406** reads stderr: the first module whose `file://` URL appears there is blamed, at its first extern, else `definition: null`. Otherwise the JSON is decoded (`decode_value` for actual values, O7) into the `ConstantResult[]` and `ExampleResult[]` that the in-process path gives, and the rest of acceptance is unchanged. Missing exports in the JSON are E0406, and then no constant or example has run (5.6: one cause).
7. The entry is removed in a `finally`. `Codebase.removeAcceptFile` removes `accept-…check.ts` too, so a killed server leaves nothing behind except during an acceptance, as today.

**`run_isolated`** (`runtime.ts`, runtime-neutral) writes through the `console.log` it captured when the runtime module loaded. The runtime is the first import of the entry and of the program, so it evaluates before any target module, which could replace `console.log`.
- It first checks every `$externs` entry with `typeof module[name] === "function"`. If any is missing, it prints `done` with `missing: [{ definition, target, functions }]`, where `functions` names the module's exported functions.
- Otherwise it evaluates the constants and runs the examples. `runConstants` and `runExamples` gain an optional `before(i)` hook for the progress lines. Then it prints `done` with `{ missing: [], constants, examples }`, each example's `actual` through `encode_value`.

**`encode_value` / `decode_value`** (runtime): JSON, except `-0`, `Infinity` and `-Infinity`, which become `{ "$float": "-0" | "Infinity" | "-Infinity" }`, and a `SortedMap`, which becomes `{ "$map": [[key, value], …] }` in key order and is rebuilt with `map_literal`. Field names are snake_case and tags PascalCase, so `$float` and `$map` cannot collide (O7). `undefined` (the actual value of a trapped example) is encoded as `null`.

**Diagnostics** (`examples.ts`, `isolationDiagnostics`; section `target` for E0406, `examples` or `body` for E0407):

| Code | Case | `at` | Message |
| --- | --- | --- | --- |
| E0406 | Missing file | `target: "./text.ts#encode"` | "The module `./text.ts` of `text.encode` does not exist: write it at `<absolute path>`." (With several externs: "of `text.encode` and `text.decode`".) |
| E0406 | Does not load | as above | "The module `./text.ts` of `text.encode` cannot be loaded: SyntaxError: Expression expected (at `./text.ts:2:13`)." The first stderr line without `error: `, and the first `at file://…` location as a path from `base` |
| E0406 | Missing export | as above | "`./text.ts` exports no function `encode`; its functions are `encodeText`, `decode`." ("it exports no function" when there are none) |
| E0406 | No result, no module named | `<program>` | "The examples' process ended without a result (exit code 3): <first stderr line, or `no output`>." |
| E0407 | Killed during an example | the example's text | "The example did not end within 30 seconds, so its process was stopped: foreign code that never returns, or a recursion too slow for an example." The limit is shown in seconds, `limitMs / 1000` |
| E0407 | Killed during a constant | `const <name>` | "Evaluating the constant did not end within 30 seconds, so its process was stopped." |
| E0407 | Killed before any item | `<program>` | "Loading the program's modules did not end within 30 seconds." |
| E0408 | No `run` permission | `extern fn <first extern>` | "A program with an `extern fn` runs its examples in a separate process without permissions, and this tool may not start one. Start it with `--allow-run`; for the MCP server: `deno run --allow-read --allow-write --allow-run <path>/src/cli.ts mcp --dir <dir>` (README)." |

**`AcceptOptions`** (`toolchain.ts`), passed by `accept`, `acceptDefinitions`, `build` and `testExamples`:

```ts
export interface AcceptOptions {
  // The directory a target is relative to (2.2): the codebase's, or the file's. Default: the current directory.
  readonly base?: string;
  // How long the separate process may run; tests shorten it. Default: 30_000.
  readonly limitMs?: number;
  // Run in a separate process although there is no extern; for tests of the process alone.
  readonly isolate?: boolean;
}
```

`cli.ts` passes `base: dirname(resolve(file))`; `Codebase` passes `base: this.dir`.

**Registration** (E11). `README.md:56` becomes `claude mcp add alang -- deno run --allow-read --allow-write --allow-run /path/to/alang/src/cli.ts mcp --dir /path/to/project`, with one sentence: "`--allow-run` lets acceptance run the examples of a program with an `extern fn` in a separate process without permissions." `scripts/playground-round.sh` gets `"--allow-run"` in its `mcp.json` args. Both changes go in commit 2. The user's own playground registration is outside the repository. It keeps working until its codebase holds an extern, and then E0408 says what to change. Report it to the user; it is not changed by an agent.

### 2.7 E12: effects

- **Declared, not checked (2.5).** The checker takes an extern's `effects` as written. Callers declare them (E0230), lambdas and conditions cannot call an effectful one (E0232, E0233), and a pure one is called synchronously.
- **At run time** the program has the Deno permissions of `main`'s effects (Toolchain). An extern that needs more is refused, and the refusal traps `effect` (2.4). Within `main`'s effects, an extern with `effects: none` can still read a file; Deno's permissions are per process. `time`, `random`, `log` and `console` need no permission, so nothing stops them.
- **At acceptance** the process has no permission at all. A pure extern that touches files, the network, the environment or processes traps `effect` in its example (E0403). This is a real check of `effects: none` for the effects that have a permission. Output, the clock and randomness are not caught (Later).
- **A module can swallow a refusal** with its own `try` (O9: `touch` returned `Err` with Deno's message). That is the module's decision, recorded under Risks.

### 2.8 E13–E15: the database

- **Kind.** An extern is stored as kind `fn`: no schema change and no migration beside const's C11.
- **Text and hits.**
  - The `text` column is the canonical text, `target` included. The `signature` column is `printSignature`, which leaves `target` out.
  - `storedHead` writes `extern fn <name>(…): Out, effects: …` for an extern. That is its `list` and `search` hit and its `search_type` line, so it stays recognizable as an assumption (2.5).
  - `context` of a caller lists the extern with that signature text. `context` of the extern gives its full text, with `target`.
- **`headerName`** (`codebase.ts:380-383`): after const and generics, `/^(?:fn|type|const|extern fn) ([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?:<[^>]*>)?\s*$/`.
- **E0505's `expected`** prints the stored header (`extern fn m.f`), not `${kind} ${name}`.
- **Interface (E14).**
  - The sections of a `fn`, compared alike for every pair of `fn` and `extern fn` (`interface.ts:52-61` needs no change).
  - `target` is not interface, as `body` is not. So `replace` may point an extern at other code, or turn `fn m.f` into `extern fn m.f` and back, and the callers follow if the other sections stay (6: "if the signature is unchanged, all callers follow automatically").
  - Comment `interface.ts:8` gets "an `extern fn` likewise; its `target` is not interface".
- **The hash (E15)** is that of the text: it covers the target's name, not the module's code.
  - Acceptance loads the module afresh in every separate process (2.6), so each change tests the current code, and so does every `alang db run`.
  - A module edit that breaks an extern's example is reported at the next acceptance of anything. That is the action at a distance under Risks.
- **Unchanged:** `rename`, `remove`, `callers`, `history`, export, import and sync. They work on texts and names; `rename` keeps the target text.

### 2.9 MCP (`src/mcp.ts`)

- **Instructions**, the sentence "Read and change definitions only through these tools, never by editing files." becomes "Read and change definitions only through these tools, never by editing files; the TypeScript module an `extern fn` names is the one file you write." That is +70 characters. With const's +27 it stays below `mcp_test.ts:500`'s 3,000 without the spec path: about 2,890 (O12; to verify on the merged text).
- No tool description changes: the hits carry `extern fn` by themselves, and the card teaches the form.

### 2.10 Spec changes (exact texts; each goes in the commit of its rule)

Section 7.12 arrives in commit 3. Commit 1 writes the 2.5 and 7.3 texts without their "(7.12)", and commit 3 adds it.

**Commit 1.**
- **Overview table, the `extern fn` row:** "| `extern fn` | Function whose code is TypeScript: the sections of a `fn`, with `target` instead of `body` |".
- **1.1** (after const's version): "- **1.1 Fixed section order.** A function consists of `doc`, `in`, `out`, `effects`, `requires`, `ensures`, `examples`, `body`, in exactly this order; an `extern fn` has `target` in place of `body`, and a constant consists of `doc`, `out`, `body`. Every section is mandatory; an empty section is written `none`."
- **2.5:** "- **2.5 Trust boundary.** The effects of an `extern fn` are declared, not checked. Every `extern fn` is thereby recognizable as an unchecked assumption. Its result is checked against its `out` where it returns, so a wrong value traps there instead of spreading (7.12)."
- **Grammar:** the `extern_def` production of 2.1, after `const_def`.
- **4.4** (after const's version): "- **4.4 Named block ends.** Blocks end with `end if`, `end for`, `end match`, `end fn <name>`, `end type <name>`, `end const <name>` or `end extern fn <name>`. There are no curly braces and no significant indentation."
- **7.1:** delete const's row "| `extern fn` (not parsed yet, E0199) | … |".
- **7.2, Reserved words, appended:** "`target` is not reserved: it is a section word only in an `extern fn`, and names a value anywhere."
- **7.2, Foreign forms, appended:** "`import` is E0006 too; code from a TypeScript module is called through an `extern fn` (7.12)."
- **7.3, a new bullet after "Generic functions"** (generics), then two blocks with their fences at column 0 (`spec_test`'s regex is `` ^``` ``). The second block is TypeScript (```` ```ts ````), which `spec_test` writes as `text.ts` (commit 3):

> - **Extern functions.** `extern fn text.encode` has the sections of a `fn` with `target: "./text.ts#encode"` in place of `body:`, then `end extern fn text.encode`: the function is `encode`, exported by the TypeScript module `text.ts`, which you write in the codebase's directory (7.12). It is called like any function. One with `effects: none` has examples (5.1), which test the TypeScript; it takes no function values (E0261) and no type parameters (E0101).

```
extern fn text.decode
  doc: "The text with its percent-encoding undone, as JavaScript's decodeURIComponent does it; None if it is not valid percent-encoded UTF-8."
  in:
    text: String
  out: Option<String>
  effects: none
  requires: none
  ensures: none
  examples:
    decode(text: "caf%C3%A9") == Some("café")
    decode(text: "100%") == None
  target: "./text.ts#decode"
end extern fn text.decode

extern fn text.encode
  doc: "The text percent-encoded for a URL, as JavaScript's encodeURIComponent does it."
  in:
    text: String
  out: String
  effects: none
  requires: none
  ensures: none
  examples:
    encode(text: "a b&c") == "a%20b%26c"
    encode(text: "é") == "%C3%A9"
  target: "./text.ts#encode"
end extern fn text.encode
```

```ts
export function encode(text: string): string {
  return encodeURIComponent(text);
}

export function decode(text: string): { tag: "Some"; value: string } | { tag: "None" } {
  try {
    return { tag: "Some", value: decodeURIComponent(text) };
  } catch {
    return { tag: "None" };
  }
}
```

- **7.11:** a row after the earlier phases' rows: "| E0260, E0261 | `extern fn`: a target that is not `./path.ts#name`, a function value in its signature |".

**Commit 2.**
- **Toolchain, first paragraph:** "The transpiler is written in TypeScript and runs on Deno. Target language and tool language are thereby the same, so examples run on the real target semantics: in the same process as the checker, or, for a program with an `extern fn`, in a process of their own (below)."
- **Toolchain, a new bullet after "Effects enforced at runtime":** "- **Foreign code in its own process.** A program with an `extern fn` runs its constants and examples in a separate Deno process without any permission, without remote modules and with a time limit, so that the TypeScript of an extern cannot read or write files, use the network or the environment, or start processes while it is tested (only the modules it imports are read as it loads), and every acceptance loads its current code. The tool therefore needs the permission to start processes (`--allow-run`)."
- **7.11:** "| E0401 to E0404 | … |" (const's version) gains a row after it: "| E0406 to E0408 | Foreign code at acceptance: a module that cannot be loaded, a time limit, a tool without `--allow-run` |".

**Commit 3.**
- **Section 5 table, a new row after `examples`:** "| `out` of an `extern fn` | What its TypeScript returns | At every call |".
- **Toolchain, "Effects enforced at runtime":** "- **Effects enforced at runtime.** A program is started with exactly the Deno permissions that its `main` declares as effects (table below). This also catches an `extern fn` whose TypeScript code does more than `main`'s effects allow (rule 2.5); within them, and for the effects that need no permission, an extern is trusted."
- **Toolchain, "Runtime-neutral output", appended:** "The module of an `extern fn` decides for itself: it runs everywhere if it uses what Deno, Node.js and Bun share (web APIs, `node:` modules) and TypeScript that Node.js can strip (no `enum`, `namespace` or parameter properties)."
- **Storage, the layout block:** a line after `out/`: "  text.ts       a TypeScript module that an `extern fn` names in its `target`, in Git with the export".
- **7.1, the row "Taking URLs apart or encoding a query":** "| Taking URLs apart or encoding a query | An `extern fn` over JavaScript's `encodeURIComponent`, `decodeURIComponent` or `URL` (7.12); `std.string.cut` and `split` take a query apart, `std.string.join` builds one |".
- **7.6, Acceptance, appended:** "In a program with an `extern fn`, the constants and examples run in a separate process without permissions (7.12)."
- **A new section 7.12**, after 7.11, so that no section number moves:

> ### 7.12 TypeScript through `extern fn`
>
> An `extern fn` is a function whose code is TypeScript (2.5). It is written like a `fn` (7.3) and called like one. This section says where its code is found, how values cross into TypeScript and back, and how it is tested.
>
> - **The module.** `target: "./text.ts#encode"` names the function `encode` that the module `text.ts` exports. The path starts with `./`, uses `/` between directories, has no `..`, and ends in `.ts`. It is relative to the codebase's directory, where `alang.db` is, or, for `alang check`, `run` and the other file commands, to the directory of the file (E0260). The module is a file you write and keep in Git beside `export/`; the codebase stores only the `target` text, so the hash and the history cover the name, not the code. A package or a `node:` module is imported inside the module, never named in a target. For the program to run on Node.js too, the module uses what Deno and Node.js share (web APIs such as `encodeURIComponent`, `node:` modules) and TypeScript that Node.js can strip: no `enum`, `namespace` or parameter properties.
> - **Values.** An argument reaches the TypeScript as a fresh copy, which it may change. The result is checked against `out` and rebuilt, so a value that does not fit traps (`extern`) at the call, naming the place in it, such as `result[2]`, and the form it needed:
>
> | Type | In TypeScript |
> | --- | --- |
> | `Int` | a number that is a safe integer; `-0` becomes `0` |
> | `Float` | a number, not NaN; infinities and `-0` are values |
> | `Bool`, `String` | a boolean, a string; a returned string has no lone surrogates |
> | `Unit` | `null`; a returned `undefined` counts too |
> | `List<T>` | an array |
> | `Map<K, V>` | a `Map`, its keys in order when passed |
> | `Option<T>`, `Result<T, E>`, `Order` | `{ tag: "Some", value }` or `{ tag: "None" }`; `{ tag: "Ok", value }` or `{ tag: "Err", value }`; `{ tag: "Less" }`, `{ tag: "Equal" }` or `{ tag: "Greater" }` |
> | A record | an object with its fields; other properties of a returned one are dropped, and its `where` is checked |
> | A case | `{ tag: "Name" }`, or `{ tag: "Name", value }` with its value |
>
>   Function values cross neither way (E0261, E0237), and an extern has no type parameters (E0101).
> - **Calls.** An extern with `effects: none` is called like any pure function and returns its value at once; a `Promise` traps. One with effects is awaited, so its TypeScript may be `async`. `requires` is checked before the call and `ensures` after the result is checked, as for a `fn`. An exception from the TypeScript traps (`extern`); a refusal by the host for lack of a permission traps (`effect`).
> - **Effects.** They are declared, not checked (2.5). Callers declare them as for any function (E0230), and a running program has the permissions of `main`'s effects, so an extern that does more than those is refused. Within them, and for `time`, `random`, `log` and `console`, which need no permission, nothing stops it.
> - **Acceptance.** A pure extern has examples (5.1); they test its TypeScript. In a program with an `extern fn`, acceptance runs the constants and examples in a separate Deno process without any permission and without remote modules, so foreign code cannot read or write files, use the network or the environment, or start processes while it is tested: a pure extern that tries traps (`effect`, E0403). Only the modules it imports are read as it loads; a remote (`https:`) import is refused there, so such a module is not accepted. The process is stopped after 30 seconds (E0407). A module that is missing, does not load, or does not export the function is E0406. The tool needs the permission to start that process: `alang` is installed with `--allow-run`, and the MCP server is started with it too (E0408). Every acceptance loads the module afresh. So a changed module is tested by the next change of any definition, or by `alang db run`, and an example it breaks is reported there, as E0402 or E0403 of the extern.

**Commit 4.**
- **6, the Storage paragraph after the layout:** append "An `extern fn`'s module lies beside `export/` and is versioned with it by Git; the database holds its `target` text only."
- **7.10, the `list(module)` row:** after "a function's signature is like `fn std.string.split(...)`…", insert "an `extern fn`'s starts with `extern fn`,".
- **7.10, Interface changes, appended:** "An `extern fn`'s `target` is not part of its interface: `replace` may point it at other code, or turn a `fn` into an `extern fn` of the same name and back, and callers follow as long as the other sections stay."

### 2.11 `docs/decisions.md` and `docs/notes.md`

`decisions.md`:
- **Lexical, Keywords:** "`target` is a section word only in an `extern fn` and is not reserved (E4); `import` names the extern."
- **Syntax:** a new row "`extern fn`" (E1, E4; P1–P6).
- **Type checking:** a new row "Extern functions" (E0260, E0261; no body; E7).
- **Semantics and runtime:**
  - a new row "Extern boundary" (E2, E5, E8, E9; the forms table in short);
  - "Representation in TS": wrappers, `$externs`, shapes.
- **Effects:** a new row "Extern effects" (E12).
- **Examples and acceptance:** a new row "Foreign code at acceptance" (E10, E11, the codes, the time limit, why no fallback and no Worker).
- **Database:** a new row "Extern functions" (E13–E15).
- **MCP server:** "Registration: `--allow-run`" and the instructions phrase.
- **Temporary limits:** delete "`extern fn` is not parsed yet." (const leaves this line).
- **Open questions:**
  - "Form of `extern fn`." is deleted;
  - new: "The code of an `extern fn` outside the hash and the history (E15)", and "Effects of a pure extern that no permission covers (console, log, clock, random)".

`notes.md` (commit 6): an item in "Current state" with the test count and "Next"; the review list E1–E20, language changes first; in "From the effect checker", mark the two `extern fn` bullets and "Examples run with the tool's permissions" as resolved for programs with externs; under "Ideas", the output attribution per example and a memory cap for the separate process.

### 2.12 Card (`src/card.ts`) (E17)

Measured on the reconstruction of the card after `generics` (O11). The program is unchanged and no code is added. Re-measure on the merged card; keep the net growth at or below zero bytes.

| Card | `CARD.split("\n").length` | Bytes | Longest line |
| --- | ---: | ---: | ---: |
| After `statements`, `fn-types`, `const`, `generics` | 159 | 9,846 | 118 |
| After this phase | 158 | 9,836 (−10) | 117 |

**X1**, a new Definitions bullet after the Generic bullet:

```
- `extern fn`: a `fn` with `target: "./text.ts#slugify"` for `body:`, `end extern fn <full name>`: `slugify`,
  exported by `text.ts`, TypeScript you write beside `alang.db`. Values cross as JavaScript: `List` an array, a
  record an object, `Unit` `null`, a case `{ tag: "Some", value: 1 }`, a `Map` a `Map`. The result is checked
  against `out`; with `effects: none` it returns at once (no `Promise`) and has examples.
```

The example is `slugify`, not `encode`, so the card does not hint at the round's task.

**X2**, "Not in alang" loses `` `extern fn`, `` and is rewrapped:

```
No comments (the `doc` describes), imports, `var`, assignment, `null`, exceptions, `while` (use recursion), `?`,
braces, `;`, `'`, `===`, `&&`, `||`, `!`, tuples, concurrency. Most get E0006, naming the alang form.
```

**Cuts that pay for X1:**
1. **The `search_type` bullet** (2 lines). No round used `search_type` in five rounds (notes, "From the std-net round"); the instructions (points 1 and the opening) and the tool's own description explain it. `card_test.ts:91` loses `search_type` from the named tools, and `:117` loses its shown text. The call at `:135` stays, testing the tool.
2. **The diagnostics bullet** in one line: "- A rejected change returns diagnostics; where one has a `fix` (`replace` by `with`), apply it and send again." Instruction point 4 lists the fields.
3. **The type-argument bullet** "Type arguments only where no argument fixes them (E0209): `std.list.empty<Int>()`." E0209 carries its fix both ways, and the Lists bullet shows `std.list.empty<T>()`. The card still names 26 codes; the test wants at least 20.
4. **The operations bullet** in two lines:

```
- `add(text)` adds a definition, `replace(name, hash, text)` the version whose hash a query returned, and
  `submit(changes)` several in one transaction (an interface change with its callers): all are accepted, or none.
```

## 3. Commits, in order

**Cut order** if the run must stop early: stop after commit 4 and do commit 5 in the next run before the round. Commits 1 to 4 cannot be cut. Commit 2 comes before commit 3 so that no build ever runs foreign code in the tool's process: after commit 1 an extern parses and checks, and the emitter refuses it.

1. **[language] `extern fn`: syntax, printing, checking** (E1, E3's form check, E4, E6, E7; E0260, E0261; P1–P7).
   - `ast.ts`, `parser.ts`, `printer.ts`, `check.ts`, `lexer.ts` (P7's text), `refs.ts` (carry `target`), `interface.ts` (the comment).
   - `codebase.ts`: `storedHead`, `headerName`, E0505's `expected`.
   - `emit.ts`: an extern is **E0303** "An `extern fn` cannot be built yet." at `extern fn <name>`, removed in commit 3.
   - Spec: Overview row, 1.1, 2.5, grammar, 4.4, 7.1, 7.2, 7.3 (bullet and blocks), 7.11 row.
   - `spec_test.ts`: `extern` blocks join the definition blocks; the inventory gains 1 block and 2 definitions. The `ts` block is ignored until commit 3.
   - `decisions.md`: Lexical, Syntax, Type checking, Temporary limits, Open questions.
   - Tests 4.1.
2. **Acceptance in a separate process** (E10, E11; E0406 to E0408; `AcceptOptions`).
   - `toolchain.ts`: `runIsolated`, the entry, the spawn, the limit, `isolate` for tests, `base` threaded through.
   - `runtime.ts`: `run_isolated`, `encode_value`, `decode_value`, the `before` hooks of `runExamples` and `runConstants`, the type `Extern`.
   - `examples.ts`: `isolationDiagnostics`. `cli.ts`: `base`. `codebase.ts`: `base`, `removeAcceptFile`. `emit.ts`: `$externs` (empty until commit 3).
   - `README.md:56` and `scripts/playground-round.sh`: `--allow-run`.
   - Spec: Toolchain (first paragraph, new bullet), 7.11 row. `decisions.md`: Examples and acceptance, MCP server (Registration).
   - Tests 4.2.
3. **Externs run: emitter, boundary, traps** (E2, E5, E8, E9, E3's resolution, E12).
   - `emit.ts`: target imports, shapes, wrappers, `$externs`; commit 1's E0303 goes.
   - `runtime.ts`: `Shape`, `to_host`, `from_host`, `extern_call`, `extern_call_async`.
   - `toolchain.ts`: `targetImport` from `base`; the missing-module check.
   - Spec: section 5 row, Toolchain (Effects, Runtime-neutral), Storage layout line, 7.1 URL row, 7.6, 7.12.
   - `spec_test.ts`: accepts the 7.3 blocks with the `ts` block as `text.ts` in a scratch directory.
   - `decisions.md`: Semantics and runtime, Effects.
   - Tests 4.3.
4. **The codebase and the MCP server** (E13–E15).
   - `codebase.ts` (`acceptHere` and `run` with `base`, already from commit 2; the tests here), `mcp.ts` (instructions).
   - Spec: section 6 Storage paragraph, 7.10 rows. `decisions.md`: Database, MCP server.
   - Tests 4.4.
5. **The card** (E17): X1, X2, cuts 1–4; `card_test.ts` as in 2.12. Re-measure first. `decisions.md`, MCP server, Card: one sentence.
6. **Notes and the round.** `notes.md` (2.11). Save the prompt of section 7 as `~/coding_projects/alang-rounds/prompts/query.md`.

## 4. Tests

Programs with an extern stay out of the two lists that are built without a module and checked as a whole:
- `check_test`'s `accepted`: `clean(source)` pushes there (`check_test.ts:88-94`), and the test at `:1452-1463` builds each with `build(source, out)` and runs `deno check`. Extern programs use `clean(source, {})`; with options given, nothing is pushed;
- `emit_test`'s `PROGRAMS`: built at load by `build(source, out)` (`emit_test.ts:846-870`). Extern programs are built on their own, after their module is written into their scratch directory, with `build(source, out, { base })`. Their out files join the `deno check` list of `emit_test.ts:874-895`, and their examples run through `testExamples(built, { base })`, which isolates.

Values are computed by hand, and checked against `round/reference.mjs` where JavaScript decides them (O13).

**Fixtures:**
- **`TEXT`**, module `text`: the two 7.3 blocks plus
  - `fn text.pair(key: String, value: String): String`, with the example `pair(key: "q", value: "café au lait") == "q=caf%C3%A9%20au%20lait"` and the body `return std.string.join(parts: [encode(text: key), "=", encode(text: value)], separator: "")`;
  - `fn text.main`, with `effects: env, console`, which prints `pair(key: "q", value: <first argument>)`;
  - `text.ts` as in 7.3.
- **`B`**, module `b`, with `b.ts`. Each extern is pure unless stated, and has the example given here, which is what the tests run:

| Extern | `out` | `b.ts` returns | Example |
| --- | --- | --- | --- |
| `half` | `Int` | `1.5` | `half() == 1` |
| `nan` | `Float` | `NaN` | `nan() == 0.0` |
| `inf` | `Float` | `Infinity` | `inf() == 1.0 / 0.0` |
| `zero` | `Int` | `-0` | `zero() == 0` |
| `lone` | `String` | `"a\uD800"` | `lone() == "a"` |
| `nothing` | `Unit` | `undefined` (no `return`) | `nothing() == Unit` |
| `missing` | `Option<Int>` | `null` | `missing() == None` |
| `span(text: String)` | `Span` (`start: Int`, `end: Int`, `where: start <= end`) | `{ start: text.length, end: 0, extra: "x" }` | `span(text: "abc") == Span(start: 0, end: 3)` (the actual side traps first) |
| `counts(words: List<String>)` | `Map<String, Int>` | a JS `Map` counting the words | `counts(words: ["b", "a", "b"]) == ["a": 1, "b": 2]` |
| `sorted(items: List<Int>)` | `List<Int>` | `items.sort((a, b) => a - b)`, in place | `sorted(items: [3, 1, 2]) == [1, 2, 3]`; and `fn b.both(items: List<Int>): List<Int>`, body `let s: List<Int> = sorted(items: items)`, then `return std.list.concat(left: items, right: s)`, example `both(items: [3, 1, 2]) == [3, 1, 2, 1, 2, 3]` (the copy keeps `items` unsorted) |
| `tree(depth: Int)` | `Tree` (variant `Leaf`, `Node: Branch`; record `Branch`: `left: Tree`, `right: Tree`) | a full tree of that depth | `tree(depth: 1) == Node(Branch(left: Leaf, right: Leaf))` |
| `later` | `Int` | `Promise.resolve(1)` (`async`) | `later() == 1` |
| `fails` | `Int` | `throw new TypeError("bad input")` | `fails() == 1` |
| `peek` | `String` | `Deno.readTextFileSync("/etc/hostname")` | `peek() == ""` |
| `leave` | `Int` | `Deno.exit(3)` (allowed without permissions: to verify) | `leave() == 1` |

  Also `fn b.zero_inverse(): Float`, with the body `return 1.0 / std.int.to_float(value: zero())` and the example `zero_inverse() == 1.0 / 0.0`.
- **`FILES`**, module `files`, with `files.ts`:
  - `extern fn files.touch(path: String): Result<Unit, String>`, `effects: fs.write`, `async`, which writes `""` with `Deno.writeTextFile` and has no `try`;
  - `fn files.main`, `effects: fs.write, console`, which touches `made.txt` and prints `made`.

**4.1 Commit 1**
1. **`syntax_test`:**
   - `TEXT`'s externs round-trip, and `printSignature(text.encode)` is its text without the `target:` line;
   - the 7.3 block prints byte for byte.
2. **`syntax_test`, errors:**
   - P1 `extern type m.T`, P3 `body:` in an extern, P4 `target:` in a `fn`, P5 `target: none`: each E0101 with its message;
   - P2 `extern fn m.f<T>`: E0101 with its message (after `generics`);
   - P6 `end fn m.f` after `extern fn m.f`: E0103 with its fix, and the fixed text parses;
   - P7 `import x`: E0006 with the new text.
3. **`syntax_test`:** `fn m.target` with the example `target(x: 1) == 1`, and a parameter named `target`, parse and check clean: `target` is not reserved (E4).
4. **`check_test`, E0260**, one case per row of 2.3:
   - `"npm:slugify#default"`, `"/abs/x.ts#f"`, `"../x.ts#f"`, `"./x.ts"` (`expected` `target: "./x.ts#<short name>"`), `"x.ts#f"` (fix `{ replace: "\"x.ts#f\"", with: "\"./x.ts#f\"" }`, and `applyFix` gives a clean program), `"./x.js#f"`, `"./x.ts#2f"`, `"./a b.ts#f"`;
   - each is one diagnostic in section `target`.
5. **`check_test`, E0261:** `in: by: (Int, Int) -> Order` is one E0261 at `by: (Int, Int) -> Order`. A record parameter whose type has a function field is one E0261.
6. **`check_test`:**
   - `out: (Int) -> Int` on an extern is E0237 (F4);
   - a pure extern without examples is E0401 (`accept_test`, codes only);
   - an effectful extern with an example is E0233;
   - a `fn` calling `files.touch` without `fs.write` is E0230 with its fix.
7. **`check_test`:** `clean(TEXT, {})` reports nothing; it stays out of `accepted` (see above), since commit 1's emitter refuses externs and the module is not there.
8. **`accept_test`:** accepting `TEXT` in commit 1 is E0303 "An `extern fn` cannot be built yet." (this test is removed in commit 3).

**4.2 Commit 2** (`isolate: true` on programs without externs)
1. **Same results.** The accept_test program behind `vals.ratio` and `vals.ports`, plus a map and a nested variant, failing on purpose, gives in isolation exactly the diagnostics it gives in-process:
   - `[1.0 / 0.0, -1.0 / 0.0]`;
   - `[Ok(net.port.Port(value: 80)), Err(net.port.OutOfRange(0)), Err(net.port.NotANumber)]`;
   - a map `["a": Some(-0.0)]` printed as such;
   - `-0.0` kept.
2. **Constants in isolation:** const's `BIG` gives `[E0404 big.n, E0402 big.f]` with const's messages, and `LOOP` exactly one E0404.
3. **E0407:** `fn slow.fib(n: Int): Int`, naive recursion, with the example `fib(n: 60) == 0`, which cannot end in time, and `limitMs: 3_000`, which covers a cold start (O6 was measured warm), is exactly one E0407. `definition` is `slow.fib`, `at` `fib(n: 60) == 0`, and the message reads "The example did not end within 3 seconds, so its process was stopped: foreign code that never returns, or a recursion too slow for an example."
4. **Clean up:** after each of 1–3, the out directory holds no `*.check.ts`.
5. **The channel:** a program whose example prints with `console.log` cannot exist in alang; instead, a unit test of `run_isolated` with a fake `$examples` entry that prints `noise` first still decodes the result.

**4.3 Commit 3**
1. **`emit_test`:** `TEXT`, built on its own with `text.ts` in `${OUT}text/` and `base` that directory:
   - `testExamples` reports 5 examples, all passing (2 for `decode`, 2 for `encode`, 1 for `pair`; `main` has none);
   - the generated module has exactly one `import * as $ext1 from "` line, ending in `/text.ts";`;
   - TypeScript-checked.
2. **`accept_test`, `B`:** accepted together, the program gives exactly these E0403 (the fixture defines its definitions in alphabetical order, which is the order below) and nothing else; `inf`, `zero`, `zero_inverse`, `nothing`, `counts`, `sorted`, `both` and `tree` pass:

| Definition | Kind | Message |
| --- | --- | --- |
| `b.fails` | `extern` | "The example ends in a trap (`extern`). `./b.ts#fails` threw TypeError: bad input." |
| `b.half` | `extern` | "The example ends in a trap (`extern`). `./b.ts#half` returned a value that does not fit `out: Int`: `result` is 1.5, where `Int` needs a safe integer." |
| `b.later` | `extern` | "The example ends in a trap (`extern`). `./b.ts#later` returned a Promise; an `extern fn` with `effects: none` returns its value at once." |
| `b.lone` | `extern` | "… `./b.ts#lone` returned a value that does not fit `out: String`: `result` is \"a\\ud800\", where `String` needs a string without lone surrogates." |
| `b.missing` | `extern` | "… `./b.ts#missing` returned a value that does not fit `out: Option<Int>`: `result` is null, where `Option<Int>` needs `{ tag: \"Some\", value }` or `{ tag: \"None\" }`." |
| `b.nan` | `extern` | "… `./b.ts#nan` returned a value that does not fit `out: Float`: `result` is NaN, where `Float` needs a number that is not NaN." |
| `b.peek` | `effect` | starts "The example ends in a trap (`effect`). `./b.ts#peek` was refused by the host: " and ends "An `extern fn` may do only what its `effects` declare, and a program only what `main` declares (2.5)." |
| `b.span` | `where` | "The example ends in a trap (`where`). Invariant of b.Span violated: start <= end." |

   `leave` is left out of this program; see 6.
3. **`accept_test`, the tree's path:** an extern `b.deep(): List<Tree>` returning `[{ tag: "Node", value: { left: { tag: "Leaf" }, right: { tag: "Lef" } } }]` traps with "`result[0].value.right` is an object with tag \"Lef\", where `b.Tree` needs `{ tag: \"Leaf\" }` or `{ tag: \"Node\", value }`."
4. **E0406:**
   - `TEXT` without `text.ts` is one E0406 at `text.decode` (first in definition order): "The module `./text.ts` of `text.decode` and `text.encode` does not exist: write it at `<dir>/text.ts`.";
   - with `export function encode(` misspelled `encodex(`, it is one E0406 at `text.encode`: "`./text.ts` exports no function `encode`; its functions are `decode`, `encodex`.";
   - with a syntax error at line 2, one E0406 at `text.decode` whose message starts "The module `./text.ts` of `text.decode` and `text.encode` cannot be loaded: SyntaxError";
   - `leave` alone: E0406 "The examples' process ended without a result (exit code 3): no output.", `definition` null.
5. **E0408:** `deno run --allow-read --allow-write src/cli.ts check text.alang` (no `--allow-run`) exits 1 with one E0408 on stderr, `at` `extern fn text.decode`.
6. **Run on Deno and Node.js** (`io_test`'s pattern):
   - `alang run text.alang -- "café au lait"` prints `q=caf%C3%A9%20au%20lait`, exit 0;
   - `node out/text.run.ts "café au lait"` prints the same.
7. **Effects at run time:**
   - `FILES` run with `alang run` prints `made`, and `made.txt` exists;
   - started with `RunOptions.effects: ["console"]` (the test hook), it exits 70 with stderr JSON `trap` `effect`, `definition` `files.touch`, `at` `./files.ts#touch`.
8. **`spec_test`:** the 7.3 blocks, with the `ts` block written as `text.ts` in a scratch directory, are accepted with `base` that directory; 4 examples run.

**4.4 Commit 4** (a fresh codebase in a scratch directory with `text.ts` and `TEXT`'s externs and `text.pair`; `invariants` after each step)
1. **`list("text")`:**
   - kinds `fn`, `fn`, `fn`;
   - the signatures `extern fn text.decode(text: String): Option<String>, effects: none`, `extern fn text.encode(text: String): String, effects: none` and `fn text.pair(key: String, value: String): String, effects: none`.
2. **`signature(text.encode)`** ends `end extern fn text.encode` and has no `target:` line; `definition` has `  target: "./text.ts#encode"`.
3. **`context(text.pair)`:** `uses` names `text.encode` first, and its `text` starts with `extern fn text.encode`.
4. **`search_type("String -> String")`** includes `text.encode`.
5. **fn to extern.** Add `fn m.double(n: Int): Int` (example `double(n: 2) == 4`, `return n * 2`) and `fn m.quad(n: Int): Int` (example `quad(n: 1) == 4`, `return double(n: double(n: n))`). Then:
   - `replace(m.double)` alone by `extern fn m.double` with the same sections and `target: "./m.ts#double"` (`m.ts` written) is written: no E0506, and `history(m.double)` has the operations `["add", "replace"]`;
   - replacing it again with `out: Float` alone is E0506, naming `m.quad`.
6. **Export:** `export/text.alang` holds the externs with their `target` lines, sorted by name; `importAll` into a fresh database gives the same hashes.
7. **A module edit is caught at the next acceptance.** Rewrite `text.ts`'s `encode` to `return text.toUpperCase();`. Then `add` an unrelated `fn other.one` (example `one() == 1`). It is rejected with E0402 on both `encode` examples, and on `text.pair`'s:
   - "The example does not hold: `encode(text: \"a b&c\")` is `\"A B&C\"`.";
   - "The example does not hold: `encode(text: \"é\")` is `\"É\"`.";
   - "The example does not hold: `pair(key: \"q\", value: \"café au lait\")` is `\"Q=CAFÉ AU LAIT\"`."

   Nothing is written.
8. **No leftovers:** after every submit, `out/` holds no `accept-*` file.
9. **MCP, E0408 and the instructions:**
   - a server process started with `--allow-read --allow-write` (`mcp_test.ts:381`'s pattern) answers `add` of `text.encode` with `ok: false` and one E0408;
   - started with `--allow-run` too, it is written;
   - the instructions contain "the TypeScript module an `extern fn` names is the one file you write", and the length test passes.

**4.5 Commit 5:** `card_test` passes: the program, codes, std names and tools as edited, at most 160, under 10,240 bytes. A new test: the card contains `target: "./text.ts#slugify"`, and `extern fn m.slugify` with `in: text: String`, `out: String`, `effects: none`, one example and that target checks clean (`checkProgram`, no acceptance).

## 5. Decisions

E continues the roadmap's E1 and E2 (`docs/plans/list-literals.md`, section 3). Both were re-examined against the code and the spec and kept:
- **E1** because the spec's Overview already names the form ("with `target` instead of `body`"), and the sections of a `fn` give an extern its contract and examples for free (5.1, 5.2).
  - The alternative, inline TypeScript, would put the code under the hash. But alang strings close on their line with four escapes (7.2), so any real function becomes one escaped line, and a module-level `import` is impossible.
  - The only change from the roadmap's wording is that `target` stays unreserved (E4), a concrete reason found in the code (O14).
- **E2** because a shallow or absent check contradicts the Overview's NaN rule and 3.9. It is extended by rebuilding results and copying arguments (O9), which the runtime forms (1.2) require.

| # | Recommendation | Reason by principle | Alternative |
| --- | --- | --- | --- |
| E1 [language] | `extern fn` with the sections of a `fn`, `target: "<module>#<export>"` in place of `body:`, `end extern fn <name>`; pure ones need examples | 1.1: one section order for every function; 5.1: examples test the assumption; the spec's own word | Inline TypeScript in a string (one escaped line, no imports) |
| E2 | Every result is checked deeply against `out` and rebuilt (records through their constructor); arguments are copied out | 5.3: a violation traps at its cause; 3.9 and 4.5: no NaN, no foreign mutation of alang values; 5.6: one diagnostic at the boundary instead of follow-ups | Trust the result; check shallowly |
| E3 [language] | A target is `./path.ts#name`: inside the project, relative to the codebase's directory (the file's for file commands), `.ts` only; no schemes (E0260, one fix: a missing `./`) | 2: the module travels with the export in Git; Toolchain: `.ts` runs on Deno and Node.js (O2, O9); 3: one spelling | Relative to `export/` (the session writes elsewhere than it targets); `npm:`/`jsr:` targets (Deno only, network at acceptance) |
| E4 [language] | `target` is a section word only in an `extern fn`, not reserved; one token of lookahead (`target :`) | 3.8 and 6: reserving it breaks `lines.alang` and `tickets.target` (O14); the reason for reserving section words (no `out: Unit` misread) does not arise after `examples` | Reserve `target`; the section `extern:` (no new word, departs from the spec) |
| E5 [language] | A pure extern is called synchronously and a `Promise` traps; an effectful one is awaited | Effects in TS (`decisions.md`): pure code stays synchronous, effectful code is async; 5.3 | Await every extern (makes pure callers async) |
| E6 [language] | No function value in an extern's `in` (E0261); `out` is F4's E0237 | 2.5: a callback is a second boundary whose arguments nothing checks, and foreign code could catch alang's traps (5.3); 3.8: loosening later breaks nothing | Wrap callbacks and check their arguments |
| E7 [language] | An extern is not generic (E0101) | E2 needs a concrete type to check; a type parameter is erased (G6); the precedent G11 | Check at each call site against `info.instances` |
| E8 [language] | The value forms of 2.4: `Unit` `null` (or `undefined` back), `Int` safe with `-0` → `0`, `Float` not NaN (infinities allowed, as the spec says, not "finite" as the brief says), `String` without lone surrogates, `Map` as a JS `Map`, tagged objects otherwise | Overview (types' meanings); S1; 3: one form per type, which a module builds without alang's runtime | `SortedMap` across (needs the runtime's path); reject `Map` at the boundary |
| E9 | An exception from foreign code traps `extern`; a permission refusal traps `effect`, as std's do | 2.3: expected errors are in the type, so a throw is a programming error; 5.3 | Let exceptions escape as JavaScript crashes (exit 1, a stack trace) |
| E10 | A program with an extern runs its constants and examples in a separate Deno process without any permission and without remote modules (`--no-remote`, `--cached-only`), 30 s limit, results over a tagged JSON channel; programs without externs keep the in-process path; never a fallback | 5, 6.3: acceptance must not hand foreign code the tool's read, write and run permissions (1.2); fresh code at every acceptance (O10); a stopped process for a loop | A `Worker` (needs `--unstable-worker-options`, O3); every program in a separate process (would break every MCP registration without `--allow-run`) |
| E11 | The MCP server is registered with `--allow-run`; without it, E0408 with the registration line | 5.5: the diagnostic carries the fix; no silent in-process fallback | Install-time check only |
| E12 [language] | Effects declared, not checked (2.5): callers by the checker, the run by `main`'s permissions, acceptance with none (catching pure externs that use file, network, environment or process APIs) | 2.5 as written; the Toolchain's runtime enforcement | Static analysis of TypeScript |
| E13 | An extern is a `FnDef` with `target`, stored as kind `fn`; hits and `signature` start with `extern fn`; `signature` leaves `target` out | 1.2, 6.1: one name, one function, whatever its code; 2.5: recognizable in every hit; no migration | A fourth kind `extern` (a second CHECK migration, every `fn` site doubled) |
| E14 | `target` is not interface; `replace` may switch `fn` ↔ `extern fn`, and callers follow while the other sections stay | 6: "if the signature is unchanged, all callers follow automatically" | Treat a kind switch as an interface change (as const's C7, where the call form changes; here it does not) |
| E15 | The hash covers the `target` text, not the module's code; every acceptance retests the code | 6.3: acceptance is the guard; the code is versioned by Git beside the export | Store the module's content hash in the database (Later) |
| E16 | Codes E0260, E0261, E0406–E0408 | 7.11 grouping by concern; E0405 is const's | — |
| E17 | Card: X1 and X2, paid by four cuts (`search_type` bullet, diagnostics bullet, type-argument bullet, operations bullet); −10 bytes, one line fewer (O11) | The card is the round's only teaching; each cut is said elsewhere (instructions, fixes, other bullets) | Leave out the value forms and let the traps teach them (one more submit per round) |
| E18 | Generated code imports the module by its relative `.ts` path; the module's portability is its author's (spec text) | Toolchain, runtime-neutral output: alang's code stays neutral (O9 on Node.js) | Forbid host APIs (cannot be checked) |
| E19 | `context` of an extern does not include the module's text | 6.5 holds through one file read; a query reading arbitrary files needs its own limits | Add the module text to `context` (Later) |
| E20 | The spec gets a new 7.12 rather than a section inserted before 7.8 | No section number moves (references in notes, decisions and plans) | Renumber 7.8 to 7.11 |

## 6. Risks

**Security of foreign code** (the roadmap's first risk):
- **Mostly closed for acceptance.** No program with an extern loads in the tool's process. The separate process:
  - has no permission (O2) and loads no remote module (O16);
  - cannot reach the MCP channel (piped);
  - is stopped after 30 s (O5);
  - cannot learn the marker.

  What remains is module loading, below.
- **Remaining at acceptance:**
  - **memory:** no cap; a later `--v8-flags=--max-old-space-size=…`;
  - **CPU:** for 30 s;
  - **module loading:** the permissions do not cover it. A module's static imports at fixed paths are read when it loads, a JSON file outside the project included (O15); a malicious module could report such a file's content back through a failing example's actual value. Remote imports are refused (`--no-remote`, O16); `--cached-only`'s effect on `npm:` and `jsr:` is to verify;
  - **Deno's permission model** itself is the trust boundary.
- **Remaining at run time.** Foreign code runs with all of `main`'s permissions, not only its own declared effects: Deno's permissions are per process. It can catch a refusal and carry on (O9), and change globals such as `Object.prototype`, which the runtime's `eq` and `show` rely on. This is 2.5's "unchecked assumption", stated in 7.12.
- **`--allow-run` for the MCP server.** The server may now start processes; only its own code does, and only `deno` without permissions. The CLI had it already.
- **The round's shell.** A session that may write files can still run arbitrary code through `alang db run`, whose program has `main`'s permissions. Acceptance itself no longer adds `--allow-run` or write access. The analysis checks it (7, check 6).

**The other risks:**
- **Code outside the hash** (E15). A module edit changes behavior without a database version, and is reported at the next acceptance of anything: the next unrelated submit fails with the extern's E0402 (test 4.4.7). The message names the extern; whether a model connects it to its file edit is check 3 of the round.
- **Nondeterminism.** A "pure" extern using `Math.random` or the clock makes examples flaky; nothing catches it.
- **Cost.** Every acceptance of a program with an extern spawns a process (about 35 ms, O6) and copies arguments and results (linear in their size, per call). An extern called per item of a large list with that list as an argument is quadratic.
- **The earlier phases are assumed as planned.** `containsFn`, `$constants`/`runConstants`/one load, G1's header and `info.shapes` substitution. Re-grep section 1.
- **`deno compile`.** A compiled `alang` would have no `deno` at `Deno.execPath()`, so this design would need another way to start the separate process; recorded for shipping.
- **Windows** paths and `SIGKILL` are not tested.
- **The card budget.** 404 bytes and 2 lines are left after this phase.

## 7. Playground round

**Run** after the phase is merged:

```
scripts/playground-round.sh 2026-11-DD-query <head of extern-fn> ~/coding_projects/alang-rounds/prompts/query.md opus
```

The script makes an empty playground, a worktree of the commit and an MCP config (now with `--allow-run`) under `~/coding_projects/alang-rounds/`. It runs headless, without the advisor, from an empty codebase, with the card and the std queries as the only teaching. The session can write files in its directory with the file tools. Its shell allows `alang ...`, `cat`, `ls`, `printf`, `echo`, `mkdir` and `cd`, joined with `;`, without redirections, and shows exit codes with `; echo $?`. No network beyond localhost is needed. To verify before the round: the allowlist `Bash(alang *)` passes single-quoted arguments that hold `&`, `(`, `)`, `!` and `%` (run one such `alang db run` by hand in a scratch playground). Check `instructions=sent` in `done.txt`. Afterwards: `git worktree remove --force ~/coding_projects/alang-rounds/2026-11-DD-query/wt`.

**Prompt** (save as `query.md`; it does not name `extern fn`):

> Build `query`, a tool for URL query strings, in alang with the alang MCP tools, in a module you name yourself. alang's standard library cannot percent-encode text, but JavaScript's `encodeURIComponent` and `decodeURIComponent` do exactly what is needed: let a small TypeScript module of yours do that part, and keep everything else in alang, in pure functions with examples. It is started as `alang db run <main> -- <command> ...`:
>
> - `encode <text>` prints the text percent-encoded as `encodeURIComponent` does it: ASCII letters, digits and `- _ . ! ~ * ' ( )` stay, and every other character becomes its UTF-8 bytes, each written `%XX` with capital hex digits.
> - `decode <text>` prints the text decoded.
> - `query <string>` reads a query string such as `a=1&b=x%20y`: it is split at `&`, empty parts are skipped, each part is split at its first `=` into a key and a value (a part without `=` is a key with the empty value), and key and value are decoded. It prints one line `<key>=<value>` per part, in order.
> - `build <base> <key=value>...` takes one or more pairs, splits each at its first `=`, encodes key and value, and prints `<base>?` followed by the pairs `<key>=<value>` joined with `&`.
>
> Errors go to stderr with exit code 1. A text that cannot be decoded (a `%` without two hex digits after it, or bytes that are not UTF-8) prints `not percent-encoded: <text>`, where `<text>` is the argument of `decode`, or the key or value of `query` as it was written. Anything else, a `build` pair without `=` or a `build` without pairs included, prints `usage: query encode <text> | decode <text> | query <string> | build <base> <key=value>...`.
>
> Then run: `encode 'a b&c=d/é'`, `encode 'Grüße, 100% (ok)!'`, `decode 'caf%C3%A9%20%E2%82%AC5'`, `decode '100%'`, `decode '%C3%28'`, `query 'q=caf%C3%A9&page=2&&empty=&flag'`, `query 'a=%ZZ'`, `build https://example.com/search 'q=café au lait' page=2`, `build https://example.com/search 'a&b=c=d'`, `build https://x.test novalue`, `build https://x.test` and `frobnicate`.
>
> Then change the encoding, in your TypeScript module, to RFC 3986: `!`, `'`, `(`, `)` and `*` are encoded too (`%21`, `%27`, `%28`, `%29`, `%2A`); decoding stays as it is. Run `encode 'Grüße, 100% (ok)!'`, `build https://example.com/search 'q=(x)*'` and `decode '%28ok%29%21'` again. Show me every output and exit code.

**Expected results** (by hand from the UTF-8 bytes `é` C3 A9, `ü` C3 BC, `ß` C3 9F, `€` E2 82 AC; confirmed by `round/reference.mjs`, O13; exit code 0 unless stated):
1. `a%20b%26c%3Dd%2F%C3%A9`
2. `Gr%C3%BC%C3%9Fe%2C%20100%25%20(ok)!`
3. `café €5`
4. stderr `not percent-encoded: 100%`, exit 1
5. stderr `not percent-encoded: %C3%28`, exit 1 (`28` is no continuation byte)
6. Four lines:
   ```
   q=café
   page=2
   empty=
   flag=
   ```
7. stderr `not percent-encoded: %ZZ`, exit 1
8. `https://example.com/search?q=caf%C3%A9%20au%20lait&page=2`
9. `https://example.com/search?a%26b=c%3Dd`
10. 11. 12. stderr `usage: query encode <text> | decode <text> | query <string> | build <base> <key=value>...`, exit 1 each

    After the change:
13. `Gr%C3%BC%C3%9Fe%2C%20100%25%20%28ok%29%21`
14. `https://example.com/search?q=%28x%29%2A`
15. `(ok)!`

**Where the language should show**:

| What | Expected form |
| --- | --- |
| The module | A `.ts` file in the session's directory (the codebase's), exporting two functions, written with the file tools |
| Encoding | `extern fn <m>.encode(text: String): String`, `effects: none`, examples, `target: "./<file>.ts#<export>"` |
| Decoding | An extern returning `Option<String>` or `Result<String, …>`, the TypeScript returning `{ tag: … }` objects and catching `URIError` |
| The rest | Splitting, cutting at `=`, joining, the usage and error texts: pure alang functions with examples, `main` thin |

**Checks for the analysis.** A fresh Opus agent, read-only, works like the earlier rounds' step 1. It lists every tool call, builds an independent reference (`round/reference.mjs` or Python's `urllib.parse.quote(s, safe="-_.!~*'()")` and `unquote` with `errors="strict"`), reruns only in a scratch copy, and ranks findings "fix now" or "later" with the files to touch.
1. **Teaching by the card:**
   - was `card` called first;
   - did the first extern have the right form (`target:` placement, `./` path, `#export`, `end extern fn`);
   - did the TypeScript return `Option` and `Result` as `{ tag … }` on the first try, or after which trap message;
   - where was the module written, and did the path in `target` match it.
2. **Diagnostics per submit**, with codes, and whether each fix or message led to the right form in one step: E0260 (and its `./` fix), E0261, E0237, E0101 P1–P5, E0103 P6, E0006 for `import`, E0401, E0233, E0403 with traps `extern`/`effect`, E0406 (a missing or misnamed export), E0407, E0408 (must not occur: the script grants `--allow-run`).
3. **The RFC change, the risk of E15:**
   - after editing the module, how did the change get tested: an `alang db run` refused by E0402 on the extern's old example, a submit, or nothing;
   - were the extern's examples adapted by `replace`;
   - did any unrelated submit fail on the stale example, and did the model connect the two;
   - count the submits it took.
4. **Correctness against the reference**, on Deno, in a scratch copy:
   - lowercase hex `decode '%e2%82%ac'` gives `€`;
   - `encode ''` prints an empty line;
   - `query 'a=1=2'` gives `a=1=2`, `query '=x'` gives `=x`, and `query ''` prints nothing, exit 0;
   - `decode '+'` gives `+`;
   - after the change, `encode "~*'"` gives `~%2A%27`;
   - nothing on stderr for a success, nothing on stdout for an error, and no trap (exit 70).
5. **Generated code and acceptance:**
   - `out/` holds `import * as $ext1 from "../<file>.ts"` and wrappers through `$rt.extern_call`;
   - no `accept-*` file is left;
   - `node out/<main>.run.ts encode 'a b'` gives the same output as Deno.
6. **Isolation, in a scratch copy only:**
   - add an example to the decoding extern whose TypeScript first calls `Deno.readTextFileSync("/etc/hostname")`; the submit is E0403 with trap `effect`;
   - a module that loops forever is E0407 after 30 s;
   - confirm in the transcript that the session never ran code outside `alang` beyond its program.
7. **Effort:** tool calls by kind, time, output tokens, file writes, and whether the first submit with an extern was accepted.

### Critical files for implementation
- `/home/josua/coding_projects/alang/src/toolchain.ts` (AcceptOptions, runIsolated, the entry, targetImport, the missing-module check)
- `/home/josua/coding_projects/alang/src/runtime.ts` (Shape, to_host, from_host, extern_call(_async), run_isolated, encode_value, decode_value, the before hooks)
- `/home/josua/coding_projects/alang/src/emit.ts` (imports, shapes, wrappers, `$externs`), `/home/josua/coding_projects/alang/src/examples.ts` (isolationDiagnostics)
- `/home/josua/coding_projects/alang/src/parser.ts`, `/home/josua/coding_projects/alang/src/ast.ts`, `/home/josua/coding_projects/alang/src/printer.ts`, `/home/josua/coding_projects/alang/src/check.ts` (E0260, E0261, no body), `/home/josua/coding_projects/alang/src/lexer.ts` (the `import` text)
- `/home/josua/coding_projects/alang/src/codebase.ts` (base, removeAcceptFile, storedHead, headerName, E0505), `/home/josua/coding_projects/alang/src/refs.ts`, `/home/josua/coding_projects/alang/src/mcp.ts`, `/home/josua/coding_projects/alang/src/cli.ts`
- `/home/josua/coding_projects/alang/src/card.ts`, `/home/josua/coding_projects/alang/alang-specs.md`, `/home/josua/coding_projects/alang/docs/decisions.md`, `/home/josua/coding_projects/alang/README.md`, `/home/josua/coding_projects/alang/scripts/playground-round.sh`
- Tests: `tests/syntax_test.ts`, `check_test.ts`, `accept_test.ts`, `emit_test.ts`, `io_test.ts` (Deno and Node.js runs), `codebase_test.ts`, `mcp_test.ts`, `spec_test.ts`, `card_test.ts`
- Probes and measurements: `/home/josua/.claude/jobs/7e0015cb/tmp/extern-fn-probes/` (`p9/extern_rt.ts` is the boundary prototype; `card/stages.ts` the card edits)
