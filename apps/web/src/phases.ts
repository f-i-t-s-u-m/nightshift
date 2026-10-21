import type { Run, RunPhase, TaskStatus } from "@nightshift/core";
import type { Tone } from "@nightshift/ui";

export const PHASE_ORDER: readonly RunPhase[] = [
  "claimed",
  "preparing",
  "working",
  "checking",
  "reviewing",
  "pushing",
  "fixing",
  "waiting_ci",
  "needs_info",
  "ready_for_review",
  "done",
  "failed",
  "stopped",
];

const ACTIVE: readonly RunPhase[] = ["claimed", "preparing", "working", "checking", "reviewing", "pushing", "fixing"];
const FINAL: readonly RunPhase[] = ["ready_for_review", "done", "failed", "stopped"];

export const isActive = (phase: RunPhase) => ACTIVE.includes(phase);
export const isFinal = (phase: RunPhase) => FINAL.includes(phase);
export const isRetryable = (phase: RunPhase) => phase === "failed" || phase === "stopped";

export type ControlDef = {
  action: "pause" | "resume" | "stop" | "retry" | "complete";
  label: string;
  enabled: (run: Run) => boolean;
  danger?: boolean;
};

export const CONTROLS: readonly ControlDef[] = [
  { action: "pause", label: "Pause", enabled: (r) => !isFinal(r.phase) && !r.paused },
  { action: "resume", label: "Resume", enabled: (r) => r.paused },
  { action: "stop", label: "Stop", enabled: (r) => !isFinal(r.phase), danger: true },
  { action: "retry", label: "Retry", enabled: (r) => isRetryable(r.phase) },
  { action: "complete", label: "Mark as done", enabled: (r) => r.phase !== "done" },
];

export type StatusDef = { status: TaskStatus; label: string; tone: Tone };

export const TASK_STATUSES: readonly StatusDef[] = [
  { status: "ready_for_ai", label: "Ready for AI", tone: "neutral" },
  { status: "in_progress", label: "In progress", tone: "info" },
  { status: "needs_info", label: "Needs info", tone: "accent" },
  { status: "ready_for_review", label: "Ready for review", tone: "success" },
  { status: "done", label: "Done", tone: "muted" },
  { status: "failed", label: "Failed", tone: "danger" },
];

const FALLBACK: StatusDef = { status: "ready_for_ai", label: "Unknown", tone: "muted" };

export const statusDef = (status: string): StatusDef =>
  TASK_STATUSES.find((s) => s.status === status) ?? { ...FALLBACK, label: status.replace(/_/g, " ") };

export const EVENT_TONES: Record<string, Tone> = {
  phase: "info",
  info: "muted",
  tool: "neutral",
  agent: "neutral",
  ci: "warning",
  review: "accent",
  comment: "accent",
  question: "accent",
  answer: "accent",
  pr: "success",
  error: "danger",
  budget: "warning",
  plan: "accent",
};
