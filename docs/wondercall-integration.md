# WonderCall integration

WonderCall is the first task source. The integration is an MCP server hosted by the WonderCall API. This is the only work needed inside the WonderCall repo.

## What WonderCall has today (checked 2026-10-16)

- **Task API:** `apps/api/src/routes/api/v1/tasks.ts`, mounted at `/v1/tasks`: list, create, get, update, comments, attachments, chat sessions and messages, status events, AI cost, position.
- **Auth:** all of `/v1` goes through `validateAuthCookie` (`apps/api/src/routes/api/v1.ts`), which accepts only a session cookie or a browser-extension token. **An external process cannot read or update tasks today.**
- **`PrivateApiKey`:** project-scoped, stored in plain text (a TODO says to hash it), resolved to the project owner by `middleware/serviceAuth.ts`, and only wired into the voice and public-agents routes.
- **No** personal access tokens, OAuth clients for third parties, outgoing webhooks, or task MCP server. The only MCP server is the WhatsApp one in `apps/integrations/whatsapp/mcp-server`, which reads the database directly; do not copy that pattern.
- **Task model:** one `assigneeId`, which must be a `User`. Comments (`TaskComment`) and status events (`TaskStatusEvent`) need a `User` author. There is no bot or agent user kind.
- **Statuses:** custom statuses (`TaskStatusDefinition`) with groups TODO, IN_PROGRESS, UPCOMING, DONE, CANCELLED. "Ready for AI", "Needs info" and "Ready for review" can be created as custom statuses today without code changes.
- **Claim pattern to copy:** the proposal-run lease columns on `Task` (`aiProposalGenerationStartedAt`, `…HeartbeatAt`).
- **Realtime:** Soketi per-user channels. Not needed for Nightshift, which polls.

## What WonderCall needs

### 1. Agent token

A hashed, workspace-scoped token sent as `Authorization: Bearer <token>`.

- Two scopes: a **service** token for Nightshift's own code, and a **task** token for one claimed task, given to the model.
- Acts as an agent user, so every action appears in the task timeline under that user.
- Fix `PrivateApiKey` plain-text storage at the same time, or use a new table.

### 2. Agent user

- v1: a normal user account named "Nightshift" in the workspace. No code change.
- Later: `User.kind = HUMAN | AGENT` so the app can show a bot badge and exclude agents from seat counts.

### 3. MCP endpoint

Hosted in the WonderCall API at `/mcp`, Streamable HTTP transport, going through the same service layer and permission checks as `/v1/tasks`.

**Service tools (called by Nightshift's code, never by the model):**

| Tool | Behaviour |
|---|---|
| `list_ready_tasks` | Tasks in "Ready for AI" in the token's workspace (optionally one `projectId`), created or approved by a human |
| `list_tasks` | All tasks of a project with their status, for Nightshift's task list |
| `create_task` | Create a task in a project (title, body), used by "New task" in Nightshift |
| `claim_task` | Locks the task in the database, returns a lease with an expiry. Fails if already claimed |
| `renew_claim` | Extends the lease |
| `release_task` | Ends the lease |
| `set_task_status` | Moves the task; takes an idempotency key |

**Task tools (given to the model, limited to the claimed task):**

| Tool | Behaviour |
|---|---|
| `get_task` | Title, body, acceptance criteria, custom fields |
| `list_comments` | Comments on the task |
| `get_attachment` | One attachment's content or a signed URL |
| `post_comment` | Comment as the agent user; takes an idempotency key |
| `ask_question` | Comment, then move the task to "Needs info" |
| `attach_file` | Add a screenshot or log |
| `search_tasks` | Read-only search for related tasks |

### 4. Safety on the WonderCall side

- A task token can reach only its own task, so a task with injected instructions cannot read or change other tasks.
- Agents cannot delete, reassign or change workspace settings.
- Every MCP call is logged as the agent user.
- Tasks created from inbound email or WhatsApp are not returned by `list_ready_tasks` until a human moves them to "Ready for AI".

## Workspace setup (no code)

1. Create the custom statuses "Ready for AI", "Needs info" and "Ready for review".
2. Create the "Nightshift" user and add it to the workspace.
3. Optional: a "Repo" custom field when tasks span more than one repository.

## Coordination with Umbra

Umbra's backlog item #137 ("Tickets in from the board, results back") plans the same WonderCall connection over the API. Agree one shape with the Umbra owner so it is not built twice.
