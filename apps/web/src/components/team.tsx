import { useState } from "react";
import { ChevronDown, GitBranch, GitMerge, MessageSquareText, TriangleAlert, User, Users } from "lucide-react";
import { toast } from "sonner";
import { TEAM_MAX_WORKERS, TEAM_MIN_WORKERS, type TeamView, type TeamWorkerStatus, type TeamWorkerView } from "@nightshift/core";
import type { Tone } from "@nightshift/ui";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { api, messageOf } from "../api";
import { Markdown } from "./Markdown";
import { Spinner, ToneBadge } from "./TaskBits";

const STATUS: Record<TeamWorkerStatus, { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "muted" },
  preparing: { label: "Preparing", tone: "info" },
  working: { label: "Working", tone: "info" },
  done: { label: "Done", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  stopped: { label: "Stopped", tone: "muted" },
};

function MergeNote({ worker }: { worker: TeamWorkerView }) {
  if (worker.merge === "merged")
    return (
      <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
        <GitMerge className="size-3" /> merged
      </span>
    );
  if (worker.merge === "conflict")
    return (
      <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400" title={worker.conflicts.join("\n")}>
        <TriangleAlert className="size-3" /> conflicts in {worker.conflicts.length} file{worker.conflicts.length === 1 ? "" : "s"}, left to the lead
      </span>
    );
  if (worker.merge === "nothing") return <span className="text-muted-foreground">no changes</span>;
  return null;
}

/** The lead's workers on a team task: what each was given, how far it got and whether its work was merged. */
export function TeamPanel({ team, onOpenSession }: { team: TeamView; onOpenSession: (sessionId: string) => void }) {
  if (!team.workers.length)
    return (
      <p className="text-sm text-muted-foreground">
        A lead agent with up to {team.maxWorkers} workers. The lead decides whether to split the work; nothing has been handed out yet.
      </p>
    );
  return (
    <ul className="grid gap-2">
      {team.workers.map((w) => {
        const status = STATUS[w.status];
        const live = w.status === "working" || w.status === "preparing";
        return (
          <li key={w.id} className={cn("grid gap-1.5 rounded-lg border p-2.5 text-sm", w.status === "failed" && "border-red-500/30")}>
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-xs font-medium text-muted-foreground">Worker {w.index}</span>
              <span className="min-w-0 flex-1 truncate font-medium" title={w.title}>
                {w.title}
              </span>
              <ToneBadge tone={status.tone} className="shrink-0">
                {live ? <Spinner className="size-3 text-current" /> : null}
                {status.label}
              </ToneBadge>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span className="inline-flex min-w-0 items-center gap-1 font-mono text-muted-foreground" title={`Local branch ${w.branch} (never pushed)`}>
                <GitBranch className="size-3 shrink-0" />
                <span className="truncate">{w.branch.split("--").pop()}</span>
              </span>
              <MergeNote worker={w} />
              {w.sessionId ? (
                <Button type="button" variant="ghost" size="sm" className="ml-auto h-6 px-1.5 text-xs" onClick={() => onOpenSession(w.sessionId!)}>
                  <MessageSquareText className="size-3" /> Transcript
                </Button>
              ) : null}
            </div>
            {w.error ? <p className="text-xs text-destructive">{w.error}</p> : null}
            {w.summary ? (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Summary</summary>
                <div className="mt-1">
                  <Markdown text={w.summary} />
                </div>
              </details>
            ) : (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Brief</summary>
                <div className="mt-1">
                  <Markdown text={w.brief} />
                </div>
              </details>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function TeamBadge({ workers, className }: { workers: number; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md border border-teal-500/40 bg-teal-500/10 px-1.5 py-px text-teal-800 dark:text-teal-200", className)} title={`A lead agent with up to ${workers} workers`}>
      <Users className="size-3 shrink-0" /> team · {workers}
    </span>
  );
}

/** Switches team mode for an existing task: one agent, or a lead with up to N workers. */
export function TeamMenu({ projectId, taskId, team, done, onChanged }: { projectId: string; taskId: string; team: TeamView | null; done: boolean; onChanged: (team: TeamView | null) => void }) {
  const [busy, setBusy] = useState(false);
  const value = team ? String(team.maxWorkers) : "one";
  const change = async (next: string) => {
    if (busy || next === value) return;
    setBusy(true);
    try {
      const res = await api.setTaskTeam(projectId, taskId, next === "one" ? null : Number(next));
      onChanged(res.team);
      toast.success(res.team ? `Team of up to ${res.team.maxWorkers} workers` : "One agent", { description: res.effect });
    } catch (err) {
      toast.error("Could not change the team", { description: messageOf(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={busy || done}
          aria-label={team ? `Team mode: up to ${team.maxWorkers} workers. Change` : "One agent. Change to a team"}
          title={done ? "The task is done" : undefined}
          className={cn(
            "inline-flex h-5 items-center gap-1 rounded-4xl border px-2 text-xs font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60 [&_svg]:size-3",
            team ? "border-teal-500/40 bg-teal-500/10 text-teal-800 hover:brightness-95 dark:text-teal-200" : "border-dashed border-border text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {busy ? <Spinner className="size-3 text-current" /> : team ? <Users aria-hidden="true" /> : <User aria-hidden="true" />}
          {team ? `Team · ${team.maxWorkers}` : "One agent"}
          <ChevronDown aria-hidden="true" className="opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>Agents on this task</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value} onValueChange={(v) => void change(v)}>
          <DropdownMenuRadioItem value="one" className="items-start py-1.5">
            <span className="grid gap-0.5">
              <span>One agent</span>
              <span className="text-xs leading-snug text-muted-foreground">A single agent does the work. Workers already running finish first.</span>
            </span>
          </DropdownMenuRadioItem>
          {Array.from({ length: TEAM_MAX_WORKERS - TEAM_MIN_WORKERS + 1 }, (_, i) => TEAM_MIN_WORKERS + i).map((n) => (
            <DropdownMenuRadioItem key={n} value={String(n)} className="items-start py-1.5">
              <span className="grid gap-0.5">
                <span>Team: lead + up to {n} workers</span>
                {n === TEAM_MIN_WORKERS ? <span className="text-xs leading-snug text-muted-foreground">The lead can split the remaining work from its next step; each worker gets its own worktree.</span> : null}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
