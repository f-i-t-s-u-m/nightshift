export type CheckConfig = {
  name: string;
  command: string;
  timeoutMs?: number;
};

export type NightshiftConfig = {
  dataDir: string;
  workspacesDir: string;
  repo: {
    path: string;
    remote: string;
    baseBranch: string;
    branchPrefix: string;
    setup?: string;
  };
  slots: number;
  intervalsMs: {
    tasks: number;
    prs: number;
    leaseRenew: number;
    tick: number;
    ciGrace: number;
  };
  source: {
    type: "wondercall-mcp";
    url: string;
    tokenEnv: string;
  };
  model: {
    provider: string;
    modelId: string;
  };
  git: {
    host: "github" | "local";
    authorName: string;
    authorEmail: string;
  };
  budgets: {
    perRunUsd: number;
    perRunTokens: number;
    perDayUsd: number;
    maxFixRounds: number;
    maxRunMinutes: number;
  };
  checks: CheckConfig[];
  http: {
    host: string;
    port: number;
  };
};

export const defaultConfig = (home: string): NightshiftConfig => ({
  dataDir: `${home}/.nightshift`,
  workspacesDir: `${home}/.nightshift/workspaces`,
  repo: {
    path: "",
    remote: "origin",
    baseBranch: "main",
    branchPrefix: "nightshift/",
  },
  slots: 2,
  intervalsMs: {
    tasks: 60_000,
    prs: 180_000,
    leaseRenew: 60_000,
    tick: 2_000,
    ciGrace: 180_000,
  },
  source: {
    type: "wondercall-mcp",
    url: "http://127.0.0.1:8787/mcp",
    tokenEnv: "WONDERCALL_AGENT_TOKEN",
  },
  model: {
    provider: "anthropic",
    modelId: "claude-sonnet-5-5",
  },
  git: {
    host: "github",
    authorName: "",
    authorEmail: "",
  },
  budgets: {
    perRunUsd: 10,
    perRunTokens: 5_000_000,
    perDayUsd: 100,
    maxFixRounds: 5,
    maxRunMinutes: 240,
  },
  checks: [],
  http: {
    host: "127.0.0.1",
    port: 4777,
  },
});

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export function mergeConfig<T>(base: T, override: unknown): T {
  if (!isObject(base) || !isObject(override)) return (override === undefined ? base : override) as T;
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(override)) out[k] = isObject(v) && isObject(out[k]) ? mergeConfig(out[k], v) : v;
  return out as T;
}

export function validateConfig(config: NightshiftConfig): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(config.slots) || config.slots < 1) problems.push("slots must be a positive integer");
  if (!config.model.provider || !config.model.modelId) problems.push("model.provider and model.modelId are required");
  if (!["github", "local"].includes(config.git.host)) problems.push("git.host must be github or local");
  return problems;
}

export type CommitAuthor = { name: string; email: string; source: "config" | "git" | "github" | "default" };
