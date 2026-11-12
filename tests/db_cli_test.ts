// `alang db` on the command line: JSON out, exit code 1 on a rejection.

import { join } from "node:path";
import { assert_, assertEquals } from "./assert.ts";
import { LOAD_ERROR, LOAD_PORT, PARSE, PARSE_ERROR, PORT } from "./db_helpers.ts";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

async function alang(dir: string, ...args: string[]): Promise<{ code: number; json: unknown; stderr: string }> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", "--allow-write", CLI, "db", "--dir", dir, ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(out.stdout);
  return { code: out.code, json: stdout ? JSON.parse(stdout) : null, stderr: new TextDecoder().decode(out.stderr) };
}

Deno.test("db cli: submit, query, a stale guard, export and import", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "alang-db-cli-" });
  const dir = join(tmp, "project");
  const changes = join(tmp, "changes.json");
  await Deno.writeTextFile(
    changes,
    JSON.stringify([PORT, PARSE_ERROR, PARSE, LOAD_PORT, LOAD_ERROR].map((text) => ({ op: "add", text }))),
  );
  const added = await alang(dir, "submit", changes);
  assertEquals(added.code, 0, added.stderr);
  assertEquals((added.json as { written: unknown[] }).written.length, 5);

  const def = await alang(dir, "definition", "net.port.parse");
  assertEquals(def.code, 0);
  const { hash } = def.json as { hash: string };
  assertEquals((await alang(dir, "callers", "net.port.parse")).json, {
    name: "net.port.parse",
    hash,
    callers: ["config.load_port"],
  });

  // An interface change and its adapted caller in one transaction (6.4).
  const loadPortHash = ((await alang(dir, "definition", "config.load_port")).json as { hash: string }).hash;
  const renamedParam = PARSE.replaceAll("text: ", "source: ").replace(
    "std.int.parse(source: text)",
    "std.int.parse(text: source)",
  );
  const single = join(tmp, "parse.alang");
  await Deno.writeTextFile(single, renamedParam);
  const alone = await alang(dir, "replace", "net.port.parse", hash, single);
  assertEquals(alone.code, 1);
  assertEquals((alone.json as { diagnostics: { code: string }[] }).diagnostics[0].code, "E0506");
  await Deno.writeTextFile(
    changes,
    JSON.stringify([
      { op: "replace", name: "net.port.parse", hash, text: renamedParam },
      {
        op: "replace",
        name: "config.load_port",
        hash: loadPortHash,
        text: LOAD_PORT.replace("net.port.parse(text: trimmed)", "net.port.parse(source: trimmed)"),
      },
    ]),
  );
  assertEquals((await alang(dir, "submit", changes)).code, 0);

  // The old hash is stale now.
  const stale = await alang(dir, "remove", "net.port.parse", hash);
  assertEquals(stale.code, 1);
  assertEquals((stale.json as { current: { name: string }[] }).current[0].name, "net.port.parse");

  // An unknown name: diagnostics on stderr.
  const unknown = await alang(dir, "context", "net.port.pars");
  assertEquals(unknown.code, 1);
  assert_(unknown.stderr.includes('"E0502"'), unknown.stderr);

  // A fresh project imported from the export has the same names.
  const other = join(tmp, "other");
  const imported = await alang(other, "import", join(dir, "export"));
  assertEquals(imported.code, 0, imported.stderr);
  assertEquals((await alang(other, "list", "net.port")).json, (await alang(dir, "list", "net.port")).json);

  // Usage errors.
  assertEquals((await alang(dir, "definition")).code, 2);
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("db cli: queries follow the export; export refuses to overwrite changed files", async () => {
  const dir = await Deno.makeTempDir({ prefix: "alang-db-cli-" });
  const changes = join(dir, "changes.json");
  await Deno.writeTextFile(changes, JSON.stringify([PORT, PARSE_ERROR, PARSE].map((text) => ({ op: "add", text }))));
  assertEquals((await alang(dir, "submit", changes)).code, 0);
  const file = join(dir, "export", "net.port.alang");
  const reordered = PARSE.replace("if n < 1 or n > 65_535 then", "if n > 65_535 or n < 1 then");

  // As after a pull: the query answers with the file's version.
  await Deno.writeTextFile(file, `${PARSE_ERROR}\n\n${PORT}\n\n${reordered}\n`);
  assertEquals(((await alang(dir, "definition", "net.port.parse")).json as { text: string }).text, reordered);

  // A file that does not parse: the query still answers, with a warning.
  await Deno.writeTextFile(file, "<<<<<<< HEAD\n");
  const stale = await alang(dir, "definition", "net.port.parse");
  assertEquals([stale.code, (stale.json as { text: string }).text], [0, reordered]);
  assert_(stale.stderr.includes('"warning"') && stale.stderr.includes("net.port.alang"), stale.stderr);
  const refused = await alang(dir, "export");
  assertEquals(refused.code, 1);
  assertEquals(await Deno.readTextFile(file), "<<<<<<< HEAD\n");

  // `--force` lets the database win.
  assertEquals((await alang(dir, "export", "--force")).code, 0);
  assertEquals(await Deno.readTextFile(file), `${PARSE_ERROR}\n\n${PORT}\n\n${reordered}\n`);
  assertEquals((await alang(dir, "export", "--all")).code, 2);
  await Deno.remove(dir, { recursive: true });
});
