# Decisions

Each entry records what was decided, why, and what was rejected. Add new entries at the bottom; do not rewrite old ones.

## D1. A separate product, not a WonderCall feature (2026-10-16)

**Decision:** Nightshift is its own repo. WonderCall is one task source.

**Why:** The owner wants a tool that is not tied to the WonderCall codebase and can later work with other boards.

**Rejected:** Building agent runs, a coding sandbox and an "AI Team" page inside WonderCall (Temporal workflows, `apps/sandbox-manager`, a new `AgentRun` table). It would work, but ties the product to WonderCall and roughly doubles the work if customers ever use it.

## D2. Local, always-on machine for v1 (2026-10-16)

**Decision:** Nightshift runs as a background service on one machine (Mac or Mac mini), kept alive by launchd.

**Why:** No public URL is needed: everything is polled (WonderCall every minute, GitHub every 2-5 minutes). It uses the machine's `git` and `gh` login, so no GitHub App is needed. Simplest path to a working loop.

**Rejected for v1:** Kubernetes sandboxes, a GitHub App with webhooks, Temporal.

## D3. MCP for the WonderCall integration (2026-10-16)

**Decision:** WonderCall exposes a hosted MCP server at `/mcp`. Nightshift connects to it as an MCP client.

**Why:**
- One integration that Claude, OpenAI and Pi clients all speak.
- Agents can act mid-run: read comments and attachments, post progress, ask a question.
- Linear, Jira and GitHub already have MCP servers, so later task sources look the same.
- It doubles as a WonderCall feature (customers connecting their own AI tools).

**Rule:** Anything that must be reliable (list, claim, status change) is called by Nightshift's own code, not decided by the model. The model only gets the conversational tools, scoped to its one task. See [wondercall-integration.md](wondercall-integration.md).

**Rejected:** A REST-only adapter (works, but would be built twice once MCP is wanted); copying WonderCall's WhatsApp MCP server pattern (it reads the database directly and skips permissions).

## D4. Pi Durable as the agent base (2026-10-17)

**Decision:** Use Pi Durable (`@earendil-works/pi-durable`, released with Pi 1.0 on 2026-10-01) for agent sessions.

**Why:**
- Durable sessions, checkpoints and crash recovery are what Nightshift needs most and what is hardest to build.
- Many sessions at once; new events (CI failed, review comment, answer to a question) can be sent into a running session.
- Idempotent submissions (`operationId` / `requestId`).
- Claude and OpenAI through `pi-ai`.
- Runs on Node, Bun and Cloudflare Workers, which keeps a hosted future open.
- We own the product and its direction.

**Conditions:** It is experimental and its API will likely change. Keep it behind an `AgentRunner` interface so the Claude Agent SDK can replace it. The spike in [spike-pi-durable.md](spike-pi-durable.md) must pass before building further.

**Rejected:**
- **Umbra as the base.** Strong at producing one checked PR, but it has no 24/7 service, queue, PR watcher or MCP, allows at most two runs at once, is Claude-centred, and is a proprietary repo with someone else's roadmap. See [umbra-comparison.md](umbra-comparison.md).
- **Claude Agent SDK or Codex CLI directly as the base.** Good coding agents, but durability, resume and many concurrent sessions would be ours to build. Kept as the fallback runner.
- **Writing our own agent loop.** No reason to when Pi Durable exists.

## D5. Node.js + TypeScript + SQLite (2026-10-16)

**Decision:** One Node.js TypeScript project that installs as a terminal command, runs a background service and serves a local dashboard.

**Why:** Pi Durable, `pi-ai` and the MCP SDK are TypeScript packages. The team writes TypeScript. SQLite is enough for one machine, and Pi Durable can store its sessions in SQLite.

## D7. Turborepo with bun workspaces (2026-10-17)

**Decision:** One repo with `apps/` (daemon, web, wondercall-mock) and `packages/` (core, store, sources, git, runner-pi, ui). bun installs, Turborepo builds; the service runs on Node because Pi Durable's SQLite storage uses `node:sqlite`.

## D8. Checks are judged against the base branch (2026-10-17)

**Decision:** Before the agent starts, Nightshift runs the configured checks on the untouched branch. Only checks that pass there and fail after the change block the task; checks already failing are reported in the PR body.

**Why:** The first end-to-end run spent three fix rounds blaming agents for a test that was already red on `main`. Umbra's backlog #133 reached the same rule on WonderCall.

## D9. Pi conversation ids are stored as text (2026-10-17)

Pi Durable conversation ids are numbers; `runner-pi` turns them into strings at its boundary and back when calling Pi. Storing the raw number in a TEXT column produced `"2.0"` and broke every lookup.

## D10. Projects, own tasks and operator messages (2026-10-17)

**Decision:** A Nightshift project is a repo + its checks + PR host + a task source: Nightshift's own task list (`local`) or one WonderCall project over MCP. The dashboard is organised as projects → tasks → task conversation. The operator can message the agent with text and pictures at any stage:

| Run state | What a message does |
|---|---|
| Working | Delivered at once as a steer; Nightshift waits for it before checking |
| Other active step | Delivered right after that step |
| Needs info | Is the answer; the agent continues |
| Waiting for CI / Ready for review | Starts another round on the same PR |
| Failed / stopped / not started | Kept, and the task goes back to Ready for AI; the next attempt starts with it |
| Done | Refused; create a new task |

Pictures go to the model as image input (PNG, JPEG, GIF, WebP, up to 10 MB). The WonderCall MCP contract gains `list_tasks` and `create_task`, and `list_ready_tasks` takes a `projectId`.

## D11. Workspace per task: preview link, own database, files and git (2026-10-17)

**Decision:** Every task's git worktree is a full workspace:
- **Preview link.** The project's dev command runs from the worktree on a free port. The daemon proxies `http://<task>-<project>.localhost:<daemon port>/` (HTTP and WebSocket) to it. `*.localhost` resolves to 127.0.0.1 in browsers, so no DNS setup is needed, and each preview gets its own origin, separate from the dashboard.
- **Own database.** Postgres only for now. `docker` mode starts one container per project (`nightshift-pg-<project>`, default image `postgres:17-alpine`, bound to 127.0.0.1, random password) and creates one database per task. `existing` mode creates the per-task database on a server you name with an admin URL. The project's setup command migrates and seeds it with `DATABASE_URL` set. The URL is passed to setup, checks, the agent's shell and the preview. A done task's database is dropped; a failed task keeps it for inspection.
- **Files and Source Control.** The dashboard reads and edits files, shows diffs, and stages, commits and pushes. Edits are refused while the agent works in that worktree.
- **Actions.** GitHub Actions runs for the branch through `gh run list/view`, plus Nightshift's own check runs.

## D12. Pi Durable features adopted (2026-10-17)

| Feature | Use |
|---|---|
| `watchEvents` | `GET /api/projects/:p/tasks/:t/stream` streams agent events to the dashboard |
| Plan mode (configure tools + extension) | Per project `planMode`: off, plan first, or plan and wait for approval (`submit_plan` terminates the planning run) |
| Reviewer conversation | Per project `review` (default on): a read-only reviewer conversation checks the diff before the PR; findings go back to the worker, at most 2 rounds |
| `type: "write"` submissions | Operator messages during work. Nightshift checks after the run that the agent saw them, otherwise it sends them as a follow-up |
| `settled.answer` + `AssistantEntry` | Reading the agent's final answer and whether it stopped on `ask_question`/`submit_plan` |
| Env per conversation | `env` factory returns `undefined` without a cwd; shell env carries `DATABASE_URL` and `PREVIEW_URL` |
| Settings | `stream.timeoutMs` 5 min, `retry.maxRetries` 6, automatic compaction, default extension list |
| `harness.inspect()` | Logs blocked Pi tasks at startup |
| Image processor | `createNodePhotonImages()` for screenshots the agent reads |
| `abort(..., { background: true })` | Stop and budget kills reach background work too |

Not yet adopted: subagents, child tasks for the orchestrator's own steps, forks for retries, `wrapTool` metrics, manual compaction before fix rounds, extension state docs for a progress/todo list.

## D13. Onboarding: import, analyse, start new, edit (2026-10-17)

- **Import existing**: a local folder or a git URL (cloned into `~/.nightshift/repos`). The analyzer reads package.json/workspaces/lockfiles, Python/Go/Rust markers, Prisma schema, compose files and `.env.example`, and the README/AGENTS/CLAUDE/CONTRIBUTING/docs files. It returns the kind, stack, package manager, monorepo packages, git facts, database, and suggested setup, checks, preview and database settings, plus warnings. Everything is prefilled and editable before creating.
- **Project brief**: the configured model summarises the analysis and documents into a short brief (stack, structure, how to run, conventions, pitfalls). The user can edit it, and it is added to every agent's instructions.
- **Start new**: pick a kind (web, mobile, backend, full-stack, desktop, library, design, other) and a starter (Vite React, Next.js, Expo, Hono+Postgres, Next+Prisma, TS library, design system, empty). Nightshift creates the folder, a git repo and a local bare remote, then a first task for the agent to scaffold the stack.
- **Settings** are editable after creation (PATCH), including pausing new work per project. A project's connections are rebuilt when its task source changes.
- **Commit diffs**: `GET …/workspace/git/commit?sha=` returns every file's before and after.

## D14. Models: API keys, subscription sign-in, OpenRouter (2026-10-17)

- Providers Anthropic, OpenAI and OpenRouter, through pi-ai. Each can connect with an **API key** or a **subscription sign-in**: Claude Pro/Max, Sign in with ChatGPT, or an OpenRouter account (which creates a key). The dashboard drives pi-ai's login as a server-side session. It shows the sign-in link or device code, and questions such as "browser or copy a code" and "paste the code" are answered in the dialog. OpenAI's sign-in gets a stable per-installation device ID and the app name "Nightshift".
- **Credentials** go into the macOS Keychain (service `dev.nightshift.credentials`), or an owner-only `credentials.json` on other systems and in tests (`NIGHTSHIFT_CREDENTIALS=file`). pi-ai refreshes OAuth tokens under its lock.
- **Model choice**: a global agent model and reviewer model plus favorites. Projects can override both. Any of OpenRouter's ~400 catalog models can be searched, starred and picked. Each run records the model it used, and reviewer usage is counted separately per run.
- Subscription plans have usage limits and their own terms for automated or third-party use; the UI says so. API keys remain the recommended way to run 24/7.

## D15. Preview targets: machine, container, device (2026-10-17)

- **Machine** (default): the dev command runs from the worktree as the user.
- **Container**: `docker run` with the worktree mounted at `/workspace`, an anonymous volume over `node_modules` (dependencies are installed inside, so host-native modules never mix), the port bound to 127.0.0.1, `127.0.0.1`/`localhost` in the env rewritten to `host.docker.internal`, and labels `nightshift=1`, `nightshift.preview=1`. Leftover preview containers are removed at startup. Default image `node:22-alpine`.
- **Device**: `lan` binds the dev server to all interfaces and gives `http://<LAN IP>:<port>/` (with a QR code) for any phone on the same Wi-Fi. `expo-go` switches `expo start --web` to `--lan` and gives an `exp://` link. `ios-simulator`/`android-emulator` run `expo start --ios/--android` on this Mac. Only `lan` is covered by the e2e test; the Expo modes need Expo and a simulator or phone.

## D16. Base branch per task, and sessions (2026-10-17)

- **Base branch**: a new task can start from any branch on the project's remote (listed with `git ls-remote`, cached 30 s, searchable). The default is the project's base branch. The run stores its base; the worktree, the "nothing changed" check, the diff stat, the reviewer's diff and the PR target all use it.
- **Sessions**: each Pi conversation of a task is a session. The task page lists them with turns and context size; the size comes from the latest request's input + cache + output tokens, and the window from the model catalog. Three ways to continue:
  - **Handoff**: a new conversation whose first message is the task, a model-written summary of the previous session and an optional note.
  - **Fresh**: a new conversation with the task only; the agent reads the workspace's git state.
  - **Compact**: Pi's compaction on the current conversation.

  When the agent is working, the switch happens at once: the new session's first message is queued, then the old conversation is aborted, so the run continues in the new session. Otherwise the new session takes over with the next message or PR round. Old sessions stay readable; usage is counted per conversation.

## D17. Verification loop, decisions, external testers, listeners (2026-10-17)

- **Steps and rounds**: every agent turn, check run, AI review, external tester run, CI result and push is recorded as a step in a numbered round (round 1 = first attempt; each fix round adds one). Findings from every source become **issues** (source, severity, file:line, round found, round fixed) that are reconciled each round: still present → stays open, gone → fixed. All fix rounds get the same issue-list prompt.
- **Order after the checks pass**: every-round testers → AI reviewer (JSON findings, at most 2 rounds) → before-PR testers → push. A blocking finding (blocker/major from a blocking source) starts a fix round.
- **Decisions**: the agent's `ask_question` (now with optional choices), reviewer findings flagged as needing a product decision, Umbra's undecided claims and inconclusive verdicts, and running out of fix rounds all create a **decision**. The task pauses in Needs info and the question is posted on the task. Answering (decision buttons, or any message) resumes the agent with the answers; "ignore"-style answers dismiss the linked issues. Out of fix rounds asks: keep fixing (3 more), open the PR with the open issues, or stop.
- **External testers** (per project): a command run in the worktree with `NIGHTSHIFT_WORKTREE/BASE/BRANCH/TASK/TASK_ID` (+ `DATABASE_URL`, `PREVIEW_URL`), read in one of three formats: Nightshift JSON, **Umbra** (parses `umbra review`'s verdict, blocking, advisory and UNADJUDICATED sections; Umbra itself is not modified or re-implemented), or exit code. Each runs every round, before the PR, or only manually ("Run now" on the task). Manual runs with blocking results ask whether to send them to the agent. (Changed in D36: they go to the agent.)
- **Listeners** (per project, each switchable): review feedback and failing CI on open PRs from agent branches (`branchPrefix`) that have no running task create a task that continues on the same branch and PR; feedback on PRs with a running task goes to that task. GitHub issues with a label become tasks (GitHub projects). Activity is logged per project. The listener setting is re-read just before creating each task.

## D18. Nothing that changes the owner's work happens without them (2026-10-18)

Found in the first real run: a retry started a new conversation, so the agent lost the owner's chat instructions. The reviewer never saw them, called the requested app code out of scope, and the agent deleted it.

- **Retry keeps the session**: a new run of the same task reuses the previous conversation in the same worktree, and starts with "Nightshift is retrying…; everything the owner told you still applies". New sessions are created only by the owner.
- **The reviewer gets the owner's messages and answered decisions**, marked as overriding the task text, and must never ask for removing work the owner requested.
- **Deleting files needs approval**: before the checks, Nightshift diffs the workspace (committed and uncommitted, renames excluded) against the last pushed state or the base. Any deleted file not approved before pauses the task with "Allow the deletions / Restore the files". Restore checks the files out again and tells the agent not to delete them.
- **The task's workspace is analysed** when the project has no preview or database settings yet, and the missing settings are offered in Preview & DB ("Use these settings").
- The chat shows only messages that are queued or were just delivered; older messages stay in their own session's transcript.

## D19. One preview per app in monorepos (2026-10-18)

A Turborepo, Nx or workspaces repository usually runs several apps together (for example `apps/web` calling `apps/api`), so a single preview command could not show them.

- **The preview is a list of services**: each has a name, a folder inside the repository, its own command, port and ready path. One is the primary. A project with one command keeps working as a single "app" service.
- **Each service gets its own link**: `<service>-<task>-<project>.localhost:<port>`; the primary also answers on the plain task link. Services start, restart and stop together or one at a time, and have their own logs.
- **Services find each other** through environment values: `{{api.url}}` (direct local address, for server-side calls), `{{api.publicUrl}}` (the preview link, for the browser), `{{api.port}}`, `{{api.lanUrl}}`, plus `NIGHTSHIFT_<NAME>_URL` and `NIGHTSHIFT_<NAME>_PUBLIC_URL` for every service.
- **Import detects the apps**: every workspace package with a dev/start script that is a frontend (Next.js, Vite, Expo, …) or backend (Express, Hono, Fastify, Nest, …), or that lives in `apps/`/`services/`, becomes a service with framework port flags. Frontends get the API's address in `NEXT_PUBLIC_API_URL` / `VITE_API_URL` / `EXPO_PUBLIC_API_URL`, `API_URL`, and any `*API*_URL` key in their `.env.example`. Libraries in `packages/` are skipped.
- An optional install command runs once before the services (needed for container previews, where `node_modules` is not shared with the Mac).
- The agent's `preview` tool takes a service name to start, restart, stop or probe one app.

## D20. Skills, like Claude Code (2026-10-18)

Agents produced generic-looking UI and ignored team conventions. Claude Code solves this with skills: a folder with a `SKILL.md` (frontmatter `name` + `description`, then instructions) and optional scripts or references, loaded only when a task needs it.

- **Same format as Claude Code and the Agent Skills standard**, so existing skills import unchanged.
- **Where they come from**: four built-ins shipped with Nightshift (`frontend-design`, `accessible-ui`, `shadcn-ui`, `database-migrations`; read-only, can be turned off), skills imported from Claude Code (`~/.claude/skills` and installed plugins), from a folder, or from a git repository (GitHub `/tree/<branch>/<path>` links work), skills written in Nightshift, and skills committed in the repository itself (`.claude/skills`, `.agents/skills`).
- **Stored** in `<dataDir>/skills/<id>/`; imports are copies, so the original stays untouched. Folders over 500 files or 30 MB, files over 5 MB and symlinks are refused or skipped.
- **On/off**: each skill has a global switch; a project can override any skill (on, off, or back to the default).
- **How the agent gets them**: before each model request a `skills` prompt section lists the enabled skills (name, description, path). Nightshift copies the enabled skills into the task's worktree under `.nightshift/skills/` (added to git's info/exclude, so never committed) and the agent reads a `SKILL.md` with its normal read tool when the task matches, then runs any scripts with bash, inside its workspace guard. Changes to skills reach running agents at their next request.
- The reviewer does not get skills yet.

## D21. Budgets pause and ask; cache reads don't count (2026-10-18)

Found in a real run: a task failed with "Run budget exceeded" at $2.16 because 4.4M of its 5M counted tokens were cache reads, and its retry died within seconds because it inherited the whole conversation's usage.

- **Token budgets count input, output and cache writes only.** Cache reads (the model re-reading its own context) are cheap and grow with every step, so they are shown in Usage but not limited.
- **Each run is measured from its own start.** A retry that continues the previous conversation records the conversation's usage so far as its baseline: the run gets a fresh budget, and today's usage is no longer counted twice.
- **Reaching a budget pauses the task with a decision** ("Continue with another budget / Stop the task") instead of failing it. Nightshift interrupts only while the agent is working; checks, pushes and reviews finish first, and the next agent step waits. A message to the paused task counts as "continue".
- **Limits are editable at runtime** under Usage (per-run cost and tokens, per-day cost, fix rounds) and override `config.json` until reset.

## D22. Create on GitHub, move to GitHub (2026-10-18)

New projects were always local (a bare remote in `~/.nightshift/remotes`), and there was no way to take a local project to GitHub.

- **Uses the GitHub CLI and the owner's own login** (`gh auth login`); Nightshift stores no GitHub token. `GET /api/github` reports whether `gh` is installed, signed in, the account and organisations, and the git protocol.
- **Create on GitHub**: the starter is built locally without a bare remote, `gh repo create <owner>/<name> --private|--public` makes an empty repository, `origin` is set to its https or ssh URL (following `gh`'s git protocol), `main` is pushed and made the default branch, and the project is registered with git host "github". Missing sign-in or a taken name is refused before anything is created.
- **Move to GitHub** (local projects only, refused while an agent is working): creates the repository, copies every branch (base branch first) and tag from the current remote, sets the default branch, adds the old remote as `nightshift-local`, points `origin` at GitHub, switches the project to GitHub pull requests and opens a GitHub pull request for every task with an open local one. Nothing is deleted.
- **Failures leave a clean retry**: if the push fails (usually missing `gh auth setup-git`), nothing on the Mac is changed and the empty repository is reused on the next attempt.
- e2e runs against a fake `gh` that keeps "GitHub" repositories as local bare repositories.

## D23. Task types, and pushing only after approval (2026-10-19)

- **Task type** (feature, bug, improvement, refactor, design, docs, tests, chore) is chosen when a task is created and can be changed later; CI-failure tasks default to bug, WonderCall and older tasks have none. The type adds a `task-type` prompt section (what this kind of task needs, e.g. reproduce first and keep a regression test for bugs), gives the reviewer a type-specific checklist, and puts the matching skills first in the skills section. Both sections render before every model request, so a type change reaches a running agent at its next step.
- **Skills declare the task types they serve** with `task-types: [bug]` in the SKILL.md frontmatter (ignored by Claude Code). Untagged skills are matched on keywords in their name and description. New built-ins: `bug-fix`, `feature-development`, `code-improvement`.
- **Push mode** per project: *Automatically* (default) or *After I approve*. With approval, the work is still committed on the Mac after every round, but before each push Nightshift pauses with "Push N commits and open the pull request?" (or "…to pull request #N") listing the commits and diffstat. Approving pushes the commit that was shown; a message to the task instead means "keep working" and the next round asks again with the new total.

## D24. Previews explain themselves: hints, AI diagnosis, AI detection (2026-10-19)

From a real Turborepo (admin, api, web): the detected apps sat in a separate card while the preview kept one `bun run dev`, and a service that did not start gave no clue why.

- **Instant hints (no AI)** from the dev server output: the app listens on another port than `$PORT`, the port is already taken, a module or command is missing, the script does not exist, or it is still not answering after 45 s.
- **AI diagnosis**: when a service fails, Nightshift asks the default model once per start attempt (or on demand) with the command, env, install step, the last 150 log lines, the app's package.json, `.env.example` and entry config. It returns a summary, the cause, a settings fix (command, env, install, folder, ready path) and, when code must change, a prompt for the agent. "Apply fix" saves it into the project's preview settings and restarts that service. Without a model, the rule-based hint is used.
- **AI detection**: reads the repository (package.json files, turbo.json, .env.example, README) together with the rule-based suggestion and proposes the whole preview setup; the result is validated like a manual edit and falls back to the rules if unusable.
- The detected apps and the preview are one card; each service has its own console. The project's task list shows each task's preview state. The agent's `preview` tool output includes hints and diagnoses.

## D25. Local files, URL rewrites, and per-app containers (2026-10-19)

Task worktrees are created from the remote, so git-ignored files (`.env`, `.env.local`, `apps/*/.env`, `.dev.vars`) were missing in every task, and two tasks could not run an app that hard-codes its port.

- **Local files** (project setting): Nightshift lists the git-ignored env/config files in the project folder (names and variable names only, never values). The selected ones are copied into each task's worktree when it is prepared (existing copies are kept, so a task can change its own) and on "Sync from project folder". A copied file that the branch does not ignore is added to git's info/exclude, so it is never committed. Nightshift's per-task values (DATABASE_URL, PORT, service URLs) are real environment variables and win over `.env` values.
- **Secrets stay away from the model by default**: the agent's read/write/edit tools and bash commands that name a protected file are blocked, and its prompt explains that the values are active and how to ask for new ones. The owner can allow access per project.
- **URL rewrites**: `localhost:<port>` URLs in the copied files that belong to one of the project's apps (port found in the app's scripts, `.env` PORT, source, or framework default; AI maps the rest) become env overrides at preview start, e.g. `NEXT_PUBLIC_API_URL={{api.publicUrl}}/v1`, applied to the app whose folder holds the file (root files apply to all).
- **Per-app container**: a preview service can run in its own container with a fixed internal port (`containerPort`) mapped to a unique host port; its dependencies install inside the container into a per-service volume (image: `oven/bun:1` for Bun projects, else `node:22-alpine`, or the project's image). The rule check and AI diagnosis propose this when an app hard-codes its port.
- Found while testing: Pi resumes conversations before the orchestrator reloads projects, so callbacks used by tool guards and prompt sections read projects from the store, not the in-memory project list.

## D26. Shared services: one instance per project (2026-10-19)

Some services must not run once per task: a local IMAP server, Mailpit, Redis, a mock payment server. Several copies waste resources or fight over state, and some are already running on the Mac.

- A preview service can be **shared**: Nightshift runs one instance per project (from the project folder) on a forced `port`, or on a port it picks once and keeps for the project. With an empty command it is **external**: nothing is started, Nightshift only checks that the port answers.
- **Health check** per service: `http` (GET the ready path, default) or `tcp` (a plain connection, for IMAP/SMTP/Redis…). The TCP probe closes its connection gracefully.
- Starting any task's preview starts the shared services first; stopping the last task preview that uses them stops them. Start/stop on a shared row acts for the whole project.
- Every task's apps reach them with `{{name.host}}`, `{{name.port}}`, `{{name.url}}`; `NIGHTSHIFT_<NAME>_HOST/PORT/URL` are set for previews, the agent's shell and checks. Shared services are never the main app and are left out of the task list's per-task preview counts.

## D27. Setup failures pause with a diagnosis (2026-10-19)

From the WonderCall import: the suggested setup ran `bunx prisma generate` at the repository root, but the schemas live in four apps, so every task failed in "preparing" with a truncated error and no way forward.

- **Detection**: Prisma clients are generated in each app that has a schema, `(cd apps/api && bunx prisma generate) && …`, using the app's own Prisma; only a root schema gets a root-level generate. Database migrate/seed is suggested only when there is one schema.
- **Setup is a visible step** in Checks & review with its full output; error lines are cut at line boundaries.
- **A failing setup no longer fails the task.** It pauses with a "Workspace setup failed" decision: a rule check plus an AI diagnosis (setup command, output, package.json, turbo.json, the rule-based suggestion) with a corrected command. Options: *Apply the fix and retry* (saves the command to the project), *Skip setup this time*, *Ask the agent to fix the setup* (setup is skipped and the agent's first prompt carries the failed command and output, asking it to make the workspace usable without changing product code and to report the working command), *Stop the task*. A message to the task counts as "ask the agent", with the message included.

## D28. The owner's own terminal in each task (2026-10-19)

The owner wants to run commands by hand in a task's worktree (install a dependency, fix the build, try something) without going through the agent.

- **Terminal tab** per task: real interactive shells (the owner's `$SHELL`, login) in the task's worktree, with the task's environment (database URL, preview and shared-service variables, copied local files on disk). Up to 5 per task; they survive page reloads while the daemon runs and keep 1 MB of scrollback.
- **No native module**: each shell runs under a small Python `pty` bridge (macOS ships Python 3); resizes go over a separate control pipe. The browser uses xterm.js; output streams over SSE, keystrokes and resizes are POSTs.
- **Not connected to the agent**: terminals are not tools, not in prompts, and their output never reaches a model. The UI says so and warns when the agent is working in the same folder.
- **Safety**: the same loopback-Host and same-origin checks as the rest of the API (preview pages run on `*.localhost` origins and cannot call it). Shells are killed when closed, when the task is done, and when the daemon stops; leftovers are reaped at start.

## D6. Humans merge, agents never do (2026-10-16)

Branch protection on `main` requires a human approval. Agents push only to `nightshift/*` branches.

## D29. Saying no is remembered, review tasks, deleting projects, shared services on demand (2026-10-20)

From daily use: the owner refuses the same deletion or push again and again, wants to hand a branch another AI agent started to Nightshift, cannot remove a project, and starting one app also started every shared service.

- **Refusing a push** has its own option, *Don't push yet*: nothing is pushed, the work stays committed on the Mac, and the task waits in Needs info until the owner messages the agent (a fix round; the next push asks again). Any other answer still means "keep working, here is what to change".
- **Refusing a deletion is remembered for the task** (and its retries): if the agent deletes a refused file again, Nightshift restores it before the checks without asking. A written answer is passed to the agent with the restore.
- **Review & continue** task type: the owner picks the branch with the earlier work. A branch under the project's prefix is continued as it is; any other branch is never pushed to (D6) — the task gets its own agent branch that starts from that branch's head, and the pull request goes to the base branch with both authors' commits. The agent is told the branch and asked to read the existing work, list what is done, missing and wrong, and finish it instead of starting over. The reviewer gets a review-specific checklist.
- **Deleting a project** (settings → Delete project, `DELETE /api/projects/:id`, typed confirmation) stops its runs, previews, shared services and terminals and removes the project, its own tasks and queued messages. Optionally it removes the task worktrees and per-task databases. The repository, its branches and pull requests are not touched; run and usage history are kept. A deleted project's id is never reused, so old runs cannot attach to a new project, and the config's default project is not re-created at the next start.
- **Shared services start on demand** (changes D26): starting one app starts only the shared services it refers to (`{{name.*}}` or `NIGHTSHIFT_<NAME>_*` in its command, its env or the preview env). Starting the whole preview still starts every shared service.

## D30. Each preview app's environment is visible (2026-10-20)

From the WonderCall import: the web app kept calling `http://127.0.0.1:8787` after the env was changed, with no way to see what it actually had.

- **Env** on every preview app (Preview tab) opens its environment: what the running process got when it started (recorded at launch), what it gets on its next start, and which layer each value comes from (task, other apps, preview env, local file rewrite, app env, Nightshift's port and host). Values that changed since the start are marked with the old value, with a button to restart the app.
- **`.env` files in the app's folder** (`.env`, `.env.development`, `.env.local`, `.env.development.local`, which Vite, Next.js and Bun load themselves) are listed too, marked as overridden when Nightshift passes the same key. A fixed localhost URL that is not overridden is flagged, because the app then talks to the owner's own server instead of the task's.
- Secret-looking keys and URL passwords are masked until "Show secrets". This is the owner's dashboard only; nothing here reaches a model. `PREVIEW_PORT` and `PREVIEW_URL_<APP>` exist only while apps run and are not counted as changes.
- API: `GET …/workspace/preview/env?service=<name>[&reveal=1]`.
- **Editing from the list**: any variable or `.env` file entry can be given its own value for that app ("Set", "Override"), a new one added, and the app's own values edited or removed. Changes are saved in the project's preview settings for that app (every task uses them from its next start; the panel then shows them as changed until a restart). Insert buttons offer the other apps' templates; on a fixed localhost URL a template replaces the origin and keeps the path. `PORT`/`HOST`/`BROWSER`, invalid names and still-masked values are refused. API: `PUT …/workspace/preview/env?service=` with `{ set, remove }`.

## D31. Env files an app loads over the environment are changed per task, invisibly to git (2026-10-20)

WonderCall's `apps/web/next.config.mjs` copies the committed `.public.env.local` into `process.env` (replacing what Nightshift passes) and then sets `NEXT_PUBLIC_API_URL` from `API_URL`, so every task's web called `127.0.0.1:8787`. The owner does not want the repository's env files changed for Nightshift, and picking another env mode does not help (every mode has fixed URLs).

- **File overrides** per app (`envFiles` on a preview service: file in the app's folder → variable → value, templates allowed): when the app starts, Nightshift writes the values into that file in the task's workspace (replacing the variable's line, or appending it). The original is kept under `<dataDir>/previews/env-originals/`.
- **Git never sees the edit**: a tracked file is marked `skip-worktree` (so `git status`, `git add -A`, explicit staging and `reset --hard` leave it alone; checked by hand and in e2e), an untracked one goes into `info/exclude`. Removing the override restores the original and clears the flag. Pull base restores the originals first (git refuses to merge over hidden edits), then writes the task's values again. Deleting a project restores them too. An agent running `git merge` itself on such a file gets git's refusal.
- **Found in the Env panel**: besides the standard `.env*` files, env-like files in the app's folder (`.public.env.local`, `.dev.vars`, …; not `.example`) are listed with the config or script files that mention them (e.g. "used by next.config.mjs") and a warning that such a config may replace the environment. Their rows offer "Change in this file"; standard files keep "Override for this app" (the environment wins there).
- Rejected: changing the files in the repository (the owner's call, and every developer's local setup would change), choosing an env mode (no mode has per-task URLs), and a Node preload that pins `process.env` (Node-only and invisible).

## D32. Umbra's review on the owner's subscription, through the Umbra server (2026-10-20)

`umbra review` (Umbra's path A) needs a metered `ANTHROPIC_API_KEY`; the owner has a Claude subscription. Umbra's path B runs the same review as a headless `claude -p` session in its Docker sandbox, but only inside the Umbra server (`POST /api/pathb-run` with `funnel: "review"`), asynchronously and one run at a time.

- **Bridge tester shipped with Nightshift**: `apps/daemon/testers/umbra-server.mjs` (plain Node, no dependencies), preset "Umbra review (subscription)", format Nightshift JSON. It resolves the merge base and HEAD as SHAs (Umbra reviews a clone of the worktree, where `origin/<base>` does not exist), checks the server is up, starts the review (waiting while another path-B run is active), follows `/api/stream` for `run.done` / `run.failed`, reads `/api/history/<runId>`, and maps findings with Umbra's own gate rule: verified blocker/major → blocking, verified minor/nit → advisory, unruled blocker/major → a decision, refuted → left out. A failed run, a timeout or a stopped server is reported as "could not run"; on SIGTERM it cancels the Umbra run.
- Testers get `NIGHTSHIFT_TESTERS` (that folder), `NIGHTSHIFT_NODE` (the node running Nightshift) and `NIGHTSHIFT_REMOTE`, so the command needs nothing on PATH.
- Nightshift commits the agent's work before testers run, so `HEAD` holds the change under review.
- Umbra is not modified. Requirements are Umbra's: `bun run serve`, Docker running, the sandbox image built, `UMBRA_SUBSCRIPTION_TOKEN` (or persisted in Setup). The e2e test uses a fake Umbra server with the same API.

## D33. Task ids: the owner's own, else the project's prefix and the next number (2026-10-20)

Nightshift's own tasks were always `T-<count + 1>`. The owner wants the board's ticket numbers, or at least a project-specific prefix.

- **Own id per task** (new task dialog, `id` on `POST …/tasks`): letters, digits, `.`, `_`, `-`, up to 40, starting with a letter or digit (no `/` or spaces: the id is part of the branch, the worktree folder, URLs and settings keys). It must be unique in the project ignoring case (branch names are lower-cased), also against ids that only survive in run history. Only for Nightshift's own task list; WonderCall gives its tasks their ids, so a typed id is refused there.
- **Otherwise the project's prefix** (project settings → Task id prefix, default `T`, a letter then up to 9 letters or digits, stored upper-case) and one above the highest number already used with that prefix, so own ids like `WC-10` and mixed histories never collide (the old count-based numbering could).
- **Existing tasks keep their ids**: renaming one would mean renaming its branch, workspace and pull request, and an open PR would lose its task.

## D34. Testers can be stopped, and queued testers run one at a time (2026-10-20)

A running tester could not be stopped (an Umbra review kept spending the subscription for up to 75 minutes, even after Pause or Stop), and two tasks running the Umbra tester at once both hit Umbra's one-at-a-time server: the second waited inside its own timeout, could time out, and its task then went on to the PR without the review.

- **Stop**: a running (or waiting) tester shows Stop on the task's Checks & review, both on its step and on its row under Testers (`POST …/testers/:id/stop`). Testers run in their own process group, which gets SIGTERM, then SIGKILL after 10 s; the Umbra bridge cancels its Umbra run on SIGTERM. The step ends as skipped with "Stopped by you"; a tester stopped alone is skipped and the checks go on.
- **Pause and Stop on a task stop its running testers** ("Stopped: the task was paused/stopped"), and that pass of the checks ends; after Resume the checks run again from the start.
- **Queue** (per tester, "One at a time"): testers with the same queue name run one after another across all tasks and projects, first come first served. A waiting tester's step shows who runs now and how many wait ahead; its timeout starts only when its turn comes. The Umbra subscription preset uses the queue `umbra`.
- Still open: a task whose tester waits or runs keeps its agent slot (the reviewing phase is active), so with 2 slots, two tasks waiting on Umbra hold both. And a blocking tester that could not run (server down, timeout) does not block the PR.

## D35. A tester can be required: it must run before the PR (2026-10-20)

A blocking tester that could not run (command missing, server down, timeout, no result) let the task go on to the PR without it, which silently skipped a gate such as Umbra.

- Per tester, **"Must run before the PR"** (`onError: "ask"`; off = `"skip"`, the old behaviour, still the default): when it cannot run during a task's checks, the task pauses in Needs info with a "A required test could not run" decision showing the error, and no PR is opened. Options: *Run it again* (the tests run again; asks again if it still cannot run), *Skip it for this change* (remembered for the current commit only; a later fix round runs it again), *Stop the task*. Any other answer counts as "run it again".
- Independent of Blocking: blocking decides whether its findings hold the PR, required decides whether its not running does.
- Stopping a required tester by hand counts as skipping it this time; pausing or stopping the task ends the pass as before (D34).
- The Umbra subscription preset is required by default.

## D36. A manual tester's blocking findings go straight to the agent (2026-10-20)

A "Run now" of Umbra's review reported BLOCKED, and nothing was fixed. Two causes: the tester was set to the Umbra format, which reads `umbra review`'s text, while `umbra-server.mjs` prints Nightshift JSON, so no finding was read and the step passed; and even when read, manual runs only asked "Send them to the agent to fix?" (D7). The owner wants the review to trigger the fix.

- A manual run's blocking findings are sent to the agent at once (like PR feedback: the task goes to fixing, then back through the checks and the PR); with no free slot they wait as a message. Undecided findings still come to the owner as decisions first, and their answers carry the blocking issues to the agent. A run that is working, done, failed or stopped is left alone.
- The Umbra format reads Nightshift JSON when the output is JSON, so either format works for `umbra-server.mjs`.
- A BLOCKED verdict whose findings cannot be read becomes a blocking issue instead of a pass.


## D37. Nightshift stops runaway processes, whatever the project's scripts do (2026-10-21)

A WonderCall package had `"lint": "turbo lint"`: inside that package turbo runs the package's own `lint`, which runs turbo again, forever. Checks and the agent's `bun run lint` left the chain running after the top-level lint exited; it reached ~1,200 turbo processes (~185 GB) and crashed the Mac twice. Imported projects cannot all be fixed, so the guard lives in Nightshift.

- **Process guard** (`apps/daemon/src/process-guard.ts`), started with the daemon: once a second it reads the process table and follows every process the daemon started (agent commands, checks, testers, setup, previews, terminals). A process is remembered once seen, so a tree stays watched after launchd adopts it; an orphan whose working directory is inside the data folder (the task worktrees) is adopted too, for commands that background a script and exit.
- A tree is frozen (SIGSTOP, so it cannot spawn between the scan and the kill) and killed when the same command runs inside itself 5 levels deep (a script that calls itself; caught in about a second), when it runs more than 800 processes, or when it holds more than 40% of the machine's memory. It is logged and shown as an error event on the task whose worktree it ran in.
- **Checks** run with `group: true`: after the command exits, everything it started is killed, including tasks turbo moved to their own process group, and the check stops above 500 processes.
- Not covered: processes inside Docker containers (the Docker VM caps their memory) and processes the owner starts outside Nightshift.

## D38. A new run of a task keeps its pull request (2026-10-21)

A message on a failed task starts a new run on the same branch, but the run did not carry the PR number, so the push asked "Push 0 commits and open the pull request?" for a branch that already had PR #1294.

- A run that continues the previous run's branch takes over its PR number and URL.
- Before asking to push, a run with no PR looks for an open PR on its branch and continues it ("Continuing the open PR #n"), so a PR opened by hand or lost from the run is used too.

## D39. CI failures and review findings that are not this branch's do not fail the task (2026-10-21)

W-5087 and W-6075 failed with "CI still fails … a human needs to look": the failing check (`Errors are values and types are honest`) also failed on `main`, so the agent rightly changed nothing, and the next look at CI failed the task. Review bots also repeat findings that are already fixed (Greptile answered a retest of a fixed migration with "the finding still applies"), and every repeat started another fix round.

- **Fails on the base branch too**: before a CI failure goes to the agent, Nightshift reads the latest finished result of each check on the base branch's last 5 commits (`PrHost.baseChecks`, cached per head commit). A check failing there is not sent to the agent and does not hold the task.
- **The agent can report what is not its to fix** (`report_not_caused_here`): a failing check this branch did not cause (e.g. from another pull request), or a review finding already fixed in the current code or not applying, each with its evidence. The feedback message lists review comments with ids for this. The reasons go on the task as a comment, so the reviewer can send it back.
- Such checks are shown as "not caused by this change" (minor, not blocker), commented on the task once per commit, and CI counts as passed without them: the task goes to Ready for review. If the agent neither fixes nor reports a failing check, the task still fails as before.
- **Stale repeats**: an inline finding is identified by its file and title, a reply by its thread's first comment. Once reported as fixed or not applying, a repeat by anyone but the owner (`gh` login) is not sent to the agent; the task shows "Not sent to the agent: n repeated finding(s) …". The owner's own comments always go through.
- Asking a bot to re-review is D40.

## D40. Commands on the PR are not feedback, and the agent's PR comments need the owner's approval (2026-10-21)

The owner's "@greptile-apps retest" comments and Greptile's "Retested: …" answers reached the agent as review feedback and started fix rounds. The owner also wants a bot re-check to be possible from Nightshift, without the agent posting on its own and without a loop of retests.

- **Not feedback**: a command (one short line starting with `@` or `/`, at most 6 words, e.g. "@greptile-apps retest", "/retest"), the answer right after a command in the same inline thread (or, on the main thread, by the bot the command mentions), and every comment Nightshift posted itself (it carries a hidden `<!-- nightshift:… -->` marker). The task shows how many were left out. Longer messages that mention a bot are still feedback.
- **The agent proposes, the owner approves** (`propose_pr_comment`, decision "Approve a comment on the pull request" with Post it / Don't post): nothing is posted before "Post it". The proposal does not pause the task, other decisions do not wait for it, and a message on the task does not answer it; only its own buttons do. The agent still cannot use `gh pr` or `gh api` (the guard blocks them).
- **No recurring loop**: the posted comment is marked, so it is never read back as feedback; the bot's answer to it is an answer to a command, so it starts no fix round and no new proposal; at most one proposal per thread per commit and 5 per task; posting is skipped when a comment with the same marker is already on the PR, so a crash and retry posts once.

## D41. PR triggers only take PRs no task owns (2026-10-21)

The PR triggers (`watchAgentPrs`) made a new task for any open `nightshift/` PR with no active run. When a task failed ("a human needs to look"), its PR had no active run, so within seconds a trigger made "Fix failing CI on PR #…" or "Address review feedback on PR #…" for it. That task failed the same way, and the next trigger followed: T-5 to T-11 on PRs #1266, #1270 and #1294, with chained titles.

- A PR that any task has worked on (same branch or PR number) stays with that task, whatever its phase. When that task failed or was stopped, the triggers log once that the PR belongs to it (the first task on the PR) and that a message to it continues the work.
- Triggers only make tasks for PRs no task owns (e.g. a branch pushed outside a run, or a run history that was lost), and use the same filters as runs: CI checks that also fail on the PR's base branch (D39) and commands, answers to commands and Nightshift's own comments (D40) do not count.

## D42. The owner can mark a task done (2026-10-21)

Some tasks cannot be finished by Nightshift: the CI failure comes from another branch, the change landed elsewhere, or the task is a duplicate (T-4 to T-11 from D41). They stayed Failed with no way to close them.

- **Mark as done** on the task (any phase except done; `POST /api/runs/:id/complete` with an optional `reason`): asks for confirmation and an optional reason, stops the agent and its testers, closes open decisions ("Closed: the task was marked done"), posts "Marked done by the owner: <reason>" on the task, sets the task's status to Done in its source (for WonderCall that is a status change there, keyed so a retry does it once), releases the lease, and ends the run as done (previews stop, the task database is dropped, terminals close; the worktree and branch stay).
- The pull request stays open and is no longer watched: agents never merge or close PRs, so the owner merges or closes it on GitHub. A PR whose task is done is not picked up by the triggers (D41).

## D43. The owner can archive stale tasks (2026-10-23)

Stale tasks (abandoned, superseded, waiting on a PR nobody will review) stayed in the list and kept being watched. Marking them done (D42) is wrong for them: it posts a comment and moves the task to Done in its source.

- **Archive** on the task row or the task page (`PUT /api/projects/:p/tasks/:t/archive` with `{ archived }`) is Nightshift-only: nothing is posted on the task and its status in the source does not change. A run that is still going or waiting (on CI, review or a decision) ends as stopped: the agent and testers stop, open decisions close ("Closed: the task was archived"), the lease is released, the PR stays open and is no longer watched; the worktree and branch stay. The task page asks first when a run would stop; the row button is hidden while the agent is working.
- Archived tasks are hidden from the list and its counts (an "Archived" filter shows them), are never picked up even if Ready for AI, and refuse messages and Retry until unarchived. **Unarchive** only clears the flag; the stopped run is continued with a message or Retry as usual.

## D44. A task can work in the owner's project folder, on its checked-out branch (2026-10-24)

The owner wants an agent to continue work that is already on a local branch with a pushed pull request, in their own checkout, instead of a new worktree (a worktree cannot even check out a branch the folder has checked out, and a big repository needs a fresh install per worktree). New fact for D6: the owner wants agents to continue the owner's own branches and PRs.

- **New task → "Where the agent works": My project folder** (`workIn: "folder"`; `GET /api/projects/:id/folder` shows the folder's branch, PR, uncommitted changes and why it cannot be used). The run's worktree is the project folder and its branch is the branch checked out there; its PR is found and reused. The task list marks such tasks "your folder".
- **Refused** on the base branch, on a detached HEAD, and while another folder task of the project is active (one at a time; a second one is not picked up until the first ends).
- **Uncommitted changes** in the folder pause the task before the agent starts ("Include them in the agent's work / Stop the task"), because its commits would include them.
- **Branch switched by the owner**: the task stops with a clear message before any commit or push, rather than commit to the wrong branch.
- **Nothing destructive in the folder**: the reviewer's `reset --hard` / `clean` is skipped, and so are the setup command, copying local files and env-file overrides (D31). Pushes never force (a remote branch with commits the folder lacks stops the task: "git pull in the folder, then retry"). Deleting the project never removes the folder.
- **D6 amended**: a folder task on a branch outside the agent prefix may push to it, but **every push asks the owner first**, whatever the project's push mode. Branches under the prefix follow the project's push mode as before.
- Commit subjects count only the agent's commits since the task started, not the owner's earlier ones.

## D45. Moving existing pull requests into Nightshift: continue a PR on its own branch, in a worktree (2026-10-24)

The owner has a few pull requests started outside Nightshift and wants agents to finish them on their branches, while new work keeps using worktrees. The folder mode (D44) works one task at a time in the owner's checkout, so it does not fit moving several PRs.

- **New task → "Continue a pull request"** (`workIn: "pr"`, `pr: <number>`; `GET /api/projects/:id/pulls` lists the open PRs): the task gets a worktree of its own on the PR's branch (the same path the PR listeners use), its base is the PR's base, and pushing updates that PR (found by branch, never a new one). Several can run side by side.
- **A PR cannot be continued** while a task works on its branch, while the branch is checked out in the project folder or another worktree (git allows one checkout per branch; the folder case suggests folder mode), or while the owner's local branch of that name has commits the PR lacks: creating the worktree resets that local branch to the PR's head, so they must be pushed first.
- **The owner's branches** (anything outside the agent prefix, whether continued here or in the folder) are never force-pushed, and every push asks first whatever the project's push mode (extends D44's amendment of D6). A push rejected because the PR branch moved stops the task with what to do.
- Commit subjects count only the agent's commits since the task started, for any task that starts on an existing branch.

## D46. Team mode: a lead agent hands pieces of a task to worker agents, each in its own worktree (2026-10-24)

The owner wants bigger tasks spread over several agents inside one task, as an option per task.

- **Per task** (New task → Agents: One agent / A team, with 2–5 workers; `team: { workers }`). Off by default; a single-agent task works exactly as before.
- **The lead** is the task's normal conversation plus the `nightshift-team` extension: a `delegate` tool (pieces with a title, a self-contained brief and the files they touch; at most the team size) and a prompt section on when to split (cleanly separable parts) and when not to (small or coupled work). Delegating ends the lead's turn, like `ask_question`.
- **A hand-out**: Nightshift commits the lead's work, creates a worktree per piece on a local sub-branch `<task branch>--w<n>` starting at that commit (local files copied, setup run once per worker), and runs the workers in parallel. Workers are conversations with only read/write/edit/bash (no task tools: they cannot ask the owner, comment or delegate) and a worker prompt (stay in your piece, do not commit, report blockers in the summary). Nightshift commits each worker's work, merges the branches into the task branch in order (`--no-ff`), leaves a conflicting branch unmerged with its files listed, removes the worker worktrees (the branches stay, never pushed), and resumes the lead with every worker's outcome and summary and how to merge a conflicting branch. The lead then integrates, may delegate again, and the task continues as usual (checks, review, testers, one PR).
- Built in Nightshift on the `AgentRunner` (`createWorker`, `enableTeam`), not on Pi Durable's subagents, so the runner stays replaceable. Hand-outs and workers are stored per run (`team:<run>`); after a restart a hand-out resumes (finished workers are not run again). Pause/Stop abort the workers too; a worker stopped by Pause starts a new turn on resume.
- Workers use the lead's model, do not take agent slots, and their usage counts toward the task's budget. Each worker is listed as a "Worker" session (its transcript is viewable) and in the task page's Team panel (status, branch, merged / conflict / no changes, brief and summary); the task list marks team tasks.
- **On an existing task** (task page → the Agents menu next to the type, `PUT …/tasks/:t/team` with `{ workers }` or `null`; refused for done tasks): the lead conversation gets or loses the team extension before its next turn, so a running task can split the remaining work from its next step (after a message, a PR round, or a resume). Turning it off does not stop a hand-out already running; its workers finish and are merged first.

## D47. @ file mentions in the composer, like Claude Code (2026-10-24)

The owner wants to point the agent at files from the message box the way Claude Code's `@` does.

- **Picker**: typing `@` in the task's message box or the New task description lists files (git's tracked and untracked, not ignored, plus folders) of the task's workspace, or of the project folder before the task has one (`GET /api/projects/:p/files/search?q=&task=`, fuzzy: characters in order, file name and runs rank higher). Arrow keys, Enter/Tab to insert `@path`, Escape to close; a folder keeps the list open inside it.
- **What the agent gets**: when a message (or the task description in the first prompt, or a message sent while it works) reaches the agent, Nightshift appends the contents of every mentioned file read from the run's workspace at that moment, under "Files the owner pointed to with @" (up to 20 files, 60 KB each, 200 KB together; longer files are cut with a note; binary files and folders show as a note and a listing). Paths outside the workspace, `.git`, and protected local files (D25) are not shown; an `@` before something that is not an existing path (an e-mail address, a name) stays plain text.
- The conversation shows the message as written, with the appended files folded under "N files shown to the agent".
- **In the project brief** too (project settings and the brief step of New project): the same picker, searching the project folder. The brief goes into an agent's instructions when its conversation starts (the agent, a new session, a team worker), so its @-mentioned files are read from that conversation's workspace then, with the same limits and protections; a later change to a mentioned file reaches agents started after it.

## D48. Reference folders: other projects or folders agents may read, never change (2026-10-24)

The owner wants to point agents at another project as a reference (how something is done there), not only at files of the task's own repository. `@../` cannot do that safely: a mention sends the file to the model provider, and the agent is confined to its workspace.

- **Project settings → References** (`references: [{ name, path }]`, up to 10): another Nightshift project in one click, or any folder (Browse). Refused: invalid or duplicate names, missing folders, the project's own repository, hidden folders themselves (`~/.ssh`, `~/.aws`) and folders too broad to be a reference (`/`, the home folder).
- **Mentions**: `@name:path` (and `@name:` for the top folder). The picker lists the references with the workspace's files and searches inside one after `name:` (git's file list, or a scan of up to 20,000 files for folders that are not git checkouts or that git ignores). The agent gets the contents marked as a read-only reference with its absolute path.
- **The agent may read them itself**: its prompt lists the reference folders, and the workspace guard lets the `read` tool open files inside them while `write`/`edit` there are blocked ("read-only reference folder").
- **Never read from a reference**, neither by mentions, the picker nor the agent's read tool: hidden files and folders, `.env*`, key and certificate files, `id_*` SSH keys, anything named credential/secret, `.npmrc`/`.netrc`, `.git`, `node_modules`.
- Bash is not path-guarded (as before, D25 covers protected files of the workspace only); the prompt tells the agent never to change references.
