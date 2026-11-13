// The pure std functions in src/runtime.ts, called directly with tables of
// inputs and results. The checker's view of them (signatures, effects) is
// tested in check_test.ts; their use from generated code in emit_test.ts.

import { assertEquals } from "./assert.ts";
import * as rt from "../src/runtime.ts";

Deno.test("std: an Int is never negative zero", () => {
  const zeros: [string, number][] = [
    ["0 * -1", rt.int_mul(0, -1, "m.f")],
    ["-7 % 7", rt.int_rem(-7, 7, "m.f")],
    ["-1 / 2", rt.int_div(-1, 2, "m.f")],
    ["0 - 0", rt.int_sub(0, 0, "m.f")],
    ['parse("-0")', (rt.std$int$parse("-0") as rt.Some<number>).value],
    ["floor(-0.0)", rt.std$float$floor(-0)],
    ["floor(-0.5) + 1", rt.int_add(rt.std$float$floor(-0.5), 1, "m.f")],
  ];
  for (const [what, value] of zeros) assertEquals(Object.is(value, 0), true, what);
  // A Float keeps IEEE's -0.0.
  assertEquals(Object.is(rt.float_mul(0, -1, "m.f"), -0), true);
});

const MAX = Number.MAX_SAFE_INTEGER;

Deno.test("std.int: min, max and abs", () => {
  assertEquals([rt.std$int$min(3, -4), rt.std$int$min(-4, 3), rt.std$int$min(2, 2)], [-4, -4, 2]);
  assertEquals([rt.std$int$max(3, -4), rt.std$int$max(-4, 3), rt.std$int$max(2, 2)], [3, 3, 2]);
  assertEquals([rt.std$int$abs(-5), rt.std$int$abs(5), rt.std$int$abs(0), rt.std$int$abs(-MAX)], [5, 5, 0, MAX]);
});

Deno.test("std.int: checked arithmetic is None outside the Int range", () => {
  const cases: [string, rt.Option<number>, rt.Option<number>][] = [
    ["MAX + 0", rt.std$int$checked_add(MAX, 0), rt.Some(MAX)],
    ["MAX + 1", rt.std$int$checked_add(MAX, 1), rt.None],
    ["-MAX + -1", rt.std$int$checked_add(-MAX, -1), rt.None],
    ["MAX + -MAX", rt.std$int$checked_add(MAX, -MAX), rt.Some(0)],
    ["-MAX - 0", rt.std$int$checked_subtract(-MAX, 0), rt.Some(-MAX)],
    ["-MAX - 1", rt.std$int$checked_subtract(-MAX, 1), rt.None],
    ["MAX - -1", rt.std$int$checked_subtract(MAX, -1), rt.None],
    ["3 - 5", rt.std$int$checked_subtract(3, 5), rt.Some(-2)],
    ["MAX * 1", rt.std$int$checked_multiply(MAX, 1), rt.Some(MAX)],
    ["MAX * -1", rt.std$int$checked_multiply(MAX, -1), rt.Some(-MAX)],
    ["MAX * 2", rt.std$int$checked_multiply(MAX, 2), rt.None],
    ["2^26 * 2^27", rt.std$int$checked_multiply(2 ** 26, 2 ** 27), rt.None],
    ["-6 * 7", rt.std$int$checked_multiply(-6, 7), rt.Some(-42)],
  ];
  for (const [what, actual, expected] of cases) assertEquals(actual, expected, what);
  // Without negative zero: deepStrictEqual tells 0 from -0.
  assertEquals(rt.std$int$checked_multiply(0, -1), rt.Some(0));
  assertEquals(rt.std$int$checked_subtract(-0, 0), rt.Some(0));
});
