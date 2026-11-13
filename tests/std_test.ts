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
