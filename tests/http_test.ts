// std.http.serve: the runtime in this process (requests in, responses out,
// one at a time, traps), then compiled server programs as their own
// processes, on Deno and Node.js.

import { assert_, assertEquals, assertThrows } from "./assert.ts";
import { pathText } from "../src/ast.ts";
import { AlangError } from "../src/diagnostic.ts";
import { printExpr } from "../src/printer.ts";
import {
  Err,
  Ok,
  type std$http$Request,
  std$http$Response,
  type std$http$Response as Response_,
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
  assertEquals([diagnostic.trap, diagnostic.definition], ["division", null]);
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
