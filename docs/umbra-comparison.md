# Umbra comparison

Umbra (`/Users/fitsumbelay/Developer/umbra`, GitHub `Visky-ship-it/umbra`) is a local Bun + TypeScript tool that turns a ticket into one checked pull request. It was reviewed on 2026-10-16 at commit `9756535`.

## What Umbra is

"An operating system for agents": many cheap agents gather material, stronger models verify it against the real repo, and a human approves the final PR. Its focus is whether agent output is true, not how many agents run.

Its backlog section "The ticket loop carries development (owner decision 2026-10-14)" has the same goal as Nightshift: a smaller WonderCall team, with tickets turned into PRs that are accepted at 90 % or more without rework. `docs/ticket-benchmark.md` uses ten real WonderCall tickets that people already fixed.

## Against our requirements

| Requirement | Umbra at `9756535` |
|---|---|
| Runs 24/7, survives crashes | No. Runs start by hand |
| Many tasks at once | At most 2 runs (`src/admission.ts`, `UMBRA_MAX_CONCURRENT_RUNS`); extra runs are refused, not queued |
| Reads WonderCall tasks | Planned (#137), not built. Takes a markdown ticket file today |
| Watches PRs, fixes CI and review comments | No. Opens the PR and stops |
| Repeats until green | Planned (#134). One fix and one review per run today |
| Claude and OpenAI | Claude. `src/agent-runner-openai.ts` targets local OpenAI-compatible models for cheap steps only |
| Progress and usage across runs | One-run view; usage in tokens, money only as estimates |
| MCP | None |
| Quality of the PR | Strong: verification layers, repo checks (#133), defect proofs (#138), tested on WonderCall |
| Ownership | Proprietary, someone else's roadmap |

## Why not build on it

Nightshift's main needs (24/7, many tasks, PR follow-up, both providers, our own product) are what Umbra lacks, and adding them means building inside a codebase we do not control. See decision D4 in [decisions.md](decisions.md).

## What to learn or reuse

- **Running WonderCall's own checks.** Umbra's notes in its backlog item #133 are a guide: install from a warm cache with `--ignore-scripts`, `prisma generate` before checks, run each check on the base first so failures that were already there are not blamed on the fix, and protect `scripts/` and `apps/web/scripts/` so a fix cannot change the scripts that judge it.
- **Benchmark.** Copy the idea of `docs/ticket-benchmark.md`: run already-fixed WonderCall tickets on the commit before the human fix and grade the result. This gives Nightshift a real success rate.
- **Ask instead of guess.** Umbra's "fork gate" pauses a run on a product question; Nightshift's "Needs info" is the same idea.
- **Optional quality gate later.** If the Umbra owner agrees, call `umbra review` on a Nightshift PR before it reaches a human. It stays a separate tool.
- **Known WonderCall fix mistakes** from Umbra's runs (#135): fixes that render raw stored messages instead of typed, translated reasons, and values computed at module load in a static export (time zone, locale). Put these in the agent's review prompt.
