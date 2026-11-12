// Thin wrapper over node:assert so the tests need no downloaded dependencies.

import assert from "node:assert/strict";

export function assertEquals<T>(actual: T, expected: T, message?: string): void {
  assert.deepStrictEqual(actual, expected, message);
}

export function assert_(condition: unknown, message?: string): asserts condition {
  assert.ok(condition, message);
}

export function assertThrows<E extends Error>(
  fn: () => unknown,
  type?: new (...args: never[]) => E,
  includes?: string,
): E {
  try {
    fn();
  } catch (e) {
    if (type && !(e instanceof type)) throw e;
    if (includes && !(e as Error).message.includes(includes)) {
      throw new Error(`Expected error message to include "${includes}", got "${(e as Error).message}"`);
    }
    return e as E;
  }
  throw new Error("Expected function to throw.");
}
