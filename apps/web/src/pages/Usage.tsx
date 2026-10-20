import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { UsageDay, UsageResponse, UsageTotals } from "@nightshift/core";
import { formatPercent, formatTokens, formatUsd } from "@nightshift/ui";
import { anySubscription, Cost, ESTIMATE_NOTE } from "../billing";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { api, messageOf } from "../api";
import { LimitsCard } from "../components/LimitsCard";
import { Notice } from "../components/Notice";
import { Page, PageHeader } from "../components/TaskBits";
import { runHref } from "../routing";
import { useLive } from "../live";

const REFRESH_MS = 15000;

export type Column<T> = { key: string; header: ReactNode; render: (row: T) => ReactNode; align?: "left" | "right" };

export function DataTable<T>({ columns, rows, rowKey, caption, empty }: { columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string; caption: string; empty: ReactNode }) {
  return (
    <Table>
      <TableCaption className="sr-only">{caption}</TableCaption>
      <TableHeader>
        <TableRow>
          {columns.map((c) => (
            <TableHead key={c.key} className={cn(c.align === "right" && "text-right")}>
              {c.header}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={columns.length} className="py-8 text-center text-muted-foreground">
              {empty}
            </TableCell>
          </TableRow>
        ) : (
          rows.map((row) => (
            <TableRow key={rowKey(row)}>
              {columns.map((c) => (
                <TableCell key={c.key} className={cn(c.align === "right" && "text-right tabular-nums")}>
                  {c.render(row)}
                </TableCell>
              ))}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}

export function Stat({ label, value, hint, tone }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: "warning" | "danger" }) {
  return (
    <div className="min-w-0 space-y-1">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className={cn("text-2xl font-semibold tabular-nums tracking-tight", tone === "danger" && "text-red-600 dark:text-red-400", tone === "warning" && "text-amber-600 dark:text-amber-400")}>
        {value}
      </div>
      {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

export function BudgetBar({ value, max, label }: { value: number; max: number; label: string }) {
  const ratio = max > 0 ? value / max : 0;
  return (
    <Progress
      value={Math.min(100, Math.max(0, ratio * 100))}
      aria-label={label}
      className={cn("h-2", ratio >= 1 ? "[&>div]:bg-red-500" : ratio >= 0.8 ? "[&>div]:bg-amber-500" : "[&>div]:bg-emerald-500")}
    />
  );
}

const usageColumns = <T,>(pick: (row: T) => UsageTotals, modelOf?: (row: T) => string | null): Column<T>[] => [
  { key: "in", header: "Input", align: "right", render: (r) => formatTokens(pick(r).inputTokens) },
  { key: "out", header: "Output", align: "right", render: (r) => formatTokens(pick(r).outputTokens) },
  { key: "cr", header: "Cache read", align: "right", render: (r) => formatTokens(pick(r).cacheReadTokens) },
  { key: "cw", header: "Cache write", align: "right", render: (r) => formatTokens(pick(r).cacheWriteTokens) },
  { key: "cost", header: "Cost", align: "right", render: (r) => <Cost usd={pick(r).costUsd} model={modelOf?.(r)} /> },
];

type ModelRow = { model: string; usage: UsageTotals };
type RunRow = UsageResponse["byRun"][number];

const dayColumns: Column<UsageDay>[] = [
  { key: "day", header: "Day", render: (r) => r.day },
  { key: "model", header: "Model", render: (r) => <code className="font-mono text-xs">{r.model}</code> },
  ...usageColumns<UsageDay>((r) => r.usage, (r) => r.model),
];

const runColumns: Column<RunRow>[] = [
  {
    key: "task",
    header: "Task",
    render: (r) => (
      <a href={runHref(r.runId)} title={r.taskId} className="font-medium hover:underline">
        {r.taskTitle || r.taskId}
      </a>
    ),
  },
  { key: "id", header: "Task id", render: (r) => <span className="font-mono text-xs text-muted-foreground">{r.taskId}</span> },
  ...usageColumns<RunRow>((r) => r.usage),
];

const modelColumns: Column<ModelRow>[] = [
  { key: "model", header: "Model", render: (r) => <code className="font-mono text-xs">{r.model}</code> },
  ...usageColumns<ModelRow>((r) => r.usage, (r) => r.model),
];

function TableCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b py-4">
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-0">{children}</CardContent>
    </Card>
  );
}

export function Usage() {
  const { status } = useLive();
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setUsage(await api.usage());
      setError(null);
    } catch (err) {
      setError(messageOf(err));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  if (!usage) {
    return (
      <Page>
        <PageHeader title="Usage" />
        {error ? (
          <Notice tone="danger" title="Could not load usage">
            {error}
          </Notice>
        ) : (
          <div className="space-y-4">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        )}
      </Page>
    );
  }

  const { today } = usage;
  const budget = status?.budgets.perDayUsd ?? 0;
  const ratio = budget > 0 ? today.costUsd / budget : 0;
  const days = [...usage.days].sort((a, b) => b.day.localeCompare(a.day) || a.model.localeCompare(b.model));
  const runs = [...usage.byRun].sort((a, b) => b.usage.costUsd - a.usage.costUsd);
  const models = Object.entries(usage.byModel)
    .map(([model, u]) => ({ model, usage: u }))
    .sort((a, b) => b.usage.costUsd - a.usage.costUsd);

  return (
    <Page>
      <PageHeader title="Usage" description="Tokens and cost across all agents." />
      {error ? (
        <Notice tone="warning" title="Showing last known usage">
          {error}
        </Notice>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Today</CardTitle>
          {budget > 0 ? <CardDescription>Daily budget {formatUsd(budget)}</CardDescription> : null}
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <Stat
              label={anySubscription(usage.billing ?? {}) ? "Cost (estimate)" : "Cost"}
              value={anySubscription(usage.billing ?? {}) ? `≈${formatUsd(today.costUsd)}` : formatUsd(today.costUsd)}
              tone={ratio >= 1 ? "danger" : ratio >= 0.8 ? "warning" : undefined}
              hint={budget > 0 ? `${formatPercent(ratio)} of ${formatUsd(budget)}` : undefined}
            />
            <Stat label="Input tokens" value={formatTokens(today.inputTokens)} />
            <Stat label="Output tokens" value={formatTokens(today.outputTokens)} />
            <Stat label="Cache read" value={formatTokens(today.cacheReadTokens)} />
            <Stat label="Cache write" value={formatTokens(today.cacheWriteTokens)} />
          </div>
          {budget > 0 ? <BudgetBar value={today.costUsd} max={budget} label="Daily budget used" /> : null}
          {anySubscription(usage.billing ?? {}) ? <p className="text-xs text-muted-foreground">{ESTIMATE_NOTE}</p> : null}
        </CardContent>
      </Card>
      <LimitsCard />
      <TableCard title="By day and model">
        <DataTable caption="Usage by day and model" columns={dayColumns} rows={days} rowKey={(r) => `${r.day}|${r.model}`} empty="No usage recorded" />
      </TableCard>
      <TableCard title="By run">
        <DataTable caption="Usage by run" columns={runColumns} rows={runs} rowKey={(r) => r.runId} empty="No runs with usage" />
      </TableCard>
      <TableCard title="By model">
        <DataTable caption="Usage by model" columns={modelColumns} rows={models} rowKey={(r) => r.model} empty="No usage recorded" />
      </TableCard>
    </Page>
  );
}
