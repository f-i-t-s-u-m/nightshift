import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  WONDERCALL_SERVICE_TOOLS as S,
  WONDERCALL_TASK_TOOLS as T,
  type TaskComment,
  type TaskDetail,
  type TaskStatus,
} from "@nightshift/core";

export type MockTask = TaskDetail & {
  projectId: string;
  createdAt: string;
  updatedAt: string;
  createdBy: "human" | "inbound";
  comments: TaskComment[];
  claim: { leaseId: string; expiresAt: string } | null;
  statusHistory: Array<{ status: TaskStatus; at: string }>;
};

export type MockState = {
  tasks: MockTask[];
  callLog: Array<{ tool: string; args: unknown; at: string }>;
  idempotency: Record<string, unknown>;
};

export type MockOptions = {
  port?: number;
  token?: string;
  leaseMs?: number;
  tasks?: Array<Partial<MockTask> & { id: string; title: string; body: string }>;
};

const nowIso = () => new Date().toISOString();
const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

export function createMockState(tasks: MockOptions["tasks"] = []): MockState {
  return {
    tasks: tasks.map((t) => ({
      status: "ready_for_ai",
      projectId: "default",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      createdBy: "human",
      comments: [],
      claim: null,
      statusHistory: [],
      acceptanceCriteria: [],
      attachments: [],
      ...t,
    })) as MockTask[],
    callLog: [],
    idempotency: {},
  };
}

function buildServer(state: MockState, leaseMs: number) {
  const server = new McpServer({ name: "wondercall-mock", version: "0.1.0" });
  const find = (taskId: string) => state.tasks.find((t) => t.id === taskId);
  const log = (tool: string, args: unknown) => state.callLog.push({ tool, args, at: nowIso() });
  const once = <R>(key: string | undefined, make: () => R): R => {
    if (key && key in state.idempotency) return state.idempotency[key] as R;
    const value = make();
    if (key) state.idempotency[key] = value;
    return value;
  };
  const leaseLive = (t: MockTask) => t.claim && new Date(t.claim.expiresAt).getTime() > Date.now();

  const inProject = (t: MockTask, projectId?: string) => !projectId || t.projectId === projectId;

  server.registerTool(S.listReady, { description: "Tasks ready for AI", inputSchema: { projectId: z.string().optional() } }, async ({ projectId }) => {
    log(S.listReady, { projectId });
    const tasks = state.tasks
      .filter((t) => inProject(t, projectId) && t.status === "ready_for_ai" && t.createdBy === "human" && !leaseLive(t))
      .map((t) => ({ id: t.id, title: t.title }));
    return json({ tasks });
  });

  server.registerTool(S.listTasks, { description: "All tasks of a project", inputSchema: { projectId: z.string().optional() } }, async ({ projectId }) => {
    log(S.listTasks, { projectId });
    const tasks = state.tasks
      .filter((t) => inProject(t, projectId))
      .map((t) => ({ id: t.id, title: t.title, status: t.status, createdAt: t.createdAt, updatedAt: t.updatedAt }));
    return json({ tasks });
  });

  server.registerTool(
    S.createTask,
    { description: "Create a task", inputSchema: { projectId: z.string().optional(), title: z.string(), body: z.string() } },
    async ({ projectId, title, body }) => {
      log(S.createTask, { projectId, title });
      const id = `WC-${100 + state.tasks.length + 1}`;
      const [task] = createMockState([{ id, title, body, projectId: projectId ?? "default" }]).tasks;
      state.tasks.push(task);
      const { comments: _c, claim: _l, statusHistory: _h, createdBy: _b, ...detail } = task;
      return json(detail);
    },
  );

  server.registerTool(S.claim, { description: "Claim a task", inputSchema: { taskId: z.string() } }, async ({ taskId }) => {
    log(S.claim, { taskId });
    const task = find(taskId);
    if (!task) return fail("not_found");
    if (leaseLive(task)) return json({ claimed: false, reason: "already_claimed" });
    task.claim = { leaseId: randomUUID(), expiresAt: new Date(Date.now() + leaseMs).toISOString() };
    return json({ claimed: true, ...task.claim });
  });

  server.registerTool(S.renew, { description: "Renew a claim", inputSchema: { taskId: z.string(), leaseId: z.string() } }, async ({ taskId, leaseId }) => {
    log(S.renew, { taskId });
    const task = find(taskId);
    if (!task || task.claim?.leaseId !== leaseId) return json({ renewed: false, reason: "lease_lost" });
    task.claim.expiresAt = new Date(Date.now() + leaseMs).toISOString();
    return json({ renewed: true, expiresAt: task.claim.expiresAt });
  });

  server.registerTool(S.release, { description: "Release a claim", inputSchema: { taskId: z.string(), leaseId: z.string() } }, async ({ taskId, leaseId }) => {
    log(S.release, { taskId });
    const task = find(taskId);
    if (task?.claim?.leaseId === leaseId) task.claim = null;
    return json({ released: true });
  });

  server.registerTool(
    S.setStatus,
    { description: "Set task status", inputSchema: { taskId: z.string(), status: z.string(), idempotencyKey: z.string().optional() } },
    async ({ taskId, status, idempotencyKey }) => {
      log(S.setStatus, { taskId, status });
      const task = find(taskId);
      if (!task) return fail("not_found");
      return json(
        once(idempotencyKey, () => {
          task.status = status as TaskStatus;
          task.updatedAt = nowIso();
          task.statusHistory.push({ status: task.status, at: nowIso() });
          return { ok: true };
        }),
      );
    },
  );

  server.registerTool(T.get, { description: "Get a task", inputSchema: { taskId: z.string() } }, async ({ taskId }) => {
    log(T.get, { taskId });
    const task = find(taskId);
    if (!task) return fail("not_found");
    const { comments: _c, claim: _l, statusHistory: _h, createdBy: _b, ...detail } = task;
    return json(detail);
  });

  server.registerTool(T.listComments, { description: "List task comments", inputSchema: { taskId: z.string() } }, async ({ taskId }) => {
    log(T.listComments, { taskId });
    const task = find(taskId);
    if (!task) return fail("not_found");
    return json({ comments: task.comments });
  });

  server.registerTool(
    T.comment,
    { description: "Comment on a task as the agent", inputSchema: { taskId: z.string(), body: z.string(), idempotencyKey: z.string().optional() } },
    async ({ taskId, body, idempotencyKey }) => {
      log(T.comment, { taskId, body });
      const task = find(taskId);
      if (!task) return fail("not_found");
      return json(
        once(idempotencyKey, () => {
          const comment: TaskComment = { id: randomUUID(), author: "Nightshift", authorIsAgent: true, body, createdAt: nowIso() };
          task.comments.push(comment);
          return comment;
        }),
      );
    },
  );

  return server;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export type MockServer = {
  url: string;
  state: MockState;
  server: Server;
  addHumanComment(taskId: string, body: string, author?: string): TaskComment;
  close(): Promise<void>;
};

export async function startMockWonderCall(options: MockOptions = {}): Promise<MockServer> {
  const state = createMockState(options.tasks);
  const leaseMs = options.leaseMs ?? 5 * 60_000;

  const addHumanComment = (taskId: string, body: string, author = "Product owner") => {
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`task ${taskId} not found`);
    const comment: TaskComment = { id: randomUUID(), author, authorIsAgent: false, body, createdAt: nowIso() };
    task.comments.push(comment);
    return comment;
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/mcp") {
        if (options.token && req.headers.authorization !== `Bearer ${options.token}`) return send(res, 401, { error: "unauthorized" });
        const body = req.method === "POST" ? await readBody(req) : undefined;
        const mcp = buildServer(state, leaseMs);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => {
          void transport.close();
          void mcp.close();
        });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }
      if (url.pathname === "/admin/state" && req.method === "GET") return send(res, 200, state);
      const commentMatch = url.pathname.match(/^\/admin\/tasks\/([^/]+)\/comments$/);
      if (commentMatch && req.method === "POST") {
        const body = (await readBody(req)) as { body: string; author?: string };
        return send(res, 200, addHumanComment(decodeURIComponent(commentMatch[1]), body.body, body.author));
      }
      if (url.pathname === "/admin/tasks" && req.method === "POST") {
        const body = (await readBody(req)) as { id: string; title: string; body: string; createdBy?: "human" | "inbound" };
        state.tasks.push(...createMockState([body]).tasks);
        return send(res, 200, { ok: true });
      }
      send(res, 404, { error: "not_found" });
    } catch (error) {
      if (!res.headersSent) send(res, 500, { error: String(error) });
    }
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    state,
    server,
    addHumanComment,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
