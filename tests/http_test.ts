// std.http.serve: the runtime in this process (requests in, responses out,
// one at a time, traps), then compiled server programs as their own
// processes, on Deno and Node.js.

import { assert_, assertEquals, assertThrows } from "./assert.ts";
import { pathText } from "../src/ast.ts";
import { AlangError } from "../src/diagnostic.ts";
import { printExpr } from "../src/printer.ts";
import {
  BAD_PORTS,
  Err,
  Ok,
  type std$http$Request,
  std$http$Response,
  type std$http$Response as Response_,
  std$http$send,
  type std$http$SendError,
  std$http$serve,
  Trap,
  trap,
  Unit,
} from "../src/runtime.ts";
import { STD_TYPES } from "../src/std.ts";
import { accept, type Built, run, writeEntry } from "../src/toolchain.ts";

const OUT = new URL("../out/test/http/", import.meta.url).pathname;

function freePort(): number {
  const probe = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (probe.addr as Deno.NetAddr).port;
  probe.close();
  return port;
}

const response = (status: number, content: string, headers: [string, string][] = []): Response_ => ({
  status,
  headers: headers.map(([name, value]) => ({ name, value })),
  content,
});

// std.http.serve in this process; `stop` ends it the way a signal would.
function serving(handler: (request: std$http$Request) => Response_ | Promise<Response_>) {
  const port = freePort();
  const abort = new AbortController();
  const served = std$http$serve("127.0.0.1", port, handler, abort.signal);
  // A trap may end serve before the test awaits it.
  served.catch(() => {});
  return {
    url: `http://127.0.0.1:${port}`,
    served,
    stop: async () => {
      abort.abort();
      return await served;
    },
  };
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("Expected the promise to reject.");
}

Deno.test("http: a request reaches the handler as a record, its response goes back", async () => {
  const seen: std$http$Request[] = [];
  const server = serving((request) => {
    seen.push(request);
    if (request.path === "/empty") return response(204, "");
    if (request.path === "/blank") return response(200, "");
    return response(201, "done", [["x-reply", "yes"]]);
  });
  const answer = await fetch(`${server.url}/a/b?x=1&y=2`, {
    method: "POST",
    headers: { "X-Test": "1" },
    body: "hello, wörld",
  });
  assertEquals([answer.status, await answer.text()], [201, "done"]);
  assertEquals(answer.headers.get("x-reply"), "yes");
  // Without a content-type of its own, content is text in UTF-8.
  assertEquals(answer.headers.get("content-type"), "text/plain; charset=utf-8");
  for (const path of ["/empty", "/blank"]) {
    const empty = await fetch(`${server.url}${path}`);
    const expected = path === "/empty" ? 204 : 200;
    assertEquals([empty.status, await empty.text(), empty.headers.get("content-type")], [expected, "", null]);
  }
  assertEquals(await server.stop(), Ok(Unit));

  const [post] = seen;
  assertEquals([post.method, post.path, post.query, post.content], ["POST", "/a/b", "x=1&y=2", "hello, wörld"]);
  const names = post.headers.map((h) => h.name);
  assertEquals(names, [...names].sort());
  assert_(post.headers.some((h) => h.name === "x-test" && h.value === "1"), JSON.stringify(post.headers));
  assertEquals([seen[1].method, seen[1].query, seen[1].content], ["GET", "", ""]);
});

Deno.test("http: requests are answered one at a time", async () => {
  const log: string[] = [];
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let started = () => {};
  const firstStarted = new Promise<void>((resolve) => (started = resolve));
  const server = serving(async (request) => {
    log.push(`start ${request.path}`);
    if (request.path === "/1") {
      started();
      await gate;
    }
    log.push(`end ${request.path}`);
    return response(200, request.path);
  });
  const first = fetch(`${server.url}/1`).then((r) => r.text());
  await firstStarted;
  const second = fetch(`${server.url}/2`).then((r) => r.text());
  // The second request has arrived but waits for the first handler.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assertEquals(log, ["start /1"]);
  release();
  assertEquals(await Promise.all([first, second]), ["/1", "/2"]);
  assertEquals(log, ["start /1", "end /1", "start /2", "end /2"]);
  assertEquals(await server.stop(), Ok(Unit));
});

Deno.test("http: a trap in the handler answers 500 and ends serve with the trap", async () => {
  const server = serving(() => trap("division", "web.handle", "1 / 0", "Int division by zero."));
  const answer = await fetch(`${server.url}/`);
  assertEquals([answer.status, await answer.text()], [500, ""]);
  const e = await rejection(server.served);
  assert_(e instanceof Trap);
  assertEquals([e.kind, e.definition], ["division", "web.handle"]);
});

Deno.test("http: an invalid response header traps", async () => {
  const server = serving(() => response(200, "x", [["bad name", "v"]]));
  const answer = await fetch(`${server.url}/`);
  assertEquals([answer.status, await answer.text()], [500, ""]);
  const e = await rejection(server.served);
  assert_(e instanceof Trap);
  assertEquals([e.kind, e.at], ["http", "bad name: v"]);
});

Deno.test("http: a port in use or out of range is an error value, not a trap", async () => {
  const taken = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  try {
    const port = (taken.addr as Deno.NetAddr).port;
    assertEquals(await std$http$serve("127.0.0.1", port, () => response(200, "")), Err({ tag: "AddressInUse" }));
  } finally {
    taken.close();
  }
  const outside = await std$http$serve("127.0.0.1", 70_000, () => response(200, ""));
  assert_(outside.tag === "Err" && outside.value.tag === "Other", JSON.stringify(outside));
});

Deno.test("http: std.http.Response checks its invariant like a user record (5)", () => {
  const def = STD_TYPES.find((d) => pathText(d.path) === "std.http.Response");
  assert_(def?.kind === "type" && def.where !== null);
  for (const [status, content] of [[100, ""], [600, ""], [204, "x"], [304, "x"]] as const) {
    const e = assertThrows(() => std$http$Response(response(status, content)), Trap);
    assertEquals([e.kind, e.definition, e.at], ["where", "std.http.Response", printExpr(def.where, "")]);
  }
  for (const [status, content] of [[200, ""], [204, ""], [404, "missing"], [599, "x"]] as const) {
    assertEquals(std$http$Response(response(status, content)), response(status, content));
  }
});

// ---- server programs ----

// Integer literals with more than four digits are grouped (4.7).
const literal = (n: number): string => (n < 10_000 ? String(n) : n.toLocaleString("en-US").replaceAll(",", "_"));

// A server whose handler has an effect; `/crash` divides by zero.
const SERVER = (port: number) => `
fn web.handle
  doc: "Prints the request line and answers with the path."
  in:
    request: std.http.Request
  out: std.http.Response
  effects: console
  requires: none
  ensures: none
  examples: none
  body:
    std.console.print_line(text: std.string.concat(left: std.string.concat(left: request.method, right: " "), right: request.path))
    if request.path == "/crash" then
      let n: Int = 1 / std.string.length(text: request.content)
    end if
    return std.http.Response(status: 200, headers: std.list.empty<std.http.Header>(), content: std.string.concat(left: "path ", right: request.path))
end fn web.handle

fn web.main
  doc: "Serves until stopped, then says so."
  in: none
  out: Unit
  effects: net, console
  requires: none
  ensures: none
  examples: none
  body:
    let served: Result<Unit, std.http.ServeError> = std.http.serve(host: "127.0.0.1", port: ${
  literal(port)
}, handler: handle)
    let text: String = match served
      case Ok(done) then
        "stopped"
      case Err(reason) then
        std.string.concat(left: "cannot serve: ", right: std.text.show(value: reason))
    end match
    std.console.print_line(text: text)
    return Unit
end fn web.main
`;

const decode = (b: Uint8Array) => new TextDecoder().decode(b).trim();

async function serverProgram(): Promise<{ built: Built; entry: string; url: string }> {
  const port = freePort();
  const built = (await accept(SERVER(port), `${OUT}server_${port}.ts`)).built;
  return { built, entry: await writeEntry(built), url: `http://127.0.0.1:${port}` };
}

// Waits until the server answers, at most five seconds.
async function get(url: string): Promise<{ status: number; text: string }> {
  for (let i = 0;; i++) {
    try {
      const r = await fetch(url);
      return { status: r.status, text: await r.text() };
    } catch (e) {
      if (i >= 100) throw e;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

// Sends a POST that announces 100 bytes of content, sends 3 and goes away.
async function cutShort(url: string): Promise<void> {
  const { hostname, port } = new URL(url);
  const conn = await Deno.connect({ hostname, port: Number(port) });
  await conn.write(new TextEncoder().encode("POST /cut HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\nabc"));
  conn.close();
  // Give the server time to notice before the next request.
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function hasNode(): Promise<boolean> {
  const node = await new Deno.Command("node", { args: ["--version"], stdout: "null", stderr: "null" }).output()
    .catch(() => null);
  return node?.success ?? false;
}

async function startedOn(command: string, args: string[]) {
  const { entry, url } = await serverProgram();
  const child = new Deno.Command(command, { args: [...args, entry], stdout: "piped", stderr: "piped" }).spawn();
  return { child, url };
}

for (const host of ["deno", "node"] as const) {
  Deno.test(`http: a server program answers until SIGTERM, then serve returns Ok (${host})`, async () => {
    if (host === "node" && !(await hasNode())) return;
    const { child, url } = await startedOn(
      host === "deno" ? Deno.execPath() : "node",
      host === "deno" ? ["run", "--no-prompt", "--allow-net"] : [],
    );
    assertEquals(await get(`${url}/hello`), { status: 200, text: "path /hello" });
    // Nothing a client sends ends the server: a target both hosts read as a
    // path, and a request that announces more content than it sends.
    assertEquals(await get(`${url}//odd`), { status: 200, text: "path //odd" });
    await cutShort(url);
    assertEquals(await get(`${url}/again?x=1`), { status: 200, text: "path /again" });
    child.kill("SIGTERM");
    const out = await child.output();
    assertEquals(
      [out.code, decode(out.stdout).split("\n")],
      [0, ["GET /hello", "GET //odd", "GET /again", "stopped"]],
      decode(out.stderr),
    );
  });
}

Deno.test("http: a trap in a handler ends the program with its diagnostic", async () => {
  const { child, url } = await startedOn(Deno.execPath(), ["run", "--no-prompt", "--allow-net"]);
  assertEquals(await get(`${url}/crash`), { status: 500, text: "" });
  const out = await child.output();
  assertEquals(out.code, 70);
  assertEquals(decode(out.stdout), "GET /crash");
  const diagnostic = JSON.parse(decode(out.stderr));
  assertEquals([diagnostic.trap, diagnostic.definition], ["division", "web.handle"]);
});

Deno.test("http: serving without the net permission traps", async () => {
  const { built } = await serverProgram();
  const out = await run(built, { stdio: "piped", effects: ["console"] });
  assertEquals(out.code, 70);
  assertEquals(JSON.parse(decode(out.stderr)).trap, "effect");
});

Deno.test("http: a port in use reaches the program as an error value, on Deno and Node.js", async () => {
  const { built, entry, url } = await serverProgram();
  const taken = Deno.listen({ hostname: "127.0.0.1", port: Number(new URL(url).port) });
  try {
    const out = await run(built, { stdio: "piped" });
    assertEquals([out.code, decode(out.stdout)], [0, "cannot serve: AddressInUse"], decode(out.stderr));
    if (!(await hasNode())) return;
    const node = await new Deno.Command("node", { args: [entry], stdout: "piped", stderr: "piped" }).output();
    assertEquals([node.code, decode(node.stdout)], [0, "cannot serve: AddressInUse"], decode(node.stderr));
  } finally {
    taken.close();
  }
});

// A pure handler has examples (5.1), so the server's logic is tested at
// every acceptance, before any request.
const PURE = (expected: string) => `
fn web.route
  doc: "Answers on the root path only."
  in:
    request: std.http.Request
  out: std.http.Response
  effects: none
  requires: none
  ensures: none
  examples:
    route(request: std.http.Request(method: "GET", path: "/", query: "", headers: std.list.empty<std.http.Header>(), content: "")) == std.http.Response(status: 200, headers: std.list.empty<std.http.Header>(), content: "${expected}")
    route(request: std.http.Request(method: "GET", path: "/x", query: "", headers: std.list.empty<std.http.Header>(), content: "")) == std.http.Response(status: 404, headers: std.list.empty<std.http.Header>(), content: "")
  body:
    if request.path == "/" then
      return std.http.Response(status: 200, headers: std.list.empty<std.http.Header>(), content: "home")
    end if
    return std.http.Response(status: 404, headers: std.list.empty<std.http.Header>(), content: "")
end fn web.route

fn web.main
  doc: "Serves the routes."
  in: none
  out: Unit
  effects: net
  requires: none
  ensures: none
  examples: none
  body:
    let served: Unit = std.http.serve(host: "127.0.0.1", port: 8080, handler: route) else return Unit
    return Unit
end fn web.main
`;

Deno.test("http: examples test a pure handler at acceptance", async () => {
  const ok = await accept(PURE("home"), `${OUT}pure.ts`);
  assertEquals(ok.examples.length, 2);
  const e = await rejection(accept(PURE("welcome"), `${OUT}pure_failing.ts`));
  assert_(e instanceof AlangError);
  assertEquals(e.diagnostics.map((d) => [d.code, d.definition]), [["E0402", "web.route"]]);
});

// ---- std.http.send ----

// The headers HTTP sets itself, which a program may not send.
const MANAGED = [
  "connection",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

const header = (name: string, value: string) => ({ name, value });
const failed = (r: { tag: string; value?: unknown }): string =>
  r.tag === "Err" && (r.value as std$http$SendError).tag === "Failed" ? "Failed" : JSON.stringify(r);

interface RawRequest {
  readonly method: string;
  readonly path: string;
  readonly head: string;
  readonly content: Uint8Array;
}
// What a raw server sends: these bytes, then it closes the connection; null
// closes it without an answer; "hold" keeps it open until the server closes.
type RawAnswer = Uint8Array | string | null | "hold";

const encode = (text: string) => new TextEncoder().encode(text);

function joined(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const all = new Uint8Array(a.length + b.length);
  all.set(a);
  all.set(b, a.length);
  return all;
}

// The head of a response, with these headers, then the content.
function raw(status: string, headers: [string, string][], content: Uint8Array | string = ""): Uint8Array {
  const head = [`HTTP/1.1 ${status}`, ...headers.map(([n, v]) => `${n}: ${v}`), "", ""].join("\r\n");
  return joined(encode(head), typeof content === "string" ? encode(content) : content);
}

async function readRequest(conn: Deno.Conn): Promise<RawRequest | null> {
  let bytes = new Uint8Array(0);
  const chunk = new Uint8Array(16_384);
  const more = async () => {
    const n = await conn.read(chunk);
    if (n === null) return false;
    bytes = joined(bytes, chunk.subarray(0, n));
    return true;
  };
  let end = -1;
  while ((end = new TextDecoder().decode(bytes).indexOf("\r\n\r\n")) < 0) if (!(await more())) return null;
  const head = new TextDecoder().decode(bytes).slice(0, end);
  const start = encode(head).length + 4;
  const length = Number(/^content-length: *(\d+)/im.exec(head)?.[1] ?? 0);
  while (bytes.length < start + length) if (!(await more())) return null;
  const [method, path] = head.split("\r\n")[0].split(" ");
  return { method, path, head, content: bytes.subarray(start, start + length) };
}

// An HTTP/1.1 server written by hand, for answers std.http.serve never gives.
function rawServer(answer: (request: RawRequest) => RawAnswer | Promise<RawAnswer>) {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const conns = new Set<Deno.Conn>();
  const handled: Promise<void>[] = [];
  let release = () => {};
  const closing = new Promise<void>((resolve) => (release = resolve));
  const requests: RawRequest[] = [];
  const handle = async (conn: Deno.Conn) => {
    try {
      const request = await readRequest(conn);
      if (request === null) return;
      requests.push(request);
      const reply = await answer(request);
      if (reply === "hold") await closing;
      else if (reply !== null) {
        const bytes = typeof reply === "string" ? encode(reply) : reply;
        for (let at = 0; at < bytes.length;) at += await conn.write(bytes.subarray(at));
      }
    } catch {
      // The client went away.
    } finally {
      conns.delete(conn);
      try {
        conn.close();
      } catch {
        // Closed already.
      }
    }
  };
  const accepting = (async () => {
    try {
      for await (const conn of listener) {
        conns.add(conn);
        handled.push(handle(conn));
      }
    } catch {
      // The listener closed.
    }
  })();
  return {
    url: `http://127.0.0.1:${(listener.addr as Deno.NetAddr).port}`,
    requests,
    close: async () => {
      release();
      listener.close();
      await accepting;
      await Promise.all(handled);
    },
  };
}

Deno.test("send: a request reaches std.http.serve, its response comes back", async () => {
  const seen: std$http$Request[] = [];
  const server = serving((request) => {
    seen.push(request);
    return response(201, "done", [["x-reply", "yes"]]);
  });
  try {
    const sent = await std$http$send("POST", `${server.url}/a/b?x=1`, [header("X-Test", "1")], "hello, wörld", 5000);
    assert_(sent.tag === "Ok", JSON.stringify(sent));
    const { status, headers, content } = sent.value;
    // Deno's server adds date and vary.
    assertEquals([status, headers.filter((h) => h.name !== "date" && h.name !== "vary"), content], [201, [
      header("content-length", "4"),
      header("content-type", "text/plain; charset=utf-8"),
      header("x-reply", "yes"),
    ], "done"]);
  } finally {
    assertEquals(await server.stop(), Ok(Unit));
  }
  const [post] = seen;
  assertEquals([post.method, post.path, post.query, post.content], ["POST", "/a/b", "x=1", "hello, wörld"]);
  // Content without a content-type is text in UTF-8, as the server sends it.
  for (const h of [header("x-test", "1"), header("content-type", "text/plain; charset=utf-8")]) {
    assert_(post.headers.some((p) => p.name === h.name && p.value === h.value), JSON.stringify(post.headers));
  }
});

Deno.test("send: response headers sorted and joined as fetch gives them; compressed content arrives decoded", async () => {
  const gzip = new Uint8Array(
    await new Response(new Blob([encode("compressed ä")]).stream().pipeThrough(new CompressionStream("gzip")))
      .arrayBuffer(),
  );
  const server = rawServer((request) =>
    request.path === "/gzip"
      ? raw(
        "200 OK",
        [["Content-Encoding", "gzip"], ["Content-Length", String(gzip.length)], ["Connection", "close"]],
        gzip,
      )
      : raw("200 OK", [
        ["Set-Cookie", "a=1"],
        ["X-B", "1"],
        ["x-a", "2"],
        ["Set-Cookie", "b=2"],
        ["x-a", "3"],
        ["Connection", "close"],
        ["Content-Length", "5"],
      ], "hello")
  );
  try {
    assertEquals(
      await std$http$send("GET", `${server.url}/headers`, [], "", 5000),
      Ok({
        status: 200,
        headers: [
          header("connection", "close"),
          header("content-length", "5"),
          header("set-cookie", "a=1"),
          header("set-cookie", "b=2"),
          header("x-a", "2, 3"),
          header("x-b", "1"),
        ],
        content: "hello",
      }),
    );
    assertEquals(
      await std$http$send("GET", `${server.url}/gzip`, [], "", 5000),
      Ok({ status: 200, headers: [header("connection", "close")], content: "compressed ä" }),
    );
  } finally {
    await server.close();
  }
});

Deno.test("send: no response is an error value: TimedOut, Unreachable, InvalidUrl", async () => {
  let calls = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const server = serving(async () => {
    calls++;
    await gate;
    return response(200, "late");
  });
  try {
    const start = performance.now();
    assertEquals(
      await std$http$send("GET", `${server.url}/held`, [], "", 100),
      Err<std$http$SendError>({ tag: "TimedOut" }),
    );
    const took = performance.now() - start;
    assert_(took < 2000, `${took} ms`);
    assertEquals(calls, 1);
    assertEquals(
      await std$http$send("GET", `http://127.0.0.1:${freePort()}/`, [], "", 5000),
      Err<std$http$SendError>({ tag: "Unreachable" }),
    );
    const port = new URL(server.url).port;
    for (
      const url of [
        "not a url",
        "/relative",
        "ftp://127.0.0.1/",
        "file:///etc/hostname",
        `http://u:p@127.0.0.1:${port}/`,
        "http://127.0.0.1:25/",
        "http://127.0.0.1:0/",
      ]
    ) assertEquals(await std$http$send("GET", url, [], "", 5000), Err<std$http$SendError>({ tag: "InvalidUrl" }), url);
    // None of them was sent.
    assertEquals(calls, 1);
  } finally {
    release();
    assertEquals(await server.stop(), Ok(Unit));
  }
});

Deno.test("send: redirects are followed as fetch follows them", async () => {
  const server = rawServer((request) => {
    const moved = (status: string, to: string) =>
      raw(status, [["Location", to], ["Content-Length", "0"], ["Connection", "close"]]);
    if (request.path === "/from") return moved("302 Found", "/target");
    if (request.path === "/see-other") return moved("303 See Other", "/echo");
    if (request.path === "/to-file") return moved("302 Found", "file:///etc/hostname");
    if (request.path === "/loop") return moved("302 Found", "/loop");
    const content = `${request.method} ${request.path} ${new TextDecoder().decode(request.content)}`;
    return raw("200 OK", [["Content-Length", String(encode(content).length)], ["Connection", "close"]], content);
  });
  try {
    const target = await std$http$send("GET", `${server.url}/from`, [], "", 5000);
    assertEquals(target.tag === "Ok" && [target.value.status, target.value.content], [200, "GET /target "]);
    // A 303 continues as GET, without the content.
    const seen = await std$http$send("POST", `${server.url}/see-other`, [], "posted", 5000);
    assertEquals(seen.tag === "Ok" && seen.value.content, "GET /echo ");
    // A redirect to anything but http or https is no response: nothing of the file.
    const file = await std$http$send("GET", `${server.url}/to-file`, [], "", 5000);
    assertEquals(failed(file), "Failed");
    assertEquals(failed(await std$http$send("GET", `${server.url}/loop`, [], "", 5000)), "Failed");
    assertEquals(server.requests.filter((r) => r.path === "/loop").length, 21);
  } finally {
    await server.close();
  }
});

Deno.test("send: the program's mistakes trap before anything is sent", async () => {
  let calls = 0;
  const server = serving(() => {
    calls++;
    return response(200, "");
  });
  const trapOf = async (method: string, headers: [string, string][], content: string, timeout = 5000) => {
    const e = await rejection(
      std$http$send(method, `${server.url}/`, headers.map(([n, v]) => header(n, v)), content, timeout),
    );
    assert_(e instanceof Trap, String(e));
    return [e.kind, e.definition, e.at];
  };
  try {
    for (const method of ["get", "CONNECT", "GE T", "TRACE", "TRACK", ""]) {
      assertEquals(await trapOf(method, [], ""), ["http", "std.http.send", method]);
    }
    assertEquals(await trapOf("GET", [], "x"), ["http", "std.http.send", "GET"]);
    assertEquals(await trapOf("HEAD", [], "x"), ["http", "std.http.send", "HEAD"]);
    for (const [name, value] of [["bad name", "v"], ["x-a", "a\nb"], ["x-a", "😀"]]) {
      assertEquals(await trapOf("GET", [[name, value]], ""), ["http", "std.http.send", `${name}: ${value}`]);
    }
    for (const name of [...MANAGED, "Host", "CONTENT-LENGTH"]) {
      assertEquals(await trapOf("POST", [[name, "1"]], "x"), ["http", "std.http.send", `${name}: 1`]);
    }
    for (const timeout of [0, -1]) {
      assertEquals(await trapOf("GET", [], "", timeout), ["requires", "std.http.send", "timeout_milliseconds >= 1"]);
    }
    assertEquals(calls, 0);
    // A character up to U+00FF is a header value.
    const latin = await std$http$send("GET", `${server.url}/`, [header("x-a", "é")], "", 5000);
    assertEquals(latin.tag === "Ok" && latin.value.status, 200);
    assertEquals(calls, 1);
  } finally {
    assertEquals(await server.stop(), Ok(Unit));
  }
});

Deno.test("send: odd answers of a server are Failed; content is read as UTF-8", async () => {
  const server = rawServer((request) => {
    if (request.path === "/600") return raw("600 Odd", [["Content-Length", "0"], ["Connection", "close"]]);
    if (request.path === "/closed") return null;
    if (request.path === "/short") return raw("200 OK", [["Content-Length", "10"], ["Connection", "close"]], "abc");
    return raw(
      "200 OK",
      [["Content-Length", "5"], ["Connection", "close"]],
      new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0xff]),
    );
  });
  try {
    for (const path of ["/600", "/closed", "/short"]) {
      assertEquals(failed(await std$http$send("GET", `${server.url}${path}`, [], "", 5000)), "Failed", path);
    }
    // A leading byte order mark goes, an invalid byte becomes U+FFFD.
    const latin = await std$http$send("GET", `${server.url}/bytes`, [], "", 5000);
    assertEquals(latin.tag === "Ok" && latin.value.content, "a�");
  } finally {
    await server.close();
  }
});

Deno.test("send: the bad ports are those Node.js's fetch refuses, and 0", async () => {
  if (!(await hasNode())) return;
  const closed = freePort();
  // Node.js tries port 0 and is refused; the runtime decides it before sending.
  const bad = [...BAD_PORTS].filter((port) => port !== 0);
  assertEquals(bad.length, BAD_PORTS.size - 1);
  const script = `
    const ports = ${JSON.stringify([...bad, 0, closed])};
    const out = [];
    for (const port of ports) {
      try {
        await fetch("http://127.0.0.1:" + port + "/");
        out.push("ok");
      } catch (e) {
        out.push(e.cause?.code ?? e.cause?.message);
      }
    }
    console.log(JSON.stringify(out));`;
  const node = await new Deno.Command("node", { args: ["-e", script], stdout: "piped", stderr: "piped" }).output();
  assertEquals(node.code, 0, decode(node.stderr));
  const answers: string[] = JSON.parse(decode(node.stdout));
  assertEquals(answers, [...bad.map(() => "bad port"), "ECONNREFUSED", "ECONNREFUSED"]);
});

Deno.test("send: sending without the net permission traps", async () => {
  const source = `
fn client.main
  doc: "Sends a request to the URL it is given."
  in: none
  out: Unit
  effects: net, env, console
  requires: none
  ensures: none
  examples: none
  body:
    let url: String = std.list.get(list: std.env.args(), index: 0) else return Unit
    let sent: Result<std.http.Response, std.http.SendError> = std.http.send(method: "GET", url: url, headers: std.list.empty<std.http.Header>(), content: "", timeout_milliseconds: 5000)
    std.console.print_line(text: std.text.show(value: sent))
    return Unit
end fn client.main
`;
  const built = (await accept(source, `${OUT}client_no_net.ts`)).built;
  const out = await run(built, {
    stdio: "piped",
    effects: ["env", "console"],
    args: [`http://127.0.0.1:${freePort()}/`],
  });
  const trap = JSON.parse(decode(out.stderr));
  assertEquals([out.code, trap.trap, trap.definition], [70, "effect", "std.http.send"]);
});
