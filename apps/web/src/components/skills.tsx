import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { CircleAlert, FileText, Folder, FolderOpen, GitBranch, MoonStar, PenLine, RefreshCw, SearchX, Terminal, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import type { Skill, SkillCandidate, SkillDiscovery, SkillDiscoverInput, SkillSource, SkillSourceKind } from "@nightshift/core";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { isConflict, messageOf, skillsApi } from "../api";
import { FolderPicker } from "./FolderPicker";
import { Notice } from "./Notice";
import { Field } from "./ProjectForm";
import { EmptyState, Spinner } from "./TaskBits";

export const SOURCES: Record<SkillSourceKind, { label: string; icon: LucideIcon; tint: string }> = {
  builtin: { label: "Built-in", icon: MoonStar, tint: "text-violet-600 dark:text-violet-400" },
  "claude-code": { label: "Claude Code", icon: Terminal, tint: "text-orange-600 dark:text-orange-400" },
  folder: { label: "Folder", icon: Folder, tint: "text-sky-600 dark:text-sky-400" },
  git: { label: "Git", icon: GitBranch, tint: "text-emerald-600 dark:text-emerald-400" },
  written: { label: "Written", icon: PenLine, tint: "text-amber-600 dark:text-amber-400" },
};

export const sourceDetail = (source: SkillSource) => source.ref ?? source.path ?? null;

export function SourceBadge({ source, className }: { source: SkillSource; className?: string }) {
  const meta = SOURCES[source.kind] ?? SOURCES.folder;
  const Icon = meta.icon;
  const detail = sourceDetail(source);
  const badge = (
    <Badge variant="outline" className={cn("gap-1 font-normal text-muted-foreground", className)} tabIndex={detail ? 0 : undefined}>
      <Icon className={cn("size-3", meta.tint)} aria-hidden="true" />
      {meta.label}
    </Badge>
  );
  if (!detail) return badge;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent className="max-w-xs font-mono text-xs break-all">{detail}</TooltipContent>
    </Tooltip>
  );
}

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

export const skillBody = (content: string) => content.replace(FRONTMATTER, "").trim();

export const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

type ImportTab = "claude-code" | "folder" | "git";
type Tab = ImportTab | "write";

type Scan = { state: "idle" } | { state: "scanning" } | { state: "error"; message: string } | { state: "done"; discovery: SkillDiscovery };

const WRITE_TEMPLATE = `## When to use

Use this skill when …

## Instructions

1. …
2. …

## Checks

- Run … before finishing.
`;

function useScan() {
  const [scan, setScan] = useState<Scan>({ state: "idle" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const controller = useRef<AbortController | null>(null);

  const run = async (input: SkillDiscoverInput) => {
    controller.current?.abort();
    const ctrl = new AbortController();
    controller.current = ctrl;
    setScan({ state: "scanning" });
    setSelected(new Set());
    try {
      const discovery = await skillsApi.discover(input, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setScan({ state: "done", discovery });
      const fresh = discovery.candidates.filter((c) => !c.error && !c.installedId);
      setSelected(new Set(fresh.length === 1 ? [fresh[0]!.path] : []));
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setScan({ state: "error", message: messageOf(err) });
    }
  };

  const reset = () => {
    controller.current?.abort();
    setScan({ state: "idle" });
    setSelected(new Set());
  };

  useEffect(() => () => controller.current?.abort(), []);

  const abort = () => controller.current?.abort();

  return { scan, selected, setSelected, run, reset, abort };
}

type ScanState = ReturnType<typeof useScan>;

function CandidateRow({ candidate, checked, onCheckedChange }: { candidate: SkillCandidate; checked: boolean; onCheckedChange: (checked: boolean) => void }) {
  const id = useId();
  const invalid = Boolean(candidate.error);
  return (
    <li>
      <label
        htmlFor={id}
        className={cn(
          "flex items-start gap-3 px-3 py-2.5 transition-colors",
          invalid ? "cursor-not-allowed" : "cursor-pointer hover:bg-muted/50",
          checked && "bg-muted/40",
        )}
      >
        <Checkbox id={id} className="mt-0.5" checked={checked} disabled={invalid} onCheckedChange={(v) => onCheckedChange(v === true)} />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cn("truncate text-sm font-medium", invalid && "text-muted-foreground")}>{candidate.name || candidate.path}</span>
            {candidate.installedId ? (
              <Badge variant="secondary" className="h-4.5 px-1.5 text-[0.7rem]">
                Installed
              </Badge>
            ) : null}
          </span>
          {candidate.description ? <span className="line-clamp-2 text-xs text-muted-foreground">{candidate.description}</span> : null}
          {candidate.error ? (
            <span className="flex items-start gap-1 text-xs text-destructive">
              <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
              {candidate.error}
            </span>
          ) : null}
          <span className="flex min-w-0 items-center gap-1.5 text-[0.7rem] text-muted-foreground/80">
            <span className="truncate font-mono">{candidate.path || "."}</span>
            <span aria-hidden="true">·</span>
            <span className="shrink-0">{plural(candidate.files, "file")}</span>
          </span>
        </span>
      </label>
    </li>
  );
}

function Candidates({ state, scanningLabel, idle, onRetry }: { state: ScanState; scanningLabel: ReactNode; idle?: ReactNode; onRetry?: () => void }) {
  const { scan, selected, setSelected } = state;
  if (scan.state === "idle") return idle ? <div className="rounded-lg border border-dashed">{idle}</div> : null;
  if (scan.state === "scanning") {
    return (
      <div className="grid gap-3 rounded-lg border p-3" role="status" aria-live="polite">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-3.5" />
          {scanningLabel}
        </div>
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-start gap-3">
            <Skeleton className="size-4 rounded" />
            <div className="grid flex-1 gap-1.5">
              <Skeleton className="h-3.5 w-1/3" />
              <Skeleton className="h-3 w-4/5" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (scan.state === "error") {
    return (
      <Notice
        tone="danger"
        title="Could not scan for skills"
        action={
          onRetry ? (
            <Button type="button" size="sm" variant="outline" onClick={onRetry}>
              Try again
            </Button>
          ) : undefined
        }
      >
        {scan.message}
      </Notice>
    );
  }
  const { candidates, label } = scan.discovery;
  if (candidates.length === 0) {
    return (
      <div className="rounded-lg border border-dashed">
        <EmptyState icon={<SearchX />} title="No skills found" className="py-8">
          Nothing in {label} has a <code className="font-mono text-xs">SKILL.md</code>.
        </EmptyState>
      </div>
    );
  }
  const selectable = candidates.filter((c) => !c.error);
  const all = selectable.length > 0 && selectable.every((c) => selected.has(c.path));
  const some = selectable.some((c) => selected.has(c.path));
  const toggle = (path: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="flex items-center gap-3 border-b bg-muted/30 px-3 py-2">
        <Checkbox
          aria-label="Select all skills"
          checked={all ? true : some ? "indeterminate" : false}
          disabled={selectable.length === 0}
          onCheckedChange={(v) => setSelected(v === true ? new Set(selectable.map((c) => c.path)) : new Set())}
        />
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={label}>
          {plural(candidates.length, "skill")} found in <span className="font-medium text-foreground">{label}</span>
        </span>
        {onRetry ? (
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Scan again" title="Scan again" onClick={onRetry}>
            <RefreshCw />
          </Button>
        ) : null}
      </div>
      <ul className="max-h-[min(20rem,40vh)] divide-y overflow-y-auto">
        {candidates.map((c) => (
          <CandidateRow key={c.path} candidate={c} checked={!c.error && selected.has(c.path)} onCheckedChange={(on) => toggle(c.path, on)} />
        ))}
      </ul>
    </div>
  );
}

function WriteForm({ id, onCreated, onBusy, onValid }: { id: string; onCreated: (skill: Skill) => void; onBusy: (busy: boolean) => void; onValid: (valid: boolean) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState(WRITE_TEMPLATE);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const valid = name.trim().length > 0 && description.trim().length > 0 && body.trim().length > 0;

  useEffect(() => onValid(valid), [valid, onValid]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || saving) return;
    setSaving(true);
    onBusy(true);
    setError(null);
    try {
      const res = await skillsApi.create({ name: name.trim(), description: description.trim(), body });
      onCreated(res.skill);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSaving(false);
      onBusy(false);
    }
  };

  return (
    <form id={id} className="grid gap-4" onSubmit={(e) => void submit(e)} noValidate>
      <Field id={`${id}-name`} label="Name" hint="Short and specific, for example api-conventions or db-migrations.">
        <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} placeholder="api-conventions" autoComplete="off" spellCheck={false} className="font-mono" />
      </Field>
      <Field id={`${id}-description`} label="Description" hint="What the skill does and when to use it. The agent reads this to decide whether to load the skill.">
        <Textarea
          id={`${id}-description`}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className="min-h-16 resize-none"
          placeholder="Conventions for new API endpoints: validation, error codes and tests. Use when a task adds or changes an endpoint."
        />
      </Field>
      <Field id={`${id}-body`} label="Instructions" hint="Markdown. Nightshift adds the name and description as the SKILL.md frontmatter.">
        <Textarea id={`${id}-body`} value={body} onChange={(e) => setBody(e.target.value)} rows={10} className="max-h-[40vh] min-h-40 font-mono text-xs leading-relaxed" spellCheck={false} />
      </Field>
      {error ? (
        <Notice tone="danger" title="Could not create the skill">
          {error}
        </Notice>
      ) : null}
    </form>
  );
}

const TABS: Array<{ value: Tab; label: string; icon: LucideIcon }> = [
  { value: "claude-code", label: "Claude Code", icon: Terminal },
  { value: "folder", label: "Folder", icon: FolderOpen },
  { value: "git", label: "Git repository", icon: GitBranch },
  { value: "write", label: "Write", icon: PenLine },
];

export function AddSkillDialog({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (open: boolean) => void; onAdded: () => void }) {
  const uid = useId();
  const [tab, setTab] = useState<Tab>("claude-code");
  const claude = useScan();
  const folder = useScan();
  const git = useScan();
  const [path, setPath] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [picker, setPicker] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [replaceAsk, setReplaceAsk] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [writeValid, setWriteValid] = useState(false);

  const scans: Record<ImportTab, ScanState> = { "claude-code": claude, folder, git };
  const active = tab === "write" ? null : scans[tab];

  useEffect(() => {
    if (!open) {
      claude.abort();
      folder.abort();
      git.abort();
      return;
    }
    setTab("claude-code");
    setPath("");
    setGitUrl("");
    setImportError(null);
    folder.reset();
    git.reset();
    void claude.run({ claudeCode: true });
  }, [open]);

  useEffect(() => setImportError(null), [tab]);

  const scanFolder = (value = path) => {
    if (!value.trim()) return;
    void folder.run({ path: value.trim() });
  };
  const scanGit = () => {
    if (!gitUrl.trim()) return;
    void git.run({ gitUrl: gitUrl.trim() });
  };

  const doImport = async (replace: boolean) => {
    if (!active || active.scan.state !== "done") return;
    const paths = [...active.selected];
    if (!paths.length) return;
    setImporting(true);
    setImportError(null);
    try {
      const res = await skillsApi.import({ sourceId: active.scan.discovery.sourceId, paths, replace: replace || undefined });
      setReplaceAsk(null);
      toast.success(res.skills.length === 1 ? `Added ${res.skills[0]?.name ?? "skill"}` : `Added ${res.skills.length} skills`, {
        description: "Agents can use them in every project unless a project turns them off.",
      });
      onAdded();
      onOpenChange(false);
    } catch (err) {
      if (isConflict(err) && !replace) {
        setReplaceAsk(messageOf(err));
      } else {
        setReplaceAsk(null);
        setImportError(messageOf(err));
      }
    } finally {
      setImporting(false);
    }
  };

  const selectedCount = active ? [...active.selected].length : 0;
  const canImport = active?.scan.state === "done" && selectedCount > 0 && !importing;

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => (importing || writing ? null : onOpenChange(v))}>
        <DialogContent className="flex h-[min(42rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
          <DialogHeader className="border-b px-5 pt-5 pb-4">
            <DialogTitle>Add skill</DialogTitle>
            <DialogDescription>Import skills you already have, or write a new one. A skill is a folder with a SKILL.md and optional scripts or references.</DialogDescription>
          </DialogHeader>
          <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="min-h-0 flex-1 gap-0">
            <div className="border-b px-5 py-3">
              <TabsList className="w-full">
                {TABS.map(({ value, label, icon: Icon }) => (
                  <TabsTrigger key={value} value={value} className="min-w-0 flex-1">
                    <Icon aria-hidden="true" />
                    <span className="truncate">{label}</span>
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <TabsContent value="claude-code" className="grid gap-3">
                <p className="text-sm text-muted-foreground">
                  Skills from <code className="font-mono text-xs">~/.claude/skills</code> and your installed Claude Code plugins. Nightshift copies them, so later changes in Claude Code are not picked up.
                </p>
                <Candidates state={claude} scanningLabel="Looking for Claude Code skills…" onRetry={() => void claude.run({ claudeCode: true })} />
              </TabsContent>
              <TabsContent value="folder" className="grid gap-3">
                <form
                  className="grid gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    scanFolder();
                  }}
                >
                  <Label htmlFor={`${uid}-path`}>Folder on this Mac</Label>
                  <div className="flex gap-2">
                    <Input
                      id={`${uid}-path`}
                      value={path}
                      onChange={(e) => setPath(e.target.value)}
                      placeholder="/Users/me/skills"
                      className="min-w-0 flex-1 font-mono"
                      spellCheck={false}
                      autoComplete="off"
                    />
                    <Button type="button" variant="outline" onClick={() => setPicker(true)}>
                      <FolderOpen /> Browse
                    </Button>
                    <Button type="submit" variant="secondary" disabled={!path.trim() || folder.scan.state === "scanning"}>
                      Scan
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">A single skill folder, or a folder or repository that holds several.</p>
                </form>
                <Candidates
                  state={folder}
                  scanningLabel="Scanning the folder…"
                  onRetry={path.trim() ? () => scanFolder() : undefined}
                  idle={
                    <EmptyState icon={<Folder />} title="Pick a folder to scan" className="py-8">
                      Nightshift lists every SKILL.md it finds so you can choose what to add.
                    </EmptyState>
                  }
                />
              </TabsContent>
              <TabsContent value="git" className="grid gap-3">
                <form
                  className="grid gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    scanGit();
                  }}
                >
                  <Label htmlFor={`${uid}-git`}>Repository URL</Label>
                  <div className="flex gap-2">
                    <Input
                      id={`${uid}-git`}
                      value={gitUrl}
                      onChange={(e) => setGitUrl(e.target.value)}
                      placeholder="https://github.com/acme/skills.git"
                      className="min-w-0 flex-1 font-mono"
                      spellCheck={false}
                      autoComplete="off"
                      inputMode="url"
                    />
                    <Button type="submit" variant="secondary" disabled={!gitUrl.trim() || git.scan.state === "scanning"}>
                      Scan
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">HTTPS or SSH. Private repositories use your git credentials.</p>
                </form>
                <Candidates
                  state={git}
                  scanningLabel="Cloning the repository. This can take a minute…"
                  onRetry={gitUrl.trim() ? scanGit : undefined}
                  idle={
                    <EmptyState icon={<GitBranch />} title="Scan a repository" className="py-8">
                      Nightshift clones it and lists the skills inside.
                    </EmptyState>
                  }
                />
              </TabsContent>
              <TabsContent value="write">
                <WriteForm
                  id={`${uid}-write`}
                  onBusy={setWriting}
                  onValid={setWriteValid}
                  onCreated={(skill) => {
                    toast.success(`Created ${skill.name}`);
                    onAdded();
                    onOpenChange(false);
                  }}
                />
              </TabsContent>
              {importError && tab !== "write" ? (
                <Notice tone="danger" title="Could not add the skills" className="mt-3">
                  {importError}
                </Notice>
              ) : null}
            </div>
          </Tabs>
          <DialogFooter className="m-0 flex-row items-center border-t bg-muted/30 px-5 py-3 sm:justify-between">
            <span className="hidden text-xs text-muted-foreground sm:inline">
              {tab === "write" ? (
                <span className="inline-flex items-center gap-1.5">
                  <FileText className="size-3.5" aria-hidden="true" /> Saved as SKILL.md
                </span>
              ) : active?.scan.state === "done" ? (
                `${selectedCount} selected`
              ) : null}
            </span>
            <div className="ml-auto flex gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={importing || writing}>
                Cancel
              </Button>
              {tab === "write" ? (
                <Button type="submit" form={`${uid}-write`} disabled={writing || !writeValid}>
                  {writing ? <Spinner className="size-3.5 text-current" /> : null}
                  Create skill
                </Button>
              ) : (
                <Button type="button" onClick={() => void doImport(false)} disabled={!canImport}>
                  {importing ? <Spinner className="size-3.5 text-current" /> : null}
                  {selectedCount > 1 ? `Add ${selectedCount} skills` : "Add skill"}
                </Button>
              )}
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <FolderPicker
        open={picker}
        onOpenChange={setPicker}
        title="Choose a skills folder"
        description="Pick a skill folder, or a folder that contains several skills."
        initialPath={path.trim() || undefined}
        selectLabel="Scan this folder"
        onSelect={(p) => {
          setPicker(false);
          setPath(p);
          scanFolder(p);
        }}
      />
      <AlertDialog open={replaceAsk !== null} onOpenChange={(v) => (!v && !importing ? setReplaceAsk(null) : null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace the installed version?</AlertDialogTitle>
            <AlertDialogDescription>
              {replaceAsk} Replacing overwrites the installed files, including any edits you made in Nightshift. Project settings for the skill are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={importing}>Keep installed</AlertDialogCancel>
            <AlertDialogAction
              disabled={importing}
              onClick={(e) => {
                e.preventDefault();
                void doImport(true);
              }}
            >
              {importing ? <Spinner className="size-3.5 text-current" /> : null}
              Replace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
