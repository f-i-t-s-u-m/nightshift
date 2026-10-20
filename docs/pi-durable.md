# Pi Durable

Facts gathered 2026-10-17. Pi Durable is new and experimental; check the official docs at https://pi.dev before relying on any detail here.

## What it is

An experimental package from Earendil, released with Pi 1.0 on 2026-10-01. Pi 1.0 itself is a terminal coding agent; Pi Durable is a separate framework for long-running agent applications, with the coding agent as only one use.

- Package: `@earendil-works/pi-durable` (1.0.0). Models through `@earendil-works/pi-ai`.
- Runs the agent loop: transcript, model calls, tools, retries and crash recovery.
- Storage: memory, SQLite or JSONL. Each step is checkpointed; a new process continues where a dead one stopped.
- Many conversations (sessions) at once. A message to a busy session is queued and answered afterwards, or can steer the running work after its current tool round.
- Each tool call runs as its own task, with its intent committed before execution.
- Submissions with an `operationId` / `requestId` are processed exactly once.
- Extensions add tools (name, description, parameters, `replay` setting, `execute`), system prompt sections and skills.
- Runs on Node, Bun and Cloudflare Workers. The Cloudflare Agents SDK has a `PiHarness` that runs it inside a Durable Object.

## Corrections from the package README (1.3.0, read 2026-10-17)

The news coverage above missed several things the official README documents:

- **Coding tools are built in:** `@earendil-works/pi-durable/tools` has `read`, `write`, `edit` and `bash`, bundled as the `CodingTools` extension.
- **Approval is possible:** a `beforeTool` hook can block a call or rewrite its arguments; `onYield` can keep a run going.
- **Per-conversation working directory and environment:** `configure({ cwd })` plus an `env` factory (`NodeExecutionEnv`, or a container per conversation).
- **Usage:** `docs["pi.usage"]` per conversation and `harness.usage()` for all, per model and per tool.
- **Watching:** `viewState()`, `watch()` and the experimental `watchEvents()` give a live view for a dashboard.
- **Subagents, child tasks, a task graph, compaction, code mode** are all included.
- **A faux provider** in pi-ai runs scripted model responses, so most tests need no API key.

## What it does not give us

- A queue across tasks, worktrees, PR watching, a dashboard or a usage page.
- A built-in MCP client. MCP tools are wrapped as our own tools; `deferred` tools plus the `tool_search` extension handle large tool sets.
- Confinement: file tools accept absolute paths and `bash` can reach the whole machine (spike findings F1, F2).
- Cross-process locking: one process owns a storage at a time.

## Known limits (from the Cloudflare harness docs)

- Event streams live in memory and do not resume from a cursor after a restart. Store our own run events in SQLite.
- `abort()` waits for the session to go idle, so a tool that ignores its abort signal keeps it busy. Every tool must honour the abort signal.
- A single model request streaming for more than 15 minutes can be cut off (Cloudflare harness).
- Background task completion can be noticed up to 30 seconds late (Cloudflare harness).
- Conversations cannot be deleted yet.

## Crash and replay rules

After a crash, a tool marked `replay: "safe"` runs again. Any other tool that was running is not re-run; the model gets an "interrupted" result and decides what to do.

A public test killed an agent right after it created a Gmail draft. On resume, one model asked the user to check; a smaller model retried, left two drafts, and reported it had saved one. With a keyed tool that checked for an existing draft first, both models ended with one draft.

Rules for Nightshift:

1. Every tool with an outside effect must be safe to repeat, and is marked `replay: "safe"` only when it is.
2. Derive an idempotency key from the task id plus the tool call id or event id. Store done keys in `side_effects`.
3. Check before acting:
   - push: compare the remote branch head with the local commit first,
   - PR: `gh pr list --head <branch>` before `gh pr create`,
   - WonderCall comment and status: send the idempotency key; the MCP server must ignore repeats.
4. Never let the model's own report ("I saved it") count as proof. Nightshift checks the real state.
5. Use a strong model for steps that decide whether to retry a side effect.

## How Nightshift uses it

- One session per task, stored in SQLite next to Nightshift's own tables.
- `operationId` = `<task-id>:<event-id>` for CI results, review comments and answers.
- Pi Durable stays behind the `AgentRunner` interface ([architecture.md](architecture.md)) so it can be swapped for the Claude Agent SDK.

## Sources

- https://developers.cloudflare.com/agents/harnesses/pi/
- https://www.withone.ai/blog/pi-durable-crash-safe-one-cli
- https://alternativeto.net/news/2026/10/pi-1-0-brings-native-mcp-support-and-pi-durable-for-long-running-crash-resistant-ai-agents/
- https://letsdatascience.com/news/pi-10-adds-mcp-and-durable-harness-6241c6f7
