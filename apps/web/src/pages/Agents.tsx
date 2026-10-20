import { useState } from "react";
import { Power } from "lucide-react";
import type { Run, SlotView, StatusResponse } from "@nightshift/core";
import { formatDateTime, formatElapsed, formatPercent, formatTokens, formatUsd, humanize, phaseTone } from "@nightshift/ui";
import { anySubscription, Cost, ESTIMATE_NOTE } from "../billing";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { api, messageOf } from "../api";
import { Notice } from "../components/Notice";
import { Dot, Page, PageHeader, PhaseBadge, TONE_BADGE, ToneBadge } from "../components/TaskBits";
import { runHref, taskHref, useNow } from "../routing";
import { useLive } from "../live";
import { PHASE_ORDER } from "../phases";
import { BudgetBar, Stat } from "./Usage";

function SlotCard({ slot, run, now }: { slot: SlotView; run: Run | undefined; now: number }) {
  if (!slot.runId) {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        <div className="flex items-center justify-between">
          <span className="font-medium">Slot {slot.slot}</span>
          <PhaseBadge phase={null} />
        </div>
        <div>Waiting for a task marked Ready for AI.</div>
      </div>
    );
  }
  const phase = slot.phase ?? run?.phase ?? null;
  return (
    <a
      className="flex flex-col gap-2 rounded-lg border bg-card p-4 text-sm transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      href={run ? taskHref(run.projectId, run.taskId) : runHref(slot.runId)}
    >
      <div className="flex items-center justify-between text-muted-foreground">
        <span className="font-medium">Slot {slot.slot}</span>
        <span className="font-mono text-xs" title="Elapsed">
          {formatElapsed(slot.startedAt, now)}
        </span>
      </div>
      <div>
        <div className="font-medium">{slot.taskTitle ?? run?.taskTitle ?? "Untitled task"}</div>
        <div className="font-mono text-xs text-muted-foreground">{slot.taskId ?? run?.taskId}</div>
      </div>
      <div className="flex items-center gap-2">
        <PhaseBadge phase={phase} paused={run?.paused} />
        {run ? <Cost usd={run.usage.costUsd} model={run.model} className="text-muted-foreground" /> : null}
      </div>
      <div className="truncate text-xs text-muted-foreground">{slot.activity ?? run?.activity ?? "No activity reported"}</div>
    </a>
  );
}

function PhaseCounts({ counts }: { counts: Record<string, number> }) {
  const known = PHASE_ORDER.filter((p) => (counts[p] ?? 0) > 0);
  const extra = Object.keys(counts).filter((k) => !(PHASE_ORDER as readonly string[]).includes(k) && (counts[k] ?? 0) > 0);
  const keys = [...known, ...extra];
  if (keys.length === 0) return <div className="text-sm text-muted-foreground">No runs yet.</div>;
  return (
    <div className="flex flex-wrap gap-2">
      {keys.map((key) => (
        <span key={key} className={cn("inline-flex items-center gap-2 rounded-md px-2 py-1 text-xs", TONE_BADGE[phaseTone(key)])}>
          {humanize(key)}
          <strong className="tabular-nums">{counts[key]}</strong>
        </span>
      ))}
    </div>
  );
}

function KillSwitch({ status }: { status: StatusResponse }) {
  const { patchStatus } = useLive();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = async (on: boolean) => {
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      const res = await api.killSwitch(on);
      patchStatus({ killSwitch: res.killSwitch });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className={cn(status.killSwitch && "ring-red-500/40")}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Power className="size-4" /> Kill switch
        </CardTitle>
        <CardDescription>Stops every session and blocks new tasks.</CardDescription>
        <CardAction>
          <Switch
            checked={status.killSwitch}
            aria-label="Kill switch"
            disabled={busy}
            className="data-checked:bg-red-600"
            onCheckedChange={(next) => (next ? setConfirming(true) : void apply(false))}
          />
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Dot tone={status.killSwitch ? "danger" : "success"} />
          {status.killSwitch ? "On: all agents stopped" : "Off: agents running"}
        </div>
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </CardContent>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn on the kill switch?</AlertDialogTitle>
            <AlertDialogDescription>Every running agent session stops and no new tasks are taken until you turn it off again.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void apply(true)}>
              Stop all agents
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function UsageToday({ status }: { status: StatusResponse }) {
  const used = status.usageToday.costUsd;
  const budget = status.budgets.perDayUsd;
  const ratio = budget > 0 ? used / budget : 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Usage today</CardTitle>
        <CardAction>
          <a href="#/usage" className="text-sm text-muted-foreground hover:text-foreground hover:underline">
            Details
          </a>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <Stat
          label={anySubscription(status.billing ?? {}) ? "Spent (estimate)" : "Spent"}
          value={anySubscription(status.billing ?? {}) ? `≈${formatUsd(used)}` : formatUsd(used)}
          tone={ratio >= 1 ? "danger" : ratio >= 0.8 ? "warning" : undefined}
          hint={budget > 0 ? `of ${formatUsd(budget)} daily budget (${formatPercent(ratio)})` : "No daily budget set"}
        />
        {anySubscription(status.billing ?? {}) ? <p className="text-xs text-muted-foreground">{ESTIMATE_NOTE}</p> : null}
        {budget > 0 ? <BudgetBar value={used} max={budget} label="Daily budget used" /> : null}
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Input" value={formatTokens(status.usageToday.inputTokens)} />
          <Stat label="Output" value={formatTokens(status.usageToday.outputTokens)} />
          <Stat label="Cache read" value={formatTokens(status.usageToday.cacheReadTokens)} />
        </div>
        <div className="text-xs text-muted-foreground">Per-run budget: {formatUsd(status.budgets.perRunUsd)}</div>
      </CardContent>
    </Card>
  );
}

function SourceCard({ status, now }: { status: StatusResponse; now: number }) {
  const { source } = status;
  const rows = [
    { label: "Last poll", value: source.lastPollAt ? `${formatElapsed(source.lastPollAt, now)} ago` : "Never" },
    { label: "Default model", value: <code className="font-mono text-xs">{status.model}</code> },
    { label: "Daemon up", value: formatElapsed(status.startedAt, now) },
    { label: "Version", value: status.version },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Task source</CardTitle>
        <CardDescription>{source.name}</CardDescription>
        <CardAction>
          <ToneBadge tone={source.connected ? "success" : "danger"}>
            <Dot tone={source.connected ? "success" : "danger"} className="size-1.5" />
            {source.connected ? "Connected" : "Disconnected"}
          </ToneBadge>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {rows.map((r) => (
            <div key={r.label} className="contents">
              <dt className="text-muted-foreground">{r.label}</dt>
              <dd className="text-right">{r.value}</dd>
            </div>
          ))}
        </dl>
        {source.lastError ? (
          <Notice tone="danger" title="Last source error">
            {source.lastError}
          </Notice>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function Agents() {
  const { status, runs } = useLive();
  const now = useNow();

  if (!status) {
    return (
      <Page>
        <PageHeader title="Agents" description="Waiting for the daemon to answer." />
        <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </Page>
    );
  }

  const busy = status.slots.filter((s) => s.runId).length;

  return (
    <Page>
      <PageHeader
        title="Agents"
        description={`${busy} of ${status.slots.length} agents busy · started ${formatDateTime(status.startedAt)}`}
      />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Slots</CardTitle>
              <CardAction>
                <ToneBadge tone={busy > 0 ? "info" : "muted"}>{busy} busy</ToneBadge>
              </CardAction>
            </CardHeader>
            <CardContent>
              {status.slots.length === 0 ? (
                <div className="text-sm text-muted-foreground">No agent slots configured</div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {status.slots.map((slot) => (
                    <SlotCard key={slot.slot} slot={slot} run={slot.runId ? runs?.[slot.runId] : undefined} now={now} />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Runs by phase</CardTitle>
            </CardHeader>
            <CardContent>
              <PhaseCounts counts={status.counts} />
            </CardContent>
          </Card>
        </div>
        <div className="space-y-4">
          <KillSwitch status={status} />
          <UsageToday status={status} />
          <SourceCard status={status} now={now} />
        </div>
      </div>
    </Page>
  );
}
