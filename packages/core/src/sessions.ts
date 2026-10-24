/** "worker": a team worker's conversation (team mode), in its own worktree. */
export type SessionReason = "start" | "fresh" | "handoff" | "retry" | "worker";

export type TaskSession = {
  id: string;
  runId: string;
  index: number;
  label: string;
  reason: SessionReason;
  createdAt: string;
  active: boolean;
  model: string;
  contextTokens: number | null;
  contextWindow: number | null;
  turns: number;
  summary: string | null;
};

export type SessionsResponse = {
  sessions: TaskSession[];
  canStartNew: { allowed: boolean; reason: string | null };
};

export type NewSessionInput = {
  mode: "fresh" | "handoff" | "compact";
  note?: string;
};

export type NewSessionResponse = { session: TaskSession | null; effect: string };

export type Branch = { name: string; sha: string; isDefault: boolean };

export type BranchesResponse = { branches: Branch[]; defaultBranch: string; total: number; error: string | null };

export const SESSION_ROUTES = {
  sessions: (p: string, t: string) => `/api/projects/${encodeURIComponent(p)}/tasks/${encodeURIComponent(t)}/sessions`,
  taskSession: (p: string, t: string, sessionId: string) =>
    `/api/projects/${encodeURIComponent(p)}/tasks/${encodeURIComponent(t)}?session=${encodeURIComponent(sessionId)}`,
  branches: (p: string, q?: string) => `/api/projects/${encodeURIComponent(p)}/branches${q ? `?q=${encodeURIComponent(q)}` : ""}`,
} as const;
