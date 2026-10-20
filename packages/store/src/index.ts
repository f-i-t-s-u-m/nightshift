import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  addUsage,
  emptyUsage,
  type ModelUsage,
  type Project,
  type TaskComment,
  type TaskStatus,
  type Run,
  type RunEvent,
  type RunEventType,
  type RunPhase,
  type UsageDay,
  type UsageTotals,
} from "@nightshift/core";

type Row = Record<string, unknown>;

const RUN_COLUMNS: Record<keyof Omit<Run, "usage" | "paused">, string> = {
  id: "id",
  projectId: "project_id",
  taskId: "task_id",
  taskTitle: "task_title",
  source: "source",
  slot: "slot",
  phase: "phase",
  branch: "branch",
  baseBranch: "base_branch",
  worktree: "worktree",
  conversationId: "conversation_id",
  prNumber: "pr_number",
  prUrl: "pr_url",
  headSha: "head_sha",
  fixRounds: "fix_rounds",
  leaseId: "lease_id",
  leaseExpiresAt: "lease_expires_at",
  lastCommentSeenAt: "last_comment_seen_at",
  activity: "activity",
  error: "error",
  model: "model",
  createdAt: "created_at",
  updatedAt: "updated_at",
};

const now = () => new Date().toISOString();
const today = () => now().slice(0, 10);

function rowToRun(row: Row): Run {
  const run = {} as Record<string, unknown>;
  for (const [key, column] of Object.entries(RUN_COLUMNS)) run[key] = row[column] ?? null;
  run.paused = row.paused === 1;
  run.usage = row.usage_json ? JSON.parse(String(row.usage_json)) : emptyUsage();
  run.fixRounds = Number(row.fix_rounds ?? 0);
  return run as Run;
}

export type LocalTask = {
  projectId: string;
  id: string;
  title: string;
  body: string;
  status: TaskStatus;
  leaseId: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type StoredAttachment = { id: string; name: string; mimeType: string; size: number; path: string; createdAt: string };

export type StoredMessage = {
  id: string;
  projectId: string;
  taskId: string;
  text: string;
  attachmentIds: string[];
  createdAt: string;
  deliveredAt: string | null;
  runId: string | null;
};

function rowToLocalTask(row: Row): LocalTask {
  return {
    projectId: String(row.project_id),
    id: String(row.id),
    title: String(row.title),
    body: String(row.body),
    status: row.status as TaskStatus,
    leaseId: row.lease_id ? String(row.lease_id) : null,
    leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToEvent(row: Row): RunEvent {
  return {
    id: Number(row.id),
    runId: String(row.run_id),
    at: String(row.at),
    type: row.type as RunEventType,
    message: String(row.message),
    data: row.data_json ? JSON.parse(String(row.data_json)) : undefined,
  };
}

export type NewRun = Pick<Run, "id" | "projectId" | "taskId" | "taskTitle" | "source" | "branch" | "worktree" | "model"> &
  Partial<Pick<Run, "slot" | "leaseId" | "leaseExpiresAt" | "phase" | "baseBranch">>;

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        task_title TEXT NOT NULL,
        source TEXT NOT NULL,
        slot INTEGER,
        phase TEXT NOT NULL,
        paused INTEGER NOT NULL DEFAULT 0,
        branch TEXT NOT NULL,
        worktree TEXT NOT NULL,
        conversation_id TEXT,
        pr_number INTEGER,
        pr_url TEXT,
        head_sha TEXT,
        fix_rounds INTEGER NOT NULL DEFAULT 0,
        lease_id TEXT,
        lease_expires_at TEXT,
        last_comment_seen_at TEXT,
        activity TEXT,
        error TEXT,
        usage_json TEXT,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id);
      CREATE INDEX IF NOT EXISTS runs_phase ON runs(phase);
      CREATE TABLE IF NOT EXISTS run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id),
        at TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        data_json TEXT
      );
      CREATE INDEX IF NOT EXISTS run_events_run ON run_events(run_id, id);
      CREATE TABLE IF NOT EXISTS side_effects (
        key TEXT PRIMARY KEY,
        run_id TEXT,
        result_json TEXT,
        at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_model_usage (
        run_id TEXT NOT NULL,
        model TEXT NOT NULL,
        usage_json TEXT NOT NULL,
        PRIMARY KEY (run_id, model)
      );
      CREATE TABLE IF NOT EXISTS usage_daily (
        day TEXT NOT NULL,
        model TEXT NOT NULL,
        usage_json TEXT NOT NULL,
        PRIMARY KEY (day, model)
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_tasks (
        project_id TEXT NOT NULL,
        id TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL,
        lease_id TEXT,
        lease_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, id)
      );
      CREATE TABLE IF NOT EXISTS local_comments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        author TEXT NOT NULL,
        author_is_agent INTEGER NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_messages (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        text TEXT NOT NULL,
        attachment_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        run_id TEXT
      );
      CREATE INDEX IF NOT EXISTS task_messages_task ON task_messages(project_id, task_id, created_at);
    `);
    const columns = (this.db.prepare("PRAGMA table_info(runs)").all() as Row[]).map((r) => String(r.name));
    if (!columns.includes("project_id")) this.db.exec("ALTER TABLE runs ADD COLUMN project_id TEXT NOT NULL DEFAULT 'default'");
    if (!columns.includes("base_branch")) this.db.exec("ALTER TABLE runs ADD COLUMN base_branch TEXT");
  }

  close() {
    this.db.close();
  }

  createRun(input: NewRun): Run {
    const at = now();
    this.db
      .prepare(
        `INSERT INTO runs (id, project_id, task_id, task_title, source, slot, phase, branch, base_branch, worktree, lease_id, lease_expires_at, model, usage_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.projectId,
        input.taskId,
        input.taskTitle,
        input.source,
        input.slot ?? null,
        input.phase ?? "claimed",
        input.branch,
        input.baseBranch ?? null,
        input.worktree,
        input.leaseId ?? null,
        input.leaseExpiresAt ?? null,
        input.model,
        JSON.stringify(emptyUsage()),
        at,
        at,
      );
    return this.getRun(input.id)!;
  }

  getRun(id: string): Run | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToRun(row) : null;
  }

  latestRunForTask(projectId: string, taskId: string): Run | null {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE project_id = ? AND task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(projectId, taskId) as Row | undefined;
    return row ? rowToRun(row) : null;
  }

  runsForTask(projectId: string, taskId: string): Run[] {
    return (this.db.prepare("SELECT * FROM runs WHERE project_id = ? AND task_id = ? ORDER BY created_at DESC").all(projectId, taskId) as Row[]).map(rowToRun);
  }

  runsForProject(projectId: string): Run[] {
    return (this.db.prepare("SELECT * FROM runs WHERE project_id = ? ORDER BY created_at DESC").all(projectId) as Row[]).map(rowToRun);
  }

  listProjects(): Project[] {
    return (this.db.prepare("SELECT json FROM projects ORDER BY created_at").all() as Row[]).map((r) => JSON.parse(String(r.json)) as Project);
  }

  getProject(id: string): Project | null {
    const row = this.db.prepare("SELECT json FROM projects WHERE id = ?").get(id) as Row | undefined;
    return row ? (JSON.parse(String(row.json)) as Project) : null;
  }

  saveProject(project: Project) {
    this.db.prepare("INSERT OR REPLACE INTO projects (id, json, created_at) VALUES (?, ?, ?)").run(project.id, JSON.stringify(project), project.createdAt);
  }

  /** Removes the project, its own tasks, comments and queued messages. Runs and usage stay as history. */
  deleteProject(id: string) {
    for (const table of ["local_comments", "local_tasks", "task_messages"]) this.db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(id);
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }

  localTasks(projectId: string): LocalTask[] {
    return (this.db.prepare("SELECT * FROM local_tasks WHERE project_id = ? ORDER BY created_at DESC").all(projectId) as Row[]).map(rowToLocalTask);
  }

  localTask(projectId: string, id: string): LocalTask | null {
    const row = this.db.prepare("SELECT * FROM local_tasks WHERE project_id = ? AND id = ?").get(projectId, id) as Row | undefined;
    return row ? rowToLocalTask(row) : null;
  }

  createLocalTask(projectId: string, title: string, body: string): LocalTask {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM local_tasks WHERE project_id = ?").get(projectId) as Row;
    const id = `T-${Number(row.n) + 1}`;
    const at = now();
    this.db
      .prepare("INSERT INTO local_tasks (project_id, id, title, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'ready_for_ai', ?, ?)")
      .run(projectId, id, title, body, at, at);
    return this.localTask(projectId, id)!;
  }

  updateLocalTask(projectId: string, id: string, patch: Partial<Pick<LocalTask, "status" | "leaseId" | "leaseExpiresAt">>) {
    const map: Record<string, string> = { status: "status", leaseId: "lease_id", leaseExpiresAt: "lease_expires_at" };
    const sets: string[] = [];
    const values: Array<string | null> = [];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${map[k]} = ?`);
      values.push((v ?? null) as string | null);
    }
    sets.push("updated_at = ?");
    values.push(now());
    this.db.prepare(`UPDATE local_tasks SET ${sets.join(", ")} WHERE project_id = ? AND id = ?`).run(...values, projectId, id);
  }

  localComments(projectId: string, taskId: string): TaskComment[] {
    const rows = this.db.prepare("SELECT * FROM local_comments WHERE project_id = ? AND task_id = ? ORDER BY created_at, rowid").all(projectId, taskId) as Row[];
    return rows.map((r) => ({ id: String(r.id), author: String(r.author), authorIsAgent: r.author_is_agent === 1, body: String(r.body), createdAt: String(r.created_at) }));
  }

  addLocalComment(projectId: string, taskId: string, author: string, authorIsAgent: boolean, body: string): TaskComment {
    const id = randomUUID();
    const at = now();
    this.db
      .prepare("INSERT INTO local_comments (id, project_id, task_id, author, author_is_agent, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, projectId, taskId, author, authorIsAgent ? 1 : 0, body, at);
    return { id, author, authorIsAgent, body, createdAt: at };
  }

  addAttachment(input: { name: string; mimeType: string; size: number; path: string; id?: string }): StoredAttachment {
    const id = input.id ?? randomUUID();
    this.db
      .prepare("INSERT INTO attachments (id, name, mime_type, size, path, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, input.name, input.mimeType, input.size, input.path, now());
    return this.attachment(id)!;
  }

  attachment(id: string): StoredAttachment | null {
    const row = this.db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as Row | undefined;
    return row
      ? { id: String(row.id), name: String(row.name), mimeType: String(row.mime_type), size: Number(row.size), path: String(row.path), createdAt: String(row.created_at) }
      : null;
  }

  addTaskMessage(projectId: string, taskId: string, text: string, attachmentIds: string[]): StoredMessage {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO task_messages (id, project_id, task_id, text, attachment_ids_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, projectId, taskId, text, JSON.stringify(attachmentIds), now());
    return this.taskMessages(projectId, taskId).find((m) => m.id === id)!;
  }

  taskMessages(projectId: string, taskId: string): StoredMessage[] {
    const rows = this.db.prepare("SELECT * FROM task_messages WHERE project_id = ? AND task_id = ? ORDER BY created_at, rowid").all(projectId, taskId) as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      projectId: String(r.project_id),
      taskId: String(r.task_id),
      text: String(r.text),
      attachmentIds: JSON.parse(String(r.attachment_ids_json)) as string[],
      createdAt: String(r.created_at),
      deliveredAt: r.delivered_at ? String(r.delivered_at) : null,
      runId: r.run_id ? String(r.run_id) : null,
    }));
  }

  markMessagesDelivered(ids: string[], runId: string) {
    const at = now();
    for (const id of ids) this.db.prepare("UPDATE task_messages SET delivered_at = ?, run_id = ? WHERE id = ?").run(at, runId, id);
  }

  listRuns(limit = 200): Run[] {
    return (this.db.prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]).map(rowToRun);
  }

  runsInPhases(phases: readonly RunPhase[]): Run[] {
    const marks = phases.map(() => "?").join(",");
    return (this.db.prepare(`SELECT * FROM runs WHERE phase IN (${marks}) ORDER BY created_at`).all(...phases) as Row[]).map(rowToRun);
  }

  updateRun(id: string, patch: Partial<Run>): Run {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [key, value] of Object.entries(patch)) {
      if (key === "usage") {
        sets.push("usage_json = ?");
        values.push(JSON.stringify(value));
      } else if (key === "paused") {
        sets.push("paused = ?");
        values.push(value ? 1 : 0);
      } else if (key in RUN_COLUMNS && key !== "id") {
        sets.push(`${RUN_COLUMNS[key as keyof typeof RUN_COLUMNS]} = ?`);
        values.push((value ?? null) as string | number | null);
      }
    }
    sets.push("updated_at = ?");
    values.push(now());
    this.db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    return this.getRun(id)!;
  }

  addEvent(runId: string, type: RunEventType, message: string, data?: unknown): RunEvent {
    const result = this.db
      .prepare("INSERT INTO run_events (run_id, at, type, message, data_json) VALUES (?, ?, ?, ?, ?)")
      .run(runId, now(), type, message, data === undefined ? null : JSON.stringify(data));
    return this.eventById(Number(result.lastInsertRowid))!;
  }

  eventById(id: number): RunEvent | null {
    const row = this.db.prepare("SELECT * FROM run_events WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToEvent(row) : null;
  }

  listEvents(runId: string, limit = 500): RunEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM (SELECT * FROM run_events WHERE run_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id")
      .all(runId, limit) as Row[];
    return rows.map(rowToEvent);
  }

  eventsAfter(id: number, limit = 500): RunEvent[] {
    return (this.db.prepare("SELECT * FROM run_events WHERE id > ? ORDER BY id LIMIT ?").all(id, limit) as Row[]).map(rowToEvent);
  }

  lastEventId(): number {
    const row = this.db.prepare("SELECT MAX(id) AS id FROM run_events").get() as Row;
    return Number(row.id ?? 0);
  }

  sideEffect<T>(key: string): T | null {
    const row = this.db.prepare("SELECT result_json FROM side_effects WHERE key = ?").get(key) as Row | undefined;
    return row ? (JSON.parse(String(row.result_json)) as T) : null;
  }

  recordSideEffect(key: string, runId: string | null, result: unknown) {
    this.db
      .prepare("INSERT OR REPLACE INTO side_effects (key, run_id, result_json, at) VALUES (?, ?, ?, ?)")
      .run(key, runId, JSON.stringify(result ?? null), now());
  }

  recordModelUsage(runId: string, current: ModelUsage, scope?: string): UsageTotals {
    const day = today();
    const key = scope ? `${runId}#${scope}` : runId;
    for (const [model, usage] of Object.entries(current)) {
      const prevRow = this.db.prepare("SELECT usage_json FROM run_model_usage WHERE run_id = ? AND model = ?").get(key, model) as Row | undefined;
      const prev: UsageTotals = prevRow ? JSON.parse(String(prevRow.usage_json)) : emptyUsage();
      const delta: UsageTotals = {
        inputTokens: Math.max(0, usage.inputTokens - prev.inputTokens),
        outputTokens: Math.max(0, usage.outputTokens - prev.outputTokens),
        cacheReadTokens: Math.max(0, usage.cacheReadTokens - prev.cacheReadTokens),
        cacheWriteTokens: Math.max(0, usage.cacheWriteTokens - prev.cacheWriteTokens),
        costUsd: Math.max(0, usage.costUsd - prev.costUsd),
      };
      this.db
        .prepare("INSERT OR REPLACE INTO run_model_usage (run_id, model, usage_json) VALUES (?, ?, ?)")
        .run(key, model, JSON.stringify(usage));
      const dayRow = this.db.prepare("SELECT usage_json FROM usage_daily WHERE day = ? AND model = ?").get(day, model) as Row | undefined;
      const dayUsage = addUsage(dayRow ? JSON.parse(String(dayRow.usage_json)) : emptyUsage(), delta);
      this.db.prepare("INSERT OR REPLACE INTO usage_daily (day, model, usage_json) VALUES (?, ?, ?)").run(day, model, JSON.stringify(dayUsage));
    }
    const total = Object.values(this.runModelUsage(runId)).reduce<UsageTotals>((sum, u) => addUsage(sum, u), emptyUsage());
    this.updateRun(runId, { usage: total });
    return total;
  }

  seedModelUsage(runId: string, current: ModelUsage, scope?: string) {
    const key = scope ? `${runId}#${scope}` : runId;
    for (const [model, usage] of Object.entries(current)) {
      this.db.prepare("INSERT OR REPLACE INTO run_model_usage (run_id, model, usage_json) VALUES (?, ?, ?)").run(key, model, JSON.stringify(usage));
    }
    this.setSetting(`usageBase:${key}`, current);
  }

  runModelUsage(runId: string): ModelUsage {
    const rows = this.db.prepare("SELECT run_id, model, usage_json FROM run_model_usage WHERE run_id = ? OR run_id LIKE ?").all(runId, `${runId}#%`) as Row[];
    const out: ModelUsage = {};
    for (const r of rows) {
      const model = String(r.model);
      const usage = JSON.parse(String(r.usage_json)) as UsageTotals;
      const base = this.setting<ModelUsage>(`usageBase:${String(r.run_id)}`, {})[model];
      const own: UsageTotals = base
        ? {
            inputTokens: Math.max(0, usage.inputTokens - base.inputTokens),
            outputTokens: Math.max(0, usage.outputTokens - base.outputTokens),
            cacheReadTokens: Math.max(0, usage.cacheReadTokens - base.cacheReadTokens),
            cacheWriteTokens: Math.max(0, usage.cacheWriteTokens - base.cacheWriteTokens),
            costUsd: Math.max(0, usage.costUsd - base.costUsd),
          }
        : usage;
      out[model] = addUsage(out[model] ?? emptyUsage(), own);
    }
    return out;
  }

  usageDays(days = 30): UsageDay[] {
    const rows = this.db.prepare("SELECT day, model, usage_json FROM usage_daily ORDER BY day DESC, model LIMIT ?").all(days * 20) as Row[];
    return rows.map((r) => ({ day: String(r.day), model: String(r.model), usage: JSON.parse(String(r.usage_json)) }));
  }

  usageOn(day = today()): UsageTotals {
    const rows = this.db.prepare("SELECT usage_json FROM usage_daily WHERE day = ?").all(day) as Row[];
    return rows.reduce<UsageTotals>((sum, r) => addUsage(sum, JSON.parse(String(r.usage_json)) as UsageTotals), emptyUsage());
  }

  usageByModel(): ModelUsage {
    const rows = this.db.prepare("SELECT model, usage_json FROM usage_daily").all() as Row[];
    const out: ModelUsage = {};
    for (const r of rows) out[String(r.model)] = addUsage(out[String(r.model)] ?? emptyUsage(), JSON.parse(String(r.usage_json)));
    return out;
  }

  setting<T>(key: string, fallback: T): T {
    const row = this.db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as Row | undefined;
    return row ? (JSON.parse(String(row.value_json)) as T) : fallback;
  }

  setSetting(key: string, value: unknown) {
    this.db.prepare("INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)").run(key, JSON.stringify(value));
  }
}
