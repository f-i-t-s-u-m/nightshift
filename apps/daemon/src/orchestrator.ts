import { EventEmitter } from "node:events";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addUsage,
  budgetTokens,
  emptyUsage,
  isActivePhase,
  type AgentMessage,
  type AgentRunner,
  type AttachmentRef,
  type Lease,
  type NewProjectInput,
  type NewTaskInput,
  type NightshiftConfig,
  type OperatorMessage,
  type ProjectSummary,
  type ProjectTasksResponse,
  type Run,
  type RunEventType,
  type ServerEvent,
  type SlotView,
  type StatusResponse,
  type TaskComment,
  type TaskListItem,
  type TaskStatus,
  type TaskViewResponse,
  type TranscriptAuthor,
  type UsageTotals,
  type TaskType,
  type TaskPreviewSummary,
  type Project,
  isTaskType,
  taskTypeInfo,
  TASK_ID_PATTERN,
  taskPrefixOf,
  type GithubRepoInput,
  type MoveToGithubResult,
} from "@nightshift/core";
import { LocalPrHost, run as exec, summarizeChecks } from "@nightshift/git";
import type { RunBridge, RunContext } from "@nightshift/runner-pi";
import type { Store, StoredMessage } from "@nightshift/store";
import { applyProjectUpdate, buildContext, seedProjectFromConfig, validateNewProject, type ProjectContext } from "./projects.ts";
import { OnboardingService, type Summarize } from "./onboarding/service.ts";
import { inspectRepository } from "./onboarding/inspect.ts";
import type { ProjectUpdate, ScaffoldInput } from "@nightshift/core";
import { WorkspaceService } from "./workspace/service.ts";
import { SHARED } from "./workspace/preview.ts";
import { VerificationLog } from "./verification/log.ts";
import { parseReviewAnswer, parseTesterOutput, type Finding } from "./verification/parsers.ts";
import { DEFAULT_TRIGGERS, type Decision, type Issue, type TaskOrigin, type TesterConfig, type TriggerConfig, type TriggerEvent } from "@nightshift/core";
import { SkillsService, skillsSection } from "./skills/service.ts";
import { syncLocalFiles } from "./workspace/local-files.ts";
import { diagnoseSetup, lastError, tailLines } from "./workspace/setup-ai.ts";
import { commitAuthor } from "./identity.ts";
import { createRepo, ensureReady, GithubError, pushHint, pushUrl, repoUrls, setDefaultBranch, tail, validateRepoInput } from "./github.ts";
import { answerPrompt, feedbackPrompt, instructions, localChecksPrompt, operatorNotes, prBody, taskPrompt } from "./prompts.ts";

type Pending = { requestId: string; text: string; author: TranscriptAuthor; attachmentIds: string[]; messageIds?: string[] };

type PiExtras = {
  note(conversationId: string, message: AgentMessage, requestId: string, messageIds: string[]): Promise<void>;
  seen(conversationId: string, messageId: string): Promise<boolean | null>;
  plan(conversationId: string, message: AgentMessage, requestId: string): Promise<{ status: string; answer: string | null; terminated: boolean; reason?: string }>;
  createReviewer(input: { cwd: string; instructions: string; model?: { provider: string; modelId: string } }): Promise<string>;
  ask(conversationId: string, message: AgentMessage, requestId: string, mode?: "steer" | "followUp", messageIds?: string[]): Promise<{ status: string; answer: string | null; terminated: boolean; reason?: string }>;
  health(): Promise<{ blocked: string[]; tasks: number }>;
  contextStats(conversationId: string): Promise<{ tokens: number | null; turns: number }>;
  compact(conversationId: string, instructions: string): Promise<void>;
};

type SessionRecord = { id: string; createdAt: string; reason: import("@nightshift/core").SessionReason; summary: string | null; model: string };

const REVIEW_PASS = "NO FURTHER FINDINGS";
const MAX_REVIEW_ROUNDS = 2;

const VERSION = "0.2.0";
const WORKING = new Set(["working", "fixing"]);
const TESTERS_DIR = fileURLToPath(new URL("../testers/", import.meta.url)).replace(/\/$/, "");
type TesterQueue = { holder: string | null; waiters: Array<{ label: string; onWait: (holder: string, ahead: number) => void; grant: () => void }> };
const REJECT_PUSH = /^((don'?t|do not) push( yet)?|not yet)[.!]?$/i;
const TASK_CACHE_MS = 3000;

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "task";

export type OrchestratorDeps = {
  summarize?: Summarize;
  modelSettings?: () => import("@nightshift/core").ModelSettings;
  modelExists?: (choice: import("@nightshift/core").ModelChoice) => boolean;
  contextWindowOf?: (modelLabel: string) => number | null;
  billing?: () => Record<string, import("@nightshift/core").Billing>;
  config: NightshiftConfig;
  store: Store;
  modelLabel: string;
  log?: (line: string) => void;
};

export class Orchestrator {
  readonly emitter = new EventEmitter();
  runner!: AgentRunner;
  readonly projects = new Map<string, ProjectContext>();
  private readonly driving = new Set<string>();
  private readonly inflight = new Map<string, Set<Promise<unknown>>>();
  private readonly leases = new Map<string, Lease>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private lastTaskPoll = 0;
  private lastPrPoll = 0;
  private lastLeaseRenew = 0;
  private lastAnswerPoll = 0;
  private lastTriggerPoll = 0;
  private readonly startedAt = new Date().toISOString();
  private stopping = false;
  private port = 0;
  readonly workspace: WorkspaceService;
  readonly onboarding: OnboardingService;
  readonly vlog: VerificationLog;
  readonly skills: SkillsService;

  constructor(private readonly deps: OrchestratorDeps) {
    this.emitter.setMaxListeners(100);
    this.skills = new SkillsService(deps.config, deps.store);
    this.vlog = new VerificationLog(deps.store, (runId) => {
      const r = deps.store.getRun(runId);
      if (r) this.touchTask(r.projectId, r.taskId);
    });
    this.onboarding = new OnboardingService(deps.config, deps.summarize ?? (async () => {
      throw new Error("No model is configured for summaries");
    }));
    this.workspace = new WorkspaceService({
      config: deps.config,
      store: deps.store,
      project: (id) => this.ctx(id).project,
      worktreeFor: (projectId, taskId) => this.store.latestRunForTask(projectId, taskId)?.worktree ?? this.ctx(projectId).workspaces.pathFor(taskId),
      agentBusy: (projectId, taskId) => {
        const run = this.store.latestRunForTask(projectId, taskId);
        return Boolean(run && !run.paused && isActivePhase(run.phase));
      },
      latestRun: (projectId, taskId) => this.store.latestRunForTask(projectId, taskId),
      onChange: (projectId, taskId) => this.touchTask(projectId, taskId),
      daemonPort: () => this.port,
      ai: () => this.deps.summarize ?? null,
      savePreview: async (projectId, preview) => {
        await this.updateProject(projectId, { preview });
      },
    });
  }

  modelFor(project: { model?: import("@nightshift/core").ModelChoice }) {
    return project.model ?? this.deps.modelSettings?.().default ?? this.config.model;
  }

  reviewModelFor(project: { model?: import("@nightshift/core").ModelChoice; reviewModel?: import("@nightshift/core").ModelChoice }) {
    return project.reviewModel ?? this.deps.modelSettings?.().review ?? this.modelFor(project);
  }

  private label(choice: { provider: string; modelId: string }) {
    return `${choice.provider}/${choice.modelId}`;
  }

  private projectFor(projectId: string): Project | undefined {
    return this.projects.get(projectId)?.project ?? this.store.getProject(projectId) ?? undefined;
  }

  previewSummary(projectId: string, taskId: string): TaskPreviewSummary | null {
    const project = this.ctx(projectId).project;
    if (!project.preview?.command && !project.preview?.services?.length) return null;
    const all = this.workspace.previews.info(projectId, taskId, project.preview);
    const info = { ...all, services: all.services.filter((s) => !s.shared) };
    if (!info.services.some((s) => s.startedAt)) return null;
    const count = (st: string) => info.services.filter((s) => s.status === st).length;
    return {
      total: info.services.length,
      running: count("running"),
      starting: count("starting") + (info.installing ? 1 : 0),
      failed: count("failed"),
      url: info.url,
      services: info.services.map((s) => ({ name: s.name, status: s.status, url: s.url })),
    };
  }

  taskTypeOf(projectId: string, taskId: string): TaskType | null {
    const stored = this.store.setting<TaskType | null>(`taskType:${projectId}/${taskId}`, null);
    if (isTaskType(stored)) return stored;
    return this.originOf(projectId, taskId).kind === "ci-failure" ? "bug" : null;
  }

  setTaskType(projectId: string, taskId: string, type: TaskType | null): { type: TaskType | null } {
    this.ctx(projectId);
    if (type !== null && !isTaskType(type)) throw new Error("Unknown task type");
    this.store.setSetting(`taskType:${projectId}/${taskId}`, type);
    const run = this.store.latestRunForTask(projectId, taskId);
    if (run) this.event(run.id, "info", `Task type set to ${taskTypeInfo(type)?.label ?? "none"}`);
    this.touchTask(projectId, taskId);
    return { type: this.taskTypeOf(projectId, taskId) };
  }

  taskGuide(projectId: string, taskId: string): string | undefined {
    const info = taskTypeInfo(this.taskTypeOf(projectId, taskId));
    if (!info) return undefined;
    const meta = this.taskMeta(projectId, taskId);
    const earlier = meta?.startFrom ?? meta?.continueBranch;
    return [
      `This task is a ${info.label.toLowerCase()}: ${info.description}`,
      ...(info.type === "review" && earlier ? [`The earlier work is on branch ${earlier}; your workspace starts from its latest commit.`] : []),
      "Work this way:",
      ...info.guidance.map((g) => `- ${g}`),
    ].join("\n");
  }

  private taskMeta(projectId: string, taskId: string) {
    return this.store.setting<{ origin?: TaskOrigin; continueBranch?: string; startFrom?: string } | null>(`taskMeta:${projectId}/${taskId}`, null);
  }

  originOf(projectId: string, taskId: string): TaskOrigin {
    return this.taskMeta(projectId, taskId)?.origin ?? { kind: "manual" };
  }

  triggersOf(project: { triggers?: TriggerConfig }): TriggerConfig {
    const t = project.triggers;
    return {
      prFeedback: { enabled: t?.prFeedback?.enabled ?? DEFAULT_TRIGGERS.prFeedback.enabled },
      ciFailures: { enabled: t?.ciFailures?.enabled ?? DEFAULT_TRIGGERS.ciFailures.enabled },
      githubIssues: { enabled: t?.githubIssues?.enabled ?? DEFAULT_TRIGGERS.githubIssues.enabled, label: t?.githubIssues?.label?.trim() || DEFAULT_TRIGGERS.githubIssues.label },
    };
  }

  private triggerEvent(projectId: string, input: Omit<TriggerEvent, "id" | "projectId" | "at">) {
    const list = this.store.setting<TriggerEvent[]>(`triggerEvents:${projectId}`, []);
    list.unshift({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, projectId, at: new Date().toISOString(), ...input });
    this.store.setSetting(`triggerEvents:${projectId}`, list.slice(0, 100));
  }

  triggerView(projectId: string): import("@nightshift/core").TriggersResponse {
    const ctx = this.ctx(projectId);
    return { triggers: this.triggersOf(ctx.project), events: this.store.setting<TriggerEvent[]>(`triggerEvents:${projectId}`, []), supported: { githubIssues: ctx.project.gitHost === "github" } };
  }

  async setTriggers(projectId: string, triggers: TriggerConfig) {
    await this.updateProject(projectId, { triggers: this.triggersOf({ triggers }) });
    this.lastTriggerPoll = 0;
    return this.triggerView(projectId);
  }

  private async watchTriggers() {
    for (const ctx of this.projects.values()) {
      if (ctx.project.paused) continue;
      const t = this.triggersOf(ctx.project);
      try {
        if (t.prFeedback.enabled || t.ciFailures.enabled) await this.watchAgentPrs(ctx, t);
        if (t.githubIssues.enabled && ctx.project.gitHost === "github") await this.watchIssues(ctx, t.githubIssues.label);
      } catch (error) {
        this.log(`triggers ${ctx.project.id}: ${String(error)}`);
      }
    }
  }

  private activeTaskForBranch(projectId: string, branch: string): boolean {
    return this.store.runsForProject(projectId).some((r) => r.branch === branch && !["done", "failed", "stopped"].includes(r.phase));
  }

  private async pendingTriggeredTask(projectId: string, branch: string): Promise<boolean> {
    const ctx = this.ctx(projectId);
    const tasks = await ctx.source.listTasks().catch(() => []);
    return tasks.some((task) => {
      const meta = this.store.setting<{ continueBranch?: string } | null>(`taskMeta:${projectId}/${task.id}`, null);
      return meta?.continueBranch === branch && !["done", "failed"].includes(task.status) && !this.store.latestRunForTask(projectId, task.id);
    });
  }

  private async watchAgentPrs(ctx: ProjectContext, t: TriggerConfig) {
    const prs = (await ctx.prHost.listOpen()).filter((p) => p.branch.startsWith(ctx.project.repo.branchPrefix));
    for (const pr of prs) {
      if (this.activeTaskForBranch(ctx.project.id, pr.branch)) continue;
      const key = `trig:${ctx.project.id}:pr:${pr.number}`;
      const status = await ctx.prHost.status(pr.number);
      const latest = [...status.comments.map((c) => c.createdAt), ...status.reviews.map((r) => r.submittedAt)].sort().at(-1) ?? "";
      let state = this.store.setting<{ seenAt: string; ciSha: string | null } | null>(key, null);
      if (!state) {
        state = { seenAt: latest, ciSha: null };
        this.store.setSetting(key, state);
      }
      if (await this.pendingTriggeredTask(ctx.project.id, pr.branch)) continue;
      const lastRun = this.store.runsForProject(ctx.project.id).find((r) => r.branch === pr.branch);
      const title = lastRun?.taskTitle ?? pr.branch.replace(ctx.project.repo.branchPrefix, "");
      const live = this.triggersOf(this.projects.get(ctx.project.id)?.project ?? ctx.project);
      if (t.prFeedback.enabled && live.prFeedback.enabled) {
        const reviews = status.reviews.filter((r) => r.submittedAt > state.seenAt && (r.state === "CHANGES_REQUESTED" || (r.body ?? "").trim()));
        const comments = status.comments.filter((c) => c.createdAt > state.seenAt);
        if (reviews.length || comments.length) {
          const feedback = [
            ...reviews.map((r) => `- ${r.author} (${r.state}): ${r.body || "(no text)"}`),
            ...comments.map((c) => `- ${c.author}${c.path ? ` on ${c.path}${c.line ? `:${c.line}` : ""}` : ""}: ${c.body}`),
          ].join("\n");
          const item = await this.createTask(
            ctx.project.id,
            { title: `Address review feedback on PR #${pr.number}: ${title}`.slice(0, 200), body: `New feedback on ${pr.url} (branch ${pr.branch}). Address it on the same branch.\n\n${feedback}`, baseBranch: pr.base !== ctx.project.repo.baseBranch ? pr.base : undefined },
            { origin: { kind: "pr-feedback", ref: `PR #${pr.number}`, url: pr.url, branch: pr.branch }, continueBranch: pr.branch },
          );
          this.store.setSetting(key, { ...state, seenAt: latest });
          this.triggerEvent(ctx.project.id, { kind: "pr-feedback", ref: `PR #${pr.number}`, url: pr.url, taskId: item.id, note: `${reviews.length + comments.length} new review item(s) → new task` });
          continue;
        }
      }
      if (t.ciFailures.enabled && live.ciFailures.enabled && summarizeChecks(status.checks) === "failure" && status.headSha && state.ciSha !== status.headSha) {
        const failing = status.checks.filter((c) => c.state === "failure");
        const logs = await Promise.all(failing.map(async (c) => `### ${c.name}\n${(await ctx.prHost.failureLog(c).catch(() => null)) ?? c.detailsUrl ?? ""}`));
        const item = await this.createTask(
          ctx.project.id,
          { title: `Fix failing CI on PR #${pr.number}: ${title}`.slice(0, 200), body: `CI fails on ${pr.url} (branch ${pr.branch}, ${status.headSha.slice(0, 8)}). Fix it on the same branch.\n\n${logs.join("\n\n")}`, baseBranch: pr.base !== ctx.project.repo.baseBranch ? pr.base : undefined },
          { origin: { kind: "ci-failure", ref: `PR #${pr.number}`, url: pr.url, branch: pr.branch }, continueBranch: pr.branch },
        );
        this.store.setSetting(key, { ...state, ciSha: status.headSha });
        this.triggerEvent(ctx.project.id, { kind: "ci-failure", ref: `PR #${pr.number}`, url: pr.url, taskId: item.id, note: `${failing.map((f) => f.name).join(", ")} failing → new task` });
      }
    }
  }

  private async watchIssues(ctx: ProjectContext, label: string) {
    const { GithubPrHost } = await import("@nightshift/git");
    const issues = await new GithubPrHost(ctx.project.repo.path).issues(label);
    for (const issue of issues) {
      if (!this.triggersOf(this.projects.get(ctx.project.id)?.project ?? ctx.project).githubIssues.enabled) return;
      const key = `trig:${ctx.project.id}:issue:${issue.number}`;
      if (this.store.setting<string | null>(key, null)) continue;
      const item = await this.createTask(
        ctx.project.id,
        { title: issue.title.slice(0, 200), body: `${issue.body ?? ""}\n\nFrom GitHub issue ${issue.url}` },
        { origin: { kind: "github-issue", ref: `Issue #${issue.number}`, url: issue.url } },
      );
      this.store.setSetting(key, item.id);
      this.triggerEvent(ctx.project.id, { kind: "github-issue", ref: `Issue #${issue.number}`, url: issue.url, taskId: item.id, note: `Labelled "${label}" → new task` });
    }
  }

  verificationView(projectId: string, taskId: string): import("@nightshift/core").VerificationResponse {
    const ctx = this.ctx(projectId);
    const run = this.store.latestRunForTask(projectId, taskId);
    const doc = run ? this.vlog.doc(run.id) : { round: 0, steps: [], issues: [], decisions: [] };
    return { runId: run?.id ?? null, round: doc.round, steps: doc.steps, issues: doc.issues, decisions: doc.decisions, testers: ctx.project.testers ?? [] };
  }

  setIssueStatus(projectId: string, taskId: string, issueId: string, status: "dismissed" | "open") {
    const run = this.store.latestRunForTask(projectId, taskId);
    if (!run) throw Object.assign(new Error("No run for this task"), { status: 404 });
    const issue = this.vlog.setIssueStatus(run.id, issueId, status);
    if (!issue) throw Object.assign(new Error("Issue not found"), { status: 404 });
    this.event(run.id, "info", `${status === "dismissed" ? "Dismissed" : "Reopened"}: ${issue.title}`);
    return issue;
  }

  async answerDecision(projectId: string, taskId: string, decisionId: string, answer: string): Promise<{ decision: Decision; effect: string }> {
    const run = this.store.latestRunForTask(projectId, taskId);
    if (!run) throw Object.assign(new Error("No run for this task"), { status: 404 });
    const text = answer.trim();
    if (!text) throw new Error("Choose an option or write an answer");
    const decision = this.vlog.answerDecision(run.id, decisionId, text);
    if (!decision) throw Object.assign(new Error("This decision is not open"), { status: 409 });
    this.event(run.id, "answer", `${decision.question}\n→ ${text}`);
    if (decision.kind === "finding" && /^(ignore|won'?t|dismiss|no\b)/i.test(text)) {
      for (const i of this.vlog.openIssues(run.id)) if (i.sourceName === decision.source && !i.decisionId) this.vlog.setIssueStatus(run.id, i.id, "dismissed");
    }
    await this.comment(run.id, `decision-answer:${decision.id}`, `Decision: ${decision.question}\n→ ${text}`).catch(() => {});
    if (this.vlog.openDecisions(run.id).length) return { decision, effect: "Recorded. Other decisions are still open." };
    if (decision.kind === "setup") {
      const fix = this.store.setting<{ command: string | null; failed: string; output: string } | null>(`setupFix:${run.id}`, null);
      if (/^stop/i.test(text)) {
        await this.control(run.id, "stop");
        return { decision, effect: "The task was stopped." };
      }
      if (/^apply/i.test(text) && fix?.command) {
        await this.updateProject(run.projectId, { repo: { setup: fix.command } });
        this.event(run.id, "info", `Setup command changed to: ${fix.command}`);
        return { decision, effect: this.resumePreparing(run) };
      }
      this.store.setSetting(`setupSkip:${run.id}`, true);
      if (!/^skip/i.test(text)) {
        const extra = /^ask the agent/i.test(text) ? "" : `\nThe task owner says: ${text}`;
        this.store.setSetting(
          `setupNote:${run.id}`,
          `Nightshift's workspace setup command failed, so it was skipped:\n\`${fix?.failed ?? ""}\`\n\nLast output:\n\`\`\`\n${fix?.output.slice(-1500) ?? ""}\n\`\`\`\nBefore working on the task, make the workspace usable (install dependencies, generate clients) with commands in your shell. Do not change product code just to make setup pass, and say in your summary which setup command works so the owner can save it.${extra}`,
        );
      }
      return { decision, effect: this.resumePreparing(run) };
    }
    if (decision.kind === "push") {
      if (/^push/i.test(text)) {
        const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: run.worktree })).stdout.trim();
        this.store.setSetting(`pushApproved:${run.id}`, head);
        return { decision, effect: this.resumeAt(run, "pushing", null) };
      }
      if (REJECT_PUSH.test(text)) {
        this.update(run.id, { activity: "Not pushed: waiting for your message" });
        return { decision, effect: "Nothing was pushed. The work stays committed on this Mac; send the agent a message with what to change, and it asks again before the next push." };
      }
      return {
        decision,
        effect: this.resumeAt(run, "fixing", {
          requestId: `${run.id}:push-notyet:${decision.id}`,
          author: "answer",
          text: `The task owner reviewed your committed work before pushing and asked for changes:\n${text}\nMake them, run the checks, then reply with your updated summary.`,
          attachmentIds: [],
        }),
      };
    }
    if (decision.kind === "budget") {
      if (/^stop/i.test(text)) {
        this.store.setSetting(`budgetHold:${run.id}`, false);
        await this.control(run.id, "stop");
        return { decision, effect: "The task was stopped." };
      }
      this.grantBudget(run);
      const note = /^continue with another budget$/i.test(text) ? "" : `\nThe task owner added: ${text}`;
      return {
        decision,
        effect: this.resumeAt(run, "fixing", {
          requestId: `${run.id}:budget-ok:${decision.id}`,
          author: "answer",
          text: `Nightshift paused you because this task reached its budget, and the task owner approved more. Continue from where you stopped; check git status and git diff first if you are unsure what was saved.${note}`,
          attachmentIds: [],
        }),
      };
    }
    if (decision.kind === "deletion") {
      const files = this.store.setting<string[]>(`pendingDeletes:${run.id}`, []);
      if (/^allow/i.test(text)) {
        this.store.setSetting(`approvedDeletes:${run.id}`, [...new Set([...this.store.setting<string[]>(`approvedDeletes:${run.id}`, []), ...files])]);
        return { decision, effect: this.resumeAt(run, "fixing", { requestId: `${run.id}:deletes-ok:${decision.id}`, author: "answer", text: `The task owner approved deleting these files:\n${files.map((f) => `- ${f}`).join("\n")}\nContinue, run the checks, then reply with your summary.`, attachmentIds: [] }) };
      }
      const ref = this.store.setting<string | null>(`deleteRef:${run.id}`, null);
      if (ref && files.length) await exec("git", ["checkout", ref, "--", ...files], { cwd: run.worktree });
      this.store.setSetting(`rejectedDeletes:${run.id}`, [...new Set([...this.store.setting<string[]>(`rejectedDeletes:${run.id}`, []), ...files])]);
      const note = /^restore the files$/i.test(text) ? "" : `\nThe task owner says: ${text}`;
      return {
        decision,
        effect: this.resumeAt(run, "fixing", {
          requestId: `${run.id}:deletes-restored:${decision.id}`,
          author: "answer",
          text: `The task owner did NOT approve deleting files. These were restored and must stay:\n${files.map((f) => `- ${f}`).join("\n")}\nDo not delete them again: Nightshift restores them without asking if you do. If you think something must be removed, ask with ask_question first. Continue, run the checks, then reply with your summary.${note}`,
          attachmentIds: [],
        }),
      };
    }
    if (decision.kind === "tester") {
      if (/^stop/i.test(text)) {
        await this.control(run.id, "stop");
        return { decision, effect: "The task was stopped." };
      }
      const ask = this.store.setting<{ testerId: string; head: string } | null>(`testerAsk:${run.id}`, null);
      if (/^skip/i.test(text) && ask) {
        this.store.setSetting(`testerSkip:${run.id}:${ask.testerId}`, ask.head);
        this.event(run.id, "info", `${decision.source} skipped by you for this change`);
        return { decision, effect: `${this.resumeAt(run, "reviewing", null)} ${decision.source} is skipped until the code changes.` };
      }
      return { decision, effect: this.resumeAt(run, "reviewing", null) };
    }
    if (decision.kind === "loop-limit") {
      if (/^stop/i.test(text)) {
        await this.control(run.id, "stop");
        return { decision, effect: "The task was stopped." };
      }
      if (/^open the pr/i.test(text)) {
        for (const i of this.vlog.openIssues(run.id)) this.vlog.setIssueStatus(run.id, i.id, "dismissed");
        return { decision, effect: this.resumeAt(run, "pushing", null) };
      }
      this.store.setSetting(`roundAllowance:${run.id}`, this.store.setting<number>(`roundAllowance:${run.id}`, 0) + 3);
    }
    const answered = this.vlog.doc(run.id).decisions.filter((d) => d.status === "answered" && d.answeredAt && d.answeredAt >= (run.lastCommentSeenAt ?? run.createdAt));
    const blocking = this.vlog.openBlocking(run.id);
    const text2 = [
      "Decisions from the task owner:",
      ...answered.map((d) => `- ${d.question}\n  → ${d.answer}`),
      "",
      blocking.length ? this.issuesPrompt(blocking) : "Apply these decisions, run the checks, then reply with your summary.",
    ].join("\n");
    if (!isActivePhase(run.phase) && run.phase !== "needs_info" && run.phase !== "waiting_ci" && run.phase !== "ready_for_review") return { decision, effect: "Recorded." };
    return { decision, effect: this.resumeAt(run, "fixing", { requestId: `${run.id}:decision:${decision.id}`, author: "answer", text: text2, attachmentIds: [] }) };
  }

  private resumeAt(run: Run, phase: "fixing" | "pushing" | "reviewing", pending: Pending | null): string {
    if (isActivePhase(run.phase) && run.phase !== "needs_info") {
      if (pending) this.store.setSetting(`sessionIntro:${run.id}`, pending.text);
      return "The agent picks this up after its current step.";
    }
    const slot = this.freeSlot();
    if (slot === null) {
      if (pending) {
        this.store.addTaskMessage(run.projectId, run.taskId, pending.text, []);
      }
      return "All agent slots are busy; the agent continues when one frees up.";
    }
    if (pending) this.setPending(run.id, pending);
    void this.setTaskStatus(run.id, "in_progress", `:resume:${Date.now()}`);
    this.update(run.id, { phase, slot, lastCommentSeenAt: new Date().toISOString(), activity: phase === "pushing" ? "Opening the PR" : phase === "reviewing" ? "Running the tests again" : "Continuing with your decision" });
    void this.drive(run.id);
    return phase === "pushing" ? "The agent opens the PR now." : phase === "reviewing" ? "The tests run again now." : "The agent continues now.";
  }

  async runTesterNow(projectId: string, taskId: string, testerId: string): Promise<{ stepId: string | null; effect: string }> {
    const ctx = this.ctx(projectId);
    const tester = (ctx.project.testers ?? []).find((t) => t.id === testerId);
    if (!tester) throw Object.assign(new Error("Tester not found"), { status: 404 });
    const run = this.store.latestRunForTask(projectId, taskId);
    if (!run || !this.workspace.info(projectId, taskId).exists) throw new Error("The agent has not created this task's workspace yet");
    void (async () => {
      const r = await this.runTester(run, tester);
      if (r.stopped) return;
      const fresh = this.store.getRun(run.id)!;
      if (r.decisions.length && !isActivePhase(fresh.phase)) await this.pauseForDecisions(fresh);
      else if (r.blocking.length && !isActivePhase(fresh.phase) && !["done", "failed", "stopped"].includes(fresh.phase)) {
        this.vlog.addDecision(run.id, {
          kind: "finding",
          question: `${tester.name} found ${r.blocking.length} blocking issue(s). Send them to the agent to fix?`,
          context: r.blocking.map((i) => `- ${i.title}`).join("\n"),
          options: ["Fix them", "Ignore them"],
          source: tester.name,
        });
        await this.pauseForDecisions(fresh);
      }
    })().catch((e) => this.log(`tester ${tester.name}: ${String(e)}`));
    return { stepId: null, effect: tester.queue ? `${tester.name} starts on the task's workspace when no other "${tester.queue}" tester runs.` : `${tester.name} is running on the task's workspace.` };
  }

  private ownerInstructions(run: Run): string {
    const messages = this.store.taskMessages(run.projectId, run.taskId).filter((m) => m.deliveredAt && m.text.trim());
    const decisions = this.store
      .runsForTask(run.projectId, run.taskId)
      .flatMap((r) => this.vlog.doc(r.id).decisions)
      .filter((d) => d.status === "answered" && d.answer);
    if (!messages.length && !decisions.length) return "";
    return [
      "",
      "",
      "## Instructions from the task owner after the task was written",
      "They override the task text above where they differ. Judge the change against them too.",
      ...messages.map((m) => `- ${m.text}`),
      ...decisions.map((d) => `- Decision: ${d.question} → ${d.answer}`),
    ].join("\n");
  }

  private async checkDeletions(run: Run): Promise<boolean> {
    const ctx = this.runCtx(run);
    const pushed = await ctx.workspaces.remoteHead(run.branch).catch(() => null);
    const ref = pushed ?? `${ctx.project.repo.remote}/${this.baseOf(run)}`;
    const res = await exec("git", ["diff", "--name-status", "-M", "--diff-filter=D", ref], { cwd: run.worktree });
    if (res.code !== 0) return false;
    const approved = new Set(this.store.setting<string[]>(`approvedDeletes:${run.id}`, []));
    const rejected = new Set(this.store.setting<string[]>(`rejectedDeletes:${run.id}`, []));
    const all = res.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("\t").slice(1).join("\t"))
      .filter((f) => f && !approved.has(f));
    // The owner already said no to these: put them back instead of asking again.
    const again = all.filter((f) => rejected.has(f));
    if (again.length && (await exec("git", ["checkout", ref, "--", ...again], { cwd: run.worktree })).code === 0) {
      this.event(run.id, "info", `Restored ${again.length} file(s) you had refused to delete: ${again.slice(0, 10).join(", ")}${again.length > 10 ? "…" : ""}`);
    }
    const deleted = all.filter((f) => !rejected.has(f));
    if (!deleted.length) return false;
    this.store.setSetting(`pendingDeletes:${run.id}`, deleted);
    this.store.setSetting(`deleteRef:${run.id}`, ref);
    const step = this.vlog.startStep(run.id, "checks", "Deleted files need your approval");
    this.vlog.finishStep(run.id, step, "waiting", { detail: `${deleted.length} file(s) deleted`, output: deleted.join("\n") });
    this.vlog.addDecision(run.id, {
      kind: "deletion",
      question: `The agent wants to delete ${deleted.length} file${deleted.length === 1 ? "" : "s"}. Allow it?`,
      context: `${deleted.slice(0, 60).map((f) => `- ${f}`).join("\n")}${deleted.length > 60 ? `\n…and ${deleted.length - 60} more` : ""}`,
      options: ["Allow the deletions", "Restore the files"],
      source: "Nightshift",
    });
    await this.pauseForDecisions(run);
    return true;
  }

  async workspaceSuggestions(projectId: string, taskId: string) {
    const ctx = this.ctx(projectId);
    const root = this.workspace.info(projectId, taskId).path;
    if (!root) throw Object.assign(new Error("No workspace yet: the agent creates it when it starts"), { status: 404 });
    const inspection = await inspectRepository(root);
    const p = ctx.project;
    const missing = {
      preview:
        inspection.suggested.preview && (!p.preview?.command || ((inspection.suggested.preview.services?.length ?? 0) > 1 && !p.preview.services?.length))
          ? inspection.suggested.preview
          : null,
      database: (!p.database || p.database.mode === "none") && inspection.suggested.database.mode !== "none" ? inspection.suggested.database : null,
      checks: inspection.suggested.checks.filter((c) => !p.checks.some((x) => x.name === c.name)),
      setup: !p.repo.setup && inspection.suggested.setup ? inspection.suggested.setup : null,
    };
    return { inspection, missing };
  }

  baseOf(run: Run) {
    return run.baseBranch ?? this.ctx(run.projectId).project.repo.baseBranch;
  }

  private branchCache = new Map<string, { at: number; list: Array<{ name: string; sha: string }> }>();

  async branches(projectId: string, q?: string): Promise<import("@nightshift/core").BranchesResponse> {
    const ctx = this.ctx(projectId);
    const def = ctx.project.repo.baseBranch;
    let error: string | null = null;
    let cached = this.branchCache.get(projectId);
    if (!cached || Date.now() - cached.at > 30_000) {
      try {
        cached = { at: Date.now(), list: await ctx.workspaces.listRemoteBranches() };
        this.branchCache.set(projectId, cached);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    const all = (cached?.list ?? [])
      .filter((b) => !q || b.name.toLowerCase().includes(q.toLowerCase()))
      .sort((a, b) => (a.name === def ? -1 : b.name === def ? 1 : a.name.localeCompare(b.name)));
    return { branches: all.slice(0, 200).map((b) => ({ ...b, isDefault: b.name === def })), defaultBranch: def, total: all.length, error };
  }

  private sessionRecords(run: Run): SessionRecord[] {
    const saved = this.store.setting<SessionRecord[] | null>(`sessions:${run.id}`, null);
    if (saved) return saved;
    return run.conversationId ? [{ id: run.conversationId, createdAt: run.createdAt, reason: "start", summary: null, model: run.model }] : [];
  }

  private addSession(runId: string, record: SessionRecord) {
    const run = this.store.getRun(runId)!;
    const list = this.store.setting<SessionRecord[] | null>(`sessions:${runId}`, null) ?? this.sessionRecords(run).filter((s) => s.id !== record.id);
    if (!list.some((s) => s.id === record.id)) list.push(record);
    this.store.setSetting(`sessions:${runId}`, list);
  }

  async sessionsFor(projectId: string, taskId: string): Promise<import("@nightshift/core").TaskSession[]> {
    const runs = [...this.store.runsForTask(projectId, taskId)].reverse();
    const latest = runs.at(-1);
    const out: import("@nightshift/core").TaskSession[] = [];
    let index = 0;
    const listed = new Set<string>();
    for (const run of runs) {
      for (const rec of this.sessionRecords(run)) {
        if (listed.has(rec.id)) continue;
        listed.add(rec.id);
        index++;
        const stats = await this.pi.contextStats(rec.id).catch(() => ({ tokens: null, turns: 0 }));
        out.push({
          id: rec.id,
          runId: run.id,
          index,
          label: `Session ${index}`,
          reason: rec.reason,
          createdAt: rec.createdAt,
          active: Boolean(latest && rec.id === latest.conversationId),
          model: rec.model,
          contextTokens: stats.tokens,
          contextWindow: this.deps.contextWindowOf?.(rec.model) ?? null,
          turns: stats.turns,
          summary: rec.summary,
        });
      }
    }
    return out.reverse();
  }

  canStartSession(run: Run | null): { allowed: boolean; reason: string | null } {
    if (!run?.conversationId) return { allowed: false, reason: "The agent has not started on this task yet" };
    if (["done", "failed", "stopped"].includes(run.phase)) return { allowed: false, reason: "Send a message to start a new attempt; it begins with a fresh session" };
    return { allowed: true, reason: null };
  }

  async newSession(projectId: string, taskId: string, input: import("@nightshift/core").NewSessionInput): Promise<import("@nightshift/core").NewSessionResponse> {
    const ctx = this.ctx(projectId);
    const run = this.store.latestRunForTask(projectId, taskId);
    const can = this.canStartSession(run);
    if (!can.allowed || !run?.conversationId) throw new Error(can.reason ?? "Not allowed");
    const note = input.note?.trim();
    if (input.mode === "compact") {
      await this.pi.compact(run.conversationId, note || "Keep the task goal, decisions made, files changed, failing checks and open questions.");
      this.event(run.id, "info", "Compacting the current session to free context");
      return { session: (await this.sessionsFor(projectId, taskId)).find((s) => s.active) ?? null, effect: "Older messages are being summarised in the background to free context." };
    }
    if (input.mode !== "fresh" && input.mode !== "handoff") throw new Error("Unknown session mode");
    let summary: string | null = null;
    if (input.mode === "handoff") {
      const items = await this.runner.transcript(run.conversationId, 300).catch(() => []);
      const text = items
        .map((i) => (i.kind === "user" ? `[${i.author}] ${i.text}` : i.kind === "assistant" ? `[agent] ${i.text}` : `[tool ${i.name}] ${i.summary}${i.isError ? " (error)" : ""}`))
        .join("\n")
        .slice(-40_000);
      const summarize = this.deps.summarize;
      if (!summarize) throw new Error("No model is configured for summaries");
      summary = await summarize(
        "You hand over coding work between AI engineer sessions. Write a concise handoff (under 300 words) with headings: Goal, Done so far, Current state of the code, Problems and open questions, Next steps. Only use facts from the transcript.",
        `Transcript of the previous session (oldest first, truncated):\n${text}`,
      );
    }
    const working = isActivePhase(run.phase) && WORKING.has(run.phase) && !run.paused;
    const oldConversation = run.conversationId;
    const conversationId = await this.runner.create({
      runId: run.id,
      cwd: run.worktree,
      instructions: instructions(ctx.project.checks, run.worktree, run.branch, ctx.project.brief),
      model: { provider: run.model.split("/")[0], modelId: run.model.split("/").slice(1).join("/") },
    });
    this.addSession(run.id, { id: conversationId, createdAt: new Date().toISOString(), reason: input.mode, summary, model: run.model });
    this.update(run.id, { conversationId });
    const [task, comments] = await Promise.all([ctx.source.getTask(taskId), ctx.source.listComments(taskId)]);
    const intro = [
      taskPrompt(task, comments),
      summary ? `## Where the previous session left off\n\n${summary}` : "You are starting a fresh session. The work done so far is in the workspace: check `git status`, `git log` and `git diff` first.",
      ...(note ? [`## Note from the operator\n\n${note}`] : []),
    ].join("\n\n");
    this.event(run.id, "info", `New ${input.mode} session started`);
    let effect: string;
    if (working) {
      this.setPending(run.id, { requestId: `${run.id}:session:${conversationId}`, author: "system", text: intro, attachmentIds: [] });
      this.store.setSetting(`switching:${run.id}`, true);
      await this.runner.abort(oldConversation).catch(() => {});
      effect = "The agent continues the task in the new session now.";
      void this.drive(run.id);
    } else {
      await this.runner.abort(oldConversation).catch(() => {});
      this.store.setSetting(`sessionIntro:${run.id}`, intro);
      effect = isActivePhase(run.phase) ? "The new session takes over after the current step." : "The new session takes over with the next message or PR round.";
    }
    this.touchTask(projectId, taskId);
    return { session: (await this.sessionsFor(projectId, taskId)).find((s) => s.id === conversationId) ?? null, effect };
  }

  setPort(port: number) {
    this.port = port;
  }

  envForCwd(cwd: string): Record<string, string> {
    const run = this.store.listRuns(5000).find((r) => r.worktree === cwd);
    if (!run || !this.projects.has(run.projectId)) return {};
    return this.workspace.env(run.projectId, run.taskId);
  }

  private get config() {
    return this.deps.config;
  }

  get budgets(): NightshiftConfig["budgets"] {
    return { ...this.config.budgets, ...this.store.setting<Partial<NightshiftConfig["budgets"]>>("limits", {}) };
  }

  defaultBudgets(): NightshiftConfig["budgets"] {
    return { ...this.config.budgets };
  }

  saveBudgets(input: Partial<NightshiftConfig["budgets"]> | null): NightshiftConfig["budgets"] {
    if (input === null) {
      this.store.setSetting("limits", {});
      return this.budgets;
    }
    const next: Partial<NightshiftConfig["budgets"]> = { ...this.store.setting<Partial<NightshiftConfig["budgets"]>>("limits", {}) };
    for (const key of ["perRunUsd", "perRunTokens", "perDayUsd", "maxFixRounds"] as const) {
      const v = input[key];
      if (v === undefined) continue;
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new Error(`${key} must be a positive number`);
      next[key] = key === "maxFixRounds" || key === "perRunTokens" ? Math.round(v) : v;
    }
    this.store.setSetting("limits", next);
    return this.budgets;
  }

  private runTotal(runId: string): UsageTotals {
    return Object.values(this.store.runModelUsage(runId)).reduce<UsageTotals>((sum, u) => addUsage(sum, u), emptyUsage());
  }

  private budgetLimit(run: Run) {
    const b = this.budgets;
    const n = 1 + this.store.setting<number>(`budgetAllowance:${run.id}`, 0);
    return { usd: b.perRunUsd * n, tokens: b.perRunTokens * n };
  }

  private overBudget(run: Run, total: UsageTotals) {
    const limit = this.budgetLimit(run);
    return total.costUsd > limit.usd || budgetTokens(total) > limit.tokens;
  }

  private async holdForBudget(run: Run, total: UsageTotals) {
    if (this.vlog.openDecisions(run.id).some((d) => d.kind === "budget")) return;
    const limit = this.budgetLimit(run);
    const millions = (n: number) => (n < 1_000_000 ? Math.round(n).toLocaleString("en-US") : `${(n / 1_000_000).toFixed(2)}M`);
    this.store.setSetting(`budgetHold:${run.id}`, true);
    this.event(run.id, "budget", `Run budget reached ($${total.costUsd.toFixed(2)} of $${limit.usd.toFixed(2)}, ${millions(budgetTokens(total))} of ${millions(limit.tokens)} tokens)`);
    if (run.conversationId) await this.runner.abort(run.conversationId).catch(() => {});
    this.vlog.addDecision(run.id, {
      kind: "budget",
      question: `This task reached its budget: $${total.costUsd.toFixed(2)} of $${limit.usd.toFixed(2)} and ${millions(budgetTokens(total))} of ${millions(limit.tokens)} tokens. Continue?`,
      context:
        "Nightshift stopped the agent at the end of its last step; the work so far stays in the workspace. Continuing gives this task another full budget. Cached context the model re-reads is not counted. You can change the limits under Usage.",
      options: ["Continue with another budget", "Stop the task"],
      source: "Nightshift",
    });
    await this.pauseForDecisions(this.store.getRun(run.id)!);
  }

  private grantBudget(run: Run) {
    this.store.setSetting(`budgetAllowance:${run.id}`, this.store.setting<number>(`budgetAllowance:${run.id}`, 0) + 1);
    this.store.setSetting(`budgetHold:${run.id}`, false);
  }

  private get store() {
    return this.deps.store;
  }

  private log(line: string) {
    this.deps.log?.(`${new Date().toISOString()} ${line}`);
  }

  private ctx(projectId: string): ProjectContext {
    const ctx = this.projects.get(projectId);
    if (!ctx) throw new Error(`project ${projectId} not found`);
    return ctx;
  }

  private runCtx(run: { projectId: string }) {
    return this.ctx(run.projectId);
  }

  readonly bridge: RunBridge = {
    contextFor: (conversationId) => {
      const reviewerRun = this.store.setting<string | null>(`reviewerConv:${conversationId}`, null);
      const run = reviewerRun ? this.store.getRun(reviewerRun) : this.store.listRuns(5000).find((r) => r.conversationId === conversationId);
      return run ? { runId: run.id, projectId: run.projectId, taskId: run.taskId, cwd: run.worktree } : undefined;
    },
    getTask: (rc) => this.ctx(rc.projectId).source.getTask(rc.taskId),
    listComments: (rc) => this.ctx(rc.projectId).source.listComments(rc.taskId),
    postComment: async (rc: RunContext, body, key) => {
      await this.sideEffect(key, rc.runId, () => this.ctx(rc.projectId).source.comment(rc.taskId, body, key));
      this.event(rc.runId, "comment", body);
    },
    askQuestion: async (rc: RunContext, question, key, options?: string[]) => {
      this.vlog.addDecision(rc.runId, { kind: "agent-question", question, context: "", options: options ?? [], source: "Agent" });
      await this.sideEffect(key, rc.runId, () => this.ctx(rc.projectId).source.comment(rc.taskId, `Question from Nightshift: ${question}`, key));
      await this.setTaskStatus(rc.runId, "needs_info");
      this.update(rc.runId, { phase: "needs_info", slot: null, lastCommentSeenAt: new Date().toISOString(), activity: "Waiting for an answer" });
      this.event(rc.runId, "question", question);
    },
    checks: (rc) => this.ctx(rc.projectId).project.checks,
    submitPlan: async (rc, plan, key) => {
      this.store.setSetting(`plan:${rc.runId}`, plan);
      this.event(rc.runId, "plan", plan);
      await this.sideEffect(key, rc.runId, () => this.ctx(rc.projectId).source.comment(rc.taskId, `Plan from Nightshift:\n\n${plan}`, key));
      if (this.ctx(rc.projectId).project.planMode === "approve") {
        await this.setTaskStatus(rc.runId, "needs_info", ":plan");
        this.update(rc.runId, { phase: "needs_info", slot: null, lastCommentSeenAt: new Date().toISOString(), activity: "Waiting for plan approval" });
      }
    },
    preview: async (rc, action, probe, service) => {
      const project = this.ctx(rc.projectId).project;
      if (!project.preview?.command && !project.preview?.services?.length) return "This project has no preview command configured.";
      try {
        if (action === "stop") await this.workspace.stopPreview(rc.projectId, rc.taskId, service);
        else if (action === "start" || action === "restart") {
          await this.workspace.startPreview(rc.projectId, rc.taskId, action === "restart", service);
          await this.workspace.previews.waitUntilSettled(rc.projectId, rc.taskId);
        }
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      const info = this.workspace.previews.info(rc.projectId, rc.taskId, project.preview);
      const lines = info.services.map(
        (s) =>
          `${info.services.length > 1 ? `${s.name}${s.primary ? " (primary)" : ""}${s.shared ? ` (shared by all tasks${s.external ? ", runs outside Nightshift" : ""}; reach it via NIGHTSHIFT_${s.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_HOST/_PORT)` : ""}: ` : "Preview: "}${s.status}${s.url ? ` at ${s.url} (local port ${s.port})` : ""}${s.cwd ? ` in ${s.cwd}` : ""}${s.error ? ` — ${s.error}` : ""}${s.hint ? `\n  Hint: ${s.hint}` : ""}${s.diagnosis ? `\n  Diagnosis: ${s.diagnosis.summary} ${s.diagnosis.cause}` : ""}`,
      );
      if (info.installing) lines.unshift("Installing dependencies before the services start…");
      const target = info.services.find((s) => (service ? s.name === service : s.primary));
      if (target?.status === "running" && target.port && probe !== undefined) {
        try {
          const res = await fetch(`http://127.0.0.1:${target.port}${probe.startsWith("/") ? probe : `/${probe}`}`, { signal: AbortSignal.timeout(15_000) });
          lines.push(`GET ${target.name}${probe} → ${res.status}`, (await res.text()).slice(0, 3000));
        } catch (error) {
          lines.push(`GET ${probe} failed: ${String(error)}`);
        }
      }
      const log = this.workspace.previews.logs(rc.projectId, rc.taskId, service);
      if (log) lines.push("--- dev server log (tail) ---", log.split("\n").slice(-40).join("\n"));
      return lines.join("\n");
    },
    taskGuide: (rc) => this.taskGuide(rc.projectId, rc.taskId),
    localFilesNote: (rc) => {
      const local = this.projectFor(rc.projectId)?.localFiles;
      if (!local?.paths.length) return undefined;
      return [
        `These git-ignored local files were copied from the owner's project folder into your workspace: ${local.paths.join(", ")}. They are never committed.`,
        local.agentCanRead
          ? "You may read and edit them when the task needs it. Never copy secret values into committed files, logs or your replies."
          : "They may hold secrets, so you cannot read or edit them. Nightshift's own values (DATABASE_URL, PORT, service URLs) are already set as environment variables and take priority. If the task needs a new or changed variable, add it to the matching .env.example file and tell the owner in your summary.",
      ].join("\n");
    },
    protectedFiles: (rc) => {
      const local = this.projectFor(rc.projectId)?.localFiles;
      return local && !local.agentCanRead ? local.paths : [];
    },
    skills: (rc) => {
      try {
        const project = this.projectFor(rc.projectId);
        return project ? skillsSection(this.skills.forRun(project, rc.cwd), this.taskTypeOf(rc.projectId, rc.taskId)) : undefined;
      } catch {
        return undefined;
      }
    },
    database: async (rc, action) => {
      const project = this.ctx(rc.projectId).project;
      if (!this.workspace.databases.active(project)) return "This project has no database configured.";
      if (action === "reset") await this.workspace.databases.create(project, rc.taskId, rc.cwd, { reset: true });
      const info = this.workspace.databases.info(project, rc.taskId);
      return `Database ${info.name ?? "(none)"}: ${info.status}${info.error ? ` — ${info.error}` : ""}. ${info.envVar} is set in your shell${info.seededAt ? `; seeded ${info.seededAt}` : ""}.`;
    },
  };

  attachRunner(runner: AgentRunner) {
    this.runner = runner;
  }

  private get pi(): PiExtras {
    return this.runner as unknown as PiExtras;
  }

  private emit(event: ServerEvent) {
    this.emitter.emit("event", event);
  }

  private touchTask(projectId: string, taskId: string) {
    const ctx = this.projects.get(projectId);
    if (ctx) ctx.tasksCache = null;
    this.emit({ type: "task", projectId, taskId });
  }

  update(runId: string, patch: Partial<Run>): Run {
    const before = this.store.getRun(runId);
    const run = this.store.updateRun(runId, patch);
    if (patch.phase && before && before.phase !== patch.phase) {
      this.event(runId, "phase", `${before.phase} → ${patch.phase}`);
      this.log(`[${run.projectId}/${run.taskId}] ${before.phase} -> ${patch.phase}`);
    }
    this.emit({ type: "run", run });
    this.touchTask(run.projectId, run.taskId);
    if (patch.phase && ["done", "stopped"].includes(patch.phase)) void this.workspace.cleanupForRun(run).catch((e) => this.log(`cleanup ${run.id}: ${String(e)}`));
    return run;
  }

  event(runId: string, type: RunEventType, message: string, data?: unknown) {
    const event = this.store.addEvent(runId, type, message, data);
    this.emit({ type: "event", event });
    return event;
  }

  private async sideEffect<T>(key: string, runId: string | null, act: () => Promise<T>): Promise<T> {
    const done = this.store.sideEffect<T>(key);
    if (done !== null) return done;
    const result = await act();
    this.store.recordSideEffect(key, runId, result ?? true);
    return result;
  }

  private async setTaskStatus(runId: string, status: TaskStatus, suffix = "") {
    const run = this.store.getRun(runId)!;
    const key = `status:${runId}:${status}${suffix}`;
    await this.sideEffect(key, runId, () => this.runCtx(run).source.setStatus(run.taskId, status, key));
    this.touchTask(run.projectId, run.taskId);
  }

  private async comment(runId: string, key: string, body: string) {
    const run = this.store.getRun(runId)!;
    await this.sideEffect(key, runId, () => this.runCtx(run).source.comment(run.taskId, body, key));
    this.event(runId, "comment", body);
  }

  private pending(runId: string): Pending | null {
    return this.store.setting<Pending | null>(`pending:${runId}`, null);
  }

  private setPending(runId: string, pending: Pending | null) {
    this.store.setSetting(`pending:${runId}`, pending);
  }

  get killSwitch() {
    return this.store.setting("killSwitch", false);
  }

  private activeRuns() {
    return this.store.listRuns(5000).filter((r) => isActivePhase(r.phase) && !r.paused);
  }

  private freeSlot(): number | null {
    const used = new Set(this.activeRuns().map((r) => r.slot));
    for (let i = 0; i < this.config.slots; i++) if (!used.has(i)) return i;
    return null;
  }

  loadProjects() {
    seedProjectFromConfig(this.config, this.store);
    for (const project of this.store.listProjects()) {
      if (!this.projects.has(project.id)) this.projects.set(project.id, buildContext(this.config, this.store, project));
    }
  }

  async createProject(input: NewProjectInput): Promise<ProjectSummary> {
    for (const choice of [input.model, input.reviewModel]) {
      if (choice && this.deps.modelExists && !this.deps.modelExists(choice)) throw new Error(`Unknown model ${choice.provider}/${choice.modelId}`);
    }
    const project = await validateNewProject(input, this.store.listProjects(), this.store.setting<string[]>("deletedProjects", []));
    this.store.saveProject(project);
    const ctx = buildContext(this.config, this.store, project);
    this.projects.set(project.id, ctx);
    await this.connect(ctx);
    this.lastTaskPoll = 0;
    this.emit({ type: "projects" });
    return this.projectSummary(ctx);
  }

  async updateProject(id: string, update: ProjectUpdate): Promise<ProjectSummary> {
    const old = this.ctx(id);
    for (const choice of [update.model, update.reviewModel]) {
      if (choice && this.deps.modelExists && !this.deps.modelExists(choice)) throw new Error(`Unknown model ${choice.provider}/${choice.modelId}`);
    }
    const next = await applyProjectUpdate(old.project, update);
    this.store.saveProject(next);
    const sourceChanged = JSON.stringify(old.project.source) !== JSON.stringify(next.source);
    const ctx = buildContext(this.config, this.store, next);
    if (sourceChanged) {
      await old.source.close().catch(() => {});
      await this.connect(ctx);
    } else {
      ctx.source = old.source;
      ctx.state = old.state;
    }
    this.projects.set(id, ctx);
    this.lastTaskPoll = 0;
    this.emit({ type: "projects" });
    return this.projectSummary(ctx);
  }

  async deleteProject(id: string, opts: { removeWorkspaces?: boolean } = {}): Promise<import("@nightshift/core").DeleteProjectResponse> {
    const ctx = this.ctx(id);
    if (this.moving.has(id)) throw Object.assign(new Error("This project is being moved to GitHub; delete it when that finishes"), { status: 409 });
    const runs = this.store.runsForProject(id);
    const stopped: string[] = [];
    for (const run of runs) {
      if (["done", "failed", "stopped"].includes(run.phase)) continue;
      await this.control(run.id, "stop").catch((e) => this.log(`delete ${id}: stop ${run.id}: ${String(e)}`));
      stopped.push(run.taskId);
    }
    for (const run of runs) await this.settleInflight(run.id);
    const taskIds = [...new Set(runs.map((r) => r.taskId))];
    for (const taskId of taskIds) {
      await this.workspace.previews.stop(id, taskId).catch(() => {});
      const worktree = runs.find((r) => r.taskId === taskId)?.worktree;
      if (worktree && existsSync(worktree)) this.workspace.previews.overlays.restore(id, taskId, worktree);
      this.workspace.previews.forget(id, taskId);
      this.workspace.terminals.closeTask(id, taskId);
    }
    await this.workspace.previews.stop(id, SHARED).catch(() => {});
    this.workspace.previews.forget(id, SHARED);
    let removedWorkspaces = 0;
    if (opts.removeWorkspaces) {
      for (const taskId of taskIds) await this.workspace.databases.drop(ctx.project, taskId).catch(() => {});
      await this.workspace.databases.removeServer(id).catch(() => {});
      for (const worktree of new Set(runs.map((r) => r.worktree).filter(Boolean))) {
        await ctx.workspaces.remove(worktree).catch(() => {});
        removedWorkspaces++;
      }
      await exec("git", ["worktree", "prune"], { cwd: ctx.project.repo.path }).catch(() => {});
      rmSync(path.join(this.config.workspacesDir, id), { recursive: true, force: true });
    }
    await ctx.source.close().catch(() => {});
    this.projects.delete(id);
    this.store.deleteProject(id);
    this.store.setSetting("deletedProjects", [...new Set([...this.store.setting<string[]>("deletedProjects", []), id])]);
    this.log(`project ${id} deleted (${stopped.length} task(s) stopped, ${removedWorkspaces} workspace(s) removed)`);
    this.emit({ type: "projects" });
    return { stopped, removedWorkspaces };
  }

  async generateBrief(id: string): Promise<string> {
    const ctx = this.ctx(id);
    return this.onboarding.brief(ctx.project.repo.path, await inspectRepository(ctx.project.repo.path));
  }

  async scaffoldProject(input: ScaffoldInput): Promise<{ project: ProjectSummary; taskId: string }> {
    const github = input.github ? validateRepoInput(input.github) : null;
    const ready = github ? await ensureReady(github) : null;
    const { repoPath, starter } = await this.onboarding.scaffold(input, { localRemote: !github });
    if (github && ready) {
      try {
        if (!ready.reuse) await createRepo(github);
      } catch (error) {
        rmSync(repoPath, { recursive: true, force: true });
        throw error;
      }
      const url = pushUrl(ready.status, await repoUrls(github));
      await exec("git", ["remote", "add", "origin", url], { cwd: repoPath });
      const pushed = await exec("git", ["push", "--quiet", "-u", "origin", "main"], { cwd: repoPath, timeoutMs: 5 * 60_000, env: { GIT_TERMINAL_PROMPT: "0" } });
      if (pushed.code !== 0)
        throw new GithubError(
          `Created github.com/${github.owner}/${github.name}, but the starter could not be pushed: ${tail(pushed)}. ${pushHint(ready.status.protocol)} Your files are in ${repoPath}. Then create the project again with the same name: Nightshift reuses the empty repository.`,
        );
      await setDefaultBranch(github, "main");
    }
    const project = await this.createProject({
      name: input.name,
      kind: input.kind,
      brief: `${input.description.trim()}\n\nStack: ${starter.label}.`,
      repo: { path: repoPath, baseBranch: "main" },
      gitHost: github ? "github" : "local",
      source: { type: "local" },
      checks: starter.checks,
      ...(starter.preview ? { preview: starter.preview } : {}),
      ...(starter.database ? { database: starter.database } : {}),
      planMode: input.planMode ?? "off",
      review: input.review ?? true,
    });
    const task = await this.createTask(project.id, {
      title: `Set up the project (${starter.label})`,
      body: `${starter.instructions}\n\n## What we are building\n\n${input.description.trim()}`,
    });
    return { project: await this.projectSummary(this.ctx(project.id)), taskId: task.id };
  }

  private readonly moving = new Set<string>();

  async moveToGithub(projectId: string, input: GithubRepoInput): Promise<MoveToGithubResult> {
    const ctx = this.ctx(projectId);
    const project = ctx.project;
    if (project.gitHost === "github") throw new GithubError("This project is already on GitHub", 409);
    if (this.moving.has(projectId)) throw new GithubError("This project is already being moved", 409);
    const busy = this.store
      .listRuns(5000)
      .filter((r) => r.projectId === projectId && !r.paused && ["claimed", "preparing", "working", "fixing", "checking", "reviewing", "pushing"].includes(r.phase));
    if (busy.length) throw new GithubError(`Pause or wait for ${[...new Set(busy.map((r) => r.taskId))].join(", ")} first: an agent is working and may push while the code moves.`, 409);
    const repo = validateRepoInput(input);
    this.moving.add(projectId);
    try {
      const { status, reuse } = await ensureReady(repo);
      if (!reuse) await createRepo(repo);
      const urls = await repoUrls(repo);
      const remoteUrl = pushUrl(status, urls);
      const cwd = project.repo.path;
      const remote = project.repo.remote;
      const git = (args: string[], timeoutMs = 120_000) => exec("git", args, { cwd, timeoutMs, env: { GIT_TERMINAL_PROMPT: "0" } });
      const oldUrl = (await git(["remote", "get-url", remote])).stdout.trim();
      const fetched = await git(["fetch", "--prune", "--tags", remote], 10 * 60_000);
      if (fetched.code !== 0) throw new GithubError(`Could not read the current remote (${oldUrl}): ${tail(fetched)}`);
      const base = project.repo.baseBranch;
      const branches = (await git(["ls-remote", "--heads", remote])).stdout
        .split("\n")
        .map((l) => l.split("\trefs/heads/")[1]?.trim())
        .filter((b): b is string => Boolean(b))
        .sort((a, b) => Number(b === base) - Number(a === base));
      if (!branches.includes(base)) throw new GithubError(`The base branch ${base} is not on ${oldUrl}`);
      const failed = (r: { code: number; stdout: string; stderr: string }) =>
        new GithubError(`Created ${urls.url}, but the code could not be copied: ${tail(r)}. ${pushHint(status.protocol)} Nothing on this Mac was changed; move again with the same name and Nightshift reuses the empty repository.`);
      const first = await git(["push", "--quiet", remoteUrl, `refs/remotes/${remote}/${base}:refs/heads/${base}`], 10 * 60_000);
      if (first.code !== 0) throw failed(first);
      const rest = branches.filter((b) => b !== base).map((b) => `refs/remotes/${remote}/${b}:refs/heads/${b}`);
      const second = await git(["push", "--quiet", remoteUrl, ...rest, "refs/tags/*:refs/tags/*"], 10 * 60_000);
      if (second.code !== 0) throw failed(second);
      await setDefaultBranch(repo, base);
      const remotes = (await git(["remote"])).stdout.split("\n").map((r) => r.trim());
      let backupRemote = "nightshift-local";
      for (let n = 2; remotes.includes(backupRemote) && (await git(["remote", "get-url", backupRemote])).stdout.trim() !== oldUrl; n++) backupRemote = `nightshift-local-${n}`;
      if (!remotes.includes(backupRemote)) await git(["remote", "add", backupRemote, oldUrl]);
      const setUrl = await git(["remote", "set-url", remote, remoteUrl]);
      if (setUrl.code !== 0) throw new GithubError(`The code is on ${urls.url}, but ${remote} could not be pointed at it: ${tail(setUrl)}`);
      await git(["fetch", "--prune", remote], 10 * 60_000);
      const oldPrs = ctx.prHost instanceof LocalPrHost ? ctx.prHost.read() : [];
      const summary = await this.updateProject(projectId, { gitHost: "github" });
      const next = this.ctx(projectId);
      const pullRequests: MoveToGithubResult["pullRequests"] = [];
      const latest = new Map<string, Run>();
      for (const r of this.store.listRuns(5000)) if (r.projectId === projectId && (!latest.has(r.taskId) || latest.get(r.taskId)!.createdAt < r.createdAt)) latest.set(r.taskId, r);
      for (const r of latest.values()) {
        if (!r.prNumber || ["done", "failed", "stopped"].includes(r.phase)) continue;
        const local = oldPrs.find((p) => p.number === r.prNumber);
        if (local && local.state !== "open") continue;
        try {
          const pr = (await next.prHost.findOpen(r.branch)) ?? (await next.prHost.create({ branch: r.branch, base: r.baseBranch ?? base, title: local?.title ?? `${r.taskId}: ${r.taskTitle}`, body: local?.body ?? "Moved from Nightshift's local pull requests." }));
          this.update(r.id, { prNumber: pr.number, prUrl: pr.url });
          this.event(r.id, "info", `Moved to GitHub: pull request ${pr.url}`);
          pullRequests.push({ taskId: r.taskId, branch: r.branch, url: pr.url, error: null });
        } catch (error) {
          pullRequests.push({ taskId: r.taskId, branch: r.branch, url: null, error: error instanceof Error ? error.message : String(error) });
        }
      }
      this.emit({ type: "projects" });
      return { project: { ...summary, gitHost: "github" }, repoUrl: urls.url, remoteUrl, branches, pullRequests, backupRemote };
    } finally {
      this.moving.delete(projectId);
    }
  }

  private async connect(ctx: ProjectContext) {
    try {
      await ctx.source.connect();
      ctx.state.connected = true;
      ctx.state.lastError = null;
    } catch (error) {
      ctx.state.connected = false;
      ctx.state.lastError = String(error instanceof Error ? error.message : error);
    }
  }

  async start() {
    this.loadProjects();
    await Promise.all([...this.projects.values()].map((ctx) => this.connect(ctx)));
    for (const run of this.store.listRuns(5000)) {
      if (run.paused && run.slot !== null) this.store.updateRun(run.id, { slot: null });
      if (!this.projects.has(run.projectId)) continue;
      if (run.leaseId && run.leaseExpiresAt && !["done", "failed", "stopped"].includes(run.phase)) {
        this.leases.set(run.id, { taskId: run.taskId, leaseId: run.leaseId, expiresAt: run.leaseExpiresAt });
      }
      if (!isActivePhase(run.phase) || run.paused) continue;
      this.event(run.id, "info", "Resuming after restart");
      void this.drive(run.id);
    }
    const health = await this.pi.health().catch(() => null);
    if (health?.blocked.length) this.log(`Pi has ${health.blocked.length} blocked task(s): ${health.blocked.join("; ")}`);
    this.timer = setInterval(() => void this.tick(), this.config.intervalsMs.tick);
    void this.tick();
  }

  async stop() {
    this.stopping = true;
    await this.workspace.previews.stopAll().catch(() => {});
    this.workspace.terminals.closeAll();
    if (this.timer) clearInterval(this.timer);
    await Promise.all([...this.projects.values()].map((ctx) => ctx.source.close().catch(() => {})));
  }

  private async tick() {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      const now = Date.now();
      await this.refreshActive();
      if (now - this.lastLeaseRenew >= this.config.intervalsMs.leaseRenew) {
        this.lastLeaseRenew = now;
        await this.renewLeases();
      }
      if (now - this.lastPrPoll >= this.config.intervalsMs.prs) {
        this.lastPrPoll = now;
        await this.watchPrs();
      }
      if (now - this.lastAnswerPoll >= this.config.intervalsMs.tasks) {
        this.lastAnswerPoll = now;
        await this.watchAnswers();
      }
      await this.deliverQueued();
      if (now - this.lastTriggerPoll >= this.config.intervalsMs.prs) {
        this.lastTriggerPoll = now;
        await this.watchTriggers();
      }
      if (now - this.lastTaskPoll >= this.config.intervalsMs.tasks) {
        this.lastTaskPoll = now;
        await this.claimTasks();
      }
      this.emit({ type: "status", status: this.status() });
    } catch (error) {
      this.log(`tick error: ${String(error)}`);
    } finally {
      this.ticking = false;
    }
  }

  private dailyBudgetHit() {
    return this.store.usageOn().costUsd >= this.budgets.perDayUsd;
  }

  private async claimTasks() {
    if (this.killSwitch || this.dailyBudgetHit()) return;
    for (const ctx of this.projects.values()) {
      if (this.freeSlot() === null) return;
      if (ctx.project.paused) continue;
      let refs;
      try {
        refs = await ctx.source.listReady();
        ctx.state = { connected: true, lastPollAt: new Date().toISOString(), lastError: null };
      } catch (error) {
        ctx.state = { ...ctx.state, connected: false, lastError: String(error instanceof Error ? error.message : error) };
        continue;
      }
      for (const ref of refs) {
        const slot = this.freeSlot();
        if (slot === null) return;
        const latest = this.store.latestRunForTask(ctx.project.id, ref.id);
        if (latest && !["failed", "stopped", "done"].includes(latest.phase)) continue;
        const lease = await ctx.source.claim(ref.id).catch(() => null);
        if (!lease) continue;
        const task = await ctx.source.getTask(ref.id);
        const meta = this.store.setting<{ continueBranch?: string } | null>(`taskMeta:${ctx.project.id}/${task.id}`, null);
        const branch =
          meta?.continueBranch ??
          (latest && latest.phase !== "done" ? latest.branch : `${ctx.project.repo.branchPrefix}${slugify(task.id)}-${slugify(task.title)}${latest ? `-${Date.now().toString(36)}` : ""}`);
        const run = this.store.createRun({
          baseBranch: this.store.setting<string | null>(`taskBase:${ctx.project.id}/${task.id}`, null) ?? ctx.project.repo.baseBranch,
          id: `run_${slugify(ctx.project.id)}_${slugify(task.id)}_${Date.now().toString(36)}`,
          projectId: ctx.project.id,
          taskId: task.id,
          taskTitle: task.title,
          source: ctx.source.name,
          slot,
          branch,
          worktree: ctx.workspaces.pathFor(task.id),
          model: this.label(this.modelFor(ctx.project)),
          leaseId: lease.leaseId,
          leaseExpiresAt: lease.expiresAt,
          phase: "claimed",
        });
        this.leases.set(run.id, lease);
        this.event(run.id, "info", `Claimed ${task.id}: ${task.title}`);
        this.emit({ type: "run", run });
        this.touchTask(run.projectId, run.taskId);
        this.log(`[${ctx.project.id}/${task.id}] claimed in slot ${slot}`);
        void this.drive(run.id);
      }
    }
  }

  private async renewLeases() {
    for (const [runId, lease] of this.leases) {
      const run = this.store.getRun(runId);
      if (!run || ["done", "failed", "stopped"].includes(run.phase)) {
        this.leases.delete(runId);
        continue;
      }
      const renewed = await this.runCtx(run).source.renew(lease).catch(() => null);
      if (renewed) {
        this.leases.set(runId, renewed);
        this.store.updateRun(runId, { leaseExpiresAt: renewed.expiresAt });
      } else {
        this.event(runId, "error", "Lost the task claim");
      }
    }
  }

  private async releaseLease(runId: string) {
    const lease = this.leases.get(runId);
    this.leases.delete(runId);
    const run = this.store.getRun(runId);
    if (lease && run) await this.runCtx(run).source.release(lease).catch(() => {});
    this.store.updateRun(runId, { leaseId: null, leaseExpiresAt: null });
  }

  private async refreshActive() {
    for (const run of this.store.listRuns(5000)) {
      if (!run.conversationId || !isActivePhase(run.phase)) continue;
      try {
        const [activity, usage] = await Promise.all([this.runner.activity(run.conversationId), this.runner.usage(run.conversationId)]);
        let total = this.store.recordModelUsage(run.id, usage, `c${run.conversationId}`);
        const reviewerId = this.store.setting<string | null>(`reviewer:${run.id}`, null);
        if (reviewerId) total = this.store.recordModelUsage(run.id, await this.runner.usage(reviewerId), "review");
        const label = activity.tool ? `${activity.tool}${activity.detail ? `: ${activity.detail}` : ""}` : activity.lastText ? `writing: ${activity.lastText.slice(-120)}` : activity.busy ? "thinking" : null;
        if (label !== run.activity) this.update(run.id, { activity: label });
        else this.emit({ type: "run", run: { ...run, usage: total } });
        const fresh = this.store.getRun(run.id)!;
        if (WORKING.has(fresh.phase) && !fresh.paused && this.overBudget(fresh, total)) await this.holdForBudget(fresh, total);
      } catch (error) {
        this.log(`refresh ${run.id}: ${String(error)}`);
      }
    }
  }

  private attachmentRefs(ids: string[]): AttachmentRef[] {
    return ids
      .map((id) => this.store.attachment(id))
      .filter((a) => a !== null)
      .map((a) => ({ id: a.id, name: a.name, mimeType: a.mimeType, size: a.size, url: `/api/uploads/${a.id}` }));
  }

  private agentMessage(text: string, author: TranscriptAuthor, attachmentIds: string[]): AgentMessage {
    const images = attachmentIds
      .map((id) => this.store.attachment(id))
      .filter((a) => a !== null && a.mimeType.startsWith("image/"))
      .map((a) => ({ data: readFileSync(a!.path).toString("base64"), mimeType: a!.mimeType }));
    return { text, author, images, attachments: this.attachmentRefs(attachmentIds) };
  }

  private undelivered(run: Run): StoredMessage[] {
    return this.store.taskMessages(run.projectId, run.taskId).filter((m) => !m.deliveredAt);
  }

  private track(runId: string, promise: Promise<unknown>) {
    const set = this.inflight.get(runId) ?? new Set();
    set.add(promise);
    this.inflight.set(runId, set);
    void promise.finally(() => set.delete(promise));
  }

  private async settleInflight(runId: string) {
    for (;;) {
      const set = this.inflight.get(runId);
      if (!set?.size) return;
      await Promise.allSettled([...set]);
    }
  }

  async drive(runId: string) {
    if (this.driving.has(runId)) return;
    this.driving.add(runId);
    try {
      for (;;) {
        const run = this.store.getRun(runId);
        if (!run || run.paused || this.stopping || !isActivePhase(run.phase)) return;
        const next = await this.step(run);
        if (!next) return;
      }
    } catch (error) {
      this.log(`drive ${runId} failed: ${String(error)}`);
      await this.fail(runId, String(error instanceof Error ? error.message : error));
    } finally {
      this.driving.delete(runId);
    }
  }

  private async step(run: Run): Promise<boolean> {
    const ctx = this.runCtx(run);
    switch (run.phase) {
      case "claimed": {
        await this.setTaskStatus(run.id, "in_progress");
        await this.comment(run.id, `pickup:${run.id}`, `Picked up by Nightshift (${run.model}). Branch: ${run.branch}`);
        this.update(run.id, { phase: "preparing", activity: "Preparing workspace" });
        return true;
      }
      case "preparing": {
        const dir = await ctx.workspaces.ensure(run.taskId, run.branch, this.baseOf(run), this.taskMeta(run.projectId, run.taskId)?.startFrom);
        if (ctx.project.localFiles?.paths.length) {
          const local = syncLocalFiles(ctx.project.repo.path, dir, ctx.project.localFiles, false);
          if (local.copied.length) {
            this.store.setSetting(`localFilesSynced:${run.projectId}/${run.taskId}`, new Date().toISOString());
            this.event(run.id, "info", `Copied local files: ${local.copied.join(", ")}`);
          }
          if (local.missing.length) this.event(run.id, "info", `Local files not in the project folder: ${local.missing.join(", ")}`);
        }
        const setup = ctx.project.repo.setup;
        if (setup && !this.store.setting<boolean>(`setupSkip:${run.id}`, false) && !this.store.sideEffect(`setup:${run.id}`)) {
          this.event(run.id, "info", `Setup: ${setup}`);
          this.update(run.id, { worktree: dir, activity: "Setting up the workspace" });
          const step = this.vlog.startStep(run.id, "setup", "Set up the workspace", setup);
          const res = await exec("sh", ["-c", setup], { cwd: dir, timeoutMs: 30 * 60_000, env: this.workspace.env(run.projectId, run.taskId) });
          const output = [res.stdout, res.stderr].filter((x) => x.trim()).join("\n");
          if (res.code !== 0) {
            this.vlog.finishStep(run.id, step, "failed", { detail: lastError(output), output: tailLines(output, 20_000) });
            await this.askSetup(this.store.getRun(run.id)!, dir, setup, output);
            return false;
          }
          this.vlog.finishStep(run.id, step, "passed", { output: tailLines(output, 4000) });
          this.store.recordSideEffect(`setup:${run.id}`, run.id, true);
        }
        if (this.workspace.databases.active(ctx.project) && this.workspace.databases.info(ctx.project, run.taskId).status !== "ready") {
          this.update(run.id, { worktree: dir, activity: "Creating and seeding the database" });
          const db = await this.workspace.databases.create(ctx.project, run.taskId, dir);
          if (db.status === "ready") this.event(run.id, "info", `Database ${db.name} ready${db.seededAt ? " and seeded" : ""}`);
          else this.event(run.id, "error", `Database setup failed: ${db.error}. The agent continues without it.`);
        }
        if (ctx.project.checks.length && this.store.setting<Record<string, boolean> | null>(`baseline:${run.id}`, null) === null) {
          this.update(run.id, { activity: "Running checks on the base branch" });
          const baseline: Record<string, boolean> = {};
          for (const check of ctx.project.checks) {
            const res = await exec("sh", ["-c", check.command], { cwd: dir, timeoutMs: check.timeoutMs ?? 600_000, env: this.workspace.env(run.projectId, run.taskId), group: true });
            baseline[check.name] = res.code === 0;
            this.workspace.recordCheck(run.id, {
              id: `${run.id}:base:${check.name}:${Date.now()}`,
              name: `${check.name} (base)`,
              ok: res.code === 0,
              output: `${res.stdout}\n${res.stderr}`.trim().split("\n").slice(-400).join("\n"),
              at: new Date().toISOString(),
              sha: null,
              preExisting: false,
            });
          }
          this.store.setSetting(`baseline:${run.id}`, baseline);
          const broken = Object.entries(baseline).filter(([, ok]) => !ok).map(([name]) => name);
          if (broken.length) this.event(run.id, "info", `Already failing before any change: ${broken.join(", ")}. These will not block the task.`);
        }
        let conversationId = run.conversationId;
        const previous = conversationId ? undefined : this.store.runsForTask(run.projectId, run.taskId).find((r) => r.id !== run.id && r.conversationId && r.worktree === dir);
        if (!conversationId && previous?.conversationId) {
          conversationId = previous.conversationId;
          this.update(run.id, { conversationId, worktree: dir });
          this.store.seedModelUsage(run.id, await this.runner.usage(conversationId), `c${conversationId}`);
          this.store.setSetting(`resumedFrom:${run.id}`, { runId: previous.id, phase: previous.phase, error: previous.error });
          const prevPlan = this.store.setting<string | null>(`plan:${previous.id}`, null);
          if (prevPlan) this.store.setSetting(`plan:${run.id}`, prevPlan);
          for (const [k, fallback] of [[`approvedDeletes:${previous.id}`, []], [`rejectedDeletes:${previous.id}`, []]] as const) this.store.setSetting(k.replace(previous.id, run.id), this.store.setting(k, fallback));
          this.event(run.id, "info", "Retrying in the same session, so the agent keeps the whole conversation");
        }
        if (!conversationId) {
          const [provider, ...rest] = run.model.split("/");
          conversationId = await this.runner.create({
            runId: run.id,
            cwd: dir,
            instructions: instructions(ctx.project.checks, dir, run.branch, ctx.project.brief),
            model: { provider, modelId: rest.join("/") },
          });
          this.update(run.id, { conversationId, worktree: dir });
          const earlier = this.store.runsForTask(run.projectId, run.taskId).filter((r) => r.id !== run.id).length;
          this.addSession(run.id, { id: conversationId, createdAt: new Date().toISOString(), reason: earlier ? "retry" : "start", summary: null, model: run.model });
        }
        this.update(run.id, { phase: "working", activity: "Starting" });
        return true;
      }
      case "working":
      case "fixing": {
        let pending = this.pending(run.id);
        if (!pending) {
          const [task, comments] = await Promise.all([ctx.source.getTask(run.taskId), ctx.source.listComments(run.taskId)]);
          const queued = this.undelivered(run);
          const resumed = this.store.setting<{ phase: string; error: string | null } | null>(`resumedFrom:${run.id}`, null);
          pending = resumed
            ? {
                requestId: `${run.id}:start`,
                author: "system",
                text:
                  `Nightshift is retrying this task. The previous attempt ${resumed.phase === "stopped" ? "was stopped" : `ended with: ${resumed.error ?? resumed.phase}`}. ` +
                  "Continue in the same workspace from where you are. Everything the task owner told you earlier in this conversation still applies; do not undo their requests." +
                  this.setupNotePrompt(run) +
                  operatorNotes(queued.map((m) => m.text)),
                attachmentIds: queued.flatMap((m) => m.attachmentIds),
              }
            : {
                requestId: `${run.id}:start`,
                author: "task",
                text: taskPrompt(task, comments) + this.setupNotePrompt(run) + operatorNotes(queued.map((m) => m.text)),
                attachmentIds: queued.flatMap((m) => m.attachmentIds),
              };
          this.setPending(run.id, pending);
          this.store.markMessagesDelivered(queued.map((m) => m.id), run.id);
        }
        const intro = this.store.setting<string | null>(`sessionIntro:${run.id}`, null);
        if (intro) {
          pending = { ...pending, text: `${intro}\n\n---\n\n${pending.text}`, requestId: `${pending.requestId}:intro` };
          this.setPending(run.id, pending);
          this.store.setSetting(`sessionIntro:${run.id}`, null);
        }
        const planMode = ctx.project.planMode ?? "off";
        if (planMode !== "off" && pending.requestId.endsWith(":start") && this.store.setting<string | null>(`plan:${run.id}`, null) === null) {
          this.update(run.id, { activity: "Planning (read-only)" });
          this.event(run.id, "agent", "Planning started", { text: pending.text });
          const planned = await this.pi.plan(
            run.conversationId!,
            this.agentMessage(
              `${pending.text}\n\nPLANNING STEP: explore the code read-only, then call submit_plan with your implementation plan. Do not change files yet.`,
              pending.author,
              pending.attachmentIds,
            ),
            `${run.id}:plan`,
          );
          if (this.store.setting<string | null>(`plan:${run.id}`, null) === null) this.store.setSetting(`plan:${run.id}`, planned.answer ?? "(no plan text)");
          const afterPlan = this.store.getRun(run.id)!;
          if (afterPlan.paused || !isActivePhase(afterPlan.phase)) return false;
          this.setPending(run.id, { requestId: `${run.id}:implement`, author: "system", text: "Your plan is recorded. Implement it now, run the checks, then reply with your summary.", attachmentIds: [] });
          return true;
        }
        this.event(run.id, "agent", pending.requestId.endsWith(":start") ? "Agent started" : "Sent to agent", { text: pending.text });
        const first = pending.requestId.endsWith(":start") || pending.requestId.endsWith(":implement");
        if (!first && this.vlog.doc(run.id).steps.some((s) => s.kind !== "agent")) this.vlog.nextRound(run.id);
        const before = this.store.getRun(run.id)!;
        if (this.overBudget(before, this.runTotal(run.id))) {
          await this.holdForBudget(before, this.runTotal(run.id));
          return false;
        }
        const agentStep = this.vlog.startStep(
          run.id,
          "agent",
          first
            ? "Agent makes the change"
            : pending.author === "feedback"
              ? "Agent fixes the issues found"
              : pending.author === "answer"
                ? "Agent continues with your answer"
                : pending.author === "operator"
                  ? "Agent works on your message"
                  : "Agent continues",
        );
        const settled = await this.pi.ask(
          run.conversationId!,
          this.agentMessage(pending.text, pending.author, pending.attachmentIds),
          pending.requestId,
          "followUp",
          pending.messageIds ?? [],
        );
        await this.settleInflight(run.id);
        const missed = await this.missedNotes(run);
        const after = this.store.getRun(run.id)!;
        if (after.paused || !isActivePhase(after.phase)) return false;
        if (settled.status !== "done" && this.store.setting(`budgetHold:${run.id}`, false)) {
          this.vlog.finishStep(run.id, agentStep, "waiting", { detail: "Stopped at the run budget; waiting for your decision" });
          return false;
        }
        if (settled.status !== "done" && this.store.setting(`switching:${run.id}`, false)) {
          this.store.setSetting(`switching:${run.id}`, false);
          this.vlog.finishStep(run.id, agentStep, "skipped", { detail: "Moved to a new session" });
          return true;
        }
        if (settled.status !== "done") {
          this.vlog.finishStep(run.id, agentStep, "failed", { detail: settled.reason ?? "No answer" });
          throw new Error(`Agent stopped without an answer: ${settled.reason ?? "unknown"}`);
        }
        if (settled.terminated && after.phase === "needs_info") {
          this.vlog.finishStep(run.id, agentStep, "waiting", { detail: "The agent asked you a question" });
          return false;
        }
        this.vlog.finishStep(run.id, agentStep, "passed", { detail: (settled.answer ?? "").slice(0, 600) });
        this.setPending(run.id, null);
        if (settled.answer) this.store.setSetting(`summary:${run.id}`, settled.answer);
        if (missed.length) {
          this.queueMessages(after, missed, "operator");
          this.event(run.id, "info", "Your message arrived as the agent finished; sending it now");
          return true;
        }
        this.event(run.id, "agent", settled.answer ?? "Agent finished");
        this.update(run.id, { phase: "checking", activity: "Running checks" });
        return true;
      }
      case "checking": {
        if (await this.checkDeletions(run)) return false;
        const queued = this.undelivered(run);
        if (queued.length) {
          this.queueMessages(run, queued, "operator");
          this.update(run.id, { phase: "working", activity: "Reading your message" });
          return true;
        }
        const failures = await this.runLocalChecks(run);
        if (failures) {
          const round = this.store.setting<number>(`localRound:${run.id}`, 0) + 1;
          this.store.setSetting(`localRound:${run.id}`, round);
          if (this.loopLimitReached(run)) return this.askLoopLimit(run);
          const checkIssues = this.vlog.openBlocking(run.id).filter((i) => i.source === "check");
          this.setPending(run.id, {
            requestId: `${run.id}:local:${round}`,
            author: "feedback",
            text: checkIssues.length ? this.issuesPrompt(checkIssues) : localChecksPrompt(failures, round),
            attachmentIds: [],
          });
          this.update(run.id, { phase: "fixing", activity: "Fixing failed checks" });
          return true;
        }
        const hasTesters = (ctx.project.testers ?? []).some((t) => t.enabled && t.when !== "manual");
        if (hasTesters || ((ctx.project.review ?? false) && this.store.setting<number>(`reviewRound:${run.id}`, 0) < MAX_REVIEW_ROUNDS)) {
          this.update(run.id, { phase: "reviewing", activity: "Testing and reviewing the change" });
          return true;
        }
        this.update(run.id, { phase: "pushing", activity: "Committing and pushing" });
        return true;
      }
      case "reviewing": {
        return this.verify(run);
      }
      case "pushing": {
        if ((ctx.project.pushMode ?? "auto") === "approve" && !(await this.pushApproved(run))) return false;
        await this.pushAndOpenPr(run);
        return false;
      }
      default:
        return false;
    }
  }

  private queueMessages(run: Run, messages: StoredMessage[], author: TranscriptAuthor) {
    const last = messages.at(-1)!;
    this.setPending(run.id, {
      requestId: `${run.id}:msg:${last.id}`,
      author,
      text: messages.map((m) => m.text).join("\n\n") || "(see attached pictures)",
      attachmentIds: messages.flatMap((m) => m.attachmentIds),
      messageIds: messages.map((m) => m.id),
    });
    this.store.markMessagesDelivered(messages.map((m) => m.id), run.id);
  }

  private noted = new Map<string, string[]>();

  private async missedNotes(run: Run): Promise<StoredMessage[]> {
    const ids = this.noted.get(run.id) ?? [];
    this.noted.delete(run.id);
    if (!ids.length || !run.conversationId) return [];
    const missed: StoredMessage[] = [];
    const all = this.store.taskMessages(run.projectId, run.taskId);
    for (const id of ids) {
      const seen = await this.pi.seen(run.conversationId, id).catch(() => null);
      const m = all.find((x) => x.id === id);
      if (seen === false && m) missed.push(m);
    }
    return missed;
  }

  private async review(run: Run): Promise<{ blocking: Issue[]; decisions: Decision[]; stop: boolean }> {
    const ctx = this.runCtx(run);
    const round = this.store.setting<number>(`reviewRound:${run.id}`, 0) + 1;
    const step = this.vlog.startStep(run.id, "review", `AI review (round ${round})`, this.label(this.reviewModelFor(ctx.project)));
    let reviewer = this.store.setting<string | null>(`reviewer:${run.id}`, null);
    if (!reviewer) {
      reviewer = await this.pi.createReviewer({
        model: this.reviewModelFor(ctx.project),
        cwd: run.worktree,
        instructions: [
          "You are a strict senior code reviewer. You never edit files; you only read code and run read-only commands (git diff, git log, cat, grep, tests).",
          `Review the change on this branch against ${ctx.project.repo.remote}/${this.baseOf(run)}: correctness bugs, missed requirements of the task, broken edge cases, security problems, missing tests, and code that does not follow the repository's conventions.`,
          `If there is nothing that must change, answer exactly: ${REVIEW_PASS}`,
          'Otherwise answer with a JSON block: {"findings": [{"title": "...", "detail": "what is wrong and how to fix it", "severity": "blocker|major|minor|info", "file": "path", "line": 12, "decision": {"question": "...", "options": ["...", "..."]}}]}. Add "decision" only when the fix needs a product or design decision from the task owner instead of a code fix.',
        ].join("\n"),
      });
      this.store.setSetting(`reviewer:${run.id}`, reviewer);
      this.store.setSetting(`reviewerConv:${reviewer}`, run.id);
    }
    const task = await ctx.source.getTask(run.taskId);
    const result = await this.pi.ask(
      reviewer,
      {
        text: `Task ${task.id}: ${task.title}\n\n${task.body}${this.ownerInstructions(run)}${this.reviewFocus(run)}\n\nReview round ${round}. Run \`git diff ${ctx.project.repo.remote}/${this.baseOf(run)}...HEAD\` and review it. Never ask for work the owner requested to be removed.`,
        author: "system",
      },
      `${run.id}:review:${round}`,
    );
    this.store.recordModelUsage(run.id, await this.runner.usage(reviewer), "review");
    await exec("git", ["reset", "--hard", "--quiet", "HEAD"], { cwd: run.worktree });
    await exec("git", ["clean", "-fdq"], { cwd: run.worktree });
    this.store.setSetting(`reviewRound:${run.id}`, round);
    const after = this.store.getRun(run.id)!;
    if (after.paused || !isActivePhase(after.phase)) {
      this.vlog.finishStep(run.id, step, "skipped");
      return { blocking: [], decisions: [], stop: true };
    }
    const answer = result.answer?.trim() ?? "";
    if (result.status !== "done" || !answer || answer.toUpperCase().includes(REVIEW_PASS)) {
      this.event(run.id, "review", result.status !== "done" ? `Reviewer did not answer (${result.reason ?? "unknown"}); continuing` : "Reviewer: no further findings");
      this.vlog.reconcile(run.id, "review", "AI reviewer", []);
      this.vlog.finishStep(run.id, step, result.status === "done" ? "passed" : "skipped", { detail: result.status === "done" ? "No further findings" : "The reviewer did not answer" });
      return { blocking: [], decisions: [], stop: false };
    }
    this.event(run.id, "review", `Reviewer findings (round ${round}):\n${answer}`);
    const outcome = this.recordFindings(run, "review", "AI reviewer", parseReviewAnswer(answer));
    this.vlog.finishStep(run.id, step, outcome.blocking.length || outcome.decisions.length ? "failed" : "passed", {
      detail: `${outcome.issues.length} finding(s)`,
      output: answer,
      issueIds: outcome.issues.map((i) => i.id),
    });
    return { blocking: outcome.blocking, decisions: outcome.decisions, stop: false };
  }

  private recordFindings(run: Run, source: Issue["source"], sourceName: string, findings: Finding[]) {
    const issues = this.vlog.reconcile(run.id, source, sourceName, findings);
    const decisions: Decision[] = [];
    findings.forEach((f, i) => {
      const issue = issues.find((x) => x.title === f.title) ?? issues[i];
      if (f.decision && issue && issue.status !== "dismissed") {
        decisions.push(
          this.vlog.addDecision(run.id, {
            kind: "finding",
            question: f.decision.question,
            context: `${sourceName}: ${f.title}${f.detail ? `\n\n${f.detail}` : ""}`,
            options: f.decision.options,
            source: sourceName,
            issueId: issue.id,
          }),
        );
      }
    });
    const blocking = issues.filter((i) => i.status === "open" && (i.severity === "blocker" || i.severity === "major"));
    return { issues, blocking, decisions };
  }

  private testerEnv(run: Run, task: { title: string; body: string }) {
    return {
      ...this.workspace.env(run.projectId, run.taskId),
      NIGHTSHIFT_WORKTREE: run.worktree,
      NIGHTSHIFT_BASE: this.baseOf(run),
      NIGHTSHIFT_BRANCH: run.branch,
      NIGHTSHIFT_TASK: `${task.title}\n\n${task.body}`.trim(),
      NIGHTSHIFT_TASK_ID: run.taskId,
      NIGHTSHIFT_REMOTE: this.runCtx(run).project.repo.remote,
      // Testers shipped with Nightshift (e.g. umbra-server.mjs) and the node running Nightshift, for commands that use them.
      NIGHTSHIFT_TESTERS: TESTERS_DIR,
      NIGHTSHIFT_NODE: process.execPath,
    };
  }

  /** Running testers by step id, so the owner (or pausing/stopping the task) can stop them. */
  private readonly testerRuns = new Map<string, { runId: string; testerId: string; controller: AbortController }>();
  /** Queued testers (same `queue` name): who runs now and who waits, across all tasks and projects. */
  private readonly testerQueues = new Map<string, TesterQueue>();

  /** Waits for a turn in `queue`; resolves with a release function, or null when `signal` aborts first. `onWait` hears who runs and how many wait ahead. */
  private acquireTesterQueue(queue: string, label: string, signal: AbortSignal, onWait: (holder: string, ahead: number) => void): Promise<(() => void) | null> {
    const q = this.testerQueues.get(queue) ?? { holder: null, waiters: [] };
    this.testerQueues.set(queue, q);
    const tell = () => q.waiters.forEach((w, i) => w.onWait(q.holder ?? "", i));
    const release = () => {
      const next = q.waiters.shift();
      q.holder = next?.label ?? null;
      next?.grant();
      tell();
    };
    if (q.holder === null) {
      q.holder = label;
      return Promise.resolve(release);
    }
    return new Promise((resolve) => {
      const waiter: TesterQueue["waiters"][number] = { label, onWait, grant: () => resolve(release) };
      q.waiters.push(waiter);
      tell();
      signal.addEventListener(
        "abort",
        () => {
          const i = q.waiters.indexOf(waiter);
          if (i < 0) return;
          q.waiters.splice(i, 1);
          tell();
          resolve(null);
        },
        { once: true },
      );
    });
  }

  /** Stops the task's running (or queued) runs of a tester. */
  stopTester(projectId: string, taskId: string, testerId: string): { stopped: number } {
    const run = this.store.latestRunForTask(projectId, taskId);
    const mine = [...this.testerRuns.values()].filter((t) => t.runId === run?.id && t.testerId === testerId);
    if (!mine.length) throw Object.assign(new Error("This tester is not running for this task"), { status: 409 });
    for (const t of mine) t.controller.abort("Stopped by you");
    return { stopped: mine.length };
  }

  private stopTestersOf(runId: string, reason: string) {
    for (const t of this.testerRuns.values()) if (t.runId === runId) t.controller.abort(reason);
  }

  async runTester(run: Run, tester: TesterConfig): Promise<{ blocking: Issue[]; decisions: Decision[]; stopped?: boolean; error?: string }> {
    const ctx = this.runCtx(run);
    const task = await ctx.source.getTask(run.taskId);
    const step = this.vlog.startStep(run.id, "external", tester.name, tester.command, tester.id);
    const controller = new AbortController();
    this.testerRuns.set(step, { runId: run.id, testerId: tester.id, controller });
    let release: (() => void) | null = null;
    let res: { code: number; stdout: string; stderr: string };
    try {
      if (tester.queue) {
        const label = `${run.taskId} (${ctx.project.name})`;
        release = await this.acquireTesterQueue(tester.queue, label, controller.signal, (holder, ahead) =>
          this.vlog.noteStep(run.id, step, `Waiting: ${holder} is running a "${tester.queue}" tester${ahead ? `, ${ahead} more ahead` : ""}. It starts when they finish.`),
        );
        this.vlog.noteStep(run.id, step, null);
      }
      res = controller.signal.aborted
        ? { code: -1, stdout: "", stderr: "" }
        : await exec("sh", ["-c", tester.command], { cwd: run.worktree, timeoutMs: tester.timeoutMs ?? 30 * 60_000, env: this.testerEnv(run, task), signal: controller.signal, group: true });
    } finally {
      release?.();
      this.testerRuns.delete(step);
    }
    if (controller.signal.aborted) {
      const reason = String(controller.signal.reason ?? "Stopped");
      this.vlog.finishStep(run.id, step, "skipped", { detail: reason, output: `$ ${tester.command}\n${res.stdout}\n${res.stderr}`.trim() });
      this.event(run.id, "info", `${tester.name}: ${reason.toLowerCase()}`);
      return { blocking: [], decisions: [], stopped: true };
    }
    const parsed = parseTesterOutput(tester.format, tester.name, res.stdout, res.stderr, res.code);
    const output = `$ ${tester.command}\n${res.stdout}\n${res.stderr}`.trim();
    if (!parsed.ranOk) {
      this.vlog.finishStep(run.id, step, "failed", { detail: `Could not run: ${parsed.error}`, output });
      this.event(run.id, "error", `${tester.name} could not run: ${parsed.error}`);
      return { blocking: [], decisions: [], error: parsed.error ?? "it did not run" };
    }
    const outcome = this.recordFindings(run, "external", tester.name, parsed.findings);
    const blocking = tester.blocking ? outcome.blocking : [];
    this.vlog.finishStep(run.id, step, blocking.length || outcome.decisions.length ? "failed" : "passed", {
      detail: `${parsed.summary}${outcome.issues.length ? ` · ${outcome.issues.length} finding(s)` : ""}${!tester.blocking && outcome.blocking.length ? " (not blocking)" : ""}`,
      output,
      issueIds: outcome.issues.map((i) => i.id),
    });
    this.event(run.id, "review", `${tester.name}: ${parsed.summary}${outcome.issues.length ? ` — ${outcome.issues.length} finding(s)` : ""}`);
    return { blocking, decisions: outcome.decisions };
  }

  private loopLimitReached(run: Run) {
    const allowance = this.store.setting<number>(`roundAllowance:${run.id}`, 0);
    return this.vlog.round(run.id) > this.budgets.maxFixRounds + allowance;
  }

  private async askLoopLimit(run: Run): Promise<boolean> {
    const open = this.vlog.openBlocking(run.id);
    this.vlog.addDecision(run.id, {
      kind: "loop-limit",
      question: `The agent has used ${this.vlog.round(run.id) - 1} fix rounds and ${open.length || "some"} issue(s) are still open. What should it do?`,
      context: open.map((i) => `- [${i.sourceName}] ${i.title}`).join("\n") || "Checks are still failing.",
      options: ["Keep fixing (3 more rounds)", "Open the PR with the open issues", "Stop the task"],
      source: "Nightshift",
    });
    await this.pauseForDecisions(run);
    return false;
  }

  private async askSetup(run: Run, dir: string, setup: string, output: string) {
    const diagnosis = await diagnoseSetup(this.deps.summarize ?? null, dir, setup, output);
    this.store.setSetting(`setupFix:${run.id}`, { command: diagnosis.command, failed: setup, output: tailLines(output, 3000) });
    this.event(run.id, "error", `Setup failed: ${diagnosis.summary}`);
    this.vlog.addDecision(run.id, {
      kind: "setup",
      question: `Setup failed: ${diagnosis.summary}`,
      context: [
        diagnosis.cause,
        diagnosis.command ? `\nSuggested setup command:\n${diagnosis.command}` : "",
        `\nSetup command that failed:\n${setup}`,
        `\nLast output:\n${tailLines(output, 1500)}`,
      ]
        .filter(Boolean)
        .join("\n"),
      options: [...(diagnosis.command ? ["Apply the fix and retry"] : []), "Skip setup this time", "Ask the agent to fix the setup", "Stop the task"],
      source: diagnosis.source === "ai" ? "Nightshift (AI diagnosis)" : "Nightshift",
    });
    await this.pauseForDecisions(this.store.getRun(run.id)!);
  }

  private resumePreparing(run: Run): string {
    void this.setTaskStatus(run.id, "in_progress", `:setup:${Date.now()}`);
    this.update(run.id, { phase: "preparing", slot: this.freeSlot(), lastCommentSeenAt: new Date().toISOString(), activity: "Setting up the workspace" });
    void this.drive(run.id);
    return "The task continues now.";
  }

  private setupNotePrompt(run: Run) {
    const note = this.store.setting<string | null>(`setupNote:${run.id}`, null);
    return note ? `\n\n## Fix the workspace setup first\n\n${note}` : "";
  }

  private async pauseForDecisions(run: Run) {
    const open = this.vlog.openDecisions(run.id);
    if (!open.length) return;
    const ids = open.map((d) => d.id).join(",");
    await this.comment(run.id, `decisions:${run.id}:${ids}`, `Decision needed:\n\n${open.map((d) => `- ${d.question}${d.options.length ? ` (${d.options.join(" / ")})` : ""}`).join("\n")}`);
    await this.setTaskStatus(run.id, "needs_info", `:decision:${ids}`);
    this.update(run.id, { phase: "needs_info", slot: null, lastCommentSeenAt: new Date().toISOString(), activity: "Waiting for your decision" });
    this.event(run.id, "question", open.map((d) => d.question).join("\n"));
  }

  private reviewFocus(run: Run) {
    const info = taskTypeInfo(this.taskTypeOf(run.projectId, run.taskId));
    return info ? `\n\nThis task is a ${info.label.toLowerCase()}. Check especially:\n${info.review.map((r) => `- ${r}`).join("\n")}` : "";
  }

  private issuesPrompt(issues: Issue[]) {
    return [
      "These problems were found in your change. Fix them, run the checks, then reply with a short summary of what you changed.",
      "",
      ...issues.map((i, n) => `${n + 1}. [${i.sourceName}] [${i.severity}] ${i.title}${i.file ? ` (${i.file}${i.line ? `:${i.line}` : ""})` : ""}${i.detail && i.detail !== i.title ? `\n   ${i.detail.split("\n").join("\n   ")}` : ""}`),
    ].join("\n");
  }

  /** A required tester could not run: hold the PR and ask the owner. */
  private async askTesterFailed(run: Run, tester: TesterConfig, error: string, head: string): Promise<boolean> {
    this.store.setSetting(`testerAsk:${run.id}`, { testerId: tester.id, head });
    for (const d of this.vlog.openDecisions(run.id)) if (d.kind === "tester") this.vlog.answerDecision(run.id, d.id, "Superseded by a newer run");
    this.vlog.addDecision(run.id, {
      kind: "tester",
      question: `${tester.name} could not run, and this project holds the PR until it has. What now?`,
      context: error.slice(-3000),
      options: ["Run it again", "Skip it for this change", "Stop the task"],
      source: tester.name,
    });
    await this.pauseForDecisions(this.store.getRun(run.id)!);
    return false;
  }

  private async verify(run: Run): Promise<boolean> {
    const ctx = this.runCtx(run);
    const summary = this.store.setting<string | null>(`summary:${run.id}`, null);
    const commits = this.store.setting<number>(`pushRound:${run.id}`, 0) + (await ctx.workspaces.aheadOfBase(run.worktree, this.baseOf(run)));
    const subject = commits === 0 ? `${run.taskId}: ${run.taskTitle}` : `${run.taskId}: address findings (round ${this.vlog.round(run.id)})`;
    await ctx.workspaces.commitAll(run.worktree, `${subject}\n\n${summary ?? ""}`.trim());
    const testers = (ctx.project.testers ?? []).filter((t) => t.enabled);
    const handle = async (blocking: Issue[], decisions: Decision[]): Promise<boolean | null> => {
      if (decisions.length || this.vlog.openDecisions(run.id).length) {
        await this.pauseForDecisions(run);
        return false;
      }
      if (blocking.length) {
        if (this.loopLimitReached(run)) return this.askLoopLimit(run);
        this.setPending(run.id, { requestId: `${run.id}:fix:${this.vlog.round(run.id)}:${blocking.map((b) => b.id.slice(0, 4)).join("")}`, author: "feedback", text: this.issuesPrompt(blocking), attachmentIds: [] });
        this.update(run.id, { phase: "fixing", activity: `Fixing ${blocking.length} issue(s)` });
        return true;
      }
      return null;
    };
    // A tester stopped because the task was paused or stopped ends this pass; one the owner stopped alone is skipped.
    const halted = (r: { stopped?: boolean }) => {
      if (!r.stopped) return false;
      const fresh = this.store.getRun(run.id);
      return !fresh || fresh.paused || !isActivePhase(fresh.phase);
    };
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: run.worktree })).stdout.trim();
    // A required tester the owner chose to skip for this commit is not run again until the code changes.
    const skipped = (t: TesterConfig) => {
      if (this.store.setting<string | null>(`testerSkip:${run.id}:${t.id}`, null) !== head) return false;
      const step = this.vlog.startStep(run.id, "external", t.name, t.command, t.id);
      this.vlog.finishStep(run.id, step, "skipped", { detail: "Skipped by you for this change" });
      return true;
    };
    for (const t of testers.filter((x) => x.when === "every-round")) {
      if (skipped(t)) continue;
      this.update(run.id, { activity: `Running ${t.name}` });
      const r = await this.runTester(run, t);
      if (halted(r)) return false;
      if (r.error && t.onError === "ask") return this.askTesterFailed(run, t, r.error, head);
      const h = await handle(r.blocking, r.decisions);
      if (h !== null) return h;
    }
    if ((ctx.project.review ?? false) && this.store.setting<number>(`reviewRound:${run.id}`, 0) < MAX_REVIEW_ROUNDS) {
      this.update(run.id, { activity: "AI reviewer is checking the change" });
      const r = await this.review(run);
      if (r.stop) return false;
      const h = await handle(r.blocking, r.decisions);
      if (h !== null) return h;
    }
    for (const t of testers.filter((x) => x.when === "before-pr")) {
      if (skipped(t)) continue;
      this.update(run.id, { activity: `Running ${t.name}` });
      const r = await this.runTester(run, t);
      if (halted(r)) return false;
      if (r.error && t.onError === "ask") return this.askTesterFailed(run, t, r.error, head);
      const h = await handle(r.blocking, r.decisions);
      if (h !== null) return h;
    }
    this.update(run.id, { phase: "pushing", activity: "Committing and pushing" });
    return true;
  }

  private async runLocalChecks(run: Run): Promise<string | null> {
    const checks = this.runCtx(run).project.checks;
    if (checks.length === 0) return null;
    const baseline = this.store.setting<Record<string, boolean>>(`baseline:${run.id}`, {});
    const failed: string[] = [];
    const step = this.vlog.startStep(run.id, "checks", `Repository checks (${checks.map((c) => c.name).join(", ")})`);
    const outputs: string[] = [];
    const issueIds: string[] = [];
    for (const check of checks) {
      const res = await exec("sh", ["-c", check.command], { cwd: run.worktree, timeoutMs: check.timeoutMs ?? 600_000, env: this.workspace.env(run.projectId, run.taskId), group: true });
      const ok = res.code === 0;
      const preExisting = !ok && baseline[check.name] === false;
      this.workspace.recordCheck(run.id, {
        id: `${run.id}:check:${check.name}:${Date.now()}`,
        name: check.name,
        ok,
        output: `${res.stdout}\n${res.stderr}`.trim().split("\n").slice(-400).join("\n"),
        at: new Date().toISOString(),
        sha: null,
        preExisting,
      });
      this.event(run.id, "info", `Check ${check.name}: ${ok ? "pass" : preExisting ? "fail (already failing on base, not blocking)" : "fail"}`);
      const tail = `${res.stdout}\n${res.stderr}`.trim().split("\n").slice(-80).join("\n");
      outputs.push(`## ${check.name}: ${ok ? "PASS" : preExisting ? "FAIL (already failing on the base branch, not blocking)" : `FAIL (exit ${res.code})`}\n$ ${check.command}\n${tail}`);
      const issues = this.vlog.reconcile(run.id, "check", check.name, !ok && !preExisting ? [{ title: `${check.name} fails`, detail: tail, severity: "blocker" }] : []);
      issueIds.push(...issues.map((i) => i.id));
      if (!ok && !preExisting) failed.push(`## ${check.name} (exit ${res.code})\n${tail}`);
    }
    this.vlog.finishStep(run.id, step, failed.length ? "failed" : "passed", {
      detail: failed.length ? `${failed.length} of ${checks.length} check(s) failing` : `All ${checks.length} check(s) pass`,
      output: outputs.join("\n\n"),
      issueIds,
    });
    return failed.length ? failed.join("\n\n") : null;
  }

  private async commitWork(run: Run): Promise<string | null> {
    const ws = this.runCtx(run).workspaces;
    const summary = this.store.setting<string | null>(`summary:${run.id}`, null);
    const round = this.store.setting<number>(`commitRound:${run.id}`, this.store.setting<number>(`pushRound:${run.id}`, 0));
    const message = round === 0 ? `${run.taskId}: ${run.taskTitle}` : `${run.taskId}: follow-up (round ${round})`;
    const sha = await ws.commitAll(run.worktree, `${message}\n\n${summary ?? ""}`.trim());
    if (sha) this.store.setSetting(`commitRound:${run.id}`, round + 1);
    return sha;
  }

  private async pushApproved(run: Run): Promise<boolean> {
    const ws = this.runCtx(run).workspaces;
    await this.commitWork(run);
    if ((await ws.aheadOfBase(run.worktree, this.baseOf(run))) === 0) throw new Error("The agent finished without changing any files");
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: run.worktree })).stdout.trim();
    if (this.store.setting<string | null>(`pushApproved:${run.id}`, null) === head) return true;
    const remoteHead = await ws.remoteHead(run.branch);
    if (run.prNumber && remoteHead === head) return true;
    const remote = this.runCtx(run).project.repo.remote;
    const since = remoteHead ? remoteHead : `${remote}/${this.baseOf(run)}`;
    const log = (await exec("git", ["log", "--format=%h %s", `${since}..HEAD`], { cwd: run.worktree })).stdout.trim();
    const count = log ? log.split("\n").length : 0;
    const stat = (await exec("git", ["diff", "--stat", `${since}..HEAD`], { cwd: run.worktree })).stdout.trim();
    for (const d of this.vlog.openDecisions(run.id)) if (d.kind === "push") this.vlog.answerDecision(run.id, d.id, "Superseded by a newer change");
    const plural = count === 1 ? "" : "s";
    this.vlog.addDecision(run.id, {
      kind: "push",
      question: run.prNumber ? `Push ${count} new commit${plural} to pull request #${run.prNumber}?` : `Push ${count} commit${plural} and open the pull request?`,
      context: [`Committed on this Mac, not pushed yet (${run.branch}):`, log, "", stat, "", "Not ready? Answer with what to change and the agent keeps working, or choose \"Don't push yet\" to hold it until you message the agent."].join("\n").trim(),
      options: [run.prNumber ? "Push to the pull request" : "Push and open the pull request", "Don't push yet"],
      source: "Nightshift",
    });
    this.store.setSetting(`pushAsk:${run.id}`, head);
    const step = this.vlog.startStep(run.id, "push", "Waiting for your approval to push");
    this.vlog.finishStep(run.id, step, "waiting", { detail: `${count} commit${plural} committed on this Mac`, output: log });
    await this.pauseForDecisions(this.store.getRun(run.id)!);
    return false;
  }

  private async pushAndOpenPr(run: Run) {
    const ctx = this.runCtx(run);
    const ws = ctx.workspaces;
    const summary = this.store.setting<string | null>(`summary:${run.id}`, null);
    const round = this.store.setting<number>(`pushRound:${run.id}`, 0);
    await this.commitWork(run);
    if ((await ws.aheadOfBase(run.worktree, this.baseOf(run))) === 0) throw new Error("The agent finished without changing any files");
    const { pushed, sha } = await ws.push(run.worktree, run.branch);
    this.store.setSetting(`pushRound:${run.id}`, round + 1);
    this.event(run.id, "pr", pushed ? `Pushed ${sha.slice(0, 8)}` : `Branch already at ${sha.slice(0, 8)}`);
    if (pushed || !this.store.setting<number | null>(`pushedAt:${run.id}`, null)) this.store.setSetting(`pushedAt:${run.id}`, Date.now());
    let pr = await ctx.prHost.findOpen(run.branch);
    if (!pr) {
      const task = await ctx.source.getTask(run.taskId);
      pr = await ctx.prHost.create({
        branch: run.branch,
        base: this.baseOf(run),
        title: `${run.taskId}: ${run.taskTitle}`,
        body: prBody(
          task,
          summary,
          await ws.diffStat(run.worktree, this.baseOf(run)),
          Object.entries(this.store.setting<Record<string, boolean>>(`baseline:${run.id}`, {}))
            .filter(([, ok]) => !ok)
            .map(([name]) => name),
        ),
      });
      this.event(run.id, "pr", `Opened PR #${pr.number}`, { url: pr.url });
    }
    const pushStep = this.vlog.startStep(run.id, "push", round === 0 ? "Push and open the pull request" : "Push the fixes");
    this.vlog.finishStep(run.id, pushStep, "passed", { detail: `${pushed ? `Pushed ${sha.slice(0, 8)}` : `Branch already at ${sha.slice(0, 8)}`} · PR #${pr.number}` });
    if (round > 0) this.vlog.resolveSource(run.id, "pr-comment");
    this.update(run.id, { prNumber: pr.number, prUrl: pr.url, headSha: sha, phase: "waiting_ci", slot: null, activity: "Waiting for CI and review" });
    await this.comment(run.id, `pr-link:${run.id}`, `Pull request opened: ${pr.url}`);
  }

  private async watchPrs() {
    for (const run of this.store.runsInPhases(["waiting_ci", "ready_for_review"])) {
      if (run.paused || !run.prNumber || !this.projects.has(run.projectId)) continue;
      const ctx = this.runCtx(run);
      try {
        const status = await ctx.prHost.status(run.prNumber);
        if (status.state === "merged") {
          await this.setTaskStatus(run.id, "done");
          await this.comment(run.id, `merged:${run.id}`, `Pull request merged: ${run.prUrl}`);
          this.update(run.id, { phase: "done", activity: null });
          await this.releaseLease(run.id);
          continue;
        }
        if (status.state === "closed") {
          await this.comment(run.id, `closed:${run.id}`, `Pull request was closed without merging: ${run.prUrl}`);
          this.update(run.id, { phase: "stopped", activity: null });
          await this.releaseLease(run.id);
          continue;
        }
        if (status.headSha && run.headSha && status.headSha !== run.headSha) continue;
        const triggers = this.triggersOf(ctx.project);
        const seen = run.lastCommentSeenAt ?? run.createdAt;
        const reviews = triggers.prFeedback.enabled ? status.reviews.filter((r) => r.submittedAt > seen && (r.state === "CHANGES_REQUESTED" || (r.body ?? "").trim())) : [];
        const comments = triggers.prFeedback.enabled ? status.comments.filter((c) => c.createdAt > seen) : [];
        const checkState = summarizeChecks(status.checks);
        const failing = checkState === "failure" && triggers.ciFailures.enabled ? status.checks.filter((c) => c.state === "failure") : [];
        const ciKey = `ciState:${run.id}:${status.headSha}`;
        if (checkState !== "pending" && checkState !== "neutral" && this.store.setting<string | null>(ciKey, null) !== checkState) {
          this.store.setSetting(ciKey, checkState);
          const step = this.vlog.startStep(run.id, "ci", `CI on ${status.headSha?.slice(0, 8) ?? "the PR"}`);
          const ciIssues: Issue[] = [];
          for (const c of status.checks) ciIssues.push(...this.vlog.reconcile(run.id, "ci", c.name, c.state === "failure" ? [{ title: `${c.name} fails on CI`, detail: c.summary ?? c.detailsUrl ?? "", severity: "blocker" }] : []));
          this.vlog.finishStep(run.id, step, checkState === "failure" ? "failed" : "passed", {
            detail: status.checks.map((c) => `${c.name}: ${c.state}`).join(", "),
            issueIds: ciIssues.map((i) => i.id),
          });
        }
        for (const r of reviews) this.vlog.reconcile(run.id, "pr-comment", `Review ${r.id}`, [{ title: (r.body || r.state).split("\n")[0].slice(0, 200), detail: `${r.author}: ${r.body || r.state}`, severity: "major" }]);
        for (const c of comments) this.vlog.reconcile(run.id, "pr-comment", `Comment ${c.id}`, [{ title: c.body.split("\n")[0].slice(0, 200), detail: `${c.author}${c.path ? ` on ${c.path}${c.line ? `:${c.line}` : ""}` : ""}: ${c.body}`, severity: "major", ...(c.path ? { file: c.path } : {}), ...(c.line ? { line: c.line } : {}) }]);
        if ((reviews.length || comments.length) && run.prNumber) this.triggerEvent(ctx.project.id, { kind: "pr-feedback", ref: `PR #${run.prNumber}`, url: run.prUrl ?? undefined, taskId: run.taskId, note: `${reviews.length + comments.length} new review item(s) sent to the running task` });
        const handledKey = `handled:${run.id}:${status.headSha}`;
        if (failing.length && !reviews.length && !comments.length && this.store.setting(handledKey, false)) {
          await this.fail(run.id, `CI still fails on ${status.headSha?.slice(0, 8)} and the agent's last fix did not change the code; a human needs to look`);
          continue;
        }
        if (failing.length || reviews.length || comments.length) {
          const slot = this.freeSlot();
          if (slot === null) continue;
          if (run.fixRounds >= this.budgets.maxFixRounds) {
            await this.fail(run.id, `Still failing after ${run.fixRounds} fix rounds`);
            continue;
          }
          const logs = await Promise.all(failing.map(async (check) => ({ check, log: await ctx.prHost.failureLog(check).catch(() => null) })));
          const round = run.fixRounds + 1;
          if (failing.length) this.store.setSetting(handledKey, true);
          const newest = [...reviews.map((r) => r.submittedAt), ...comments.map((c) => c.createdAt)].sort().at(-1) ?? seen;
          this.setPending(run.id, { requestId: `${run.id}:pr-feedback:${round}`, author: "feedback", text: feedbackPrompt({ failing: logs, reviews, comments }), attachmentIds: [] });
          if (failing.length) this.event(run.id, "ci", `CI failed: ${failing.map((f) => f.name).join(", ")}`);
          if (reviews.length || comments.length) this.event(run.id, "review", `${reviews.length + comments.length} new review item(s)`);
          await this.setTaskStatus(run.id, "in_progress", `:pr:${round}`);
          this.update(run.id, { phase: "fixing", fixRounds: round, slot, lastCommentSeenAt: newest, activity: "Addressing PR feedback" });
          void this.drive(run.id);
          continue;
        }
        const pushedAt = this.store.setting<number>(`pushedAt:${run.id}`, 0);
        if (checkState === "neutral" && Date.now() - pushedAt < this.config.intervalsMs.ciGrace) continue;
        if (run.phase === "waiting_ci" && (checkState === "success" || checkState === "neutral")) {
          this.event(run.id, "ci", checkState === "success" ? "CI passed" : "No CI checks reported");
          const n = this.store.setting<number>(`pushRound:${run.id}`, 0);
          await this.setTaskStatus(run.id, "ready_for_review", `:${n}`);
          await this.comment(run.id, `ready:${run.id}:${n}`, `Ready for review: ${run.prUrl}`);
          this.update(run.id, { phase: "ready_for_review", activity: "Waiting for human review" });
        }
      } catch (error) {
        this.log(`watch PR ${run.id}: ${String(error)}`);
      }
    }
  }

  private async watchAnswers() {
    for (const run of this.store.runsInPhases(["needs_info"])) {
      if (run.paused || !this.projects.has(run.projectId)) continue;
      try {
        const comments = await this.runCtx(run).source.listComments(run.taskId);
        const seen = run.lastCommentSeenAt ?? run.createdAt;
        const answers = comments.filter((c: TaskComment) => !c.authorIsAgent && c.createdAt > seen);
        if (!answers.length) continue;
        const slot = this.freeSlot();
        if (slot === null) continue;
        const last = answers.at(-1)!;
        this.vlog.answerOpenDecisions(run.id, answers.map((a) => a.body).join("\n"));
        this.event(run.id, "answer", answers.map((a) => `${a.author}: ${a.body}`).join("\n"));
        this.setPending(run.id, { requestId: `${run.id}:answer:${last.id}`, author: "answer", text: answerPrompt(answers), attachmentIds: [] });
        await this.setTaskStatus(run.id, "in_progress", `:answer:${last.id}`);
        this.update(run.id, { phase: "working", slot, lastCommentSeenAt: last.createdAt, activity: "Continuing with the answer" });
        void this.drive(run.id);
      } catch (error) {
        this.log(`watch answers ${run.id}: ${String(error)}`);
      }
    }
  }

  private async deliverQueued() {
    for (const run of this.store.runsInPhases(["needs_info", "waiting_ci", "ready_for_review"])) {
      if (run.paused || !this.projects.has(run.projectId)) continue;
      const queued = this.undelivered(run);
      if (!queued.length) continue;
      const slot = this.freeSlot();
      if (slot === null) return;
      if (run.phase === "needs_info") {
        this.vlog.answerOpenDecisions(run.id, queued.map((m) => m.text).join("\n"));
        this.queueMessages(run, queued, "answer");
        this.event(run.id, "answer", queued.map((m) => m.text).join("\n"));
        await this.setTaskStatus(run.id, "in_progress", `:answer:${queued.at(-1)!.id}`);
        this.update(run.id, { phase: "working", slot, lastCommentSeenAt: new Date().toISOString(), activity: "Continuing with your answer" });
      } else {
        this.queueMessages(run, queued, "operator");
        this.event(run.id, "review", "New round requested by the operator");
        await this.setTaskStatus(run.id, "in_progress", `:msg:${queued.at(-1)!.id}`);
        this.update(run.id, { phase: "fixing", slot, activity: "Working on your message" });
      }
      void this.drive(run.id);
    }
  }

  async fail(runId: string, reason: string) {
    const run = this.store.getRun(runId);
    if (!run || ["failed", "done", "stopped"].includes(run.phase)) return;
    this.event(runId, "error", reason);
    this.update(runId, { phase: "failed", error: reason, slot: null, activity: null });
    try {
      await this.comment(runId, `failed:${runId}`, `Nightshift could not finish this task: ${reason}`);
      await this.setTaskStatus(runId, "failed");
    } catch (error) {
      this.log(`fail notify ${runId}: ${String(error)}`);
    }
    await this.releaseLease(runId);
  }

  async control(runId: string, action: "pause" | "resume" | "stop" | "retry"): Promise<Run> {
    const run = this.store.getRun(runId);
    if (!run) throw new Error("run not found");
    if (action === "pause") {
      if (["done", "failed", "stopped"].includes(run.phase) || run.paused) throw new Error(`cannot pause a ${run.paused ? "paused" : run.phase} run`);
      const updated = this.update(runId, { paused: true, slot: null, activity: "Paused" });
      this.stopTestersOf(runId, "Stopped: the task was paused");
      if (run.conversationId && isActivePhase(run.phase)) await this.runner.abort(run.conversationId).catch(() => {});
      this.event(runId, "info", "Paused by operator");
      return updated;
    }
    if (action === "resume") {
      if (!run.paused) throw new Error("run is not paused");
      if (isActivePhase(run.phase) && this.freeSlot() === null) throw new Error(`All ${this.config.slots} agent slots are busy. Resume it when one frees up, or raise the slot count.`);
      const n = this.store.setting<number>(`resumes:${runId}`, 0) + 1;
      this.store.setSetting(`resumes:${runId}`, n);
      if (WORKING.has(run.phase) && run.conversationId) {
        const pending = this.pending(runId);
        this.setPending(
          runId,
          pending
            ? { ...pending, requestId: `${pending.requestId}:resume:${n}` }
            : { requestId: `${runId}:resume:${n}`, author: "system", text: "You were paused. Continue the task from where you stopped.", attachmentIds: [] },
        );
      }
      const updated = this.update(runId, { paused: false, slot: isActivePhase(run.phase) ? this.freeSlot() : null });
      this.event(runId, "info", "Resumed by operator");
      void this.drive(runId);
      return updated;
    }
    if (action === "stop") {
      if (["done", "stopped"].includes(run.phase)) throw new Error(`run already ${run.phase}`);
      if (run.conversationId) await this.runner.abort(run.conversationId).catch(() => {});
      const updated = this.update(runId, { phase: "stopped", paused: false, slot: null, activity: null });
      this.stopTestersOf(runId, "Stopped: the task was stopped");
      await this.comment(runId, `stopped:${runId}`, "Stopped by the Nightshift operator.").catch(() => {});
      await this.setTaskStatus(runId, "failed", ":stopped").catch(() => {});
      await this.releaseLease(runId);
      return updated;
    }
    if (!["failed", "stopped"].includes(run.phase)) throw new Error("only failed or stopped runs can be retried");
    await this.setTaskStatus(runId, "ready_for_ai", `:retry:${Date.now()}`);
    this.event(runId, "info", "Retry requested: the task is back in Ready for AI");
    this.lastTaskPoll = 0;
    return run;
  }

  messageEffect(run: Run | null, status: TaskStatus): { allowed: boolean; effect: string } {
    if (!run || ["failed", "stopped"].includes(run.phase)) {
      if (!run && status === "ready_for_ai") return { allowed: true, effect: "Added to the task. The agent reads it when it starts." };
      if (!run && status === "done") return { allowed: false, effect: "This task is done. Create a new task for more work." };
      return { allowed: true, effect: "Sends the task back to the agent with your message." };
    }
    if (run.phase === "done") return { allowed: false, effect: "This task is done. Create a new task for more work." };
    if (run.paused) return { allowed: true, effect: "The agent is paused. It gets your message when you resume it." };
    if (WORKING.has(run.phase)) return { allowed: true, effect: "The agent gets this right away, while it works." };
    if (isActivePhase(run.phase)) return { allowed: true, effect: "The agent gets this right after its current step." };
    if (run.phase === "needs_info" && this.vlog.openDecisions(run.id).some((d) => d.kind === "setup"))
      return { allowed: true, effect: "Skips the failed setup and asks the agent to fix the workspace first, with your message." };
    if (run.phase === "needs_info" && this.vlog.openDecisions(run.id).some((d) => d.kind === "push"))
      return { allowed: true, effect: "Keeps the work on this Mac and sends the agent your changes." };
    if (run.phase === "needs_info" && this.vlog.openDecisions(run.id).some((d) => d.kind === "budget"))
      return { allowed: true, effect: "Gives the task another budget and continues with your message." };
    if (run.phase === "needs_info") return { allowed: true, effect: "Answers the agent's question. It continues right away." };
    return { allowed: true, effect: "Starts another round on the same pull request." };
  }

  async sendMessage(projectId: string, taskId: string, text: string, attachmentIds: string[]): Promise<{ message: OperatorMessage; effect: string }> {
    const ctx = this.ctx(projectId);
    const clean = text.trim();
    const ids = attachmentIds.filter((id) => this.store.attachment(id));
    if (!clean && !ids.length) throw new Error("Write a message or attach a picture");
    const task = await ctx.source.getTask(taskId);
    const run = this.store.latestRunForTask(projectId, taskId);
    const can = this.messageEffect(run, task.status);
    if (!can.allowed) throw new Error(can.effect);
    const stored = this.store.addTaskMessage(projectId, taskId, clean, ids);
    if (run) this.event(run.id, "info", `Message from operator: ${clean || "(pictures)"}`);
    if (run && run.phase === "needs_info") {
      for (const d of this.vlog.openDecisions(run.id).filter((x) => x.kind === "push")) {
        this.vlog.answerDecision(run.id, d.id, "Not pushed: you asked for more changes");
        this.event(run.id, "answer", `${d.question}\n→ Not pushed: you asked for more changes`);
      }
    }
    const setupDecision = run && run.phase === "needs_info" ? this.vlog.openDecisions(run.id).find((d) => d.kind === "setup") : undefined;
    if (run && setupDecision) {
      this.event(run.id, "answer", `${setupDecision.question}\n→ Ask the agent to fix the setup (from your message)`);
      await this.answerDecision(projectId, taskId, setupDecision.id, "Ask the agent to fix the setup");
      this.touchTask(projectId, taskId);
      return { message: this.operatorMessage(stored), effect: "The agent fixes the workspace setup first, then works on your message." };
    }
    const budgetDecision = run && run.phase === "needs_info" ? this.vlog.openDecisions(run.id).find((d) => d.kind === "budget") : undefined;
    if (run && budgetDecision) {
      this.vlog.answerDecision(run.id, budgetDecision.id, "Continue with another budget (from your message)");
      this.grantBudget(run);
      this.event(run.id, "answer", `${budgetDecision.question}\n→ Continue with another budget (from your message)`);
    }
    if (run && !run.paused && WORKING.has(run.phase) && run.conversationId) {
      this.store.markMessagesDelivered([stored.id], run.id);
      this.noted.set(run.id, [...(this.noted.get(run.id) ?? []), stored.id]);
      const p = this.pi
        .note(run.conversationId, this.agentMessage(clean || "(see attached pictures)", "operator", ids), `${run.id}:msg:${stored.id}`, [stored.id])
        .catch((error) => this.log(`deliver message ${stored.id}: ${String(error)}`));
      this.track(run.id, p);
    } else if (!run || ["failed", "stopped"].includes(run.phase)) {
      if (task.status !== "ready_for_ai") {
        const key = `status:msg:${stored.id}`;
        await this.sideEffect(key, run?.id ?? null, () => ctx.source.setStatus(taskId, "ready_for_ai", key));
        this.lastTaskPoll = 0;
      }
    } else {
      void this.deliverQueued();
    }
    this.touchTask(projectId, taskId);
    return { message: this.operatorMessage(stored), effect: can.effect };
  }

  private operatorMessage(m: StoredMessage): OperatorMessage {
    return { id: m.id, text: m.text, attachments: this.attachmentRefs(m.attachmentIds), createdAt: m.createdAt, delivered: Boolean(m.deliveredAt), deliveredAt: m.deliveredAt, runId: m.runId };
  }

  async createTask(projectId: string, input: NewTaskInput, meta?: { origin: TaskOrigin; continueBranch?: string }): Promise<TaskListItem> {
    const ctx = this.ctx(projectId);
    const title = input.title?.trim();
    if (!title) throw new Error("A task needs a title");
    const base = input.baseBranch?.trim();
    if (base && base !== ctx.project.repo.baseBranch) {
      const branches = await this.branches(projectId);
      if (!branches.branches.some((b) => b.name === base)) throw new Error(`Branch ${base} was not found on ${ctx.project.repo.remote}`);
    }
    const customId = input.id?.trim() || undefined;
    if (customId) {
      if (ctx.project.source.type !== "local") throw new Error("Tasks of this project come from WonderCall, which gives them their ids");
      if (!TASK_ID_PATTERN.test(customId)) throw new Error(`The task id ${customId} is not valid: use letters, digits, ".", "_" or "-" (up to 40), starting with a letter or digit`);
      // Runs keep a task's id after the task is gone, and branch names are lower-cased: both must stay unambiguous.
      if (this.store.localTaskIdTaken(projectId, customId) || this.store.runsForProject(projectId).some((r) => r.taskId.toLowerCase() === customId.toLowerCase()))
        throw Object.assign(new Error(`This project already has a task ${customId}`), { status: 409 });
    }
    const startFrom = input.type === "review" ? input.startFrom?.trim() : undefined;
    if (input.type === "review") {
      if (!startFrom) throw new Error("Choose the branch with the work to continue");
      if (startFrom === (base || ctx.project.repo.baseBranch)) throw new Error("Choose the branch with the earlier work, not the base branch");
      if (!(await this.branches(projectId, startFrom)).branches.some((b) => b.name === startFrom)) throw new Error(`Branch ${startFrom} was not found on ${ctx.project.repo.remote}`);
      if (this.activeTaskForBranch(projectId, startFrom)) throw new Error(`Another task is still working on ${startFrom}; stop it or wait until it is done`);
    }
    const task = await ctx.source.createTask({ title, body: input.body?.trim() ?? "", ...(customId ? { id: customId } : {}) });
    if (base && base !== ctx.project.repo.baseBranch) this.store.setSetting(`taskBase:${projectId}/${task.id}`, base);
    // Agents push only to branches under the project's prefix (D6): another prefix gets its own agent branch, started from it.
    if (startFrom && !meta) {
      this.store.setSetting(
        `taskMeta:${projectId}/${task.id}`,
        startFrom.startsWith(ctx.project.repo.branchPrefix) ? { origin: { kind: "manual", branch: startFrom }, continueBranch: startFrom } : { origin: { kind: "manual", branch: startFrom }, startFrom },
      );
    }
    if (meta) this.store.setSetting(`taskMeta:${projectId}/${task.id}`, meta);
    if (input.type !== undefined && input.type !== null) {
      if (!isTaskType(input.type)) throw new Error("Unknown task type");
      this.store.setSetting(`taskType:${projectId}/${task.id}`, input.type);
    }
    const ids = (input.attachmentIds ?? []).filter((id) => this.store.attachment(id));
    if (ids.length) this.store.addTaskMessage(projectId, task.id, "Pictures attached to the task.", ids);
    ctx.tasksCache = null;
    this.lastTaskPoll = 0;
    this.touchTask(projectId, task.id);
    return this.taskItem(projectId, { id: task.id, title: task.title, status: task.status, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }

  private taskItem(projectId: string, t: { id: string; title: string; status: TaskStatus; createdAt?: string; updatedAt?: string }): TaskListItem {
    const run = this.store.latestRunForTask(projectId, t.id);
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      createdAt: t.createdAt ?? null,
      updatedAt: run?.updatedAt ?? t.updatedAt ?? null,
      unreadMessages: this.store.taskMessages(projectId, t.id).filter((m) => !m.deliveredAt).length,
      baseBranch: run?.baseBranch ?? this.store.setting<string | null>(`taskBase:${projectId}/${t.id}`, null) ?? this.ctx(projectId).project.repo.baseBranch,
      origin: this.originOf(projectId, t.id),
      type: this.taskTypeOf(projectId, t.id),
      preview: this.previewSummary(projectId, t.id),
      openDecisions: run ? this.vlog.openDecisions(run.id).length : 0,
      openIssues: run ? this.vlog.openIssues(run.id).length : 0,
      run: run
        ? {
            id: run.id,
            model: run.model,
            phase: run.phase,
            paused: run.paused,
            activity: run.activity,
            prUrl: run.prUrl,
            prNumber: run.prNumber,
            fixRounds: run.fixRounds,
            costUsd: run.usage.costUsd,
            updatedAt: run.updatedAt,
          }
        : null,
    };
  }

  private async listTasksCached(ctx: ProjectContext) {
    if (ctx.tasksCache && Date.now() - ctx.tasksCache.at < TASK_CACHE_MS) return ctx.tasksCache.tasks;
    try {
      const tasks = await ctx.source.listTasks();
      ctx.tasksCache = { at: Date.now(), tasks };
      ctx.state.lastError = null;
      return tasks;
    } catch (error) {
      ctx.state.lastError = String(error instanceof Error ? error.message : error);
      return ctx.tasksCache?.tasks ?? [];
    }
  }

  async projectSummary(ctx: ProjectContext): Promise<ProjectSummary> {
    const tasks = await this.listTasksCached(ctx);
    const taskCounts: ProjectSummary["taskCounts"] = {};
    for (const t of tasks) taskCounts[t.status] = (taskCounts[t.status] ?? 0) + 1;
    const activeRuns = this.store.runsForProject(ctx.project.id).filter((r) => isActivePhase(r.phase)).length;
    const openDecisions = this.store.runsForProject(ctx.project.id).reduce((n, r) => n + (["done", "stopped"].includes(r.phase) ? 0 : this.vlog.openDecisions(r.id).length), 0);
    return { ...ctx.project, taskCounts, activeRuns, openDecisions, sourceError: ctx.state.lastError, commitAuthor: commitAuthor(this.config, ctx.project.repo.path) };
  }

  async listProjects(): Promise<ProjectSummary[]> {
    return Promise.all([...this.projects.values()].map((ctx) => this.projectSummary(ctx)));
  }

  async projectTasks(projectId: string): Promise<ProjectTasksResponse> {
    const ctx = this.ctx(projectId);
    const tasks = await this.listTasksCached(ctx);
    const items = tasks.map((t) => this.taskItem(projectId, t));
    items.sort((a, b) => (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? ""));
    const nextTaskId = ctx.project.source.type === "local" ? this.store.nextLocalTaskId(projectId, taskPrefixOf(ctx.project)) : null;
    return { project: await this.projectSummary(ctx), tasks: items, nextTaskId };
  }

  async taskView(projectId: string, taskId: string, sessionId?: string): Promise<TaskViewResponse> {
    const ctx = this.ctx(projectId);
    const [task, comments] = await Promise.all([ctx.source.getTask(taskId), ctx.source.listComments(taskId)]);
    const runs = this.store.runsForTask(projectId, taskId);
    const run = runs[0] ?? null;
    const sessions = await this.sessionsFor(projectId, taskId);
    if (sessionId && !sessions.some((s) => s.id === sessionId)) throw Object.assign(new Error("Session not found"), { status: 404 });
    const shown = sessionId ?? sessions.find((s) => s.active)?.id ?? sessions.at(0)?.id ?? null;
    const transcript = shown ? await this.runner.transcript(shown).catch(() => []) : [];
    const live = run?.conversationId && isActivePhase(run.phase) ? await this.runner.activity(run.conversationId).catch(() => null) : null;
    const messages = this.store.taskMessages(projectId, taskId).map((m) => this.operatorMessage(m));
    return {
      origin: this.originOf(projectId, taskId),
      type: this.taskTypeOf(projectId, taskId),
      openDecisions: run ? this.vlog.openDecisions(run.id).length : 0,
      baseBranch: run?.baseBranch ?? this.store.setting<string | null>(`taskBase:${projectId}/${taskId}`, null) ?? ctx.project.repo.baseBranch,
      session: shown,
      sessions,
      workspace: this.workspace.info(projectId, taskId),
      project: ctx.project,
      task,
      comments,
      run,
      runs: runs.map((r) => ({ id: r.id, phase: r.phase, createdAt: r.createdAt, prUrl: r.prUrl })),
      transcript,
      live,
      events: run ? this.store.listEvents(run.id, 300) : [],
      messages,
      attachments: messages.flatMap((m) => m.attachments),
      canMessage: this.messageEffect(run, task.status),
    };
  }

  async setKillSwitch(on: boolean) {
    this.store.setSetting("killSwitch", on);
    if (on) {
      const paused: string[] = [];
      for (const run of this.activeRuns()) {
        await this.control(run.id, "pause").catch(() => {});
        paused.push(run.id);
      }
      this.store.setSetting("killSwitchPaused", paused);
    } else {
      for (const id of this.store.setting<string[]>("killSwitchPaused", [])) await this.control(id, "resume").catch(() => {});
      this.store.setSetting("killSwitchPaused", []);
    }
    this.emit({ type: "status", status: this.status() });
    return on;
  }

  status(): StatusResponse {
    const runs = this.store.listRuns(5000);
    const counts: Record<string, number> = {};
    for (const r of runs) counts[r.phase] = (counts[r.phase] ?? 0) + 1;
    const active = runs.filter((r) => isActivePhase(r.phase) && !r.paused);
    const slots: SlotView[] = Array.from({ length: this.config.slots }, (_, slot) => {
      const run = active.find((r) => r.slot === slot);
      return {
        slot,
        runId: run?.id ?? null,
        taskId: run?.taskId ?? null,
        taskTitle: run?.taskTitle ?? null,
        phase: run ? (run.paused ? `${run.phase} (paused)` : run.phase) : null,
        activity: run?.activity ?? null,
        startedAt: run?.createdAt ?? null,
      };
    });
    const states = [...this.projects.values()].map((c) => c.state);
    return {
      version: VERSION,
      startedAt: this.startedAt,
      source: {
        name: `${this.projects.size} project${this.projects.size === 1 ? "" : "s"}`,
        connected: states.every((s) => s.lastError === null),
        lastPollAt: states.map((s) => s.lastPollAt).filter(Boolean).sort().at(-1) ?? null,
        lastError: states.map((s) => s.lastError).find(Boolean) ?? null,
      },
      killSwitch: this.killSwitch,
      slots,
      counts,
      usageToday: this.store.usageOn() ?? emptyUsage(),
      billing: this.deps.billing?.() ?? {},
      budgets: { perDayUsd: this.budgets.perDayUsd, perRunUsd: this.budgets.perRunUsd, perRunTokens: this.budgets.perRunTokens },
      model: this.label(this.deps.modelSettings?.().default ?? this.config.model),
    };
  }
}
