import { Suspense, lazy, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { FileCode2, FileText, Lock, Pencil, Plus, Search, SearchX, Sparkles, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import type { Skill, SkillDetail } from "@nightshift/core";
import { formatDateTime, formatRelative } from "@nightshift/ui";
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
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { messageOf, skillsApi } from "../api";
import { Markdown } from "../components/Markdown";
import { Notice } from "../components/Notice";
import { AddSkillDialog, SOURCES, SourceBadge, formatBytes, plural, skillBody, sourceDetail } from "../components/skills";
import { EmptyState, Page, PageHeader, Spinner } from "../components/TaskBits";
import { TaskTypeBadge } from "../components/taskTypes";

const SkillEditor = lazy(() => import("../components/SkillEditor"));

const byName = (a: Skill, b: Skill) => a.name.localeCompare(b.name);

function UsedFirstFor({ skill, className }: { skill: Skill; className?: string }) {
  const types = skill.taskTypes ?? [];
  if (types.length === 0) return null;
  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground", className)}>
      <span>Used first for</span>
      {types.map((t) => (
        <TaskTypeBadge key={t} type={t} />
      ))}
    </div>
  );
}

function SkillCard({ skill, busy, onOpen, onToggle }: { skill: Skill; busy: boolean; onOpen: () => void; onToggle: (enabled: boolean) => void }) {
  return (
    <Card className={cn("group relative gap-3 px-4 transition-[background-color,box-shadow] hover:bg-muted/40 hover:ring-foreground/20 has-[button:focus-visible]:ring-2 has-[button:focus-visible]:ring-ring/50")}>
      <div className="flex items-start gap-3">
        <h2 className="min-w-0 flex-1 text-sm leading-snug font-medium">
          <button type="button" onClick={onOpen} className={cn("block max-w-full truncate text-left outline-none after:absolute after:inset-0 after:content-['']", !skill.enabled && "text-muted-foreground")}>
            {skill.name}
          </button>
        </h2>
        <Switch
          className="relative z-10 mt-0.5"
          checked={skill.enabled}
          disabled={busy}
          onCheckedChange={onToggle}
          aria-label={`${skill.enabled ? "Turn off" : "Turn on"} ${skill.name}`}
        />
      </div>
      <p className={cn("line-clamp-3 min-h-[3lh] text-[0.8rem] leading-relaxed text-muted-foreground", !skill.enabled && "text-muted-foreground/70")}>
        {skill.description || "No description."}
      </p>
      <UsedFirstFor skill={skill} className={cn(!skill.enabled && "opacity-70")} />
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <SourceBadge source={skill.source} className="relative z-10" />
        <span className="inline-flex shrink-0 items-center gap-1">
          <FileText className="size-3" aria-hidden="true" />
          {plural(skill.files.length, "file")}
        </span>
        <time className="ml-auto truncate" dateTime={skill.updatedAt} title={`Updated ${formatDateTime(skill.updatedAt)}`}>
          {formatRelative(skill.updatedAt)}
        </time>
      </div>
    </Card>
  );
}

function CardsSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-hidden="true">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <Card key={i} className="gap-3 px-4">
          <div className="flex items-center justify-between gap-3">
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-[18px] w-8 rounded-full" />
          </div>
          <div className="grid gap-1.5">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-11/12" />
            <Skeleton className="h-3 w-3/5" />
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="h-5 w-20 rounded-full" />
            <Skeleton className="h-3 w-12" />
          </div>
        </Card>
      ))}
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

function SkillSheet({
  summary,
  onClose,
  onToggle,
  toggling,
  onSaved,
  onDeleted,
}: {
  summary: Skill | null;
  onClose: () => void;
  onToggle: (skill: Skill, enabled: boolean) => void;
  toggling: boolean;
  onSaved: (skill: SkillDetail) => void;
  onDeleted: (id: string) => void;
}) {
  const [kept, setKept] = useState<Skill | null>(summary);
  if (summary && summary !== kept) setKept(summary);
  const id = kept?.id ?? null;
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  useEffect(() => {
    if (!id) return;
    let live = true;
    setDetail(null);
    setError(null);
    setDraft(null);
    setSaveError(null);
    skillsApi
      .get(id)
      .then((res) => live && setDetail(res.skill))
      .catch((err: unknown) => live && setError(messageOf(err)));
    return () => {
      live = false;
    };
  }, [id]);

  const skill: Skill | null = kept ? { ...(detail ?? kept), enabled: kept.enabled } : null;
  const dirty = draft !== null && detail !== null && draft !== detail.content;
  const editing = draft !== null;

  const requestClose = () => {
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  const save = async () => {
    if (!id || draft === null || saving) return;
    if (!dirty) {
      setDraft(null);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await skillsApi.save(id, draft);
      setDetail(res.skill);
      setDraft(null);
      onSaved(res.skill);
      toast.success(`Saved ${res.skill.name}`);
    } catch (err) {
      setSaveError(messageOf(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!id) return;
    setDeleting(true);
    try {
      await skillsApi.remove(id);
      toast.success(`Deleted ${skill?.name ?? "skill"}`);
      setConfirmDelete(false);
      onDeleted(id);
    } catch (err) {
      toast.error("Could not delete the skill", { description: messageOf(err) });
    } finally {
      setDeleting(false);
    }
  };

  const source = skill ? SOURCES[skill.source.kind] : null;
  const where = skill ? sourceDetail(skill.source) : null;
  const files = skill ? [...skill.files].sort((a, b) => (a === "SKILL.md" ? -1 : b === "SKILL.md" ? 1 : a.localeCompare(b))) : [];

  return (
    <>
      <Sheet open={summary !== null} onOpenChange={(open) => (open ? null : requestClose())}>
        <SheetContent
          className="w-full gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl"
          onEscapeKeyDown={(e) => {
            if (editing) {
              e.preventDefault();
              requestClose();
            }
          }}
        >
          {skill ? (
            <>
              <SheetHeader className="gap-2 border-b px-6 pt-5 pb-4">
                <div className="flex min-w-0 flex-wrap items-center gap-2 pr-8">
                  <SheetTitle className="truncate text-lg">{skill.name}</SheetTitle>
                  <SourceBadge source={skill.source} />
                </div>
                <SheetDescription className="leading-relaxed">{skill.description || "No description."}</SheetDescription>
              </SheetHeader>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {editing ? (
                  <div className="flex h-full flex-col gap-3 px-6 py-4">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-sm font-medium">
                        <FileCode2 className="size-4 text-muted-foreground" aria-hidden="true" /> Editing SKILL.md
                      </span>
                      <span className="text-xs text-muted-foreground">{dirty ? "Unsaved changes" : "No changes"}</span>
                    </div>
                    <div className="min-h-[24rem] flex-1 overflow-hidden rounded-lg border">
                      <Suspense
                        fallback={
                          <div className="flex h-full items-center justify-center">
                            <Spinner label="Loading editor" />
                          </div>
                        }
                      >
                        <SkillEditor path={`skills/${skill.id}/SKILL.md`} value={draft ?? ""} onChange={setDraft} onSave={() => void save()} />
                      </Suspense>
                    </div>
                    {saveError ? (
                      <Notice tone="danger" title="Could not save">
                        {saveError}
                      </Notice>
                    ) : null}
                  </div>
                ) : (
                  <div className="space-y-6 px-6 py-5">
                    <div className="flex items-center gap-3 rounded-lg border bg-muted/30 px-4 py-3">
                      <div className="grid min-w-0 flex-1 gap-0.5">
                        <Label htmlFor="skill-enabled" className="text-sm">
                          {skill.enabled ? "On for agents" : "Off for agents"}
                        </Label>
                        <p className="text-xs text-muted-foreground">Applies to every project unless its settings override it.</p>
                      </div>
                      <Switch id="skill-enabled" checked={skill.enabled} disabled={toggling} onCheckedChange={(v) => onToggle(skill, v)} />
                    </div>
                    <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
                      <Detail label="Source">
                        <span className="inline-flex items-center gap-1.5">
                          {source ? <source.icon className={cn("size-3.5", source.tint)} aria-hidden="true" /> : null}
                          {source?.label}
                        </span>
                      </Detail>
                      <Detail label="Files">{plural(skill.files.length, "file")}</Detail>
                      <Detail label="Size">{formatBytes(skill.sizeBytes)}</Detail>
                      <Detail label="Updated">
                        <time dateTime={skill.updatedAt} title={formatDateTime(skill.updatedAt)}>
                          {formatRelative(skill.updatedAt)}
                        </time>
                      </Detail>
                      {where ? (
                        <Detail label={skill.source.kind === "git" ? "Repository" : "Imported from"}>
                          <span className="block truncate font-mono text-xs" title={where}>
                            {where}
                          </span>
                        </Detail>
                      ) : null}
                    </dl>
                    {(skill.taskTypes ?? []).length > 0 ? (
                      <section aria-labelledby="skill-task-types" className="grid gap-2">
                        <h3 id="skill-task-types" className="text-sm font-medium">
                          Used first for
                        </h3>
                        <div className="flex flex-wrap gap-1.5">
                          {skill.taskTypes.map((t) => (
                            <TaskTypeBadge key={t} type={t} />
                          ))}
                        </div>
                        <p className="text-xs text-muted-foreground">Agents load this skill ahead of others on tasks of these types.</p>
                      </section>
                    ) : null}
                    <section aria-labelledby="skill-files" className="grid gap-2">
                      <h3 id="skill-files" className="text-sm font-medium">
                        Files
                      </h3>
                      <ul className="divide-y overflow-hidden rounded-lg border">
                        {files.map((f) => (
                          <li key={f} className="flex min-w-0 items-center gap-2 px-3 py-1.5">
                            <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                            <span className="truncate font-mono text-xs" title={f}>
                              {f}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </section>
                    <section aria-labelledby="skill-content" className="grid gap-2">
                      <div className="flex items-center justify-between gap-2">
                        <h3 id="skill-content" className="text-sm font-medium">
                          SKILL.md
                        </h3>
                        {skill.builtin ? null : (
                          <Button size="sm" variant="outline" disabled={!detail} onClick={() => detail && setDraft(detail.content)}>
                            <Pencil /> Edit
                          </Button>
                        )}
                      </div>
                      {error ? (
                        <Notice tone="danger" title="Could not load SKILL.md">
                          {error}
                        </Notice>
                      ) : detail ? (
                        <div className="rounded-lg border bg-card px-5 py-4">
                          {skillBody(detail.content) ? <Markdown text={skillBody(detail.content)} className="space-y-3" /> : <p className="text-sm text-muted-foreground">No instructions yet.</p>}
                        </div>
                      ) : (
                        <div className="grid gap-2 rounded-lg border px-5 py-4">
                          <Skeleton className="h-4 w-1/3" />
                          <Skeleton className="h-3 w-full" />
                          <Skeleton className="h-3 w-5/6" />
                          <Skeleton className="h-3 w-2/3" />
                        </div>
                      )}
                    </section>
                  </div>
                )}
              </div>
              <div className="flex min-h-14 items-center gap-2 border-t bg-muted/30 px-6 py-3">
                {editing ? (
                  <>
                    <span className="mr-auto hidden text-xs text-muted-foreground sm:inline">⌘S to save</span>
                    <Button variant="outline" onClick={() => (dirty ? setConfirmDiscard(true) : setDraft(null))} disabled={saving}>
                      Cancel
                    </Button>
                    <Button onClick={() => void save()} disabled={saving || !dirty}>
                      {saving ? <Spinner className="size-3.5 text-current" /> : null}
                      Save
                    </Button>
                  </>
                ) : skill.builtin ? (
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Lock className="size-3.5" aria-hidden="true" /> Built-in skills are read-only. Turn it off if you do not want agents to use it.
                  </span>
                ) : (
                  <Button variant="ghost" className="-ml-2 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setConfirmDelete(true)}>
                    <Trash2 /> Delete skill
                  </Button>
                )}
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
      <AlertDialog open={confirmDelete} onOpenChange={(v) => (deleting ? null : setConfirmDelete(v))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {skill?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Agents stop using it in every project and its files are removed from Nightshift. The original source is not touched, so you can import it again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={(e) => {
                e.preventDefault();
                void remove();
              }}
            >
              {deleting ? <Spinner className="size-3.5 text-current" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard your changes?</AlertDialogTitle>
            <AlertDialogDescription>Your edits to SKILL.md have not been saved.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setDraft(null);
                setSaveError(null);
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function Skills() {
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [toggling, setToggling] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const res = await skillsApi.list();
      setSkills([...res.skills].sort(byName));
      setError(null);
    } catch (err) {
      setError(messageOf(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = (next: Skill) => setSkills((list) => (list ? list.map((s) => (s.id === next.id ? { ...s, ...next } : s)) : list));

  const toggle = async (skill: Skill, enabled: boolean) => {
    setToggling((t) => new Set(t).add(skill.id));
    patch({ ...skill, enabled });
    try {
      const res = await skillsApi.setEnabled(skill.id, enabled);
      patch(res.skill);
      toast.success(enabled ? `${skill.name} is on` : `${skill.name} is off`);
    } catch (err) {
      patch({ ...skill, enabled: !enabled });
      toast.error("Could not update the skill", { description: messageOf(err) });
    } finally {
      setToggling((t) => {
        const next = new Set(t);
        next.delete(skill.id);
        return next;
      });
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!skills || !q) return skills;
    return skills.filter((s) => [s.name, s.description, SOURCES[s.source.kind]?.label ?? ""].some((v) => v.toLowerCase().includes(q)));
  }, [skills, query]);

  const open = skills?.find((s) => s.id === openId) ?? null;
  const onCount = skills?.filter((s) => s.enabled).length ?? 0;

  return (
    <Page>
      <PageHeader
        title="Skills"
        description={
          <p className="max-w-2xl leading-relaxed">
            Instructions, scripts and references the coding agent loads when a task matches a skill's description. Turn skills on or off here, or per project in
            its settings.
          </p>
        }
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus /> Add skill
          </Button>
        }
      />
      {error && !skills ? (
        <Notice
          tone="danger"
          title="Could not load skills"
          action={
            <Button size="sm" variant="outline" onClick={() => void load()}>
              Retry
            </Button>
          }
        >
          {error}
        </Notice>
      ) : skills === null ? (
        <div className="space-y-4">
          <Skeleton className="h-8 w-full max-w-sm" />
          <CardsSkeleton />
        </div>
      ) : skills.length === 0 ? (
        <Card className="border-dashed ring-0 outline-1 outline-border outline-dashed">
          <EmptyState
            icon={<Sparkles />}
            title="No skills yet"
            className="py-16"
            action={
              <Button onClick={() => setAdding(true)}>
                <Plus /> Add skill
              </Button>
            }
          >
            Import skills from Claude Code, a folder or a git repository, or write your own. Agents load a skill when a task matches its description.
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <InputGroup className="w-full sm:max-w-sm">
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search skills" aria-label="Search skills" />
              {query ? (
                <InputGroupAddon align="inline-end">
                  <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => setQuery("")}>
                    <X />
                  </InputGroupButton>
                </InputGroupAddon>
              ) : null}
            </InputGroup>
            <p className="text-sm text-muted-foreground sm:ml-auto" aria-live="polite">
              {plural(skills.length, "skill")} · {onCount} on
            </p>
          </div>
          {filtered && filtered.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {filtered.map((s) => (
                <SkillCard key={s.id} skill={s} busy={toggling.has(s.id)} onOpen={() => setOpenId(s.id)} onToggle={(v) => void toggle(s, v)} />
              ))}
            </div>
          ) : (
            <EmptyState icon={<SearchX />} title="No skills match" className="py-16">
              Nothing matches “{query.trim()}”. Try another word or{" "}
              <button type="button" className="underline underline-offset-4 hover:text-foreground" onClick={() => setQuery("")}>
                clear the search
              </button>
              .
            </EmptyState>
          )}
        </div>
      )}
      <SkillSheet
        summary={open}
        onClose={() => setOpenId(null)}
        toggling={open ? toggling.has(open.id) : false}
        onToggle={(s, v) => void toggle(s, v)}
        onSaved={(s) => patch(s)}
        onDeleted={(id) => {
          setOpenId(null);
          setSkills((list) => (list ? list.filter((s) => s.id !== id) : list));
        }}
      />
      <AddSkillDialog open={adding} onOpenChange={setAdding} onAdded={() => void load()} />
    </Page>
  );
}
