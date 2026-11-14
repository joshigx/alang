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
  "",
].join("\n");
export const IO_STDERR = "to the log\n";

// A `main` that ends with an error: without an argument, `Err` with a
// message for stderr and exit code 1.
export const ENDING_PROGRAM = `fn ending.main
  doc: "Prints its first argument; without one, ends with an error."
  in: none
  out: Result<Unit, String>
  effects: env, console
  requires: none
  ensures: none
  examples: none
  body:
    let first: String = std.list.get(list: std.env.args(), index: 0) else return Err("no input")
    std.console.print_line(text: first)
    return Ok(Unit)
end fn ending.main
`;
