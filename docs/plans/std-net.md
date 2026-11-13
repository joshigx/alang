# Plan: phase 3, `std-net`

The planner wrote this on 2026-11-14, from `main` at `6f698cd` (`logstat-fixes` merged). No repository file was written. The facts marked "observed" come from probes on Deno 2.8.0 and Node.js 26.13.0: `deno eval` and `node -e`, in-process servers, and writes aimed at an existing directory, which change nothing. "To verify" marks what was not observed. The main session takes every recommendation. N3 was approved by the user on 2026-11-13.

**Branch:** `std-net` from `main`. After every commit, run `deno task test`, `deno lint` and `deno fmt --check`. Then commit with explicit paths, never `git add -A`.

## 1. Findings that shape the phase

1. **Effects and checker: nothing to add.**
   - `net` and `time` exist (`src/ast.ts:142`), and `PERMISSIONS` maps `net` to `--allow-net` while `time` needs no permission (`src/toolchain.ts:148`).
   - Any std call with effects goes into `CheckInfo.effectful` (`src/check.ts:829`) and is awaited (`src/emit.ts:489`). So an async runtime function needs no checker or emitter change. `std$http$serve` is the precedent.
   - The decision row "Effects in TS" already names network and waiting as the reason.
2. **`fetch` is global on both hosts.** The client needs no host branch, and only error mapping differs.
3. **Host facts (observed).**

   | Situation | Deno | Node.js |
   | --- | --- | --- |
   | Exclusive create on an existing directory (`createNew` / `flag: "wx"`) | `AlreadyExists`, code `EEXIST` | code `EEXIST` |
   | Recursive `mkdir` over a file | `AlreadyExists`, `EEXIST` | `EEXIST` |
   | fetch: connection refused | `TypeError`, no `code` or `cause`; "…client error (Connect): tcp connect error: Connection refused (os error 111)" | `TypeError` "fetch failed", `cause.code` `ECONNREFUSED` |
   | fetch: name does not resolve | "…client error (Connect): dns error: failed to lookup address information…" | `cause.code` `ENOTFOUND` |
   | fetch: `ftp:`, `u:p@` in the URL | "Url scheme 'ftp' not supported"; credentials ignored (it connects) | "fetch failed"; `TypeError` for credentials |
   | fetch to port 1 | connects | "fetch failed", cause "bad port" (Fetch-standard port blocking) |
   | `AbortSignal.timeout` | `TimeoutError` | `TimeoutError` |
   | Method "GE T", a header value with `\n`, GET with a body | `TypeError` | `TypeError` |
   | Request header `host` | replaced by the host | replaced by the host |
   | Request header `content-length: 99` | ignored | fails |
   | Request headers `transfer-encoding`, `keep-alive`, `upgrade`, `expect` | sent | fail (`UND_ERR_INVALID_ARG` / `UND_ERR_NOT_SUPPORTED`) |
   | Response headers from the same server | lowercase and sorted, repeats joined `, `, one `set-cookie` per cookie; `connection`, `keep-alive` and `transfer-encoding` exposed | the same |
   | Compressed response | decompressed; drops `content-encoding` and `content-length`, also when the program set `accept-encoding: gzip` | decompressed; keeps both, the length being the compressed one |
   | Status 299 | accepted | accepted |
   | POST with body `""` | — | sends `content-type: text/plain;charset=UTF-8` and length 0 |

   Default request headers differ by host: Deno sends user-agent `Deno/2.8.0` and `accept-encoding: gzip,br`; Node sends `node`, `gzip, deflate` and `sec-fetch-mode`. Only the server sees these.
4. **`onFiles`** (`src/runtime.ts:527`) maps the codes both hosts share. `EEXIST` is unmapped, so today it becomes `Other`.
5. **`hostHeaders`** (`runtime.ts:706`) holds the server's header check. The client needs the same check under its own name.
6. **Exhaustive matches over `std.fs.Error`.**
   - In the repository: `tests/check_test.ts:347` and `tests/emit_test.ts:317-323`.
   - In the playground export: `ledger`, `wordcount` and `logstat`. After N3 these fail E0213, so the whole program is rejected there.
7. **Pins to adapt.**
   - `EFFECTFUL` (`check_test.ts:866`, in STD order; it must name every effectful std function but `serve`).
   - `NEEDING` (`io_test.ts:316`).
   - "std signatures and runtime exports match" (`check_test.ts:159`): new runtime helpers must not start with `std$`.
   - In `tests/queries_test.ts`:
     - `searchText("file")` and `searchText("PORT")` (about line 270);
     - the `list("std.http")` pin (about line 225).
   - `spec_test` inventory: definitions 16 → 17.
   - `IO_STDOUT` and `ENDING_PROGRAM` (`tests/io_program.ts`).
   - The pinned stderr of `lines.alang` and `words.alang` (`io_test.ts:507-509`, `540-541`).
   - The create-directory test (`io_test.ts:181`, which pins `Other`).
   - The card's "waiting".
8. **`error:` as an argument label parses.** `bindingName` (`src/parser.ts:256`) guards only bindings and parameters, so `std.fs.describe(error: error)` is legal in an `else` branch.
9. **`std.console.print` bypasses the MCP redirect.** `src/mcp.ts:571` sends `console.log` to stderr; a direct stdout write is not covered. Generated code with effects never runs in the MCP process (examples are pure), so this is a risk line only.
10. **Card budget (measured).** Now 158 lines and 9,372 bytes. With the edits of 2.7: 158 lines, 9,420 bytes, longest line 115 characters.
11. **Test pins on doc words.** Words in the new docs that `tests/queries_test.ts` searches for:
    - "file": in `create_text`, `create_directory` (new doc) and `std.fs.describe`;
    - "port": only in the `SendError` doc.

    No other new doc contains either word.

## 2. Design

### 2.1 N3: `AlreadyExists` and `std.fs.create_text` (approved)

**Type** (`STD_TYPES_SOURCE`):

```
type std.fs.Error
  doc: "Why a file or directory operation failed; `std.fs.describe` gives it as text. Other carries the host's message, which differs between runtimes: show it, do not compare it."
  variant:
    NotFound
    PermissionDenied
    IsADirectory
    AlreadyExists
    Other: String
  where: none
end type std.fs.Error
```

The doc names `std.fs.describe`, which exists only from commit 2. In commit 1 keep the old doc; commit 2 changes it.

**Runtime.**
- In `onFiles`, before `EACCES`: `if (err.code === "EEXIST") return Err({ tag: "AlreadyExists" })`. Mapping it for every fs function keeps "every `std.fs` function reports a failure the same way", so `create_directory` over a file becomes `AlreadyExists` (both hosts give `EEXIST`, observed).
- `std$fs$create_text`:
  - Deno: `deno.writeTextFileSync(path, text, { createNew: true })`.
  - Node: `fs.writeFileSync(path, text, { flag: "wx" })`.
  - Widen the `DenoFs` and `NodeFs` types to take these options.
  - Both are `O_CREAT|O_EXCL`. POSIX makes that fail with `EEXIST` for a link, even a broken one (to verify in the test).

**Rows** (STD order: after `append_text`):

| Signature | Effects | Doc |
| --- | --- | --- |
| `std.fs.create_text(path: String, text: String): Result<Unit, std.fs.Error>` | fs.write | Creates a file holding the text as UTF-8, only if nothing is at the path yet, so it never overwrites: `Err(AlreadyExists)` if a file, a directory or a link (even a broken one) is there, which stays unchanged. Testing and creating are one step, so of two programs creating the same path exactly one succeeds. |
| `std.fs.create_directory(path: String): Result<Unit, std.fs.Error>` (doc changed) | fs.write | Creates a directory and its missing parents; `Ok` if it already exists, `Err(AlreadyExists)` if a file is there. |

### 2.2 `std.fs.describe` (N4)

- **Signature:** `std.fs.describe(error: std.fs.Error): String`, pure, the last row of `std.fs`.
- **Doc:** "The error as a short text for a message, starting in lower case and without a final period: `no such file or directory`, `permission denied`, `is a directory`, `already exists`, or the host's message that `Other` carries."
- **Runtime:** a `switch` on the tag.
- **Examples:** `examples/lines.alang` and `examples/words.alang` replace `std.text.show(value: error)` with `std.fs.describe(error: error)`. Their stderr becomes, for example, `cannot read the file: no such file or directory`.

### 2.3 `std.console.print` (N9)

- **Signature:** `std.console.print(text: String): Unit`, console, after `print_line`.
- **Doc:** "Writes the text to the console without a line break, such as a prompt before `std.console.read_line`."
- **Runtime:**
  - Deno: `Deno.stdout.writeSync` in a loop until every byte of `new TextEncoder().encode(text)` is written.
  - Node: `process.stdout.write(text)`, the stream `console.log` uses.
  - Otherwise: a trap `effect` ("This runtime has no console.").
  - Declare a structural `OutputHost` type, as `InputHost` does.
  - `print_line` stays `console.log`.

### 2.4 `std.time.wait` (N10)

- **Signature:** `std.time.wait(milliseconds: Int): Unit`, time, after `now_milliseconds`.
- **Doc:** "Waits (sleeps) for the given number of milliseconds; 0 returns at once and a negative number traps. Nothing else runs meanwhile, so a server whose handler waits answers no other request."
- **Runtime:**

```ts
// setTimeout holds at most 2^31 - 1 ms (Node.js fires a longer one at once), so a
// longer wait is a chain of timers. Returns a function that cancels it.
const MAX_DELAY = 2_147_483_647;
function after(milliseconds: number, done: () => void): () => void {
  let handle: ReturnType<typeof setTimeout>;
  const step = (left: number) => {
    handle = setTimeout(() => (left > MAX_DELAY ? step(left - MAX_DELAY) : done()), Math.min(left, MAX_DELAY));
  };
  step(milliseconds);
  return () => clearTimeout(handle);
}
export async function std$time$wait(milliseconds: number): Promise<Unit> {
  if (milliseconds < 0) trap("requires", "std.time.wait", "milliseconds >= 0", "Precondition of std.time.wait violated: milliseconds >= 0");
  await new Promise<void>((resolve) => after(milliseconds, resolve));
  return Unit;
}
```

### 2.5 `std.http.send` and `std.http.SendError` (N1, N2, N5 to N8, N11)

**Types.** Add `SendError` after `ServeError`. The docs of `Header` and `Response` change:

```
type std.http.Header
  doc: "One header of a request or response. A name that is not an HTTP token, or a value with a line break or a character above U+00FF, traps when it is sent."
...
type std.http.Response
  doc: "The answer to a request: what a handler of std.http.serve returns and what std.http.send receives. Statuses 204, 205 and 304 carry no content. Without a content-type header, content is sent as text/plain in UTF-8."
...
type std.http.SendError
  doc: "Why std.http.send got no response; `std.http.describe` gives it as text. InvalidUrl: not an absolute http or https URL, one with a user name or password, or one with a port the Fetch standard blocks (such as 25), found before sending. Unreachable: the host name does not resolve, or the server refuses the connection. TimedOut: no whole response within the timeout. Failed: anything else, with the host's message, which differs between runtimes: show it, do not compare it."
  variant:
    InvalidUrl
    Unreachable
    TimedOut
    Failed: String
  where: none
end type std.http.SendError
```

(The `SendError` doc names `std.http.describe`. Commit 5 leaves out the clause that names it, and commit 6 adds it.)

**Function** (after `serve`):

| Signature | Effects | Doc |
| --- | --- | --- |
| `std.http.send(method: String, url: String, headers: List<std.http.Header>, content: String, timeout_milliseconds: Int): Result<std.http.Response, std.http.SendError>` | net | Sends an HTTP request, like fetch, and waits for the whole response, following up to 20 redirects; `timeout_milliseconds` covers all of it. The response's header names are lowercase and sorted, repeated ones joined with `, ` except `set-cookie`; compressed content arrives decompressed, without its `content-encoding` and `content-length` headers. Content is sent and read as UTF-8 text; without a `content-type` header, content is sent as text/plain. Traps: a method not in capital letters, or CONNECT, TRACE or TRACK; content with GET or HEAD; a header HTTP manages itself (`connection`, `content-length`, `expect`, `host`, `keep-alive`, `te`, `trailer`, `transfer-encoding`, `upgrade`); a timeout below 1. |

**Runtime.** The order of steps is load-bearing: traps first, then `InvalidUrl`, then the network.

```ts
// The Fetch standard's bad ports (fetch.spec.whatwg.org/#port-blocking): Node.js's
// fetch refuses them, Deno's does not, so the runtime refuses them on both.
export const BAD_PORTS: ReadonlySet<number> = new Set([0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);
const MANAGED = new Set(["connection", "content-length", "expect", "host", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"]);
const UNREACHABLE_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
```

1. **`timeout_milliseconds < 1`** traps: kind `requires`, condition `timeout_milliseconds >= 1`.
2. **Method.** Unless it matches `/^[A-Z]+$/` and is not CONNECT, TRACE or TRACK, trap `http`, at the method: "The method `get` cannot be sent: write it in capital letters, such as GET or POST; CONNECT, TRACE and TRACK are refused."
3. **GET or HEAD with content `!== ""`** traps `http`, at the method: "A GET or HEAD request carries no content; send `""`, or use POST."
4. **Headers.**
   - Extract `checkHeader(definition, name, value)` from `hostHeaders`, so the server keeps its trap.
   - A name whose lowercase form is in `MANAGED` traps `http`, at `name: value`: "The header `host` is set by HTTP itself, not by the program."
   - Without a `content-type` (case-insensitive) and with non-empty content, add `content-type: text/plain; charset=utf-8` (N11).
5. **URL.** `new URL(url)` throws, or protocol is not `http:` / `https:`, or `username` / `password` is non-empty, or the port (default 80/443) is in `BAD_PORTS`: return `Err(InvalidUrl)`.
6. **Network missing.** No global `fetch`: trap `effect` ("This runtime has no network.").
7. **Timer and request.** `const controller = new AbortController(); let timedOut = false; const cancel = after(timeout, () => { timedOut = true; controller.abort(); })`. Then:
   - `fetch(target.href, { method, headers, body: content === "" ? undefined : content, redirect: "follow", signal })`;
   - `const text = await r.text()`; the signal also covers the body.
   - `cancel()` in `finally`.
8. **Status** outside 200..599: `Err(Failed("The server answered with status 600, outside 200 to 599."))`. Read the body first, so the test sanitizers stay quiet.
9. **Headers of the response.** `[...r.headers]` as `{ name, value }`, sorted stably by name. If any `content-encoding` is present, drop `content-encoding` and `content-length` (N7; Deno does this already, Node does not).
10. **Errors.**
    - `timedOut`: `Err(TimedOut)`.
    - `err.name === "NotCapable"`, or `ERR_ACCESS_DENIED` in `err.code` or `err.cause?.code`: trap `effect`, at the URL: "Sending needs the effect `net` on `main`."
    - `UNREACHABLE_CODES.has(err.cause?.code)` or `/\b(dns error|tcp connect error)\b/.test(err.message)`: `Err(Unreachable)`. Deno's message is matched, as `onFiles` matches "all access" for `/proc`.
    - Otherwise `Err(Failed(cause ? \`${message}: ${cause.message}\` : message))`.

### 2.6 `std.http.describe` (N4)

- **Signature:** `std.http.describe(error: std.http.SendError): String`, pure, after `send`.
- **Doc:** "The error as a short text for a message, starting in lower case and without a final period: `invalid URL`, `cannot reach the server`, `timed out`, or the host's message that `Failed` carries."
- `ServeError` keeps `std.text.show` (one call per server program). If it ever needs text, the name is `describe_serve_error`.

### 2.7 Card (`src/card.ts`, measured: 158 lines, 9,420 bytes)

- **Intro (lines 13–14), one line:** "alang is written by LLMs and transpiled to TypeScript. Write from this card; the tools find the standard library."
- **`main` bullet, add:** "Its I/O\n  errors become text: `let t: String = std.fs.read_text(path: p) else return Err(std.fs.describe(error: error))`." This teaches `main` and fs errors, the open question of the last round.
- **"Not in alang":** remove "waiting, ".

## 3. Commits, in order

**Cut order** if the run must stop early: drop `examples/probe.alang` (commit 6), then commit 4's chunking test. N3, both `describe` functions and `send` stay.

1. **N3: reopen `std.fs.Error` with `AlreadyExists`, add `std.fs.create_text`.**
   - Source: `src/std.ts` and `src/runtime.ts` (2.1).
   - Spec 7.8:
     - the two rows and the types block;
     - in the fs paragraph:
       - "…`IsADirectory`. Something already at the path where a function creates one is `AlreadyExists`: `create_text` finds a file, a directory or a link there (it does not follow links, so a broken one counts), `create_directory` a file.";
       - remove "a file where `create_directory` wants a directory" from the `Other` list;
       - add "`create_text` tests and creates in one step, so of two programs creating the same path one gets `Ok` and the other `AlreadyExists`: a lock file, or an output that must not be overwritten.".
   - `decisions.md`, Files: rewrite the "Error type" row (five cases; N3 approved by the user 2026-11-13, reopening the four cases of D2; why `EEXIST` maps everywhere). Change the `create_directory` row ("A file at the path is `AlreadyExists`") and add a `create_text` row.
   - Tests:
     - `check_test.ts:347` and `emit_test.ts:317-323` gain an `AlreadyExists` arm;
     - `EFFECTFUL` and `NEEDING` gain `create_text`;
     - `queries_test` "file" gains `create_directory` and `create_text`;
     - new io tests (section 4).
   - This commit must not depend on later ones. Reverting it later conflicts only on the `AlreadyExists` arm of `std.fs.describe`.
2. **`std.fs.describe`.**
   - std, runtime, the 7.8 row, the `std.fs.Error` doc (2.1).
   - `lines.alang`, `words.alang` and their `io_test` expectations; "file" gains `std.fs.describe`.
   - Decisions row (N4).
3. **`std.console.print`.** std, runtime, row, `EFFECTFUL`; `IO_PROGRAM` and `ENDING_PROGRAM` (section 4); decisions row (N9).
4. **`std.time.wait`.** std, runtime (`after`), row, `EFFECTFUL`; decisions row (N10); in the "Synchronous" row: "except `std.time.wait` and `std.http.send`, which wait in fact".
5. **`std.http.send` and `SendError`.**
   - Source: std (types, `Header` and `Response` docs), runtime (2.5).
   - Spec 7.8: the row and the types block.
   - Tests:
     - `spec_test` inventory → 17;
     - `queries_test`: `list("std.http")` becomes `Header, Request, Response, SendError, ServeError, send, serve`, and "PORT" gains `std.http.SendError`;
     - `EFFECTFUL` gains `send`;
     - the in-process http tests.
   - Decisions: rename the section "HTTP (`std.http`)" and add rows N1, N2, N5 to N8, N11.
6. **`std.http.describe`, `NET_PROGRAM` on both hosts, `examples/probe.alang`.**
   - Source: std and runtime; the row; `SendError` doc names `describe`.
   - Tests: `NET_PROGRAM` in `tests/io_program.ts`, its tests, and `emit_test` `PROGRAMS` (`net`, `probe`) and `writeEntry`.
   - `README.md`: one line, `deno task alang run examples/probe.alang -- http://localhost:8080/   # check URLs with std.http.send`.
   - `list("std.http")` pin gains `describe` (`…, ServeError, describe, send, serve`).
7. **Card and documents.**
   - The card (2.7).
   - Spec:
     - 7.1: the row "Waiting, an HTTP client, …" becomes "Binary files and binary HTTP content, renaming and copying files, the log without a line break", with "Instead": "A text file is copied or renamed with `std.fs.read_text`, `std.fs.create_text` or `write_text`, and `std.fs.remove`; `std.log.print_line` takes whole lines". The Concurrency row adds "`std.http.send` and `std.time.wait` hold the program until they return". A new row: "Taking URLs apart or encoding a query | Nothing yet; `std.string.cut` and `split` take a query apart, `std.string.join` builds one".
     - 7.7 "Console and log": `print`.
     - 7.8: the console and time sentences, and the http paragraph below.
   - `decisions.md`, "Left out": remove waiting and console output without a line break.
   - `notes.md`:
     - item 19, "Next", the test count;
     - the review list with N3 first;
     - mark as resolved: the ledger round's `AlreadyExists` item, "No std way to turn a `std.fs.Error` into text" in the wordcount and logstat rounds, and the 7.1 gaps;
     - a section "From std-net" with the host differences of section 1.

**The http paragraph for 7.8** (exact):

> `std.http.send` sends one request and returns when the whole response has arrived; nothing else runs meanwhile. It follows redirects as fetch does, at most 20 (a 303, and a 301 or 302 after a POST, continue as GET without content), and `timeout_milliseconds` covers the whole exchange, redirects and content included. What the program gives is checked before anything is sent: a method that is not capital letters, or CONNECT, TRACE or TRACK, content with GET or HEAD, a header HTTP manages itself (`connection`, `content-length`, `expect`, `host`, `keep-alive`, `te`, `trailer`, `transfer-encoding`, `upgrade`), and a header name or value `std.http.Header` refuses trap (`http`); a timeout below 1 traps (`requires`). Content `""` sends no body; other content is sent as UTF-8, as `text/plain; charset=utf-8` unless a `content-type` header says otherwise. `InvalidUrl` is decided before sending, alike on every host: not an absolute `http` or `https` URL as browsers read URLs, a user name or password in it, or a port the Fetch standard blocks (such as 25 or 6000). `Unreachable` means no connection: the name did not resolve, or the server refused. `TimedOut` comes from the program's own timeout. Anything else is `Failed` with the host's message: a broken connection, a TLS error, too many redirects, a redirect to anything but `http` or `https`, a status outside 200 to 599. The response's header names are lowercase and sorted, repeated ones joined with `, ` except `set-cookie`, which comes once per cookie; compressed content arrives decompressed, without the `content-encoding` and `content-length` headers that described it. Content is read as UTF-8, invalid bytes as U+FFFD, a leading byte order mark dropped. The hosts still differ in two ways: Node.js's fetch gives up connecting after 10 seconds (`Unreachable`) and waiting for headers or for more content after 300 seconds (`Failed`), whatever the timeout; Deno sends through a proxy named in `HTTP_PROXY` or `HTTPS_PROXY`. A handler of `std.http.serve` that sends to its own server waits for itself until the timeout, since requests are answered one at a time. Logic about responses goes into pure functions over `std.http.Response`, which examples can state.

The two Node limits and the Deno proxy are to verify. If they do not hold, drop the sentence.

## 4. Tests (about 20 new, plus adaptations)

**Commit 1** (`tests/io_test.ts`):
1. **`create_text`:**
   - `Ok`, and exactly the bytes written;
   - a second call is `AlreadyExists`, with the content unchanged;
   - a directory at the path is `AlreadyExists`;
   - on Linux, a link to a file and a broken link are `AlreadyExists`, and the link stays;
   - a missing parent and `""` are `NotFound`;
   - with `MODES`, a 0o555 directory is `PermissionDenied`.
2. **The create-directory test:** a file at the path becomes `AlreadyExists`; a file as a parent stays `Other`.
3. **`IO_PROGRAM`, after the two `create_directory` calls:**
   - calls: `create_text(work/sub/c.txt, "c")`, the same again, `create_directory(work/sub/c.txt)`, `read_text(work/sub/c.txt)`, `remove(work/sub/c.txt)`;
   - `IO_STDOUT` gains `Ok(Unit)`, `Err(AlreadyExists)`, `Err(AlreadyExists)`, `Ok("c")` and `Ok(Unit)`, alike on both hosts;
   - the trap test runs on `NEEDING`.

**Commit 2:**

4. **`std_test`:** `std$fs$describe` on all five cases.
5. **`check_test`:** `let t: String = std.fs.read_text(path: p) else return Err(std.fs.describe(error: error))` is clean in a `Result<Unit, String>` function.
6. **`lines.alang` and `words.alang`:** stderr shows `no such file or directory`.

**Commit 3** (`IO_PROGRAM` and `ENDING_PROGRAM`, both hosts, piped):
- `IO_PROGRAM` ends with `print("no line break, ")`, `print("")`, `print_line("then one")`, `print("last ä")`, so stdout ends `…no line break, then one\nlast ä`.
- `ENDING_PROGRAM` begins with `print("> ")`, so no arguments give `[1, "> ", "no input\n"]` and `given` gives `[0, "> given\n", ""]`. This checks a partial line before exit 1.

**Commit 4:**

7. **`wait` in-process:**
   - `await std$time$wait(50)` takes at least 49 ms (`performance.now`);
   - `wait(0)` resolves;
   - `wait(-1)` rejects with the trap `["requires", "std.time.wait", "milliseconds >= 0"]`.
8. **Chunking:** stub `globalThis.setTimeout` to record each delay and call back at once (restore it in `finally`). `wait(5_000_000_000)` records `[2_147_483_647, 2_147_483_647, 705_032_706]`.

**Commit 5** (`tests/http_test.ts`, in-process, against `serving()` or a raw `Deno.listen` server written in the test; close every socket, since the sanitizers check):

9. **A request through `std.http.serve`.** POST `/a/b?x=1`, header `X-Test: 1`, content `hello, wörld`, timeout 5000:
   - the handler sees POST, the path, `x=1`, the content, `x-test: 1` and `content-type: text/plain; charset=utf-8`;
   - the client gets status 201, `x-reply` and content `done`; ignore `date` and `vary`, which Deno's server adds.
10. **Response headers and compression (raw server).**
    - Response: `Set-Cookie: a=1`, `X-B: 1`, `x-a: 2`, `Set-Cookie: b=2`, `x-a: 3`, `Connection: close`, `Content-Length: 5`.
    - Expected headers: `connection`, `content-length`, `set-cookie` ×2 in order, `x-a: 2, 3`, `x-b`, sorted.
    - A gzip body (from `CompressionStream`) with `Content-Encoding: gzip` arrives decoded, without either header.
11. **Failures without a response:**
    - a handler held by a gate with a 100 ms timeout gives `TimedOut` in under 2 s;
    - a closed port from `freePort()` gives `Unreachable`;
    - `InvalidUrl` for: `not a url`, `/relative`, `ftp://127.0.0.1/`, `file:///etc/hostname`, `http://u:p@127.0.0.1:<port>/`, `http://127.0.0.1:25/` and `http://127.0.0.1:0/`;
    - the handler is called 0 times.
12. **Redirects:**
    - a 302 to `/target` gives the target's 200;
    - a 303 after a POST arrives as a GET with content `""`;
    - a 302 to `file:///etc/hostname` is `Failed` and returns no file content (to verify on Deno);
    - a redirect loop is `Failed`.
13. **Traps (`http` unless noted), and the handler is never called:**
    - methods `get`, `CONNECT` and `GE T`;
    - GET and HEAD with content;
    - header name `bad name`;
    - values `a\nb` and `😀` (`é` passes);
    - each name in `MANAGED`, written as `Host` and `CONTENT-LENGTH` too;
    - timeouts 0 and -1 (`requires`).
14. **A raw server's odd answers:**
    - status 600 is `Failed`;
    - a connection closed before the response is `Failed`;
    - a body cut short is `Failed`;
    - the body bytes `EF BB BF 61 FF` give content `"a�"`.
15. **The bad ports equal Node's** (skipped without Node):
    - every port in `BAD_PORTS` is refused by `node -e` fetch with cause "bad port";
    - a closed port not in the list gives `ECONNREFUSED`.
16. **Without `net`, Deno traps:** a program that sends, run with `effects: ["env", "console"]`, gives `[70, "effect", "std.http.send"]`.

**Commit 6:**

17. **`std_test`:** `std$http$describe` on all four cases.
18. **`NET_PROGRAM` alike on both hosts.** `tests/io_program.ts` gets module `client`, `main` with `net, env, console`, and its argument list holds the raw server's base URL and a closed URL. It prints `std.text.show` of each `send`:
    - `/headers`;
    - `/gzip`;
    - POST `/echo`, header `X-Test: 1`, content `ä` (the raw server echoes the method, path, `content-type`, `x-test` and the body);
    - `/redirect` (302 to `/headers`);
    - `/odd` (status 299);
    - `/latin`;
    - `/600`;
    - `/slow` with a 300 ms timeout;
    - the closed URL, `ftp://127.0.0.1/` and `http://127.0.0.1:25/`;
    - then `std.http.describe(error: std.http.TimedOut)`.

    The raw server runs in the test process. Stdout is compared exactly, as `IO_STDOUT`, after replacing `/Failed\(".*?"\)/` with `Failed`.
19. **`examples/probe.alang` on both hosts.** The example has four parts:
    - `retry`: a pure function, five arms, with examples;
    - `verdict`: a pure function, with examples such as `verdict(outcome: Err(std.http.TimedOut)) == "failed: timed out"`;
    - `fetch_once_more`: net and time, `send` with timeout 5000, and if `retry` says so, `wait(1000)` and a second `send`;
    - `main`: net, time, env, console; with no arguments, `Err("usage: probe <url>...")`; per URL, `print(url + " ... ")` and then `print_line(verdict(...))`.

    Against `/ok` (200), `/missing` (404), the closed URL and `ftp://example.com/`, it prints:
    `http://127.0.0.1:P/ok ... 200`, `http://127.0.0.1:P/missing ... 404`, `http://127.0.0.1:C/ ... failed: cannot reach the server`, `ftp://example.com/ ... failed: invalid URL`.

    Without arguments: `[1, "", "usage: probe <url>...\n"]`.

**Commit 7:** `card_test` passes (std names, 158 lines, bytes under 10,240).

## 5. Decisions

N continues the roadmap's N1–N3. None changes the grammar.

| # | Recommendation | Reason by principle | Alternative |
| --- | --- | --- | --- |
| N3 (approved, listed first for review) | `std.fs.Error` gains `AlreadyExists`, with `std.fs.create_text` (exclusive create). `EEXIST` maps in every fs function, so `create_directory` over a file is `AlreadyExists`, no longer `Other`. Every existing exhaustive `match` over the type now needs one more arm (E0213 names it) | 3.8 and E0227 freeze the cases at publishing; both hosts report `EEXIST` alike (observed); a lock file or a write that never overwrites cannot be written today; one mapping for every fs function | Map `EEXIST` in `create_text` only; or four cases and `Result<Bool, std.fs.Error>` |
| N1 | `std.http.SendError`: `InvalidUrl` and `TimedOut` decided by the runtime itself; `Unreachable` from Node's `cause.code` and Deno's message (connect or DNS phase); everything else `Failed: String` | 2.3; each case promised alike on both hosts; the message match follows the `/proc` precedent | Three cases without `Unreachable` (no message match); or one `std.http.Error` for server and client |
| N2 | The timeout is a parameter covering the whole exchange, redirects and content included; a chain of timers, so any Int ≥ 1 works; up to 20 redirects followed | 2.6: no defaults; 4: no setTimeout limit to know | A fixed timeout; manual redirects with the 3xx returned |
| N4 | `std.fs.describe(error)` and `std.http.describe(error)`: lower-case texts without a period (`no such file or directory`, `permission denied`, `is a directory`, `already exists`; `invalid URL`, `cannot reach the server`, `timed out`), and `Other`/`Failed` give their message | 3: the four-arm `match` three programs wrote, with the texts they chose; the label `error:` fits `else return Err(...describe(error: error))` | `error_text` or `message`; none for http until a program shows the need |
| N5 | `send(method, url, headers, content, timeout_milliseconds)` with `method` a `String`, reusing `Header` and `Response`, so pure functions over responses take the server's record | 3: one function for every method; 4.1: every part named; 5.1: responses in examples | A request record; `fetch`, `get` and `post`; a method variant |
| N6 | The program's mistakes trap (`http`, `requires`) before sending: method, GET/HEAD content, invalid headers, the nine headers HTTP manages, a timeout below 1. The environment's faults are `Err` | 5.3; the hosts disagree on exactly these (observed), so a trap gives one behaviour; the same split as `serve` | All as `Err(Failed)`, host-dependent |
| N7 | Response headers as fetch iterates them (sorted, joined, `set-cookie` apart); `content-encoding` and `content-length` dropped when content was decompressed; a status outside 200..599 is `Failed` | 3.7: one header list on both hosts (Deno drops the two, Node keeps them, observed); `Response`'s `where` holds by construction | Headers as each host gives them |
| N8 | The Fetch standard's bad ports are `InvalidUrl` on both hosts, decided by the runtime | Runtime neutrality (Node refuses them, Deno connects, observed) | Document the difference |
| N9 | `std.console.print(text)`, beside `print_line`, on the same stream | 3: the pair most languages have | `write` |
| N10 | `std.time.wait(milliseconds)`: the label carries the unit, as `timeout_milliseconds` does; 0 allowed, negative traps; the doc says "sleeps" so `search("sleep")` finds it | 4.1: the unit at every call; 3 | `wait_milliseconds(milliseconds:)` (the roadmap; the label repeats the name), `sleep` |
| N11 | Request content without `content-type` is sent as `text/plain; charset=utf-8`, the server's rule | 3: one rule for both directions | fetch's `text/plain;charset=UTF-8` |

## 6. Risks

- **N3 breaks programs.** Every four-arm `match` over `std.fs.Error` fails E0213, and so does every acceptance of a codebase holding one: the playground's `ledger`, `wordcount` and `logstat`.
- **Deno message matching.** A Deno release that rewords connect errors moves refusals from `Unreachable` to `Failed`; test 11 (closed port) catches it on Deno, test 18 on both hosts.
- **Host limits that remain:**
  - Node's undici limits: 10 s connect, 300 s headers and body;
  - Deno's proxy variables;
  - HTTPS is untested here (no certificate), and TLS failures are only `Failed`;
  - a redirect to a bad port fails on Node but not on Deno.
- **The first runtime functions that really wait.** Test sanitizers watch timers, fetch bodies and the raw sockets; each test must cancel and close them. One-at-a-time `serve` plus a self-send waits until the timeout.
- **`print` bypasses `console.log`.**
  - The MCP redirect (`mcp.ts:571`) does not cover it; harmless while effects never run there.
  - Ordering with `print_line` on Deno relies on both writes being synchronous; tested on pipes.
  - On macOS, Node writes to pipes asynchronously, so `process.exit` (an `Err` main, a trap) may cut output. This already holds for `console.log`.
- **Long docs.** The `send` doc is about 700 characters (W1), and `list("std.http")` grows.
- **Drift.** The bad-port list may drift from Node's; test 15 pins it.

## 7. Playground round

**Setup.**
- An empty codebase. The old export no longer checks after N3, and moving or deleting it is the user's call: ask, or start a new playground directory.
- The playground's MCP server on the merged `main`.
- The playground's `CLAUDE.md`:
  - MCP tools for all alang code and std lookup;
  - Bash only for `alang db run` and for looking at the files the programs write;
  - no reading of the alang repository or `alang-specs.md`;
  - no advisor.

**Prompt to paste:**

> Build two command-line programs in alang with the alang MCP tools, in modules you name yourself, and run them against each other on this machine; no internet is needed.
> 1. A stock server, started as `alang db run <server main> -- <port>`, listens on `127.0.0.1` at that port. `GET /stock?item=<name>` answers 200 with the item's count as plain text (`apple` 3, `pear` 0, `plum` 12), 404 with `unknown item` for any other name, and 400 for a request without a well-formed `item=` query. Every other path is 404.
> 2. A client, `alang db run <client main> -- <base url> <report file> <item>...`, asks the server about each item in order. For each it first prints `<item>: ` without a line break, then on the same line the count, `unknown`, or `failed: <reason>`. A request that cannot connect or gets no response within 2 seconds is tried once more after half a second. At the end it writes these lines to the report file, but only if that file does not exist yet; otherwise it ends with `report exists: <file>` on stderr and exit code 1. Any other file error ends it with `cannot write <file>: <reason>`, the reason in words such as `permission denied`. Without enough arguments it prints a usage line to stderr and exits with code 1.
>
> Keep the logic in pure functions with examples. Start the server in the background, run the client for `apple pear kiwi` with a new report file, then again with the same report file, then once against a port where nothing listens with another new report file. Show me each output, the reports and the exit codes, and stop the server at the end.

**Expected results.**
- First run: `apple: 3`, `pear: 0`, `kiwi: unknown`, with the same three lines in the report; exit 0.
- Second run: the same stdout, then `report exists: …` on stderr; exit 1.
- Third run: each item `failed: …` after one retry, about 1.5 s in total, and a report of three `failed` lines.

**Discovery check (expected hits).**
- `search`, by word:
  - "sleep" → `std.time.wait`;
  - "wait" → `wait`, `send`;
  - "fetch" → `send`, `SendError`;
  - "timeout" → `send`, `SendError`;
  - "overwrite" → `create_text`;
  - "exist" → `kind`, `create_directory`, `create_text`, `std.fs.describe`;
  - "prompt" → `console.print`;
  - "message" → both `describe` functions, `std.fs.Error`, `SendError`.
- `search_type`:
  - `Int -> Unit` → `wait`;
  - `Error -> String` → `std.fs.describe`;
  - `SendError -> String` → `std.http.describe`;
  - `String, String -> Result<Unit, _>` → `write_text`, `append_text`, `create_text`.

**What to observe.**
1. **Discovery.**
   - Does it call `card`, then `list("std.http")`, `list("std.time")` and `list("std.fs")`?
   - Log every `search` and `search_type` word. No round has used them yet.
   - Count std `context` calls; the target, now that hits carry signatures, is near zero.
   - Record guessed names that fail with E0201: `std.http.get`, `fetch`, `post`, `std.time.sleep`, `std.console.write`.
2. **The exclusive create.** `std.fs.create_text` with `Err(std.fs.AlreadyExists)`, or a `std.fs.kind` test first (the ledger round's way, which leaves a race)?
3. **Error text.** `std.fs.describe` and `std.http.describe`, or a hand-written `match` again? Does the card's `main` line carry it?
4. **http mistakes.** Method case, GET with content, `headers: []` (E0228 and its fix), a `host` header, the query parsed with `std.string.cut`. Any trap at run time?
5. **The prompt line.** `print` followed by `print_line` on one line; is the output right when piped?
6. **Retry shape.** Is the decision pure with examples, does it match `SendError` with five arms (E0227 or E0213 on the way), and is `wait` called in the effectful part?
7. **Effort.** Diagnostics per submit (codes), number of tool calls, time, and whether the first submit is accepted.
8. **Correctness.** Exit codes, the report contents, the 400 cases (no query, `item` without `=`), and the server ending cleanly on SIGTERM.

### Critical Files for Implementation
- /home/josua/coding_projects/alang/src/runtime.ts
- /home/josua/coding_projects/alang/src/std.ts
- /home/josua/coding_projects/alang/tests/http_test.ts
- /home/josua/coding_projects/alang/tests/io_test.ts (with /home/josua/coding_projects/alang/tests/io_program.ts)
- /home/josua/coding_projects/alang/alang-specs.md (7.1, 7.7, 7.8), with /home/josua/coding_projects/alang/src/card.ts and /home/josua/coding_projects/alang/docs/decisions.md
