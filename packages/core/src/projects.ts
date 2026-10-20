import type { CheckConfig } from "./config.ts";
import type { DatabaseConfig, PreviewConfig } from "./workspace.ts";
import type { AgentActivity, Run, RunEvent } from "./runs.ts";
import type { TaskComment, TaskDetail, TaskStatus } from "./tasks.ts";

export type ProjectSource =
  | { type: "local" }
  | { type: "wondercall-mcp"; url: string; tokenEnv: string; projectId?: string };

export type ProjectRepo = {
  path: string;
  remote: string;
  baseBranch: string;
  branchPrefix: string;
  setup?: string;
};

export type Project = {
  id: string;
  name: string;
  repo: ProjectRepo;
  checks: CheckConfig[];
  gitHost: "github" | "local";
  source: ProjectSource;
  preview?: PreviewConfig;
  database?: DatabaseConfig;
  planMode?: "off" | "plan" | "approve";
  review?: boolean;
  kind?: import("./onboarding.ts").ProjectKind;
  brief?: string;
  paused?: boolean;
  model?: import("./models.ts").ModelChoice;
  reviewModel?: import("./models.ts").ModelChoice;
  testers?: import("./verification.ts").TesterConfig[];
  triggers?: import("./verification.ts").TriggerConfig;
  skills?: Record<string, boolean>;
  pushMode?: "auto" | "approve";
  localFiles?: import("./workspace.ts").LocalFilesConfig;
  createdAt: string;
};

export type NewProjectInput = {
  name: string;
  repo: { path: string; remote?: string; baseBranch?: string; branchPrefix?: string; setup?: string };
  checks?: CheckConfig[];
  gitHost?: "github" | "local";
  source?: ProjectSource;
  preview?: PreviewConfig;
  database?: DatabaseConfig;
  planMode?: "off" | "plan" | "approve";
  pushMode?: "auto" | "approve";
  review?: boolean;
  kind?: import("./onboarding.ts").ProjectKind;
  brief?: string;
  model?: import("./models.ts").ModelChoice | null;
  reviewModel?: import("./models.ts").ModelChoice | null;
};

export type ProjectSummary = Project & {
  taskCounts: Partial<Record<TaskStatus, number>>;
  activeRuns: number;
  openDecisions: number;
  sourceError: string | null;
  commitAuthor?: import("./config.ts").CommitAuthor;
};

export type ProjectsResponse = { projects: ProjectSummary[] };

/** `DELETE /api/projects/:id` (`?workspaces=remove` also removes task worktrees and databases). */
export type DeleteProjectResponse = { stopped: string[]; removedWorkspaces: number };

export type TaskRunSummary = {
  id: string;
  model: string;
  phase: Run["phase"];
  paused: boolean;
  activity: string | null;
  prUrl: string | null;
  prNumber: number | null;
  fixRounds: number;
  costUsd: number;
  updatedAt: string;
};

export type TaskListItem = {
  id: string;
  title: string;
  status: TaskStatus;
  createdAt: string | null;
  updatedAt: string | null;
  run: TaskRunSummary | null;
  unreadMessages: number;
  baseBranch: string;
  origin: import("./verification.ts").TaskOrigin;
  openDecisions: number;
  openIssues: number;
  type: import("./task-types.ts").TaskType | null;
  preview: import("./workspace.ts").TaskPreviewSummary | null;
};

export type ProjectTasksResponse = { project: ProjectSummary; tasks: TaskListItem[] };

export type AttachmentRef = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
};

export type TranscriptAuthor = "task" | "operator" | "answer" | "feedback" | "system";

export type TranscriptItem =
  | { kind: "user"; id: string; at: string | null; author: TranscriptAuthor; text: string; attachments: AttachmentRef[]; messageIds?: string[] }
  | { kind: "assistant"; id: string; at: string | null; text: string }
  | { kind: "tool"; id: string; at: string | null; name: string; summary: string; args: string; result: string | null; isError: boolean; running: boolean };

export type OperatorMessage = {
  id: string;
  text: string;
  attachments: AttachmentRef[];
  createdAt: string;
  delivered: boolean;
  deliveredAt: string | null;
  runId: string | null;
};

export type TaskViewResponse = {
  type: import("./task-types.ts").TaskType | null;
  origin: import("./verification.ts").TaskOrigin;
  openDecisions: number;
  baseBranch: string;
  session: string | null;
  sessions: import("./sessions.ts").TaskSession[];
  workspace: import("./workspace.ts").WorkspaceInfo;
  project: Project;
  task: TaskDetail;
  comments: TaskComment[];
  run: Run | null;
  runs: Array<Pick<Run, "id" | "phase" | "createdAt" | "prUrl">>;
  transcript: TranscriptItem[];
  live: AgentActivity | null;
  events: RunEvent[];
  messages: OperatorMessage[];
  attachments: AttachmentRef[];
  canMessage: { allowed: boolean; effect: string };
};

export type NewTaskInput = {
  title: string;
  body: string;
  attachmentIds?: string[];
  baseBranch?: string;
  type?: import("./task-types.ts").TaskType;
  /** Review tasks: the branch with the work to continue. A branch under the project's prefix is continued as is; any other gets a new agent branch that starts from it. */
  startFrom?: string;
};

export type TaskTypeUpdate = { type: import("./task-types.ts").TaskType | null };

export type NewTaskResponse = { task: TaskListItem };

export type SendMessageInput = { text: string; attachmentIds?: string[] };

export type SendMessageResponse = { message: OperatorMessage; effect: string };

export type UploadResponse = { attachment: AttachmentRef };

export const PROJECT_ROUTES = {
  projects: "/api/projects",
  project: (id: string) => `/api/projects/${encodeURIComponent(id)}`,
  tasks: (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/tasks`,
  task: (projectId: string, taskId: string) => `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`,
  messages: (projectId: string, taskId: string) =>
    `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/messages`,
  taskType: (projectId: string, taskId: string) => `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/type`,
  uploads: "/api/uploads",
  upload: (id: string) => `/api/uploads/${encodeURIComponent(id)}`,
} as const;
