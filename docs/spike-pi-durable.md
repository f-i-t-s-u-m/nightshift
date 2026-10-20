# Spike: Pi Durable

Goal: decide in 1-2 days whether Pi Durable is a safe base for Nightshift.

## Setup

- Node 22+, a fresh TypeScript project in this repo.
- `@earendil-works/pi-durable` and `@earendil-works/pi-ai`, versions pinned.
- SQLite storage.
- One clone of the target repo and one worktree for the test task.
- A Claude API key and an OpenAI API key.

## Build

1. A `bash` tool that runs only inside the worktree, honours the abort signal and has a timeout.
2. `read_file` and `edit_file` tools limited to the worktree. First check whether Pi's own coding tools can be loaded into Pi Durable instead.
3. A `create_pr` step in our own code: `gh pr list --head <branch>` first, then `gh pr create` only if none exists.
4. A small runner that starts one session for one task and prints events and usage.

## Tests and pass criteria

| # | Test | Pass when |
|---|---|---|
| 1 | Finish one small real task (a typo-level or one-file change) | A correct commit on the branch |
| 2 | Kill the process (`SIGKILL`) in the middle of a long `bash` command, then restart | The session resumes from its checkpoint and finishes; the interrupted command is handled sensibly |
| 3 | Kill the process right after the PR is created, then restart | Exactly one PR exists |
| 4 | Send an extra message into a running session (simulated review comment) | The agent acts on it on the same branch |
| 5 | Send the same message twice with the same `operationId` | It is processed once |
| 6 | Read usage for the session | Input, cached and output tokens per model call are available |
| 7 | Run the same task with an OpenAI model | It works through `pi-ai` without code changes outside configuration |
| 8 | Three sessions at once on three worktrees | No interference; each resumes after a kill |
| 9 | Check MCP | Whether an MCP server's tools can be used from a Pi Durable extension |

## Decision

- All of 1-6 pass: build M1 on Pi Durable.
- 2, 3 or 5 fail: do not build on it; switch to the Claude Agent SDK behind `AgentRunner`.
- Only 7, 8 or 9 fail: build on it and work around or report upstream.

Record the results and the versions used at the bottom of this file.

## Results

### Run 1: 2026-10-17, scripted model (no API key)

Versions: `@earendil-works/pi-durable` 1.3.0, `pi-ai` 1.3.0, `chord` 1.3.0, Node 26.5.0, macOS. SQLite storage. The model is pi-ai's faux provider with scripted responses, so these tests check the harness, not model quality.

Run with `npm run spike` (all scenarios) or `npm run spike -- <scenario>`. Code in `spike/`; run folders in `.nightshift/spike-runs/` (gitignored). Run twice with the same results.

| # | Test | Scenario | Result |
|---|---|---|---|
| 2 | Kill mid-`bash`, restart | `long-bash` | ✅ Session resumed and settled `done`. The model got `Tool bash was interrupted and may have partially run`; bash was not re-run. ⚠️ **The killed process's shell kept running and finished its command** (the marker file was written after the kill). See finding F1 |
| 3 | Kill right after PR creation, restart | `pr-safe` | ✅ One PR. The replay-safe tool re-ran on resume, found the PR by branch and did not create another |
| 3b | Same, tool without the existence check | `pr-naive` | ❌ as expected: **two PRs**. Confirms rule 3 in [pi-durable.md](pi-durable.md) |
| 4 | Message into a running session | `steer` | ✅ The steer was placed right after the running tool round and answered in the same run |
| 5 | Same `requestId` twice | `dedupe` | ✅ Same submission id returned; one user entry in the transcript |
| 6 | Usage | all | ✅ Tokens per model (input, output, cache read/write) in `harness.usage()`, kept across the crash. ⚠️ Cost stayed 0 with the faux provider; dollar cost needs the real-model run |
| 8 | Three sessions at once, kill, restart | `parallel` | ✅ All three resumed and settled. ⚠️ Their result files were written by the orphaned shells from F1, not by resumed work |
| 9 | MCP | (reading) | Pi Durable has no built-in MCP client. MCP tools are added as our own tools (an MCP SDK client wrapped with `defineTool`), optionally `deferred` with the `tool_search` extension for large sets |
| – | Keep file tools inside the worktree | `confine` | ✅ Without a guard, `read` accepts absolute paths. A `beforeTool` hook blocked `read /etc/hosts`; the model got a "blocked" error result |

### Findings

- **F1. Orphaned commands keep running after a crash.** `SIGKILL` on the Nightshift process does not kill the shells its `bash` tool started. After restart, the model is told the command "may have partially run" while it is in fact still running and may finish later, racing the resumed work. Fix before M2: start each command in its own process group and record its pid per task; on startup kill leftover groups before `resume()`. A container per task (M5) removes the problem fully.
- **F2. Built-in tools are not confined to `cwd`.** `cwd` sets where relative paths resolve, nothing more. Nightshift must install the path guard hook (as in `spike/lib.ts`) and, for `bash`, rely on a container or OS sandbox later.
- **F3. Replay-safe needs a real existence check.** Marking a tool `replay: "safe"` without one duplicated the PR. Every side-effect tool checks the real state first.
- **F4. The API is wide and works as documented.** Durable sessions, steering, `requestId`, usage, hooks, per-conversation `cwd`, the `bash`/`read`/`write`/`edit` tools and SQLite storage all behaved as the README says.

### Still to run (needs API keys)

| # | Test | How |
|---|---|---|
| 1 | Finish one small real task | `npm run spike:real` |
| 6 | Dollar cost per run | `npm run spike:real` |
| 7 | Same task with OpenAI | `npm run spike:real` with `OPENAI_API_KEY` set |

Put the keys in `.env` (copy `.env.example`; `.env` is gitignored). The script creates a small git repo with a failing test per provider, asks the agent to fix it, then checks `node --test` itself rather than trusting the agent's answer, and prints the diff, time and usage.

### Decision so far

Tests 2, 3, 5 pass, so by the rule above Pi Durable stays the base. F1 and F2 are Nightshift's to fix and go into M1/M2. Final decision after the real-model run.
