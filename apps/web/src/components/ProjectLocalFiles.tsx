import { useId, useState } from "react";
import { ArrowRight, FileKey2, FolderSearch, ListChecks, Plus, Repeat2, Sparkles, X } from "lucide-react";
import type { EnvRewrite, LocalFileCandidate, LocalFilesConfig, LocalFilesScan } from "@nightshift/core";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { messageOf, scanLocalFiles } from "../api";
import { Notice } from "./Notice";
import { formatBytes, plural } from "./skills";
import { EmptyState, Spinner, ToneBadge } from "./TaskBits";

const MAX_KEYS = 8;
const CUSTOM = "__custom";
const EMPTY: LocalFilesConfig = { paths: [], agentCanRead: false, rewrites: [] };

const PUBLIC_PREFIX = /^(NEXT_PUBLIC_|VITE_|EXPO_PUBLIC_|PUBLIC_)/;

export const isPublicVar = (key: string) => PUBLIC_PREFIX.test(key);

const urlSuffix = (was: string) => {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(.*)$/i.exec(was.trim());
  const rest = m?.[1] ?? "";
  return rest === "/" ? "" : rest;
};

export const rewriteValue = (key: string, was: string, app: string) => `{{${app}.${isPublicVar(key) ? "publicUrl" : "url"}}}${urlSuffix(was)}`;

const appOf = (r: EnvRewrite) => r.service ?? /^\{\{([\w-]+)\./.exec(r.value)?.[1] ?? null;

const sameRewrite = (a: EnvRewrite, b: EnvRewrite) => a.file === b.file && a.key === b.key;

function KeyChips({ keys }: { keys: string[] }) {
  if (!keys.length) return <span className="text-xs text-muted-foreground">No variables</span>;
  const shown = keys.slice(0, MAX_KEYS);
  const more = keys.length - shown.length;
  return (
    <ul className="flex flex-wrap gap-1" aria-label="Variable names">
      {shown.map((k) => (
        <li key={k} className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] leading-4 text-muted-foreground">
          {k}
        </li>
      ))}
      {more > 0 ? (
        <li className="rounded px-1 py-0.5 text-[11px] leading-4 text-muted-foreground" title={keys.slice(MAX_KEYS).join(", ")}>
          +{more}
        </li>
      ) : null}
    </ul>
  );
}

type FileRow = { path: string; candidate: LocalFileCandidate | null };

function FileItem({ row, checked, scanned, disabled, onToggle }: { row: FileRow; checked: boolean; scanned: boolean; disabled: boolean; onToggle: (on: boolean) => void }) {
  const id = useId();
  const c = row.candidate;
  return (
    <li className="flex items-start gap-3 px-3 py-2.5">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onToggle(v === true)} disabled={disabled} className="mt-0.5" aria-describedby={`${id}-meta`} />
      <div className="grid min-w-0 flex-1 gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <Label htmlFor={id} className="min-w-0 cursor-pointer font-mono text-sm font-medium break-all">
            {row.path}
          </Label>
          <span id={`${id}-meta`} className="flex items-center gap-2 text-xs text-muted-foreground">
            {c ? <span>{formatBytes(c.size)}</span> : null}
            {c ? <span>{plural(c.keys.length, "variable")}</span> : null}
            {!c && scanned ? <ToneBadge tone="warning">Not in project folder</ToneBadge> : null}
          </span>
        </div>
        {c ? <KeyChips keys={c.keys} /> : null}
      </div>
    </li>
  );
}

function RewriteRow({ rewrite, apps, disabled, onChange, onRemove }: { rewrite: EnvRewrite; apps: string[]; disabled: boolean; onChange: (next: EnvRewrite) => void; onRemove: () => void }) {
  const id = useId();
  const app = appOf(rewrite);
  const selected = app && apps.includes(app) ? app : CUSTOM;
  return (
    <li className="grid grid-cols-1 gap-2 px-3 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          <span className="text-muted-foreground">{rewrite.file}</span>
          <span className="text-muted-foreground" aria-hidden="true">
            {" · "}
          </span>
          <span id={`${id}-key`} className="font-semibold text-foreground">
            {rewrite.key}
          </span>
        </span>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove rewrite for ${rewrite.key}`} onClick={onRemove} disabled={disabled}>
          <X />
        </Button>
      </div>
      <div className="grid min-w-0 grid-cols-1 items-center gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.4fr)]">
        <code className="min-w-0 truncate font-mono text-xs text-muted-foreground line-through decoration-muted-foreground/60" title={rewrite.was}>
          <span className="sr-only">Was </span>
          {rewrite.was || "(empty)"}
        </code>
        <ArrowRight className="hidden size-3.5 text-muted-foreground sm:block" aria-hidden="true" />
        <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-2">
          {apps.length ? (
            <Select
              value={selected}
              disabled={disabled}
              onValueChange={(v) => (v === CUSTOM ? onChange({ ...rewrite, service: null }) : onChange({ ...rewrite, service: v, value: rewriteValue(rewrite.key, rewrite.was, v) }))}
            >
              <SelectTrigger size="sm" className="w-28" aria-label={`App that ${rewrite.key} points at`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {apps.map((a) => (
                  <SelectItem key={a} value={a}>
                    {a}
                  </SelectItem>
                ))}
                <SelectItem value={CUSTOM}>Custom</SelectItem>
              </SelectContent>
            </Select>
          ) : null}
          <Input
            className={cn("h-8 font-mono text-xs", !apps.length && "col-span-2")}
            value={rewrite.value}
            disabled={disabled}
            onChange={(e) => onChange({ ...rewrite, value: e.target.value, service: null })}
            aria-label={`New value of ${rewrite.key}`}
            aria-invalid={!rewrite.value.trim()}
            spellCheck={false}
          />
        </div>
      </div>
    </li>
  );
}

type ScanState = { state: "idle" } | { state: "loading" } | { state: "done"; scan: LocalFilesScan } | { state: "error"; error: string };

export function ProjectLocalFilesCard({
  projectId,
  root,
  value,
  apps,
  disabled = false,
  onChange,
}: {
  projectId: string;
  root: string;
  value: LocalFilesConfig | null;
  apps: string[];
  disabled?: boolean;
  onChange: (next: LocalFilesConfig | null) => void;
}) {
  const uid = useId();
  const [scan, setScan] = useState<ScanState>({ state: "idle" });
  const config = value ?? EMPTY;
  const result = scan.state === "done" ? scan.scan : null;

  const runScan = async () => {
    setScan({ state: "loading" });
    try {
      setScan({ state: "done", scan: await scanLocalFiles(projectId, true) });
    } catch (err) {
      setScan({ state: "error", error: messageOf(err) });
    }
  };

  const set = (patch: Partial<LocalFilesConfig>) => onChange({ ...config, ...patch });

  const suggestedFor = (path: string) => (result?.rewrites ?? []).filter((r) => r.file === path && !config.rewrites.some((x) => sameRewrite(x, r)));

  const toggle = (path: string, on: boolean) => {
    if (on) set({ paths: [...config.paths.filter((p) => p !== path), path], rewrites: [...config.rewrites, ...suggestedFor(path)] });
    else set({ paths: config.paths.filter((p) => p !== path) });
  };

  const rows: FileRow[] = [
    ...(result?.candidates ?? []).map((c) => ({ path: c.path, candidate: c })),
    ...config.paths.filter((p) => !result?.candidates.some((c) => c.path === p)).map((p) => ({ path: p, candidate: null })),
  ];
  const checked = new Set(config.paths);
  const rewrites = config.rewrites.filter((r) => checked.has(r.file));
  const suggestions = (result?.rewrites ?? []).filter((r) => checked.has(r.file) && !config.rewrites.some((x) => sameRewrite(x, r)));
  const updateRewrite = (prev: EnvRewrite, next: EnvRewrite) => set({ rewrites: config.rewrites.map((r) => (sameRewrite(r, prev) ? next : r)) });
  const removeRewrite = (prev: EnvRewrite) => set({ rewrites: config.rewrites.filter((r) => !sameRewrite(r, prev)) });

  return (
    <Card id="local-files" className="scroll-mt-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileKey2 className="size-4 text-muted-foreground" /> Local files
        </CardTitle>
        <CardDescription>
          Tasks start from a fresh copy of the repository, so gitignored files like <code className="font-mono text-xs">.env</code> are missing. Pick the ones Nightshift copies into every new task.
        </CardDescription>
        <CardAction>
          <Button type="button" variant="outline" size="sm" onClick={() => void runScan()} disabled={scan.state === "loading" || disabled}>
            {scan.state === "loading" ? <Spinner className="size-3.5" /> : <FolderSearch />}
            <span className="hidden sm:inline">{result ? "Scan again" : "Scan project folder"}</span>
            <span className="sm:hidden">Scan</span>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid min-w-0 grid-cols-1 gap-5">
        {scan.state === "error" ? (
          <Notice
            tone="danger"
            title="Could not scan the project folder"
            action={
              <Button type="button" size="sm" variant="outline" onClick={() => void runScan()}>
                Try again
              </Button>
            }
          >
            {scan.error}
          </Notice>
        ) : null}

        <section aria-labelledby={`${uid}-files`} className="grid min-w-0 grid-cols-1 gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 id={`${uid}-files`} className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Files to copy
            </h3>
            {result ? (
              <span className="inline-flex min-w-0 max-w-full items-center gap-1 text-xs text-muted-foreground">
                {result.source === "ai" ? <Sparkles className="size-3 text-violet-600 dark:text-violet-400" aria-hidden="true" /> : <ListChecks className="size-3" aria-hidden="true" />}
                {result.source === "ai" ? "Found with AI" : "Found by rule check"} in <code className="min-w-0 max-w-48 truncate font-mono" title={result.root}>{result.root}</code>
              </span>
            ) : null}
          </div>
          {scan.state === "loading" && !rows.length ? (
            <div role="status" className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-6 text-sm text-muted-foreground">
              <Spinner className="size-3.5" /> Looking for gitignored env and config files…
            </div>
          ) : rows.length ? (
            <ul className="divide-y overflow-hidden rounded-lg border">
              {rows.map((r) => (
                <FileItem key={r.path} row={r} checked={checked.has(r.path)} scanned={Boolean(result)} disabled={disabled} onToggle={(on) => toggle(r.path, on)} />
              ))}
            </ul>
          ) : result ? (
            <div className="rounded-lg border border-dashed">
              <EmptyState icon={<FileKey2 />} title="Nothing to copy" className="py-8">
                No gitignored env files in <code className="font-mono text-xs break-all">{result.root}</code>.
              </EmptyState>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed">
              <EmptyState
                icon={<FolderSearch />}
                title="No local files yet"
                className="py-8"
                action={
                  <Button type="button" variant="outline" size="sm" onClick={() => void runScan()} disabled={scan.state === "loading" || disabled}>
                    {scan.state === "loading" ? <Spinner className="size-3.5" /> : <FolderSearch />} Scan project folder
                  </Button>
                }
              >
                Scan <code className="font-mono text-xs break-all">{root}</code> for <code className="font-mono text-xs">.env</code> files and other gitignored config. Only variable names are shown, never values.
              </EmptyState>
            </div>
          )}
          {result?.notes.length ? (
            <ul className="grid gap-1">
              {result.notes.map((n, i) => (
                <li key={i} className="text-xs text-muted-foreground">
                  {n}
                </li>
              ))}
            </ul>
          ) : null}
          {config.paths.length ? (
            <p className="text-xs text-muted-foreground">
              Nightshift's own values for each task, like <code className="font-mono">DATABASE_URL</code> and <code className="font-mono">PORT</code>, are passed as environment variables and win over these files.
            </p>
          ) : null}
        </section>

        <div className="grid gap-3">
          <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
            <div className="grid gap-1">
              <Label htmlFor={`${uid}-read`}>Let the agent read these files</Label>
              <p id={`${uid}-read-hint`} className="text-xs text-muted-foreground">
                Off by default. The app can use them, but the agent cannot open them.
              </p>
            </div>
            <Switch id={`${uid}-read`} checked={config.agentCanRead} onCheckedChange={(v) => set({ agentCanRead: v })} disabled={disabled} aria-describedby={`${uid}-read-hint`} />
          </div>
          {config.agentCanRead ? (
            <Notice tone="warning" title="Their contents leave this machine">
              Anything the agent reads, including keys and passwords in these files, is sent to your model provider.
            </Notice>
          ) : null}
        </div>

        {config.paths.length ? (
          <section aria-labelledby={`${uid}-rw`} className="grid min-w-0 grid-cols-1 gap-2">
            <div className="grid gap-1">
              <h3 id={`${uid}-rw`} className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                <Repeat2 className="size-3.5" aria-hidden="true" /> Rewrites
              </h3>
              <p className="text-xs text-muted-foreground">
                Values that point at another app of this project are replaced with the task's own address when the preview starts. The files themselves are not changed.
              </p>
            </div>
            {rewrites.length ? (
              <ul className="divide-y overflow-hidden rounded-lg border">
                {rewrites.map((r) => (
                  <RewriteRow key={`${r.file}:${r.key}`} rewrite={r} apps={apps} disabled={disabled} onChange={(next) => updateRewrite(r, next)} onRemove={() => removeRewrite(r)} />
                ))}
              </ul>
            ) : (
              <p className="rounded-lg border border-dashed px-3 py-3 text-sm text-muted-foreground">
                {result ? "No rewrites. Values are used as they are." : "No rewrites. Scan the project folder to find values that point at your apps."}
              </p>
            )}
            {!apps.length && rewrites.length ? (
              <p className="text-xs text-muted-foreground">Split the preview into services to pick which app a value points at.</p>
            ) : null}
            {suggestions.length ? (
              <div className="grid grid-cols-1 gap-2">
                <ul className="divide-y rounded-lg border border-dashed">
                  {suggestions.map((s) => (
                    <li key={`${s.file}:${s.key}`} className="flex items-center gap-3 px-3 py-2 text-sm">
                      <span className="font-mono text-xs font-semibold text-emerald-600 dark:text-emerald-400" aria-hidden="true">
                        +
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        <span className="text-muted-foreground">Suggested: </span>
                        <code className="font-mono text-xs font-semibold">{s.key}</code>
                        <span className="text-muted-foreground"> → </span>
                        <code className="font-mono text-xs">{s.value}</code>
                      </span>
                      <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => set({ rewrites: [...config.rewrites, s] })}>
                        Add
                      </Button>
                    </li>
                  ))}
                </ul>
                {suggestions.length > 1 ? (
                  <div>
                    <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => set({ rewrites: [...config.rewrites, ...suggestions] })}>
                      <Plus /> Add all {suggestions.length}
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>
        ) : null}
      </CardContent>
    </Card>
  );
}
