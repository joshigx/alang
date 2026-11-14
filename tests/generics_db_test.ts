// Generic definitions in the database (phase `generics`, G13 to G15): hits
// and signatures with type parameters, letters that are no references,
// `search_type`, interface changes, renames a type parameter captures, and
// the header of an add.

import { assert_, assertEquals } from "./assert.ts";
import { checkProgram } from "../src/check.ts";
import type { Codebase } from "../src/codebase.ts";
import { parseProgram } from "../src/parser.ts";
import { printDefinition } from "../src/printer.ts";
import { dependencies } from "../src/refs.ts";
import { add, codes, done, fails, fn, fresh, hashOf, ok, withPort } from "./db_helpers.ts";
import { TREE, UTIL } from "./generics_fixtures.ts";

const [LAST, COUNT_IF, REPEAT, NONE_LIST] = parseProgram(UTIL).map(printDefinition);

const TAIL_OF = fn("util.tail_of", {
  params: ["xs: List<Int>"],
  out: "Option<Int>",
  examples: ["tail_of(xs: [4, 5]) == Some(5)"],
  body: "return last(list: xs)",
});

async function withUtil(): Promise<Codebase> {
  const cb = await fresh();
  await ok(cb, [LAST, COUNT_IF, REPEAT, NONE_LIST, TAIL_OF].map(add));
  return cb;
}

const names = (cb: Codebase, pattern: string) => cb.searchType(pattern).map((h) => h.name);

Deno.test("generics db: a hit shows the type parameters after the name, as std's do (G15)", async () => {
  const cb = await withUtil();
  const last = cb.list("util").definitions.find((h) => h.name === "util.last");
  assertEquals(last?.signature, "fn util.last<T>(list: List<T>): Option<T>, effects: none");
  const count = cb.list("util").definitions.find((h) => h.name === "util.count_if");
  assertEquals(count?.signature, "fn util.count_if<T>(list: List<T>, test: (T) -> Bool): Int, effects: none");
  assert_(cb.signature("util.last").signature.startsWith("fn util.last<T>\n"));
  await done(cb);
});

Deno.test("generics db: a type parameter is no reference (G14)", async () => {
  const defs = parseProgram(UTIL);
  const { diagnostics, info } = checkProgram(defs);
  assertEquals(diagnostics, []);
  assertEquals(dependencies(defs[0], info), ["util.last", "std.list.empty", "std.list.get", "std.list.length"]);
  // The stored refs rows are these dependencies (`invariants` in `done`).
  const cb = await withUtil();
  assertEquals(cb.callers("util.last").callers, ["util.tail_of"]);
  await done(cb);
});

Deno.test("generics db: search_type matches a stored type parameter as std's (G15)", async () => {
  const cb = await withUtil();
  assertEquals(names(cb, "List<Int> -> Option<Int>"), ["std.list.first", "std.list.last", "util.last", "util.tail_of"]);
  assertEquals(names(cb, "List<Int> -> Option<String>"), []);
  assertEquals(names(cb, "List<_>, (_) -> Bool -> Int").filter((n) => n.startsWith("util.")), ["util.count_if"]);
  // The same type at each occurrence.
  assert_(names(cb, "String, Int -> List<String>").includes("util.repeat"));
  assert_(!names(cb, "String, Int -> List<Int>").includes("util.repeat"));
  await done(cb);
});

Deno.test("generics db: renaming a type parameter throughout is no interface change (G13)", async () => {
  const cb = await withUtil();
  const renamed = LAST.replaceAll("<T>", "<E>");
  assert_(renamed.startsWith("fn util.last<E>\n") && !renamed.includes("<T>"));
  await ok(cb, [{ op: "replace", name: "util.last", hash: hashOf(cb, "util.last"), text: renamed }]);
  assertEquals(cb.definition("util.last").text, renamed);
  // Without the type parameter, `in` and `out` change for the caller.
  const ints = renamed.replace("fn util.last<E>", "fn util.last").replaceAll("<E>", "<Int>")
    .replace('    last(list: ["a"]) == Some("a")\n', "");
  const r = await fails(cb, [{ op: "replace", name: "util.last", hash: hashOf(cb, "util.last"), text: ints }]);
  assertEquals(codes(r.diagnostics), ["E0506"]);
  assert_(r.diagnostics[0].message.includes("changes its `in`, `out` section"), r.diagnostics[0].message);
  await done(cb);
});

Deno.test("generics db: a rename whose new name a type parameter captures is refused (E0510, G14)", async () => {
  const cb = await fresh();
  const x = `type m.X
  doc: "A tag."
  record:
    n: Int
  where: none
end type m.X`;
  const keep = fn("m.keep", {
    params: ["item: T", "tag: X"],
    out: "T",
    examples: ["keep(item: 1, tag: X(n: 2)) == 1"],
    body: "return item",
  }).replace("fn m.keep\n", "fn m.keep<T>\n");
  await ok(cb, [add(x), add(keep)]);
  const r = await fails(cb, [{ op: "rename", name: "m.X", hash: hashOf(cb, "m.X"), to: "m.T" }]);
  assertEquals(r.diagnostics.map((d) => [d.code, d.definition]), [["E0510", "m.keep"]]);
  assert_(r.diagnostics[0].message.includes("A local binding or a type parameter probably has the new name"));
  await done(cb);
});

Deno.test("generics db: an add's header names its definition with type parameters", async () => {
  const cb = await fresh();
  const bad = LAST.replace("fn util.last<T>", "fn util.bad<T>").replace("end fn util.last", "end fn util.bad")
    .replace("The last item", "The last\\ritem");
  const r = await fails(cb, [add(bad)]);
  assertEquals(r.diagnostics.map((d) => [d.code, d.definition]), [["E0005", "util.bad"]]);
  await done(cb);
});

Deno.test("generics db: context lists a used generic function by its signature", async () => {
  const cb = await withUtil();
  const context = cb.context("util.tail_of");
  assertEquals(context.uses.map((u) => u.name), ["util.last"]);
  assert_(context.uses[0].text.startsWith("fn util.last<T>\n"));
  await done(cb);
});

Deno.test("generics db: a case's type arguments are references (G7)", async () => {
  const cb = await withPort();
  const none = fn("m.none_port", {
    params: ["n: Int"],
    out: "Bool",
    examples: ["none_port(n: 1) == true"],
    body: "return std.list.length(list: [None<net.port.Port>]) == n",
  });
  await ok(cb, [add(none)]);
  assert_(cb.callers("net.port.Port").callers.includes("m.none_port"));
  await done(cb);
});

Deno.test("generics db: generic types in hits, search_type and interface changes (G8, G13, G15)", async () => {
  const cb = await fresh();
  const defs = parseProgram(TREE).map(printDefinition);
  await ok(cb, defs.map(add));
  const hits = cb.list("tree").definitions.map((h) => [h.name, h.signature]);
  assertEquals(hits.sort(), [
    ["tree.Branch", "type tree.Branch<T>, record: item: T, left: tree.Tree<T>, right: tree.Tree<T>"],
    ["tree.Tree", "type tree.Tree<T>, variant: Leaf | Node: tree.Branch<T>"],
    [
      "tree.insert",
      "fn tree.insert<T>(tree: tree.Tree<T>, item: T, by: (T, T) -> Order): tree.Tree<T>, effects: none",
    ],
    ["tree.items", "fn tree.items<T>(tree: tree.Tree<T>): List<T>, effects: none"],
  ]);
  assertEquals(names(cb, "Tree<_> -> List<_>"), ["tree.items"]);
  // The context of a function over a generic type names it, never a letter.
  assertEquals(cb.context("tree.items").uses.map((u) => u.name), [
    "tree.Tree",
    "std.list.empty",
    "tree.Branch",
    "std.list.flatten",
  ]);
  const tree = defs.find((d) => d.startsWith("type tree.Tree<T>"))!;
  await ok(cb, [{
    op: "replace",
    name: "tree.Tree",
    hash: hashOf(cb, "tree.Tree"),
    text: tree.replaceAll("T>", "E>"),
  }]);
  assert_(cb.definition("tree.Tree").text.startsWith("type tree.Tree<E>\n"));
  const branch = defs.find((d) => d.startsWith("type tree.Branch<T>"))!;
  const swapped = branch.replace("    item: T\n    left: Tree<T>\n", "    left: Tree<T>\n    item: T\n");
  const r = await fails(cb, [{ op: "replace", name: "tree.Branch", hash: hashOf(cb, "tree.Branch"), text: swapped }]);
  assertEquals(codes(r.diagnostics), ["E0506"]);
  assert_(r.diagnostics[0].message.includes("changes its `record` section"), r.diagnostics[0].message);
  await done(cb);
});
