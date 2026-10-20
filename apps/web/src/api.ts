import { FS_ROUTES, GITHUB_ROUTES as G, LOCAL_FILES_ROUTES as L, SKILL_ROUTES as K, VERIFY_ROUTES as V, type FsListResponse, type FsMkdirResponse } from "@nightshift/core";
import type {
  DeleteProjectResponse,
  LimitsResponse,
  RunLimits,
  ControlAction,
  NewProjectInput,
  NewTaskInput,
  NewTaskResponse,
  ProjectSummary,
  ProjectsResponse,
  ProjectTasksResponse,
  RunDetailResponse,
  RunsResponse,
  SendMessageInput,
  SendMessageResponse,
  StatusResponse,
  TaskViewResponse,
  TaskType,
  TaskTypeUpdate,
  UploadResponse,
  UsageResponse,
  WorkspaceInfo,
  PreviewDiagnosis,
  PreviewDetectResponse,
  PreviewFix,
  FilesResponse,
  FileContent,
  GitStatusResponse,
  PullBaseConflict,
  PullBaseResponse,
  CreateEntryInput,
  GitDiffResponse,
  GitLogResponse,
  ActionsResponse,
  ActionLogResponse,
  BriefResponse,
  CommitDiffResponse,
  InspectInput,
  InspectResponse,
  ProjectKind,
  ProjectUpdate,
  ScaffoldInput,
  ScaffoldResponse,
  Starter,
  CatalogResponse,
  LoginState,
  ModelSettings,
  ModelsResponse,
  ProviderStatus,
  TestResult,
  BranchesResponse,
  SessionsResponse,
  NewSessionInput,
  NewSessionResponse,
  VerificationResponse,
  Issue,
  Decision,
  TriggerConfig,
  TriggersResponse,
  SkillsResponse,
  SkillResponse,
  SkillDiscovery,
  SkillDiscoverInput,
  SkillImportInput,
  SkillWriteInput,
  ProjectSkillsResponse,
  GithubStatus,
  GithubRepoInput,
  MoveToGithubResult,
  LocalFilesScan,
  LocalFilesSyncResult,
  TerminalInfo,
  TerminalsResponse,
} from "@nightshift/core";
import { MODEL_ROUTES as M, ONBOARDING_ROUTES as O, PROJECT_ROUTES as P, SESSION_ROUTES as S, WORKSPACE_ROUTES as W } from "@nightshift/core";

export const DAEMON_ADDRESS = "127.0.0.1:4777";

const enc = encodeURIComponent;

export const ROUTES = {
  status: "/api/status",
  runs: "/api/runs",
  run: (id: string) => `/api/runs/${enc(id)}`,
  control: (id: string, action: ControlAction) => `/api/runs/${enc(id)}/${action}`,
  usage: "/api/usage",
  killSwitch: "/api/kill-switch",
  events: "/api/events",
  projects: "/api/projects",
  tasks: (projectId: string) => `/api/projects/${enc(projectId)}/tasks`,
  task: (projectId: string, taskId: string) => `/api/projects/${enc(projectId)}/tasks/${enc(taskId)}`,
  messages: (projectId: string, taskId: string) => `/api/projects/${enc(projectId)}/tasks/${enc(taskId)}/messages`,
  uploads: "/api/uploads",
  stream: (projectId: string, taskId: string) => `/api/projects/${enc(projectId)}/tasks/${enc(taskId)}/stream`,
} as const;

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const readBody = async (res: Response): Promise<unknown> => {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const errorFrom = (body: unknown): string | null =>
  body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : null;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { Accept: "application/json", ...init?.headers } });
  } catch {
    throw new ApiError(`Daemon not reachable at ${DAEMON_ADDRESS}`, 0);
  }
  const body = await readBody(res);
  const err = errorFrom(body);
  if (!res.ok || err) {
    if (res.status >= 502 && res.status <= 504 && !err) throw new ApiError(`Daemon not reachable at ${DAEMON_ADDRESS}`, 0);
    throw new ApiError(err ?? `Request failed (HTTP ${res.status})`, res.status);
  }
  if (body === null || typeof body !== "object") throw new ApiError("Unexpected response from daemon", res.status);
  return body as T;
}

const post = <T,>(path: string, payload?: unknown) =>
  request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });

export const api = {
  limits: () => request<LimitsResponse>("/api/settings/limits"),
  saveLimits: (limits: Partial<RunLimits> | null) =>
    request<LimitsResponse>("/api/settings/limits", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ limits }) }),
  status: () => request<StatusResponse>(ROUTES.status),
  runs: () => request<RunsResponse>(ROUTES.runs),
  run: (id: string) => request<RunDetailResponse>(ROUTES.run(id)),
  usage: () => request<UsageResponse>(ROUTES.usage),
  control: (id: string, action: ControlAction) => post<{ ok: true }>(ROUTES.control(id, action)),
  killSwitch: (on: boolean) => post<{ killSwitch: boolean }>(ROUTES.killSwitch, { on }),
  projects: () => request<ProjectsResponse>(ROUTES.projects),
  createProject: (input: NewProjectInput) => post<{ project: ProjectSummary }>(ROUTES.projects, input),
  updateProject: (id: string, update: ProjectUpdate) =>
    request<{ project: ProjectSummary }>(P.project(id), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(update) }),
  deleteProject: (id: string, removeWorkspaces: boolean) =>
    request<DeleteProjectResponse>(`${P.project(id)}${removeWorkspaces ? "?workspaces=remove" : ""}`, { method: "DELETE" }),
  inspect: (input: InspectInput, signal?: AbortSignal) =>
    request<InspectResponse>(O.inspect, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal }),
  scaffold: (input: ScaffoldInput) => post<ScaffoldResponse>(O.scaffold, input),
  starters: () => request<{ kinds: Array<{ kind: ProjectKind; label: string; description: string }>; starters: Starter[] }>(O.starters),
  generateBrief: (id: string) => post<BriefResponse>(O.brief(id)),
  github: () => request<GithubStatus>(G.status),
  moveToGithub: (projectId: string, input: GithubRepoInput) => post<MoveToGithubResult>(G.moveProject(projectId), input),
  tasks: (projectId: string) => request<ProjectTasksResponse>(ROUTES.tasks(projectId)),
  createTask: (projectId: string, input: NewTaskInput) => post<NewTaskResponse>(ROUTES.tasks(projectId), input),
  setTaskType: (projectId: string, taskId: string, type: TaskType | null) =>
    request<TaskTypeUpdate>(P.taskType(projectId, taskId), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type } satisfies TaskTypeUpdate) }),
  task: (projectId: string, taskId: string, sessionId?: string | null) =>
    request<TaskViewResponse>(sessionId ? S.taskSession(projectId, taskId, sessionId) : ROUTES.task(projectId, taskId)),
  branches: (projectId: string, q?: string, signal?: AbortSignal) => request<BranchesResponse>(S.branches(projectId, q), { signal }),
  sessions: (projectId: string, taskId: string) => request<SessionsResponse>(S.sessions(projectId, taskId)),
  newSession: (projectId: string, taskId: string, input: NewSessionInput) => post<NewSessionResponse>(S.sessions(projectId, taskId), input),
  sendMessage: (projectId: string, taskId: string, input: SendMessageInput) =>
    post<SendMessageResponse>(ROUTES.messages(projectId, taskId), input),
  upload: (file: File) =>
    request<UploadResponse>(ROUTES.uploads, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": enc(file.name || "image") },
      body: file,
    }),
};

const put = <T,>(path: string, payload: unknown) =>
  request<T>(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });

export const modelsApi = {
  get: () => request<ModelsResponse>(M.models),
  saveSettings: (settings: ModelSettings) => put<{ settings: ModelSettings }>(M.settings, settings),
  catalog: (provider?: string, q?: string, signal?: AbortSignal) => request<CatalogResponse>(M.catalog(provider, q), { signal }),
  saveApiKey: (provider: string, key: string) => post<ProviderStatus>(M.apiKey(provider), { key }),
  test: (provider: string, modelId?: string) => post<TestResult>(M.test(provider), modelId ? { modelId } : {}),
  disconnect: (provider: string) =>
    request<unknown>(M.disconnect(provider), { method: "DELETE" }).catch((err: unknown) => {
      if (err instanceof ApiError && err.status >= 200 && err.status < 300) return null;
      throw err;
    }),
  login: (provider: string) => post<LoginState>(M.login(provider), { method: "oauth" }),
  loginState: (id: string) => request<LoginState>(M.loginState(id)),
  answer: (id: string, promptId: string, value: string) => post<LoginState>(M.loginAnswer(id), { promptId, value }),
  cancelLogin: (id: string) => post<unknown>(M.loginCancel(id)),
};

export const workspaceApi = (p: string, t: string) => ({
  info: () => request<WorkspaceInfo>(W.base(p, t)),
  preview: (action: "start" | "stop" | "restart", service?: string) => post<WorkspaceInfo>(W.preview(p, t, action, service)),
  previewLogs: (service?: string) => request<{ log: string }>(W.previewLogs(p, t, service)),
  previewDiagnose: (service?: string) => post<PreviewDiagnosis>(W.previewDiagnose(p, t, service)),
  previewFix: (fix: PreviewFix, service?: string) => post<WorkspaceInfo>(W.previewFix(p, t, service), { fix }),
  previewDetect: (signal?: AbortSignal) =>
    request<PreviewDetectResponse>(W.previewDetect(p, t), { method: "POST", headers: { "Content-Type": "application/json" }, signal }),
  database: (action: "create" | "reset" | "drop") => post<WorkspaceInfo>(W.database(p, t, action)),
  files: (dir: string) => request<FilesResponse>(W.files(p, t, dir)),
  file: (path: string) => request<FileContent>(W.file(p, t, path)),
  saveFile: (path: string, content: string) => put<{ ok: true }>(`${W.base(p, t)}/file`, { path, content }),
  gitStatus: () => request<GitStatusResponse>(W.gitStatus(p, t)),
  gitDiff: (path: string, staged: boolean) => request<GitDiffResponse>(W.gitDiff(p, t, path, staged)),
  stage: (paths: string[]) => post<{ ok: true }>(W.gitAction(p, t, "stage"), { paths }),
  unstage: (paths: string[]) => post<{ ok: true }>(W.gitAction(p, t, "unstage"), { paths }),
  discard: (paths: string[]) => post<{ ok: true }>(W.gitAction(p, t, "discard"), { paths }),
  commit: (message: string) => post<{ ok: true }>(W.gitAction(p, t, "commit"), { message }),
  push: () => post<{ ok: true }>(W.gitAction(p, t, "push")),
  gitLog: () => request<GitLogResponse>(W.gitLog(p, t)),
  create: (input: CreateEntryInput) => post<CreateEntryInput>(W.create(p, t), input),
  pullBase: async (): Promise<PullBaseResponse | PullBaseConflict> => {
    let res: Response;
    try {
      res = await fetch(W.pullBase(p, t), { method: "POST", headers: { Accept: "application/json" } });
    } catch {
      throw new ApiError(`Daemon not reachable at ${DAEMON_ADDRESS}`, 0);
    }
    const body = await readBody(res);
    if (res.ok && body && typeof body === "object" && "merged" in body) return body as PullBaseResponse;
    if (res.status === 409 && body && typeof body === "object" && "code" in body) return body as PullBaseConflict;
    throw new ApiError(errorFrom(body) ?? `Request failed (HTTP ${res.status})`, res.status);
  },
  commitDiff: (sha: string) => request<CommitDiffResponse>(O.commit(p, t, sha)),
  actions: () => request<ActionsResponse>(W.actions(p, t)),
  actionLog: (id: string) => request<ActionLogResponse>(W.actionLog(p, t, id)),
  listTerminals: () => request<TerminalsResponse>(W.terminals(p, t)),
  createTerminal: (size: { cols: number; rows: number }) => post<TerminalInfo>(W.terminals(p, t), size),
  closeTerminal: (id: string) => request<{ ok: true }>(W.terminal(p, t, id), { method: "DELETE" }),
  terminalInput: (id: string, data: string) => post<{ ok: true }>(W.terminal(p, t, id, "input"), { data }),
  terminalResize: (id: string, size: { cols: number; rows: number }) => post<{ ok: true }>(W.terminal(p, t, id, "resize"), size),
  terminalStreamUrl: (id: string) => W.terminal(p, t, id, "stream"),
});

export type WorkspaceApi = ReturnType<typeof workspaceApi>;

export const verifyApi = {
  verification: (p: string, t: string) => request<VerificationResponse>(V.verification(p, t)),
  setIssue: (p: string, t: string, id: string, status: "dismissed" | "open") => post<{ issue: Issue }>(V.issue(p, t, id), { status }),
  answer: (p: string, t: string, id: string, answer: string) => post<{ decision: Decision; effect: string }>(V.decision(p, t, id), { answer }),
  runTester: (p: string, t: string, testerId: string) => post<{ stepId: string; effect: string }>(V.runTester(p, t, testerId)),
  triggers: (p: string) => request<TriggersResponse>(V.triggers(p)),
  saveTriggers: (p: string, triggers: TriggerConfig) =>
    request<TriggersResponse>(V.triggers(p), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ triggers }) }),
};

export const fsApi = {
  list: (path?: string, hidden = false) => request<FsListResponse>(FS_ROUTES.list(path, hidden)),
  mkdir: (parent: string, name: string) => post<FsMkdirResponse>(FS_ROUTES.mkdir, { parent, name }),
};

const send = <T,>(method: string, path: string, payload: unknown) =>
  request<T>(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });

export const skillsApi = {
  list: () => request<SkillsResponse>(K.list),
  get: (id: string) => request<SkillResponse>(K.skill(id)),
  create: (input: SkillWriteInput) => post<SkillResponse>(K.list, input),
  save: (id: string, content: string) => send<SkillResponse>("PUT", K.skill(id), { content }),
  setEnabled: (id: string, enabled: boolean) => send<SkillResponse>("PATCH", K.skill(id), { enabled }),
  remove: (id: string) => request<{ ok: true }>(K.skill(id), { method: "DELETE" }),
  discover: (input: SkillDiscoverInput, signal?: AbortSignal) =>
    request<SkillDiscovery>(K.discover, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal }),
  import: (input: SkillImportInput) => post<SkillsResponse>(K.import, input),
  project: (projectId: string) => request<ProjectSkillsResponse>(K.project(projectId)),
  setProjectSkill: (projectId: string, id: string, value: boolean | null) => api.updateProject(projectId, { skills: { [id]: value } }),
};

export const scanLocalFiles = (projectId: string, ai = false) => request<LocalFilesScan>(`${L.scan(projectId)}${ai ? "?ai=1" : ""}`);

export const syncLocalFiles = (projectId: string, taskId: string, overwrite: boolean) => post<LocalFilesSyncResult>(W.localFilesSync(projectId, taskId), { overwrite });

export const isConflict = (err: unknown) => err instanceof ApiError && err.status === 409;

export const isUnreachable = (err: unknown) => err instanceof ApiError && err.status === 0;

export const isNotFound = (err: unknown) => err instanceof ApiError && err.status === 404;

export const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
