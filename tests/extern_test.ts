// `extern fn` (phase `extern-fn`, E1 to E12): the form, checking, acceptance
// in a separate process, the boundary and running, on the fixtures of
// docs/plans/extern-fn.md (section 4).

import { assertEquals, assertThrows } from "./assert.ts";
import { checkProgram } from "../src/check.ts";
import { AlangError, type Diagnostic } from "../src/diagnostic.ts";
import { parseProgram } from "../src/parser.ts";
import { printProgram, printSignature } from "../src/printer.ts";
import { accept, type AcceptOptions, readReport } from "../src/toolchain.ts";
import * as rt from "../src/runtime.ts";
import { TEXT } from "./extern_fixtures.ts";

const OUT = new URL("../out/test/extern/", import.meta.url).pathname;

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

Deno.test("extern: an extern cannot be built yet (E0303, until the boundary exists)", async () => {
  const ds = await acceptance(TEXT);
  assertEquals(ds.map((d) => [d.code, d.at, d.message]), [
    ["E0303", "extern fn text.decode", "An `extern fn` cannot be built yet."],
  ]);
});
