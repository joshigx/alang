// Programs that io_test.ts runs on Deno and Node.js, and whose output
// emit_test.ts has TypeScript check.

// Calls every std function for files and program input once or more,
// printing each result.

const CALLS = [
  "std.env.args()",
  'std.fs.create_directory(path: "work/sub")',
  'std.fs.create_directory(path: "work/sub")',
  'std.fs.create_text(path: "work/sub/c.txt", text: "c")',
  'std.fs.create_text(path: "work/sub/c.txt", text: "again")',
  'std.fs.create_directory(path: "work/sub/c.txt")',
  'std.fs.read_text(path: "work/sub/c.txt")',
  'std.fs.remove(path: "work/sub/c.txt")',
  'std.fs.write_text(path: "work/sub/a.txt", text: "first\\n")',
  'std.fs.append_text(path: "work/sub/a.txt", text: "second ä")',
  'std.fs.read_text(path: "work/sub/a.txt")',
  'std.fs.write_text(path: "work/sub/a.txt", text: "new")',
  'std.fs.read_text(path: "work/sub/a.txt")',
  'std.fs.write_text(path: "work/missing/a.txt", text: "x")',
  'std.fs.write_text(path: "work/sub", text: "x")',
  'std.fs.append_text(path: "work/b.txt", text: "b")',
  'std.fs.list_directory(path: "work")',
  'std.fs.list_directory(path: "work/missing")',
  'std.fs.kind(path: "work/sub")',
  'std.fs.kind(path: "work/b.txt")',
  'std.fs.kind(path: "work/missing")',
  'std.fs.remove(path: "work/b.txt")',
  'std.fs.remove(path: "work/b.txt")',
  'std.fs.remove(path: "work/sub/a.txt")',
  'std.fs.remove(path: "work/sub")',
  'std.fs.list_directory(path: "work")',
  'std.env.get(name: "ALANG_IO_TEST")',
  'std.env.get(name: "ALANG_IO_TEST_UNSET")',
  "std.console.read_line()",
  "std.console.read_line()",
  "std.console.read_line()",
];

export const IO_PROGRAM = [
  "fn io.main",
  '  doc: "Calls each function for files and program input and prints what it returns."',
  "  in: none",
  "  out: Unit",
  "  effects: fs.read, fs.write, env, log, console",
  "  requires: none",
  "  ensures: none",
  "  examples: none",
  "  body:",
  ...CALLS.map((call) => `    std.console.print_line(text: std.text.show(value: ${call}))`),
  '    std.log.print_line(text: "to the log")',
  '    std.console.print(text: "no line break, ")',
  '    std.console.print(text: "")',
  '    std.console.print_line(text: "then one")',
  '    std.console.print(text: "last ä")',
  "    return Unit",
  "end fn io.main",
  "",
].join("\n");

// How IO_PROGRAM is started, and what it prints, on every host.
export const IO_ARGS = ["one", "two words", "--flag"];
export const IO_STDIN = "first ä\r\nsecond";
export const IO_ENV = { ALANG_IO_TEST: "x y" };
export const IO_STDOUT = [
  '["one", "two words", "--flag"]',
  "Ok(Unit)",
  "Ok(Unit)",
  "Ok(Unit)",
  "Err(AlreadyExists)",
  "Err(AlreadyExists)",
  'Ok("c")',
  "Ok(Unit)",
  "Ok(Unit)",
  "Ok(Unit)",
  'Ok("first\\nsecond ä")',
  "Ok(Unit)",
  'Ok("new")',
  "Err(NotFound)",
  "Err(IsADirectory)",
  "Ok(Unit)",
  'Ok(["b.txt", "sub"])',
  "Err(NotFound)",
  "Ok(Directory)",
  "Ok(File)",
  "Err(NotFound)",
  "Ok(Unit)",
  "Err(NotFound)",
  "Ok(Unit)",
  "Ok(Unit)",
  "Ok([])",
  'Some("x y")',
  "None",
  'Some("first ä")',
  'Some("second")',
  "None",
  "no line break, then one",
  "last ä",
].join("\n");
export const IO_STDERR = "to the log\n";

// A `main` that ends with an error: without an argument, `Err` with a
// message for stderr and exit code 1. The prompt before it is a partial
// line, which must reach stdout before the exit.
export const ENDING_PROGRAM = `fn ending.main
  doc: "Prints a prompt and its first argument; without one, ends with an error."
  in: none
  out: Result<Unit, String>
  effects: env, console
  requires: none
  ensures: none
  examples: none
  body:
    std.console.print(text: "> ")
    let first: String = std.list.get(list: std.env.args(), index: 0) else return Err("no input")
    std.console.print_line(text: first)
    return Ok(Unit)
end fn ending.main
`;

// A client that sends to a server the test runs, given its base URL and a
// URL where nothing listens, and prints every outcome: the same text on
// every host.
export const NET_PROGRAM = `fn client.main
  doc: "Sends requests to the server whose base URL is the first argument and prints each outcome."
  in: none
  out: Result<Unit, String>
  effects: net, env, console
  requires: none
  ensures: none
  examples: none
  body:
    let args: List<String> = std.env.args()
    let base: String = std.list.get(list: args, index: 0) else return Err("usage: client <base url> <closed url>")
    let closed: String = std.list.get(list: args, index: 1) else return Err("usage: client <base url> <closed url>")
    let plain: List<std.http.Header> = std.list.empty<std.http.Header>()
    std.console.print_line(text: std.text.show(value: std.http.send(method: "GET", url: std.string.concat(left: base, right: "/headers"), headers: plain, content: "", timeout_milliseconds: 5000)))
    std.console.print_line(text: std.text.show(value: std.http.send(method: "GET", url: std.string.concat(left: base, right: "/gzip"), headers: plain, content: "", timeout_milliseconds: 5000)))
    std.console.print_line(text: std.text.show(value: std.http.send(method: "POST", url: std.string.concat(left: base, right: "/echo"), headers: [std.http.Header(name: "X-Test", value: "1")], content: "ä", timeout_milliseconds: 5000)))
    std.console.print_line(text: std.text.show(value: std.http.send(method: "GET", url: std.string.concat(left: base, right: "/redirect"), headers: plain, content: "", timeout_milliseconds: 5000)))
    std.console.print_line(text: std.text.show(value: std.http.send(method: "GET", url: std.string.concat(left: base, right: "/odd"), headers: plain, content: "", timeout_milliseconds: 5000)))
    std.console.print_line(text: std.text.show(value: std.http.send(method: "GET", url: std.string.concat(left: base, right: "/latin"), headers: plain, content: "", timeout_milliseconds: 5000)))
    std.console.print_line(text: std.text.show(value: std.http.send(method: "GET", url: std.string.concat(left: base, right: "/600"), headers: plain, content: "", timeout_milliseconds: 5000)))
    std.console.print_line(text: std.text.show(value: std.http.send(method: "POST", url: std.string.concat(left: base, right: "/closed"), headers: plain, content: "x", timeout_milliseconds: 5000)))
    std.console.print_line(text: std.text.show(value: std.http.send(method: "GET", url: std.string.concat(left: base, right: "/slow"), headers: plain, content: "", timeout_milliseconds: 300)))
    std.console.print_line(text: std.text.show(value: std.http.send(method: "GET", url: closed, headers: plain, content: "", timeout_milliseconds: 5000)))
    std.console.print_line(text: std.text.show(value: std.http.send(method: "GET", url: "ftp://127.0.0.1/", headers: plain, content: "", timeout_milliseconds: 5000)))
    std.console.print_line(text: std.text.show(value: std.http.send(method: "GET", url: "http://127.0.0.1:25/", headers: plain, content: "", timeout_milliseconds: 5000)))
    std.console.print_line(text: std.http.describe(error: std.http.TimedOut))
    return Ok(Unit)
end fn client.main
`;
