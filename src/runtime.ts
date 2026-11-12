// The one runtime library shared by the checker and by generated programs.
// It must stay runtime-neutral: no Deno.*, no Node APIs, so generated code
// runs on Deno, Node.js and Bun alike.

// ---- built-in types ----

export type Unit = null;
export const Unit: Unit = null;

export type Some<T> = { readonly tag: "Some"; readonly value: T };
export type None = { readonly tag: "None" };
export type Option<T> = Some<T> | None;
export type Ok<T> = { readonly tag: "Ok"; readonly value: T };
export type Err<E> = { readonly tag: "Err"; readonly value: E };
export type Result<T, E> = Ok<T> | Err<E>;
export type Order = { readonly tag: "Less" } | { readonly tag: "Equal" } | { readonly tag: "Greater" };

export function Some<T>(value: T): Some<T> {
  return { tag: "Some", value };
}
export const None: None = { tag: "None" };
export function Ok<T>(value: T): Ok<T> {
  return { tag: "Ok", value };
}
export function Err<E>(value: E): Err<E> {
  return { tag: "Err", value };
}
export const Less = { tag: "Less" } as const;
export const Equal = { tag: "Equal" } as const;
export const Greater = { tag: "Greater" } as const;

// ---- traps ----

// A trap ends the program with a diagnostic and cannot be caught by alang code.
// (No parameter properties: the file must run under plain type stripping, as
// Node.js does it.)
export class Trap extends Error {
  readonly kind: string;
  readonly definition: string | null;
  readonly at: string;
  constructor(kind: string, definition: string | null, at: string, message: string) {
    super(message);
    this.name = "Trap";
    this.kind = kind;
    this.definition = definition;
    this.at = at;
  }
}

export function trap(kind: string, definition: string | null, at: string, message: string): never {
  throw new Trap(kind, definition, at, message);
}

// ---- let ... else (rule 3.2) ----

export function isPresent<T>(r: Result<T, unknown> | Option<T>): r is Ok<T> | Some<T> {
  return r.tag === "Ok" || r.tag === "Some";
}

// ---- equality and order (rule 3.9) ----

// Equality of Int, Float, Bool, String and Unit.
export function same<T extends number | string | boolean | null>(a: T, b: T): boolean {
  return a === b;
}

export function eq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => eq(x, b[i]));
  }
  if (a instanceof Map) {
    if (!(b instanceof Map) || a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (!b.has(k) || !eq(v, b.get(k))) return false;
    }
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    Object.hasOwn(b, k) && eq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
  );
}

// Strings order by Unicode scalar values, not by UTF-16 code units. Int and
// Float compare with the native operators in generated code.
export function str_compare(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done || y.done) return x.done && y.done ? 0 : x.done ? -1 : 1;
    const cx = x.value.codePointAt(0)!;
    const cy = y.value.codePointAt(0)!;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

export const str_lt = (a: string, b: string): boolean => str_compare(a, b) < 0;
export const str_le = (a: string, b: string): boolean => str_compare(a, b) <= 0;
export const str_gt = (a: string, b: string): boolean => str_compare(a, b) > 0;
export const str_ge = (a: string, b: string): boolean => str_compare(a, b) >= 0;

function toOrder(n: number): Order {
  return n < 0 ? Less : n > 0 ? Greater : Equal;
}

// ---- Int ----
// Integers from -(2^53 - 1) to 2^53 - 1; leaving the range traps.

function int(op: string, a: number, b: number, r: number): number {
  if (!Number.isSafeInteger(r)) trap("overflow", null, `${a} ${op} ${b}`, "Int overflow.");
  return r;
}

export const int_add = (a: number, b: number): number => int("+", a, b, a + b);
export const int_sub = (a: number, b: number): number => int("-", a, b, a - b);
export const int_mul = (a: number, b: number): number => int("*", a, b, a * b);

// Rounds toward zero.
export function int_div(a: number, b: number): number {
  if (b === 0) trap("division", null, `${a} / ${b}`, "Int division by zero.");
  return int("/", a, b, Math.trunc(a / b));
}

// Has the sign of the dividend: -7 % 2 == -1.
export function int_rem(a: number, b: number): number {
  if (b === 0) trap("division", null, `${a} % ${b}`, "Int remainder by zero.");
  return int("%", a, b, a % b);
}

// ---- Float ----
// IEEE 754 doubles without NaN: a NaN result traps. Infinities are values.

function float(op: string, a: number, b: number, r: number): number {
  if (Number.isNaN(r)) trap("nan", null, `${a} ${op} ${b}`, "Float operation produced NaN.");
  return r;
}

export const float_add = (a: number, b: number): number => float("+", a, b, a + b);
export const float_sub = (a: number, b: number): number => float("-", a, b, a - b);
export const float_mul = (a: number, b: number): number => float("*", a, b, a * b);
export const float_div = (a: number, b: number): number => float("/", a, b, a / b);
export const float_rem = (a: number, b: number): number => float("%", a, b, a % b);

// ---- examples ----

// An example `call == expected`, with both sides as separate thunks so that a
// failing example can report the value the call returned.
export interface Example {
  readonly definition: string;
  readonly text: string;
  readonly actual: () => unknown;
  readonly expected: () => unknown;
}

export interface TrapInfo {
  readonly kind: string;
  readonly definition: string | null;
  readonly at: string;
  readonly message: string;
}

export interface ExampleResult {
  readonly definition: string;
  readonly text: string;
  readonly passed: boolean;
  // The value of the call; undefined if the example trapped.
  readonly actual: unknown;
  readonly trap: TrapInfo | null;
}

// Recursion is the only way to repeat (3), so a missing base case ends in a
// stack overflow, which the host reports as a RangeError, not as a trap.
function isStackOverflow(e: unknown): boolean {
  return e instanceof RangeError && /call stack/i.test(e.message);
}

export function runExamples(examples: readonly Example[]): ExampleResult[] {
  return examples.map((ex) => {
    const result = (actual: unknown, passed: boolean, trap: TrapInfo | null): ExampleResult => ({
      definition: ex.definition,
      text: ex.text,
      passed,
      actual,
      trap,
    });
    try {
      const actual = ex.actual();
      return result(actual, eq(actual, ex.expected()), null);
    } catch (e) {
      if (e instanceof Trap) {
        return result(undefined, false, { kind: e.kind, definition: e.definition, at: e.at, message: e.message });
      }
      if (isStackOverflow(e)) {
        const message = "The call stack overflowed; a recursion does not reach its base case, or recurses too deep.";
        return result(undefined, false, { kind: "stack", definition: null, at: ex.text, message });
      }
      throw e;
    }
  });
}

// ---- std ----
// Named std$<module>$<name>, matching the mangled paths the emitter produces.

export function std$console$print_line(text: string): Unit {
  console.log(text);
  return Unit;
}

// Files are one of the two places where the runtime touches the host; the
// network (std.http) is the other. Deno and Node.js (and Bun) are detected by
// their globals; the error codes are shared.
type Host = {
  Deno?: { readTextFileSync(path: string): string };
  process?: { getBuiltinModule(name: string): { readFileSync(path: string, encoding: "utf8"): string } };
};

export type std$fs$ReadError =
  | { readonly tag: "NotFound" }
  | { readonly tag: "PermissionDenied" }
  | { readonly tag: "IsADirectory" }
  | { readonly tag: "Other"; readonly value: string };

export function std$fs$read_text(path: string): Result<string, std$fs$ReadError> {
  const host = globalThis as Host;
  try {
    if (host.Deno) return Ok(host.Deno.readTextFileSync(path));
    if (host.process) return Ok(host.process.getBuiltinModule("node:fs").readFileSync(path, "utf8"));
    return trap("effect", "std.fs.read_text", path, "This runtime has no file system.");
  } catch (e) {
    if (e instanceof Trap) throw e;
    const err = e as { name?: string; code?: string; message?: string };
    // A read the host refused because the program lacks the permission:
    // the program does more than its `main` declares (2.5).
    if (err.name === "NotCapable") {
      return trap("effect", "std.fs.read_text", path, "Reading files needs the effect `fs.read` on `main`.");
    }
    switch (err.code) {
      case "ENOENT":
        return Err<std$fs$ReadError>({ tag: "NotFound" });
      case "EACCES":
      case "EPERM":
        return Err<std$fs$ReadError>({ tag: "PermissionDenied" });
      case "EISDIR":
        return Err<std$fs$ReadError>({ tag: "IsADirectory" });
    }
    return Err<std$fs$ReadError>({ tag: "Other", value: String(err.message ?? e) });
  }
}

// ---- std.http ----

export type std$http$Header = { readonly name: string; readonly value: string };
export function std$http$Header($fields: std$http$Header): std$http$Header {
  return $fields;
}

export type std$http$Request = {
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly headers: readonly std$http$Header[];
  readonly content: string;
};
export function std$http$Request($fields: std$http$Request): std$http$Request {
  return $fields;
}

export type std$http$Response = {
  readonly status: number;
  readonly headers: readonly std$http$Header[];
  readonly content: string;
};

// The `where` of std.http.Response in std.ts, as printed (a test compares them).
const RESPONSE_WHERE =
  '200 <= status and status <= 599 and (content == "" or (status != 204 and status != 205 and status != 304))';

function noContent(status: number): boolean {
  return status === 204 || status === 205 || status === 304;
}

export function std$http$Response($fields: std$http$Response): std$http$Response {
  const { status, content } = $fields;
  if (!(200 <= status && status <= 599 && (content === "" || !noContent(status)))) {
    trap("where", "std.http.Response", RESPONSE_WHERE, `Invariant of std.http.Response violated: ${RESPONSE_WHERE}`);
  }
  return $fields;
}

export type std$http$ServeError =
  | { readonly tag: "AddressInUse" }
  | { readonly tag: "PermissionDenied" }
  | { readonly tag: "Other"; readonly value: string };

// A function value with effects is async (see emit.ts), a pure one is not.
type Handler = (request: std$http$Request) => std$http$Response | Promise<std$http$Response>;

// What the host sees of a running server: `close` stops accepting requests,
// `closed` settles once the requests in progress are answered.
interface Listener {
  close(): void;
  readonly closed: Promise<void>;
}

// The alang response for a request; null if the handler trapped (the host
// answers 500 then). `fail` ends the server with an error of the host's own.
interface Answering {
  answer(request: std$http$Request): Promise<std$http$Response | null>;
  fail(error: unknown): void;
}

type Listen = (host: string, port: number, a: Answering) => Promise<Listener | std$http$ServeError>;

// Headers as the host sends them. Both hosts reject names that are not HTTP
// tokens and values with line breaks or characters above U+00FF; checking
// here gives one trap on every host instead of two different exceptions. A
// response without content-type gets the same one on every host.
function hostHeaders(response: std$http$Response): [string, string][] {
  const headers: [string, string][] = [];
  for (const { name, value } of response.headers) {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || !/^[\t\x20-\x7e\x80-\xff]*$/.test(value)) {
      trap(
        "http",
        "std.http.serve",
        `${name}: ${value}`,
        "A response header has a name that is not an HTTP token, or a value with a line break or a character above U+00FF.",
      );
    }
    headers.push([name, value]);
  }
  if (!headers.some(([name]) => name.toLowerCase() === "content-type") && response.content !== "") {
    headers.push(["content-type", "text/plain; charset=utf-8"]);
  }
  return headers;
}

function serveError(e: unknown): std$http$ServeError {
  const err = e as { name?: string; code?: string; message?: string };
  // Listening refused for lack of the permission: the program does more
  // than its `main` declares (2.5).
  if (err.name === "NotCapable") {
    return trap("effect", "std.http.serve", String(err.message), "Serving needs the effect `net` on `main`.");
  }
  if (err.code === "EADDRINUSE" || err.name === "AddrInUse") return { tag: "AddressInUse" };
  if (err.code === "EACCES" || err.name === "PermissionDenied") return { tag: "PermissionDenied" };
  return { tag: "Other", value: String(err.message ?? e) };
}

// ---- std.http on Deno ----

type DenoServer = { shutdown(): Promise<void>; readonly finished: Promise<void> };
type DenoHost = {
  serve(
    options: { hostname: string; port: number; onListen(): void; onError(error: unknown): Response },
    handler: (request: Request) => Promise<Response>,
  ): DenoServer;
};

const listenDeno = (deno: DenoHost): Listen => (host, port, a) => {
  let server: DenoServer;
  try {
    server = deno.serve({
      hostname: host,
      port,
      // The program decides what it prints.
      onListen() {},
      onError(error) {
        a.fail(error);
        return new Response(null, { status: 500 });
      },
    }, async (request) => {
      const url = new URL(request.url);
      let content: string;
      try {
        content = await request.text();
      } catch {
        // The client went away while sending; not the program's fault.
        return new Response(null, { status: 400 });
      }
      const answer = await a.answer({
        method: request.method,
        path: url.pathname,
        query: url.search.slice(1),
        headers: [...request.headers].map(([name, value]) => ({ name, value })),
        content,
      });
      if (answer === null) return new Response(null, { status: 500 });
      try {
        // Empty content is no body, so Deno adds no content-type of its own.
        const content = answer.content === "" ? null : answer.content;
        return new Response(content, { status: answer.status, headers: hostHeaders(answer) });
      } catch (e) {
        a.fail(e);
        return new Response(null, { status: 500 });
      }
    });
  } catch (e) {
    return Promise.resolve(serveError(e));
  }
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void server.shutdown();
  };
  return Promise.resolve({ close, closed: server.finished });
};

// ---- std.http on Node.js ----

type NodeRequest = AsyncIterable<Uint8Array> & {
  readonly method?: string;
  readonly url?: string;
  readonly headersDistinct: Record<string, string[]>;
};
type NodeResponse = { writeHead(status: number, headers: string[]): void; end(content?: string): void };
type NodeServer = {
  listen(port: number, host: string, listening: () => void): void;
  once(event: "error", listener: (error: unknown) => void): void;
  off(event: "error", listener: (error: unknown) => void): void;
  close(closed: () => void): void;
  closeIdleConnections(): void;
};
type NodeHttp = { createServer(handler: (req: NodeRequest, res: NodeResponse) => void): NodeServer };

const listenNode = (http: NodeHttp): Listen => (host, port, a) => {
  let closing = false;
  const server = http.createServer(async (req, res) => {
    let content = "";
    try {
      const decoder = new TextDecoder();
      for await (const chunk of req) content += decoder.decode(chunk, { stream: true });
      content += decoder.decode();
    } catch {
      // The client went away while sending; not the program's fault.
      res.writeHead(400, ["connection", "close"]);
      res.end();
      return;
    }
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const headers = Object.entries(req.headersDistinct)
        .map(([name, values]) => ({ name, value: values.join(", ") }))
        .sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
      const answer = await a.answer({
        method: req.method ?? "GET",
        path: url.pathname,
        query: url.search.slice(1),
        headers,
        content,
      });
      if (answer === null) {
        res.writeHead(500, ["connection", "close"]);
        res.end();
        return;
      }
      const flat = hostHeaders(answer).flat();
      // Once closing, every answer ends its connection, so that close
      // finishes although clients keep connections alive.
      if (closing) flat.push("connection", "close");
      res.writeHead(answer.status, flat);
      res.end(answer.content === "" && noContent(answer.status) ? undefined : answer.content);
    } catch (e) {
      a.fail(e);
      res.writeHead(500, ["connection", "close"]);
      res.end();
    }
  });
  return new Promise((resolve) => {
    const refused = (error: unknown) => resolve(serveError(error));
    server.once("error", refused);
    try {
      server.listen(port, host, () => {
        server.off("error", refused);
        let close: (() => void) | null = null;
        const closed = new Promise<void>((done) => {
          close = () => {
            if (closing) return;
            closing = true;
            server.close(done);
            server.closeIdleConnections();
          };
        });
        resolve({ close: () => close!(), closed });
      });
    } catch (e) {
      // An invalid port throws before listening.
      resolve(serveError(e));
    }
  });
};

// ---- std.http.serve ----

type Signals = {
  Deno?: {
    addSignalListener(signal: string, listener: () => void): void;
    removeSignalListener(signal: string, listener: () => void): void;
  };
  process?: { on(signal: string, listener: () => void): void; off(signal: string, listener: () => void): void };
};

// Calls `stop` on SIGINT and SIGTERM until the returned function is called.
// A signal the platform does not know (SIGTERM on Windows) is skipped.
function onStopSignals(stop: () => void): () => void {
  const host = globalThis as Signals;
  const added: string[] = [];
  for (const signal of ["SIGINT", "SIGTERM"]) {
    try {
      if (host.Deno) host.Deno.addSignalListener(signal, stop);
      else host.process?.on(signal, stop);
      added.push(signal);
    } catch {
      // Not supported here.
    }
  }
  return () => {
    for (const signal of added.splice(0)) {
      if (host.Deno) host.Deno.removeSignalListener(signal, stop);
      else host.process?.off(signal, stop);
    }
  };
}

type HttpHost = {
  Deno?: DenoHost;
  process?: { getBuiltinModule(name: "node:http"): NodeHttp };
};

// Requests are answered one at a time, in the order they arrive: alang has no
// concurrency, so a handler never starts before the previous one returned.
// A trap in the handler (or in sending its response) ends the server: the
// request gets status 500, later ones are not handled, and the trap ends
// the program from where `serve` was called. `stop` is for tests only, since
// alang code cannot make an AbortSignal; programs end on SIGINT or SIGTERM.
export async function std$http$serve(
  host: string,
  port: number,
  handler: Handler,
  stop?: AbortSignal,
): Promise<Result<Unit, std$http$ServeError>> {
  const h = globalThis as HttpHost;
  const listen = h.Deno ? listenDeno(h.Deno) : h.process ? listenNode(h.process.getBuiltinModule("node:http")) : null;
  if (listen === null) return trap("effect", "std.http.serve", host, "This runtime has no network.");

  let failure: { error: unknown } | null = null;
  let listener: Listener | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const fail = (error: unknown) => {
    failure ??= { error };
    listener?.close();
  };
  const answering: Answering = {
    answer(request) {
      const turn = queue.then(async () => {
        if (failure !== null) return null;
        try {
          return await handler(request);
        } catch (e) {
          fail(e);
          return null;
        }
      });
      queue = turn;
      return turn;
    },
    fail,
  };

  const listening = await listen(host, port, answering);
  if (!("close" in listening)) return Err(listening);
  listener = listening;
  const close = () => listening.close();
  // After the first signal the listeners go, so a second one ends the
  // program at once if answering the requests in progress takes too long.
  const removeSignals = onStopSignals(() => {
    removeSignals();
    close();
  });
  stop?.addEventListener("abort", close);
  try {
    await listening.closed;
  } finally {
    removeSignals();
    stop?.removeEventListener("abort", close);
  }
  if (failure !== null) throw (failure as { error: unknown }).error;
  return Ok(Unit);
}

export function std$int$parse(text: string): Option<number> {
  if (!/^-?[0-9]+$/.test(text)) return None;
  const n = Number(text);
  return Number.isSafeInteger(n) ? Some(n) : None;
}

export function std$int$to_float(value: number): number {
  return value;
}

export function std$int$compare(left: number, right: number): Order {
  return toOrder(left - right);
}

export function std$float$floor(value: number): number {
  const r = Math.floor(value);
  if (!Number.isSafeInteger(r)) trap("overflow", "std.float.floor", String(value), "Float outside the Int range.");
  return r;
}

export function std$string$trim(text: string): string {
  return text.trim();
}

// Number of Unicode scalar values.
export function std$string$length(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

export function std$string$concat(left: string, right: string): string {
  return left + right;
}

export function std$string$join(parts: readonly string[], separator: string): string {
  return parts.join(separator);
}

export function std$string$compare(left: string, right: string): Order {
  return toOrder(str_compare(left, right));
}

export function std$list$empty<T>(): readonly T[] {
  return [];
}

export function std$list$append<T>(list: readonly T[], item: T): readonly T[] {
  return [...list, item];
}

export function std$list$length<T>(list: readonly T[]): number {
  return list.length;
}

export function std$list$get<T>(list: readonly T[], index: number): Option<T> {
  return index >= 0 && index < list.length ? Some(list[index]) : None;
}

export function std$list$map<T, U>(list: readonly T[], fn: (item: T) => U): readonly U[] {
  return list.map((x) => fn(x));
}

export function std$list$filter<T>(list: readonly T[], fn: (item: T) => boolean): readonly T[] {
  return list.filter((x) => fn(x));
}

export function std$list$fold<T, A>(list: readonly T[], initial: A, fn: (acc: A, item: T) => A): A {
  let acc = initial;
  for (const x of list) acc = fn(acc, x);
  return acc;
}

export function std$list$sort<T>(list: readonly T[], by: (left: T, right: T) => Order): readonly T[] {
  const order = { Less: -1, Equal: 0, Greater: 1 } as const;
  return [...list].sort((a, b) => order[by(a, b).tag]);
}

// Text representation (rule 3.9). Records have no runtime type name yet, so
// they show as their fields in parentheses.
export function std$text$show(value: unknown): string {
  if (value === null) return "Unit";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(std$text$show).join(", ")}]`;
  if (value instanceof Map) {
    return `{${[...value].map(([k, v]) => `${std$text$show(k)}: ${std$text$show(v)}`).join(", ")}}`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.tag === "string") return "value" in obj ? `${obj.tag}(${std$text$show(obj.value)})` : obj.tag;
    return `(${Object.entries(obj).map(([k, v]) => `${k}: ${std$text$show(v)}`).join(", ")})`;
  }
  return String(value);
}
