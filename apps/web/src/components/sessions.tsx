import { useEffect, useId, useState, type ReactNode } from "react";
import { ChevronRight, Plus } from "lucide-react";
import { toast } from "sonner";
import type { NewSessionInput, SessionReason, SessionsResponse, TaskSession } from "@nightshift/core";
import { formatDateTime, formatRelative, formatTokens } from "@nightshift/ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { api, messageOf } from "../api";
import { Notice } from "./Notice";
import { Spinner } from "./TaskBits";

export const LARGE_CONTEXT = 0.7;

export const contextRatio = (s: Pick<TaskSession, "contextTokens" | "contextWindow"> | null | undefined) =>
  s && s.contextTokens !== null && s.contextWindow ? s.contextTokens / s.contextWindow : null;

const level = (ratio: number) => (ratio > 0.8 ? "high" : ratio >= 0.5 ? "mid" : "low");

const LEVEL_BAR = {
  low: "*:data-[slot=progress-indicator]:bg-emerald-500",
  mid: "*:data-[slot=progress-indicator]:bg-amber-500",
  high: "*:data-[slot=progress-indicator]:bg-red-500",
} as const;

const LEVEL_TEXT = {
  low: "text-emerald-700 dark:text-emerald-400",
  mid: "text-amber-700 dark:text-amber-400",
  high: "text-red-700 dark:text-red-400",
} as const;

const REASONS: Record<SessionReason, { label: string; className: string }> = {
  start: { label: "Start", className: "bg-muted text-muted-foreground" },
  fresh: { label: "Fresh", className: "bg-sky-500/15 text-sky-700 dark:text-sky-300" },
  handoff: { label: "Handoff", className: "bg-violet-500/15 text-violet-700 dark:text-violet-300" },
  retry: { label: "Retry", className: "bg-amber-500/15 text-amber-800 dark:text-amber-300" },
};

const pct = (ratio: number) => `${Math.round(Math.min(ratio, 1) * 100)}%`;

export function ContextMeter({ session, compact }: { session: TaskSession; compact?: boolean }) {
  const ratio = contextRatio(session);
  if (ratio === null) {
    return compact ? (
      <span className="text-muted-foreground">Context unknown</span>
    ) : (
      <div className="text-xs text-muted-foreground">Context size unknown</div>
    );
  }
  const lv = level(ratio);
  const amount = `${formatTokens(session.contextTokens ?? 0)} / ${formatTokens(session.contextWindow ?? 0)}`;
  if (compact) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Progress value={Math.min(ratio, 1) * 100} className={cn("h-1.5 w-12", LEVEL_BAR[lv])} aria-label="Context used" />
        <span className={cn("font-medium tabular-nums", LEVEL_TEXT[lv])}>Context {pct(ratio)}</span>
        <span className="hidden tabular-nums sm:inline">· {amount}</span>
      </span>
    );
  }
  return (
    <div className="grid gap-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">Context</span>
        <span className="tabular-nums">
          <span className={cn("font-medium", LEVEL_TEXT[lv])}>{pct(ratio)}</span>
          <span className="text-muted-foreground"> · {amount}</span>
        </span>
      </div>
      <Progress value={Math.min(ratio, 1) * 100} className={cn("h-1.5", LEVEL_BAR[lv])} aria-label={`Context used: ${pct(ratio)}`} />
    </div>
  );
}

export function LargeContextHint({ onNew, className }: { onNew?: () => void; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100", className)}>
      <span className="min-w-0 flex-1">Context is getting large — start a new session to keep the agent sharp.</span>
      {onNew ? (
        <Button type="button" size="xs" variant="outline" onClick={onNew}>
          <Plus /> New session
        </Button>
      ) : null}
    </div>
  );
}

function SessionRow({ session, viewing, onSelect }: { session: TaskSession; viewing: boolean; onSelect: () => void }) {
  const reason = REASONS[session.reason] ?? { label: session.reason, className: "bg-muted text-muted-foreground" };
  return (
    <li className={cn("rounded-md border bg-card text-sm transition-colors", viewing && "border-primary/60 ring-1 ring-primary/30")}>
      <button
        type="button"
        onClick={onSelect}
        aria-current={viewing ? "true" : undefined}
        className="grid w-full gap-2 rounded-md p-2.5 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="font-medium">{session.label}</span>
          <span className={cn("rounded px-1.5 text-xs font-medium", reason.className)}>{reason.label}</span>
          {session.active ? (
            <Badge className="h-5 px-1.5 text-[10px]">Current</Badge>
          ) : null}
          {viewing && !session.active ? <span className="text-xs text-muted-foreground">viewing</span> : null}
          <time className="ml-auto text-xs text-muted-foreground" dateTime={session.createdAt} title={formatDateTime(session.createdAt)}>
            {formatRelative(session.createdAt)}
          </time>
        </span>
        <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 truncate font-mono" title={session.model}>
            {session.model}
          </span>
          <span className="shrink-0">·</span>
          <span className="shrink-0 tabular-nums">
            {session.turns} turn{session.turns === 1 ? "" : "s"}
          </span>
        </span>
        <ContextMeter session={session} />
      </button>
      {session.summary ? (
        <Collapsible className="group/summary border-t">
          <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-1.5 px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]/summary:rotate-90" />
            <span className="shrink-0 font-medium">Summary</span>
            <span className="min-w-0 truncate group-data-[state=open]/summary:hidden">{session.summary.split("\n")[0]}</span>
          </CollapsibleTrigger>
          <CollapsibleContent className="max-h-64 overflow-auto px-2.5 pb-2.5 text-xs whitespace-pre-wrap text-muted-foreground">{session.summary}</CollapsibleContent>
        </Collapsible>
      ) : null}
    </li>
  );
}

type CanStart = SessionsResponse["canStartNew"];

export function useCanStartNew(projectId: string, taskId: string, key: string) {
  const [canStart, setCanStart] = useState<CanStart | null>(null);
  useEffect(() => {
    let live = true;
    api
      .sessions(projectId, taskId)
      .then((res) => {
        if (live) setCanStart(res.canStartNew);
      })
      .catch(() => {
        if (live) setCanStart(null);
      });
    return () => {
      live = false;
    };
  }, [projectId, taskId, key]);
  return canStart;
}

export function NewSessionButton({ canStart, onClick, size = "sm" }: { canStart: CanStart | null; onClick: () => void; size?: "sm" | "xs" }) {
  const blocked = canStart !== null && !canStart.allowed;
  const button = (
    <Button type="button" size={size} variant="outline" disabled={blocked} onClick={onClick}>
      <Plus /> New session
    </Button>
  );
  if (!blocked) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
          {button}
        </span>
      </TooltipTrigger>
      <TooltipContent>{canStart?.reason ?? "A new session cannot be started right now"}</TooltipContent>
    </Tooltip>
  );
}

export function SessionsList({
  sessions,
  viewingId,
  canStart,
  onSelect,
  onNew,
}: {
  sessions: TaskSession[];
  viewingId: string | null;
  canStart: CanStart | null;
  onSelect: (session: TaskSession) => void;
  onNew: () => void;
}) {
  const ordered = [...sessions].sort((a, b) => b.index - a.index);
  const active = sessions.find((s) => s.active);
  const ratio = contextRatio(active);
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">Each session is a separate conversation with the agent.</span>
        <NewSessionButton canStart={canStart} onClick={onNew} size="xs" />
      </div>
      {ratio !== null && ratio > LARGE_CONTEXT && canStart?.allowed !== false ? <LargeContextHint /> : null}
      {ordered.length === 0 ? (
        <div className="text-sm text-muted-foreground">No sessions yet</div>
      ) : (
        <ul className="grid gap-2" aria-label="Sessions">
          {ordered.map((s) => (
            <SessionRow key={s.id} session={s} viewing={s.id === viewingId} onSelect={() => onSelect(s)} />
          ))}
        </ul>
      )}
    </div>
  );
}

const MODES: Array<{ mode: NewSessionInput["mode"]; title: string; badge?: string; body: ReactNode }> = [
  {
    mode: "handoff",
    title: "Handoff",
    badge: "Recommended",
    body: "Start a new session that begins with a summary of the current one. Writing the summary takes a few seconds.",
  },
  { mode: "fresh", title: "Fresh", body: "Start a new session with only the task and the current state of the code." },
  { mode: "compact", title: "Compact", body: "Stay in this session but summarise older messages to shrink the context." },
];

export function NewSessionDialog({
  projectId,
  taskId,
  open,
  onOpenChange,
  onDone,
}: {
  projectId: string;
  taskId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<NewSessionInput["mode"]>("handoff");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.newSession(projectId, taskId, { mode, ...(note.trim() ? { note: note.trim() } : {}) });
      toast.success(mode === "compact" ? "Compacting context" : res.session ? `${res.session.label} started` : "New session started", { description: res.effect });
      setNote("");
      setMode("handoff");
      onOpenChange(false);
      onDone();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-lg">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>New session</DialogTitle>
            <DialogDescription>A large context can make the agent lose focus. Choose how the agent continues.</DialogDescription>
          </DialogHeader>
          <RadioGroup value={mode} onValueChange={(v) => setMode(v as NewSessionInput["mode"])} aria-label="How to continue" disabled={busy}>
            {MODES.map((m) => (
              <Label
                key={m.mode}
                htmlFor={`${id}-${m.mode}`}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal transition-colors hover:bg-muted/50",
                  mode === m.mode && "border-primary/60 bg-primary/5",
                )}
              >
                <RadioGroupItem id={`${id}-${m.mode}`} value={m.mode} className="mt-0.5" />
                <span className="grid gap-1">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {m.title}
                    {m.badge ? (
                      <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                        {m.badge}
                      </Badge>
                    ) : null}
                  </span>
                  <span className="text-xs leading-relaxed text-muted-foreground">{m.body}</span>
                </span>
              </Label>
            ))}
          </RadioGroup>
          <div className="grid gap-2">
            <Label htmlFor={`${id}-note`}>Note for the agent (optional)</Label>
            <Textarea
              id={`${id}-note`}
              rows={3}
              value={note}
              disabled={busy}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Focus on the failing test"
            />
          </div>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy} aria-busy={busy}>
              {busy ? <Spinner className="size-3.5" /> : null}
              {busy ? (mode === "handoff" ? "Writing summary…" : mode === "compact" ? "Compacting…" : "Starting…") : mode === "compact" ? "Compact context" : "Start session"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
