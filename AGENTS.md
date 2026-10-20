Nightshift is a local, always-on AI engineering team built on Pi Durable. Read [README.md](README.md) and the docs it lists before working.

- Decisions live in [docs/decisions.md](docs/decisions.md). Do not reopen a decision there without a new fact; add a new entry instead.
- Every side effect outside the process (git push, PR create, task comment, status change) must be safe to repeat after a crash. See [docs/pi-durable.md](docs/pi-durable.md).
- Keep Pi Durable behind the `AgentRunner` interface described in [docs/architecture.md](docs/architecture.md).
- Agents never merge, never touch production secrets, and only take tasks a human created or moved to "Ready for AI".
- Keep this file brief; put detailed rules in `docs/`.
