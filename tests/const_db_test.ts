// Constants in the database and the MCP tools (phase `const`, C7 to C11):
// hits, signatures, context, callers, interface changes, a fn turned into a
// const, remove, rename, the E0226 fix, export and import, search, and the
// migration of a database made before constants.

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assert_, assertEquals } from "./assert.ts";
import { checkProgram } from "../src/check.ts";
import { Codebase, hashText } from "../src/codebase.ts";
import { INSTRUCTIONS, TOOLS } from "../src/mcp.ts";
import { parseProgram } from "../src/parser.ts";
import { printDefinition, printSignature } from "../src/printer.ts";
import { dependencies } from "../src/refs.ts";
import { add, CLOCK, codes, done, fails, fn, fresh, hashOf, ok } from "./db_helpers.ts";

const SHOP = [
  `const shop.max_items
  doc: "The most items one order may hold."
  out: Int
  body:
    return 100
end const shop.max_items`,
  `const shop.prices
  doc: "The price of one shirt per size, in cents."
  out: Map<String, Int>
  body:
    let base: Int = 1500
    return ["S": base, "M": base, "L": base + 200, "XL": base + 400]
end const shop.prices`,
  `type shop.Limits
  doc: "How many items and sizes an order may have."
  record:
    items: Int
    sizes: Int
  where: items <= max_items
end type shop.Limits`,
  `const shop.limits
  doc: "The limits of an order."
  out: Limits
  body:
    return Limits(items: max_items, sizes: std.map.size(map: prices))
end const shop.limits`,
  fn("shop.price", {
    params: ["size: String", "count: Int"],
    out: "Option<Int>",
    examples: [
      'price(size: "M", count: 2) == Some(3000)',
      'price(size: "XL", count: 1) == Some(1900)',
      'price(size: "XXL", count: 1) == None',
      'price(size: "S", count: max_items) == Some(150_000)',
    ],
    body: "let each: Int = std.map.get(map: prices, key: size) else return None\nreturn Some(each * count)",
  }).replace("  requires: none", "  requires: count <= max_items"),
  fn("shop.fits", {
    params: ["count: Int"],
    out: "Bool",
    examples: ["fits(count: 100) == true", "fits(count: 101) == false"],
    body: "return count <= limits.items",
  }),
];

const WEB = fn("web.label", {
  params: ["prefix: String"],
  out: "String",
  examples: ['label(prefix: "max ") == "max 100 of 4 sizes"'],
  body:
    'return std.string.join(parts: [prefix, std.text.show(value: shop.max_items), " of ", std.text.show(value: shop.limits.sizes), " sizes"], separator: "")',
});

const MAX_ITEMS = SHOP[0];

async function withShop(): Promise<Codebase> {
  const cb = await fresh();
  await ok(cb, [...SHOP, WEB].map(add));
  return cb;
}

Deno.test("const db: list shows constants with their type; signature is doc and out (C9, C10)", async () => {
  const cb = await withShop();
  const hits = cb.list("shop").definitions;
  assertEquals(hits.map((h) => [h.name, h.kind]), [
    ["shop.Limits", "type"],
    ["shop.fits", "fn"],
    ["shop.limits", "const"],
    ["shop.max_items", "const"],
    ["shop.price", "fn"],
    ["shop.prices", "const"],
  ]);
  assertEquals(hits.filter((h) => h.kind === "const").map((h) => h.signature), [
    "const shop.limits: shop.Limits",
    "const shop.max_items: Int",
    "const shop.prices: Map<String, Int>",
  ]);
  assertEquals(
    cb.signature("shop.max_items").signature,
    'const shop.max_items\n  doc: "The most items one order may hold."\n  out: Int\nend const shop.max_items',
  );
  assertEquals(cb.definition("shop.max_items").text, MAX_ITEMS);
  assertEquals(cb.searchText("most items").map((h) => h.name), ["shop.max_items"]);
  assert_(!cb.searchType("-> Int").some((h) => h.name.startsWith("shop.")), "no constant in search_type");
  await done(cb);
});

Deno.test("const db: context gives a used constant's whole text; callers include constants and types", async () => {
  const cb = await withShop();
  const fits = cb.context("shop.fits");
  assertEquals(fits.uses.map((u) => u.name), ["shop.limits", "shop.Limits"]);
  assertEquals(fits.uses[0].text, SHOP[3]);
  assertEquals(cb.context("web.label").uses.map((u) => u.name), [
    "std.string.join",
    "std.text.show",
    "shop.max_items",
    "shop.limits",
    "shop.Limits",
  ]);
  assertEquals(cb.callers("shop.max_items").callers, ["shop.Limits", "shop.limits", "shop.price", "web.label"]);
  await done(cb);
});

Deno.test("const db: a constant's type is its interface, its value is not (C8)", async () => {
  const cb = await withShop();
  const hash = hashOf(cb, "shop.max_items");
  const float = MAX_ITEMS.replace("out: Int", "out: Float").replace("return 100", "return 100.0");
  const r = await fails(cb, [{ op: "replace", name: "shop.max_items", hash, text: float }]);
  assertEquals(codes(r.diagnostics), ["E0506"]);
  assertEquals(
    r.diagnostics[0].message,
    "`shop.max_items` changes its `out` section, which affects `shop.Limits`, `shop.limits`, `shop.price`, " +
      "`web.label`. Submit them, adapted, in the same transaction (6.4).",
  );
  // A new value is no interface change: the examples that state the old one
  // reject it, and nothing is written.
  const fifty = await fails(cb, [{
    op: "replace",
    name: "shop.max_items",
    hash,
    text: MAX_ITEMS.replace("return 100", "return 50"),
  }]);
  assertEquals(fifty.diagnostics.map((d) => [d.code, d.definition, d.message]), [
    ["E0402", "shop.fits", "The example does not hold: `fits(count: 100)` is `false`."],
    ["E0402", "shop.price", 'The example does not hold: `price(size: "S", count: max_items)` is `Some(75_000)`.'],
    ["E0402", "web.label", 'The example does not hold: `label(prefix: "max ")` is `"max 50 of 4 sizes"`.'],
  ]);
  assertEquals(hashOf(cb, "shop.max_items"), hash);
  await done(cb);
});

Deno.test("const db: a fn becomes a const in one submit with its callers (C7)", async () => {
  const cb = await fresh();
  const limitFn = fn("m.limit", { out: "Int", examples: ["limit() == 100"], body: "return 100" });
  const f = fn("m.f", { params: ["n: Int"], out: "Bool", examples: ["f(n: 1) == true"], body: "return n < limit()" });
  await ok(cb, [add(limitFn), add(f)]);
  const limitConst = 'const m.limit\n  doc: "limit."\n  out: Int\n  body:\n    return 100\nend const m.limit';
  const replace = { op: "replace" as const, name: "m.limit", hash: hashOf(cb, "m.limit"), text: limitConst };
  const alone = await fails(cb, [replace]);
  assertEquals(alone.diagnostics.map((d) => [d.code, d.message]), [[
    "E0506",
    "`m.limit` changes from a `fn` to a `const`, which affects `m.f`. Submit them, adapted, in the same transaction (6.4).",
  ]]);
  const adapted = f.replace("return n < limit()", "return n < limit");
  await ok(cb, [replace, { op: "replace", name: "m.f", hash: hashOf(cb, "m.f"), text: adapted }]);
  assertEquals(cb.list("m").definitions.find((h) => h.name === "m.limit")?.kind, "const");
  assertEquals(cb.history("m.limit").entries.map((e) => e.operation), ["add", "replace"]);
  await done(cb);
});

Deno.test("const db: remove, rename and the E0226 fix cover constants", async () => {
  const cb = await withShop();
  const removed = await fails(cb, [{ op: "remove", name: "shop.max_items", hash: hashOf(cb, "shop.max_items") }]);
  assertEquals(removed.diagnostics.map((d) => [d.code, d.message]), [[
    "E0507",
    "`shop.max_items` is still used by `shop.Limits`, `shop.limits`, `shop.price`, `web.label`. Remove or change them in the same transaction.",
  ]]);
  const renamed = await ok(cb, [{
    op: "rename",
    name: "shop.limits",
    hash: hashOf(cb, "shop.limits"),
    to: "shop.order_limits",
  }]);
  assertEquals(renamed.written.map((w) => [w.name, w.operation]).sort(), [
    ["shop.fits", "follow"],
    ["shop.limits", "rename"],
    ["shop.order_limits", "rename"],
    ["web.label", "follow"],
  ]);
  assert_(cb.definition("shop.fits").text.includes("return count <= order_limits.items"));
  assert_(cb.definition("web.label").text.includes("std.text.show(value: shop.order_limits.sizes)"));
  // A name written in full in its own module is stored short.
  const g = fn("shop.g", {
    params: ["n: Int"],
    out: "Int",
    examples: ["g(n: 1) == 201"],
    body: "return n + shop.max_items + shop.order_limits.items",
  });
  const fixed = await ok(cb, [add(g)]);
  assertEquals(codes(fixed.fixed ?? []), ["E0226", "E0226"]);
  assert_(cb.definition("shop.g").text.includes("return n + max_items + order_limits.items"));
  await done(cb);
});

Deno.test("const db: a rename a local captures is refused (E0510)", async () => {
  const cb = await withShop();
  const cap = fn("shop.cap", {
    params: ["count: Int"],
    out: "Bool",
    examples: ["cap(count: 5) == true"],
    body: "return count <= max_items",
  });
  await ok(cb, [add(cap)]);
  const r = await fails(cb, [{
    op: "rename",
    name: "shop.max_items",
    hash: hashOf(cb, "shop.max_items"),
    to: "shop.count",
  }]);
  // shop.price's `requires` is captured too, but its example still names the
  // constant, so the comparison of dependency sets misses it (known, Risks).
  assertEquals(r.diagnostics.map((d) => [d.code, d.definition]), [["E0510", "shop.cap"]]);
  await done(cb);
});

Deno.test("const db: an add whose header is a const names its definition; export and import keep hashes", async () => {
  const cb = await withShop();
  const bad = await fails(cb, [add(MAX_ITEMS.replace("shop.max_items", "shop.bad").replace("most", "most\r"))]);
  assertEquals(bad.diagnostics.map((d) => [d.code, d.definition]), [["E0005", "shop.bad"]]);
  const exported = await Deno.readTextFile(join(cb.dir, "export", "shop.alang"));
  const names = parseProgram(exported).map((d) => d.path.join("."));
  assertEquals(names, ["shop.Limits", "shop.fits", "shop.limits", "shop.max_items", "shop.price", "shop.prices"]);
  assertEquals(exported, names.map((n) => cb.definition(n).text).join("\n\n") + "\n");
  const other = await fresh();
  const imported = await other.importAll(join(cb.dir, "export"));
  assert_(imported.ok, JSON.stringify(imported));
  for (const n of names) assertEquals(hashOf(other, n), hashOf(cb, n));
  await done(other);
  await done(cb);
});

Deno.test("const db: the MCP tools describe constants", () => {
  const description = (name: string) => TOOLS.find((t) => t.name === name)!.description;
  assert_(description("list").includes("`const shop.zones: Map<String, Int>`"), description("list"));
  assert_(description("context").includes("the text of every constant it uses"), description("context"));
  assert_(INSTRUCTIONS.includes("(a constant's whole text)"));
});

// The definitions table as alang made it before constants.
const OLD_SCHEMA = `
CREATE TABLE IF NOT EXISTS definitions (
  hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('fn', 'type')),
  text TEXT NOT NULL,
  signature TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS names (
  name TEXT PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE REFERENCES definitions (hash)
);
CREATE TABLE IF NOT EXISTS refs (
  from_hash TEXT NOT NULL REFERENCES definitions (hash),
  to_name TEXT NOT NULL,
  PRIMARY KEY (from_hash, to_name)
);
CREATE INDEX IF NOT EXISTS refs_to_name ON refs (to_name);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  hash TEXT REFERENCES definitions (hash),
  changed_at TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('add', 'replace', 'remove', 'rename', 'follow', 'import')),
  other_name TEXT
);
CREATE INDEX IF NOT EXISTS history_name ON history (name);
CREATE TABLE IF NOT EXISTS export_files (
  module TEXT PRIMARY KEY,
  hash TEXT NOT NULL
);
`;

Deno.test("const db: a database made before constants is migrated on open, history kept (C11)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "alang-db-old-" });
  const old = new DatabaseSync(join(dir, "alang.db"));
  old.exec("PRAGMA foreign_keys = ON");
  old.exec(OLD_SCHEMA);
  // One function, stored as the old code stored it: row, name, refs, history.
  const text = fn("shop.twice", {
    params: ["n: Int"],
    out: "Int",
    examples: ["twice(n: 2) == 4"],
    body: "return n * 2",
  });
  const [def] = parseProgram(text);
  const hash = hashText(printDefinition(def));
  old.prepare("INSERT INTO definitions (hash, kind, text, signature) VALUES (?, 'fn', ?, ?)")
    .run(hash, printDefinition(def), printSignature(def));
  old.prepare("INSERT INTO names (name, hash) VALUES ('shop.twice', ?)").run(hash);
  for (const to of dependencies(def, checkProgram([def]).info)) {
    old.prepare("INSERT INTO refs (from_hash, to_name) VALUES (?, ?)").run(hash, to);
  }
  old.prepare("INSERT INTO history (name, hash, changed_at, operation) VALUES ('shop.twice', ?, ?, 'add')")
    .run(hash, CLOCK().toISOString());
  assert_(
    String(
      assertThrowsMessage(() =>
        old.prepare("INSERT INTO definitions (hash, kind, text, signature) VALUES ('x', 'const', 't', 's')").run()
      ),
    ).includes("CHECK constraint failed"),
  );
  old.close();

  const sql = () => {
    const db = new DatabaseSync(join(dir, "alang.db"), { readOnly: true });
    try {
      return (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'definitions'").get() as { sql: string }).sql;
    } finally {
      db.close();
    }
  };
  const cb = await Codebase.open(dir, { clock: CLOCK });
  assert_(sql().includes("'const'"), sql());
  // deno-lint-ignore no-explicit-any
  const own = (cb as any).db as DatabaseSync;
  assertEquals((own.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1);
  await ok(cb, [add(MAX_ITEMS)]);
  assertEquals(cb.history("shop.twice").entries.map((e) => [e.hash, e.operation]), [[hash, "add"]]);
  assertEquals(cb.list("shop").definitions.map((h) => [h.name, h.kind]), [
    ["shop.max_items", "const"],
    ["shop.twice", "fn"],
  ]);
  cb.close();
  // A second open finds the new table and leaves it alone.
  const before = sql();
  const again = await Codebase.open(dir, { clock: CLOCK });
  assertEquals(sql(), before);
  await done(again);
});

function assertThrowsMessage(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("Expected an error.");
}
