import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import type { ActionRun, ActionsResponse, LocalFilesScan, LocalFilesSyncResult, NightshiftConfig, PreviewConfig, PreviewDetectResponse, PreviewDiagnosis, PreviewFix, Project, Run, WorkspaceInfo } from "@nightshift/core";
import { isActivePhase } from "@nightshift/core";
import { GithubPrHost, run as exec, WorktreeOps } from "@nightshift/git";
import type { Store } from "@nightshift/store";
import { DatabaseManager } from "./database.ts";
import { commitAuthor } from "../identity.ts";
import { PreviewManager, previewHost, servicesOf } from "./preview.ts";
import { applyFix, detect, diagnose, rulesDiagnosis, type Ask } from "./preview-ai.ts";
import { TerminalManager } from "./terminal.ts";
import { localFilesStatus, rewriteEnv, scanLocalFiles, syncLocalFiles } from "./local-files.ts";

export type CheckRecord = { id: string; name: string; ok: boolean; output: string; at: string; sha: string | null; preExisting: boolean };

export class WorkspaceError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type WorkspaceDeps = {
  config: NightshiftConfig;
  store: Store;
  project: (id: string) => Project;
  worktreeFor: (projectId: string, taskId: string) => string;
  agentBusy: (projectId: string, taskId: string) => boolean;
  latestRun: (projectId: string, taskId: string) => Run | null;
  onChange: (projectId: string, taskId: string) => void;
  daemonPort: () => number;
  ai: () => Ask | null;
  savePreview: (projectId: string, preview: PreviewConfig) => Promise<void>;
};

const pickPort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });

const portFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });

export class WorkspaceService {
  readonly previews: PreviewManager;
  readonly terminals: TerminalManager;
  readonly databases: DatabaseManager;

  constructor(private readonly deps: WorkspaceDeps) {
    this.previews = new PreviewManager(path.join(deps.config.dataDir, "previews"), deps.daemonPort, deps.onChange);
    this.terminals = new TerminalManager(path.join(deps.config.dataDir, "terminals"));
    this.terminals.reapLeftovers();
    this.previews.sharedRoot = (projectId) => this.deps.project(projectId).repo.path;
    this.previews.stablePort = async (projectId, service) => {
      const key = `sharedPort:${projectId}/${service}`;
      const saved = this.deps.store.setting<number | null>(key, null);
      if (saved && (await portFree(saved))) return saved;
      const port = await pickPort();
      this.deps.store.setSetting(key, port);
      return port;
    };
    this.previews.onFailed = (projectId, taskId, service) => {
      if (!this.deps.ai()) return;
      const multi = Boolean(this.deps.project(projectId).preview?.services?.length);
      void this.diagnosePreview(projectId, taskId, multi ? service : undefined, true).catch(() => {});
    };
    this.databases = new DatabaseManager(deps.store, deps.onChange);
  }

  ops(projectId: string, taskId: string): WorktreeOps {
    const project = this.deps.project(projectId);
    const root = this.deps.worktreeFor(projectId, taskId);
    const ops = new WorktreeOps(root, project.repo.remote, this.deps.latestRun(projectId, taskId)?.baseBranch ?? project.repo.baseBranch, () => commitAuthor(this.deps.config, project.repo.path));
    if (!ops.exists()) throw new WorkspaceError("No workspace yet: the agent creates it when it starts", 404);
    return ops;
  }

  editable(projectId: string, taskId: string) {
    if (this.deps.agentBusy(projectId, taskId)) throw new WorkspaceError("The agent is working in this workspace. Pause it or wait until it finishes.", 409);
  }

  env(projectId: string, taskId: string): Record<string, string> {
    const project = this.deps.project(projectId);
    const env: Record<string, string> = { ...this.databases.env(project, taskId) };
    const preview = this.previews.info(projectId, taskId, project.preview);
    env.PREVIEW_URL = this.previews.url(previewHost(projectId, taskId));
    if (preview.port) env.PREVIEW_PORT = String(preview.port);
    for (const svc of preview.services.filter((x) => x.shared)) {
      const port = svc.port ?? this.deps.store.setting<number | null>(`sharedPort:${projectId}/${svc.name}`, null);
      if (!port) continue;
      const name = svc.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
      env[`NIGHTSHIFT_${name}_HOST`] = "127.0.0.1";
      env[`NIGHTSHIFT_${name}_PORT`] = String(port);
      env[`NIGHTSHIFT_${name}_URL`] = `http://127.0.0.1:${port}`;
    }
    for (const s of preview.services) if (s.url) env[`PREVIEW_URL_${s.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`] = s.url;
    return env;
  }

  info(projectId: string, taskId: string): WorkspaceInfo {
    const project = this.deps.project(projectId);
    const root = this.deps.worktreeFor(projectId, taskId);
    const exists = existsSync(path.join(root, ".git"));
    const run = this.deps.latestRun(projectId, taskId);
    return {
      projectId,
      taskId,
      exists,
      path: exists ? root : null,
      branch: run?.branch ?? null,
      baseBranch: run?.baseBranch ?? project.repo.baseBranch,
      agentBusy: this.deps.agentBusy(projectId, taskId),
      preview: this.previews.info(projectId, taskId, project.preview),
      database: this.databases.info(project, taskId, true),
      localFiles: exists ? this.localFiles(projectId, taskId) : null,
    };
  }

  async startPreview(projectId: string, taskId: string, restart = false, service?: string): Promise<WorkspaceInfo> {
    const project = this.deps.project(projectId);
    if (!project.preview?.command && !project.preview?.services?.length) throw new WorkspaceError("This project has no preview command. Add one in the project settings.", 400);
    if (service && !servicesOf(project.preview).some((s) => s.name === service)) throw new WorkspaceError(`This project has no preview service named ${service}`, 404);
    const root = this.ops(projectId, taskId).root;
    if (restart) {
      await this.previews.stop(projectId, taskId, service);
      await this.previews.waitStopped(projectId, taskId, service);
    }
    await this.previews.start(projectId, taskId, root, this.withLocalEnv(project), this.env(projectId, taskId), service);
    return this.info(projectId, taskId);
  }

  private serviceDef(projectId: string, service?: string) {
    const project = this.deps.project(projectId);
    if (!project.preview?.command && !project.preview?.services?.length) throw new WorkspaceError("This project has no preview command. Add one in the project settings.", 400);
    const defs = servicesOf(project.preview);
    const def = service ? defs.find((d) => d.name === service) : (defs.find((d) => d.primary) ?? defs[0]);
    if (!def) throw new WorkspaceError(`This project has no preview service named ${service}`, 404);
    return { project, config: project.preview, def };
  }

  private withLocalEnv(project: Project): PreviewConfig {
    const preview = structuredClone(project.preview!);
    if (!project.localFiles?.rewrites.length) return preview;
    if (preview.services?.length) for (const svc of preview.services) svc.env = { ...rewriteEnv(project.localFiles, svc), ...svc.env };
    else preview.env = { ...rewriteEnv(project.localFiles, null), ...preview.env };
    return preview;
  }

  localFiles(projectId: string, taskId: string) {
    const project = this.deps.project(projectId);
    const root = this.deps.worktreeFor(projectId, taskId);
    if (!existsSync(root)) return null;
    return localFilesStatus(project.repo.path, root, project.localFiles, this.deps.store.setting<string | null>(`localFilesSynced:${projectId}/${taskId}`, null));
  }

  syncLocalFiles(projectId: string, taskId: string, overwrite: boolean): LocalFilesSyncResult {
    const project = this.deps.project(projectId);
    if (!project.localFiles?.paths.length) throw new WorkspaceError("No local files are selected for this project. Choose them under Local files in the project settings.", 400);
    const root = this.ops(projectId, taskId).root;
    if (overwrite) this.editable(projectId, taskId);
    const result = syncLocalFiles(project.repo.path, root, project.localFiles, overwrite);
    if (result.copied.length) this.deps.store.setSetting(`localFilesSynced:${projectId}/${taskId}`, new Date().toISOString());
    this.deps.onChange(projectId, taskId);
    return { ...result, status: this.localFiles(projectId, taskId)! };
  }

  async scanLocalFiles(projectId: string, useAi = false): Promise<LocalFilesScan> {
    const project = this.deps.project(projectId);
    return scanLocalFiles(project.repo.path, project.preview, project.localFiles, useAi ? this.deps.ai() : null);
  }

  openTerminal(projectId: string, taskId: string, size: { cols?: number; rows?: number }) {
    const root = this.ops(projectId, taskId).root;
    const env = { ...this.env(projectId, taskId) };
    return this.terminals.create(projectId, taskId, root, env, size);
  }

  async diagnosePreview(projectId: string, taskId: string, service?: string, auto = false): Promise<PreviewDiagnosis | null> {
    const { config, def } = this.serviceDef(projectId, service);
    const root = this.ops(projectId, taskId).root;
    const info = this.previews.info(projectId, taskId, config).services.find((s) => s.name === def.name)!;
    const key = `${projectId}/${taskId}/${def.name}`;
    const existing = this.previews.diagnoses.get(key);
    if (existing?.diagnosing) return existing.diagnosis;
    if (auto && existing?.diagnosis && existing.diagnosis.startedAt === info.startedAt) return existing.diagnosis;
    const rules = rulesDiagnosis(def.name, info.hint, info.startedAt, def, info.error);
    const ask = this.deps.ai();
    if (!ask) {
      this.previews.diagnoses.set(key, { diagnosis: rules, diagnosing: false });
      this.deps.onChange(projectId, taskId);
      return rules;
    }
    this.previews.diagnoses.set(key, { diagnosis: existing?.diagnosis ?? null, diagnosing: true });
    this.deps.onChange(projectId, taskId);
    try {
      const diagnosis = await diagnose(ask, {
        root,
        service: def.name,
        def,
        config,
        log: this.previews.serviceLog(projectId, taskId, def.name),
        hint: info.hint,
        error: info.error,
        port: info.port,
        startedAt: info.startedAt,
      });
      this.previews.diagnoses.set(key, { diagnosis, diagnosing: false });
      return diagnosis;
    } catch {
      this.previews.diagnoses.set(key, { diagnosis: rules, diagnosing: false });
      return rules;
    } finally {
      this.deps.onChange(projectId, taskId);
    }
  }

  async fixPreview(projectId: string, taskId: string, fix: PreviewFix, service?: string): Promise<WorkspaceInfo> {
    const { config, def } = this.serviceDef(projectId, service);
    if (!fix || typeof fix !== "object" || !Object.keys(fix).length) throw new WorkspaceError("There is nothing to apply", 400);
    await this.deps.savePreview(projectId, applyFix(config, config.services?.length ? def.name : undefined, fix));
    this.previews.diagnoses.delete(`${projectId}/${taskId}/${def.name}`);
    const multi = Boolean(this.deps.project(projectId).preview?.services?.length);
    return this.startPreview(projectId, taskId, true, multi ? def.name : undefined);
  }

  async detectPreview(projectId: string, taskId: string): Promise<PreviewDetectResponse> {
    const root = this.ops(projectId, taskId).root;
    return detect(this.deps.ai(), root, this.deps.project(projectId).preview);
  }

  async stopPreview(projectId: string, taskId: string, service?: string): Promise<WorkspaceInfo> {
    await this.previews.stop(projectId, taskId, service);
    return this.info(projectId, taskId);
  }

  async createDatabase(projectId: string, taskId: string, reset = false): Promise<WorkspaceInfo> {
    const project = this.deps.project(projectId);
    if (!this.databases.active(project)) throw new WorkspaceError("This project has no database configured", 400);
    const root = this.ops(projectId, taskId).root;
    await this.databases.create(project, taskId, root, { reset });
    return this.info(projectId, taskId);
  }

  async dropDatabase(projectId: string, taskId: string): Promise<WorkspaceInfo> {
    await this.databases.drop(this.deps.project(projectId), taskId);
    return this.info(projectId, taskId);
  }

  async push(projectId: string, taskId: string) {
    const ops = this.ops(projectId, taskId);
    const run = this.deps.latestRun(projectId, taskId);
    if (!run) throw new WorkspaceError("This task has no branch yet", 400);
    this.editable(projectId, taskId);
    const project = this.deps.project(projectId);
    const res = await exec("git", ["push", "--quiet", project.repo.remote, `HEAD:refs/heads/${run.branch}`], { cwd: ops.root, env: { GIT_TERMINAL_PROMPT: "0" } });
    if (res.code !== 0) throw new WorkspaceError(`Push failed: ${(res.stderr || res.stdout).trim().slice(-400)}`, 400);
  }

  recordCheck(runId: string, record: CheckRecord) {
    const list = this.deps.store.setting<CheckRecord[]>(`checkRuns:${runId}`, []);
    list.push(record);
    this.deps.store.setSetting(`checkRuns:${runId}`, list.slice(-200));
  }

  async actions(projectId: string, taskId: string): Promise<ActionsResponse> {
    const project = this.deps.project(projectId);
    const run = this.deps.latestRun(projectId, taskId);
    const local: ActionRun[] = (run ? this.deps.store.setting<CheckRecord[]>(`checkRuns:${run.id}`, []) : [])
      .map((c) => ({
        id: c.id,
        name: `Nightshift check: ${c.name}`,
        status: "completed" as const,
        conclusion: c.ok ? ("success" as const) : c.preExisting ? ("neutral" as const) : ("failure" as const),
        url: null,
        branch: run?.branch ?? "",
        sha: c.sha,
        event: c.id.includes(":base:") ? "base check" : "local check",
        createdAt: c.at,
        source: "nightshift" as const,
      }))
      .reverse();
    if (project.gitHost !== "github" || !run) return { provider: project.gitHost === "github" ? "github" : "local", runs: local, error: null };
    try {
      const gh = await new GithubPrHost(project.repo.path).runs(run.branch);
      return { provider: "github", runs: [...gh, ...local], error: null };
    } catch (error) {
      return { provider: "github", runs: local, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async actionLog(projectId: string, taskId: string, id: string): Promise<string> {
    const project = this.deps.project(projectId);
    const run = this.deps.latestRun(projectId, taskId);
    const local = run ? this.deps.store.setting<CheckRecord[]>(`checkRuns:${run.id}`, []).find((c) => c.id === id) : undefined;
    if (local) return local.output || "(no output)";
    if (project.gitHost !== "github" || !/^\d+$/.test(id)) throw new WorkspaceError("Run not found", 404);
    return new GithubPrHost(project.repo.path).runLog(id);
  }

  async cleanupForRun(run: Run) {
    if (isActivePhase(run.phase)) return;
    if (["done", "stopped"].includes(run.phase)) await this.previews.stop(run.projectId, run.taskId);
    if (run.phase === "done") await this.databases.drop(this.deps.project(run.projectId), run.taskId).catch(() => {});
    if (run.phase === "done") this.terminals.closeTask(run.projectId, run.taskId);
  }
}
