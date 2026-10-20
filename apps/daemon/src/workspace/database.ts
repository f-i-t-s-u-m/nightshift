import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import pg from "pg";
import type { DatabaseConfig, DatabaseInfo, Project } from "@nightshift/core";
import { run } from "@nightshift/git";
import type { Store } from "@nightshift/store";

type DbState = { status: DatabaseInfo["status"]; name: string | null; url: string | null; error: string | null; seededAt: string | null };

type ActiveConfig = Extract<DatabaseConfig, { mode: "docker" | "existing" }>;

const DEFAULT_IMAGE = "postgres:17-alpine";

export const containerName = (projectId: string) => `nightshift-pg-${projectId.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}`;

const dbName = (projectId: string, taskId: string) =>
  `ns_${projectId}_${taskId}`
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .slice(0, 60);

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

function withDatabase(url: string, database: string) {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export function redact(url: string | null) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.password) u.password = "****";
    return u.toString();
  } catch {
    return url;
  }
}

export class DatabaseManager {
  constructor(
    private readonly store: Store,
    private readonly onChange: (projectId: string, taskId: string) => void,
  ) {}

  private stateKey(projectId: string, taskId: string) {
    return `db:${projectId}/${taskId}`;
  }

  private state(projectId: string, taskId: string): DbState {
    return this.store.setting<DbState>(this.stateKey(projectId, taskId), { status: "none", name: null, url: null, error: null, seededAt: null });
  }

  private setState(projectId: string, taskId: string, patch: Partial<DbState>) {
    this.store.setSetting(this.stateKey(projectId, taskId), { ...this.state(projectId, taskId), ...patch });
    this.onChange(projectId, taskId);
  }

  active(project: Project): ActiveConfig | null {
    const c = project.database;
    return c && c.mode !== "none" ? c : null;
  }

  info(project: Project, taskId: string, reveal = false): DatabaseInfo {
    const c = this.active(project);
    const s = this.state(project.id, taskId);
    return {
      configured: Boolean(c),
      mode: c?.mode ?? "none",
      status: c ? s.status : "none",
      name: s.name,
      url: reveal ? s.url : redact(s.url),
      envVar: c ? (c.envVar ?? "DATABASE_URL") : null,
      error: s.error,
      seededAt: s.seededAt,
    };
  }

  env(project: Project, taskId: string): Record<string, string> {
    const c = this.active(project);
    const s = this.state(project.id, taskId);
    return c && s.status === "ready" && s.url ? { [c.envVar ?? "DATABASE_URL"]: s.url } : {};
  }

  private async docker(args: string[], timeoutMs = 120_000) {
    const res = await run("docker", args, { timeoutMs });
    if (res.code !== 0) throw new Error(`docker ${args[0]} failed: ${(res.stderr || res.stdout).trim().slice(-400)}`);
    return res.stdout.trim();
  }

  async adminUrl(project: Project): Promise<string> {
    const c = this.active(project);
    if (!c) throw new Error("This project has no database configured");
    if (c.mode === "existing") {
      if (!c.adminUrl) throw new Error("The project's existing database needs an admin connection URL");
      return c.adminUrl;
    }
    const name = containerName(project.id);
    const saved = this.store.setting<{ url: string } | null>(`dbserver:${project.id}`, null);
    const inspect = await run("docker", ["inspect", "-f", "{{.State.Running}}", name]);
    if (inspect.code === 0 && saved) {
      if (inspect.stdout.trim() !== "true") await this.docker(["start", name]);
    } else {
      if (inspect.code === 0) await run("docker", ["rm", "-f", name]);
      const password = randomBytes(18).toString("hex");
      const port = await freePort();
      await this.docker(
        [
          "run",
          "-d",
          "--name",
          name,
          "--label",
          "nightshift=1",
          "--label",
          `nightshift.project=${project.id}`,
          "-e",
          `POSTGRES_PASSWORD=${password}`,
          "-e",
          "POSTGRES_USER=nightshift",
          "-e",
          "POSTGRES_DB=postgres",
          "-p",
          `127.0.0.1:${port}:5432`,
          c.image ?? DEFAULT_IMAGE,
        ],
        10 * 60_000,
      );
      this.store.setSetting(`dbserver:${project.id}`, { url: `postgresql://nightshift:${password}@127.0.0.1:${port}/postgres` });
    }
    const url = this.store.setting<{ url: string }>(`dbserver:${project.id}`, { url: "" }).url;
    const deadline = Date.now() + 60_000;
    for (;;) {
      const ready = await run("docker", ["exec", name, "pg_isready", "-U", "nightshift", "-d", "postgres"]);
      if (ready.code === 0) {
        try {
          await this.query(url, "SELECT 1");
          break;
        } catch {}
      }
      if (Date.now() > deadline) throw new Error("The Postgres container did not become ready within a minute");
      await new Promise((r) => setTimeout(r, 500));
    }
    return url;
  }

  private async query(url: string, sql: string) {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    await client.connect();
    try {
      return await client.query(sql);
    } finally {
      await client.end();
    }
  }

  async create(project: Project, taskId: string, cwd: string, opts: { reset?: boolean } = {}): Promise<DatabaseInfo> {
    const c = this.active(project);
    if (!c) throw new Error("This project has no database configured");
    const name = dbName(project.id, taskId);
    this.setState(project.id, taskId, { status: "creating", name, error: null });
    try {
      const admin = await this.adminUrl(project);
      const exists = (await this.query(admin, `SELECT 1 FROM pg_database WHERE datname = '${name}'`)).rowCount;
      if (exists && opts.reset) {
        await this.query(admin, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`);
        await this.query(admin, `DROP DATABASE "${name}"`);
      }
      if (!exists || opts.reset) await this.query(admin, `CREATE DATABASE "${name}"`);
      const url = withDatabase(admin, name);
      let seededAt = this.state(project.id, taskId).seededAt;
      if (c.setup && (!exists || opts.reset || !seededAt)) {
        const res = await run("sh", ["-c", c.setup], { cwd, timeoutMs: 15 * 60_000, env: { [c.envVar ?? "DATABASE_URL"]: url } });
        if (res.code !== 0) throw new Error(`Seed command failed (exit ${res.code}): ${(res.stderr || res.stdout).trim().slice(-600)}`);
        seededAt = new Date().toISOString();
      }
      this.setState(project.id, taskId, { status: "ready", name, url, error: null, seededAt });
    } catch (error) {
      this.setState(project.id, taskId, { status: "failed", error: error instanceof Error ? error.message : String(error) });
    }
    return this.info(project, taskId);
  }

  async drop(project: Project, taskId: string): Promise<DatabaseInfo> {
    const s = this.state(project.id, taskId);
    if (s.name && this.active(project)) {
      try {
        const admin = await this.adminUrl(project);
        await this.query(admin, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${s.name}' AND pid <> pg_backend_pid()`);
        await this.query(admin, `DROP DATABASE IF EXISTS "${s.name}"`);
      } catch (error) {
        this.setState(project.id, taskId, { status: "failed", error: error instanceof Error ? error.message : String(error) });
        return this.info(project, taskId);
      }
    }
    this.setState(project.id, taskId, { status: "none", name: null, url: null, error: null, seededAt: null });
    return this.info(project, taskId);
  }

  async removeServer(projectId: string) {
    await run("docker", ["rm", "-f", containerName(projectId)]);
    this.store.setSetting(`dbserver:${projectId}`, null);
  }
}
