export type PreviewTarget = "machine" | "container" | "device";

export type DeviceMode = "lan" | "expo-go" | "ios-simulator" | "android-emulator";

export type PreviewService = {
  name: string;
  command: string;
  cwd?: string;
  portEnv?: string;
  readyPath?: string;
  env?: Record<string, string>;
  primary?: boolean;
  target?: "machine" | "container";
  containerPort?: number;
  shared?: boolean;
  port?: number;
  check?: "http" | "tcp";
};

export type PreviewConfig = {
  services?: PreviewService[];
  install?: string;
  command: string;
  portEnv?: string;
  readyPath?: string;
  env?: Record<string, string>;
  target?: PreviewTarget;
  container?: { image: string };
  containerPort?: number;
  device?: { mode: DeviceMode };
};

export type DatabaseConfig =
  | { mode: "none" }
  | {
      mode: "docker" | "existing";
      engine: "postgres";
      image?: string;
      adminUrl?: string;
      envVar?: string;
      setup?: string;
    };

export type PreviewStatus = "stopped" | "starting" | "running" | "failed";

/** Where a preview service's env value comes from, lowest priority first. */
export type EnvSource = "task" | "apps" | "preview" | "rewrite" | "service" | "port";

export type EnvEntry = { key: string; value: string; source: EnvSource; secret: boolean };

/** A value in a `.env` file the app's framework loads itself; `overriddenBy` is set when Nightshift passes the same key. */
export type EnvFileEntry = { file: string; key: string; value: string; secret: boolean; overriddenBy: EnvSource | null };

/** `GET …/workspace/preview/env?service=`: the env a service started with, the env it would get now, and its `.env` files. */
export type ServiceEnvResponse = {
  service: string;
  status: PreviewStatus;
  startedAt: string | null;
  /** What the running process got; null when it is not running. */
  running: EnvEntry[] | null;
  /** What it gets on its next start. Ports of apps that never started show as templates. */
  next: EnvEntry[];
  files: EnvFileEntry[];
  /** Keys whose value differs between `running` and `next`: restart the service to apply them. */
  changed: string[];
  revealed: boolean;
  /** This app's own env as saved in the project settings, templates unfilled (secrets masked unless revealed). */
  own: Record<string, string>;
  /** Keys Nightshift sets last (port, host): an own value for them would be ignored. */
  locked: string[];
  /** Templates this app can use in a value, such as `{{api.publicUrl}}`. */
  templates: string[];
};

/** `PUT …/workspace/preview/env?service=`: changes the app's own env in the project settings. */
export type ServiceEnvUpdate = { set?: Record<string, string>; remove?: string[] };

export type PreviewServiceInfo = {
  name: string;
  primary: boolean;
  status: PreviewStatus;
  url: string | null;
  port: number | null;
  lanUrl: string | null;
  deviceUrl: string | null;
  command: string;
  cwd: string | null;
  error: string | null;
  startedAt: string | null;
  hint: string | null;
  diagnosis: PreviewDiagnosis | null;
  diagnosing: boolean;
  shared: boolean;
  external: boolean;
  check: "http" | "tcp";
  usedBy: string[];
};

export type PreviewFix = { command?: string; env?: Record<string, string>; install?: string; cwd?: string; portEnv?: string; readyPath?: string; target?: "machine" | "container"; containerPort?: number };

export type PreviewDiagnosis = {
  service: string;
  at: string;
  startedAt: string | null;
  summary: string;
  cause: string;
  fix: PreviewFix | null;
  agentPrompt: string | null;
  source: "ai" | "rules";
};

export type PreviewDetectResponse = { suggestion: PreviewConfig | null; notes: string[]; source: "ai" | "rules" };

export type TaskPreviewSummary = { total: number; running: number; starting: number; failed: number; url: string | null; services: Array<{ name: string; status: PreviewStatus; url: string | null }> };

export type PreviewInfo = {
  services: PreviewServiceInfo[];
  installing: boolean;
  install: string | null;
  target: PreviewTarget;
  deviceMode: DeviceMode | null;
  lanUrl: string | null;
  deviceUrl: string | null;
  configured: boolean;
  status: PreviewStatus;
  url: string | null;
  port: number | null;
  command: string | null;
  startedAt: string | null;
  error: string | null;
};

export type DatabaseStatus = "none" | "creating" | "ready" | "failed";

export type DatabaseInfo = {
  configured: boolean;
  mode: "none" | "docker" | "existing";
  status: DatabaseStatus;
  name: string | null;
  url: string | null;
  envVar: string | null;
  error: string | null;
  seededAt: string | null;
};

export type WorkspaceInfo = {
  projectId: string;
  taskId: string;
  exists: boolean;
  path: string | null;
  branch: string | null;
  baseBranch: string;
  agentBusy: boolean;
  preview: PreviewInfo;
  database: DatabaseInfo;
  localFiles: LocalFilesStatus | null;
};

export type EnvRewrite = { file: string; key: string; value: string; was: string; service: string | null };

export type LocalFilesConfig = { paths: string[]; agentCanRead: boolean; rewrites: EnvRewrite[] };

export type LocalFileCandidate = { path: string; size: number; keys: string[]; configured: boolean };

export type LocalFilesScan = { root: string; candidates: LocalFileCandidate[]; rewrites: EnvRewrite[]; notes: string[]; source: "rules" | "ai" };

export type LocalFilesStatus = { configured: string[]; present: string[]; missing: string[]; changed: string[]; syncedAt: string | null };

export type LocalFilesSyncResult = { copied: string[]; skipped: string[]; missing: string[]; status: LocalFilesStatus };

export type FileEntry = {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
  git?: GitFileStatus;
};

export type FilesResponse = { path: string; entries: FileEntry[] };

export type FileContent = {
  path: string;
  content: string;
  binary: boolean;
  size: number;
  language: string;
  tooLarge: boolean;
};

export type GitFileStatus = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";

export type GitChange = { path: string; status: GitFileStatus; oldPath?: string };

export type GitStatusResponse = {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  baseBranch: string;
  baseBehind: number;
  staged: GitChange[];
  unstaged: GitChange[];
};

export type GitDiffResponse = {
  path: string;
  staged: boolean;
  original: string;
  modified: string;
  language: string;
  binary: boolean;
};

export type GitCommit = {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  author: string;
  date: string;
  pushed: boolean;
  files: Array<{ path: string; status: GitFileStatus }>;
};

export type GitLogResponse = { commits: GitCommit[] };

export type ActionRun = {
  id: string;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "cancelled" | "skipped" | "neutral" | null;
  url: string | null;
  branch: string;
  sha: string | null;
  event: string;
  createdAt: string;
  source: "github" | "nightshift";
};

export type ActionsResponse = { provider: "github" | "local"; runs: ActionRun[]; error: string | null };

export type ActionLogResponse = { id: string; log: string };

export const WORKSPACE_ROUTES = {
  base: (p: string, t: string) => `/api/projects/${encodeURIComponent(p)}/tasks/${encodeURIComponent(t)}/workspace`,
  preview: (p: string, t: string, action: "start" | "stop" | "restart", service?: string) =>
    `${WORKSPACE_ROUTES.base(p, t)}/preview/${action}${service ? `?service=${encodeURIComponent(service)}` : ""}`,
  previewEnv: (p: string, t: string, service?: string, reveal = false) => {
    const q = new URLSearchParams({ ...(service ? { service } : {}), ...(reveal ? { reveal: "1" } : {}) }).toString();
    return `${WORKSPACE_ROUTES.base(p, t)}/preview/env${q ? `?${q}` : ""}`;
  },
  previewLogs: (p: string, t: string, service?: string) => `${WORKSPACE_ROUTES.base(p, t)}/preview/logs${service ? `?service=${encodeURIComponent(service)}` : ""}`,
  database: (p: string, t: string, action: "create" | "reset" | "drop") => `${WORKSPACE_ROUTES.base(p, t)}/database/${action}`,
  files: (p: string, t: string, dir = "") => `${WORKSPACE_ROUTES.base(p, t)}/files?path=${encodeURIComponent(dir)}`,
  file: (p: string, t: string, file: string) => `${WORKSPACE_ROUTES.base(p, t)}/file?path=${encodeURIComponent(file)}`,
  gitStatus: (p: string, t: string) => `${WORKSPACE_ROUTES.base(p, t)}/git/status`,
  gitDiff: (p: string, t: string, file: string, staged: boolean) =>
    `${WORKSPACE_ROUTES.base(p, t)}/git/diff?path=${encodeURIComponent(file)}&staged=${staged ? 1 : 0}`,
  gitAction: (p: string, t: string, action: "stage" | "unstage" | "discard" | "commit" | "push") => `${WORKSPACE_ROUTES.base(p, t)}/git/${action}`,
  gitLog: (p: string, t: string) => `${WORKSPACE_ROUTES.base(p, t)}/git/log`,
  pullBase: (p: string, t: string) => `${WORKSPACE_ROUTES.base(p, t)}/git/pull-base`,
  previewDiagnose: (p: string, t: string, service?: string) => `${WORKSPACE_ROUTES.base(p, t)}/preview/diagnose${service ? `?service=${encodeURIComponent(service)}` : ""}`,
  previewFix: (p: string, t: string, service?: string) => `${WORKSPACE_ROUTES.base(p, t)}/preview/fix${service ? `?service=${encodeURIComponent(service)}` : ""}`,
  previewDetect: (p: string, t: string) => `${WORKSPACE_ROUTES.base(p, t)}/preview/detect`,
  localFilesSync: (p: string, t: string) => `${WORKSPACE_ROUTES.base(p, t)}/local-files/sync`,
  terminals: (p: string, t: string) => `${WORKSPACE_ROUTES.base(p, t)}/terminals`,
  terminal: (p: string, t: string, id: string, action?: "stream" | "input" | "resize") =>
    `${WORKSPACE_ROUTES.base(p, t)}/terminals/${encodeURIComponent(id)}${action ? `/${action}` : ""}`,
  create: (p: string, t: string) => `${WORKSPACE_ROUTES.base(p, t)}/files/create`,
  actions: (p: string, t: string) => `${WORKSPACE_ROUTES.base(p, t)}/actions`,
  actionLog: (p: string, t: string, id: string) => `${WORKSPACE_ROUTES.base(p, t)}/actions/${encodeURIComponent(id)}/log`,
} as const;

export type PullBaseResponse = { baseBranch: string; merged: number; upToDate: boolean; sha: string };

export type PullBaseConflict = { error: string; code: "conflict" | "dirty"; conflicts: string[]; baseBranch: string };

export type CreateEntryInput = { path: string; kind: "file" | "folder" };

export const LOCAL_FILES_ROUTES = { scan: (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/local-files/scan` } as const;

export type TerminalInfo = { id: string; title: string; cwd: string; shell: string; createdAt: string; exited: boolean; exitCode: number | null };

export type TerminalsResponse = { terminals: TerminalInfo[] };

export type TerminalStreamEvent = { type: "output"; data: string } | { type: "exit"; code: number | null } | { type: "reset" };
