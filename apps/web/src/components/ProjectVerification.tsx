import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { ChevronDown, ExternalLink, FlaskConical, Plus, Radar, X } from "lucide-react";
import { toast } from "sonner";
import { DEFAULT_TRIGGERS, TESTER_PRESETS, type TaskOriginKind, type TesterConfig, type TesterFormat, type TesterPreset, type TesterWhen, type TriggerConfig, type TriggersResponse } from "@nightshift/core";
import { formatDateTime, formatRelative } from "@nightshift/ui";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { messageOf, verifyApi } from "../api";
import { taskHref } from "../routing";
import { Notice } from "./Notice";
import { Field } from "./ProjectForm";
import { Spinner, ToneBadge } from "./TaskBits";

const FORMATS: Array<{ value: TesterFormat; label: string; hint: string }> = [
  { value: "umbra", label: "Umbra", hint: "Reads Umbra's verdict: blocking and advisory findings, and claims it could not decide become decisions for you." },
  { value: "nightshift-json", label: "Nightshift JSON", hint: "The command prints findings as JSON on stdout." },
  { value: "exit-code", label: "Pass/fail exit code", hint: "A non-zero exit becomes one finding with the end of the output." },
];

const WHENS: Array<{ value: TesterWhen; label: string }> = [
  { value: "every-round", label: "Every round" },
  { value: "before-pr", label: "Before opening the PR" },
  { value: "manual", label: "Only when I run it" },
];

const ENV_VARS: Array<[string, string]> = [
  ["NIGHTSHIFT_WORKTREE", "absolute path of the task's worktree (the command also runs there)"],
  ["NIGHTSHIFT_BASE", "the base branch, for example main"],
  ["NIGHTSHIFT_BRANCH", "the agent's branch"],
  ["NIGHTSHIFT_TASK", "the task title and description"],
  ["NIGHTSHIFT_TASK_ID", "the task id"],
  ["DATABASE_URL", "the task's database, when the project has one"],
  ["PREVIEW_URL", "the running preview, when there is one"],
];

const newId = () => `t-${Math.random().toString(36).slice(2, 8)}`;

const fromPreset = (p: TesterPreset): TesterConfig => ({
  id: newId(),
  name: p.name,
  command: p.command,
  format: p.format,
  when: p.when,
  blocking: p.blocking,
  enabled: true,
  ...(p.timeoutMs ? { timeoutMs: p.timeoutMs } : {}),
  ...(p.queue ? { queue: p.queue } : {}),
  ...(p.onError ? { onError: p.onError } : {}),
});

function TesterEditor({ tester, prefix, onChange, onRemove }: { tester: TesterConfig; prefix: string; onChange: (patch: Partial<TesterConfig>) => void; onRemove: () => void }) {
  const id = (s: string) => `${prefix}-${tester.id}-${s}`;
  const format = FORMATS.find((f) => f.value === tester.format);
  const nameMissing = !tester.name.trim();
  const commandMissing = !tester.command.trim();
  return (
    <li className={cn("grid gap-3 rounded-lg border p-3", !tester.enabled && "bg-muted/40")}>
      <div className="flex items-end gap-2">
        <Field id={id("name")} label="Name" className="flex-1" error={nameMissing} hint={nameMissing ? "A name is required" : undefined}>
          <Input id={id("name")} value={tester.name} onChange={(e) => onChange({ name: e.target.value })} aria-invalid={nameMissing} placeholder="Umbra review" />
        </Field>
        <div className="flex h-8 items-center gap-2">
          <Label htmlFor={id("enabled")} className="text-xs font-normal text-muted-foreground">
            {tester.enabled ? "On" : "Off"}
          </Label>
          <Switch id={id("enabled")} checked={tester.enabled} onCheckedChange={(v) => onChange({ enabled: v })} aria-label={`Enable ${tester.name || "tester"}`} />
        </div>
        <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${tester.name || "tester"}`} onClick={onRemove}>
          <X />
        </Button>
      </div>
      <Field id={id("cmd")} label="Command" error={commandMissing} hint={commandMissing ? "A command is required" : "Runs in the task's worktree with the variables below."}>
        <Input id={id("cmd")} className="font-mono text-xs" value={tester.command} onChange={(e) => onChange({ command: e.target.value })} spellCheck={false} aria-invalid={commandMissing} aria-describedby={`${id("cmd")}-hint`} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8rem]">
        <Field id={id("format")} label="Output format">
          <Select value={tester.format} onValueChange={(v) => onChange({ format: v as TesterFormat })}>
            <SelectTrigger id={id("format")} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FORMATS.map((f) => (
                <SelectItem key={f.value} value={f.value}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field id={id("when")} label="Runs">
          <Select value={tester.when} onValueChange={(v) => onChange({ when: v as TesterWhen })}>
            <SelectTrigger id={id("when")} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WHENS.map((w) => (
                <SelectItem key={w.value} value={w.value}>
                  {w.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field id={id("timeout")} label="Timeout (min)">
          <Input
            id={id("timeout")}
            type="number"
            min={1}
            inputMode="numeric"
            value={tester.timeoutMs ? String(Math.round(tester.timeoutMs / 60_000)) : ""}
            onChange={(e) => {
              const n = Number(e.target.value);
              onChange({ timeoutMs: e.target.value && Number.isFinite(n) && n > 0 ? Math.round(n * 60_000) : undefined });
            }}
            placeholder="None"
          />
        </Field>
        <Field id={id("queue")} className="sm:col-span-3" label="One at a time" hint="Testers with the same name here run one after another across all tasks; waiting does not count toward the timeout.">
          <Input
            id={id("queue")}
            className="font-mono"
            value={tester.queue ?? ""}
            onChange={(e) => onChange({ queue: e.target.value.trim() ? e.target.value.toLowerCase().replace(/\s+/g, "-") : undefined })}
            placeholder="No queue (parallel)"
            maxLength={40}
            aria-describedby={`${id("queue")}-hint`}
            spellCheck={false}
          />
        </Field>
      </div>
      {format ? <p className="-mt-1 text-xs text-muted-foreground">{format.hint}</p> : null}
      <div className="flex items-start justify-between gap-4 rounded-md bg-muted/40 px-3 py-2">
        <div className="grid gap-0.5">
          <Label htmlFor={id("blocking")}>Blocking</Label>
          <p className="text-xs text-muted-foreground">
            {tester.blocking ? "Its findings must be fixed or dismissed before the PR opens." : "Advisory: findings are shown and passed to the agent, but never hold the PR."}
          </p>
        </div>
        <Switch id={id("blocking")} checked={tester.blocking} onCheckedChange={(v) => onChange({ blocking: v })} />
      </div>
      {tester.when !== "manual" ? (
        <div className="flex items-start justify-between gap-4 rounded-md bg-muted/40 px-3 py-2">
          <div className="grid gap-0.5">
            <Label htmlFor={id("required")}>Must run before the PR</Label>
            <p className="text-xs text-muted-foreground">
              {tester.onError === "ask"
                ? "If it cannot run (command missing, server down, timeout), the task waits and asks you: run it again, skip it for this change, or stop."
                : "If it cannot run, the task goes on to the PR without it."}
            </p>
          </div>
          <Switch id={id("required")} checked={tester.onError === "ask"} onCheckedChange={(v) => onChange({ onError: v ? "ask" : undefined })} />
        </div>
      ) : null}
    </li>
  );
}

export function TestersCard({ value, onChange, prefix }: { value: TesterConfig[]; onChange: (next: TesterConfig[]) => void; prefix: string }) {
  const update = (id: string, patch: Partial<TesterConfig>) => onChange(value.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  return (
    <Card id="external-tests" className="scroll-mt-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FlaskConical className="size-4 text-muted-foreground" /> External tests
        </CardTitle>
        <CardDescription>
          Add a tester to the agent's loop, such as Umbra's review gate or an e2e suite. Its findings become issues the agent fixes, and open questions come to you as decisions.
        </CardDescription>
        <CardAction>
          <AddTesterMenu onAdd={(t) => onChange([...value, t])} />
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4">
        {value.length === 0 ? <p className="text-sm text-muted-foreground">No external testers. Checks and the AI review still run.</p> : null}
        <ul className="grid gap-3">
          {value.map((t) => (
            <TesterEditor key={t.id} tester={t} prefix={prefix} onChange={(patch) => update(t.id, patch)} onRemove={() => onChange(value.filter((x) => x.id !== t.id))} />
          ))}
        </ul>
        <Collapsible className="group/env rounded-lg border">
          <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[state=closed]/env:-rotate-90" />
            What the command gets
          </CollapsibleTrigger>
          <CollapsibleContent className="border-t px-3 py-2">
            <dl className="grid gap-1.5 text-xs sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-x-3">
              {ENV_VARS.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt>
                    <code className="font-mono font-medium">{k}</code>
                  </dt>
                  <dd className="mb-1 text-muted-foreground sm:mb-0">{v}</dd>
                </div>
              ))}
            </dl>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}

function AddTesterMenu({ onAdd }: { onAdd: (t: TesterConfig) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Plus /> Add tester
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[min(26rem,calc(100vw-2rem))]">
        <DropdownMenuLabel>Start from</DropdownMenuLabel>
        {TESTER_PRESETS.map((p) => (
          <DropdownMenuItem key={p.presetId} className="flex-col items-start gap-0.5 py-2" onSelect={() => onAdd(fromPreset(p))}>
            <span className="font-medium">{p.name}</span>
            <span className="text-xs whitespace-normal text-muted-foreground">{p.description}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const EVENT_KINDS: Record<Exclude<TaskOriginKind, "manual">, string> = {
  "pr-feedback": "PR review",
  "ci-failure": "Failing CI",
  "github-issue": "GitHub issue",
};

const mergeTriggers = (t: Partial<TriggerConfig> | undefined): TriggerConfig => ({
  prFeedback: { ...DEFAULT_TRIGGERS.prFeedback, ...t?.prFeedback },
  ciFailures: { ...DEFAULT_TRIGGERS.ciFailures, ...t?.ciFailures },
  githubIssues: { ...DEFAULT_TRIGGERS.githubIssues, ...t?.githubIssues },
});

function ListenerRow({ id, title, hint, checked, disabled, busy, onChange, children }: { id: string; title: string; hint: string; checked: boolean; disabled?: boolean; busy?: boolean; onChange: (v: boolean) => void; children?: ReactNode }) {
  return (
    <div className={cn("flex items-start justify-between gap-4 rounded-lg border p-3", disabled && "opacity-70")}>
      <div className="grid min-w-0 flex-1 gap-1">
        <Label htmlFor={id}>{title}</Label>
        {children}
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <div className="flex items-center gap-2">
        {busy ? <Spinner className="size-3.5" /> : null}
        <Switch id={id} checked={checked} disabled={disabled || busy} onCheckedChange={onChange} />
      </div>
    </div>
  );
}

export function ListenersCard({ projectId, branchPrefix }: { projectId: string; branchPrefix: string }) {
  const uid = useId();
  const [data, setData] = useState<TriggersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<keyof TriggerConfig | null>(null);
  const [label, setLabel] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await verifyApi.triggers(projectId);
      setData({ ...res, triggers: mergeTriggers(res.triggers) });
      setLabel(mergeTriggers(res.triggers).githubIssues.label);
      setError(null);
    } catch (err) {
      setError(messageOf(err));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (key: keyof TriggerConfig, next: TriggerConfig, message: string) => {
    if (!data) return;
    const prev = data;
    setBusy(key);
    setData({ ...data, triggers: next });
    try {
      const res = await verifyApi.saveTriggers(projectId, next);
      const triggers = mergeTriggers(res.triggers);
      setData({ ...res, triggers });
      setLabel(triggers.githubIssues.label);
      toast.success(message);
    } catch (err) {
      setData(prev);
      setLabel(prev.triggers.githubIssues.label);
      toast.error("Could not save the listener", { description: messageOf(err) });
    } finally {
      setBusy(null);
    }
  };

  const t = data?.triggers ?? null;
  const prefix = branchPrefix || "nightshift/";
  const supported = data?.supported.githubIssues ?? false;
  const labelChanged = t !== null && label.trim() !== t.githubIssues.label && label.trim().length > 0;

  const saveLabel = () => {
    if (!t || !labelChanged) return;
    void save("githubIssues", { ...t, githubIssues: { ...t.githubIssues, label: label.trim() } }, `Label set to “${label.trim()}”`);
  };

  return (
    <Card id="listeners" className="scroll-mt-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Radar className="size-4 text-muted-foreground" /> Listeners
        </CardTitle>
        <CardDescription>
          Listeners watch open, unmerged branches the agent pushed (branch prefix <code className="font-mono text-xs">{prefix}</code>) and create tasks automatically. Changes save right away.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {error && !data ? (
          <Notice tone="warning" title="Could not load listeners">
            {error}
          </Notice>
        ) : !t || !data ? (
          <div className="flex justify-center py-6">
            <Spinner label="Loading listeners" />
          </div>
        ) : (
          <>
            <ListenerRow
              id={`${uid}-pr`}
              title="Review feedback on agent pull requests"
              hint="A review or comment asking for changes on an agent's PR becomes a task to address it."
              checked={t.prFeedback.enabled}
              busy={busy === "prFeedback"}
              onChange={(v) => void save("prFeedback", { ...t, prFeedback: { enabled: v } }, v ? "Listening for PR feedback" : "Stopped listening for PR feedback")}
            />
            <ListenerRow
              id={`${uid}-ci`}
              title="Failing CI on agent pull requests"
              hint="A red CI run on an agent's branch becomes a task to fix it."
              checked={t.ciFailures.enabled}
              busy={busy === "ciFailures"}
              onChange={(v) => void save("ciFailures", { ...t, ciFailures: { enabled: v } }, v ? "Listening for failing CI" : "Stopped listening for failing CI")}
            />
            <ListenerRow
              id={`${uid}-gh`}
              title="GitHub issues with a label"
              hint={
                supported
                  ? "Open issues with this label become tasks. Remove the label to stop new ones."
                  : "Only for GitHub projects. This project's tasks come from elsewhere or its git host is local."
              }
              checked={supported && t.githubIssues.enabled}
              disabled={!supported}
              busy={busy === "githubIssues"}
              onChange={(v) => void save("githubIssues", { ...t, githubIssues: { ...t.githubIssues, enabled: v } }, v ? `Listening for issues labelled “${t.githubIssues.label}”` : "Stopped listening for GitHub issues")}
            >
              <div className="flex max-w-sm items-center gap-2">
                <Label htmlFor={`${uid}-label`} className="sr-only">
                  Issue label
                </Label>
                <Input id={`${uid}-label`} className="h-7 font-mono text-xs" value={label} disabled={!supported || busy !== null} onChange={(e) => setLabel(e.target.value)} onBlur={saveLabel}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      saveLabel();
                    }
                  }}
                  placeholder="nightshift"
                  spellCheck={false}
                />
                {labelChanged ? (
                  <Button type="button" size="sm" variant="secondary" onMouseDown={(e) => e.preventDefault()} onClick={saveLabel}>
                    Save label
                  </Button>
                ) : null}
              </div>
            </ListenerRow>
            <section aria-labelledby={`${uid}-activity`} className="mt-2 grid gap-2">
              <h3 id={`${uid}-activity`} className="text-sm font-medium">
                Recent listener activity
              </h3>
              {data.events.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing yet. Tasks created by listeners show up here and on the project page.</p>
              ) : (
                <ul className="divide-y rounded-lg border text-sm">
                  {data.events.map((e) => (
                    <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                      <time className="w-24 shrink-0 text-xs text-muted-foreground" dateTime={e.at} title={formatDateTime(e.at)}>
                        {formatRelative(e.at)}
                      </time>
                      <ToneBadge tone="info">{EVENT_KINDS[e.kind] ?? e.kind}</ToneBadge>
                      {e.url ? (
                        <a className="inline-flex items-center gap-1 font-mono text-xs underline-offset-4 hover:underline" href={e.url} target="_blank" rel="noopener noreferrer">
                          {e.ref}
                          <ExternalLink className="size-3" />
                        </a>
                      ) : (
                        <span className="font-mono text-xs">{e.ref}</span>
                      )}
                      <span className="min-w-0 flex-1 basis-48 text-xs text-muted-foreground">
                        {e.taskId ? (
                          <>
                            Created{" "}
                            <a className="font-medium text-foreground underline underline-offset-4" href={taskHref(projectId, e.taskId)}>
                              {e.taskId}
                            </a>
                            {e.note ? ` · ${e.note}` : null}
                          </>
                        ) : (
                          e.note || "No task created"
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </CardContent>
    </Card>
  );
}
