// `alang db`: the queries and operations of section 6 on the command line,
// with JSON output. A thin layer over `Codebase`; the MCP server will be
// another.
//
//   alang db [--dir <dir>] <command> ...       (default dir: the current one)
//
//   definition <name>         signature <name>         context <name>
//   callers <name>            list [<module>]          search <text>
//   search-type <pattern>     history <name>
//
//   add <file>                       the text of one definition ("-": stdin)
//   replace <name> <hash> <file>
//   remove <name> <hash>
//   rename <name> <hash> <to> [<file>]  with a file: its text is the changed
//                                    definition under the new name
//   submit <file>                    a JSON array of changes, one transaction:
//                                    {"op": "add", "text": ...}, {"op": "replace",
//                                    "name", "hash", "text"}, {"op": "remove", "name",
//                                    "hash"}, {"op": "rename", "name", "hash", "to"}
//                                    (optionally with "text")
//   export [--force]                 rewrite export/ from the database; without
//                                    --force, files changed since the last write
//                                    are imported first, not overwritten
//   import [<dir>]                   rebuild the database from export/ (or <dir>)
//
// Every command prints one JSON value. Operations print the submit result and
// exit with 1 if it was rejected; a query on an unknown name prints its
// diagnostics on stderr and exits with 1. Before a query, the database is
// brought in step with the export (`Codebase.sync`); if that fails, the query
// answers from the database and the diagnostics go to stderr.

import { type Change, Codebase, type ExportResult, type SubmitResult } from "./codebase.ts";

export const DB_USAGE = "usage: alang db [--dir <dir>] <definition|signature|context|callers|list|search|" +
  "search-type|history|add|replace|remove|rename|submit|export|import> ...";

async function readText(path: string): Promise<string> {
  return path === "-" ? await new Response(Deno.stdin.readable).text() : await Deno.readTextFile(path);
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function result(r: SubmitResult | ExportResult): number {
  print(r);
  return r.ok ? 0 : 1;
}

// Parses and checks the changes of a `submit` file; throws on a malformed one.
function changesOf(json: unknown): Change[] {
  if (!Array.isArray(json)) throw new Error("submit: the file holds a JSON array of changes.");
  const fields: Record<string, string[]> = {
    add: ["text"],
    replace: ["name", "hash", "text"],
    remove: ["name", "hash"],
    rename: ["name", "hash", "to"],
  };
  return json.map((c, i) => {
    const needed = fields[c?.op];
    const optional = c?.op === "rename" && c.text !== undefined ? ["text"] : [];
    if (!needed || ![...needed, ...optional].every((f) => typeof c[f] === "string")) {
      throw new Error(
        `submit: change ${i} is not one of ${JSON.stringify(fields)} with string fields (a rename may add "text").`,
      );
    }
    return c as Change;
  });
}

const QUERIES = new Set(["definition", "signature", "context", "callers", "list", "search", "search-type", "history"]);

export async function dbMain(args: string[]): Promise<number> {
  let dir = ".";
  if (args[0] === "--dir") {
    dir = args[1];
    args = args.slice(2);
  }
  const [command, ...rest] = args;
  const arity: Record<string, [number, number]> = {
    definition: [1, 1],
    signature: [1, 1],
    context: [1, 1],
    callers: [1, 1],
    list: [0, 1],
    search: [1, 1],
    "search-type": [1, 1],
    history: [1, 1],
    add: [1, 1],
    replace: [3, 3],
    remove: [2, 2],
    rename: [3, 4],
    submit: [1, 1],
    export: [0, 1],
    import: [0, 1],
  };
  const range = arity[command];
  const usage = !range || rest.length < range[0] || rest.length > range[1] ||
    (command === "export" && rest.length === 1 && rest[0] !== "--force");
  if (!dir || usage) {
    console.error(DB_USAGE);
    return 2;
  }

  const cb = await Codebase.open(dir);
  try {
    const [a, b, c, d] = rest;
    if (QUERIES.has(command)) {
      const synced = await cb.sync();
      if (!synced.ok) {
        console.error(JSON.stringify(
          {
            warning: "The database could not be brought in step with the export; answering from the database.",
            diagnostics: synced.diagnostics,
          },
          null,
          2,
        ));
      }
    }
    switch (command) {
      case "definition":
        print(cb.definition(a));
        return 0;
      case "signature":
        print(cb.signature(a));
        return 0;
      case "context":
        print(cb.context(a));
        return 0;
      case "callers":
        print(cb.callers(a));
        return 0;
      case "list":
        print(cb.list(a ?? ""));
        return 0;
      case "search":
        print(cb.searchText(a));
        return 0;
      case "search-type":
        print(cb.searchType(a));
        return 0;
      case "history":
        print(cb.history(a));
        return 0;
      case "add":
        return result(await cb.submit([{ op: "add", text: await readText(a) }]));
      case "replace":
        return result(await cb.submit([{ op: "replace", name: a, hash: b, text: await readText(c) }]));
      case "remove":
        return result(await cb.submit([{ op: "remove", name: a, hash: b }]));
      case "rename":
        return result(
          await cb.submit([{
            op: "rename",
            name: a,
            hash: b,
            to: c,
            ...(d === undefined ? {} : { text: await readText(d) }),
          }]),
        );
      case "submit":
        return result(await cb.submit(changesOf(JSON.parse(await readText(a)))));
      case "export":
        return result(await cb.exportAll({ force: a === "--force" }));
      case "import":
        return result(await cb.importAll(a));
    }
    return 2;
  } finally {
    cb.close();
  }
}
