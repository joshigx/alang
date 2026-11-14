// `extern fn` (phase `extern-fn`, E1 to E12): the form, checking, acceptance
// in a separate process, the boundary and running, on the fixtures of
// docs/plans/extern-fn.md (section 4).

import { assertEquals, assertThrows } from "./assert.ts";
import { checkProgram } from "../src/check.ts";
import { AlangError, type Diagnostic } from "../src/diagnostic.ts";
import { parseProgram } from "../src/parser.ts";
import { printProgram, printSignature } from "../src/printer.ts";
import { accept, type AcceptOptions, build, readReport, run, testExamples, writeEntry } from "../src/toolchain.ts";
import * as rt from "../src/runtime.ts";
import { B, B_TS, DEEP, FILES, FILES_TS, G, G_DEEP, G_TS, LEAVE, TEXT, TEXT_TS } from "./extern_fixtures.ts";

const OUT = new URL("../out/test/extern/", import.meta.url).pathname;
const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

async function hasNode(): Promise<boolean> {
  const node = await new Deno.Command("node", { args: ["--version"], stdout: "null", stderr: "null" }).output()
    .catch(() => null);
  return node?.success ?? false;
}

function check(source: string): Diagnostic[] {
  return checkProgram(parseProgram(source)).diagnostics;
}

function clean(source: string): void {
  const ds = check(source);
  assertEquals(ds, [], JSON.stringify(ds, null, 2));
}

// Exactly one diagnostic, with the given code; returns it.
function one(source: string, code: string): Diagnostic {
  const ds = check(source);
  assertEquals(ds.map((d) => d.code), [code], JSON.stringify(ds, null, 2));
  return ds[0];
}

function parseError(source: string): Diagnostic {
  return assertThrows(() => parseProgram(source), AlangError).diagnostic;
}

let counter = 0;
async function acceptance(source: string, options: AcceptOptions = {}): Promise<Diagnostic[]> {
  try {
    await accept(source, `${OUT}accept_${counter++}.ts`, options);
    return [];
  } catch (e) {
    if (e instanceof AlangError) return [...e.diagnostics];
    throw e;
  }
}

// An extern `m.f` with the given lines in place of its `in`, `out`,
// `effects`, `examples` and `target` sections.
function extern(
  {
    params = "  in:\n    text: String",
    out = "String",
    effects = "none",
    examples = '    f(text: "a") == "a"',
    target,
  }: {
    params?: string;
    out?: string;
    effects?: string;
    examples?: string;
    target?: string;
  } = {},
): string {
  return `extern fn m.f
  doc: "F."
${params}
  out: ${out}
  effects: ${effects}
  requires: none
  ensures: none
  examples:${examples === "none" ? " none" : `\n${examples}`}
  target: ${JSON.stringify(target ?? "./m.ts#f")}
end extern fn m.f
`;
}

const ENCODE = TEXT.slice(TEXT.indexOf("extern fn text.encode"), TEXT.indexOf("fn text.pair"));

// ---- the form (4.1.1 to 4.1.3) ----

Deno.test("extern: TEXT round-trips; the signature leaves `target` out (E1, E13)", () => {
  const tree = parseProgram(TEXT);
  assertEquals(printProgram(tree), TEXT);
  assertEquals(parseProgram(printProgram(tree)), tree);
  const encode = tree.find((d) => d.path.join(".") === "text.encode")!;
  assertEquals(printSignature(encode), ENCODE.trimEnd().replace('  target: "./text.ts#encode"\n', ""));
  assertEquals(encode.kind === "fn" && encode.target, "./text.ts#encode");
  assertEquals(encode.kind === "fn" && encode.body, []);
});

Deno.test("extern: the parser's messages for the forms of other kinds (P1 to P7)", () => {
  const p1 = parseError('extern type m.T\n  doc: "T."\n');
  assertEquals([p1.code, p1.message], ["E0101", "Only a function is written in TypeScript: `extern fn module.name`."]);
  assertEquals(parseError("extern const m.c\n").message, p1.message);
  const p2 = parseError(extern().replace("extern fn m.f\n", "extern fn m.f<T>\n"));
  assertEquals([p2.code, p2.message], [
    "E0101",
    "An `extern fn` takes no type parameters: its result is checked against one concrete type where it returns (2.5). Write one extern per type, or keep the generic part in alang.",
  ]);
  const p3 = parseError(extern().replace('  target: "./m.ts#f"', "  body:\n    return text"));
  assertEquals([p3.code, p3.section, p3.message], [
    "E0101",
    "body",
    'An `extern fn` has `target: "./module.ts#name"` in place of `body:`; its code is TypeScript in that module.',
  ]);
  const p4 = parseError(
    'fn m.f\n  doc: "F."\n  in: none\n  out: Int\n  effects: none\n  requires: none\n  ensures: none\n' +
      '  examples: none\n  target: "./m.ts#f"\nend fn m.f\n',
  );
  assertEquals([p4.code, p4.section, p4.message], [
    "E0101",
    "target",
    "A `fn` has `body:`. A function whose code is TypeScript is an `extern fn`, with `target:` in place of `body:`.",
  ]);
  const p5 = parseError(extern().replace('target: "./m.ts#f"', "target: none"));
  assertEquals([p5.code, p5.section, p5.message], [
    "E0101",
    "target",
    '`target` holds one string: `"./module.ts#name"`.',
  ]);
  const p6 = parseError(extern().replace("end extern fn m.f", "end fn m.f"));
  assertEquals([p6.code, p6.message, p6.expected, p6.fix], [
    "E0103",
    "The block end names `fn m.f`, but the definition is `extern fn m.f`.",
    "end extern fn m.f",
    { replace: "end fn m.f", with: "end extern fn m.f" },
  ]);
  const fixed = extern().replace("end extern fn m.f", "end fn m.f").replace(p6.fix!.replace, p6.fix!.with);
  assertEquals(parseProgram(fixed).length, 1);
  const reverse = parseError(
    'fn m.g\n  doc: "G."\n  in: none\n  out: Int\n  effects: none\n  requires: none\n  ensures: none\n' +
      "  examples:\n    g() == 1\n  body:\n    return 1\nend extern fn m.g\n",
  );
  assertEquals([reverse.code, reverse.fix], ["E0103", { replace: "end extern fn m.g", with: "end fn m.g" }]);
  const p7 = parseError('import { slugify } from "./text.ts"\n');
  assertEquals([p7.code, p7.message], [
    "E0006",
    'There are no imports; write names from other modules fully qualified. Code from a TypeScript module is called through an `extern fn` with `target: "./module.ts#name"`.',
  ]);
  assertEquals(
    parseError("let x: Int = 1\n").message,
    "Expected a definition (`fn`, `type`, `const` or `extern fn`), found `let`.",
  );
});

Deno.test("extern: `target` is no reserved word (E4)", () => {
  clean(
    'fn m.target\n  doc: "Its argument."\n  in:\n    x: Int\n  out: Int\n  effects: none\n  requires: none\n' +
      "  ensures: none\n  examples:\n    target(x: 1) == 1\n  body:\n    return x\nend fn m.target\n\n" +
      'fn m.aim\n  doc: "Its argument."\n  in:\n    target: Int\n  out: Int\n  effects: none\n  requires: none\n' +
      "  ensures: none\n  examples:\n    aim(target: 1) == 1\n  body:\n    let x: Int = target\n" +
      "    return x\nend fn m.aim\n",
  );
});

// ---- checking (4.1.4 to 4.1.7) ----

Deno.test("extern: a target that is not `./path.ts#name` is E0260, one rule each (E3)", () => {
  const cases: [string, string, string | null, { replace: string; with: string } | null][] = [
    [
      "npm:slugify#default",
      'A target names a TypeScript module of this project, such as `"./text.ts#slugify"`; a package or a `node:` module is imported inside that module.',
      null,
      null,
    ],
    [
      "/abs/x.ts#f",
      "A target stays inside the project: its path starts with `./`, from the codebase's directory (for a file command, the file's), and has no `..`.",
      null,
      null,
    ],
    [
      "../x.ts#f",
      "A target stays inside the project: its path starts with `./`, from the codebase's directory (for a file command, the file's), and has no `..`.",
      null,
      null,
    ],
    [
      "./x.ts",
      'A target ends with `#` and the name its module exports: `"./text.ts#slugify"`.',
      'target: "./x.ts#f"',
      null,
    ],
    [
      "x.ts#f",
      "A target's path starts with `./`, as a relative import does.",
      null,
      { replace: '"x.ts#f"', with: '"./x.ts#f"' },
    ],
    [
      "./x.js#f",
      'A target names a `.ts` module, which Deno and Node.js both load: `"./text.ts#slugify"`.',
      null,
      null,
    ],
    [
      "./x.ts#2f",
      "After `#` comes the name the module exports, a JavaScript identifier such as `slugify`.",
      null,
      null,
    ],
    [
      "./a b.ts#f",
      'A target\'s path is made of letters, digits, `_`, `-` and `.`, with `/` between directories: `"./lib/text.ts#slugify"`.',
      null,
      null,
    ],
  ];
  for (const [target, message, expected, fix] of cases) {
    const source = extern({ target });
    const d = one(source, "E0260");
    assertEquals([d.section, d.at, d.message, d.expected, d.fix], [
      "target",
      `target: ${JSON.stringify(target)}`,
      message,
      expected,
      fix,
    ]);
    if (fix) {
      const fixed = source.replace(d.at, d.at.replace(fix.replace, fix.with));
      clean(fixed);
    }
  }
  clean(extern({ target: "./lib/text-1.v2.ts#$slug_ify" }));
});

Deno.test("extern: no function value in `in` (E0261), none in `out` (E0237)", () => {
  const by = one(
    extern({
      params: "  in:\n    items: List<Int>\n    by: (Int, Int) -> Order",
      out: "List<Int>",
      examples: "    f(items: [1], by: std.int.compare) == [1]",
    }),
    "E0261",
  );
  assertEquals([by.section, by.at, by.message], [
    "in",
    "by: (Int, Int) -> Order",
    "`by: (Int, Int) -> Order` holds a function value, and an `extern fn` takes none: its TypeScript would call alang code with values nothing checks, and could catch its traps (2.5). Pass data, and keep the function in alang.",
  ]);
  const holder = 'type m.Holder\n  doc: "H."\n  record:\n    run: (Int) -> Int\n  where: none\nend type m.Holder\n';
  const field = one(
    extern({
      params: "  in:\n    h: Holder",
      out: "Int",
      examples: "    f(h: Holder(run: fn(x: Int): Int => x)) == 1",
    }) +
      "\n" + holder,
    "E0261",
  );
  assertEquals(field.at, "h: Holder");
  const out = one(extern({ out: "(Int) -> Int", examples: "none", effects: "console" }), "E0237");
  assertEquals(out.section, "out");
});

Deno.test("extern: examples, effects and callers are those of a `fn`", async () => {
  // A pure extern without examples is E0401, in the example form: an extern
  // has no body to move into a constant (E1).
  const missing = await acceptance(extern({ params: "  in: none", out: "Int", examples: "none" }));
  assertEquals(missing.map((d) => [d.code, d.expected]), [["E0401", "f() == Int"]]);
  assertEquals(one(extern({ effects: "fs.read" }), "E0233").section, "examples");
  const caller = 'fn m.g\n  doc: "G."\n  in: none\n  out: Result<Unit, String>\n  effects: console\n' +
    '  requires: none\n  ensures: none\n  examples: none\n  body:\n    touch(path: "x") else return Err(error)\n' +
    "    return Ok(Unit)\nend fn m.g\n";
  const touch = extern({
    params: "  in:\n    path: String",
    out: "Result<Unit, String>",
    effects: "fs.write",
    examples: "none",
  }).replaceAll("m.f", "m.touch").replace('"./m.ts#f"', '"./m.ts#touch"');
  const e0230 = one(touch + "\n" + caller, "E0230");
  assertEquals(e0230.fix, { replace: "effects: console", with: "effects: fs.write, console" });
});

Deno.test("extern: TEXT checks clean", () => {
  clean(TEXT);
});

// ---- the separate process (4.2) ----

const FIB = `fn slow.fib
  doc: "The nth Fibonacci number, the slow way."
  in:
    n: Int
  out: Int
  effects: none
  requires: none
  ensures: none
  examples:
    fib(n: 60) == 0
  body:
    if n < 2 then
      return n
    end if
    return fib(n: n - 1) + fib(n: n - 2)
end fn slow.fib
`;

const checkFiles = () => [...Deno.readDirSync(OUT)].filter((e) => e.name.endsWith(".check.ts")).map((e) => e.name);

Deno.test("extern: a separate process is stopped at its time limit (E0407)", async () => {
  // 3 s covers a cold start (O6 was measured warm).
  const ds = await acceptance(FIB, { isolate: true, limitMs: 3_000 });
  assertEquals(ds.map((d) => [d.code, d.definition, d.section, d.at, d.message]), [[
    "E0407",
    "slow.fib",
    "examples",
    "fib(n: 60) == 0",
    "The example did not end within 3 seconds, so its process was stopped: foreign code that never returns, or a recursion too slow for an example.",
  ]]);
  const constant = FIB +
    '\nconst slow.big\n  doc: "Big."\n  out: Int\n  body:\n    return fib(n: 60)\nend const slow.big\n';
  const slow = await acceptance(constant.replace("fib(n: 60) == 0", "fib(n: 2) == 1"), {
    isolate: true,
    limitMs: 3_000,
  });
  assertEquals(slow.map((d) => [d.code, d.definition, d.section, d.at, d.message]), [[
    "E0407",
    "slow.big",
    "body",
    "const slow.big",
    "Evaluating the constant did not end within 3 seconds, so its process was stopped.",
  ]]);
  assertEquals(checkFiles(), []);
});

Deno.test("extern: values cross the report as tagged JSON (O7)", () => {
  const map = rt.map_literal<string, unknown>([["b", -0], ["a", rt.Some(Infinity)]], "test");
  const value = [-0, Infinity, -Infinity, 1.5, 'q"é😀', null, map, { tag: "Node", value: { left: rt.None } }];
  const copy = rt.decode_value(JSON.parse(JSON.stringify(rt.encode_value(value)))) as unknown[];
  assertEquals(rt.eq(copy, value), true);
  assertEquals(Object.is(copy[0], -0), true);
  assertEquals(Object.is(rt.map_entries(copy[6] as rt.SortedMap<string, unknown>)[1][1], -0), true);
  assertEquals(rt.encode_value(undefined), null);
});

Deno.test("extern: the report is found by its marker, whatever else is printed (E10)", async () => {
  // An entry like the toolchain's, whose example prints first: a line, then
  // text without a line break.
  const entry = `${OUT}noise.check.ts`;
  await Deno.mkdir(OUT, { recursive: true });
  await Deno.writeTextFile(
    entry,
    `import { run_isolated } from "../../../src/runtime.ts";\n` +
      `const example = { definition: "m.f", text: "f() == 1", expected: () => 1, actual: () => {\n` +
      `  console.log("noise");\n  Deno.stdout.writeSync(new TextEncoder().encode("partial"));\n  return 1;\n} };\n` +
      `run_isolated([], [], [example], "MARK");\n`,
  );
  try {
    const out = await new Deno.Command(Deno.execPath(), { args: ["run", "--no-config", "--quiet", entry] }).output();
    const report = readReport(new TextDecoder().decode(out.stdout), "MARK");
    assertEquals(report.last, { kind: "example", index: 0 });
    assertEquals(JSON.parse(report.done!).examples.map((e: { passed: boolean }) => e.passed), [true]);
  } finally {
    await Deno.remove(entry);
  }
});

// ---- the boundary and running (4.3) ----

// A scratch directory holding the given modules; the targets are relative
// to it.
async function project(name: string, modules: Record<string, string>): Promise<string> {
  const dir = `${OUT}${name}/`;
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  await Deno.mkdir(dir, { recursive: true });
  for (const [file, text] of Object.entries(modules)) await Deno.writeTextFile(dir + file, text);
  return dir;
}

async function acceptIn(dir: string, source: string, options: AcceptOptions = {}): Promise<Diagnostic[]> {
  return await acceptance(source, { ...options, base: dir });
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

// Every program built here with its modules is also checked by TypeScript.
const builtFiles: string[] = [];

Deno.test("extern: TEXT runs its examples through text.ts; one import per module (E2, E3)", async () => {
  const dir = await project("text", { "text.ts": TEXT_TS });
  const built = await build(TEXT, `${dir}out/text.ts`, { base: dir });
  const results = await testExamples(built);
  assertEquals(results.map((r) => [r.definition, r.passed]), [
    ["text.decode", true],
    ["text.decode", true],
    ["text.encode", true],
    ["text.encode", true],
    ["text.pair", true],
  ]);
  const imports = (await Deno.readTextFile(built.outPath)).split("\n").filter((l) => l.startsWith("import * as $ext"));
  assertEquals(imports, ['import * as $ext1 from "../text.ts";']);
  assertEquals(checkFiles(), []);
  builtFiles.push(built.outPath);
});

Deno.test("extern: every value that does not fit traps at the call, naming its place (E2, E5, E8, E9)", async () => {
  const dir = await project("b", { "b.ts": B_TS });
  const ds = await acceptIn(dir, B);
  const extern = (
    name: string,
    message: string,
  ) => ["E0403", `b.${name}`, `The example ends in a trap (\`extern\`). ${message}`];
  assertEquals(ds.filter((d) => d.definition !== "b.peek").map((d) => [d.code, d.definition, d.message]), [
    extern("fails", "`./b.ts#fails` threw TypeError: bad input."),
    extern(
      "half",
      "`./b.ts#half` returned a value that does not fit `out: Int`: `result` is 1.5, where `Int` needs a safe integer.",
    ),
    extern(
      "later",
      "`./b.ts#later` returned a Promise; an `extern fn` with `effects: none` returns its value at once.",
    ),
    extern(
      "lone",
      '`./b.ts#lone` returned a value that does not fit `out: String`: `result` is "a\\ud800", where `String` needs a string without lone surrogates.',
    ),
    extern(
      "missing",
      '`./b.ts#missing` returned a value that does not fit `out: Option<Int>`: `result` is null, where `Option<Int>` needs `{ tag: "Some", value }` or `{ tag: "None" }`.',
    ),
    extern(
      "nan",
      "`./b.ts#nan` returned a value that does not fit `out: Float`: `result` is NaN, where `Float` needs a number that is not NaN.",
    ),
    ["E0403", "b.span", "The example ends in a trap (`where`). Invariant of b.Span violated: start <= stop."],
  ]);
  // Without permissions, a pure extern that reads a file is refused (E12).
  const peek = ds.find((d) => d.definition === "b.peek")!;
  assertEquals(
    peek.message.startsWith("The example ends in a trap (`effect`). `./b.ts#peek` was refused by the host: "),
    true,
    peek.message,
  );
  assertEquals(
    peek.message.endsWith(
      "An `extern fn` may do only what its `effects` declare, and a program only what `main` declares (2.5).",
    ),
    true,
  );
  assertEquals(ds.length, 8);
  const built = await build(B, `${dir}out/b.ts`, { base: dir });
  builtFiles.push(built.outPath);
});

Deno.test("extern: the place of a misfit deep in a value; generic and std records rebuilt", async () => {
  const dir = await project("deep", { "b.ts": B_TS, "g.ts": G_TS });
  const ds = await acceptIn(dir, DEEP);
  assertEquals(ds.map((d) => d.message), [
    'The example ends in a trap (`extern`). `./b.ts#deep` returned a value that does not fit `out: List<b.Tree>`: `result[0].value.right` is an object with tag "Lef", where `b.Tree` needs `{ tag: "Leaf" }` or `{ tag: "Node", value }`.',
  ]);
  // A generic type that grows (`Nest<List<T>>` inside `Nest<T>`) is unfolded
  // as deep as the value goes; a record comes back with its name (R7) and
  // without extra properties; arguments are copies.
  assertEquals(await acceptIn(dir, G), []);
  const built = await build(G, `${dir}out/g.ts`, { base: dir });
  builtFiles.push(built.outPath);
  const nest = await acceptIn(dir, G_DEEP);
  assertEquals(nest.map((d) => d.message), [
    'The example ends in a trap (`extern`). `./g.ts#bad_nest` returned a value that does not fit `out: g.Nest<Int>`: `result.inner.value.item[1]` is "x", where `Int` needs a safe integer.',
  ]);
});

Deno.test("extern: a module that is missing, misnamed or broken is E0406", async () => {
  const none = await project("text_missing", {});
  const missing = await acceptIn(none, TEXT);
  assertEquals(missing.map((d) => [d.code, d.definition, d.section, d.at, d.message]), [[
    "E0406",
    "text.decode",
    "target",
    'target: "./text.ts#decode"',
    `The module \`./text.ts\` of \`text.decode\` and \`text.encode\` does not exist: write it at \`${none}text.ts\`.`,
  ]]);
  const misnamed = await project("text_misnamed", {
    "text.ts": TEXT_TS.replace("function encode(", "function encodex("),
  });
  const exported = await acceptIn(misnamed, TEXT);
  assertEquals(exported.map((d) => [d.code, d.definition, d.message]), [[
    "E0406",
    "text.encode",
    "`./text.ts` exports no function `encode`; its functions are `decode`, `encodex`.",
  ]]);
  const broken = await project("text_broken", {
    "text.ts": TEXT_TS.replace("  return encodeURIComponent(text);", "  return (;"),
  });
  const loads = await acceptIn(broken, TEXT);
  assertEquals(loads.map((d) => [d.code, d.definition]), [["E0406", "text.decode"]]);
  assertEquals(
    loads[0].message.startsWith(
      "The module `./text.ts` of `text.decode` and `text.encode` cannot be loaded: SyntaxError",
    ),
    true,
    loads[0].message,
  );
  assertEquals(loads[0].message.includes("(at `./text.ts:2:"), true, loads[0].message);
  const leave = await project("leave", { "b.ts": B_TS });
  const ended = await acceptIn(leave, LEAVE);
  assertEquals(ended.map((d) => [d.code, d.definition, d.at, d.message]), [[
    "E0406",
    null,
    "<program>",
    "The examples' process ended without a result (exit code 3): no output.",
  ]]);
  assertEquals(checkFiles(), []);
});

Deno.test("extern: a module that never finishes loading is stopped (E0407); its output is ignored", async () => {
  const hang = await project("hang", { "text.ts": "while (true) {}\n" + TEXT_TS });
  const ds = await acceptIn(hang, TEXT, { limitMs: 3_000 });
  assertEquals(ds.map((d) => [d.code, d.definition, d.at, d.message]), [[
    "E0407",
    null,
    "<program>",
    "Loading the program's modules did not end within 3 seconds.",
  ]]);
  const noisy = await project("noisy", {
    "text.ts": 'console.log("noise");\nDeno.stdout.writeSync(new TextEncoder().encode("partial"));\n' +
      TEXT_TS.replace(
        "  return encodeURIComponent(text);",
        '  console.log("more");\n  return encodeURIComponent(text);',
      ),
  });
  assertEquals(await acceptIn(noisy, TEXT), []);
});

Deno.test("extern: a tool without --allow-run refuses the program, never runs it itself (E0408)", async () => {
  const dir = await project("no_run", { "text.ts": TEXT_TS, "text.alang": TEXT });
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", "--allow-write", CLI, "check", `${dir}text.alang`],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(out.code, 1);
  const ds = JSON.parse(decode(out.stderr)) as Diagnostic[];
  assertEquals(ds.map((d) => [d.code, d.definition, d.at]), [["E0408", "text.decode", "extern fn text.decode"]]);
});

for (const host of ["deno", "node"] as const) {
  Deno.test(`extern: a program with an extern runs alike on every host (${host})`, async () => {
    if (host === "node" && !(await hasNode())) return;
    const dir = await project(`run_${host}`, { "text.ts": TEXT_TS, "text.alang": TEXT });
    const out = host === "deno"
      ? await new Deno.Command(Deno.execPath(), {
        args: ["run", "--allow-read", "--allow-write", "--allow-run", CLI, "run", "text.alang", "--", "café au lait"],
        cwd: dir,
        stdout: "piped",
        stderr: "piped",
      }).output()
      : await (async () => {
        const built = (await accept(TEXT, `${dir}out/text.ts`, { base: dir })).built;
        return await new Deno.Command("node", {
          args: [await writeEntry(built), "café au lait"],
          cwd: dir,
          stdout: "piped",
          stderr: "piped",
        }).output();
      })();
    assertEquals([out.code, decode(out.stdout), decode(out.stderr)], [0, "q=caf%C3%A9%20au%20lait\n", ""]);
  });
}

Deno.test("extern: an extern with effects is awaited, and has the permissions of main (E12)", async () => {
  const dir = await project("files", { "files.ts": FILES_TS });
  const built = (await accept(FILES, `${dir}out/files.ts`, { base: dir })).built;
  builtFiles.push(built.outPath);
  const made = await run(built, { stdio: "piped", cwd: dir });
  assertEquals([made.code, decode(made.stdout)], [0, "made\n"]);
  assertEquals((await Deno.stat(`${dir}made.txt`)).isFile, true);
  await Deno.remove(`${dir}made.txt`);
  const refused = await run(built, { stdio: "piped", cwd: dir, effects: ["console"] });
  assertEquals(refused.code, 70);
  const trap = JSON.parse(decode(refused.stderr));
  assertEquals([trap.trap, trap.definition, trap.at], ["effect", "files.touch", "./files.ts#touch"]);
});

Deno.test("extern: every program built here with its modules is accepted by TypeScript too", async () => {
  assertEquals(builtFiles.length >= 4, true, String(builtFiles.length));
  const result = await new Deno.Command(Deno.execPath(), { args: ["check", ...builtFiles], stderr: "piped" }).output();
  assertEquals(result.success, true, decode(result.stderr));
});
