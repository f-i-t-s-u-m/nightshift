export type IssueSource = "check" | "review" | "external" | "ci" | "pr-comment";
export type IssueSeverity = "blocker" | "major" | "minor" | "info";
export type IssueStatus = "open" | "fixed" | "dismissed" | "needs_decision";

export type Issue = {
  id: string;
  runId: string;
  source: IssueSource;
  sourceName: string;
  title: string;
  detail: string;
  severity: IssueSeverity;
  file?: string;
  line?: number;
  status: IssueStatus;
  round: number;
  foundAt: string;
  resolvedAt?: string;
  fixedRound?: number;
  decisionId?: string;
};

export type DecisionKind = "agent-question" | "finding" | "loop-limit" | "plan" | "deletion" | "budget" | "push" | "setup";

export type Decision = {
  id: string;
  runId: string;
  kind: DecisionKind;
  question: string;
  context: string;
  options: string[];
  status: "open" | "answered" | "dismissed";
  answer?: string;
  askedAt: string;
  answeredAt?: string;
  source: string;
};

export type StepKind = "setup" | "agent" | "checks" | "review" | "external" | "ci" | "push";
export type StepStatus = "running" | "passed" | "failed" | "skipped" | "waiting";

export type VerificationStep = {
  id: string;
  round: number;
  kind: StepKind;
  title: string;
  status: StepStatus;
  startedAt: string;
  endedAt?: string;
  detail?: string;
  output?: string;
  testerId?: string;
  issueIds: string[];
};

export type TesterFormat = "nightshift-json" | "umbra" | "exit-code";
export type TesterWhen = "every-round" | "before-pr" | "manual";

export type TesterConfig = {
  id: string;
  name: string;
  command: string;
  format: TesterFormat;
  when: TesterWhen;
  blocking: boolean;
  enabled: boolean;
  timeoutMs?: number;
};

export type TesterPreset = Omit<TesterConfig, "id" | "enabled"> & { presetId: string; description: string };

export const TESTER_PRESETS: TesterPreset[] = [
  {
    presetId: "umbra-lite",
    name: "Umbra review (lite)",
    description:
      "Umbra's gate on the branch diff: findings verified against the code, blocking vs advisory, and claims it could not decide. Needs the `umbra` command (bun link in the Umbra checkout) and a metered ANTHROPIC_API_KEY in Umbra (a Claude subscription does not cover the CLI).",
    command: 'umbra review "origin/$NIGHTSHIFT_BASE" HEAD "$NIGHTSHIFT_TASK" "$NIGHTSHIFT_WORKTREE" --lite',
    format: "umbra",
    when: "before-pr",
    blocking: true,
    timeoutMs: 30 * 60_000,
  },
  {
    presetId: "umbra-full",
    name: "Umbra review (full)",
    description: "Umbra's full gate with the judge and the executing ward. Slower and uses more of Umbra's budget.",
    command: 'umbra review "origin/$NIGHTSHIFT_BASE" HEAD "$NIGHTSHIFT_TASK" "$NIGHTSHIFT_WORKTREE" --exec',
    format: "umbra",
    when: "manual",
    blocking: true,
    timeoutMs: 60 * 60_000,
  },
  {
    presetId: "umbra-subscription",
    name: "Umbra review (subscription)",
    description:
      "Umbra's review on your Claude subscription, run by the Umbra server (path B): start it with `bun run serve` in the Umbra folder, with Docker running and the sandbox image built. One review at a time; a full review takes 20-60 minutes. Use --profile lite for a quicker pass.",
    command: '"$NIGHTSHIFT_NODE" "$NIGHTSHIFT_TESTERS/umbra-server.mjs" --profile full',
    format: "nightshift-json",
    when: "before-pr",
    blocking: true,
    timeoutMs: 75 * 60_000,
  },
  {
    presetId: "json",
    name: "Custom tester (JSON)",
    description:
      'Any command that prints {"summary": "...", "findings": [{"title", "detail", "severity": "blocker|major|minor|info", "file", "line", "decision": {"question", "options": []}}]} on stdout.',
    command: "./scripts/nightshift-test.sh",
    format: "nightshift-json",
    when: "every-round",
    blocking: true,
  },
  {
    presetId: "exit-code",
    name: "Command (pass/fail)",
    description: "Any command; a non-zero exit becomes one blocking finding with the end of its output (e2e suites, Playwright, Lighthouse budgets).",
    command: "npx playwright test",
    format: "exit-code",
    when: "before-pr",
    blocking: true,
  },
];

export type TriggerConfig = {
  prFeedback: { enabled: boolean };
  ciFailures: { enabled: boolean };
  githubIssues: { enabled: boolean; label: string };
};

export const DEFAULT_TRIGGERS: TriggerConfig = {
  prFeedback: { enabled: true },
  ciFailures: { enabled: true },
  githubIssues: { enabled: false, label: "nightshift" },
};

export type TaskOriginKind = "manual" | "github-issue" | "pr-feedback" | "ci-failure";

export type TaskOrigin = { kind: TaskOriginKind; ref?: string; url?: string; branch?: string };

export type TriggerEvent = {
  id: string;
  projectId: string;
  kind: Exclude<TaskOriginKind, "manual">;
  at: string;
  ref: string;
  url?: string;
  taskId: string | null;
  note: string;
};

export type VerificationResponse = {
  runId: string | null;
  round: number;
  steps: VerificationStep[];
  issues: Issue[];
  decisions: Decision[];
  testers: TesterConfig[];
};

export type TriggersResponse = { triggers: TriggerConfig; events: TriggerEvent[]; supported: { githubIssues: boolean } };

export const VERIFY_ROUTES = {
  verification: (p: string, t: string) => `/api/projects/${encodeURIComponent(p)}/tasks/${encodeURIComponent(t)}/verification`,
  decision: (p: string, t: string, id: string) =>
    `/api/projects/${encodeURIComponent(p)}/tasks/${encodeURIComponent(t)}/decisions/${encodeURIComponent(id)}`,
  issue: (p: string, t: string, id: string) => `/api/projects/${encodeURIComponent(p)}/tasks/${encodeURIComponent(t)}/issues/${encodeURIComponent(id)}`,
  runTester: (p: string, t: string, testerId: string) =>
    `/api/projects/${encodeURIComponent(p)}/tasks/${encodeURIComponent(t)}/testers/${encodeURIComponent(testerId)}/run`,
  triggers: (p: string) => `/api/projects/${encodeURIComponent(p)}/triggers`,
} as const;
