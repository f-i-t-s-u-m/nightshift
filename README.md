# Nightshift

A local, always-on AI engineering team. Nightshift picks up tasks from a task board (WonderCall first), works on them with Claude or OpenAI models through [Pi Durable](https://pi.dev), opens pull requests, follows CI and review feedback until each task is ready, and shows you what every agent is doing and what it costs.

A human writes the tasks, reviews the pull requests and merges. Nightshift does everything in between.

## Status

M1 to M3 of the [roadmap](docs/roadmap.md) are built, plus projects (several repos), tasks created in Nightshift, and messages with pictures to the agent. The end-to-end test (`bun run e2e`, 20 checks) passes with a scripted model, a mock WonderCall server and a local git remote. Not yet run against a real model, real GitHub or the real WonderCall (its `/mcp` endpoint does not exist yet; see [docs/wondercall-integration.md](docs/wondercall-integration.md)).

## Layout

Turborepo with bun workspaces. The service runs on Node 22.13+.

| Path | What it is |
|---|---|
| `apps/daemon` | The service: scheduler, run state machine, PR and answer watchers, HTTP API with live events, `nightshift` CLI, launchd install. End-to-end test in `apps/daemon/e2e` |
| `apps/web` | Dashboard (Vite + React): sidebar of projects → a project's tasks → a task's live agent conversation with a message box for text and pictures; agents, usage, kill switch |
| `apps/wondercall-mock` | A WonderCall MCP server with the planned tool contract, for development and tests |
| `packages/core` | Shared types, config, HTTP API contract, WonderCall MCP tool names |
| `packages/store` | SQLite (`node:sqlite`): runs, events, side effects, usage per day and model, settings |
| `packages/sources` | WonderCall MCP client (`TaskSource`) |
| `packages/git` | Worktrees, safe push, PR hosts: GitHub through `gh`, or local for development |
| `packages/runner-pi` | Pi Durable runner: coding tools, task tools, path and command guard, orphan-process cleanup |
| `packages/ui` | Shared React components and styles |
| `spike/` | The Pi Durable spike (kept for reference) |

## Develop

```bash
bun install
bun run build        # turbo build of every package
bun run typecheck
bun run e2e          # end-to-end test; report in .nightshift/e2e/<time>/report.md
bun run demo         # same setup, left running: open the printed URL for the dashboard
```

## Use

```bash
bun install
bun run build
bun run serve            # starts the service; dashboard at http://127.0.0.1:4777
```

Then, in the dashboard:
1. **Models**: connect Anthropic, OpenAI or OpenRouter (API key or subscription sign-in) and pick the agent and reviewer models.
2. **New project**: import a folder or git URL (Browse… to pick it), or start a new one from a starter. Check the suggested checks, preview and database, then create.
3. **New task** in the project. An agent picks it up within a minute; follow it on the task page.

`bun run serve` creates `~/.nightshift/config.json` with defaults on first start. Data, worktrees, cloned repos and logs live in `~/.nightshift`. Docker is only needed for per-task databases and container previews; `gh auth login` for projects on GitHub.

Run it in the background (macOS, restarts on crash and at login): `bun run nightshift start`; stop with `bun run nightshift stop`. Other commands: `bun run nightshift status | runs | logs <run> -f | usage | kill-switch on|off`.

## Documents

| Doc | What it holds |
|---|---|
| [docs/requirements.md](docs/requirements.md) | What the product must do |
| [docs/decisions.md](docs/decisions.md) | Decisions made and why |
| [docs/architecture.md](docs/architecture.md) | Components, task lifecycle, data model, dashboard |
| [docs/pi-durable.md](docs/pi-durable.md) | What Pi Durable gives us and the rules for using it safely |
| [docs/wondercall-integration.md](docs/wondercall-integration.md) | The MCP server WonderCall needs |
| [docs/umbra-comparison.md](docs/umbra-comparison.md) | How Nightshift relates to Umbra |
| [docs/risks.md](docs/risks.md) | Safety, cost, quality and repo-specific risks |
| [docs/roadmap.md](docs/roadmap.md) | Milestones and what is done |
| [docs/spike-pi-durable.md](docs/spike-pi-durable.md) | The Pi Durable spike and its results |
