# Requirements

Written 2026-10-17 from the planning conversation.

## Goal

Reduce how much of the engineering load sits on people. AI agents should take most of the implementation work from the task board, so the team can be smaller and people spend their time writing clear tasks, reviewing and testing.

## Must have

1. **Agents read tasks from WonderCall.** A task a human marks as ready for AI is picked up without anyone starting it by hand.
2. **Agents do the work without a human in the loop.** They read the task, change the code, run the repo's checks and open a pull request.
3. **Many tasks at once.** Several agents work on different tasks in parallel, each isolated from the others.
4. **Agents follow their pull requests on GitHub.** When CI fails or a reviewer comments, the agent wakes up and fixes it on the same branch.
5. **24/7 until each task is done.** The system keeps running, survives crashes and reboots, and continues each task where it stopped.
6. **The human is the final step.** The human reviews or tests the result and merges. Agents never merge.
7. **Visibility.** At any time you can see:
   - each agent's current task and what it is doing right now,
   - the progress of every task (queued, working, waiting for CI, needs info, ready for review, failed),
   - AI usage: tokens and money per task, per agent, per model, per day.
8. **Claude and OpenAI.** Both providers must be usable.
9. **Separate product.** Nightshift is its own repo and product, not built on top of the WonderCall codebase. WonderCall is integrated as a task source.
10. **Local tool.** It runs on a machine we own. No hosted service is needed for v1.

## Should have

- Agents ask a question on the task when it is unclear, and wait for the answer instead of guessing.
- Budgets per task and per day, and a kill switch.
- Pause, stop and retry per run.

## Later

- More task sources (GitHub Issues, Linear, Jira) through the same interface.
- A reviewer agent that checks each PR before a human sees it.
- A triage agent that splits large tasks into agent-sized ones.
- Other agent kinds on the same base (QA, support triage).
- A hosted version (Pi Durable can run on Cloudflare Workers).
- Offering it to WonderCall customers for their own repos.

## Not in scope for v1

- Agents merging or deploying.
- Agents running database migrations against shared databases.
- Taking tasks that arrived from outside (inbound email, WhatsApp) without a human approving them first.
