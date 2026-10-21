import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Bot,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CirclePause,
  CircleQuestionMark,
  CircleX,
  ExternalLink,
  FlaskConical,
  GitPullRequestArrow,
  ListChecks,
  Play,
  Radar,
  ScanSearch,
  Settings,
  Square,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import type { Decision, Issue, IssueSeverity, IssueSource, StepKind, StepStatus, TaskOrigin, TesterConfig, TesterWhen, VerificationResponse, VerificationStep } from "@nightshift/core";
import { formatDateTime, formatDuration, formatTime, type Tone } from "@nightshift/ui";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { messageOf, verifyApi } from "../api";
import { useDebouncedRefresh, useLive } from "../live";
import { projectSettingsHref, useNow } from "../routing";
import { Markdown } from "./Markdown";
import { Notice } from "./Notice";
import { EmptyState, Spinner, TONE_BADGE, TONE_TEXT, ToneBadge } from "./TaskBits";

const RUNNING_POLL_MS = 2000;
const FALLBACK_POLL_MS = 5000;

export type Verification = {
  data: VerificationResponse | null;
  error: string | null;
  load: () => Promise<void>;
};

export function useVerification(projectId: string, taskId: string): Verification {
  const { connection } = useLive();
  const [data, setData] = useState<VerificationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const res = await verifyApi.verification(projectId, taskId);
      if (mine !== seq.current) return;
      setData(res);
      setError(null);
    } catch (err) {
      if (mine !== seq.current) return;
      setError(messageOf(err));
    }
  }, [projectId, taskId]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  const running = data?.steps.some((s) => s.status === "running") ?? false;

  useEffect(() => {
    const ms = running ? RUNNING_POLL_MS : connection === "live" ? 0 : FALLBACK_POLL_MS;
    if (!ms) return;
    const timer = window.setInterval(() => void load(), ms);
    return () => window.clearInterval(timer);
  }, [running, connection, load]);

  useDebouncedRefresh(
    (event) => (event.type === "task" && event.projectId === projectId && event.taskId === taskId) || (event.type === "run" && event.run.projectId === projectId && event.run.taskId === taskId),
    () => void load(),
  );

  return { data, error, load };
}

export const openDecisionsOf = (data: VerificationResponse | null) => data?.decisions.filter((d) => d.status === "open") ?? [];

export const attentionCount = (data: VerificationResponse | null) =>
  data ? data.issues.filter((i) => i.status === "open").length + openDecisionsOf(data).length : 0;

const prRef = (ref: string | undefined) => (ref ? (/^\d+$/.test(ref) ? `#${ref}` : ref) : "");

export const originLabel = (origin: TaskOrigin | undefined): string | null => {
  if (!origin || origin.kind === "manual") return null;
  const ref = prRef(origin.ref);
  if (origin.kind === "pr-feedback") return ref ? `From PR ${ref} review` : "From PR review";
  if (origin.kind === "ci-failure") return ref ? `From failing CI on PR ${ref}` : "From failing CI";
  return ref ? `From GitHub issue ${ref}` : "From a GitHub issue";
};

const ORIGIN_ICONS: Record<Exclude<TaskOrigin["kind"], "manual">, LucideIcon> = {
  "pr-feedback": GitPullRequestArrow,
  "ci-failure": Workflow,
  "github-issue": CircleDashed,
};

export function OriginBadge({ origin, className }: { origin: TaskOrigin | undefined; className?: string }) {
  const label = originLabel(origin);
  if (!origin || origin.kind === "manual" || !label) return null;
  const Icon = ORIGIN_ICONS[origin.kind];
  const title = origin.branch ? `${label} · created by a listener on ${origin.branch}` : `${label} · created by a listener`;
  const body = (
    <>
      <Icon className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
      {origin.url ? <ExternalLink className="size-3 shrink-0 opacity-70" /> : null}
    </>
  );
  const cls = cn("inline-flex max-w-64 items-center gap-1 rounded-md border border-teal-500/30 bg-teal-500/10 px-1.5 py-px text-xs text-teal-800 dark:text-teal-200", className);
  return origin.url ? (
    <a href={origin.url} target="_blank" rel="noopener noreferrer" title={title} className={cn(cls, "relative z-10 hover:bg-teal-500/20")}>
      {body}
    </a>
  ) : (
    <span title={title} className={cls}>
      {body}
    </span>
  );
}

export function DecisionCount({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded-md bg-violet-500/15 px-1.5 py-px text-xs font-medium text-violet-700 dark:text-violet-300", className)}
      title={`${count} decision${count === 1 ? "" : "s"} waiting for you`}
    >
      <CircleQuestionMark className="size-3" />
      {count} decision{count === 1 ? "" : "s"} needed
    </span>
  );
}

const DECISION_KINDS: Record<Decision["kind"], string> = {
  "agent-question": "The agent asks",
  finding: "A finding needs your call",
  "loop-limit": "The fix loop hit its limit",
  plan: "Plan approval",
  deletion: "Approve deleting files",
  budget: "Budget reached",
  push: "Approve the push",
  setup: "Workspace setup failed",
  tester: "A required test could not run",
  "pr-comment": "Approve a comment on the pull request",
};

const PLAIN_CONTEXT = new Set<Decision["kind"]>(["push", "setup", "tester", "pr-comment"]);

function DecisionCard({ projectId, taskId, decision, onAnswered }: { projectId: string; taskId: string; decision: Decision; onAnswered: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fieldId = `decision-${decision.id}-text`;

  const answer = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    setBusy(trimmed);
    setError(null);
    try {
      const res = await verifyApi.answer(projectId, taskId, decision.id, trimmed);
      toast.success("Decision sent", { description: res.effect });
      setText("");
      onAnswered();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card id={`decision-${decision.id}`} className="scroll-mt-4 gap-3 border-violet-500/50 bg-violet-500/[0.04] py-4 ring-violet-500/40" role="region" aria-label="Your decision is needed">
      <CardHeader className="px-4">
        <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-violet-700 dark:text-violet-300">
          <CircleQuestionMark className="size-4" />
          Your decision is needed
          <span className="font-normal text-muted-foreground">
            · {DECISION_KINDS[decision.kind] ?? decision.kind}
            {decision.source ? ` · ${decision.source}` : ""} · {formatTime(decision.askedAt).slice(0, 5)}
          </span>
        </div>
        <CardTitle className="text-base leading-snug">{decision.question}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 px-4">
        {decision.context ? (
          <Collapsible defaultOpen={PLAIN_CONTEXT.has(decision.kind)} className="group/ctx rounded-md border bg-background/60">
            <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
              <ChevronRight className="size-3.5 transition-transform group-data-[state=open]/ctx:rotate-90" />
              {decision.kind === "push" ? "What will be pushed" : decision.kind === "pr-comment" ? "What will be posted" : decision.kind === "setup" || decision.kind === "tester" ? "What went wrong" : "Context"}
            </CollapsibleTrigger>
            <CollapsibleContent className="border-t px-3 py-2 text-sm">
              {PLAIN_CONTEXT.has(decision.kind) ? (
                <pre className="max-h-72 overflow-auto font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">{decision.context}</pre>
              ) : (
                <Markdown text={decision.context} />
              )}
            </CollapsibleContent>
          </Collapsible>
        ) : null}
        {decision.options.length > 0 ? (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Choose an answer">
            {decision.options.map((o, i) => (
              <Button key={o} size="sm" variant={i === 0 ? "default" : "outline"} disabled={busy !== null} aria-busy={busy === o} onClick={() => void answer(o)} className="h-auto min-h-8 py-1.5 text-left whitespace-normal">
                {busy === o ? <Spinner className="size-3 text-current" /> : null}
                {o}
              </Button>
            ))}
          </div>
        ) : null}
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void answer(text);
          }}
        >
          <label htmlFor={fieldId} className="text-xs text-muted-foreground">
            {decision.options.length > 0 ? "Or answer in your own words" : "Your answer"}
          </label>
          <div className="flex items-end gap-2">
            <Textarea
              id={fieldId}
              rows={1}
              value={text}
              disabled={busy !== null}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void answer(text);
                }
              }}
              placeholder="Tell the agent what to do…"
              className="max-h-32 min-h-9 resize-none bg-background"
            />
            <Button type="submit" size="sm" variant="secondary" disabled={!text.trim() || busy !== null}>
              Send
            </Button>
          </div>
        </form>
        {error ? (
          <p className="text-xs text-destructive" role="alert">
            Could not send: {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function DecisionCards({ projectId, taskId, decisions, onAnswered, className }: { projectId: string; taskId: string; decisions: Decision[]; onAnswered: () => void; className?: string }) {
  const open = decisions.filter((d) => d.status === "open");
  if (open.length === 0) return null;
  return (
    <div className={cn("grid gap-3", className)}>
      {open.map((d) => (
        <DecisionCard key={d.id} projectId={projectId} taskId={taskId} decision={d} onAnswered={onAnswered} />
      ))}
    </div>
  );
}

const STEP_KINDS: Record<StepKind, { label: string; icon: LucideIcon }> = {
  setup: { label: "Setup", icon: Wrench },
  agent: { label: "Agent", icon: Bot },
  checks: { label: "Checks", icon: ListChecks },
  review: { label: "AI review", icon: ScanSearch },
  external: { label: "External test", icon: FlaskConical },
  ci: { label: "CI", icon: Workflow },
  push: { label: "Push", icon: GitPullRequestArrow },
};

const STEP_STATUS: Record<StepStatus, { label: string; tone: Tone; icon: LucideIcon }> = {
  running: { label: "Running", tone: "info", icon: CircleDashed },
  passed: { label: "Passed", tone: "success", icon: CircleCheck },
  failed: { label: "Found problems", tone: "danger", icon: CircleX },
  skipped: { label: "Skipped", tone: "muted", icon: CircleDashed },
  waiting: { label: "Waiting for you", tone: "accent", icon: CirclePause },
};

const RING: Record<StepStatus, string> = {
  running: "border-sky-500/60 bg-sky-500/10",
  passed: "border-emerald-500/50 bg-emerald-500/10",
  failed: "border-red-500/50 bg-red-500/10",
  skipped: "border-border bg-muted",
  waiting: "border-violet-500/60 bg-violet-500/10",
};

const SEVERITIES: Record<IssueSeverity, { label: string; tone: Tone; rank: number }> = {
  blocker: { label: "Blocker", tone: "danger", rank: 0 },
  major: { label: "Major", tone: "warning", rank: 1 },
  minor: { label: "Minor", tone: "neutral", rank: 2 },
  info: { label: "Info", tone: "muted", rank: 3 },
};

const SOURCE_ORDER: IssueSource[] = ["check", "review", "external", "ci", "pr-comment"];

const sourceLabel = (source: IssueSource, name: string) => {
  if (source === "check") return `Check: ${name || "checks"}`;
  if (source === "review") return name || "AI reviewer";
  if (source === "external") return name || "External tester";
  if (source === "ci") return name ? `CI: ${name}` : "CI";
  return name ? `PR comment from ${name}` : "PR comment";
};

const WHEN_LABELS: Record<TesterWhen, string> = {
  "every-round": "Every round",
  "before-pr": "Before the PR",
  manual: "Only when you run it",
};

const duration = (step: VerificationStep, now: number) => {
  const start = Date.parse(step.startedAt);
  const end = step.endedAt ? Date.parse(step.endedAt) : step.status === "running" ? now : NaN;
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? formatDuration(end - start) : null;
};

const fixedRound = (issue: Issue, steps: VerificationStep[]) => {
  if (issue.fixedRound !== undefined) return issue.fixedRound;
  if (!issue.resolvedAt) return null;
  const at = Date.parse(issue.resolvedAt);
  const before = steps.filter((s) => Date.parse(s.startedAt) <= at).map((s) => s.round);
  return before.length ? Math.max(...before) : issue.round + 1;
};

function roundLabel(round: number, issues: Issue[]) {
  if (round === 1) return "first attempt";
  const fixing = issues.filter((i) => i.round === round - 1 && i.status !== "dismissed" && i.status !== "needs_decision").length;
  return fixing > 0 ? `fixing ${fixing} issue${fixing === 1 ? "" : "s"}` : "another pass";
}

function IssueChip({ issue, onJump }: { issue: Issue; onJump: (id: string) => void }) {
  const sev = SEVERITIES[issue.severity];
  const done = issue.status === "fixed" || issue.status === "dismissed";
  return (
    <button
      type="button"
      onClick={() => onJump(issue.id)}
      title={`${sev.label}: ${issue.title}`}
      className={cn(
        "inline-flex max-w-72 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        TONE_BADGE[sev.tone],
        done && "line-through opacity-60",
      )}
    >
      <span className="font-medium">{sev.label}</span>
      <span className="truncate">{issue.title}</span>
    </button>
  );
}

/** Stops a task's running (or queued) tester; `onStopped` reloads the view. */
function useStopTester(projectId: string, taskId: string, onStopped: () => void) {
  const [stopping, setStopping] = useState<string | null>(null);
  const stop = async (testerId: string, name: string) => {
    setStopping(testerId);
    try {
      await verifyApi.stopTester(projectId, taskId, testerId);
      toast.success(`${name} stopped`);
      onStopped();
    } catch (err) {
      toast.error(`Could not stop ${name}`, { description: messageOf(err) });
    } finally {
      setStopping(null);
    }
  };
  return { stopping, stop };
}

function StopTesterButton({ busy, name, onClick }: { busy: boolean; name: string; onClick: () => void }) {
  return (
    <Button size="sm" variant="outline" className="h-7 text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={busy} onClick={onClick} aria-label={`Stop ${name}`}>
      {busy ? <Spinner className="size-3 text-current" /> : <Square />} Stop
    </Button>
  );
}

type StepStop = { stopping: string | null; stop: (testerId: string, name: string) => Promise<void> };

function StepProgress({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <Collapsible className="group/live mt-1">
      <CollapsibleTrigger className="inline-flex max-w-full items-center gap-1 rounded-sm text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
        <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]/live:rotate-90" />
        <span className="truncate font-mono">{lines[lines.length - 1]}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="mt-1.5 max-h-60 overflow-auto rounded-md bg-zinc-950 p-2.5 font-mono text-[11px] leading-4 whitespace-pre-wrap break-all text-zinc-100" aria-live="polite">{text}</pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

function StepRow({ step, issues, now, onJump, last, stopper }: { step: VerificationStep; issues: Map<string, Issue>; now: number; onJump: (id: string) => void; last: boolean; stopper: StepStop }) {
  const kind = STEP_KINDS[step.kind] ?? { label: step.kind, icon: Bot };
  const status = STEP_STATUS[step.status] ?? STEP_STATUS.skipped;
  const found = step.issueIds.map((id) => issues.get(id)).filter((i): i is Issue => Boolean(i));
  const took = duration(step, now);
  const Kind = kind.icon;
  const StatusIcon = status.icon;
  return (
    <li className="relative grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3">
      {last ? null : <span className="absolute top-8 bottom-0 left-4 w-px -translate-x-1/2 bg-border" aria-hidden="true" />}
      <span className={cn("relative z-10 flex size-8 items-center justify-center rounded-full border", RING[step.status])} aria-hidden="true">
        {step.status === "running" ? <Spinner className="size-4 text-sky-600 dark:text-sky-400" /> : <Kind className={cn("size-4", TONE_TEXT[status.tone])} />}
      </span>
      <div className="min-w-0 pb-5">
        <div className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium">{step.title || kind.label}</span>
          <span className="text-xs text-muted-foreground">{kind.label}{step.kind === "external" && step.detail ? ` · ${step.detail}` : ""}</span>
          <ToneBadge tone={status.tone} className="ml-auto">
            {step.status === "running" ? <Spinner className="size-3 text-current" /> : <StatusIcon />}
            {step.status === "running" && step.note ? "Waiting" : status.label}
          </ToneBadge>
          {step.status === "running" && step.kind === "external" && step.testerId ? (
            <StopTesterButton busy={stopper.stopping === step.testerId} name={step.title} onClick={() => void stopper.stop(step.testerId!, step.title)} />
          ) : null}
        </div>
        {step.status === "running" && step.note ? <p className="text-xs text-amber-700 dark:text-amber-400">{step.note}</p> : null}
        {step.status === "running" && step.progress ? <StepProgress text={step.progress} /> : null}
        <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <time dateTime={step.startedAt} title={formatDateTime(step.startedAt)}>
            {formatTime(step.startedAt).slice(0, 5)}
          </time>
          {took ? <span>· {step.status === "running" ? `running for ${took}` : took}</span> : null}
          {step.detail && step.kind !== "external" ? <span className="min-w-0 break-words">· {step.detail}</span> : null}
        </div>
        {found.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5" aria-label={`Issues found by ${step.title}`}>
            {found.map((i) => (
              <IssueChip key={i.id} issue={i} onJump={onJump} />
            ))}
          </div>
        ) : null}
        {step.output ? (
          <Collapsible className="group/out mt-2">
            <CollapsibleTrigger className="inline-flex items-center gap-1 rounded-sm text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
              <ChevronRight className="size-3.5 transition-transform group-data-[state=open]/out:rotate-90" />
              Output
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="mt-1.5 max-h-80 overflow-auto rounded-md bg-zinc-950 p-2.5 font-mono text-[11px] leading-4 whitespace-pre-wrap break-all text-zinc-100">{step.output}</pre>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </div>
    </li>
  );
}

function StepsTimeline({ data, onJump, stopper }: { data: VerificationResponse; onJump: (id: string) => void; stopper: StepStop }) {
  const running = data.steps.some((s) => s.status === "running");
  const now = useNow(running ? 1000 : 60_000);
  const issues = new Map(data.issues.map((i) => [i.id, i]));
  const rounds = [...new Set(data.steps.map((s) => s.round))].sort((a, b) => a - b);
  if (rounds.length === 0) return <p className="text-sm text-muted-foreground">Nothing has run yet. Steps show up here when the agent finishes a change and the checks start.</p>;
  return (
    <div className="grid gap-5">
      {rounds.map((r) => {
        const steps = data.steps.filter((s) => s.round === r);
        return (
          <section key={r} aria-labelledby={`round-${r}`}>
            <h3 id={`round-${r}`} className="mb-3 flex items-center gap-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Round {r}
              <span className="font-normal normal-case">· {roundLabel(r, data.issues)}</span>
              {r === data.round ? <span className="rounded bg-muted px-1.5 font-normal normal-case">current</span> : null}
            </h3>
            <ol className="grid">
              {steps.map((s, i) => (
                <StepRow key={s.id} step={s} issues={issues} now={now} onJump={onJump} last={i === steps.length - 1} stopper={stopper} />
              ))}
            </ol>
          </section>
        );
      })}
    </div>
  );
}

type IssueFilter = "open" | "fixed" | "all";

const ISSUE_FILTERS: Array<{ id: IssueFilter; label: string; match: (i: Issue) => boolean }> = [
  { id: "open", label: "Open", match: (i) => i.status === "open" || i.status === "needs_decision" },
  { id: "fixed", label: "Fixed", match: (i) => i.status === "fixed" },
  { id: "all", label: "All", match: () => true },
];

function IssueStatus({ issue, steps, onJump }: { issue: Issue; steps: VerificationStep[]; onJump: (decisionId: string) => void }) {
  if (issue.status === "fixed") {
    const r = fixedRound(issue, steps);
    return <ToneBadge tone="success">{r ? `Fixed in round ${r}` : "Fixed"}</ToneBadge>;
  }
  if (issue.status === "dismissed") return <ToneBadge tone="muted">Dismissed</ToneBadge>;
  if (issue.status === "needs_decision")
    return issue.decisionId ? (
      <button type="button" className={cn("inline-flex h-5 items-center rounded-4xl px-2 text-xs font-medium hover:underline", TONE_BADGE.accent)} onClick={() => onJump(issue.decisionId ?? "")}>
        Needs your decision
      </button>
    ) : (
      <ToneBadge tone="accent">Needs your decision</ToneBadge>
    );
  return <ToneBadge tone="warning">Open</ToneBadge>;
}

function IssueRow({ issue, steps, highlighted, onSet, onJumpDecision }: { issue: Issue; steps: VerificationStep[]; highlighted: boolean; onSet: (issue: Issue, status: "dismissed" | "open") => Promise<void>; onJumpDecision: (id: string) => void }) {
  const [busy, setBusy] = useState(false);
  const sev = SEVERITIES[issue.severity];
  const done = issue.status === "fixed" || issue.status === "dismissed";
  const set = async (status: "dismissed" | "open") => {
    setBusy(true);
    await onSet(issue, status);
    setBusy(false);
  };
  return (
    <li id={`issue-${issue.id}`} className={cn("scroll-mt-4 px-3 py-2.5 transition-colors", highlighted && "bg-amber-500/10")}>
      <Collapsible className="group/issue">
        <div className="flex items-start gap-2">
          <CollapsibleTrigger
            className="mt-0.5 rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-30"
            aria-label={`Show details for ${issue.title}`}
            disabled={!issue.detail}
          >
            <ChevronRight className="size-4 transition-transform group-data-[state=open]/issue:rotate-90" />
          </CollapsibleTrigger>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <ToneBadge tone={sev.tone}>{sev.label}</ToneBadge>
              <span className={cn("min-w-0 font-medium break-words", done && "text-muted-foreground line-through decoration-muted-foreground/50")}>{issue.title}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              {issue.file ? (
                <code className="max-w-full truncate font-mono" title={issue.file}>
                  {issue.file}
                  {issue.line ? `:${issue.line}` : ""}
                </code>
              ) : null}
              <span>found in round {issue.round}</span>
              <IssueStatus issue={issue} steps={steps} onJump={onJumpDecision} />
            </div>
          </div>
          {issue.status === "dismissed" ? (
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => void set("open")}>
              {busy ? <Spinner className="size-3" /> : null}
              Reopen
            </Button>
          ) : issue.status === "open" || issue.status === "needs_decision" ? (
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => void set("dismissed")} title="Won't fix: stop blocking on this issue">
              {busy ? <Spinner className="size-3" /> : null}
              Dismiss
            </Button>
          ) : null}
        </div>
        {issue.detail ? (
          <CollapsibleContent className="mt-2 ml-6 rounded-md border bg-muted/40 px-3 py-2 text-sm">
            <Markdown text={issue.detail} />
          </CollapsibleContent>
        ) : null}
      </Collapsible>
    </li>
  );
}

function IssuesList({ data, filter, setFilter, highlight, onSet, onJumpDecision }: { data: VerificationResponse; filter: IssueFilter; setFilter: (f: IssueFilter) => void; highlight: string | null; onSet: (issue: Issue, status: "dismissed" | "open") => Promise<void>; onJumpDecision: (id: string) => void }) {
  const match = ISSUE_FILTERS.find((f) => f.id === filter)?.match ?? (() => true);
  const shown = data.issues.filter(match);
  const groups = new Map<string, { source: IssueSource; label: string; issues: Issue[] }>();
  for (const i of shown) {
    const key = `${i.source}:${i.sourceName}`;
    const g = groups.get(key) ?? { source: i.source, label: sourceLabel(i.source, i.sourceName), issues: [] };
    g.issues.push(i);
    groups.set(key, g);
  }
  const ordered = [...groups.values()].sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source) || a.label.localeCompare(b.label));
  const statusRank = (i: Issue) => (i.status === "needs_decision" ? 0 : i.status === "open" ? 1 : i.status === "fixed" ? 2 : 3);
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-1.5" role="toolbar" aria-label="Filter issues">
        {ISSUE_FILTERS.map((f) => (
          <Button key={f.id} size="sm" variant={filter === f.id ? "secondary" : "ghost"} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
            {f.label} <span className="tabular-nums text-muted-foreground">{data.issues.filter(f.match).length}</span>
          </Button>
        ))}
      </div>
      {data.issues.length === 0 ? (
        <p className="text-sm text-muted-foreground">No issues found so far.</p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">{filter === "open" ? "Nothing open. Every issue is fixed or dismissed." : "No issues match this filter."}</p>
      ) : (
        ordered.map((g) => (
          <section key={`${g.source}:${g.label}`} aria-label={g.label}>
            <h4 className="mb-1.5 flex items-center gap-2 text-xs font-medium text-muted-foreground">
              {g.label}
              <span className="tabular-nums">{g.issues.length}</span>
            </h4>
            <ul className="divide-y rounded-lg border bg-card">
              {[...g.issues]
                .sort((a, b) => statusRank(a) - statusRank(b) || SEVERITIES[a.severity].rank - SEVERITIES[b.severity].rank)
                .map((i) => (
                  <IssueRow key={i.id} issue={i} steps={data.steps} highlighted={highlight === i.id} onSet={onSet} onJumpDecision={onJumpDecision} />
                ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

function TesterRow({ projectId, taskId, tester, steps, onRan, stopper }: { projectId: string; taskId: string; tester: TesterConfig; steps: VerificationStep[]; onRan: () => void; stopper: StepStop }) {
  const [busy, setBusy] = useState(false);
  const mine = steps.filter((s) => s.kind === "external" && (s.testerId ? s.testerId === tester.id : s.detail === tester.name));
  const last = mine[mine.length - 1];
  const running = last?.status === "running";
  const run = async () => {
    setBusy(true);
    try {
      const res = await verifyApi.runTester(projectId, taskId, tester.id);
      toast.success(`${tester.name} started`, { description: res.effect });
      onRan();
    } catch (err) {
      toast.error(`Could not run ${tester.name}`, { description: messageOf(err) });
    } finally {
      setBusy(false);
    }
  };
  const lastStatus = last ? STEP_STATUS[last.status] : null;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5">
      <FlaskConical className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 basis-48">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("font-medium", !tester.enabled && "text-muted-foreground")}>{tester.name}</span>
          {!tester.enabled ? <ToneBadge tone="muted">Off</ToneBadge> : null}
        </div>
        <div className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          <span>{tester.enabled ? WHEN_LABELS[tester.when] : "Only when you run it"}</span>
          <span>· {tester.blocking ? "Blocks the PR" : "Advisory"}</span>
          {tester.onError === "ask" && tester.when !== "manual" ? <span title="If it cannot run, the PR waits and you are asked">· must run</span> : null}
          {tester.queue ? <span title={`Runs one at a time with every other "${tester.queue}" tester, across all tasks`}>· one at a time ({tester.queue})</span> : null}
          {last && lastStatus ? (
            <span className={TONE_TEXT[lastStatus.tone]}>
              · Last run {formatTime(last.startedAt).slice(0, 5)}: {lastStatus.label.toLowerCase()}
            </span>
          ) : null}
        </div>
      </div>
      {running ? (
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="size-3.5" /> {last?.note ? "Waiting…" : "Running…"}
          <StopTesterButton busy={stopper.stopping === tester.id} name={tester.name} onClick={() => void stopper.stop(tester.id, tester.name)} />
        </span>
      ) : (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void run()}>
          {busy ? <Spinner className="size-3.5" /> : <Play />}
          Run now
        </Button>
      )}
    </li>
  );
}

function SectionCard({ title, description, action, children }: { title: ReactNode; description?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
        {action ? <CardAction>{action}</CardAction> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function ChecksTab({ projectId, taskId, verification }: { projectId: string; taskId: string; verification: Verification }) {
  const { data, error, load } = verification;
  const [filter, setFilter] = useState<IssueFilter>("open");
  const [highlight, setHighlight] = useState<string | null>(null);
  const highlightTimer = useRef<number | undefined>(undefined);
  const stopper = useStopTester(projectId, taskId, () => void load());

  useEffect(() => () => window.clearTimeout(highlightTimer.current), []);

  const jumpToIssue = (id: string) => {
    const issue = data?.issues.find((i) => i.id === id);
    if (issue && !(ISSUE_FILTERS.find((f) => f.id === filter)?.match(issue) ?? true)) setFilter("all");
    setHighlight(id);
    window.clearTimeout(highlightTimer.current);
    highlightTimer.current = window.setTimeout(() => setHighlight(null), 2500);
    window.requestAnimationFrame(() => document.getElementById(`issue-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
  };

  const jumpToDecision = (id: string) => document.getElementById(`decision-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });

  const setIssue = async (issue: Issue, status: "dismissed" | "open") => {
    try {
      await verifyApi.setIssue(projectId, taskId, issue.id, status);
      toast.success(status === "dismissed" ? "Issue dismissed" : "Issue reopened", {
        description: status === "dismissed" ? "It no longer blocks the PR." : "The agent will treat it as open again.",
      });
      await load();
    } catch (err) {
      toast.error("Could not update the issue", { description: messageOf(err) });
    }
  };

  if (!data) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        {error ? (
          <Notice tone="warning" title="Checks and review are not available" className="max-w-lg">
            {error}
          </Notice>
        ) : (
          <Spinner label="Loading checks and review" />
        )}
      </div>
    );
  }

  const open = data.issues.filter((i) => i.status === "open").length;
  const decisions = openDecisionsOf(data).length;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto grid max-w-4xl gap-5 px-3 py-4 sm:px-6">
        {error ? <div className="text-xs text-amber-700 dark:text-amber-300">Showing last known state: {error}</div> : null}
        <DecisionCards projectId={projectId} taskId={taskId} decisions={data.decisions} onAnswered={() => void load()} />
        <p className="text-sm text-muted-foreground">
          {data.steps.length === 0
            ? "When the agent finishes a change, Nightshift runs your checks, an AI review and your external tests, and the agent fixes what they find."
            : `Round ${data.round}. ${open === 0 ? "No open issues" : `${open} open issue${open === 1 ? "" : "s"}`}${decisions ? `, ${decisions} decision${decisions === 1 ? "" : "s"} waiting for you` : ""}.`}
        </p>
        <SectionCard title={<><Radar className="size-4 text-muted-foreground" /> Steps</>} description="Each round: the agent changes the code, then checks, review and testers run. What they find goes back to the agent.">
          <StepsTimeline data={data} onJump={jumpToIssue} stopper={stopper} />
        </SectionCard>
        <SectionCard title={<><CircleX className="size-4 text-muted-foreground" /> Issues</>} description="Dismiss an issue to tell the agent not to fix it and stop it from blocking the PR.">
          <IssuesList data={data} filter={filter} setFilter={setFilter} highlight={highlight} onSet={setIssue} onJumpDecision={jumpToDecision} />
        </SectionCard>
        <SectionCard
          title={<><FlaskConical className="size-4 text-muted-foreground" /> External tests</>}
          description="Testers run a command against this task's worktree. Their findings land in the issues above."
          action={
            <Button size="sm" variant="ghost" asChild>
              <a href={projectSettingsHref(projectId)}>
                <Settings /> {data.testers.length ? "Manage" : "Add a tester"}
              </a>
            </Button>
          }
        >
          {data.testers.length === 0 ? (
            <EmptyState icon={<FlaskConical />} title="No external testers" className="py-6">
              Add one in project settings, for example Umbra's review gate or your e2e suite.
            </EmptyState>
          ) : (
            <ul className="divide-y rounded-lg border">
              {data.testers.map((t) => (
                <TesterRow key={t.id} projectId={projectId} taskId={taskId} tester={t} steps={data.steps} onRan={() => void load()} stopper={stopper} />
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
