// The MCP server: the protocol in both eras, the tools on the path of a
// change, sync before queries, and the stdio transport end to end.

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assert_, assertEquals } from "./assert.ts";
import {
  CLOCK,
  done,
  fn,
  fresh,
  LOAD_PORT,
  PARSE,
  PARSE_ERROR,
  PARSE_REORDERED,
  PORT,
  withPort,
} from "./db_helpers.ts";
import { CARD } from "../src/card.ts";
import { Codebase, hashText } from "../src/codebase.ts";
import { LEGACY_VERSIONS, McpServer, MODERN_VERSIONS, type Response, TOOLS } from "../src/mcp.ts";

let ids = 0;

async function request(server: McpServer, method: string, params?: unknown): Promise<Response> {
  const id = ++ids;
  const response = await server.handle({ jsonrpc: "2.0", id, method, params });
  assert_(response !== null, `no response to ${method}`);
  assertEquals(response.id, id);
  return response;
}

async function result(server: McpServer, method: string, params?: unknown): Promise<Record<string, unknown>> {
  const r = await request(server, method, params);
  assert_(r.error === undefined, JSON.stringify(r.error));
  return r.result as Record<string, unknown>;
}

const modern = (params: Record<string, unknown> = {}) => ({
  ...params,
  _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} },
});

interface Called {
  readonly isError: boolean;
  // The first content block, parsed.
  readonly json: Record<string, unknown>;
  // Every content block, parsed.
  readonly blocks: Record<string, unknown>[];
}

async function call(server: McpServer, name: string, args: unknown): Promise<Called> {
  const r = await result(server, "tools/call", { name, arguments: args }) as {
    content: { type: string; text: string }[];
    isError: boolean;
  };
  assert_(r.content.every((c) => c.type === "text"));
  const blocks = r.content.map((c) => JSON.parse(c.text));
  return { isError: r.isError, json: blocks[0], blocks };
}

const codesOf = (c: Called) => (c.json.diagnostics as { code: string }[]).map((d) => d.code);

Deno.test("mcp: the initialize handshake and the stateless era", async () => {
  const cb = await fresh();
  const server = new McpServer(cb);

  // Legacy: the server answers with the version asked for, if it has it.
  const init = await result(server, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  assertEquals(init.protocolVersion, "2025-06-18");
  assertEquals(init.capabilities, { tools: {} });
  assertEquals((init.serverInfo as { name: string }).name, "alang");
  assert_((init.instructions as string).includes("context(name)"));
  assertEquals((await result(server, "initialize", { protocolVersion: "2099-01-01" })).protocolVersion, "2025-11-25");
  assertEquals(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assertEquals(await result(server, "ping"), {});
  const legacyTools = await result(server, "tools/list", {});
  assertEquals(Object.keys(legacyTools), ["tools"]);

  // Modern: discover, then requests with their version in `_meta`.
  const discovered = await result(server, "server/discover", modern());
  assertEquals(discovered.resultType, "complete");
  assertEquals(discovered.supportedVersions, MODERN_VERSIONS);
  assertEquals(discovered.capabilities, { tools: {} });
  assertEquals(discovered.instructions, init.instructions);
  const tools = await result(server, "tools/list", modern());
  assertEquals([tools.resultType, tools.cacheScope, typeof tools.ttlMs], ["complete", "public", "number"]);
  assertEquals(tools.tools, legacyTools.tools);
  assertEquals((await result(server, "ping", modern())).resultType, "complete");
  const unsupported = await request(server, "tools/list", {
    _meta: { "io.modelcontextprotocol/protocolVersion": "2025-11-25" },
  });
  assertEquals(unsupported.error, {
    code: -32022,
    message: "Unsupported protocol version",
    data: { supported: MODERN_VERSIONS, requested: "2025-11-25" },
  });
  assert_(!LEGACY_VERSIONS.some((v) => MODERN_VERSIONS.includes(v)));

  // Every tool, in a fixed order, with a closed schema.
  const listed = legacyTools.tools as { name: string; inputSchema: Record<string, unknown> }[];
  assertEquals(listed.map((t) => t.name), [
    "card",
    "context",
    "definition",
    "signature",
    "callers",
    "list",
    "search",
    "search_type",
    "history",
    "add",
    "replace",
    "remove",
    "rename",
    "submit",
  ]);
  for (const t of listed) {
    assertEquals(t.inputSchema.type, "object");
    assertEquals(t.inputSchema.additionalProperties, false);
    assert_(/^[a-z_]+$/.test(t.name));
  }
  assertEquals(listed.find((t) => t.name === "rename")!.inputSchema.required, ["name", "hash", "to"]);
  assertEquals(listed.find((t) => t.name === "list")!.inputSchema.required, []);

  // Protocol errors.
  assertEquals((await request(server, "resources/list")).error?.code, -32601);
  assertEquals((await request(server, "tools/call", { name: "nope", arguments: {} })).error?.code, -32602);
  assertEquals((await server.handle({ jsonrpc: "2.0", id: 1, method: "ping", params: [] }))?.error?.code, -32602);
  assertEquals((await server.handle({ id: 1, method: "ping" }))?.error?.code, -32600);
  // A batch is split by the transport (see the stdio test), not here.
  assertEquals((await server.handle([{ jsonrpc: "2.0", id: 1, method: "ping" }]))?.error?.code, -32600);
  assertEquals((await server.handle({ jsonrpc: "2.0", id: null, method: "ping" }))?.error?.code, -32600);
  // A response from the client: nothing to answer.
  assertEquals(await server.handle({ jsonrpc: "2.0", id: 7, result: {} }), null);
  await done(cb);
});

Deno.test("mcp: the path of a change through context and replace", async () => {
  const cb = await fresh();
  const server = new McpServer(cb);
  const added = await call(server, "submit", {
    changes: [PORT, PARSE_ERROR, PARSE].map((text) => ({ op: "add", text })),
  });
  assertEquals(added.isError, false);
  assertEquals((added.json.written as unknown[]).length, 3);
  assertEquals((await call(server, "add", { text: LOAD_PORT })).isError, true); // needs config.LoadError

  // Read (the spec's step 1), then replace with the hash (step 2).
  const context = await call(server, "context", { name: "net.port.parse" });
  assertEquals(context.isError, false);
  assertEquals(context.json.text, PARSE);
  assertEquals((context.json.uses as { name: string }[]).map((u) => u.name).slice(0, 2), [
    "net.port.Port",
    "net.port.ParseError",
  ]);
  const hash = context.json.hash as string;
  const replaced = await call(server, "replace", { name: "net.port.parse", hash, text: PARSE_REORDERED });
  assertEquals(replaced.isError, false);
  const written = replaced.json.written as { name: string; hash: string }[];
  assertEquals(written.map((w) => w.name), ["net.port.parse"]);
  assertEquals((await call(server, "definition", { name: "net.port.parse" })).json.hash, written[0].hash);

  // The old hash is stale: rejected, with the current version to retry on.
  const stale = await call(server, "replace", { name: "net.port.parse", hash, text: PARSE });
  assertEquals(stale.isError, true);
  assertEquals(codesOf(stale), ["E0501"]);
  assertEquals(stale.json.current, [{ name: "net.port.parse", hash: written[0].hash, text: PARSE_REORDERED }]);

  // An unknown name is a result too, with a closest-name fix.
  const unknown = await call(server, "signature", { name: "net.port.pars" });
  assertEquals(unknown.isError, true);
  assertEquals(codesOf(unknown), ["E0502"]);

  // An interface change with a caller outside the transaction (E0506), then
  // both in one submit.
  const caller = `fn app.port
  doc: "The default port."
  in: none
  out: Result<net.port.Port, net.port.ParseError>
  effects: none
  requires: none
  ensures: none
  examples:
    port() == Ok(net.port.Port(value: 8080))
  body:
    return net.port.parse(text: "8080")
end fn app.port`;
  const callerHash = ((await call(server, "add", { text: caller })).json.written as { hash: string }[])[0].hash;
  const renamedParam = PARSE_REORDERED.replaceAll("text: ", "source: ")
    .replace("std.int.parse(source: text)", "std.int.parse(text: source)");
  const alone = await call(server, "replace", { name: "net.port.parse", hash: written[0].hash, text: renamedParam });
  assertEquals(codesOf(alone), ["E0506"]);
  assert_((alone.json.diagnostics as { message: string }[])[0].message.includes("app.port"));
  const together = await call(server, "submit", {
    changes: [
      { op: "replace", name: "net.port.parse", hash: written[0].hash, text: renamedParam },
      { op: "replace", name: "app.port", hash: callerHash, text: caller.replace("parse(text:", "parse(source:") },
    ],
  });
  assertEquals(together.isError, false, JSON.stringify(together.json));
  assertEquals((await call(server, "callers", { name: "net.port.parse" })).json.callers, ["app.port"]);

  // Rename with a text, the other queries.
  const before = (await call(server, "definition", { name: "app.port" })).json.hash;
  const renamed = await call(server, "rename", {
    name: "app.port",
    hash: before,
    to: "app.default_port",
    text: caller.replaceAll("app.port", "app.default_port").replace("port() ==", "default_port() ==")
      .replace("parse(text:", "parse(source:").replace("The default port.", "The port used without a config."),
  });
  assertEquals(renamed.isError, false, JSON.stringify(renamed.json));
  assertEquals((await call(server, "list", {})).json.submodules, ["app", "net"]);
  assertEquals(
    ((await call(server, "list", { module: "app" })).json.definitions as { name: string }[]).map((d) => d.name),
    ["app.default_port"],
  );
  const newHash = (renamed.json.written as { name: string; hash: string }[])
    .find((w) => w.name === "app.default_port")!.hash;
  assertEquals((await call(server, "search", { text: "without a config" })).json as unknown, [
    {
      name: "app.default_port",
      hash: newHash,
      kind: "fn",
      signature: "fn app.default_port(): Result<net.port.Port, net.port.ParseError>, effects: none",
      doc: "The port used without a config.",
    },
  ]);
  const byType = (await call(server, "search_type", { pattern: "-> Result<Port, _>" })).json as unknown as {
    name: string;
  }[];
  assertEquals(byType.map((h) => h.name), ["app.default_port"]);
  assertEquals(
    ((await call(server, "history", { name: "app.default_port" })).json.entries as { operation: string }[])
      .map((e) => e.operation),
    ["add", "replace", "rename"],
  );
  const removed = await call(server, "remove", { name: "app.default_port", hash: newHash });
  assertEquals(removed.isError, false);
  await done(cb);
});

Deno.test("mcp: arguments that do not fit are tool errors the model can read", async () => {
  const cb = await fresh();
  const server = new McpServer(cb);
  const errorOf = async (name: string, args: unknown) => {
    const c = await call(server, name, args);
    assertEquals(c.isError, true);
    return c.json.error as string;
  };
  // A misnamed argument would otherwise silently list the top level.
  assertEquals(await errorOf("list", { name: "net" }), "`list` has no argument `name`; its arguments are `module`.");
  assertEquals(await errorOf("replace", { name: "a.b", hash: "x" }), "`replace` needs the argument `text`.");
  assertEquals(await errorOf("definition", { name: 3 }), "The argument `name` of `definition` is a string.");
  assertEquals(await errorOf("definition", "a.b"), "The arguments of `definition` are an object.");
  assert_((await errorOf("submit", { changes: [{ op: "replace", name: "a.b" }] })).startsWith("submit: change 0"));
  assertEquals(await errorOf("submit", { changes: "add" }), "submit takes a JSON array of changes.");
  // Missing arguments count as none.
  assertEquals((await result(server, "tools/call", { name: "list" })).isError, false);
  await done(cb);
});

Deno.test("mcp: every query sees the export as it is now", async () => {
  const cb = await withPort();
  const server = new McpServer(cb);
  const file = join(cb.dir, "export", "net.port.alang");

  // As after a pull while the server runs.
  await Deno.writeTextFile(file, `${PARSE_ERROR}\n\n${PORT}\n\n${PARSE_REORDERED}\n`);
  assertEquals((await call(server, "definition", { name: "net.port.parse" })).json.text, PARSE_REORDERED);

  // A file that does not parse: the answer comes from the database, and a
  // second block says why.
  await Deno.writeTextFile(file, "<<<<<<< HEAD\n");
  const stale = await call(server, "definition", { name: "net.port.parse" });
  assertEquals([stale.isError, stale.json.text], [false, PARSE_REORDERED]);
  assertEquals(stale.blocks.length, 2);
  assert_((stale.blocks[1].warning as string).includes("from the database"));
  assert_(JSON.stringify(stale.blocks[1].diagnostics).includes("net.port.alang"));
  // A submit refuses to work on it.
  const refused = await call(server, "add", { text: PORT.replaceAll("net.port.Port", "net.port.Other") });
  assertEquals(refused.isError, true);
  await Deno.writeTextFile(file, `${PARSE_ERROR}\n\n${PORT}\n\n${PARSE_REORDERED}\n`);
  await done(cb);
});

// The tasks round (2026-11-14): the user moved alang.db to the Trash while
// the server ran; queries answered from the moved file, every write failed.
Deno.test("mcp: an alang.db moved or deleted while the server runs is opened again from the export", async () => {
  const cb = await withPort();
  const server = new McpServer(cb);
  const db = join(cb.dir, "alang.db");
  const double = fn("demo.double", {
    params: ["n: Int"],
    out: "Int",
    examples: ["double(n: 2) == 4"],
    body: "return n * 2",
  });

  // Moved: the next call opens a new alang.db, filled from the export as on
  // a fresh start, and the submit is written there.
  await Deno.rename(db, `${db}.moved`);
  const added = await call(server, "add", { text: double });
  assertEquals(added.isError, false, JSON.stringify(added.json));
  assertEquals(((await call(server, "list", { module: "net.port" })).json.definitions as unknown[]).length, 3);
  assertEquals(await Deno.readTextFile(join(cb.dir, "export", "demo.alang")), `${double}\n`);
  assert_((await Deno.stat(db)).isFile);

  // Deleted: a query answers from the export.
  await Deno.remove(db);
  const parse = await call(server, "definition", { name: "net.port.parse" });
  assertEquals([parse.isError, parse.json.text], [false, PARSE]);
  assertEquals((await call(server, "definition", { name: "demo.double" })).json.text, double);
  await done(cb);
});

Deno.test("mcp: a database file moved during a submit is a diagnostic, not an internal error", async () => {
  const dir = await Deno.makeTempDir({ prefix: "alang-db-" });
  let moveTo: string | null = null;
  const cb = await Codebase.open(dir, {
    clock: CLOCK,
    during: async (stage) => {
      if (stage !== "accepted" || moveTo === null) return;
      await Deno.rename(join(dir, "alang.db"), moveTo);
      moveTo = null;
    },
  });
  const server = new McpServer(cb);
  // After the check before the call: the write itself fails.
  moveTo = join(dir, "alang.db.moved");
  const refused = await call(server, "add", { text: PORT });
  assertEquals([refused.isError, refused.json.ok, codesOf(refused), refused.json.current], [
    true,
    false,
    ["E0514"],
    [],
  ]);
  const message = (refused.json.diagnostics as { message: string }[])[0].message;
  assert_(message.includes("was moved or deleted while the server ran"), message);
  // The next call opens the file again, and the change goes through.
  assertEquals((await call(server, "add", { text: PORT })).isError, false);
  // A file that cannot be written for another reason is not reported as moved.
  assertEquals(cb.movedDiagnostic(new Error("attempt to write a readonly database")), null);
  await done(cb);
});

Deno.test("mcp: calls sent together are answered in the order sent", async () => {
  const cb = await fresh();
  const server = new McpServer(cb);
  const [added, listed] = await Promise.all([
    call(server, "submit", { changes: [PORT, PARSE_ERROR, PARSE].map((text) => ({ op: "add", text })) }),
    call(server, "list", { module: "net.port" }),
  ]);
  assertEquals(added.isError, false);
  assertEquals((listed.json.definitions as unknown[]).length, 3);
  await done(cb);
});

// ---- stdio ----

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

async function withProcess(cb: Codebase, lines: string[]): Promise<{ code: number; out: string[]; err: string }> {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", "--allow-write", CLI, "mcp", "--dir", cb.dir],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  const encoder = new TextEncoder();
  for (const line of lines) await writer.write(encoder.encode(line));
  await writer.close();
  const out = await child.output();
  const stdout = new TextDecoder().decode(out.stdout);
  return {
    code: out.code,
    out: stdout.split("\n").filter((l) => l !== ""),
    err: new TextDecoder().decode(out.stderr),
  };
}

Deno.test("mcp: over stdio, one message per line", async () => {
  const cb = await withPort();
  cb.close(); // The server process opens it.
  const msg = (id: number, method: string, params: unknown) => JSON.stringify({ jsonrpc: "2.0", id, method, params });
  const call2 = msg(2, "tools/call", { name: "context", arguments: { name: "net.port.parse" } });
  const { code, out, err } = await withProcess(cb, [
    msg(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } }) +
    "\n",
    '{"jsonrpc":"2.0","method":"notifications/initialized"}\n',
    "not json\n",
    // One message in two writes, the second with a Windows line end.
    call2.slice(0, 40),
    call2.slice(40) + "\r\n",
    "\n",
    // A batch: a request and a notification.
    `[${msg(3, "ping", {})},{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":9}}]\n`,
    // An accepted change runs the examples in the server process.
    msg(4, "tools/call", {
      name: "replace",
      arguments: { name: "net.port.parse", hash: hashText(PARSE), text: PARSE_REORDERED },
    }) + "\n",
    msg(5, "tools/call", { name: "replace", arguments: { name: "net.port.parse", hash: "0000", text: PARSE } }),
  ]);
  assertEquals(code, 0, err);
  // Every line on stdout is a message.
  const messages = out.map((l) => JSON.parse(l) as Response | Response[]);
  assertEquals(messages.length, 6);
  const batch = messages.find((m) => Array.isArray(m)) as Response[];
  assertEquals(batch, [{ jsonrpc: "2.0", id: 3, result: {} }]);
  const byId = new Map(messages.filter((m) => !Array.isArray(m)).map((m) => [(m as Response).id, m as Response]));
  assertEquals(byId.get(null)?.error?.code, -32700);
  assertEquals((byId.get(1)?.result as { protocolVersion: string }).protocolVersion, "2025-11-25");
  const context = byId.get(2)?.result as { content: { text: string }[]; isError: boolean };
  assertEquals([context.isError, JSON.parse(context.content[0].text).text], [false, PARSE]);
  const replaced = byId.get(4)?.result as { content: { text: string }[]; isError: boolean };
  assertEquals(replaced.isError, false, replaced.content[0].text);
  assertEquals(JSON.parse(replaced.content[0].text).written[0].hash, hashText(PARSE_REORDERED));
  assertEquals(
    await Deno.readTextFile(join(cb.dir, "export", "net.port.alang")),
    `${PARSE_ERROR}\n\n${PORT}\n\n${PARSE_REORDERED}\n`,
  );
  const stale = byId.get(5)?.result as { content: { text: string }[]; isError: boolean };
  assertEquals([stale.isError, JSON.parse(stale.content[0].text).diagnostics[0].code], [true, "E0501"]);

  // Usage errors.
  const usage = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", "--allow-write", CLI, "mcp", "--port", "1"],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals([usage.code, usage.stdout.length], [2, 0]);
  await Deno.remove(cb.dir, { recursive: true });
});

Deno.test("mcp: a signal ends the server, and no acceptance file stays behind", async () => {
  const cb = await withPort();
  cb.close(); // The server process opens it.
  const accepts = () => [...Deno.readDirSync(join(cb.dir, "out"))].filter((e) => e.name.startsWith("accept-"));
  for (const [i, signal] of (["SIGTERM", "SIGINT", "SIGHUP"] as const).entries()) {
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "--allow-read", "--allow-write", CLI, "mcp", "--dir", cb.dir],
      stdin: "piped",
      stdout: "piped",
      stderr: "null",
    }).spawn();
    const writer = child.stdin.getWriter();
    const text = `fn m.f${i}\n  doc: "One."\n  in: none\n  out: Int\n  effects: none\n  requires: none\n` +
      `  ensures: none\n  examples:\n    f${i}() == 1\n  body:\n    return 1\nend fn m.f${i}`;
    const add = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "add", arguments: { text } } };
    await writer.write(new TextEncoder().encode(JSON.stringify(add) + "\n"));
    const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
    let answer = "";
    while (!answer.includes("\n")) answer += (await reader.read()).value ?? "";
    assertEquals(JSON.parse(answer).result.isError, false, answer);
    // The file exists only while an acceptance runs, so even SIGKILL leaves none.
    assertEquals(accepts(), []);
    // Clients may end a server with a signal instead of closing its stdin.
    child.kill(signal);
    assertEquals((await child.status).code, 0, signal);
    await reader.cancel();
    await writer.close().catch(() => {});
    assertEquals(accepts(), []);
  }
  await Deno.remove(cb.dir, { recursive: true });
});

// The instructions send the model to the card; clients cut long ones, so
// they stay short and name the card first.
Deno.test("mcp: the instructions name the card first, then the spec, in both eras", async () => {
  const cb = await fresh();
  const server = new McpServer(cb);
  const spec = fileURLToPath(new URL("../alang-specs.md", import.meta.url));
  const legacy = (await result(server, "initialize", { protocolVersion: "2025-11-25" })).instructions as string;
  const modernEra = (await result(server, "server/discover", modern())).instructions as string;
  for (const instructions of [legacy, modernEra]) {
    assert_(instructions.startsWith("Before writing alang, call `card`"), instructions.slice(0, 80));
    assert_(instructions.includes(`The full design and reference is ${spec};`));
    assert_(!instructions.includes("read it before writing alang"));
    // Claude Code cuts at 4,096 characters (before v2.1.296 at 2,048); install
    // paths vary in length, so the rest keeps a margin.
    assert_(instructions.length - spec.length < 3_000, `${instructions.length} characters`);
    // The rest of the instructions follows unchanged.
    for (const kept of ["context(name)", "E0501", "E0506", "E0513"]) assert_(instructions.includes(kept), kept);
    // Hits carry the signature, so std needs no context call per function.
    assert_(instructions.includes("comes with its signature (parameters, result, effects) and doc"));
  }
  await done(cb);
});

Deno.test("mcp: card answers with the card itself, as Markdown", async () => {
  const cb = await fresh();
  const server = new McpServer(cb);
  const tool = (await result(server, "tools/list", {})).tools as { name: string; annotations: unknown }[];
  assertEquals(tool.find((t) => t.name === "card")!.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  const answered = await result(server, "tools/call", { name: "card", arguments: {} });
  assertEquals(answered, { content: [{ type: "text", text: CARD }], isError: false });
  // Without arguments at all, too; an argument it does not take is refused.
  assertEquals((await result(server, "tools/call", { name: "card" })).content, answered.content);
  const extra = await call(server, "card", { topic: "match" });
  assertEquals([extra.isError, typeof extra.json.error], [true, "string"]);
  await done(cb);
});

// The tool table and its list stay in step.
Deno.test("mcp: each tool has a title, a description and described arguments", () => {
  for (const t of TOOLS) {
    assert_(t.title !== "" && t.description.endsWith("."), t.name);
    for (const [key, p] of Object.entries(t.params)) assert_(p.description.endsWith("."), `${t.name}.${key}`);
  }
});
