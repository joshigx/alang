// The MCP server: the queries and operations of section 6 as tools, so that
// an LLM changes alang code the way the spec intends (Storage, "The path of a
// change"): read with `context`, write with `replace`. A thin layer over
// `Codebase`, like `alang db` (db_cli.ts).
//
//   alang mcp [--dir <dir>]      (default dir: the current one)
//
// Transport: stdio, one JSON-RPC 2.0 message per line; nothing else is
// written to stdout. Two eras of MCP are served: the `initialize` handshake
// (2024-11-05 to 2025-11-25) and the stateless requests of 2026-07-28, which
// carry their version in `_meta` and find the server by `server/discover`.
// Only tools are offered. The language itself is served by the tool `card`
// (card.ts), to which the instructions send the model first.
//
// Every query first brings the database in step with the export
// (`Codebase.sync`): a long-running server would otherwise answer from a
// database that a pull has left behind. Submits sync by themselves. Tool
// calls run one at a time. Diagnostics and rejected transactions are tool
// results with `isError`, so the model sees them and can correct itself;
// JSON-RPC errors are left for malformed requests and unknown tools.

import { fileURLToPath } from "node:url";
import { CARD } from "./card.ts";
import { Codebase, parseChanges, type SubmitResult } from "./codebase.ts";
import { AlangError } from "./diagnostic.ts";

// ---- protocol ----

// Versions with per-request metadata, newest first.
export const MODERN_VERSIONS = ["2026-07-28"];
// Versions with the `initialize` handshake, newest first.
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";
const SERVER_INFO = { name: "alang", version: "0.1.0" };
// How long a client may cache the tool list: it changes only with the server.
const TTL_MS = 3_600_000;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const UNSUPPORTED_VERSION = -32022;

type Id = string | number | null;

export interface Response {
  readonly jsonrpc: "2.0";
  readonly id: Id;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}

function failure(id: Id, code: number, message: string, data?: unknown): Response {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---- tools ----

// The full design and reference next to the sources, for a model that can
// read files; demoted behind the card. Installed elsewhere (not from files),
// the instructions go without it.
const SPEC = new URL("../alang-specs.md", import.meta.url);
const SPEC_LINE = SPEC.protocol === "file:"
  ? ` The full design and reference is ${fileURLToPath(SPEC)}; you need it only for questions the card and the \
tools do not answer.`
  : "";

// Clients cut long instructions (Claude Code at 4,096 characters, before
// v2.1.296 at 2,048), so the card is a tool and the instructions name it
// first; tests/mcp_test.ts keeps them short.
export const INSTRUCTIONS = `Before writing alang, call \`card\`, and again when its text is no longer in your \
context: the rules every definition needs and a complete accepted program. The standard library is not on it; find it with \`list("std")\`, \`search\`, \
\`search_type\` and \`context\`.${SPEC_LINE}

An alang codebase, stored as a database of definitions (spec section 6). \
Read and change definitions only through these tools, never by editing files. export/*.alang is the database's \
copy for Git, one file per module, kept in step in both directions without your help: every change is written there \
at once, and what Git or a person changes there is read back before the next tool call. You never export or import \
anything yourself. \
out/ is generated. So the codebase can change between your calls (a pull, a checkout, the user's own \
edit): answer questions about its current state from a fresh query, not from earlier results.

1. Find: \`list\` (modules; \`std\` is the standard library), \`search\` (names and doc lines), \`search_type\` \
(signatures such as \`String -> Result<Int, _>\`). std is included in all three.
2. Read: \`context(name)\` gives the canonical text, its hash, and the signatures of everything it uses: all you \
need to change it. It reads std names too (hash null): \`context(std.http.serve)\` gives the signature and the \
fields of the types it takes and returns. std cannot be changed.
3. Change: \`replace(name, hash, text)\` with the complete new definition and the hash the query returned. Hashes \
are guards; never write one into code. A change is parsed, type- and effect-checked, and every example of the \
program is run (each pure function needs at least one); it is written, in canonical form, only if all of that passes. \
Names of the definition's own module are written short (\`parse\` inside \`net.port\`), all others in full \
(\`std.int.parse\`).
4. Results: \`ok: true\` lists each written name with its new hash, which the next change can use without another \
query; \`fixed\`, if present, lists own-module names you wrote in full, which were stored short. \`ok: false\` \
means nothing was written; it lists \`diagnostics\` (code, definition, section, at: the quoted location, message, \
expected, fix) and \`current\` versions. E0501 (stale hash): redo the change on the version in \
\`current\`. E0506 (interface changed): send the change together with the callers it names, adapted, in one \`submit\`.
5. E0513 (an export file and the database both changed): stop and tell the user. Do not run \`alang db import\` or \
\`alang db export --force\` yourself; which side wins is the user's call.`;

interface Param {
  readonly description: string;
  readonly optional?: boolean;
  // JSON Schema of the value; a string if not given.
  readonly schema?: Readonly<Record<string, unknown>>;
}

interface Tool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly params: Readonly<Record<string, Param>>;
  // Queries only read: they sync first, and are marked read-only.
  readonly query: boolean;
  // Answers with Markdown that does not depend on the codebase: no sync, and
  // the text as it is rather than as JSON.
  readonly plain?: boolean;
  readonly run: (cb: Codebase, args: Readonly<Record<string, unknown>>) => unknown;
}

const NAME: Param = { description: "The full name of a definition, such as `net.port.parse`." };
const HASH: Param = { description: "The hash a query or change returned for the version you read (the guard)." };
const TEXT: Param = { description: "The complete text of one definition, from its first line to its `end` line." };

const s = (value: unknown): string => value as string;

// Arguments that fit the schema but not the tool's own reading of them.
class InvalidInput extends Error {}

function input<T>(read: () => T): T {
  try {
    return read();
  } catch (e) {
    throw new InvalidInput(e instanceof Error ? e.message : String(e));
  }
}

export const TOOLS: readonly Tool[] = [
  {
    name: "card",
    title: "The language card",
    description: "The rules every alang definition needs and a complete accepted program, as Markdown: call it " +
      "before writing alang, and again when its text is no longer in your context. The standard library is not on it; find it with `list`, `search`, " +
      "`search_type` and `context`.",
    params: {},
    query: true,
    plain: true,
    run: () => CARD,
  },
  {
    name: "context",
    title: "Definition with what it uses",
    description: "The canonical text of a definition and its hash, followed by the signatures of every function " +
      "and type it uses, in order of first use, and of the types in those signatures (std functions as one " +
      "line). Everything needed to change the definition: read this before `replace`. For a std name (hash " +
      "null), its text and the types its signature mentions, such as the fields of `std.http.Request`.",
    params: { name: NAME },
    query: true,
    run: (cb, a) => cb.context(s(a.name)),
  },
  {
    name: "definition",
    title: "Definition text",
    description: "The complete canonical text of a definition, with its hash. For a std name (hash null), a " +
      "type's text or a function's signature on one line, since std functions have no alang body.",
    params: { name: NAME },
    query: true,
    run: (cb, a) => cb.definition(s(a.name)),
  },
  {
    name: "signature",
    title: "Signature",
    description: "Every section of a definition except `body` (for a type, its whole text), with its hash. For " +
      "a std name (hash null), the same as `definition`.",
    params: { name: NAME },
    query: true,
    run: (cb, a) => cb.signature(s(a.name)),
  },
  {
    name: "callers",
    title: "Callers",
    description: "The definitions that use `name` (for a variant type, also those that use its cases), sorted, " +
      "with the hash of `name`. These are the definitions an interface change or a removal affects.",
    params: { name: NAME },
    query: true,
    run: (cb, a) => cb.callers(s(a.name)),
  },
  {
    name: "list",
    title: "List a module",
    description: "The definitions of a module (name, hash, kind, doc) and the names of its direct submodules. " +
      "Without `module`, the top-level modules of the codebase; `std` and its submodules (`std.http`) list the " +
      "standard library.",
    params: { module: { description: "A module such as `net.port`; leave it out for the top level.", optional: true } },
    query: true,
    run: (cb, a) => cb.list(a.module === undefined ? "" : s(a.module)),
  },
  {
    name: "search",
    title: "Search names and docs",
    description: "Definitions and std entries whose full name or `doc` line contains `text`, ignoring case, " +
      "sorted by name.",
    params: { text: { description: "The text to look for." } },
    query: true,
    run: (cb, a) => cb.searchText(s(a.text)),
  },
  {
    name: "search_type",
    title: "Search by signature",
    description: "Functions, std included, whose signature matches a type pattern, sorted by name, each with its " +
      "signature on one line. The pattern lists parameter types by position, then `->` and the result type: " +
      "`String -> Result<Int, _>`, `Int, Int -> Bool`, `-> Unit` for no parameters. `_` matches any type; a " +
      "one-segment name such as `Port` matches by its last segment, a qualified one exactly.",
    params: { pattern: { description: "A type pattern such as `String -> Result<Int, _>`." } },
    query: true,
    run: (cb, a) => cb.searchType(s(a.pattern)),
  },
  {
    name: "history",
    title: "History",
    description: "Every version a name had, oldest first, with time and operation (a removal has hash null), and " +
      "the current hash (null if removed). A name that came from a rename continues with the old name's history. " +
      "std names have none.",
    params: { name: NAME },
    query: true,
    run: (cb, a) => cb.history(s(a.name)),
  },
  {
    name: "add",
    title: "Add a definition",
    description: "Adds one new definition. Rejected if the name exists (E0503, with that version in `current`).",
    params: { text: TEXT },
    query: false,
    run: (cb, a) => cb.submit([{ op: "add", text: s(a.text) }]),
  },
  {
    name: "replace",
    title: "Replace a definition",
    description: "Replaces the version of `name` that has `hash` by `text`, the complete new definition under " +
      "the same name. A stale hash is rejected (E0501) with the current version in `current`. If the interface " +
      "changes (anything but `doc`, `examples` and `body`) while callers exist, the change is rejected (E0506) " +
      "naming them: send them, adapted or unchanged, in one `submit` with this change.",
    params: { name: NAME, hash: HASH, text: TEXT },
    query: false,
    run: (cb, a) => cb.submit([{ op: "replace", name: s(a.name), hash: s(a.hash), text: s(a.text) }]),
  },
  {
    name: "remove",
    title: "Remove a definition",
    description: "Removes a definition. Rejected while callers exist (E0507): change or remove them in the same " +
      "`submit`. History keeps every version.",
    params: { name: NAME, hash: HASH },
    query: false,
    run: (cb, a) => cb.submit([{ op: "remove", name: s(a.name), hash: s(a.hash) }]),
  },
  {
    name: "rename",
    title: "Rename a definition",
    description: "Renames a definition and rewrites every definition that refers to it. With `text`, the " +
      "definition is changed in the same transaction: `text` is its complete new version under the new name.",
    params: {
      name: NAME,
      hash: HASH,
      to: { description: "The new full name." },
      text: { description: "The changed definition under the new name (optional).", optional: true },
    },
    query: false,
    run: (cb, a) =>
      cb.submit([{
        op: "rename",
        name: s(a.name),
        hash: s(a.hash),
        to: s(a.to),
        ...(a.text === undefined ? {} : { text: s(a.text) }),
      }]),
  },
  {
    name: "submit",
    title: "Submit a transaction",
    description: "Several changes as one transaction: all are written, or none. Use it for an interface change " +
      "together with its callers, or for new definitions that use each other. Each change is " +
      '`{"op": "add", "text"}`, `{"op": "replace", "name", "hash", "text"}`, `{"op": "remove", "name", "hash"}` ' +
      'or `{"op": "rename", "name", "hash", "to"}`, the last optionally with "text".',
    params: {
      changes: {
        description: "The changes, in any order.",
        schema: {
          type: "array",
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["add", "replace", "remove", "rename"] },
              name: { type: "string" },
              hash: { type: "string" },
              to: { type: "string" },
              text: { type: "string" },
            },
            required: ["op"],
            additionalProperties: false,
          },
        },
      },
    },
    query: false,
    run: (cb, a) => cb.submit(input(() => parseChanges(a.changes))),
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

function describe(tool: Tool): Record<string, unknown> {
  const params = Object.entries(tool.params);
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(
        params.map(([key, p]) => [key, { ...(p.schema ?? { type: "string" }), description: p.description }]),
      ),
      required: params.filter(([, p]) => !p.optional).map(([key]) => key),
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: tool.query,
      destructiveHint: !tool.query && tool.name !== "add",
      idempotentHint: tool.query,
      openWorldHint: false,
    },
  };
}

const quoted = (names: Iterable<string>): string => [...names].map((n) => `\`${n}\``).join(", ");

// A message for arguments that do not fit the tool; null if they do. The
// changes of `submit` are checked by `parseChanges`.
function invalidArguments(tool: Tool, args: unknown): string | null {
  if (!isObject(args)) return `The arguments of \`${tool.name}\` are an object.`;
  const unknown = Object.keys(args).filter((key) => !Object.hasOwn(tool.params, key));
  if (unknown.length > 0) {
    const known = quoted(Object.keys(tool.params));
    return `\`${tool.name}\` has no argument ${quoted(unknown)}; its arguments are ${known}.`;
  }
  for (const [key, p] of Object.entries(tool.params)) {
    if (args[key] === undefined) {
      if (!p.optional) return `\`${tool.name}\` needs the argument \`${key}\`.`;
    } else if (!p.schema && typeof args[key] !== "string") {
      return `The argument \`${key}\` of \`${tool.name}\` is a string.`;
    }
  }
  return null;
}

interface CallResult {
  readonly content: { readonly type: "text"; readonly text: string }[];
  readonly isError: boolean;
}

const json = (value: unknown) => ({ type: "text" as const, text: JSON.stringify(value, null, 2) });

function isSubmitResult(value: unknown): value is SubmitResult {
  return isObject(value) && typeof value.ok === "boolean";
}

// Runs a tool. The answer is one JSON text, as `alang db` prints it; a query
// whose sync failed adds a second one with the sync's diagnostics. A plain
// tool (`card`) answers with its text as it is.
async function callTool(cb: Codebase, tool: Tool, args: unknown): Promise<CallResult> {
  const invalid = invalidArguments(tool, args ?? {});
  if (invalid) return { content: [json({ error: invalid })], isError: true };
  if (tool.plain) return { content: [{ type: "text", text: tool.run(cb, {}) as string }], isError: false };
  const warning = [];
  try {
    if (tool.query) {
      const synced = await cb.sync();
      if (!synced.ok) {
        warning.push(json({
          warning: "The database could not be brought in step with the export; this answer is from the database.",
          diagnostics: synced.diagnostics,
        }));
      }
    }
    const value = await tool.run(cb, (args ?? {}) as Record<string, unknown>);
    return { content: [json(value), ...warning], isError: isSubmitResult(value) && !value.ok };
  } catch (e) {
    if (e instanceof AlangError) return { content: [json({ diagnostics: e.diagnostics }), ...warning], isError: true };
    if (e instanceof InvalidInput) return { content: [json({ error: e.message })], isError: true };
    if (!(e instanceof Error)) throw e;
    // A fault of the tool: the model learns that it failed, the log why.
    console.error(e);
    return { content: [json({ error: `internal error: ${e.message}` }), ...warning], isError: true };
  }
}

// ---- server ----

// Answers MCP messages for one codebase. Independent of the transport, so
// the tests talk to it directly.
export class McpServer {
  // Tool calls run one at a time; other requests are answered at once.
  private calls: Promise<unknown> = Promise.resolve();

  constructor(private readonly cb: Codebase) {}

  // The response to one parsed message; null for a notification or a
  // response (this server sends no requests). Never throws.
  async handle(message: unknown): Promise<Response | null> {
    if (!isObject(message) || message.jsonrpc !== "2.0") {
      return failure(null, INVALID_REQUEST, "Not a JSON-RPC 2.0 message.");
    }
    const id = message.id;
    const hasId = typeof id === "string" || typeof id === "number";
    if (typeof message.method !== "string") {
      if (hasId && ("result" in message || "error" in message)) return null;
      return failure(hasId ? id : null, INVALID_REQUEST, "A request has a method.");
    }
    if (!("id" in message)) return null;
    if (!hasId) return failure(null, INVALID_REQUEST, "A request id is a string or a number.");
    if (message.params !== undefined && !isObject(message.params)) {
      return failure(id, INVALID_PARAMS, "The params of a request are an object.");
    }
    try {
      return { jsonrpc: "2.0", id, result: await this.request(message.method, message.params ?? {}) };
    } catch (e) {
      if (e instanceof RpcError) return failure(id, e.code, e.message, e.data);
      console.error(e);
      return failure(id, INTERNAL_ERROR, e instanceof Error ? e.message : String(e));
    }
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    // A request that names its version in `_meta` is of the modern era.
    const meta = params._meta;
    const requested = isObject(meta) ? meta[VERSION_KEY] : undefined;
    const modern = requested !== undefined;
    if (modern && !MODERN_VERSIONS.includes(requested as string)) {
      throw new RpcError(UNSUPPORTED_VERSION, "Unsupported protocol version", {
        supported: MODERN_VERSIONS,
        requested,
      });
    }
    const complete = (result: Record<string, unknown>) =>
      modern ? { resultType: "complete", ...result, _meta: { [SERVER_INFO_KEY]: SERVER_INFO } } : result;

    switch (method) {
      case "initialize": {
        const asked = params.protocolVersion;
        return {
          protocolVersion: LEGACY_VERSIONS.includes(asked as string) ? asked : LEGACY_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        };
      }
      case "server/discover":
        return {
          resultType: "complete",
          supportedVersions: MODERN_VERSIONS,
          capabilities: { tools: {} },
          instructions: INSTRUCTIONS,
          ttlMs: TTL_MS,
          cacheScope: "public",
          _meta: { [SERVER_INFO_KEY]: SERVER_INFO },
        };
      case "ping":
        return complete({});
      case "tools/list": {
        const tools = TOOLS.map(describe);
        return modern ? complete({ tools, ttlMs: TTL_MS, cacheScope: "public" }) : { tools };
      }
      case "tools/call": {
        const tool = typeof params.name === "string" ? TOOL_BY_NAME.get(params.name) : undefined;
        if (!tool) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${String(params.name)}`);
        const run = this.calls.then(() => callTool(this.cb, tool, params.arguments));
        this.calls = run.catch(() => {});
        return complete({ ...await run });
      }
      default:
        throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }
}

// ---- stdio ----

// The lines of a byte stream, without their line ends; a last line without
// one counts too.
async function* lines(input: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of input.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      yield buffer.slice(0, end).replace(/\r$/, "");
      buffer = buffer.slice(end + 1);
    }
  }
  if (buffer !== "") yield buffer;
}

// Serves MCP over a pair of streams until the input ends, then waits for the
// answers still being computed. A line may hold a batch, an array of
// messages (2025-03-26 only, but harmless for the others); it gets an array
// of the responses, or nothing if all were notifications.
export async function serve(
  cb: Codebase,
  input: ReadableStream<Uint8Array>,
  output: WritableStream<Uint8Array>,
): Promise<void> {
  const server = new McpServer(cb);
  const writer = output.getWriter();
  const encoder = new TextEncoder();
  let written: Promise<void> = Promise.resolve();
  const send = (response: Response | Response[]) => {
    written = written.then(() => writer.write(encoder.encode(JSON.stringify(response) + "\n")))
      .catch((e) => console.error("alang mcp: could not write a response:", e));
  };
  const pending = new Set<Promise<void>>();
  for await (const line of lines(input)) {
    if (line.trim() === "") continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      send(failure(null, PARSE_ERROR, "Parse error: a message is one line of JSON."));
      continue;
    }
    const answered = Array.isArray(message) && message.length > 0
      ? Promise.all(message.map((m) => server.handle(m))).then((responses) => {
        const answers = responses.filter((r) => r !== null);
        if (answers.length > 0) send(answers);
      })
      : server.handle(message).then((response) => {
        if (response) send(response);
      });
    pending.add(answered);
    answered.finally(() => pending.delete(answered));
  }
  await Promise.all(pending);
  await written;
  writer.releaseLock();
}

export const MCP_USAGE = "usage: alang mcp [--dir <dir>]";

export async function mcpMain(args: string[]): Promise<number> {
  const dir = args.length === 2 && args[0] === "--dir" ? args[1] : args.length === 0 ? "." : null;
  if (!dir) {
    console.error(MCP_USAGE);
    return 2;
  }
  // stdout carries protocol messages only. Anything else printed in this
  // process (say, a generated program calling `std.console.print_line`) goes
  // to stderr.
  console.log = console.info = console.debug = console.error;
  const cb = await Codebase.open(dir);
  // Clients may end the server with a signal instead of closing its stdin.
  // The acceptance file exists only during an acceptance; one in progress is
  // abandoned (nothing is written before it ends), and the process ends.
  const stop = () => {
    cb.close();
    Deno.exit(0);
  };
  const signals: Deno.Signal[] = [];
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    try {
      Deno.addSignalListener(signal, stop);
      signals.push(signal);
    } catch {
      // Only SIGINT (and SIGBREAK) can be listened to on Windows.
    }
  }
  try {
    await serve(cb, Deno.stdin.readable, Deno.stdout.writable);
  } finally {
    for (const signal of signals) Deno.removeSignalListener(signal, stop);
    cb.close();
  }
  return 0;
}
