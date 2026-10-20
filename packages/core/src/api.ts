import type { ModelUsage, Run, RunEvent, UsageTotals } from "./runs.ts";

export type SlotView = {
  slot: number;
  runId: string | null;
  taskId: string | null;
  taskTitle: string | null;
  phase: string | null;
  activity: string | null;
  startedAt: string | null;
};

export type Billing = "subscription" | "api" | "none";

export type StatusResponse = {
  billing: Record<string, Billing>;
  version: string;
  startedAt: string;
  source: { name: string; connected: boolean; lastPollAt: string | null; lastError: string | null };
  killSwitch: boolean;
  slots: SlotView[];
  counts: Record<string, number>;
  usageToday: UsageTotals;
  budgets: { perDayUsd: number; perRunUsd: number; perRunTokens: number };
  model: string;
};

export type RunsResponse = { runs: Run[] };

export type RunDetailResponse = { run: Run; events: RunEvent[]; modelUsage: ModelUsage };

export type UsageDay = { day: string; model: string; usage: UsageTotals };

export type UsageResponse = {
  billing: Record<string, Billing>;
  today: UsageTotals;
  days: UsageDay[];
  byRun: Array<{ runId: string; projectId: string; taskId: string; taskTitle: string; usage: UsageTotals }>;
  byModel: ModelUsage;
};

export type ControlAction = "pause" | "resume" | "stop" | "retry";

export type ServerEvent =
  | { type: "status"; status: StatusResponse }
  | { type: "run"; run: Run }
  | { type: "event"; event: RunEvent }
  | { type: "task"; projectId: string; taskId: string }
  | { type: "projects" };

export const API_ROUTES = {
  status: "/api/status",
  runs: "/api/runs",
  run: (id: string) => `/api/runs/${encodeURIComponent(id)}`,
  control: (id: string, action: ControlAction) => `/api/runs/${encodeURIComponent(id)}/${action}`,
  usage: "/api/usage",
  killSwitch: "/api/kill-switch",
  settings: "/api/settings",
  events: "/api/events",
} as const;

export type RunLimits = { perRunUsd: number; perRunTokens: number; perDayUsd: number; maxFixRounds: number; maxRunMinutes: number };

export type LimitsResponse = { limits: RunLimits; defaults: RunLimits };
