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
