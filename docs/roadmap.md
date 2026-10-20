# Roadmap

## Status (2026-10-17)

| Milestone | State |
|---|---|
| M0 spike | Passed with a scripted model; real-model run still owed (`bun run spike:real`) |
| M1 one task, one PR | Built. WonderCall MCP source (against the mock), worktrees, Pi runner, checks judged against base, idempotent push and PR |
| M1-WC WonderCall `/mcp` | Not started (WonderCall repo) |
| M2 24/7 loop | Built. launchd service, slots, leases, PR watcher (CI per commit, reviews, comments, merge, close), Needs info pause and resume, budgets, kill switch, orphan-process cleanup on restart |
| M3 dashboard and usage | Built. Overview, board, run timeline, usage, controls; CLI equivalents |
| M4, M5 | Not started |

Verified by `bun run e2e` (13 checks: claim → PR, question → answer → PR, inbound task ignored, CI failure fix round, review comment round, green CI → ready for review, merge → done, crash mid-command → orphan killed and one PR, kill switch, usage, dashboard served, foreign Host refused).

Added 2026-10-17 (later): projects, Nightshift-native tasks, operator messages with pictures, shadcn dashboard with a VS Code–style workspace (files + Monaco, source control, Actions, preview link, per-worktree Postgres via Docker or an existing server), plan mode, AI reviewer gate, live agent event stream. `bun run e2e`: 33 checks, including Docker, import analysis, settings edits, starters and commit diffs.

Backlog from this round:
- Preview log tail/cursor; an explicit `awaitingPlanApproval` flag.
- Pi Durable: subagents for exploration, forks for retries, child tasks for the orchestrator's own steps, `wrapTool` metrics, a progress/todo document, manual compaction before fix rounds.
- Container per task for `bash` and previews.

Open before first real use:
- Run `bun run spike:real` with API keys and one real task on a scratch GitHub repo (`git.host: "github"`).
- Build the WonderCall `/mcp` endpoint; until then the daemon can only talk to the mock.
- A per-task container for `bash` (today: path guard, command blocklist and process cleanup only).

## M0. Pi Durable spike (1-2 days)

Prove Pi Durable can carry the product. Plan and pass criteria in [spike-pi-durable.md](spike-pi-durable.md). If it fails, use the Claude Agent SDK behind the same `AgentRunner` interface.

## M1. One task, one PR (about 1 week)

- `nightshift run <task-id>` in the foreground.
- WonderCall task source. Until the WonderCall `/mcp` endpoint exists, a stub source that reads a task from a local markdown file.
- Worktree per task, Pi Durable session, coding tools, `run_checks`.
- Push and PR creation done by Nightshift's code, safe to repeat.
- Usage of the run written to SQLite.

**Done when** a real small WonderCall task becomes a PR that passes CI.

## M1-WC. WonderCall MCP endpoint (in the WonderCall repo, in parallel)

Agent token, `/mcp` with service and task tools, locked claim, agent user. See [wondercall-integration.md](wondercall-integration.md).

## M2. The 24/7 loop

- Background service under launchd, restarts after crash and reboot.
- Scheduler with slots, leases, retries, budgets and kill switch.
- PR watcher: CI failures and review comments go into the running session.
- "Needs info": the agent asks on the task and pauses until answered.
- Task status kept in sync with WonderCall.

**Done when** three tasks run in parallel overnight, one is killed mid-run and resumes, and each ends as "Ready for review", "Needs info" or "Failed" with a comment.

## M3. Dashboard and usage

- Local web dashboard: agents, current task, phase, live log, board view.
- Usage per run, per day, per model, with budget used.
- Pause, stop, retry, slot count, kill switch.

## M4. Quality

- Benchmark of ten already-fixed WonderCall tickets; record a baseline success rate.
- Reviewer agent step before a PR reaches a human.
- Repo-idiom checks from known mistakes.
- Optional: Umbra review as a gate, if its owner agrees.

## M5. Expansion

- OpenAI models tuned and compared against Claude per task kind.
- More task sources (GitHub Issues, Linear, Jira).
- Triage agent that splits large tasks.
- Container per run for stronger isolation.
- Hosted version on Cloudflare (Pi Durable runs there via `PiHarness`).
