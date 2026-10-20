import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  WONDERCALL_SERVICE_TOOLS as S,
  WONDERCALL_TASK_TOOLS as T,
  type Lease,
  type McpClaimResult,
  type McpListReadyResult,
  type McpRenewResult,
  type TaskComment,
  type TaskDetail,
  type TaskRef,
  type TaskSource,
  type TaskStatus,
  type TaskSummary,
} from "@nightshift/core";

export class McpToolError extends Error {
  constructor(
    readonly tool: string,
    message: string,
  ) {
    super(`${tool}: ${message}`);
  }
}

export class WonderCallMcpSource implements TaskSource {
  readonly name = "wondercall";
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;

  constructor(
    readonly url: string,
    readonly token: string | undefined,
    readonly projectId?: string,
  ) {}

  private scope(): Record<string, unknown> {
    return this.projectId ? { projectId: this.projectId } : {};
  }

  private async connected(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = new Client({ name: "nightshift", version: "0.1.0" });
        const transport = new StreamableHTTPClientTransport(new URL(this.url), {
          requestInit: { headers: this.token ? { Authorization: `Bearer ${this.token}` } : {} },
        });
        await client.connect(transport);
        this.client = client;
        return client;
      })().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  async connect() {
    await this.connected();
  }

  async close() {
    const client = this.client;
    this.client = null;
    await client?.close();
  }

  async call<R>(tool: string, args: Record<string, unknown>): Promise<R> {
    let client = await this.connected();
    let result;
    try {
      result = await client.callTool({ name: tool, arguments: args });
    } catch (error) {
      this.client = null;
      client = await this.connected();
      result = await client.callTool({ name: tool, arguments: args });
    }
    const text = Array.isArray(result.content)
      ? result.content.map((c) => (c && typeof c === "object" && "text" in c ? String(c.text) : "")).join("")
      : "";
    if (result.isError) throw new McpToolError(tool, text || "tool error");
    if (result.structuredContent) return result.structuredContent as R;
    return (text ? JSON.parse(text) : {}) as R;
  }

  async listReady(): Promise<TaskRef[]> {
    return (await this.call<McpListReadyResult>(S.listReady, this.scope())).tasks;
  }

  async listTasks(): Promise<TaskSummary[]> {
    return (await this.call<{ tasks: TaskSummary[] }>(S.listTasks, this.scope())).tasks;
  }

  async createTask(input: { title: string; body: string }): Promise<TaskDetail> {
    return this.call<TaskDetail>(S.createTask, { ...this.scope(), title: input.title, body: input.body });
  }

  async claim(taskId: string): Promise<Lease | null> {
    const result = await this.call<McpClaimResult>(S.claim, { taskId });
    return result.claimed ? { taskId, leaseId: result.leaseId, expiresAt: result.expiresAt } : null;
  }

  async renew(lease: Lease): Promise<Lease | null> {
    const result = await this.call<McpRenewResult>(S.renew, { taskId: lease.taskId, leaseId: lease.leaseId });
    return result.renewed ? { ...lease, expiresAt: result.expiresAt } : null;
  }

  async release(lease: Lease): Promise<void> {
    await this.call(S.release, { taskId: lease.taskId, leaseId: lease.leaseId });
  }

  async getTask(taskId: string): Promise<TaskDetail> {
    return this.call<TaskDetail>(T.get, { taskId });
  }

  async listComments(taskId: string): Promise<TaskComment[]> {
    return (await this.call<{ comments: TaskComment[] }>(T.listComments, { taskId })).comments;
  }

  async comment(taskId: string, body: string, idempotencyKey: string): Promise<TaskComment> {
    return this.call<TaskComment>(T.comment, { taskId, body, idempotencyKey });
  }

  async setStatus(taskId: string, status: TaskStatus, idempotencyKey: string): Promise<void> {
    await this.call(S.setStatus, { taskId, status, idempotencyKey });
  }
}
