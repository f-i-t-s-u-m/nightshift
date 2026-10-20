import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { ChevronDown, CircleAlert, ExternalLink, GitBranch, GitPullRequest, Inbox, ListFilter, Plus, Radar, Settings, Share2 } from "lucide-react";
import { toast } from "sonner";
import { TASK_ID_PATTERN, TASK_TYPES, isTaskType, taskTypeInfo, type PreviewStatus, type ProjectTasksResponse, type TaskListItem, type TaskPreviewSummary, type TaskStatus, type TaskType } from "@nightshift/core";
import { formatDateTime, type Tone } from "@nightshift/ui";
import { Cost } from "../billing";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { api, isNotFound, messageOf } from "../api";
import { AttachButton, UploadTray, useUploads } from "../components/attachments";
import { BranchPicker } from "../components/BranchPicker";
import { Markdown } from "../components/Markdown";
import { Notice } from "../components/Notice";
import { Dot, EmptyState, Page, PageHeader, PhaseBadge, ProjectMeta, StatusPill, TONE_TEXT } from "../components/TaskBits";
import { projectSettingsHref, taskHref } from "../routing";
import { KindIcon } from "../components/projectKinds";
import { DEFAULT_TASK_TYPE, TaskTypeBadge, TaskTypeIcon, TaskTypePicker } from "../components/taskTypes";
import { DecisionCount, OriginBadge } from "../components/verification";
import { useDebouncedRefresh, useLive } from "../live";
import { TASK_STATUSES, isActive } from "../phases";

const POLL_MS = 5000;

type Filter = "all" | TaskStatus;

const FILTER_KEY = "nightshift.taskFilter";
const LISTENER_KEY = "nightshift.listenerFilter";
const TYPE_KEY = "nightshift.typeFilter";

type TypeFilter = "all" | TaskType;

const readTypeFilter = (): TypeFilter => {
  try {
    const v = window.localStorage.getItem(TYPE_KEY);
    return isTaskType(v) ? v : "all";
  } catch {
    return "all";
  }
};

const readListenerFilter = () => {
  try {
    return window.localStorage.getItem(LISTENER_KEY) === "1";
  } catch {
    return false;
  }
};

const fromListener = (t: TaskListItem) => Boolean(t.origin && t.origin.kind !== "manual");

const readFilter = (): Filter => {
  try {
    const v = window.localStorage.getItem(FILTER_KEY);
    if (v === "all" || TASK_STATUSES.some((s) => s.status === v)) return v as Filter;
  } catch {
    return "all";
  }
  return "all";
};

const byRecent = (a: TaskListItem, b: TaskListItem) => Date.parse(b.updatedAt ?? b.createdAt ?? "") - Date.parse(a.updatedAt ?? a.createdAt ?? "") || 0;

const SERVICE_TONE: Record<TaskPreviewSummary["services"][number]["status"], Tone> = { stopped: "muted", starting: "warning", running: "success", failed: "danger" };

function PreviewSummary({ preview }: { preview: TaskPreviewSummary }) {
  const { total, running, starting, failed, url, services } = preview;
  if (running + starting + failed === 0) return null;
  const tone: Tone = failed ? "danger" : starting ? "warning" : "success";
  const failedNames = services.filter((s) => s.status === "failed").map((s) => s.name);
  const label = failed
    ? total > 1
      ? failed === 1 && failedNames[0]
        ? `${failedNames[0]} failed`
        : `${failed}/${total} failed`
      : "preview failed"
    : starting
      ? total > 1
        ? `${starting}/${total} starting`
        : "preview starting"
      : total > 1
        ? running === total
          ? `${total} apps running`
          : `${running}/${total} running`
        : "preview running";
  const detail = services.map((s) => `${s.name} ${s.status}`).join(", ");
  const className = cn("inline-flex items-center gap-1.5 rounded-sm text-xs whitespace-nowrap", TONE_TEXT[tone]);
  const body = (
    <>
      <Dot tone={tone} pulse={!failed && starting > 0} className="size-1.5" />
      {label}
    </>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {url && running > 0 && !failed ? (
          <a href={url} target="_blank" rel="noopener noreferrer" className={cn(className, "underline-offset-4 hover:underline")}>
            {body}
            <ExternalLink className="size-3 opacity-70" aria-hidden="true" />
            <span className="sr-only"> (opens the preview in a new tab; {detail})</span>
          </a>
        ) : (
          <span tabIndex={0} className={cn(className, "cursor-default")}>
            {body}
            <span className="sr-only"> ({detail})</span>
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent className="grid gap-1">
        {services.map((s) => (
          <span key={s.name} className="flex items-center gap-2">
            <Dot tone={SERVICE_TONE[s.status]} className="size-1.5" />
            <span className="font-medium">{s.name}</span>
            <span className="opacity-70">{s.status}</span>
          </span>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

const LIVE = (s: PreviewStatus) => s === "running" || s === "starting";

function SharedServicesStrip({ project, tasks }: { project: ProjectTasksResponse["project"]; tasks: TaskListItem[] }) {
  const headingId = useId();
  const shared = (project.preview?.services ?? []).filter((s) => s.shared);
  if (!shared.length) return null;
  const names = new Set(shared.map((s) => s.name));
  const users = tasks.filter((t) => t.preview?.services.some((s) => !names.has(s.name) && LIVE(s.status))).map((t) => t.id);
  const statusOf = (name: string): PreviewStatus | null => {
    const seen = tasks.flatMap((t) => t.preview?.services.filter((s) => s.name === name) ?? []).map((s) => s.status);
    return seen.find(LIVE) ?? seen.find((s) => s === "failed") ?? seen[0] ?? null;
  };
  return (
    <section aria-labelledby={headingId} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-card px-3 py-2">
      <h2 id={headingId} className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Share2 className="size-3.5 text-violet-600 dark:text-violet-400" aria-hidden="true" />
        Shared services
      </h2>
      <ul className="flex min-w-0 flex-wrap gap-1.5">
        {shared.map((s) => {
          const external = !s.command.trim();
          const status = statusOf(s.name);
          const shown: PreviewStatus = status ?? "stopped";
          const tone: Tone = status ? SERVICE_TONE[status] : "muted";
          const count = status && LIVE(status) ? users.length : 0;
          const usage = count ? `used by ${count} task${count === 1 ? "" : "s"}` : "not in use";
          const detail = [external ? "already running outside Nightshift" : null, status ? shown : external ? null : "stopped", s.port ? `port ${s.port}` : "port picked on first start", usage].filter(Boolean).join(", ");
          return (
            <li key={s.name}>
              <span className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-md border bg-background px-2 text-xs" title={`${s.name}: ${detail}${count ? ` (${users.join(", ")})` : ""}`}>
                <Dot tone={tone} pulse={status === "starting"} className="size-1.5" />
                <span className="font-medium">{s.name}</span>
                {s.port ? <code className="font-mono text-muted-foreground">:{s.port}</code> : null}
                {external ? <span className="text-muted-foreground">external</span> : null}
                <span className="tabular-nums text-muted-foreground" aria-hidden="true">
                  · {count ? `${count} task${count === 1 ? "" : "s"}` : status === "failed" ? "failed" : "idle"}
                </span>
                <span className="sr-only">: {detail}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const withoutShared = (preview: TaskPreviewSummary, shared: Set<string>): TaskPreviewSummary => {
  if (!shared.size) return preview;
  const services = preview.services.filter((s) => !shared.has(s.name));
  const count = (st: PreviewStatus) => services.filter((s) => s.status === st).length;
  return { ...preview, total: services.length, running: count("running"), starting: count("starting"), failed: count("failed"), services };
};

function TaskRow({ projectId, task, defaultBranch, shared }: { projectId: string; task: TaskListItem; defaultBranch: string; shared: Set<string> }) {
  const run = task.run;
  const running = run ? isActive(run.phase) : false;
  return (
    <li className={cn("relative flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 transition-colors hover:bg-muted/50", running && "bg-sky-500/[0.03]")}>
      <div className="min-w-0 flex-1 basis-64">
        <a className="font-medium after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-3 focus-visible:after:ring-ring/50" href={taskHref(projectId, task.id)}>
          {task.title || task.id}
        </a>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <TaskTypeBadge type={task.type} />
          <span className="font-mono">{task.id}</span>
          {task.baseBranch && task.baseBranch !== defaultBranch ? (
            <span className="inline-flex max-w-56 items-center gap-1 rounded-md border px-1.5 py-px font-mono" title={`Starts from ${task.baseBranch}`}>
              <GitBranch className="size-3 shrink-0" />
              <span className="truncate">from {task.baseBranch}</span>
            </span>
          ) : null}
          <OriginBadge origin={task.origin} />
          {run && (running || run.paused) ? <PhaseBadge phase={run.phase} paused={run.paused} /> : null}
          {run?.activity && running ? <span className="min-w-0 truncate">{run.activity}</span> : null}
        </div>
      </div>
      <div className="relative flex items-center gap-3 text-sm">
        {task.preview ? <PreviewSummary preview={withoutShared(task.preview, shared)} /> : null}
        <DecisionCount count={task.openDecisions ?? 0} />
        {(task.openIssues ?? 0) > 0 ? (
          <span className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300" title={`${task.openIssues} open issue${task.openIssues === 1 ? "" : "s"} from checks, review or testers`}>
            <CircleAlert className="size-3.5" />
            {task.openIssues}
            <span className="sr-only"> open issues</span>
          </span>
        ) : null}
        {task.unreadMessages > 0 ? (
          <span
            className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground"
            title={`${task.unreadMessages} message${task.unreadMessages === 1 ? "" : "s"} waiting for the agent`}
          >
            {task.unreadMessages}
            <span className="sr-only"> new messages</span>
          </span>
        ) : null}
        {run?.prUrl ? (
          <a className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground" href={run.prUrl} target="_blank" rel="noopener noreferrer">
            <GitPullRequest className="size-3.5" />
            {run.prNumber ? `#${run.prNumber}` : "PR"}
          </a>
        ) : null}
        {run && run.costUsd > 0 ? <Cost usd={run.costUsd} model={run.model} className="text-muted-foreground" /> : null}
        <StatusPill status={task.status} />
      </div>
    </li>
  );
}

function NewTaskDialog({
  projectId,
  projectDefaultBranch,
  nextTaskId,
  open,
  onOpenChange,
  onCreated,
}: {
  projectId: string;
  projectDefaultBranch: string;
  /** null when the task source gives ids (WonderCall): no id field then. */
  nextTaskId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (type: TaskType) => void;
}) {
  const uploads = useUploads();
  const [defaultBranch, setDefaultBranch] = useState(projectDefaultBranch);
  const [baseBranch, setBaseBranch] = useState<string | null>(null);
  const [startFrom, setStartFrom] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [taskId, setTaskId] = useState("");
  const [body, setBody] = useState("");
  const [bodyView, setBodyView] = useState<"write" | "preview">("write");
  const [type, setType] = useState<TaskType>(DEFAULT_TASK_TYPE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const review = type === "review";
  const idError = taskId.trim() && !TASK_ID_PATTERN.test(taskId.trim()) ? 'Use letters, digits, ".", "_" or "-", starting with a letter or digit' : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() || busy || uploads.uploading || (review && !startFrom) || idError) return;
    setBusy(true);
    setError(null);
    try {
      const base = baseBranch && baseBranch !== defaultBranch ? baseBranch : undefined;
      await api.createTask(projectId, {
        title: title.trim(),
        body: body.trim(),
        type,
        attachmentIds: uploads.attachments.map((a) => a.id),
        ...(base ? { baseBranch: base } : {}),
        ...(review && startFrom ? { startFrom } : {}),
        ...(taskId.trim() ? { id: taskId.trim() } : {}),
      });
      uploads.clear();
      setBaseBranch(null);
      setStartFrom(null);
      setTitle("");
      setTaskId("");
      setBody("");
      setBodyView("write");
      setType(DEFAULT_TASK_TYPE);
      onCreated(type);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <form className={cn("grid gap-4", uploads.dragging && "rounded-lg outline-2 outline-dashed outline-primary")} onSubmit={(e) => void submit(e)} {...uploads.dropProps}>
          <DialogHeader>
            <DialogTitle>New task</DialogTitle>
            <DialogDescription>An agent picks it up when a slot is free.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor={`${id}-base`}>Base branch</Label>
            <BranchPicker
              id={`${id}-base`}
              projectId={projectId}
              value={baseBranch ?? defaultBranch}
              defaultBranch={defaultBranch}
              onChange={setBaseBranch}
              onDefaultBranch={setDefaultBranch}
            />
          </div>
          <div className="grid gap-2">
            <Label id={`${id}-type-label`} asChild>
              <span>Type</span>
            </Label>
            <TaskTypePicker value={type} onChange={setType} labelledBy={`${id}-type-label`} describedBy={`${id}-type-hint`} />
            <p id={`${id}-type-hint`} className="text-xs text-muted-foreground" aria-live="polite">
              {taskTypeInfo(type)?.description}
            </p>
          </div>
          {review ? (
            <div className="grid gap-2">
              <Label htmlFor={`${id}-from`}>Branch with the work to continue</Label>
              <BranchPicker id={`${id}-from`} projectId={projectId} value={startFrom ?? ""} defaultBranch={defaultBranch} onChange={setStartFrom} />
              <p className="text-xs text-muted-foreground">
                The agent checks what is on this branch, then finishes it. Branches outside Nightshift's prefix are not pushed to: the agent works on its own branch that starts from this one, and the pull request goes to the base branch.
              </p>
            </div>
          ) : null}
          <div className={cn("grid gap-x-3 gap-y-2", nextTaskId !== null && "sm:grid-cols-[9rem_1fr]")}>
            {nextTaskId !== null ? (
              <div className="grid content-start gap-2">
                <Label htmlFor={`${id}-taskid`}>ID</Label>
                <Input
                  id={`${id}-taskid`}
                  value={taskId}
                  onChange={(e) => setTaskId(e.target.value.replace(/\s/g, ""))}
                  placeholder={nextTaskId}
                  className="font-mono"
                  aria-invalid={Boolean(idError)}
                  aria-describedby={`${id}-taskid-hint`}
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={40}
                />
              </div>
            ) : null}
            <div className="grid content-start gap-2">
              <Label htmlFor={`${id}-title`}>Title</Label>
              <Input id={`${id}-title`} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What should the agent do?" required onPaste={uploads.onPaste} />
            </div>
            {nextTaskId !== null ? (
              <p id={`${id}-taskid-hint`} className={cn("text-xs sm:col-span-2", idError ? "text-destructive" : "text-muted-foreground")}>
                {idError ?? (
                  <>
                    Your own id, such as a board ticket number. Leave it empty for <code className="font-mono">{nextTaskId}</code>. It names the branch, the commits and the pull request.
                  </>
                )}
              </p>
            ) : null}
          </div>
          <div className="grid gap-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor={`${id}-body`}>Description</Label>
              <div className="flex rounded-md border p-0.5 text-xs" role="group" aria-label="Description view">
                {(["write", "preview"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={bodyView === m}
                    onClick={() => setBodyView(m)}
                    className={cn("rounded px-2 py-0.5 capitalize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50", bodyView === m ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
            {bodyView === "write" ? (
              <Textarea
                id={`${id}-body`}
                rows={8}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                onPaste={uploads.onPaste}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void submit(e);
                  }
                }}
                placeholder="Context, acceptance criteria, links. Markdown works (# headings, - lists, `code`). Paste or drop screenshots here."
                className="max-h-[45dvh] resize-y overflow-y-auto"
              />
            ) : (
              <div className="max-h-[45dvh] min-h-36 overflow-y-auto rounded-lg border px-3 py-2" aria-label="Description preview">
                {body.trim() ? <Markdown text={body} /> : <p className="text-sm text-muted-foreground">Nothing to preview yet.</p>}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              {body.trim() ? `${body.trim().split(/\s+/).length} words · ` : ""}The task page shows it formatted like the preview. ⌘/Ctrl + Enter creates the task.
            </p>
          </div>
          <UploadTray uploads={uploads} />
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <DialogFooter className="sticky -bottom-4 -mx-4 -mb-4 items-center border-t bg-popover px-4 py-3 sm:justify-between">
            <AttachButton uploads={uploads} />
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!title.trim() || busy || uploads.uploading || (review && !startFrom) || Boolean(idError)}>
                {busy ? "Creating…" : uploads.uploading ? "Uploading…" : "Create task"}
              </Button>
            </div>
          </DialogFooter>
          {uploads.dragging ? <div className="text-center text-sm text-muted-foreground">Drop pictures to attach</div> : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ProjectPage({ projectId }: { projectId: string }) {
  const { connection, refreshProjects } = useLive();
  const [data, setData] = useState<ProjectTasksResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [composing, setComposing] = useState(false);
  const [filter, setFilterState] = useState<Filter>(readFilter);
  const [listenersOnly, setListenersOnlyState] = useState(readListenerFilter);
  const [typeFilter, setTypeFilterState] = useState<TypeFilter>(readTypeFilter);

  const setTypeFilter = (next: TypeFilter) => {
    setTypeFilterState(next);
    try {
      window.localStorage.setItem(TYPE_KEY, next);
    } catch {
      return;
    }
  };

  const setListenersOnly = (next: boolean) => {
    setListenersOnlyState(next);
    try {
      window.localStorage.setItem(LISTENER_KEY, next ? "1" : "0");
    } catch {
      return;
    }
  };

  const setFilter = (next: Filter) => {
    setFilterState(next);
    try {
      window.localStorage.setItem(FILTER_KEY, next);
    } catch {
      return;
    }
  };

  const load = useCallback(async () => {
    try {
      setData(await api.tasks(projectId));
      setError(null);
      setNotFound(false);
    } catch (err) {
      setNotFound(isNotFound(err));
      setError(messageOf(err));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (connection === "live") return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [connection, load]);

  useDebouncedRefresh(
    (event) => (event.type === "task" && event.projectId === projectId) || (event.type === "run" && event.run.projectId === projectId) || event.type === "projects",
    () => void load(),
  );

  if (!data) {
    return (
      <Page>
        {notFound ? (
          <Notice tone="warning" title="Project not found">
            No project with id <code>{projectId}</code>. <a href="#/">Go home</a>.
          </Notice>
        ) : error ? (
          <Notice tone="danger" title="Could not load project">
            {error}
          </Notice>
        ) : (
          <div className="space-y-4">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-64 w-full" />
          </div>
        )}
      </Page>
    );
  }

  const { project, tasks: allTasks } = data;
  const listenerCount = allTasks.filter(fromListener).length;
  const sourceTasks = listenersOnly ? allTasks.filter(fromListener) : allTasks;
  const typeCounts = Object.fromEntries(TASK_TYPES.map((t) => [t.type, sourceTasks.filter((x) => x.type === t.type).length])) as Record<TaskType, number>;
  const typed = sourceTasks.some((t) => t.type !== null);
  const tasks = typeFilter === "all" ? sourceTasks : sourceTasks.filter((t) => t.type === typeFilter);
  const typeLabel = typeFilter === "all" ? null : taskTypeInfo(typeFilter)?.label;
  const counts = Object.fromEntries(TASK_STATUSES.map((s) => [s.status, tasks.filter((t) => t.status === s.status).length]));
  const groups = TASK_STATUSES.filter((s) => filter === "all" || s.status === filter).map((s) => ({
    ...s,
    tasks: tasks.filter((t) => t.status === s.status).sort(byRecent),
  }));
  const visible = groups.filter((g) => g.tasks.length > 0);
  const sharedNames = new Set((project.preview?.services ?? []).filter((s) => s.shared).map((s) => s.name));

  return (
    <Page>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <KindIcon kind={project.kind} className="size-5 text-muted-foreground" />
            {project.name}
          </span>
        }
        description={<ProjectMeta project={project} />}
        actions={
          <>
            <Button variant="outline" size="icon" asChild>
              <a href={projectSettingsHref(projectId)} aria-label="Project settings" title="Project settings">
                <Settings />
              </a>
            </Button>
            <Button onClick={() => setComposing(true)}>
              <Plus /> New task
            </Button>
          </>
        }
      />
      <SharedServicesStrip project={project} tasks={allTasks} />
      {project.paused ? (
        <Notice
          tone="warning"
          title="New work is paused"
          action={
            <Button size="sm" variant="outline" asChild>
              <a href={projectSettingsHref(projectId)}>
                <Settings /> Open settings
              </a>
            </Button>
          }
        >
          Agents do not pick up new tasks in this project until you resume it in settings.
        </Notice>
      ) : null}
      {project.sourceError ? (
        <Notice tone="danger" title="Task source error">
          {project.sourceError}
        </Notice>
      ) : null}
      {error ? (
        <Notice tone="warning" title="Showing last known tasks">
          {error}
        </Notice>
      ) : null}
      <NewTaskDialog
        projectId={projectId}
        projectDefaultBranch={project.repo.baseBranch}
        nextTaskId={data?.nextTaskId ?? null}
        open={composing}
        onOpenChange={setComposing}
        onCreated={(created) => {
          if (typeFilter !== "all" && typeFilter !== created) setTypeFilter("all");
          setComposing(false);
          toast.success("Task created", { description: "An agent picks it up when a slot is free." });
          if (filter !== "all" && filter !== "ready_for_ai") setFilter("all");
          void load();
          void refreshProjects();
        }}
      />
      <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-wrap md:px-0" role="toolbar" aria-label="Filter tasks">
        <Button size="sm" variant={filter === "all" ? "secondary" : "ghost"} aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
          All <span className="tabular-nums text-muted-foreground">{tasks.length}</span>
        </Button>
        {TASK_STATUSES.map((s) => (
          <Button key={s.status} size="sm" variant={filter === s.status ? "secondary" : "ghost"} aria-pressed={filter === s.status} onClick={() => setFilter(s.status)}>
            <Dot tone={s.tone} className="size-1.5" />
            {s.label} <span className="tabular-nums text-muted-foreground">{counts[s.status]}</span>
          </Button>
        ))}
        {listenerCount > 0 || listenersOnly ? (
          <>
            <span className="mx-1 w-px shrink-0 self-stretch bg-border" aria-hidden="true" />
            <Button
              size="sm"
              variant={listenersOnly ? "secondary" : "ghost"}
              aria-pressed={listenersOnly}
              onClick={() => setListenersOnly(!listenersOnly)}
              title="Tasks created automatically from PR reviews, failing CI or GitHub issues"
            >
              <Radar className="text-teal-600 dark:text-teal-400" />
              Created by listeners <span className="tabular-nums text-muted-foreground">{listenerCount}</span>
            </Button>
          </>
        ) : null}
        {typed || typeFilter !== "all" ? (
          <>
            <span className="mx-1 w-px shrink-0 self-stretch bg-border" aria-hidden="true" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant={typeFilter === "all" ? "ghost" : "secondary"} aria-label={typeLabel ? `Filter by type: ${typeLabel}` : "Filter by type"}>
                  {typeFilter === "all" ? <ListFilter /> : <TaskTypeIcon type={typeFilter} />}
                  {typeLabel ?? "Type"}
                  {typeFilter !== "all" ? <span className="tabular-nums text-muted-foreground">{tasks.length}</span> : null}
                  <ChevronDown className="opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuLabel>Task type</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={typeFilter} onValueChange={(v) => setTypeFilter(isTaskType(v) ? v : "all")}>
                  <DropdownMenuRadioItem value="all">
                    <ListFilter className="text-muted-foreground" />
                    All types
                    <span className="ml-auto tabular-nums text-xs text-muted-foreground">{sourceTasks.length}</span>
                  </DropdownMenuRadioItem>
                  <DropdownMenuSeparator />
                  {TASK_TYPES.map((t) => (
                    <DropdownMenuRadioItem key={t.type} value={t.type} disabled={typeCounts[t.type] === 0 && typeFilter !== t.type}>
                      <TaskTypeIcon type={t.type} className="size-4" />
                      {t.label}
                      <span className="ml-auto tabular-nums text-xs text-muted-foreground">{typeCounts[t.type]}</span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : null}
      </div>
      {allTasks.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Inbox />}
            title="No tasks yet"
            action={
              <Button variant="outline" onClick={() => setComposing(true)}>
                <Plus /> New task
              </Button>
            }
          >
            Create a task and an agent will pick it up. {project.source.type !== "local" ? "Tasks marked Ready for AI in WonderCall show up here too." : null}
          </EmptyState>
        </Card>
      ) : visible.length === 0 ? (
        <Card>
          <EmptyState title="Nothing here">{typeFilter !== "all" ? `No ${typeLabel ?? ""} tasks${listenersOnly ? " from listeners" : ""} with this status.` : listenersOnly ? "No listener-created tasks with this status." : "No tasks with this status."}</EmptyState>
        </Card>
      ) : (
        visible.map((g) => (
          <section key={g.status} aria-labelledby={`grp-${g.status}`} className="space-y-2">
            <h2 id={`grp-${g.status}`} className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Dot tone={g.tone} />
              {g.label}
              <span className="tabular-nums">{g.tasks.length}</span>
            </h2>
            <Card className="py-0">
              <ul className="divide-y">
                {g.tasks.map((t) => (
                  <TaskRow key={t.id} projectId={projectId} task={t} defaultBranch={project.repo.baseBranch} shared={sharedNames} />
                ))}
              </ul>
            </Card>
          </section>
        ))
      )}
      <p className="text-xs text-muted-foreground">Created {formatDateTime(project.createdAt)}</p>
    </Page>
  );
}
