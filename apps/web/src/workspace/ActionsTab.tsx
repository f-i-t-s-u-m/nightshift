import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Ban, CircleCheck, CircleDashed, CircleMinus, CircleX, ExternalLink, Loader2, PlayCircle, RefreshCw, SkipForward } from "lucide-react";
import type { ActionRun } from "@nightshift/core";
import { formatDateTime, formatRelative } from "@nightshift/ui";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { messageOf } from "../api";
import { Notice } from "../components/Notice";
import { EmptyState, Spinner, ToneBadge } from "../components/TaskBits";
import { NoWorkspace, SplitPane, useLoad, useWorkspaceRefresh, type WorkspaceTabProps } from "./common";

const POLL_MS = 10000;

export function RunIcon({ run, className }: { run: ActionRun; className?: string }) {
  const c = cn("size-4 shrink-0", className);
  if (run.status === "queued") return <CircleDashed className={cn(c, "text-amber-500")} aria-label="Queued" />;
  if (run.status === "in_progress") return <Loader2 className={cn(c, "animate-spin text-amber-500")} aria-label="In progress" />;
  switch (run.conclusion) {
    case "success":
      return <CircleCheck className={cn(c, "text-emerald-600 dark:text-emerald-400")} aria-label="Succeeded" />;
    case "failure":
      return <CircleX className={cn(c, "text-red-600 dark:text-red-400")} aria-label="Failed" />;
    case "cancelled":
      return <Ban className={cn(c, "text-muted-foreground")} aria-label="Cancelled" />;
    case "skipped":
      return <SkipForward className={cn(c, "text-muted-foreground")} aria-label="Skipped" />;
    default:
      return <CircleMinus className={cn(c, "text-muted-foreground")} aria-label="Neutral" />;
  }
}

const runLabel = (run: ActionRun) => (run.status === "completed" ? (run.conclusion ?? "completed") : run.status.replace("_", " "));

export default function ActionsTab({ projectId, taskId, ws, workspace, active }: WorkspaceTabProps) {
  const actions = useLoad(() => ws.actions(), workspace.exists);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const logEnd = useRef<HTMLDivElement>(null);

  const runs = actions.data?.runs ?? [];
  const selected = runs.find((r) => r.id === selectedId) ?? null;
  const running = runs.some((r) => r.status !== "completed");

  const loadLog = useCallback(
    async (id: string | null) => {
      if (!id) return;
      setLogLoading(true);
      try {
        const res = await ws.actionLog(id);
        setLog(res.log);
        setLogError(null);
      } catch (err) {
        setLogError(messageOf(err));
      } finally {
        setLogLoading(false);
      }
    },
    [ws],
  );

  useEffect(() => {
    setLog(null);
    setLogError(null);
    void loadLog(selectedId);
  }, [selectedId, loadLog]);

  const refresh = useCallback(() => {
    void actions.reload();
    void loadLog(selectedId);
  }, [actions.reload, loadLog, selectedId]);

  useWorkspaceRefresh(projectId, taskId, active, refresh);

  useEffect(() => {
    if (!active || !running) return;
    const timer = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, running, refresh]);

  useLayoutEffect(() => {
    logEnd.current?.scrollIntoView({ block: "end" });
  }, [log]);

  if (actions.missing || !workspace.exists) return <NoWorkspace />;

  const data = actions.data;

  const list = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Runs</span>
        {data ? <ToneBadge tone="muted">{data.provider === "github" ? "GitHub Actions" : "Local checks"}</ToneBadge> : null}
        <span className="ml-auto" />
        {actions.loading ? <Spinner className="size-3.5" /> : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label="Refresh runs" onClick={refresh}>
              <RefreshCw />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh</TooltipContent>
        </Tooltip>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2 p-2">
          {data?.error ? (
            <Notice tone="warning" title={data.provider === "github" ? "GitHub Actions unavailable" : "Checks unavailable"}>
              {data.error}
            </Notice>
          ) : null}
          {actions.error && !data ? <Notice tone="danger" title="Could not load runs">{actions.error}</Notice> : null}
          {!data && actions.loading ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : null}
          {data && runs.length === 0 && !data.error ? (
            <EmptyState icon={<PlayCircle />} title="No runs yet">
              {data.provider === "github" ? "Workflow runs for this branch show up here after the agent pushes." : "Nightshift's check results show up here after the agent runs them."}
            </EmptyState>
          ) : null}
          {runs.length > 0 ? (
            <ul className="divide-y rounded-md border">
              {runs.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    aria-current={r.id === selectedId ? "true" : undefined}
                    className={cn(
                      "flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
                      r.id === selectedId && "bg-muted",
                    )}
                    onClick={() => setSelectedId(r.id)}
                  >
                    <RunIcon run={r} className="mt-0.5" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{r.name}</span>
                      <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                        <span className="capitalize">{runLabel(r)}</span>
                        <span>{r.event}</span>
                        {r.sha ? <code className="font-mono">{r.sha.slice(0, 7)}</code> : null}
                        <time dateTime={r.createdAt} title={formatDateTime(r.createdAt)}>
                          {formatRelative(r.createdAt)}
                        </time>
                        {r.source === "nightshift" ? <span>Nightshift</span> : null}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );

  const logPane = selected ? (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-sm">
        <RunIcon run={selected} />
        <span className="min-w-0 truncate font-medium">{selected.name}</span>
        <span className="hidden text-xs text-muted-foreground capitalize sm:inline">{runLabel(selected)}</span>
        <span className="ml-auto" />
        {logLoading ? <Spinner className="size-3.5" /> : null}
        {selected.url ? (
          <Button asChild variant="ghost" size="xs">
            <a href={selected.url} target="_blank" rel="noopener noreferrer">
              <ExternalLink /> GitHub
            </a>
          </Button>
        ) : null}
      </div>
      <ScrollArea className="min-h-0 flex-1 bg-zinc-950 text-zinc-100">
        {logError && log === null ? (
          <div className="p-4 text-sm text-red-300">{logError}</div>
        ) : log === null ? (
          <div className="p-4 text-sm text-zinc-400">Loading log…</div>
        ) : (
          <pre className="p-4 font-mono text-xs leading-5 whitespace-pre-wrap break-all" aria-label={`Log for ${selected.name}`} tabIndex={0}>
            {log || "No output."}
          </pre>
        )}
        <div ref={logEnd} />
      </ScrollArea>
    </div>
  ) : (
    <EmptyState icon={<PlayCircle />} title="Select a run" className="h-full">
      Pick a run to see its log.
    </EmptyState>
  );

  return <SplitPane id={`actions-${projectId}-${taskId}`} first={list} second={logPane} firstSize="36%" firstMin="260px" className="h-full" />;
}
