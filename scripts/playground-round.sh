#!/bin/sh
# Runs one automated playground round: a fresh headless Claude Code session that writes alang
# through the alang MCP tools, from an empty codebase, against a pinned alang commit.
#
# usage: scripts/playground-round.sh <name> <commit> <prompt-file> [model]
#
# Everything goes to $ALANG_ROUNDS/<name>/ (default ~/coding_projects/alang-rounds): work/ is the
# playground (its own CLAUDE.md, alang.db, export/), wt/ a git worktree of <commit> that serves the
# MCP server and the `alang` command on the session's PATH, result.json the session's result,
# session.txt its id. The transcript is in ~/.claude/projects/<work/ with / as ->/<session>.jsonl.
# The session runs restricted: the alang MCP tools, `alang` and a few read-only shell commands,
# and file tools inside work/ only, so it cannot read the repository or the spec.
# Afterwards remove the worktree: git worktree remove --force <base>/wt
set -eu
name=$1
commit=$2
prompt=$3
model=${4:-opus}
repo=$(cd "$(dirname "$0")/.." && pwd)
rounds=${ALANG_ROUNDS:-$HOME/coding_projects/alang-rounds}
base=$rounds/$name
work=$base/work
wt=$base/wt
[ -e "$base" ] && { echo "exists: $base" >&2; exit 2; }
mkdir -p "$work/bin"
git -C "$repo" worktree add --detach "$wt" "$commit" >/dev/null 2>&1
cat >"$work/CLAUDE.md" <<'EOF'
Write and change alang only through the alang MCP tools. Call the `card` tool first for the language rules, and find standard-library functions with `list("std")`, `search` and `context`. Do not read the alang repository or its spec file; the card and the tools are meant to be enough, and finding out where they are not is part of the test.

To run the program, run `alang db run` in this directory (`alang db run <module>.main` if there are several `main` functions). It prints the program's output; diagnostics come as JSON on stderr.

Arguments for the program go after `--`: `alang db run <module>.main -- in.txt out.txt`.

Shell commands allowed in this session: `alang ...`, `cat`, `ls`, `printf`, `echo`, `mkdir` and `cd`, one command per call or several joined with `;`. Others (`rm`, loops such as `for`, shell functions, scripts) are refused; use the file tools instead.

Redirections (`>`, `>>`, `2>`) are refused too: stdout and stderr arrive together, and `echo $?` after a run gives its exit code; to create or extend a file, use the file tools (Write, Edit).
EOF
cat >"$work/bin/alang" <<EOF
#!/bin/sh
exec deno run --allow-read --allow-write --allow-run --config $wt/deno.json 'file://$wt/src/cli.ts' "\$@"
EOF
chmod +x "$work/bin/alang"
cat >"$base/mcp.json" <<EOF
{"mcpServers": {"alang": {"type": "stdio", "command": "deno",
  "args": ["run", "--allow-read", "--allow-write", "--allow-run", "$wt/src/cli.ts", "mcp", "--dir", "$work"]}}}
EOF
session=$(python3 -I -c 'import uuid; print(uuid.uuid4())')
echo "$session" >"$base/session.txt"
git -C "$wt" rev-parse HEAD >"$base/commit.txt"
cp "$prompt" "$base/prompt.md"
cd "$work"
start=$(date +%s)
set +e
env -u CLAUDECODE PATH="$work/bin:$PATH" timeout 2400 claude -p "$(cat "$base/prompt.md")" \
  --model "$model" \
  --append-system-prompt "$(cat "$work/CLAUDE.md")" \
  --restricted --tools "Bash,Read,Write,Edit,Glob,Grep,TaskStop" \
  --mcp-config "$base/mcp.json" --strict-mcp-config \
  --permission-mode dontAsk --permission-prompts none \
  --allowedTools "mcp__alang__*" "Bash(alang *)" "Bash(cat *)" "Bash(ls *)" "Bash(printf *)" \
  "Bash(echo *)" "Bash(mkdir *)" "Bash(cd *)" "Read" "Write" "Edit" "Glob" "Grep" \
  --session-id "$session" --output-format json </dev/null >"$base/result.json" 2>"$base/stderr.txt"
code=$?
set -e
# A program the session left running (a server started in the background) ends with the round.
pkill -f "$wt/src/cli.ts" 2>/dev/null || true
# --restricted ignores project instructions, so CLAUDE.md goes in through --append-system-prompt;
# check that it reached the model.
transcript=$HOME/.claude/projects/$(printf %s "$work" | sed 's|[/._]|-|g')/$session.jsonl
if grep -q "the card and the tools are meant to be enough" "$transcript" 2>/dev/null; then
  instructions=sent
else
  instructions=MISSING
fi
echo "exit=$code seconds=$(($(date +%s) - start)) session=$session instructions=$instructions" |
  tee "$base/done.txt"
