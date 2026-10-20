import { randomUUID } from "node:crypto";
import type { Lease, TaskComment, TaskDetail, TaskRef, TaskSource, TaskStatus, TaskSummary } from "@nightshift/core";
import type { Store } from "@nightshift/store";

const LEASE_MS = 5 * 60_000;

export class LocalTaskSource implements TaskSource {
  readonly name = "nightshift";

  constructor(
    private readonly store: Store,
    readonly projectId: string,
  ) {}

  async connect() {}

  async close() {}

  private live(expiresAt: string | null) {
    return expiresAt !== null && new Date(expiresAt).getTime() > Date.now();
  }

  async listTasks(): Promise<TaskSummary[]> {
    return this.store.localTasks(this.projectId).map((t) => ({ id: t.id, title: t.title, status: t.status, createdAt: t.createdAt, updatedAt: t.updatedAt }));
  }

  async createTask(input: { title: string; body: string }): Promise<TaskDetail> {
    const t = this.store.createLocalTask(this.projectId, input.title, input.body);
    return this.getTask(t.id);
  }

  async listReady(): Promise<TaskRef[]> {
    return this.store
      .localTasks(this.projectId)
      .filter((t) => t.status === "ready_for_ai" && !this.live(t.leaseExpiresAt))
      .reverse()
      .map((t) => ({ id: t.id, title: t.title, updatedAt: t.updatedAt }));
  }

  async claim(taskId: string): Promise<Lease | null> {
    const t = this.store.localTask(this.projectId, taskId);
    if (!t || this.live(t.leaseExpiresAt)) return null;
    const lease = { taskId, leaseId: randomUUID(), expiresAt: new Date(Date.now() + LEASE_MS).toISOString() };
    this.store.updateLocalTask(this.projectId, taskId, { leaseId: lease.leaseId, leaseExpiresAt: lease.expiresAt });
    return lease;
  }

  async renew(lease: Lease): Promise<Lease | null> {
    const t = this.store.localTask(this.projectId, lease.taskId);
    if (!t || t.leaseId !== lease.leaseId) return null;
    const renewed = { ...lease, expiresAt: new Date(Date.now() + LEASE_MS).toISOString() };
    this.store.updateLocalTask(this.projectId, lease.taskId, { leaseExpiresAt: renewed.expiresAt });
    return renewed;
  }

  async release(lease: Lease): Promise<void> {
    const t = this.store.localTask(this.projectId, lease.taskId);
    if (t?.leaseId === lease.leaseId) this.store.updateLocalTask(this.projectId, lease.taskId, { leaseId: null, leaseExpiresAt: null });
  }

  async getTask(taskId: string): Promise<TaskDetail> {
    const t = this.store.localTask(this.projectId, taskId);
    if (!t) throw new Error(`task ${taskId} not found`);
    return { id: t.id, title: t.title, body: t.body, status: t.status };
  }

  async listComments(taskId: string): Promise<TaskComment[]> {
    return this.store.localComments(this.projectId, taskId);
  }

  async comment(taskId: string, body: string): Promise<TaskComment> {
    return this.store.addLocalComment(this.projectId, taskId, "Nightshift", true, body);
  }

  async setStatus(taskId: string, status: TaskStatus): Promise<void> {
    this.store.updateLocalTask(this.projectId, taskId, { status });
  }
}
