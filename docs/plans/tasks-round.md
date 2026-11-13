# Playground round: `tasks` (2026-11-14)

The round after `logstat-fixes`. It runs on `main` at `9c15790` or later, before `std-net` is built, from an empty
codebase: the user moved the playground's `alang.db` to `alang.db.bak` and `export/` to `export.bak` (the export is the
source of truth, so moving only the database would have restored the old programs at the first sync). New Claude Code
session in `~/coding_projects/alang-playground`, advisor off, fresh MCP server.

## What it checks

1. **The card alone teaches `main`, files and file errors.** The logstat round could not show it: its database held
   `ledger`, and the model copied `ledger.fs_problem`.
2. **Signatures in hits.** std `context` calls should drop from 21 (logstat round) to near zero, left only for
   examples or uses, now that `list` and `search` hits carry `signature` (commit `4c67e79`).
3. **`search` and `search_type`.** No round has used them yet; log every word and type tried.
4. **Correctness:** the number alignment in `list`, the file left unchanged after a malformed line, exit codes and
   stderr texts.
5. **Effort:** tool calls by kind, diagnostics per submit (codes, whether the `fix` helped), time, output tokens, and
   whether the first submit is accepted.

## Prompt as pasted

> Build `tasks`, a command-line to-do list in alang, using the alang MCP tools; choose the module name yourself. It
> keeps its tasks in the file `tasks.txt` in the current directory, one task per line, written `[ ] <text>` for an open
> task and `[x] <text>` for a done one. A missing file means no tasks yet. It is started as
> `alang db run <main> -- <command> ...`:
>
> - `add <words...>`: appends a task whose text is the words joined by single spaces, and prints `added <n>: <text>`,
>   where `n` is its number (tasks are numbered from 1 in file order).
> - `list`: prints one line per task, `<n>. [ ] <text>` or `<n>. [x] <text>`, with the numbers right-aligned to the
>   width of the largest number, then a last line `<open> open, <done> done`.
> - `done <n>`: marks task `n` done and prints `done <n>: <text>`; if it was already done, it prints
>   `already done: <text>` instead.
> - `clear`: removes all done tasks and prints `removed <k>`.
>
> Errors go to stderr with exit code 1: no command or an unknown one prints
> `usage: tasks add <text> | list | done <n> | clear`; a missing or invalid number, or no such task, prints
> `no task <arg>`; a line in `tasks.txt` without the format above prints `tasks.txt line <k> is malformed` and leaves
> the file unchanged; any other file problem prints a one-line message. Keep the logic in pure functions with
> examples. Then run: add three tasks, list, mark the second done, list, clear, list, and one error case of your
> choice, and show me all the output.

## After the round

1. A fresh Opus agent analyzes the newest transcript in
   `~/.claude/projects/-home-josua-coding-projects-alang-playground/` against the points above, the same way as the
   logstat round (see "From the logstat round" in `docs/notes.md`): every tool call listed, an independent reference
   implementation (Python) with edge cases (empty file, a missing final newline, CRLF, `done 0`, `done 01`, `done -1`,
   `done 2x`, ten or more tasks for the alignment, a malformed line in the middle), reruns only in a scratch copy, never
   in the playground, and a ranked "fix now" / "later" list naming the files to touch. Read-only.
2. Fresh agents fix the "fix now" items on a branch; the main session verifies, merges, records the round in the notes.
3. Then phase `std-net` from `docs/plans/std-net.md`, implemented by a fresh Opus agent on branch `std-net`. Its
   playground round (plan section 7) needs an empty codebase again: ask the user to move `export/` and `alang.db`
   aside before it.
