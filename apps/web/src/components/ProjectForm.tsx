import { useId, useRef, useState, type ReactNode } from "react";
import { Plus, Rows3, Share2, Sparkles, SquareTerminal, X } from "lucide-react";
import { useFileMentions } from "./mentions";
import { DEFAULT_TASK_PREFIX, TASK_PREFIX_PATTERN, taskPrefixOf } from "@nightshift/core";
import type { CheckConfig, DatabaseConfig, DeviceMode, LocalFilesConfig, ModelChoice, NewProjectInput, PreviewConfig, PreviewService, PreviewTarget, Project, ProjectInspection, ProjectKind, ProjectSource, ProjectUpdate, TesterConfig } from "@nightshift/core";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { api, messageOf } from "../api";
import { Notice } from "./Notice";
import { KindIcon, kindDef, kindOptions } from "./projectKinds";
import { Spinner } from "./TaskBits";
import { ModelPicker, useModelInfo, useModels } from "./models";

export type CheckRow = { key: number; name: string; command: string; timeoutMs?: number };
export type EnvRow = { key: number; name: string; value: string };
export type ServiceTarget = "" | "machine" | "container";
export type ServiceCheck = "http" | "tcp";
export type ServiceRow = {
  key: number;
  name: string;
  cwd: string;
  command: string;
  portEnv: string;
  readyPath: string;
  env: EnvRow[];
  primary: boolean;
  target: ServiceTarget;
  containerPort: string;
  shared: boolean;
  port: string;
  external: boolean;
  check: ServiceCheck;
  stash: string;
};
export type DbMode = "none" | "docker" | "existing";
export type SourceType = "local" | "wondercall-mcp";
export type PlanMode = "off" | "plan" | "approve";
export type PushMode = "auto" | "approve";

export type ProjectForm = {
  name: string;
  kind: ProjectKind;
  paused: boolean;
  brief: string;
  path: string;
  remote: string;
  baseBranch: string;
  branchPrefix: string;
  taskPrefix: string;
  setup: string;
  gitHost: "github" | "local";
  sourceType: SourceType;
  mcpUrl: string;
  tokenEnv: string;
  wcProject: string;
  checks: CheckRow[];
  previewOn: boolean;
  previewCommand: string;
  portEnv: string;
  readyPath: string;
  previewEnv?: Record<string, string>;
  previewServices: ServiceRow[];
  previewInstall: string;
  previewTarget: PreviewTarget;
  containerImage: string;
  containerPort: string;
  deviceMode: DeviceMode;
  dbMode: DbMode;
  dbImage: string;
  dbAdminUrl: string;
  dbEnvVar: string;
  dbSetup: string;
  planMode: PlanMode;
  pushMode: PushMode;
  review: boolean;
  model: ModelChoice | null;
  reviewModel: ModelChoice | null;
  testers: TesterConfig[];
  localFiles: LocalFilesConfig | null;
};

let checkSeq = 0;
export const newCheck = (name = "", command = "", timeoutMs?: number): CheckRow => ({ key: ++checkSeq, name, command, ...(timeoutMs ? { timeoutMs } : {}) });

const newEnv = (name = "", value = ""): EnvRow => ({ key: ++checkSeq, name, value });

const envRows = (env: Record<string, string> | undefined) => Object.entries(env ?? {}).map(([k, v]) => newEnv(k, v));

export const newService = (patch: Partial<Omit<ServiceRow, "key">> = {}): ServiceRow => ({
  key: ++checkSeq,
  name: "",
  cwd: "",
  command: "",
  portEnv: "PORT",
  readyPath: "",
  env: [],
  primary: false,
  target: "",
  containerPort: "",
  shared: false,
  port: "",
  external: false,
  check: "http",
  stash: "",
  ...patch,
});

const withPrimary = (rows: ServiceRow[]) => {
  const apps = rows.filter((r) => !r.shared);
  if (apps.some((r) => r.primary) && !rows.some((r) => r.shared && r.primary)) return rows;
  const main = apps.find((r) => r.primary)?.key ?? apps[0]?.key;
  return rows.map((r) => ({ ...r, primary: r.key === main }));
};

export const envPrefix = (name: string) => `NIGHTSHIFT_${(name.trim() || "name").toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;

const serviceRows = (services: PreviewService[] | undefined) =>
  withPrimary(
    (services ?? []).map((s) =>
      newService({
        name: s.name,
        cwd: s.cwd ?? "",
        command: s.command,
        portEnv: s.portEnv ?? "PORT",
        readyPath: s.readyPath ?? "",
        env: envRows(s.env),
        primary: Boolean(s.primary) && !s.shared,
        target: s.target ?? "",
        containerPort: s.containerPort ? String(s.containerPort) : "",
        shared: Boolean(s.shared),
        port: s.port ? String(s.port) : "",
        external: Boolean(s.shared && !s.command.trim()),
        check: s.check ?? "http",
      }),
    ),
  );

const blank: ProjectForm = {
  name: "",
  kind: "other",
  paused: false,
  brief: "",
  path: "",
  remote: "origin",
  baseBranch: "main",
  branchPrefix: "nightshift/",
  taskPrefix: DEFAULT_TASK_PREFIX,
  setup: "",
  gitHost: "github",
  sourceType: "local",
  mcpUrl: "",
  tokenEnv: "WONDERCALL_AGENT_TOKEN",
  wcProject: "",
  checks: [],
  previewOn: false,
  previewCommand: "",
  portEnv: "PORT",
  readyPath: "",
  previewServices: [],
  previewInstall: "",
  previewTarget: "machine",
  containerImage: "node:22-alpine",
  containerPort: "",
  deviceMode: "lan",
  dbMode: "none",
  dbImage: "postgres:17",
  dbAdminUrl: "",
  dbEnvVar: "DATABASE_URL",
  dbSetup: "",
  planMode: "off",
  pushMode: "auto",
  review: true,
  model: null,
  reviewModel: null,
  testers: [],
  localFiles: null,
};

export const DEFAULT_CONTAINER_IMAGE = "node:22-alpine";

const previewFields = (preview: PreviewConfig | undefined) =>
  preview
    ? {
        previewOn: true,
        previewCommand: preview.command,
        portEnv: preview.portEnv ?? "PORT",
        readyPath: preview.readyPath ?? "",
        previewEnv: preview.env,
        previewServices: serviceRows(preview.services),
        previewInstall: preview.install ?? "",
        previewTarget: preview.target ?? ("machine" as PreviewTarget),
        containerImage: preview.container?.image ?? "node:22-alpine",
        containerPort: preview.containerPort ? String(preview.containerPort) : "",
        deviceMode: preview.device?.mode ?? ("lan" as DeviceMode),
      }
    : {
        previewOn: false,
        previewCommand: "",
        portEnv: "PORT",
        readyPath: "",
        previewEnv: undefined,
        previewServices: [] as ServiceRow[],
        previewInstall: "",
        previewTarget: "machine" as PreviewTarget,
        containerImage: "node:22-alpine",
        containerPort: "",
        deviceMode: "lan" as DeviceMode,
      };

const databaseFields = (db: DatabaseConfig | undefined) =>
  !db || db.mode === "none"
    ? { dbMode: "none" as DbMode, dbImage: "postgres:17", dbAdminUrl: "", dbEnvVar: "DATABASE_URL", dbSetup: "" }
    : { dbMode: db.mode, dbImage: db.image ?? "postgres:17", dbAdminUrl: db.adminUrl ?? "", dbEnvVar: db.envVar ?? "DATABASE_URL", dbSetup: db.setup ?? "" };

export const formFromProject = (p: Project): ProjectForm => ({
  ...blank,
  name: p.name,
  kind: p.kind ?? "other",
  paused: p.paused ?? false,
  brief: p.brief ?? "",
  path: p.repo.path,
  remote: p.repo.remote,
  baseBranch: p.repo.baseBranch,
  branchPrefix: p.repo.branchPrefix,
  taskPrefix: taskPrefixOf(p),
  setup: p.repo.setup ?? "",
  gitHost: p.gitHost,
  sourceType: p.source.type,
  mcpUrl: p.source.type === "wondercall-mcp" ? p.source.url : "",
  tokenEnv: p.source.type === "wondercall-mcp" ? p.source.tokenEnv : blank.tokenEnv,
  wcProject: p.source.type === "wondercall-mcp" ? (p.source.projectId ?? "") : "",
  checks: p.checks.map((c) => newCheck(c.name, c.command, c.timeoutMs)),
  ...previewFields(p.preview),
  ...databaseFields(p.database),
  planMode: p.planMode ?? "off",
  pushMode: p.pushMode ?? "auto",
  review: p.review ?? false,
  model: p.model ?? null,
  reviewModel: p.reviewModel ?? null,
  testers: p.testers ?? [],
  localFiles: p.localFiles ?? null,
});

export const formFromInspection = (i: ProjectInspection): ProjectForm => ({
  ...blank,
  name: i.suggested.name || i.name,
  kind: i.kind,
  path: i.path,
  remote: i.git.remote ?? "origin",
  baseBranch: i.suggested.baseBranch,
  setup: i.suggested.setup ?? "",
  gitHost: i.suggested.gitHost,
  checks: i.suggested.checks.map((c) => newCheck(c.name, c.command, c.timeoutMs)),
  ...previewFields(i.suggested.preview),
  ...databaseFields(i.suggested.database),
});

const cleanChecks = (f: ProjectForm): CheckConfig[] =>
  f.checks
    .filter((c) => c.command.trim())
    .map((c) => ({ name: c.name.trim() || c.command.trim().split(/\s+/)[0] || "check", command: c.command.trim(), ...(c.timeoutMs ? { timeoutMs: c.timeoutMs } : {}) }));

const sourceOf = (f: ProjectForm): ProjectSource =>
  f.sourceType === "local"
    ? { type: "local" }
    : { type: "wondercall-mcp", url: f.mcpUrl.trim(), tokenEnv: f.tokenEnv.trim(), ...(f.wcProject.trim() ? { projectId: f.wcProject.trim() } : {}) };

const cleanCwd = (cwd: string) => cwd.trim().replace(/^\.\/+/, "").replace(/\/+$/, "").replace(/^\.$/, "");

const cleanEnv = (rows: EnvRow[]) => {
  const env = Object.fromEntries(rows.filter((r) => r.name.trim()).map((r) => [r.name.trim(), r.value]));
  return Object.keys(env).length ? env : undefined;
};

export const parsePort = (v: string) => {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return /^\d+$/.test(t) && n >= 1 && n <= 65535 ? n : Number.NaN;
};

export const portError = (v: string) => (Number.isNaN(parsePort(v)) ? "Use a port from 1 to 65535" : null);

export const serviceRunsIn = (r: Pick<ServiceRow, "target">, previewTarget: PreviewTarget): "machine" | "container" =>
  r.target || (previewTarget === "container" ? "container" : "machine");

const cleanServices = (rows: ServiceRow[], previewTarget: PreviewTarget = "machine"): PreviewService[] =>
  withPrimary(rows).map((r) => {
    const external = r.shared && r.external;
    const cwd = external ? "" : cleanCwd(r.cwd);
    const env = external ? undefined : cleanEnv(r.env);
    const target = previewTarget === "device" || external ? "" : r.target;
    const port = !external && previewTarget !== "device" && serviceRunsIn(r, previewTarget) === "container" ? parsePort(r.containerPort) : null;
    const fixed = r.shared ? parsePort(r.port) : null;
    const tcp = r.shared && r.check === "tcp";
    return {
      name: r.name.trim(),
      command: external ? "" : r.command.trim(),
      ...(cwd ? { cwd } : {}),
      portEnv: r.portEnv.trim() || "PORT",
      ...(r.readyPath.trim() && !tcp ? { readyPath: r.readyPath.trim() } : {}),
      ...(env ? { env } : {}),
      ...(r.primary && !r.shared ? { primary: true } : {}),
      ...(target ? { target } : {}),
      ...(port ? { containerPort: port } : {}),
      ...(r.shared ? { shared: true } : {}),
      ...(fixed ? { port: fixed } : {}),
      ...(tcp ? { check: "tcp" as const } : {}),
    };
  });

export const usesContainer = (f: Pick<ProjectForm, "previewTarget" | "previewServices">) =>
  f.previewTarget === "container" || (f.previewTarget !== "device" && f.previewServices.some((r) => r.target === "container"));

const previewTargetOf = (f: ProjectForm) => ({
  ...(f.previewTarget === "container" ? { target: "container" as const } : {}),
  ...(usesContainer(f) ? { container: { image: f.containerImage.trim() || DEFAULT_CONTAINER_IMAGE } } : {}),
  ...(f.previewTarget === "device" ? { target: "device" as const, device: { mode: f.deviceMode } } : {}),
});

const previewOf = (f: ProjectForm): PreviewConfig | null => {
  if (!f.previewOn) return null;
  if (f.previewServices.length) {
    const services = cleanServices(f.previewServices, f.previewTarget);
    const primary = services.find((x) => x.primary) ?? services.find((x) => !x.shared) ?? services[0];
    return {
      services,
      ...(f.previewInstall.trim() ? { install: f.previewInstall.trim() } : {}),
      command: primary.command,
      portEnv: primary.portEnv ?? "PORT",
      ...(primary.readyPath ? { readyPath: primary.readyPath } : {}),
      ...previewTargetOf(f),
    };
  }
  const containerPort = f.previewTarget === "container" ? parsePort(f.containerPort) : null;
  return {
    command: f.previewCommand.trim(),
    portEnv: f.portEnv.trim() || "PORT",
    ...(f.readyPath.trim() ? { readyPath: f.readyPath.trim() } : {}),
    ...(f.previewEnv ? { env: f.previewEnv } : {}),
    ...previewTargetOf(f),
    ...(containerPort ? { containerPort } : {}),
  };
};

const databaseOf = (f: ProjectForm): DatabaseConfig =>
  f.dbMode === "none"
    ? { mode: "none" }
    : {
        mode: f.dbMode,
        engine: "postgres",
        envVar: f.dbEnvVar.trim() || "DATABASE_URL",
        ...(f.dbMode === "docker" ? { image: f.dbImage.trim() || "postgres:17" } : { adminUrl: f.dbAdminUrl.trim() }),
        ...(f.dbSetup.trim() ? { setup: f.dbSetup.trim() } : {}),
      };

const cleanTesters = (f: ProjectForm): TesterConfig[] =>
  f.testers.map((t) => ({
    id: t.id,
    name: t.name.trim(),
    command: t.command.trim(),
    format: t.format,
    when: t.when,
    blocking: t.blocking,
    enabled: t.enabled,
    ...(t.timeoutMs ? { timeoutMs: t.timeoutMs } : {}),
  }));

export const serviceErrors = (rows: ServiceRow[]) =>
  rows.map((r) => {
    const name = r.name.trim();
    return {
      name: !name ? "A name is required" : /\s/.test(name) ? "No spaces" : rows.some((o) => o.key !== r.key && o.name.trim() === name) ? "Names must be unique" : null,
      command: !(r.shared && r.external) && !r.command.trim(),
      containerPort: r.shared && r.external ? null : portError(r.containerPort),
      port: !r.shared ? null : r.external && !r.port.trim() ? "Enter the port it already listens on" : portError(r.port),
    };
  });

export const needsApp = (rows: ServiceRow[]) => rows.length > 0 && rows.every((r) => r.shared);

export const formErrors = (f: ProjectForm) => ({
  testers: f.testers.some((t) => !t.name.trim() || !t.command.trim()),
  name: !f.name.trim(),
  source: f.sourceType === "wondercall-mcp" && (!f.mcpUrl.trim() || !f.tokenEnv.trim()),
  preview:
    f.previewOn &&
    (f.previewServices.length
      ? needsApp(f.previewServices) || serviceErrors(f.previewServices).some((e) => e.name || e.command || e.port || (f.previewTarget !== "device" && e.containerPort))
      : !f.previewCommand.trim() || (f.previewTarget === "container" && Boolean(portError(f.containerPort)))),
  database: f.dbMode === "existing" && !f.dbAdminUrl.trim(),
  taskPrefix: f.sourceType === "local" && !TASK_PREFIX_PATTERN.test(cleanTaskPrefix(f.taskPrefix)),
});

const cleanTaskPrefix = (value: string) => value.trim().replace(/-+$/, "").toUpperCase() || DEFAULT_TASK_PREFIX;

export const formValid = (f: ProjectForm) => !Object.values(formErrors(f)).some(Boolean);

export const formToInput = (f: ProjectForm): NewProjectInput => {
  const preview = previewOf(f);
  const database = databaseOf(f);
  return {
    name: f.name.trim(),
    kind: f.kind,
    repo: { path: f.path, baseBranch: f.baseBranch.trim() || "main", ...(f.setup.trim() ? { setup: f.setup.trim() } : {}) },
    checks: cleanChecks(f),
    gitHost: f.gitHost,
    source: sourceOf(f),
    planMode: f.planMode,
    pushMode: f.pushMode,
    review: f.review,
    ...(f.sourceType === "local" ? { taskPrefix: cleanTaskPrefix(f.taskPrefix) } : {}),
    ...(f.brief.trim() ? { brief: f.brief.trim() } : {}),
    ...(preview ? { preview } : {}),
    ...(database.mode !== "none" ? { database } : {}),
    ...(f.model ? { model: f.model } : {}),
    ...(f.reviewModel ? { reviewModel: f.reviewModel } : {}),
  };
};

export const cleanLocalFiles = (c: LocalFilesConfig | null): LocalFilesConfig | null => {
  if (!c) return null;
  const paths = [...new Set(c.paths)];
  if (!paths.length) return null;
  const rewrites = c.rewrites
    .filter((x) => paths.includes(x.file) && x.key.trim() && x.value.trim())
    .map((x) => ({ file: x.file, key: x.key.trim(), value: x.value.trim(), was: x.was, service: x.service }));
  return { paths, agentCanRead: c.agentCanRead, rewrites };
};

const parts = (f: ProjectForm) => ({
  name: f.name.trim(),
  kind: f.kind,
  brief: f.brief.trim(),
  paused: f.paused,
  repo: { baseBranch: f.baseBranch.trim() || "main", branchPrefix: f.branchPrefix.trim(), setup: f.setup.trim(), remote: f.remote.trim() || "origin" },
  taskPrefix: cleanTaskPrefix(f.taskPrefix),
  checks: cleanChecks(f),
  gitHost: f.gitHost,
  source: sourceOf(f),
  preview: previewOf(f),
  database: databaseOf(f),
  planMode: f.planMode,
  pushMode: f.pushMode,
  review: f.review,
  model: f.model,
  reviewModel: f.reviewModel,
  testers: cleanTesters(f),
  localFiles: cleanLocalFiles(f.localFiles),
});

export const formToUpdate = (initial: ProjectForm, f: ProjectForm): ProjectUpdate => {
  const a = parts(initial);
  const b = parts(f);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(b) as Array<keyof typeof b>) {
    if (key === "repo") {
      const repo = Object.fromEntries(Object.entries(b.repo).filter(([k, v]) => a.repo[k as keyof typeof a.repo] !== v));
      if (Object.keys(repo).length) out.repo = repo;
    } else if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
      out[key] = b[key];
    }
  }
  return out as ProjectUpdate;
};

export type Suggestion = { id: string; label: ReactNode; apply: (f: ProjectForm) => ProjectForm };

export const suggestionsFor = (f: ProjectForm, i: ProjectInspection): Suggestion[] => {
  const s = i.suggested;
  const out: Suggestion[] = [];
  const code = (t: string) => <code className="rounded bg-muted px-1 font-mono text-xs">{t}</code>;
  if (i.kind !== f.kind) out.push({ id: "kind", label: <>Change kind to {kindDef(i.kind).label}</>, apply: (x) => ({ ...x, kind: i.kind }) });
  if (s.baseBranch && s.baseBranch !== f.baseBranch.trim()) out.push({ id: "base", label: <>Use base branch {code(s.baseBranch)}</>, apply: (x) => ({ ...x, baseBranch: s.baseBranch }) });
  if (s.gitHost !== f.gitHost) out.push({ id: "host", label: <>Set git host to {s.gitHost === "github" ? "GitHub" : "local only"}</>, apply: (x) => ({ ...x, gitHost: s.gitHost }) });
  if (s.setup && s.setup !== f.setup.trim()) out.push({ id: "setup", label: <>Set setup command to {code(s.setup)}</>, apply: (x) => ({ ...x, setup: s.setup ?? "" }) });
  for (const c of s.checks) {
    const same = f.checks.find((x) => x.name.trim() === c.name);
    if (!same) out.push({ id: `check-add-${c.name}`, label: <>Add check {code(c.name)}: {code(c.command)}</>, apply: (x) => ({ ...x, checks: [...x.checks, newCheck(c.name, c.command, c.timeoutMs)] }) });
    else if (same.command.trim() !== c.command)
      out.push({
        id: `check-cmd-${c.name}`,
        label: <>Change check {code(c.name)} to {code(c.command)}</>,
        apply: (x) => ({ ...x, checks: x.checks.map((r) => (r.name.trim() === c.name ? { ...r, command: c.command } : r)) }),
      });
  }
  const suggestedServices = s.preview?.services ?? [];
  if (s.preview && suggestedServices.length) {
    const current = f.previewOn ? cleanServices(f.previewServices) : [];
    const same =
      current.length === suggestedServices.length && suggestedServices.every((x) => current.some((c) => c.name === x.name && c.command === x.command && (c.cwd ?? "") === (x.cwd ?? "")));
    if (!same) {
      out.push({
        id: "preview-services",
        label: <>Run one preview per service: {suggestedServices.map((x, idx) => <span key={x.name}>{idx ? ", " : ""}{code(x.name)}</span>)}</>,
        apply: (x) => ({ ...x, ...previewFields(s.preview), ...(x.previewOn ? { previewTarget: x.previewTarget, containerImage: x.containerImage, deviceMode: x.deviceMode } : {}) }),
      });
    }
  } else if (s.preview && (!f.previewOn || s.preview.command !== f.previewCommand.trim()))
    out.push({ id: "preview", label: <>{f.previewOn ? "Change" : "Add"} preview {code(s.preview.command)}</>, apply: (x) => ({ ...x, ...previewFields(s.preview) }) });
  if (s.database.mode !== "none" && (f.dbMode !== s.database.mode || (s.database.setup ?? "") !== f.dbSetup.trim()))
    out.push({
      id: "db",
      label: (
        <>
          Use {s.database.mode === "docker" ? "Docker Postgres" : "an existing Postgres server"}
          {s.database.setup ? <> with setup {code(s.database.setup)}</> : null}
        </>
      ),
      apply: (x) => ({ ...x, ...databaseFields(s.database) }),
    });
  return out;
};

export function Field({
  id,
  label,
  hint,
  error,
  optional,
  className,
  children,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: boolean;
  optional?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("grid min-w-0 gap-2", className)}>
      <Label htmlFor={id}>
        {label}
        {optional ? <span className="font-normal text-muted-foreground">(optional)</span> : null}
      </Label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className={cn("text-xs text-muted-foreground", error && "text-destructive")}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Choice({ value, id, title, hint, selected }: { value: string; id: string; title: string; hint: string; selected: boolean }) {
  return (
    <Label
      htmlFor={id}
      className={cn("flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal transition-colors hover:bg-muted/50", selected && "border-primary bg-muted/40")}
    >
      <RadioGroupItem value={value} id={id} className="mt-0.5" />
      <span className="grid gap-1">
        <span className="font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </span>
    </Label>
  );
}

export function PlanModeField({ id, value, onChange }: { id: string; value: PlanMode; onChange: (v: PlanMode) => void }) {
  return (
    <Field
      id={id}
      label="Plan first"
      hint={
        value === "approve"
          ? "The agent posts its plan and waits. Reply on the task to approve it or ask for changes."
          : value === "plan"
            ? "The agent writes a plan, posts it, then starts right away."
            : "The agent starts working straight away."
      }
    >
      <Select value={value} onValueChange={(v) => onChange(v as PlanMode)}>
        <SelectTrigger id={id} className="w-full" aria-describedby={`${id}-hint`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="off">Off</SelectItem>
          <SelectItem value="plan">Plan, then work</SelectItem>
          <SelectItem value="approve">Plan and wait for my approval</SelectItem>
        </SelectContent>
      </Select>
    </Field>
  );
}

export function PushModeField({ id, value, onChange }: { id: string; value: PushMode; onChange: (v: PushMode) => void }) {
  return (
    <div className="grid gap-2">
      <Label id={`${id}-label`} asChild>
        <span>Pushing</span>
      </Label>
      <RadioGroup value={value} onValueChange={(v) => onChange(v as PushMode)} aria-labelledby={`${id}-label`} className="grid gap-2 sm:grid-cols-2">
        <Choice
          value="auto"
          id={`${id}-auto`}
          title="Automatically"
          hint="Commits and pushes after checks and review pass, then opens the pull request."
          selected={value === "auto"}
        />
        <Choice
          value="approve"
          id={`${id}-approve`}
          title="After I approve"
          hint="The agent still commits on this Mac after each round, but Nightshift asks you before every push and before opening the pull request."
          selected={value === "approve"}
        />
      </RadioGroup>
    </div>
  );
}

export function SwitchRow({ id, label, hint, checked, onChange }: { id: string; label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
      <div className="grid gap-1">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

export function KindSelect({ id, value, onChange }: { id: string; value: ProjectKind; onChange: (v: ProjectKind) => void }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as ProjectKind)}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {kindOptions(value).map((k) => (
          <SelectItem key={k.kind} value={k.kind}>
            <KindIcon kind={k.kind} className="text-muted-foreground" />
            {k.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function BriefField({
  id,
  projectId,
  value,
  onChange,
  disabled,
}: {
  id: string;
  projectId: string | null;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const mentions = useFileMentions({ projectId: projectId ?? "", value, setValue: onChange, ref });
  const generate = async () => {
    if (!projectId) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await api.generateBrief(projectId);
      onChange(res.brief);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setGenerating(false);
    }
  };
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label htmlFor={id}>Project brief</Label>
        {projectId ? (
          <Button type="button" variant="outline" size="sm" onClick={() => void generate()} disabled={generating || disabled}>
            {generating ? <Spinner className="size-3.5" /> : <Sparkles />}
            {generating ? "Reading the repository…" : "Generate from the repository"}
          </Button>
        ) : null}
      </div>
      <div className="relative">
      {projectId ? mentions.list : null}
      <Textarea
        ref={ref}
        id={id}
        rows={10}
        value={value}
        {...(projectId ? mentions.inputProps : {})}
        onKeyDown={(e) => {
          if (projectId) mentions.onKeyDown(e);
        }}
        onChange={(e) => {
          onChange(e.target.value);
          if (projectId) mentions.detect(e.target.value, e.target.selectionStart);
        }}
        disabled={generating || disabled}
        aria-describedby={`${id}-hint`}
        className="font-mono text-[13px]"
        placeholder="What this project is, its stack, how to run it, conventions agents must follow… Type @ to point agents at a file (e.g. @CONTRIBUTING.md)."
      />
      </div>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        Added to every agent's instructions in this project. Files you mention with @ are read from each task's workspace when its agent starts and added too. Generating replaces the text above; review it before saving.
      </p>
      {error ? (
        <Notice tone="danger" title="Could not generate the brief">
          {error}
        </Notice>
      ) : null}
    </div>
  );
}

type Mode = "create" | "edit";

const shellQuote = (v: string) => (/^[\w./@-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`);

export const splitIntoServices = (f: ProjectForm): ProjectForm => ({
  ...f,
  previewServices: [
    newService({
      name: f.kind === "backend" ? "api" : "web",
      command: f.previewCommand.trim(),
      portEnv: f.portEnv.trim() || "PORT",
      readyPath: f.readyPath.trim(),
      env: envRows(f.previewEnv),
      primary: true,
      containerPort: f.previewTarget === "container" ? f.containerPort : "",
    }),
  ],
});

export const mergeIntoSingleCommand = (f: ProjectForm): ProjectForm => {
  const only = f.previewServices[0];
  if (!only) return f;
  const cwd = cleanCwd(only.cwd);
  return {
    ...f,
    previewServices: [],
    previewInstall: "",
    previewCommand: [f.previewInstall.trim(), cwd ? `cd ${shellQuote(cwd)} && ${only.command.trim()}` : only.command.trim()].filter(Boolean).join(" && "),
    portEnv: only.portEnv.trim() || "PORT",
    readyPath: only.readyPath.trim(),
    previewEnv: cleanEnv(only.env),
    ...(only.target && f.previewTarget !== "device" ? { previewTarget: only.target } : {}),
    containerPort: serviceRunsIn(only, f.previewTarget) === "container" ? only.containerPort : "",
  };
};

function Template({ children }: { children: string }) {
  return <code className="rounded bg-muted px-1 font-mono text-[0.6875rem] text-foreground">{children}</code>;
}

function SharedSettings({ r, err, sid, update }: { r: ServiceRow; err: ReturnType<typeof serviceErrors>[number]; sid: (s: string) => string; update: (key: number, patch: Partial<ServiceRow>) => void }) {
  const name = r.name.trim() || "name";
  const env = envPrefix(r.name);
  return (
    <div className={cn("grid gap-3 rounded-lg border border-dashed p-3 transition-colors", r.shared && "border-solid border-violet-500/30 bg-violet-500/[0.04] dark:bg-violet-500/[0.07]")}>
      <div className="flex items-start justify-between gap-4">
        <div className="grid gap-1">
          <Label htmlFor={sid("shared")} className="flex items-center gap-1.5">
            <Share2 className="size-3.5 text-violet-600 dark:text-violet-400" aria-hidden="true" /> Shared by all tasks
          </Label>
          <p id={`${sid("shared")}-hint`} className="text-xs text-muted-foreground">
            One copy for the whole project on one port, used by every task's preview and the agent. For mail servers, Redis or mock APIs.
          </p>
        </div>
        <Switch
          id={sid("shared")}
          checked={r.shared}
          aria-describedby={`${sid("shared")}-hint`}
          onCheckedChange={(v) => update(r.key, v ? { shared: true, primary: false } : { shared: false, external: false, command: r.external ? r.stash : r.command, stash: "" })}
        />
      </div>
      {r.shared ? (
        <>
          <div className="grid items-start gap-3 sm:grid-cols-2">
            <Field
              id={sid("fixed-port")}
              label="Port"
              optional={!r.external}
              error={Boolean(err.port)}
              hint={err.port ?? (r.external ? "Where it already listens on this Mac." : parsePort(r.port) ? "Every task uses this port. Keep it free on this Mac." : "Leave empty and Nightshift picks a port once and keeps it.")}
            >
              <Input
                id={sid("fixed-port")}
                className="font-mono"
                inputMode="numeric"
                value={r.port}
                onChange={(e) => update(r.key, { port: e.target.value })}
                placeholder={r.external ? "6379" : "pick one for me"}
                aria-invalid={Boolean(err.port)}
                aria-describedby={`${sid("fixed-port")}-hint`}
                spellCheck={false}
              />
            </Field>
            <Field
              id={sid("check")}
              label="Health check"
              hint={r.check === "tcp" ? "Up once the port accepts a connection. Use it for IMAP, SMTP, Redis and other non-web servers." : "Up once the ready path answers over HTTP."}
            >
              <Select value={r.check} onValueChange={(v) => update(r.key, { check: v as ServiceCheck })}>
                <SelectTrigger id={sid("check")} className="w-full" aria-describedby={`${sid("check")}-hint`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="http">HTTP path</SelectItem>
                  <SelectItem value="tcp">TCP port</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <div className="flex items-start gap-3">
            <Checkbox
              id={sid("external")}
              className="mt-0.5"
              checked={r.external}
              aria-describedby={`${sid("external")}-hint`}
              onCheckedChange={(v) => update(r.key, v === true ? { external: true, stash: r.command, command: "" } : { external: false, command: r.stash, stash: "" })}
            />
            <div className="grid gap-1">
              <Label htmlFor={sid("external")} className="font-normal">
                Already running outside Nightshift
              </Label>
              <p id={`${sid("external")}-hint`} className="text-xs text-muted-foreground">
                Nightshift starts nothing and points every task at this port.
              </p>
            </div>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            Other apps reach it with <Template>{`{{${name}.host}}`}</Template>, <Template>{`{{${name}.port}}`}</Template> or <Template>{`{{${name}.url}}`}</Template>. The agent's shell and tests get{" "}
            <Template>{`${env}_HOST`}</Template>, <Template>{`${env}_PORT`}</Template> and <Template>{`${env}_URL`}</Template>.
          </p>
        </>
      ) : null}
    </div>
  );
}

function ServicesEditor({ f, onChange, id }: { f: ProjectForm; onChange: (next: ProjectForm) => void; id: (s: string) => string }) {
  const rows = f.previewServices;
  const errors = serviceErrors(rows);
  const primaryKey = rows.find((r) => r.primary)?.key ?? rows.find((r) => !r.shared)?.key;
  const setRows = (next: ServiceRow[]) => onChange({ ...f, previewServices: withPrimary(next) });
  const update = (key: number, patch: Partial<ServiceRow>) => setRows(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const updateEnv = (row: ServiceRow, envKey: number, patch: Partial<EnvRow>) => update(row.key, { env: row.env.map((e) => (e.key === envKey ? { ...e, ...patch } : e)) });
  const remove = (key: number) => setRows(rows.filter((r) => r.key !== key));
  const add = () => setRows([...rows, newService()]);
  const ref = (row: ServiceRow) => rows.find((r) => r.key !== row.key && r.name.trim())?.name.trim() || "api";
  const noApp = needsApp(rows);
  return (
    <div className="grid gap-4">
      <Field id={id("pv-install")} label="Install command" optional hint="Runs once in the worktree root before the services start.">
        <Input
          id={id("pv-install")}
          className="font-mono"
          value={f.previewInstall}
          onChange={(e) => onChange({ ...f, previewInstall: e.target.value })}
          placeholder="bun install"
          aria-describedby={`${id("pv-install")}-hint`}
          spellCheck={false}
        />
      </Field>
      <div className="grid gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <Label id={id("pv-services-label")}>Services</Label>
          <span className="text-xs text-muted-foreground">Each task gets its own copy of every service, with its own port and link, unless it is shared. The main one is what Open preview shows.</span>
        </div>
        {noApp ? (
          <Notice tone="warning" title="Add an app that is not shared">
            Every service here is shared. Each task needs at least one app of its own to be its main preview.
          </Notice>
        ) : null}
        <RadioGroup value={primaryKey === undefined ? "" : String(primaryKey)} onValueChange={(v) => setRows(rows.map((r) => ({ ...r, primary: String(r.key) === v })))} aria-labelledby={id("pv-services-label")} className="grid gap-3">
          {rows.map((r, i) => {
            const err = errors[i];
            const sid = (s: string) => id(`svc-${r.key}-${s}`);
            const label = r.name.trim() || `service ${i + 1}`;
            const external = r.shared && r.external;
            const runsIn = serviceRunsIn(r, f.previewTarget);
            const fixedPort = runsIn === "container" && Boolean(parsePort(r.containerPort));
            const sharedPort = r.shared ? parsePort(r.port) : null;
            const showReady = !r.shared || r.check === "http";
            return (
              <fieldset key={r.key} className="grid min-w-0 gap-3 rounded-lg border p-3">
                <legend className="sr-only">Service {label}</legend>
                <div className={cn("grid items-start gap-3", external ? "sm:grid-cols-[minmax(0,1fr)_auto]" : "sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]")}>
                  <Field id={sid("name")} label="Name" error={Boolean(err.name)} hint={err.name ?? undefined}>
                    <Input
                      id={sid("name")}
                      className="font-mono"
                      value={r.name}
                      onChange={(e) => update(r.key, { name: e.target.value })}
                      placeholder={r.shared ? "imap" : "web"}
                      aria-invalid={Boolean(err.name)}
                      aria-describedby={err.name ? `${sid("name")}-hint` : undefined}
                      spellCheck={false}
                    />
                  </Field>
                  {external ? null : (
                    <Field id={sid("cwd")} label="Folder" optional>
                      <Input id={sid("cwd")} className="font-mono" value={r.cwd} onChange={(e) => update(r.key, { cwd: e.target.value })} placeholder="apps/web" spellCheck={false} />
                    </Field>
                  )}
                  <div className="flex items-center gap-1 sm:pt-[1.375rem]">
                    <Label
                      htmlFor={sid("primary")}
                      className={cn("flex h-9 items-center gap-2 rounded-md px-2 font-normal", r.shared ? "cursor-not-allowed text-muted-foreground" : "cursor-pointer")}
                      title={r.shared ? "A shared service cannot be the main app" : undefined}
                    >
                      <RadioGroupItem value={String(r.key)} id={sid("primary")} disabled={r.shared} />
                      Main
                    </Label>
                    {rows.length > 1 ? (
                      <Button type="button" variant="ghost" size="icon" aria-label={`Remove service ${label}`} onClick={() => remove(r.key)}>
                        <X />
                      </Button>
                    ) : null}
                  </div>
                </div>
                <SharedSettings r={r} err={err} sid={sid} update={update} />
                <Field
                  id={sid("cmd")}
                  label="Dev command"
                  error={err.command}
                  hint={
                    err.command
                      ? "A command is required"
                      : external
                        ? "Started outside Nightshift, so there is nothing to run."
                        : r.shared
                          ? `Runs once for the whole project${sharedPort ? ` on port ${sharedPort}` : ""}. Nightshift passes the port in the port variable.`
                          : fixedPort
                            ? `Runs in the folder above, inside a container. The app listens on port ${parsePort(r.containerPort)} and Nightshift maps it to a free port outside.`
                            : "Runs in the folder above. Nightshift picks a free port and passes it in the port variable."
                  }
                >
                  <Input
                    id={sid("cmd")}
                    className="font-mono"
                    value={r.command}
                    onChange={(e) => update(r.key, { command: e.target.value })}
                    placeholder={external ? "Nothing to run" : r.shared ? "bunx mailpit --smtp 0.0.0.0:$PORT" : "bun run dev -- --port $PORT"}
                    disabled={external}
                    aria-invalid={err.command}
                    aria-describedby={`${sid("cmd")}-hint`}
                    spellCheck={false}
                  />
                </Field>
                {!external || showReady ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {external ? null : (
                      <Field id={sid("port")} label="Port environment variable">
                        <Input id={sid("port")} className="font-mono" value={r.portEnv} onChange={(e) => update(r.key, { portEnv: e.target.value })} placeholder="PORT" spellCheck={false} />
                      </Field>
                    )}
                    {showReady ? (
                      <Field id={sid("ready")} label="Ready path" optional>
                        <Input id={sid("ready")} className="font-mono" value={r.readyPath} onChange={(e) => update(r.key, { readyPath: e.target.value })} placeholder="/" spellCheck={false} />
                      </Field>
                    ) : null}
                  </div>
                ) : null}
                {f.previewTarget !== "device" && !external ? (
                  <div className="grid items-start gap-3 sm:grid-cols-2">
                    <Field id={sid("runs-in")} label="Runs in" hint={runsIn === "container" ? "An isolated Docker container for this app." : "Runs as you, with your tools and files."}>
                      <Select value={runsIn} onValueChange={(v) => update(r.key, { target: v as "machine" | "container" })}>
                        <SelectTrigger id={sid("runs-in")} className="w-full" aria-describedby={`${sid("runs-in")}-hint`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="machine">This machine</SelectItem>
                          <SelectItem value="container">Container</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                    {runsIn === "container" ? (
                      <Field
                        id={sid("cport")}
                        label="Port inside the container"
                        optional
                        error={Boolean(err.containerPort)}
                        hint={err.containerPort ?? (r.shared ? "For apps that always listen on the same port inside the container." : "For apps that always listen on the same port. Each task still gets its own outside port.")}
                      >
                        <Input
                          id={sid("cport")}
                          className="font-mono"
                          inputMode="numeric"
                          value={r.containerPort}
                          onChange={(e) => update(r.key, { containerPort: e.target.value })}
                          placeholder="3000"
                          aria-invalid={Boolean(err.containerPort)}
                          aria-describedby={`${sid("cport")}-hint`}
                          spellCheck={false}
                        />
                      </Field>
                    ) : null}
                  </div>
                ) : null}
                {external ? null : (
                  <div className="grid gap-2">
                    <span className="text-sm font-medium" id={sid("env-label")}>
                      Environment variables <span className="font-normal text-muted-foreground">(optional)</span>
                    </span>
                    {r.env.length ? (
                      <ul className="grid gap-2" aria-labelledby={sid("env-label")}>
                        {r.env.map((e) => (
                          <li key={e.key} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-2">
                            <Input
                              className="font-mono"
                              value={e.name}
                              onChange={(ev) => updateEnv(r, e.key, { name: ev.target.value })}
                              placeholder="NEXT_PUBLIC_API_URL"
                              aria-label={`Variable name for ${label}`}
                              spellCheck={false}
                            />
                            <Input
                              className="font-mono"
                              value={e.value}
                              onChange={(ev) => updateEnv(r, e.key, { value: ev.target.value })}
                              placeholder={`{{${ref(r)}.publicUrl}}`}
                              aria-label={`Value of ${e.name || "variable"} for ${label}`}
                              spellCheck={false}
                            />
                            <Button type="button" variant="ghost" size="icon" aria-label={`Remove variable ${e.name || ""}`.trim()} onClick={() => update(r.key, { env: r.env.filter((x) => x.key !== e.key) })}>
                              <X />
                            </Button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <p className="text-xs text-muted-foreground">
                      Point at another service with <code className="font-mono">{`{{${ref(r)}.publicUrl}}`}</code> (link for the browser), <code className="font-mono">{`{{${ref(r)}.url}}`}</code> (server-side calls),{" "}
                      <code className="font-mono">{`{{${ref(r)}.host}}`}</code> or <code className="font-mono">{`{{${ref(r)}.port}}`}</code>.
                    </p>
                    <div>
                      <Button type="button" variant="outline" size="sm" onClick={() => update(r.key, { env: [...r.env, newEnv()] })}>
                        <Plus /> Add variable
                      </Button>
                    </div>
                  </div>
                )}
              </fieldset>
            );
          })}
        </RadioGroup>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={add}>
          <Plus /> Add service
        </Button>
        {rows.length === 1 && !rows[0]?.shared ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange(mergeIntoSingleCommand(f))}>
            <SquareTerminal /> Use a single command
          </Button>
        ) : null}
      </div>
    </div>
  );
}

const DEVICE_MODES: Array<{ value: DeviceMode; label: string; hint: string }> = [
  { value: "lan", label: "Phone or tablet on my Wi-Fi (LAN link)", hint: "Open a link or scan a QR code on any device on the same network." },
  { value: "expo-go", label: "Expo Go on my phone", hint: "Starts the Expo dev server and shows a QR code to scan with Expo Go." },
  { value: "ios-simulator", label: "iOS Simulator", hint: "Opens the app in the iOS Simulator on this Mac. Needs Xcode." },
  { value: "android-emulator", label: "Android emulator", hint: "Opens the app in a running Android emulator. Needs Android Studio." },
];

function ProjectModelFields({ f, set, id }: { f: ProjectForm; set: <K extends keyof ProjectForm>(key: K, v: ProjectForm[K]) => void; id: (s: string) => string }) {
  const { data } = useModels();
  const defaults = data?.settings;
  const info = useModelInfo([defaults?.default, defaults?.review, f.model]);
  const name = (c: ModelChoice | null | undefined) => (c ? (info(c)?.name ?? c.modelId) : "…");
  const agentDefault = defaults?.default;
  const effectiveAgent = f.model ?? agentDefault;
  const reviewDefault = defaults ? (defaults.review ?? effectiveAgent) : null;
  return (
    <div className="grid items-start gap-4 sm:grid-cols-2">
      <Field id={id("model")} label="Agent model" hint={<>Defaults are set on the <a href="#/settings/models" className="underline underline-offset-4">Models page</a>.</>}>
        <ModelPicker id={id("model")} value={f.model} onChange={(v) => set("model", v)} ariaDescribedBy={`${id("model")}-hint`} nullOption={{ label: <>Use default ({name(agentDefault)})</>, text: "Use default" }} />
      </Field>
      <Field id={id("review-model")} label="Reviewer model">
        <ModelPicker id={id("review-model")} value={f.reviewModel} onChange={(v) => set("reviewModel", v)} nullOption={{ label: <>Use default ({name(reviewDefault)})</>, text: "Use default" }} />
      </Field>
    </div>
  );
}

export function ProjectFormSections({ value: f, onChange, mode, prefix }: { value: ProjectForm; onChange: (next: ProjectForm) => void; mode: Mode; prefix: string }) {
  const uid = useId();
  const set = <K extends keyof ProjectForm>(key: K, v: ProjectForm[K]) => onChange({ ...f, [key]: v });
  const errors = formErrors(f);
  const updateCheck = (key: number, patch: Partial<CheckRow>) => onChange({ ...f, checks: f.checks.map((c) => (c.key === key ? { ...c, ...patch } : c)) });
  const id = (s: string) => `${prefix}-${s}`;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id={id("name")} label="Name" error={errors.name} hint={errors.name ? "A name is required" : undefined}>
              <Input id={id("name")} value={f.name} onChange={(e) => set("name", e.target.value)} required aria-invalid={errors.name} />
            </Field>
            <Field id={id("kind")} label="Kind">
              <KindSelect id={id("kind")} value={f.kind} onChange={(v) => set("kind", v)} />
            </Field>
          </div>
          {mode === "edit" ? (
            <SwitchRow
              id={id("paused")}
              label="Pause new work in this project"
              hint="Agents finish what they are doing but do not pick up new tasks until you resume."
              checked={f.paused}
              onChange={(v) => set("paused", v)}
            />
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Repository</CardTitle>
          <CardDescription>Agents work in their own worktrees and never touch your checkout.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Field id={id("path")} label="Path" hint={mode === "edit" ? "The repository location cannot be changed here." : undefined}>
            <Input id={id("path")} className="font-mono" value={f.path} readOnly aria-readonly="true" aria-describedby={mode === "edit" ? `${id("path")}-hint` : undefined} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            {mode === "edit" ? (
              <Field id={id("remote")} label="Remote">
                <Input id={id("remote")} className="font-mono" value={f.remote} onChange={(e) => set("remote", e.target.value)} placeholder="origin" spellCheck={false} />
              </Field>
            ) : null}
            <Field id={id("base")} label="Base branch">
              <Input id={id("base")} className="font-mono" value={f.baseBranch} onChange={(e) => set("baseBranch", e.target.value)} spellCheck={false} />
            </Field>
            {mode === "edit" ? (
              <Field id={id("prefix")} label="Branch prefix">
                <Input id={id("prefix")} className="font-mono" value={f.branchPrefix} onChange={(e) => set("branchPrefix", e.target.value)} placeholder="nightshift/" spellCheck={false} />
              </Field>
            ) : null}
            {f.sourceType === "local" ? (
              <Field
                id={id("task-prefix")}
                label="Task id prefix"
                error={formErrors(f).taskPrefix}
                hint={
                  formErrors(f).taskPrefix
                    ? "Start with a letter, then up to 9 letters or digits (e.g. WC)."
                    : `New tasks without their own id become ${cleanTaskPrefix(f.taskPrefix)}-1, ${cleanTaskPrefix(f.taskPrefix)}-2, … Existing tasks keep theirs.`
                }
              >
                <Input
                  id={id("task-prefix")}
                  className="font-mono uppercase"
                  value={f.taskPrefix}
                  onChange={(e) => set("taskPrefix", e.target.value.replace(/\s/g, "").toUpperCase())}
                  placeholder={DEFAULT_TASK_PREFIX}
                  maxLength={10}
                  aria-invalid={formErrors(f).taskPrefix}
                  aria-describedby={`${id("task-prefix")}-hint`}
                  spellCheck={false}
                />
              </Field>
            ) : null}
            <Field id={id("host")} label="Git host">
              <Select value={f.gitHost} onValueChange={(v) => set("gitHost", v as "github" | "local")}>
                <SelectTrigger id={id("host")} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="github">GitHub (push and open PRs)</SelectItem>
                  <SelectItem value="local">Local only (no remote)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field id={id("setup")} label="Setup command" optional hint="Runs once in each new worktree before the agent starts.">
            <Input
              id={id("setup")}
              className="font-mono"
              value={f.setup}
              onChange={(e) => set("setup", e.target.value)}
              placeholder="bun install"
              aria-describedby={`${id("setup")}-hint`}
              spellCheck={false}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Task source</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <RadioGroup value={f.sourceType} onValueChange={(v) => set("sourceType", v as SourceType)} aria-label="Where tasks come from" className="grid gap-2 sm:grid-cols-2">
            <Choice value="local" id={`${uid}-src-local`} title="Nightshift tasks" hint="Create and manage tasks right here." selected={f.sourceType === "local"} />
            <Choice value="wondercall-mcp" id={`${uid}-src-wc`} title="WonderCall" hint="Take tasks marked Ready for AI from a WonderCall workspace." selected={f.sourceType === "wondercall-mcp"} />
          </RadioGroup>
          {f.sourceType === "wondercall-mcp" ? (
            <>
              <Field id={id("mcp")} label="MCP URL" error={errors.source && !f.mcpUrl.trim()} hint={errors.source && !f.mcpUrl.trim() ? "The MCP URL is required" : undefined}>
                <Input id={id("mcp")} className="font-mono" type="url" value={f.mcpUrl} onChange={(e) => set("mcpUrl", e.target.value)} placeholder="https://…/mcp" spellCheck={false} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id={id("token")} label="Token environment variable" hint="Name of the variable that holds the token, not the token itself.">
                  <Input id={id("token")} className="font-mono" value={f.tokenEnv} onChange={(e) => set("tokenEnv", e.target.value)} aria-describedby={`${id("token")}-hint`} spellCheck={false} />
                </Field>
                <Field id={id("wcp")} label="WonderCall project id" optional>
                  <Input id={id("wcp")} className="font-mono" value={f.wcProject} onChange={(e) => set("wcProject", e.target.value)} spellCheck={false} />
                </Field>
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Checks</CardTitle>
          <CardDescription>Commands the agent must pass before it pushes, run from the repository root.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {f.checks.length === 0 ? <p className="text-sm text-muted-foreground">No checks. The agent pushes without running anything.</p> : null}
          <ul className="grid gap-2">
            {f.checks.map((c, i) => (
              <li key={c.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] items-end gap-2">
                <div className="grid gap-2">
                  <Label htmlFor={id(`cn-${c.key}`)} className={i > 0 ? "sr-only" : undefined}>
                    Name
                  </Label>
                  <Input id={id(`cn-${c.key}`)} value={c.name} onChange={(e) => updateCheck(c.key, { name: e.target.value })} placeholder="test" />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor={id(`cc-${c.key}`)} className={i > 0 ? "sr-only" : undefined}>
                    Command
                  </Label>
                  <Input id={id(`cc-${c.key}`)} className="font-mono" value={c.command} onChange={(e) => updateCheck(c.key, { command: e.target.value })} placeholder="bun run test" spellCheck={false} />
                </div>
                <Button type="button" variant="ghost" size="icon" aria-label={`Remove check ${c.name || i + 1}`} onClick={() => onChange({ ...f, checks: f.checks.filter((x) => x.key !== c.key) })}>
                  <X />
                </Button>
              </li>
            ))}
          </ul>
          <div>
            <Button type="button" variant="outline" size="sm" onClick={() => onChange({ ...f, checks: [...f.checks, newCheck()] })}>
              <Plus /> Add check
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Preview</CardTitle>
          <CardDescription>Run a dev server in each worktree so you can open the agent's work in a browser.</CardDescription>
          <CardAction>
            <Switch checked={f.previewOn} onCheckedChange={(v) => set("previewOn", v)} aria-label="Enable preview" />
          </CardAction>
        </CardHeader>
        {f.previewOn ? (
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <Label id={id("pv-target-label")}>Run the preview on</Label>
              <RadioGroup value={f.previewTarget} onValueChange={(v) => set("previewTarget", v as PreviewTarget)} aria-labelledby={id("pv-target-label")} className="grid gap-2 sm:grid-cols-3">
                <Choice value="machine" id={`${uid}-pv-machine`} title="This machine" hint="Fastest. Runs as you, with your tools and files." selected={f.previewTarget === "machine"} />
                <Choice value="container" id={`${uid}-pv-container`} title="Container" hint="An isolated Docker container per worktree." selected={f.previewTarget === "container"} />
                <Choice value="device" id={`${uid}-pv-device`} title="Device" hint="A phone, tablet, simulator or emulator." selected={f.previewTarget === "device"} />
              </RadioGroup>
            </div>
            {usesContainer(f) ? (
              <>
                <Field id={id("pv-image")} label="Container image" hint="The worktree is mounted into this image. Docker must be running.">
                  <Input id={id("pv-image")} className="font-mono" value={f.containerImage} onChange={(e) => set("containerImage", e.target.value)} placeholder={DEFAULT_CONTAINER_IMAGE} aria-describedby={`${id("pv-image")}-hint`} spellCheck={false} />
                </Field>
                <Notice>
                  Dependencies are installed inside the container, not on this machine, so the dev command should install them first, for example <code className="font-mono text-xs">npm ci &amp;&amp; npm run dev</code>. The server must listen on <code className="font-mono text-xs">0.0.0.0</code>.
                </Notice>
              </>
            ) : null}
            {f.previewTarget === "device" ? (
              <>
                <Field id={id("pv-device")} label="Device" hint={DEVICE_MODES.find((d) => d.value === f.deviceMode)?.hint}>
                  <Select value={f.deviceMode} onValueChange={(v) => set("deviceMode", v as DeviceMode)}>
                    <SelectTrigger id={id("pv-device")} className="w-full" aria-describedby={`${id("pv-device")}-hint`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DEVICE_MODES.map((d) => (
                        <SelectItem key={d.value} value={d.value}>
                          {d.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                {f.deviceMode === "lan" || f.deviceMode === "expo-go" ? (
                  <Notice tone="warning" title="Visible on your local network">
                    The dev server listens on your network address, so anyone on the same Wi-Fi can open it while the preview runs. Avoid this on public networks.
                  </Notice>
                ) : null}
              </>
            ) : null}
            {f.previewServices.length ? (
              <ServicesEditor f={f} onChange={onChange} id={id} />
            ) : (
              <>
                <Field id={id("pv-cmd")} label="Dev command" hint="Runs from the worktree root. Nightshift picks a free port and passes it in the port variable." error={errors.preview}>
                  <Input
                    id={id("pv-cmd")}
                    className="font-mono"
                    value={f.previewCommand}
                    onChange={(e) => set("previewCommand", e.target.value)}
                    placeholder={f.previewTarget === "container" ? "npm ci && npm run dev -- --host 0.0.0.0" : f.previewTarget === "device" && f.deviceMode !== "lan" ? "npx expo start" : "bun run dev"}
                    aria-describedby={`${id("pv-cmd")}-hint`}
                    aria-invalid={errors.preview}
                    spellCheck={false}
                  />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field id={id("pv-port")} label="Port environment variable">
                    <Input id={id("pv-port")} className="font-mono" value={f.portEnv} onChange={(e) => set("portEnv", e.target.value)} placeholder="PORT" spellCheck={false} />
                  </Field>
                  <Field id={id("pv-ready")} label="Ready path" optional hint="Polled until it answers before the preview counts as running.">
                    <Input id={id("pv-ready")} className="font-mono" value={f.readyPath} onChange={(e) => set("readyPath", e.target.value)} placeholder="/" aria-describedby={`${id("pv-ready")}-hint`} spellCheck={false} />
                  </Field>
                  {f.previewTarget === "container" ? (
                    <Field
                      id={id("pv-cport")}
                      label="Port inside the container"
                      optional
                      error={Boolean(portError(f.containerPort))}
                      hint={portError(f.containerPort) ?? "For apps that always listen on the same port. Each task still gets its own outside port."}
                    >
                      <Input
                        id={id("pv-cport")}
                        className="font-mono"
                        inputMode="numeric"
                        value={f.containerPort}
                        onChange={(e) => set("containerPort", e.target.value)}
                        placeholder="3000"
                        aria-invalid={Boolean(portError(f.containerPort))}
                        aria-describedby={`${id("pv-cport")}-hint`}
                        spellCheck={false}
                      />
                    </Field>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-dashed p-3">
                  <Button type="button" variant="outline" size="sm" onClick={() => onChange(splitIntoServices(f))}>
                    <Rows3 /> Split into services
                  </Button>
                  <span className="text-xs text-muted-foreground">For monorepos: run a dev server per app, each with its own link.</span>
                </div>
              </>
            )}
          </CardContent>
        ) : null}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Database</CardTitle>
          <CardDescription>Give each worktree its own Postgres database.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <RadioGroup value={f.dbMode} onValueChange={(v) => set("dbMode", v as DbMode)} aria-label="Database" className="grid gap-2 sm:grid-cols-3">
            <Choice value="none" id={`${uid}-db-none`} title="None" hint="No database per worktree." selected={f.dbMode === "none"} />
            <Choice value="docker" id={`${uid}-db-docker`} title="Docker Postgres" hint="A container per worktree." selected={f.dbMode === "docker"} />
            <Choice value="existing" id={`${uid}-db-existing`} title="Existing server" hint="A new database on a Postgres you run." selected={f.dbMode === "existing"} />
          </RadioGroup>
          {f.dbMode === "docker" ? (
            <Field id={id("db-image")} label="Image">
              <Input id={id("db-image")} className="font-mono" value={f.dbImage} onChange={(e) => set("dbImage", e.target.value)} placeholder="postgres:17" spellCheck={false} />
            </Field>
          ) : null}
          {f.dbMode === "existing" ? (
            <Field id={id("db-admin")} label="Admin connection URL" hint="Used to create and drop one database per worktree." error={errors.database}>
              <Input
                id={id("db-admin")}
                className="font-mono"
                value={f.dbAdminUrl}
                onChange={(e) => set("dbAdminUrl", e.target.value)}
                placeholder="postgres://postgres:postgres@127.0.0.1:5432/postgres"
                aria-describedby={`${id("db-admin")}-hint`}
                aria-invalid={errors.database}
                spellCheck={false}
                autoComplete="off"
              />
            </Field>
          ) : null}
          {f.dbMode !== "none" ? (
            <>
              <Field id={id("db-env")} label="Environment variable" hint="The worktree's connection URL is passed in this variable.">
                <Input id={id("db-env")} className="font-mono" value={f.dbEnvVar} onChange={(e) => set("dbEnvVar", e.target.value)} placeholder="DATABASE_URL" aria-describedby={`${id("db-env")}-hint`} spellCheck={false} />
              </Field>
              <Field id={id("db-setup")} label="Setup command" optional hint="Runs in the worktree after the database is created, to migrate and seed it.">
                <Input
                  id={id("db-setup")}
                  className="font-mono"
                  value={f.dbSetup}
                  onChange={(e) => set("dbSetup", e.target.value)}
                  placeholder="bunx prisma migrate deploy && bun run db:seed"
                  aria-describedby={`${id("db-setup")}-hint`}
                  spellCheck={false}
                />
              </Field>
            </>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Agent</CardTitle>
          <CardDescription>How the agent plans, checks and pushes its work before opening a pull request.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <PlanModeField id={id("plan")} value={f.planMode} onChange={(v) => set("planMode", v)} />
          <PushModeField id={id("push")} value={f.pushMode} onChange={(v) => set("pushMode", v)} />
          <SwitchRow id={id("review")} label="AI review before PR" hint="A reviewer model checks the diff before the agent pushes." checked={f.review} onChange={(v) => set("review", v)} />
          <ProjectModelFields f={f} set={set} id={id} />
        </CardContent>
      </Card>
    </>
  );
}
