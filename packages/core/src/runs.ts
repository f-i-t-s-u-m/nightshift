export const RUN_PHASES = [
  "claimed",
  "preparing",
  "working",
  "checking",
  "reviewing",
  "pushing",
  "waiting_ci",
  "fixing",
  "needs_info",
  "ready_for_review",
  "done",
  "failed",
  "stopped",
] as const;

export type RunPhase = (typeof RUN_PHASES)[number];

export const ACTIVE_PHASES: readonly RunPhase[] = ["claimed", "preparing", "working", "checking", "reviewing", "pushing", "fixing"];
export const WAITING_PHASES: readonly RunPhase[] = ["waiting_ci", "needs_info"];
export const FINAL_PHASES: readonly RunPhase[] = ["ready_for_review", "done", "failed", "stopped"];

export const isActivePhase = (phase: RunPhase) => ACTIVE_PHASES.includes(phase);
export const isFinalPhase = (phase: RunPhase) => FINAL_PHASES.includes(phase);

export type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
};

export const emptyUsage = (): UsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
});

export const addUsage = (a: UsageTotals, b: UsageTotals): UsageTotals => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  costUsd: a.costUsd + b.costUsd,
});

export const totalTokens = (u: UsageTotals) => u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;

export const budgetTokens = (u: UsageTotals) => u.inputTokens + u.outputTokens + u.cacheWriteTokens;

export type ModelUsage = Record<string, UsageTotals>;

export type Run = {
  id: string;
  projectId: string;
  taskId: string;
  taskTitle: string;
  source: string;
  slot: number | null;
  phase: RunPhase;
  paused: boolean;
  branch: string;
  baseBranch: string | null;
  worktree: string;
  conversationId: string | null;
  prNumber: number | null;
  prUrl: string | null;
  headSha: string | null;
  fixRounds: number;
  leaseId: string | null;
  leaseExpiresAt: string | null;
  lastCommentSeenAt: string | null;
  activity: string | null;
  error: string | null;
  usage: UsageTotals;
  model: string;
  createdAt: string;
  updatedAt: string;
};

/** The last check of a run's PR while it waits on CI or review: what Nightshift saw and when it looks again. */
export type PrWatch = {
  checkedAt: string;
  nextAt: string;
  /** e.g. "PR #12: CI 3 passed, 1 pending · no new review comments · waiting for CI". */
  line: string;
  /** False when the check itself failed (e.g. GitHub unreachable). */
  ok: boolean;
};

export type RunEventType =
  | "phase"
  | "info"
  | "tool"
  | "agent"
  | "ci"
  | "review"
  | "comment"
  | "question"
  | "answer"
  | "pr"
  | "error"
  | "budget"
  | "plan";

export type RunEvent = {
  id: number;
  runId: string;
  at: string;
  type: RunEventType;
  message: string;
  data?: unknown;
};

export type AgentActivity = {
  busy: boolean;
  tool: string | null;
  detail: string | null;
  lastText: string | null;
};

export type AgentCreate = {
  runId: string;
  cwd: string;
  instructions: string;
  model?: { provider: string; modelId: string };
};

export type AgentSettled = {
  status: "done" | "unanswered";
  reason?: string;
  answer: string | null;
  terminated: boolean;
};

export type AgentImage = { data: string; mimeType: string };

export type AgentMessage = {
  text: string;
  images?: AgentImage[];
  author: "task" | "operator" | "answer" | "feedback" | "system";
  attachments?: Array<{ id: string; name: string; mimeType: string; size: number; url: string }>;
};

export interface AgentRunner {
  create(input: AgentCreate): Promise<string>;
  ask(conversationId: string, message: AgentMessage, requestId: string, mode?: "steer" | "followUp"): Promise<AgentSettled>;
  abort(conversationId: string): Promise<void>;
  activity(conversationId: string): Promise<AgentActivity>;
  usage(conversationId: string): Promise<ModelUsage>;
  transcript(conversationId: string, limit?: number): Promise<import("./projects.ts").TranscriptItem[]>;
  close(): Promise<void>;
}
