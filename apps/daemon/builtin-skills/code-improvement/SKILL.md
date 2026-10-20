---
name: code-improvement
description: Improve or refactor existing code safely - performance, readability, structure or UX polish - while keeping behaviour stable and showing a measurable before/after. Use for improvement, optimisation, cleanup and refactoring tasks.
task-types: [improvement, refactor]
---

# Improving existing code

The rule: behaviour that users and other code rely on stays the same unless the task explicitly asks to change it, and the improvement is shown, not claimed.

## 1. Baseline first

- Run the existing tests and note the result. Where the code you will touch has no tests, add characterisation tests that capture today's behaviour before changing anything.
- Measure what you are improving: timings (a small benchmark or the preview with timing), bundle or query counts, lines/complexity, or a short description and screenshot of the current UX.

## 2. Change in small steps

- One kind of change at a time (rename, extract, move, optimise). Run the tests after each step.
- Keep public APIs, URLs, data formats and configuration compatible. If something must change, keep the old path working or ask first.
- Do not mix in new features or unrelated fixes; note them as follow-ups.

## 3. Performance work

- Find the actual bottleneck (profile, log timings, `EXPLAIN` the query) before optimising.
- Prefer algorithmic and I/O wins (fewer queries, batching, caching with clear invalidation, avoiding re-renders) over micro-optimisations.

## 4. Show the result

- Same tests pass (plus any characterisation tests you added).
- Summary includes before and after numbers or descriptions, what was changed structurally, and any risk you see.
