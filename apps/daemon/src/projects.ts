import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { EnvFileOverrides, NightshiftConfig, NewProjectInput, PreviewConfig, Project, ProjectUpdate, TaskSource, TaskSummary } from "@nightshift/core";
import { GithubPrHost, LocalPrHost, run, Workspaces, type PrHost } from "@nightshift/git";
import { DEFAULT_TASK_PREFIX, TASK_PREFIX_PATTERN } from "@nightshift/core";
import { WonderCallMcpSource } from "@nightshift/sources";
import type { Store } from "@nightshift/store";
import { LocalTaskSource } from "./local-source.ts";
import { commitAuthor } from "./identity.ts";
import { normalizeLocalFiles } from "./workspace/local-files.ts";

export type ProjectContext = {
  project: Project;
  source: TaskSource;
  workspaces: Workspaces;
  prHost: PrHost;
  state: { connected: boolean; lastPollAt: string | null; lastError: string | null };
  tasksCache: { at: number; tasks: TaskSummary[] } | null;
};

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "project";

export function buildContext(config: NightshiftConfig, store: Store, project: Project): ProjectContext {
  const source: TaskSource =
    project.source.type === "local"
      ? new LocalTaskSource(store, project.id)
      : new WonderCallMcpSource(project.source.url, process.env[project.source.tokenEnv], project.source.projectId);
  const workspaces = new Workspaces(
    project.repo.path,
    path.join(config.workspacesDir, project.id),
    project.repo.remote,
    project.repo.baseBranch,
    () => commitAuthor(config, project.repo.path),
  );
  const prHost =
    project.gitHost === "github"
      ? new GithubPrHost(project.repo.path)
      : new LocalPrHost(path.join(config.dataDir, "local-prs", `${project.id}.json`), project.repo.path, project.repo.remote);
  return { project, source, workspaces, prHost, state: { connected: false, lastPollAt: null, lastError: null }, tasksCache: null };
}

export function seedProjectFromConfig(config: NightshiftConfig, store: Store) {
  if (store.listProjects().length || !config.repo.path || store.setting<string[]>("deletedProjects", []).includes("default")) return;
  store.saveProject({
    id: "default",
    name: path.basename(config.repo.path),
    repo: { ...config.repo },
    checks: config.checks,
    gitHost: config.git.host,
    source: { type: "wondercall-mcp", url: config.source.url, tokenEnv: config.source.tokenEnv },
    createdAt: new Date().toISOString(),
  });
}

export async function validateNewProject(input: NewProjectInput, existing: Project[], deleted: string[] = []): Promise<Project> {
  const name = input.name?.trim();
  if (!name) throw new Error("A project needs a name");
  const repoPath = input.repo?.path?.trim();
  if (!repoPath || !path.isAbsolute(repoPath)) throw new Error("The repository path must be an absolute path");
  if (!existsSync(repoPath)) throw new Error(`${repoPath} does not exist`);
  const gitDir = await run("git", ["rev-parse", "--git-dir"], { cwd: repoPath });
  if (gitDir.code !== 0) throw new Error(`${repoPath} is not a git repository`);
  const remote = input.repo.remote?.trim() || "origin";
  const remoteUrl = await run("git", ["remote", "get-url", remote], { cwd: repoPath });
  if (remoteUrl.code !== 0) throw new Error(`The repository has no remote named ${remote}`);
  const baseBranch = input.repo.baseBranch?.trim() || "main";
  const heads = await run("git", ["ls-remote", "--heads", remote, baseBranch], { cwd: repoPath, timeoutMs: 20_000 });
  if (heads.code !== 0 || !heads.stdout.trim()) throw new Error(`Branch ${baseBranch} was not found on ${remote}`);
  const source = input.source ?? { type: "local" as const };
  if (input.database?.mode === "existing" && !/^postgres(ql)?:\/\//.test(input.database.adminUrl ?? "")) throw new Error("The existing database needs a postgres:// admin connection URL");
  if (source.type === "wondercall-mcp" && !/^https?:\/\//.test(source.url ?? "")) throw new Error("The WonderCall MCP URL must start with http:// or https://");
  const checks = (input.checks ?? []).filter((c) => c.name?.trim() && c.command?.trim()).map((c) => ({ ...c, name: c.name.trim(), command: c.command.trim() }));
  let id = slug(name);
  // A deleted project's runs keep its id, so a new project must not reuse it.
  if (existing.some((p) => p.id === id) || deleted.includes(id)) id = `${id}-${randomUUID().slice(0, 6)}`;
  return {
    id,
    name,
    repo: {
      path: repoPath,
      remote,
      baseBranch,
      branchPrefix: input.repo.branchPrefix?.trim() || "nightshift/",
      ...(input.repo.setup?.trim() ? { setup: input.repo.setup.trim() } : {}),
    },
    checks,
    gitHost: input.gitHost === "local" ? "local" : "github",
    planMode: input.planMode === "plan" || input.planMode === "approve" ? input.planMode : "off",
    ...(input.pushMode === "approve" ? { pushMode: "approve" as const } : {}),
    ...(normalizeTaskPrefix(input.taskPrefix) ? { taskPrefix: normalizeTaskPrefix(input.taskPrefix) } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.brief?.trim() ? { brief: input.brief.trim() } : {}),
    ...(input.model ? { model: { provider: input.model.provider, modelId: input.model.modelId } } : {}),
    ...(input.reviewModel ? { reviewModel: { provider: input.reviewModel.provider, modelId: input.reviewModel.modelId } } : {}),
    review: input.review ?? true,
    ...(normalizePreview(input.preview) ? { preview: normalizePreview(input.preview) } : {}),
    ...(input.database && input.database.mode !== "none"
      ? {
          database: {
            mode: input.database.mode,
            engine: "postgres" as const,
            ...(input.database.mode === "docker" ? { image: input.database.image?.trim() || "postgres:17-alpine" } : {}),
            ...(input.database.mode === "existing" ? { adminUrl: input.database.adminUrl?.trim() } : {}),
            envVar: input.database.envVar?.trim() || "DATABASE_URL",
            ...(input.database.setup?.trim() ? { setup: input.database.setup.trim() } : {}),
          },
        }
      : {}),
    source: source.type === "local" ? { type: "local" } : { type: "wondercall-mcp", url: source.url, tokenEnv: source.tokenEnv || "WONDERCALL_AGENT_TOKEN", ...(source.projectId ? { projectId: source.projectId } : {}) },
    createdAt: new Date().toISOString(),
  };
}

export async function applyProjectUpdate(project: Project, update: ProjectUpdate): Promise<Project> {
  const next: Project = structuredClone(project);
  if (update.name !== undefined) {
    if (!update.name.trim()) throw new Error("A project needs a name");
    next.name = update.name.trim();
  }
  if (update.kind !== undefined) next.kind = update.kind;
  if (update.brief !== undefined) next.brief = update.brief.trim() || undefined;
  if (update.paused !== undefined) next.paused = update.paused;
  if (update.taskPrefix !== undefined) {
    const prefix = normalizeTaskPrefix(update.taskPrefix);
    if (prefix) next.taskPrefix = prefix;
    else delete next.taskPrefix;
  }
  if (update.planMode !== undefined) next.planMode = ["plan", "approve"].includes(update.planMode) ? update.planMode : "off";
  if (update.review !== undefined) next.review = update.review;
  if (update.testers !== undefined) {
    const seen = new Set<string>();
    next.testers = update.testers
      .filter((t) => t.name?.trim() && t.command?.trim())
      .map((t) => {
        let id = (t.id || t.name).toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 40) || "tester";
        while (seen.has(id)) id = `${id}-${Math.random().toString(36).slice(2, 5)}`;
        seen.add(id);
        return {
          id,
          name: t.name.trim(),
          command: t.command.trim(),
          format: t.format === "umbra" || t.format === "exit-code" ? t.format : "nightshift-json",
          when: t.when === "every-round" || t.when === "manual" ? t.when : "before-pr",
          blocking: t.blocking !== false,
          enabled: t.enabled !== false,
          ...(t.timeoutMs && t.timeoutMs > 0 ? { timeoutMs: Math.min(t.timeoutMs, 4 * 3600_000) } : {}),
          ...(t.queue?.trim() ? { queue: t.queue.trim().toLowerCase().slice(0, 40) } : {}),
          ...(t.onError === "ask" ? { onError: "ask" as const } : {}),
        };
      });
  }
  if (update.triggers !== undefined) {
    next.triggers = {
      prFeedback: { enabled: Boolean(update.triggers.prFeedback?.enabled) },
      ciFailures: { enabled: Boolean(update.triggers.ciFailures?.enabled) },
      githubIssues: { enabled: Boolean(update.triggers.githubIssues?.enabled), label: update.triggers.githubIssues?.label?.trim() || "nightshift" },
    };
  }
  if (update.model !== undefined) next.model = update.model ? { provider: update.model.provider, modelId: update.model.modelId } : undefined;
  if (update.reviewModel !== undefined) next.reviewModel = update.reviewModel ? { provider: update.reviewModel.provider, modelId: update.reviewModel.modelId } : undefined;
  if (update.gitHost !== undefined) next.gitHost = update.gitHost === "local" ? "local" : "github";
  if (update.repo) {
    const r = update.repo;
    if (r.remote !== undefined) {
      const remote = r.remote.trim() || "origin";
      if ((await run("git", ["remote", "get-url", remote], { cwd: next.repo.path })).code !== 0) throw new Error(`The repository has no remote named ${remote}`);
      next.repo.remote = remote;
    }
    if (r.baseBranch !== undefined) {
      const base = r.baseBranch.trim() || "main";
      const heads = await run("git", ["ls-remote", "--heads", next.repo.remote, base], { cwd: next.repo.path, timeoutMs: 20_000 });
      if (heads.code !== 0 || !heads.stdout.trim()) throw new Error(`Branch ${base} was not found on ${next.repo.remote}`);
      next.repo.baseBranch = base;
    }
    if (r.branchPrefix !== undefined) next.repo.branchPrefix = r.branchPrefix.trim() || "nightshift/";
    if (r.setup !== undefined) next.repo.setup = r.setup.trim() || undefined;
  }
  if (update.checks !== undefined) next.checks = update.checks.filter((c) => c.name?.trim() && c.command?.trim()).map((c) => ({ ...c, name: c.name.trim(), command: c.command.trim() }));
  if (update.source !== undefined) {
    if (update.source.type === "wondercall-mcp" && !/^https?:\/\//.test(update.source.url ?? "")) throw new Error("The WonderCall MCP URL must start with http:// or https://");
    next.source =
      update.source.type === "local"
        ? { type: "local" }
        : { type: "wondercall-mcp", url: update.source.url, tokenEnv: update.source.tokenEnv || "WONDERCALL_AGENT_TOKEN", ...(update.source.projectId ? { projectId: update.source.projectId } : {}) };
  }
  if (update.preview !== undefined) {
    next.preview = normalizePreview(update.preview);
  }
  if (update.localFiles !== undefined) next.localFiles = normalizeLocalFiles(update.localFiles);
  if (update.pushMode !== undefined) next.pushMode = update.pushMode === "approve" ? "approve" : "auto";
  if (update.skills !== undefined) {
    const skills = { ...next.skills };
    for (const [id, value] of Object.entries(update.skills ?? {})) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`"${id}" is not a skill id`);
      if (value === null) delete skills[id];
      else skills[id] = Boolean(value);
    }
    next.skills = Object.keys(skills).length ? skills : undefined;
  }
  if (update.database !== undefined) {
    const d = update.database;
    if (d.mode === "none") next.database = { mode: "none" };
    else {
      if (d.mode === "existing" && !/^postgres(ql)?:\/\//.test(d.adminUrl ?? "")) throw new Error("The existing database needs a postgres:// admin connection URL");
      next.database = {
        mode: d.mode,
        engine: "postgres",
        ...(d.mode === "docker" ? { image: d.image?.trim() || "postgres:17-alpine" } : {}),
        ...(d.mode === "existing" ? { adminUrl: d.adminUrl?.trim() } : {}),
        envVar: d.envVar?.trim() || "DATABASE_URL",
        ...(d.setup?.trim() ? { setup: d.setup.trim() } : {}),
      };
    }
  }
  return next;
}

const validPort = (p: unknown) => Number.isInteger(Number(p)) && Number(p) > 0 && Number(p) < 65536;

export function normalizePreview(input: PreviewConfig | null | undefined): PreviewConfig | undefined {
  const seen = new Set<string>();
  const services = (input?.services ?? [])
    .filter((s) => s?.name?.trim() && (s.command?.trim() || (s.shared && validPort(s.port))))
    .map((s) => {
      const name = s.name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
      if (!name) throw new Error("A preview service needs a name made of letters or numbers");
      if (seen.has(name)) throw new Error(`Two preview services are named ${name}`);
      seen.add(name);
      const cwd = s.cwd?.trim().replace(/^\.?\/+|\/+$/g, "");
      if (cwd && (cwd.split("/").includes("..") || path.isAbsolute(cwd))) throw new Error(`The folder for ${name} must be inside the repository`);
      return {
        name,
        command: (s.command ?? "").trim(),
        ...(cwd ? { cwd } : {}),
        portEnv: s.portEnv?.trim() || "PORT",
        readyPath: s.readyPath?.trim() || "/",
        ...(s.env && Object.keys(s.env).length ? { env: s.env } : {}),
        ...(normalizeEnvFiles(s.envFiles) ? { envFiles: normalizeEnvFiles(s.envFiles) } : {}),
        ...(s.primary && !s.shared ? { primary: true } : {}),
        ...(s.shared ? { shared: true } : {}),
        ...(s.shared && validPort(s.port) ? { port: Number(s.port) } : {}),
        ...(s.check === "tcp" ? { check: "tcp" as const } : {}),
        ...(s.target === "container" ? { target: "container" as const } : {}),
        ...(s.target === "container" && validPort(s.containerPort) ? { containerPort: Number(s.containerPort) } : {}),
      };
    });
  const firstOwn = services.findIndex((s) => !s.shared);
  if (services.length && !services.some((s) => s.primary) && firstOwn >= 0) services[firstOwn] = { ...services[firstOwn]!, primary: true };
  const sharedPorts = services.filter((s) => s.shared && s.port).map((s) => s.port);
  if (new Set(sharedPorts).size !== sharedPorts.length) throw new Error("Two shared services use the same port");
  if (services.filter((s) => s.primary).length > 1) {
    let first = true;
    for (const s of services) if (s.primary) first ? (first = false) : delete s.primary;
  }
  const primary = services.find((s) => s.primary);
  const command = primary?.command ?? input?.command?.trim();
  if (!command) return undefined;
  const target = input!.target === "container" || input!.target === "device" ? input!.target : "machine";
  const image = input!.container?.image?.trim() || "node:22-alpine";
  if (target === "container" && !/^[a-z0-9][a-z0-9._\/:@-]*$/i.test(image)) throw new Error("The container image name is not valid");
  const mode = input!.device?.mode;
  return {
    ...(services.length ? { services } : {}),
    ...(input!.install?.trim() ? { install: input!.install.trim() } : {}),
    command,
    portEnv: primary?.portEnv ?? (input!.portEnv?.trim() || "PORT"),
    readyPath: primary?.readyPath ?? (input!.readyPath?.trim() || "/"),
    ...(input!.env && Object.keys(input!.env).length ? { env: input!.env } : {}),
    ...(!services.length && normalizeEnvFiles(input!.envFiles) ? { envFiles: normalizeEnvFiles(input!.envFiles) } : {}),
    target,
    ...(target === "container"
      ? { container: { image } }
      : input!.container?.image?.trim() && services.some((s) => s.target === "container")
        ? { container: { image: input!.container.image.trim() } }
        : {}),
    ...(validPort(input!.containerPort) && !services.length ? { containerPort: Number(input!.containerPort) } : {}),
    ...(target === "device" ? { device: { mode: mode === "expo-go" || mode === "ios-simulator" || mode === "android-emulator" ? mode : "lan" } } : {}),
  };
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Checks `envFiles`: paths stay inside the app's folder, names are valid, values are single lines. */
export function normalizeEnvFiles(input: EnvFileOverrides | undefined): EnvFileOverrides | undefined {
  if (!input || typeof input !== "object") return undefined;
  const out: EnvFileOverrides = {};
  for (const [raw, values] of Object.entries(input)) {
    const file = raw.trim().replace(/^\.\/+/, "");
    if (!file || path.isAbsolute(file) || file.split("/").includes("..")) throw new Error(`The file ${raw} must be inside the app's folder`);
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(values ?? {})) {
      if (!ENV_KEY.test(key)) throw new Error(`${key} in ${file} is not a valid variable name`);
      if (typeof value !== "string" || /[\r\n\0]/.test(value)) throw new Error(`The value of ${key} in ${file} must be one line`);
      clean[key] = value;
    }
    if (Object.keys(clean).length) out[file] = clean;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Upper-cases and checks a task id prefix; empty or the default means "use the default". */
export function normalizeTaskPrefix(input: string | undefined): string | undefined {
  const prefix = (input ?? "").trim().replace(/-+$/, "").toUpperCase();
  if (!prefix || prefix === DEFAULT_TASK_PREFIX) return undefined;
  if (!TASK_PREFIX_PATTERN.test(prefix)) throw new Error(`The task id prefix ${input} is not valid: start with a letter, then up to 9 letters or digits (e.g. WC)`);
  return prefix;
}
