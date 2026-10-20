import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Eye, EyeOff, Pencil, Plus, RefreshCw, RotateCcw, Search, Trash2, Variable } from "lucide-react";
import { toast } from "sonner";
import type { EnvEntry, EnvFileEntry, EnvSource, ServiceEnvResponse } from "@nightshift/core";
import { formatDateTime, formatRelative, type Tone } from "@nightshift/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { messageOf, workspaceApi } from "../api";
import { Notice } from "../components/Notice";
import { Spinner, ToneBadge } from "../components/TaskBits";

const SOURCES: Record<EnvSource, { label: string; tone: Tone; title: string }> = {
  task: { label: "task", tone: "muted", title: "Set by Nightshift for this task: database, preview link, shared services" },
  apps: { label: "other apps", tone: "info", title: "Addresses of the other preview apps (NIGHTSHIFT_<APP>_*)" },
  preview: { label: "preview env", tone: "neutral", title: "The preview's env in the project settings" },
  rewrite: { label: "local file rewrite", tone: "accent", title: "A localhost URL from a copied local file, pointed at this task's app" },
  service: { label: "app env", tone: "neutral", title: "This app's env in the project settings" },
  port: { label: "nightshift", tone: "muted", title: "Port and host Nightshift gives the dev server" },
};

/** Fixed local addresses in a file that Nightshift does not override still point at the owner's own apps, not the task's. */
const FIXED_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?/i;

function SourceBadge({ source }: { source: EnvSource }) {
  const s = SOURCES[source];
  return (
    <ToneBadge tone={s.tone} title={s.title} className="shrink-0 font-normal">
      {s.label}
    </ToneBadge>
  );
}

const MASK = "••••••••";

type Editing = { id: string; key: string; value: string; isNew: boolean };

/** Puts a template where it belongs: in place of a fixed localhost origin (keeping the path), else at the cursor. */
function insertTemplate(value: string, template: string, cursor: number | null) {
  const origin = value.match(FIXED_LOCAL);
  if (origin) return { value: template + value.slice(origin[0].length).replace(/^\/?$/, ""), cursor: null };
  const at = cursor ?? value.length;
  return { value: value.slice(0, at) + template + value.slice(at), cursor: at + template.length };
}

function EnvEditor({
  editing,
  templates,
  app,
  running,
  busy,
  error,
  onChange,
  onSave,
  onCancel,
}: {
  editing: Editing;
  templates: string[];
  app: string;
  running: boolean;
  busy: boolean;
  error: string | null;
  onChange: (next: Editing) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const valueRef = useRef<HTMLInputElement>(null);
  const valid = /^[A-Za-z_][A-Za-z0-9_]*$/.test(editing.key);
  return (
    <form
      className="grid gap-2 rounded-md border bg-muted/30 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !busy) onSave();
      }}
    >
      {editing.isNew ? (
        <div className="grid gap-1">
          <Label htmlFor={`${id}-key`} className="text-xs">
            Name
          </Label>
          <Input
            id={`${id}-key`}
            autoFocus
            value={editing.key}
            onChange={(e) => onChange({ ...editing, key: e.target.value.trim() })}
            placeholder="VITE_API_URL"
            className="h-8 font-mono text-xs"
            aria-invalid={editing.key !== "" && !valid}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      ) : null}
      <div className="grid gap-1">
        <Label htmlFor={`${id}-value`} className="text-xs">
          {editing.isNew ? "Value" : <>Value of <code className="font-mono">{editing.key}</code></>}
        </Label>
        <Input
          id={`${id}-value`}
          ref={valueRef}
          autoFocus={!editing.isNew}
          value={editing.value}
          onChange={(e) => onChange({ ...editing, value: e.target.value })}
          className="h-8 font-mono text-xs"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      {templates.length ? (
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Insert another app's address">
          <span className="mr-1 text-xs text-muted-foreground">Insert:</span>
          {templates.map((t) => (
            <Button
              key={t}
              type="button"
              variant="outline"
              size="sm"
              className="h-6 px-1.5 font-mono text-[11px]"
              onClick={() => {
                const input = valueRef.current;
                const next = insertTemplate(editing.value, t, input && document.activeElement === input ? input.selectionStart : null);
                onChange({ ...editing, value: next.value });
                requestAnimationFrame(() => {
                  input?.focus();
                  if (next.cursor !== null) input?.setSelectionRange(next.cursor, next.cursor);
                });
              }}
            >
              {t}
            </Button>
          ))}
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Saved in the project's preview settings for {app}, so every task gets it. {running ? `Restart ${app} afterwards to use it.` : "Used from the next start."}
      </p>
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!valid || busy}>
          {busy ? <Spinner className="size-3 text-current" /> : null} Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function RowAction({ label, icon, onClick, disabled }: { label: string; icon: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" className="size-7" aria-label={label} onClick={onClick} disabled={disabled}>
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

type RowEdit = {
  editing: Editing | null;
  editor: ReactNode;
  own: Record<string, string>;
  locked: string[];
  busy: boolean;
  revealed: boolean;
  start: (next: Editing) => void;
  remove: (key: string) => void;
};

/** What to put in the editor for a key: the saved value (templates intact) when the app has one, else what is shown. */
const editValue = (e: { key: string; value: string; secret: boolean }, edit: RowEdit) => {
  const saved = edit.own[e.key];
  const value = saved ?? e.value;
  return value.includes(MASK) ? "" : value;
};

function EnvTable({ entries, previous, query, edit }: { entries: EnvEntry[]; previous: Map<string, string> | null; query: string; edit: RowEdit }) {
  const q = query.trim().toLowerCase();
  const shown = entries.filter((e) => !q || e.key.toLowerCase().includes(q) || e.value.toLowerCase().includes(q)).sort((a, b) => a.key.localeCompare(b.key));
  const removed = previous ? [...previous.keys()].filter((k) => !entries.some((e) => e.key === k) && (!q || k.toLowerCase().includes(q))) : [];
  if (!shown.length && !removed.length) return <p className="px-1 text-sm text-muted-foreground">{q ? "No variable matches." : "No variables."}</p>;
  return (
    <ul className="divide-y rounded-lg border text-sm">
      {shown.map((e) => {
        const was = previous?.get(e.key);
        const changed = previous !== null && was !== e.value;
        return (
          <li key={e.key} className={cn("grid gap-1 px-3 py-2", changed && "bg-amber-500/[0.07]")}>
            <div className="flex min-w-0 items-center gap-2">
              <code className="min-w-0 truncate font-mono text-xs font-semibold" title={e.key}>
                {e.key}
              </code>
              {changed ? (
                <ToneBadge tone="warning" className="font-normal">
                  {was === undefined ? "new" : "changed"}
                </ToneBadge>
              ) : null}
              <span className="ml-auto" />
              <SourceBadge source={e.source} />
              {edit.locked.includes(e.key) ? null : (
                <span className="-my-1 flex">
                  <RowAction
                    label={e.key in edit.own ? `Edit ${e.key}` : `Set ${e.key} for this app`}
                    icon={<Pencil />}
                    disabled={edit.busy}
                    onClick={() => edit.start({ id: `env:${e.key}`, key: e.key, value: editValue(e, edit), isNew: false })}
                  />
                  {e.key in edit.own ? <RowAction label={`Remove ${e.key} from this app's env`} icon={<Trash2 />} disabled={edit.busy} onClick={() => edit.remove(e.key)} /> : null}
                </span>
              )}
            </div>
            {changed && was !== undefined ? (
              <code className="font-mono text-xs break-all text-muted-foreground line-through" title="Value the running process has">
                {was || "(empty)"}
              </code>
            ) : null}
            <code className="font-mono text-xs break-all">{e.value || <span className="text-muted-foreground">(empty)</span>}</code>
            {e.key in edit.own && edit.own[e.key] !== e.value && !edit.own[e.key]!.includes(MASK) ? (
              <code className="font-mono text-[11px] break-all text-muted-foreground" title="As saved in the project settings">
                = {edit.own[e.key]}
              </code>
            ) : null}
            {edit.editing?.id === `env:${e.key}` ? edit.editor : null}
          </li>
        );
      })}
      {removed.map((k) => (
        <li key={k} className="grid gap-1 bg-amber-500/[0.07] px-3 py-2">
          <div className="flex items-center gap-2">
            <code className="font-mono text-xs font-semibold line-through">{k}</code>
            <ToneBadge tone="warning" className="font-normal">
              removed
            </ToneBadge>
          </div>
          <code className="font-mono text-xs break-all text-muted-foreground line-through">{previous!.get(k)}</code>
        </li>
      ))}
    </ul>
  );
}

function FileTable({ files, query, edit }: { files: EnvFileEntry[]; query: string; edit: RowEdit }) {
  const q = query.trim().toLowerCase();
  const shown = files.filter((f) => !q || f.key.toLowerCase().includes(q) || f.value.toLowerCase().includes(q));
  if (!shown.length) return <p className="px-1 text-sm text-muted-foreground">{files.length ? "No variable matches." : "No .env files in this app's folder."}</p>;
  return (
    <ul className="divide-y rounded-lg border text-sm">
      {shown.map((f) => {
        const stale = !f.overriddenBy && FIXED_LOCAL.test(f.value);
        return (
          <li key={`${f.file}:${f.key}`} className={cn("grid gap-1 px-3 py-2", stale && "bg-red-500/[0.06]", f.overriddenBy && "opacity-70")}>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <code className={cn("min-w-0 truncate font-mono text-xs font-semibold", f.overriddenBy && "line-through")}>{f.key}</code>
              <span className="font-mono text-xs text-muted-foreground">{f.file}</span>
              <span className="ml-auto" />
              {f.overriddenBy ? (
                <ToneBadge tone="muted" className="font-normal" title={`Nightshift passes ${f.key} itself (${SOURCES[f.overriddenBy].label}); the framework keeps that value`}>
                  overridden
                </ToneBadge>
              ) : stale ? (
                <ToneBadge tone="danger" className="font-normal" title="Not overridden: the app uses this fixed address, which is not this task's app">
                  fixed address, used as is
                </ToneBadge>
              ) : (
                <ToneBadge tone="neutral" className="font-normal">
                  used as is
                </ToneBadge>
              )}
              {edit.locked.includes(f.key) ? null : (
                <span className="-my-1 flex">
                  <RowAction
                    label={f.key in edit.own ? `Edit the app's ${f.key}` : `Override ${f.key} for this app`}
                    icon={f.key in edit.own ? <Pencil /> : <Plus />}
                    disabled={edit.busy}
                    onClick={() => edit.start({ id: `file:${f.file}:${f.key}`, key: f.key, value: editValue(f, edit), isNew: false })}
                  />
                </span>
              )}
            </div>
            <code className="font-mono text-xs break-all">{f.value || <span className="text-muted-foreground">(empty)</span>}</code>
            {edit.editing?.id === `file:${f.file}:${f.key}` ? edit.editor : null}
          </li>
        );
      })}
    </ul>
  );
}

export function EnvButton({ projectId, taskId, service, label, onRestart }: { projectId: string; taskId: string; service?: string; label: string; onRestart?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" className="h-8 px-2" aria-label={`Show the environment of ${label}`} onClick={() => setOpen(true)}>
        <Variable />
        <span className="hidden sm:inline">Env</span>
      </Button>
      {open ? <ServiceEnvSheet projectId={projectId} taskId={taskId} service={service} label={label} onOpenChange={setOpen} onRestart={onRestart} /> : null}
    </>
  );
}

function ServiceEnvSheet({
  projectId,
  taskId,
  service,
  label,
  onOpenChange,
  onRestart,
}: {
  projectId: string;
  taskId: string;
  service?: string;
  label: string;
  onOpenChange: (open: boolean) => void;
  onRestart?: () => void;
}) {
  const ws = useMemo(() => workspaceApi(projectId, taskId), [projectId, taskId]);
  const [data, setData] = useState<ServiceEnvResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await ws.previewEnv(service, reveal));
      setError(null);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setLoading(false);
    }
  }, [ws, service, reveal]);

  useEffect(() => {
    void load();
  }, [load]);

  const running = data?.running ?? null;
  const previous = running ? new Map(running.map((e) => [e.key, e.value])) : null;
  const stale = data?.files.filter((f) => !f.overriddenBy && FIXED_LOCAL.test(f.value)) ?? [];

  const change = async (update: { set?: Record<string, string>; remove?: string[] }, done: string) => {
    setSaving(true);
    setSaveError(null);
    try {
      await ws.setPreviewEnv(service, update);
      setEditing(null);
      toast.success(done, { description: running ? `Restart ${label} to use it.` : "Used from the next start." });
      await load();
    } catch (err) {
      const message = messageOf(err);
      if (update.set) setSaveError(message);
      else toast.error("Could not remove", { description: message });
    } finally {
      setSaving(false);
    }
  };

  const start = (next: Editing) => {
    setSaveError(null);
    setEditing(next);
  };
  const editor = editing ? (
    <EnvEditor
      editing={editing}
      templates={data?.templates ?? []}
      app={label}
      running={Boolean(running)}
      busy={saving}
      error={saveError}
      onChange={setEditing}
      onCancel={() => setEditing(null)}
      onSave={() => void change({ set: { [editing.key]: editing.value } }, `${editing.key} saved for ${label}`)}
    />
  ) : null;
  const edit: RowEdit = {
    editing,
    editor,
    own: data?.own ?? {},
    locked: data?.locked ?? [],
    busy: saving,
    revealed: reveal,
    start,
    remove: (key) => void change({ remove: [key] }, `${key} removed from ${label}`),
  };

  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent
        className="w-full gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl"
        onEscapeKeyDown={(e) => {
          if (editing && !saving) {
            e.preventDefault();
            setEditing(null);
          }
        }}
      >
        <SheetHeader className="gap-1 border-b px-6 pt-5 pb-4">
          <SheetTitle className="pr-8">{label} environment</SheetTitle>
          <SheetDescription>
            {data?.startedAt && running ? (
              <>
                What the running process got when it started{" "}
                <time dateTime={data.startedAt} title={formatDateTime(data.startedAt)}>
                  {formatRelative(data.startedAt)}
                </time>
                , compared with what it gets on its next start.
              </>
            ) : (
              "Not running: this is what it gets on its next start."
            )}{" "}
            Variables from the daemon's own environment are inherited too and not listed.
          </SheetDescription>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <div className="relative min-w-40 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter variables or values…" aria-label="Filter variables" className="h-8 pl-8" />
            </div>
            <Button variant="outline" size="sm" onClick={() => setReveal((v) => !v)} aria-pressed={reveal}>
              {reveal ? <EyeOff /> : <Eye />} {reveal ? "Hide secrets" : "Show secrets"}
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={() => void load()} disabled={loading} aria-label="Reload">
              {loading ? <Spinner className="size-3.5" /> : <RefreshCw />}
            </Button>
          </div>
        </SheetHeader>
        <div className="grid min-h-0 flex-1 content-start gap-5 overflow-y-auto px-6 py-4">
          {error ? (
            <Notice tone="danger" title="Could not read the environment">
              {error}
            </Notice>
          ) : null}
          {!data && !error ? <Spinner className="size-4" /> : null}
          {data && data.changed.length ? (
            <Notice tone="warning" title={`${data.changed.length} value${data.changed.length === 1 ? "" : "s"} changed since ${label} started`}>
              <p>
                The running process still has the old {data.changed.length === 1 ? "value" : "values"} of <code className="font-mono">{data.changed.join(", ")}</code>. Restart it to apply.
              </p>
              {onRestart ? (
                <Button
                  size="sm"
                  className="mt-2"
                  onClick={() => {
                    onRestart();
                    onOpenChange(false);
                  }}
                >
                  <RotateCcw /> Restart {label}
                </Button>
              ) : null}
            </Notice>
          ) : null}
          {stale.length ? (
            <Notice tone="danger" title="Fixed local addresses the app still uses">
              <code className="font-mono">{stale.map((f) => `${f.key} (${f.file})`).join(", ")}</code> {stale.length === 1 ? "points" : "point"} at a fixed localhost address and Nightshift does not override{" "}
              {stale.length === 1 ? "it" : "them"}, so the app talks to that address instead of this task's app. Use <Plus className="inline size-3.5 align-[-2px]" aria-label="Override" /> on it below to give this app its own value (for example{" "}
              <code className="font-mono">{"{{api.publicUrl}}"}</code>), or map it under Local files.
            </Notice>
          ) : null}
          {data ? (
            <>
              <section className="grid gap-2" aria-label="Variables Nightshift passes">
                <div className="flex items-start gap-2">
                  <h3 className="min-w-0 flex-1 text-sm font-medium">
                    Passed by Nightshift{" "}
                    <span className="font-normal text-muted-foreground">· {running ? "next start; old values of the running process are struck through" : "next start"}</span>
                  </h3>
                  <Button size="sm" variant="outline" className="h-7" disabled={saving} onClick={() => start({ id: "new", key: "", value: "", isNew: true })}>
                    <Plus /> Add variable
                  </Button>
                </div>
                {editing?.id === "new" ? editor : null}
                <EnvTable entries={data.next} previous={previous} query={query} edit={edit} />
              </section>
              <section className="grid gap-2" aria-label="Variables in .env files">
                <h3 className="text-sm font-medium">
                  .env files in the app's folder <span className="font-normal text-muted-foreground">· the framework loads these; what Nightshift passes wins</span>
                </h3>
                <FileTable files={data.files} query={query} edit={edit} />
              </section>
            </>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
