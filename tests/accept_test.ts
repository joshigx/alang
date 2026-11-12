// Acceptance (6.3) and mandatory examples (5.1): a pure function without an
// example is rejected, and so is a definition whose example fails or traps.
// A failing example reports the actual value as alang text; substituting it
// for the expected value must give an accepted program.

import { assert_, assertEquals } from "./assert.ts";
import { AlangError, type Diagnostic } from "../src/diagnostic.ts";
import { showValue } from "../src/examples.ts";
import { accept, build, testExamples } from "../src/toolchain.ts";
import { con, FLOAT, INT, list, option, ORDER, STRING, UNIT } from "../src/types.ts";

const OUT = new URL("../out/test/accept/", import.meta.url).pathname;
const spec = await Deno.readTextFile(new URL("../alang-specs.md", import.meta.url));
const specBlock = (firstLine: string): string => {
  const m = [...spec.matchAll(/^```\n([\s\S]*?)^```$/gm)].find((m) => m[1].startsWith(firstLine + "\n"));
  if (!m) throw new Error(`spec block not found: ${firstLine}`);
  return m[1];
};

let counter = 0;
const outPath = () => `${OUT}program_${counter++}.ts`;

async function diagnostics(source: string): Promise<Diagnostic[]> {
  try {
    await accept(source, outPath());
    return [];
  } catch (e) {
    if (e instanceof AlangError) return [...e.diagnostics];
    throw e;
  }
}

async function accepted(source: string): Promise<void> {
  const ds = await diagnostics(source);
  assertEquals(ds, [], JSON.stringify(ds, null, 2));
}

// A function `<module>.<name>` with the given sections.
function fn(
  name: string,
  o: { params?: string[]; out: string; effects?: string; requires?: string; examples?: string[]; body: string },
): string {
  const short = name.slice(name.lastIndexOf(".") + 1);
  return [
    `fn ${name}`,
    `  doc: "${short}."`,
    o.params ? ["  in:", ...o.params.map((p) => `    ${p}`)].join("\n") : "  in: none",
    `  out: ${o.out}`,
    `  effects: ${o.effects ?? "none"}`,
    `  requires: ${o.requires ?? "none"}`,
    "  ensures: none",
    o.examples ? ["  examples:", ...o.examples.map((e) => `    ${e}`)].join("\n") : "  examples: none",
    "  body:",
    ...o.body.split("\n").map((l) => `    ${l}`),
    `end fn ${name}`,
  ].join("\n");
}

const PORT = specBlock("type net.port.Port");
const LOAD_PORT = specBlock("fn config.load_port") + `

type config.LoadError
  doc: "Why the configuration could not be loaded."
  variant:
    FileUnreadable: std.fs.ReadError
    InvalidPort: net.port.ParseError
  where: none
end type config.LoadError

${PORT}`;

// ---- the spec ----

Deno.test("accept: the spec programs are accepted end to end", async () => {
  await accepted(specBlock("fn hello.main"));
  await accepted(PORT);
  await accepted(specBlock("fn math.clamp"));
  // Functions with effects need no example; config.load_port has fs.read.
  await accepted(LOAD_PORT);
});

// ---- presence (5.1) ----

Deno.test("accept: a pure function without examples is rejected (5.1)", async () => {
  const source = fn("m.twice", { params: ["n: Int"], out: "Int", body: "return n * 2" });
  assertEquals(await diagnostics(source), [{
    code: "E0401",
    definition: "m.twice",
    section: "examples",
    at: "examples: none",
    message: "`twice` has `effects: none` and needs at least one example (5.1): a call and the value it returns, " +
      "in the form shown under `expected`.",
    expected: "twice(n: Int) == Int",
    fix: null,
  }]);
  await accepted(source.replace("examples: none", "examples:\n    twice(n: 2) == 4"));
  // The quoted location is the examples line itself.
  assert_(source.includes("  examples: none\n"));
});

Deno.test("accept: missing examples come in the same round as type errors", async () => {
  const source = [
    fn("m.a", { out: "Int", examples: ["a() == 1"], body: 'return "one"' }),
    fn("m.b", { out: "Int", body: "return 2" }),
    fn("m.c", { out: "Int", examples: ["c() == 3"], body: "return cc" }),
  ].join("\n\n");
  const ds = await diagnostics(source);
  // Grouped by definition, in the order of the program.
  assertEquals(ds.map((d) => [d.definition, d.code]), [["m.a", "E0204"], ["m.b", "E0401"], ["m.c", "E0203"]]);
});

// ---- failing examples ----

Deno.test("accept: a failing example is rejected and reports the actual value", async () => {
  const source = PORT.replace('parse(text: "0") == Err(OutOfRange(0))', 'parse(text: "0") == Err(NotANumber)');
  assertEquals(await diagnostics(source), [{
    code: "E0402",
    definition: "net.port.parse",
    section: "examples",
    at: 'parse(text: "0") == Err(NotANumber)',
    message: 'The example does not hold: `parse(text: "0")` is `Err(OutOfRange(0))`.',
    expected: null,
    // No fix: the body may be what is wrong, not the example.
    fix: null,
  }]);
});

Deno.test("accept: an example that traps is rejected with the trap", async () => {
  const clamp = specBlock("fn math.clamp");
  const requires = await diagnostics(
    clamp.replace("clamp(value: 5, low: 0, high: 10) == 5", "clamp(value: 5, low: 10, high: 0) == 5"),
  );
  assertEquals(requires.map((d) => [d.code, d.at]), [["E0403", "clamp(value: 5, low: 10, high: 0) == 5"]]);
  assertEquals(
    requires[0].message,
    "The example ends in a trap (`requires`). Precondition of math.clamp violated: low <= high.",
  );

  // The expected side traps too: Port(value: 0) violates the invariant.
  const where = await diagnostics(PORT.replace("Err(OutOfRange(0))", "Ok(Port(value: 0))"));
  assertEquals(where.map((d) => d.code), ["E0403"]);
  assert_(where[0].message.includes("(`where`)"), where[0].message);

  const overflow = await diagnostics(
    fn("m.big", {
      params: ["n: Int"],
      out: "Int",
      examples: ["big(n: 9_007_199_254_740_991) == 0"],
      body: "return n + 1",
    }),
  );
  assertEquals(overflow.map((d) => d.code), ["E0403"]);
  assertEquals(
    overflow[0].message,
    "The example ends in a trap (`overflow`). Int overflow (at `9007199254740991 + 1`).",
  );
});

Deno.test("accept: runaway recursion is a trap, not a crash of the tool", async () => {
  const source = fn("m.down", {
    params: ["n: Int"],
    out: "Int",
    examples: ["down(n: 3) == 0"],
    // The base case is never reached.
    body: "if n == 0 then\n  return 0\nend if\nreturn down(n: n + 1)",
  });
  const ds = await diagnostics(source);
  assertEquals(ds.map((d) => [d.code, d.at]), [["E0403", "down(n: 3) == 0"]]);
  assert_(ds[0].message.startsWith("The example ends in a trap (`stack`)."), ds[0].message);
  await accepted(source.replace("down(n: n + 1)", "down(n: n - 1)"));
});

Deno.test("accept: a rebuilt program runs its new code, however quickly it follows", async () => {
  const path = outPath();
  const version = (n: number) => fn("m.k", { out: "Int", examples: [`k() == ${n}`], body: `return ${n}` });
  for (let n = 1; n <= 5; n++) {
    await accept(version(n), path);
    // The previous version's examples would fail against this one.
    const ds = await accept(version(n).replace(`k() == ${n}`, `k() == ${n - 1}`), path).then(() => [], (e) => e);
    assert_(ds instanceof AlangError, `version ${n}: an outdated module ran`);
  }
});

Deno.test("accept: every failing example of a program is reported", async () => {
  const source = specBlock("fn math.clamp")
    .replace("clamp(value: 5, low: 0, high: 10) == 5", "clamp(value: 5, low: 0, high: 10) == 6")
    .replace("clamp(value: 42, low: 0, high: 10) == 10", "clamp(value: 42, low: 0, high: 10) == 42");
  const ds = await diagnostics(source);
  assertEquals(ds.map((d) => d.message), [
    "The example does not hold: `clamp(value: 5, low: 0, high: 10)` is `5`.",
    "The example does not hold: `clamp(value: 42, low: 0, high: 10)` is `10`.",
  ]);
});

// ---- actual values as alang text ----

// Every function returns something other than its example says. The
// rendered actual values are checked literally, and then substituted into
// the examples: the result must be accepted, so the text is valid alang
// that denotes exactly the value.
const VALUES = [
  PORT,
  `type vals.Pair
  doc: "Two numbers."
  record:
    whole: Int
    part: Float
  where: none
end type vals.Pair`,
  fn("vals.pair", {
    params: ["n: Int"],
    out: "Pair",
    examples: ["pair(n: 3) == Pair(whole: 0, part: 0.0)"],
    body: "return Pair(whole: n * -100_000, part: std.int.to_float(value: n) / 4.0)",
  }),
  fn("vals.ratio", {
    params: ["a: Float", "b: Float"],
    out: "List<Float>",
    examples: ["ratio(a: 1.0, b: 0.0) == std.list.empty<Float>()"],
    body: "let xs: List<Float> = std.list.append(list: std.list.empty<Float>(), item: a / b)\n" +
      "return std.list.append(list: xs, item: 0.0 - (a / b))",
  }),
  fn("vals.quote", {
    params: ["text: String"],
    out: "String",
    examples: ['quote(text: "x") == "x"'],
    body: 'return std.string.concat(left: "line\\n\\t", right: std.string.concat(left: text, right: "\\"\\\\é"))',
  }),
  fn("vals.order", {
    params: ["a: Int"],
    out: "Option<Order>",
    examples: ["order(a: 1) == None"],
    body: "return Some(std.int.compare(left: a, right: 2))",
  }),
  fn("vals.ports", {
    params: ["text: String"],
    out: "List<Result<net.port.Port, net.port.ParseError>>",
    examples: ['ports(text: "x") == std.list.empty<Result<net.port.Port, net.port.ParseError>>()'],
    body: "let one: List<Result<net.port.Port, net.port.ParseError>> = " +
      'std.list.append(list: std.list.empty<Result<net.port.Port, net.port.ParseError>>(), item: net.port.parse(text: "80"))\n' +
      'let two: List<Result<net.port.Port, net.port.ParseError>> = std.list.append(list: one, item: net.port.parse(text: "0"))\n' +
      "return std.list.append(list: two, item: net.port.parse(text: text))",
  }),
  fn("vals.read_error", {
    params: ["n: Int"],
    out: "Result<Bool, std.fs.ReadError>",
    examples: ["read_error(n: 1) == Ok(true)"],
    body: 'if n > 0 then\n  return Err(std.fs.Other("disk"))\nend if\nreturn Err(std.fs.NotFound)',
  }),
].join("\n\n");

Deno.test("accept: actual values print as alang text written from the example's module", async () => {
  const outcomes = await testExamples(await build(VALUES, outPath()));
  const failed = outcomes.filter((o) => !o.passed);
  assertEquals(Object.fromEntries(failed.map((o) => [o.definition, o.actual])), {
    "vals.pair": "Pair(whole: -300_000, part: 0.75)",
    "vals.ratio": "std.list.append(list: std.list.append(list: std.list.empty<Float>(), item: 1.0 / 0.0), " +
      "item: -1.0 / 0.0)",
    "vals.quote": '"line\\n\\tx\\"\\\\é"',
    "vals.order": "Some(Less)",
    "vals.ports": "std.list.append(list: std.list.append(list: std.list.append(list: " +
      "std.list.empty<Result<net.port.Port, net.port.ParseError>>(), item: Ok(net.port.Port(value: 80))), " +
      "item: Err(net.port.OutOfRange(0))), item: Err(net.port.NotANumber))",
    "vals.read_error": 'Err(std.fs.Other("disk"))',
  });

  let fixed = VALUES;
  for (const o of failed) fixed = fixed.replace(o.text, `${o.call} == ${o.actual}`);
  await accepted(fixed);
});

Deno.test("accept: values without a failing example print canonically too", () => {
  const shapes = new Map();
  assertEquals(showValue(null, UNIT, shapes, "m"), "Unit");
  assertEquals(showValue(65_535, INT, shapes, "m"), "65_535");
  assertEquals(showValue(-0.000_000_1, FLOAT, shapes, "m"), "-0.0000001");
  assertEquals(showValue(1e21, FLOAT, shapes, "m"), "1_000_000_000_000_000_000_000.0");
  assertEquals(showValue({ tag: "Greater" }, ORDER, shapes, "m"), "Greater");
  assertEquals(
    showValue({ tag: "Some", value: [] }, option(list(STRING)), shapes, "m"),
    "Some(std.list.empty<String>())",
  );
  // Maps have no constructor in std yet; they fall back to std.text.show.
  assertEquals(showValue(new Map([[1, 2]]), con("Map", INT, INT), shapes, "m"), "{1: 2}");
});

// ---- the command line ----

async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      new URL("../src/cli.ts", import.meta.url).pathname,
      ...args,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = (b: Uint8Array) => new TextDecoder().decode(b).trim();
  return { code: out.code, stdout: text(out.stdout), stderr: text(out.stderr) };
}

Deno.test("accept: check, ts, build and run refuse a program whose example fails", async () => {
  await Deno.mkdir(OUT, { recursive: true });
  const file = `${OUT}failing.alang`;
  const hello = specBlock("fn hello.main");
  await Deno.writeTextFile(file, hello + "\n\n" + PORT.replace("Err(OutOfRange(0))", "Err(NotANumber)"));
  for (const command of ["check", "ts", "build", "run"]) {
    const r = await cli(command, file, "-o", `${OUT}failing.ts`);
    assertEquals(r.code, 1, `${command}: ${r.stderr}`);
    assertEquals(JSON.parse(r.stderr).map((d: Diagnostic) => d.code), ["E0402"], command);
    assertEquals(r.stdout, "", command);
  }
  // `test` lists every example with the actual value of the failing one.
  const t = await cli("test", file, "-o", `${OUT}failing.ts`);
  assertEquals(t.code, 1);
  assert_(
    t.stdout.includes('FAIL net.port.parse: parse(text: "0") == Err(NotANumber)  (actual: Err(OutOfRange(0)))'),
    t.stdout,
  );
  assert_(t.stdout.endsWith("2 passed, 1 failed"), t.stdout);

  await Deno.writeTextFile(file, hello + "\n\n" + PORT);
  assertEquals(await cli("check", file, "-o", `${OUT}failing.ts`), { code: 0, stdout: "ok", stderr: "" });
  const run = await cli("run", file, "-o", `${OUT}failing.ts`);
  assertEquals([run.code, run.stdout], [0, "Hello, world"], run.stderr);
});
