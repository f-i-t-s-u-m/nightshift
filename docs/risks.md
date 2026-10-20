# Risks

## Safety

- **Prompt injection.** WonderCall creates some tasks automatically from inbound email and WhatsApp. Only tasks a human created or moved to "Ready for AI" are taken, and the model's WonderCall token reaches only its own task.
- **Secrets.** Worktrees get `.env.local` only. Never production credentials or shared remote ones (for WonderCall, never `.env.dev`, which points at the remote dev database).
- **Tools are not confined by default.** Pi Durable's file tools accept absolute paths and `bash` reaches the whole machine; a killed process leaves its shell commands running (spike findings F1, F2). Use a `beforeTool` path guard, own process groups per task, no merge rights, and later a container per run.
- **Repeated side effects after a crash.** See the rules in [pi-durable.md](pi-durable.md).
- **Merges.** Branch protection on `main` with a required human approval.
- **Previews run agent-written code on your machine.** A preview is the project's dev server running from the task's worktree with the agent's changes, as your user. Only start previews for projects you trust; a container per task (M5) is the real fix.
- **Database containers.** Nightshift only creates and removes containers labelled `nightshift=1` and named `nightshift-pg-<project>`, bound to 127.0.0.1. It never touches other containers. `existing` mode needs an admin URL that can create databases; never point it at production.
- **LAN previews** expose that task's dev server to everyone on the same network while running. Use them on trusted networks and stop them when done.
- **Keychain writes** use the `security` command with the credential as an argument, so it is briefly visible in the local process list. Acceptable on a single-user Mac; a native Keychain binding would remove it.
- **Subscription sign-in** runs your personal plan for automated work. Check the provider's terms; prefer API keys for an unattended team.
- **Operator edits.** Saving files, discarding changes and committing from the dashboard are refused while the agent works in that worktree, but they still change the branch the agent continues on.

## Quality

- **Work that looks fine but is wrong.** The main risk of any agent system. Agents must run the repo's own checks before opening a PR, add a reviewer step later, and measure with a benchmark of already-fixed tickets (see [umbra-comparison.md](umbra-comparison.md)).
- **Agents reporting broken work as passing.** Never trust the agent's summary; Nightshift reads the real check results.
- **Thin tasks.** A two-line task leads to guessing. The agent must ask on the task ("Needs info") instead.

## WonderCall repo specifics

- API typecheck must run with `--incremental false`; the incremental cache both hides real errors and invents false ones.
- dbe2e tests need the local database URL from `.env.local` passed explicitly.
- Each worktree needs its own install, Prisma client, database name and ports; parallel runs otherwise clash on 8787 and 3000.
- Do not run the root prettier on `apps/mobile` files.
- Tasks that need a Prisma migration or touch billing should go to a human, or be limited to writing the migration without applying it to shared databases.

## Cost

- Use API keys, not personal subscriptions, so 24/7 use is metered and budgets can be enforced. Subscriptions have usage windows that will stall unattended runs.
- Budgets per run (tokens, money, time, rounds) and per day, plus a kill switch.

## Dependency

- Pi Durable is about two weeks old and experimental; its API will likely change. Pin its version, keep it behind `AgentRunner`, and keep the Claude Agent SDK as the fallback.

## People

Agents do well on well-scoped tasks and badly on vague product work. People are still needed to write clear tasks, review PRs and test. The team gets smaller; it does not go away.
