# Architecture

## Overview

```
┌──────────────── Local machine (always on) ─────────────────────────┐
│  nightshift service (Node, kept alive by launchd)                  │
│                                                                    │
│   Task sources ── WonderCall MCP client (later: GitHub, Linear)    │
│        │                                                           │
│   Scheduler ── queue, N slots, retries, budgets, kill switch       │
│        │                                                           │
│   AgentRunner ── Pi Durable: one session per task                  │
│        │           tools: bash, read/edit files, git, task tools   │
│        │                                                           │
│   Workspaces ── one git worktree per task                          │
│   PR watcher ── polls `gh pr view` / `gh pr checks` / comments     │
│   Store ── SQLite (runs, events, usage) + Pi Durable's own tables  │
│   Dashboard ── local web UI, live updates                          │
└────────────────────────────────────────────────────────────────────┘
        ▲ list / claim / comment / status            ▲ push / PR
   WonderCall /mcp (agent token)                   GitHub
```

## Task lifecycle

1. **Queued.** A WonderCall task is in the "Ready for AI" status (or has an agent field set) and was created or approved by a human.
2. **Claimed.** The scheduler claims it through MCP (`claim_task` returns a lease), comments "Picked up by Nightshift", sets it to In progress and creates the worktree `workspaces/<task-id>` on branch `nightshift/<task-id>-<slug>`.
3. **Working.** A Pi Durable session gets the task title, body, attachments and the repo's `AGENTS.md`, and works in the worktree.
4. **Self-check.** Before the agent starts, Nightshift runs the configured checks once on the untouched branch. After the agent finishes, it runs them again itself (it does not trust the agent's report). Only checks that newly fail send the agent back, up to `budgets.maxFixRounds` rounds; checks already failing on the base are listed in the PR body.
5. **PR open.** Nightshift pushes and opens the PR, then posts the link on the task.
6. **Watching.** The PR watcher sends each CI failure or review comment into the same session as a new message. The agent fixes it on the same branch.
7. **Ready for review.** Checks are green and there are no open review comments. The task moves to "Ready for review". A human tests and merges.
8. **Needs info.** At any step the agent can ask a question on the task. The task moves to "Needs info" and the run pauses until someone answers; the answer goes into the session.
9. **Failed.** Out of rounds, budget or time. The task gets a comment with what was tried and goes back to a human.

## Components

### Command (`nightshift`)

```bash
nightshift init        # repo path, WonderCall MCP URL + token, model keys, slots, budgets
nightshift start       # install and start the launchd service
nightshift status      # what each slot is doing
nightshift logs <run> -f
nightshift pause | resume | stop <run>
nightshift run <task-id>   # one task in the foreground, for testing
nightshift usage --today
nightshift dashboard   # open the local dashboard
```

### Task sources

A small interface so WonderCall is swappable:

```ts
interface TaskSource {
  listReady(): Promise<TaskRef[]>
  claim(taskId: string): Promise<Lease | null>
  renew(lease: Lease): Promise<void>
  release(lease: Lease): Promise<void>
  get(taskId: string): Promise<TaskDetail>
  comment(taskId: string, body: string, idempotencyKey: string): Promise<void>
  setStatus(taskId: string, status: TaskStatus, idempotencyKey: string): Promise<void>
}
```

The WonderCall implementation is an MCP client. See [wondercall-integration.md](wondercall-integration.md).

### AgentRunner

Pi Durable is the first implementation. The Claude Agent SDK is the fallback.

```ts
interface AgentRunner {
  start(run: RunSpec): Promise<SessionRef>
  send(session: SessionRef, event: RunEvent, operationId: string): Promise<void>
  stop(session: SessionRef): Promise<void>
  events(session: SessionRef): AsyncIterable<AgentEvent>
  usage(session: SessionRef): Promise<Usage>
}
```

One task = one Pi Durable session. CI results, review comments and answers are `send` calls with an `operationId` of `<task-id>:<event-id>`, so a repeated event is processed once.

### Scheduler

- Fixed number of slots (start with 2-3; each WonderCall worktree needs its own install and ports).
- Picks the oldest ready task; skips tasks whose claim fails.
- Renews leases while a run is alive; a run whose lease expires is resumed or released.
- Budgets: per run (tokens, money, time, rounds) and per day. The kill switch stops all sessions.

### Workspaces

- One git worktree per task under `workspaces/`, all from one clone of the repo.
- One shared pnpm/bun store so installs are cheap.
- Each worktree gets its own database name and port range so parallel runs do not clash.
- `.env.local` is copied in. Production and shared remote credentials are never copied.

### PR watcher

Polls every `intervalsMs.prs` per open PR: check results for the current head commit, reviews, review comments, merge state. A failure or new comment becomes the next message to the same session (a fix round on the same branch and PR). No checks within `intervalsMs.ciGrace` of a push means CI has not started yet; after that, no checks counts as green. A failure on a commit the agent already tried to fix, with no new commit, fails the run for a human. A merged PR moves the task to Done; a closed one stops the run.

### Store (SQLite)

| Table | Purpose |
|---|---|
| `runs` | task id, source, slot, phase, branch, PR url, attempts, started/updated, final state |
| `run_events` | timeline: phase changes, tool calls (summarised), CI results, comments |
| `usage` | per model call: run, model, input/cached/output tokens, cost |
| `side_effects` | idempotency keys of pushes, PRs, comments and status changes already done |
| `settings` | slots, budgets, kill switch |

Pi Durable keeps its own transcript, inbox and task tables next to these.

### Dashboard

Local web page served by the service.

- **Agents:** each slot, its task, phase, a live log, elapsed time.
- **Board:** queued, working, waiting for CI, needs info, ready for review, failed.
- **Usage:** tokens and money per run, per day, per model; budget used.
- **Controls:** pause, stop, retry, slot count, kill switch.

## Tools given to the model

| Tool | Notes |
|---|---|
| `bash` | Runs inside the task's worktree only, with a timeout |
| `read_file`, `edit_file`, `list_files`, `search` | Worktree only |
| `run_checks` | Runs the repo's declared checks and returns failures |
| WonderCall task tools | `get_task`, `list_comments`, `get_attachment`, `post_comment`, `ask_question`, `attach_file`, scoped to the claimed task |

`git push` and `gh pr create` are done by Nightshift's code, not by the model, so they can be made safe to repeat.
