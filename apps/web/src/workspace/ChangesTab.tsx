import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { DiffEditor } from "@monaco-editor/react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  CloudOff,
  CloudUpload,
  FileDiff,
  Files,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  Minus,
  Plus,
  RefreshCw,
  Undo2,
} from "lucide-react";
import { toast } from "sonner";
import type { CommitDiffResponse, GitChange, GitCommit, GitDiffResponse, PullBaseConflict } from "@nightshift/core";
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { api, messageOf } from "../api";
import { EmptyState, Spinner, ToneBadge } from "../components/TaskBits";
import { GitLetter, NoWorkspace, SplitPane, baseName, dirName, useLoad, useMonacoTheme, useWorkspaceRefresh, type WorkspaceTabProps } from "./common";
import { languageFor } from "./monaco";

type Selected = { path: string; staged: boolean };
type CommitSelected = { sha: string; path: string };
type CommitDiffState = { data: CommitDiffResponse | null; error: string | null; loading: boolean };

function IconAction({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function ChangeRow({
  change,
  staged,
  selected,
  busy,
  onSelect,
  onStage,
  onUnstage,
  onDiscard,
}: {
  change: GitChange;
  staged: boolean;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onStage?: () => void;
  onUnstage?: () => void;
  onDiscard?: () => void;
}) {
  const dir = dirName(change.path);
  return (
    <li className={cn("group flex h-7 items-center gap-1 pr-1 hover:bg-muted", selected && "bg-muted")}>
      <button
        type="button"
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-6 text-left text-[13px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        title={change.oldPath ? `${change.oldPath} → ${change.path}` : change.path}
      >
        <span className={cn("truncate", change.status === "deleted" && "line-through")}>{baseName(change.path)}</span>
        {dir ? <span className="min-w-0 truncate text-xs text-muted-foreground">{dir}</span> : null}
      </button>
      <span className="flex items-center opacity-100 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100">
        {onDiscard ? (
          <IconAction label="Discard changes" onClick={onDiscard} disabled={busy}>
            <Undo2 />
          </IconAction>
        ) : null}
        {onStage ? (
          <IconAction label="Stage changes" onClick={onStage} disabled={busy}>
            <Plus />
          </IconAction>
        ) : null}
        {onUnstage ? (
          <IconAction label="Unstage changes" onClick={onUnstage} disabled={busy}>
            <Minus />
          </IconAction>
        ) : null}
      </span>
      <GitLetter status={change.status} className="mr-1" />
      <span className="sr-only">{staged ? "staged" : "not staged"}</span>
    </li>
  );
}

function Section({ title, count, actions, children, defaultOpen = true }: { title: string; count: number; actions?: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="group/section flex h-7 items-center pr-1 hover:bg-muted/60">
        <CollapsibleTrigger className="flex h-full min-w-0 flex-1 items-center gap-1 pl-1 text-left text-xs font-semibold tracking-wide uppercase focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset">
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
          <span className="truncate">{title}</span>
        </CollapsibleTrigger>
        {actions ? <span className="flex items-center">{actions}</span> : null}
        <span className="ml-1 rounded-full bg-muted px-1.5 text-[11px] tabular-nums text-muted-foreground">{count}</span>
      </div>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

function CommitItem({
  commit,
  selectedPath,
  onSelectFile,
}: {
  commit: GitCommit;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <li>
        <CollapsibleTrigger className="flex w-full items-start gap-1.5 px-1 py-1.5 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset">
          <ChevronRight className={cn("mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
          <GitCommitHorizontal className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px]" title={commit.subject}>
              {commit.subject}
            </span>
            <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              <code className="font-mono">{commit.shortSha}</code>
              <span className="truncate">{commit.author}</span>
              <time dateTime={commit.date} title={formatDateTime(commit.date)}>
                {formatRelative(commit.date)}
              </time>
            </span>
          </span>
          {commit.pushed ? (
            <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-label="Pushed" />
          ) : (
            <CloudOff className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-label="Not pushed" />
          )}
        </CollapsibleTrigger>
        <CollapsibleContent>
          {commit.body ? <pre className="mx-6 mb-1 font-sans text-xs whitespace-pre-wrap text-muted-foreground">{commit.body}</pre> : null}
          {commit.files.length > 1 ? (
            <button
              type="button"
              className="ml-11 flex h-6 items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onClick={() => onSelectFile(commit.files[0]?.path ?? "")}
            >
              <Files className="size-3.5" />
              View all {commit.files.length} files of this commit
            </button>
          ) : null}
          <ul className="pb-1">
            {commit.files.map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  className={cn(
                    "flex h-6 w-full items-center gap-1.5 pr-2 pl-11 text-left text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
                    selectedPath === f.path && "bg-muted",
                  )}
                  title={f.path}
                  aria-current={selectedPath === f.path ? "true" : undefined}
                  onClick={() => onSelectFile(f.path)}
                >
                  <span className={cn("min-w-0 flex-1 truncate", f.status === "deleted" && "line-through")}>{f.path}</span>
                  <GitLetter status={f.status} />
                </button>
              </li>
            ))}
            {commit.files.length === 0 ? <li className="pl-11 text-xs text-muted-foreground">No files</li> : null}
          </ul>
        </CollapsibleContent>
      </li>
    </Collapsible>
  );
}

function CommitDiffPane({
  sel,
  commit,
  state,
  theme,
  mobile,
  onSelect,
  onRetry,
  onClose,
}: {
  sel: CommitSelected;
  commit: GitCommit | null;
  state: CommitDiffState;
  theme: string;
  mobile: boolean;
  onSelect: (path: string) => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const data = state.data;
  const files = data?.files ?? [];
  const index = files.findIndex((f) => f.path === sel.path);
  const file = index >= 0 ? files[index] : undefined;
  const shortSha = commit?.shortSha ?? sel.sha.slice(0, 7);
  const subject = data?.subject ?? commit?.subject ?? "";
  const prev = index > 0 ? files[index - 1] : undefined;
  const next = index >= 0 && index < files.length - 1 ? files[index + 1] : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-xs">
        <GitCommitHorizontal className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 items-center gap-1.5" title={`commit ${sel.sha} · ${subject} · ${sel.path}`}>
          <span className="shrink-0 text-muted-foreground">commit</span>
          <code className="shrink-0 font-mono">{shortSha}</code>
          {subject ? (
            <>
              <span className="text-muted-foreground" aria-hidden="true">·</span>
              <span className="hidden max-w-[40%] truncate sm:inline">{subject}</span>
              <span className="hidden text-muted-foreground sm:inline" aria-hidden="true">·</span>
            </>
          ) : null}
          <span className="min-w-0 truncate font-mono">{file?.oldPath ? `${file.oldPath} → ${sel.path}` : sel.path}</span>
          {file ? <GitLetter status={file.status} /> : null}
        </span>
        {state.loading ? <Spinner className="size-3.5" /> : null}
        {files.length > 1 ? (
          <span className="flex shrink-0 items-center gap-0.5">
            <IconAction label="Previous file" onClick={() => prev && onSelect(prev.path)} disabled={!prev}>
              <ChevronLeft />
            </IconAction>
            <span className="tabular-nums text-muted-foreground">
              {index + 1}/{files.length}
            </span>
            <IconAction label="Next file" onClick={() => next && onSelect(next.path)} disabled={!next}>
              <ChevronRight />
            </IconAction>
          </span>
        ) : null}
        <Button variant="ghost" size="xs" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        {state.error && !data ? (
          <EmptyState
            title="Could not load the commit"
            className="h-full"
            action={
              <Button size="sm" variant="outline" onClick={onRetry}>
                Retry
              </Button>
            }
          >
            {state.error}
          </EmptyState>
        ) : !data ? (
          <EmptyState icon={<Spinner />} title="Loading commit…" className="h-full" />
        ) : !file ? (
          <EmptyState icon={<FileDiff />} title="File not in this commit's diff" className="h-full">
            {files.length ? "Pick another file of the commit." : "This commit changes no files."}
          </EmptyState>
        ) : file.binary ? (
          <EmptyState title="Binary file" className="h-full">
            Binary files are not compared here.
          </EmptyState>
        ) : file.tooLarge ? (
          <EmptyState title="File too large" className="h-full">
            This file is too large to compare in the browser.
          </EmptyState>
        ) : (
          <DiffEditor
            original={file.original}
            modified={file.modified}
            language={languageFor(file.path, file.language)}
            originalModelPath={`diff/commit/${sel.sha}/original/${file.oldPath ?? file.path}`}
            modifiedModelPath={`diff/commit/${sel.sha}/modified/${file.path}`}
            keepCurrentOriginalModel
            keepCurrentModifiedModel
            theme={theme}
            loading={<Spinner label="Loading editor" />}
            options={{
              readOnly: true,
              originalEditable: false,
              renderSideBySide: !mobile,
              automaticLayout: true,
              minimap: { enabled: false },
              fontSize: 13,
              scrollBeyondLastLine: false,
            }}
          />
        )}
      </div>
    </div>
  );
}

export default function ChangesTab({ projectId, taskId, ws, workspace, active }: WorkspaceTabProps) {
  const theme = useMonacoTheme();
  const mobile = useIsMobile();
  const status = useLoad(() => ws.gitStatus(), workspace.exists);
  const log = useLoad(() => ws.gitLog(), workspace.exists);
  const [selected, setSelectedState] = useState<Selected | null>(null);
  const [commitSel, setCommitSel] = useState<CommitSelected | null>(null);
  const [commitDiffs, setCommitDiffs] = useState<Record<string, CommitDiffState>>({});
  const commitRequested = useRef(new Set<string>());
  const [diff, setDiff] = useState<GitDiffResponse | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState<string[] | null>(null);

  const loadDiff = useCallback(
    async (sel: Selected | null) => {
      if (!sel) {
        setDiff(null);
        return;
      }
      setDiffLoading(true);
      try {
        setDiff(await ws.gitDiff(sel.path, sel.staged));
        setDiffError(null);
      } catch (err) {
        setDiffError(messageOf(err));
      } finally {
        setDiffLoading(false);
      }
    },
    [ws],
  );

  useEffect(() => {
    void loadDiff(selected);
  }, [selected, loadDiff]);

  const setSelected = (sel: Selected | null) => {
    setCommitSel(null);
    setSelectedState(sel);
  };

  const loadCommit = useCallback(
    async (sha: string, force = false) => {
      if (commitRequested.current.has(sha) && !force) return;
      commitRequested.current.add(sha);
      setCommitDiffs((prev) => ({ ...prev, [sha]: { data: prev[sha]?.data ?? null, error: null, loading: true } }));
      try {
        const data = await ws.commitDiff(sha);
        setCommitDiffs((prev) => ({ ...prev, [sha]: { data, error: null, loading: false } }));
      } catch (err) {
        commitRequested.current.delete(sha);
        setCommitDiffs((prev) => ({ ...prev, [sha]: { data: null, error: messageOf(err), loading: false } }));
      }
    },
    [ws],
  );

  const selectCommitFile = (sha: string, path: string) => {
    setSelectedState(null);
    setCommitSel({ sha, path });
    void loadCommit(sha);
  };

  const refresh = useCallback(() => {
    void status.reload();
    void log.reload();
    void loadDiff(selected);
  }, [status.reload, log.reload, loadDiff, selected]);

  useWorkspaceRefresh(projectId, taskId, active, refresh);

  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    try {
      await fn();
      if (done) toast.success(done);
      return true;
    } catch (err) {
      toast.error("Git action failed", { description: messageOf(err) });
      return false;
    } finally {
      setBusy(null);
      void status.reload();
    }
  };

  const data = status.data;
  const staged = data?.staged ?? [];
  const unstaged = data?.unstaged ?? [];

  useEffect(() => {
    if (!selected || !data) return;
    const list = selected.staged ? data.staged : data.unstaged;
    if (!list.some((c) => c.path === selected.path)) {
      const other = (selected.staged ? data.unstaged : data.staged).find((c) => c.path === selected.path);
      setSelectedState(other ? { path: other.path, staged: !selected.staged } : null);
    }
  }, [data, selected]);

  const stage = (paths: string[]) => void run("stage", () => ws.stage(paths));
  const unstage = (paths: string[]) => void run("unstage", () => ws.unstage(paths));

  const commit = async () => {
    const msg = message.trim();
    if (!msg || staged.length === 0) return;
    const ok = await run("commit", () => ws.commit(msg), "Committed");
    if (ok) {
      setMessage("");
      void log.reload();
    }
  };

  const push = async () => {
    const ok = await run("push", () => ws.push(), "Pushed");
    if (ok) void log.reload();
  };

  const [conflict, setConflict] = useState<PullBaseConflict | null>(null);

  const pullBase = async () => {
    setBusy("pull");
    setConflict(null);
    try {
      const res = await ws.pullBase();
      if ("code" in res) {
        setConflict(res);
        return;
      }
      if (res.upToDate) toast.success(`Already up to date with ${res.baseBranch}`);
      else toast.success(`Merged ${res.merged} commit${res.merged === 1 ? "" : "s"} from ${res.baseBranch}`, { description: "Push to update the pull request." });
      void log.reload();
      refresh();
    } catch (err) {
      toast.error(`Could not pull ${data?.baseBranch ?? "the base branch"}`, { description: messageOf(err) });
    } finally {
      setBusy(null);
      void status.reload();
    }
  };

  const askAgentToMerge = async () => {
    if (!conflict) return;
    setBusy("ask");
    try {
      const sent = await api.sendMessage(projectId, taskId, {
        text: `Merge origin/${conflict.baseBranch} into your branch and resolve the conflicts${conflict.conflicts.length ? ` in ${conflict.conflicts.join(", ")}` : ""}. Keep both the task's changes and the new changes from ${conflict.baseBranch}, run the checks, then reply with a short summary.`,
      });
      toast.success("Sent to the agent", { description: sent.effect });
      setConflict(null);
    } catch (err) {
      toast.error("Could not send the message", { description: messageOf(err) });
    } finally {
      setBusy(null);
    }
  };

  if (status.missing || !workspace.exists) return <NoWorkspace />;

  const canCommit = staged.length > 0 && message.trim().length > 0 && busy === null;
  const commits = log.data?.commits ?? [];

  const scm = (
    <div className="flex h-full min-h-0 flex-col bg-sidebar/40">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Source control</span>
        <span className="ml-auto" />
        {status.loading || busy ? <Spinner className="size-3.5" /> : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label="Refresh" onClick={refresh}>
              <RefreshCw />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh</TooltipContent>
        </Tooltip>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 p-2">
          {data ? (
            <div className="flex flex-wrap items-center gap-2 px-1 text-xs">
              <GitBranch className="size-3.5 text-muted-foreground" />
              <code className="min-w-0 truncate font-mono" title={data.upstream ? `Tracking ${data.upstream}` : "No upstream"}>
                {data.branch}
              </code>
              <span className="flex items-center gap-1.5 text-muted-foreground" aria-label={`${data.ahead} ahead, ${data.behind} behind`}>
                <span className="inline-flex items-center">
                  <ArrowUp className="size-3" />
                  {data.ahead}
                </span>
                <span className="inline-flex items-center">
                  <ArrowDown className="size-3" />
                  {data.behind}
                </span>
              </span>
              {!data.upstream ? <ToneBadge tone="muted">not published</ToneBadge> : null}
            </div>
          ) : null}
          {data ? (
            <div className="flex items-center gap-2 px-1">
              <Button
                size="sm"
                variant="outline"
                className="h-7 flex-1 justify-start gap-1.5 text-xs"
                disabled={busy !== null || workspace.agentBusy}
                onClick={() => void pullBase()}
                title={workspace.agentBusy ? "Locked while the agent works" : `Fetch ${data.baseBranch} and merge it into this task's branch`}
              >
                {busy === "pull" ? <Spinner className="size-3" /> : <GitMerge />}
                Pull {data.baseBranch}
                {data.baseBehind > 0 ? (
                  <span className="ml-auto rounded-full bg-sky-500/15 px-1.5 text-[11px] font-medium text-sky-700 tabular-nums dark:text-sky-300">{data.baseBehind} new</span>
                ) : null}
              </Button>
            </div>
          ) : null}
          {conflict ? (
            <div role="alert" className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs">
              <p className="font-medium text-amber-800 dark:text-amber-200">{conflict.error}</p>
              {conflict.conflicts.length ? (
                <ul className="space-y-0.5 font-mono text-[11px] text-muted-foreground">
                  {conflict.conflicts.slice(0, 8).map((f) => (
                    <li key={f} className="truncate" title={f}>
                      {f}
                    </li>
                  ))}
                  {conflict.conflicts.length > 8 ? <li>…and {conflict.conflicts.length - 8} more</li> : null}
                </ul>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {conflict.code === "conflict" ? (
                  <Button size="sm" className="h-7 text-xs" disabled={busy !== null} onClick={() => void askAgentToMerge()}>
                    {busy === "ask" ? <Spinner className="size-3 text-primary-foreground" /> : null}
                    Ask the agent to merge it
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setConflict(null)}>
                  Dismiss
                </Button>
              </div>
            </div>
          ) : null}
          {status.error && !data ? <div className="px-1 text-xs text-destructive">{status.error}</div> : null}
          <div className="grid gap-2">
            <label htmlFor={`commit-${taskId}`} className="sr-only">
              Commit message
            </label>
            <Textarea
              id={`commit-${taskId}`}
              rows={2}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={`Message (⌘Enter to commit on "${data?.branch ?? workspace.branch ?? "branch"}")`}
              className="min-h-14 resize-y text-[13px]"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void commit();
                }
              }}
            />
            <div className="flex gap-2">
              <Button size="sm" className="flex-1" disabled={!canCommit} onClick={() => void commit()} title={staged.length === 0 ? "Stage changes to commit them" : undefined}>
                {busy === "commit" ? <Spinner className="size-3 text-primary-foreground" /> : <Check />}
                Commit
              </Button>
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void push()}>
                {busy === "push" ? <Spinner className="size-3" /> : <CloudUpload />}
                Push{data && data.ahead > 0 ? ` (${data.ahead})` : ""}
              </Button>
            </div>
            {workspace.agentBusy ? <p className="text-xs text-amber-700 dark:text-amber-300">The agent is working; it may commit and push on its own.</p> : null}
          </div>
          <div>
            <Section
              title="Staged changes"
              count={staged.length}
              actions={
                staged.length > 0 ? (
                  <IconAction label="Unstage all changes" onClick={() => unstage(staged.map((c) => c.path))} disabled={busy !== null}>
                    <Minus />
                  </IconAction>
                ) : null
              }
            >
              {staged.length === 0 ? (
                <p className="py-1 pl-6 text-xs text-muted-foreground">Nothing staged</p>
              ) : (
                <ul>
                  {staged.map((c) => (
                    <ChangeRow
                      key={`s-${c.path}`}
                      change={c}
                      staged
                      busy={busy !== null}
                      selected={selected?.staged === true && selected.path === c.path}
                      onSelect={() => setSelected({ path: c.path, staged: true })}
                      onUnstage={() => unstage([c.path])}
                    />
                  ))}
                </ul>
              )}
            </Section>
            <Section
              title="Changes"
              count={unstaged.length}
              actions={
                unstaged.length > 0 ? (
                  <>
                    <IconAction label="Discard all changes" onClick={() => setDiscarding(unstaged.map((c) => c.path))} disabled={busy !== null}>
                      <Undo2 />
                    </IconAction>
                    <IconAction label="Stage all changes" onClick={() => stage(unstaged.map((c) => c.path))} disabled={busy !== null}>
                      <Plus />
                    </IconAction>
                  </>
                ) : null
              }
            >
              {unstaged.length === 0 ? (
                <p className="py-1 pl-6 text-xs text-muted-foreground">No changes</p>
              ) : (
                <ul>
                  {unstaged.map((c) => (
                    <ChangeRow
                      key={`u-${c.path}`}
                      change={c}
                      staged={false}
                      busy={busy !== null}
                      selected={selected?.staged === false && selected.path === c.path}
                      onSelect={() => setSelected({ path: c.path, staged: false })}
                      onStage={() => stage([c.path])}
                      onDiscard={() => setDiscarding([c.path])}
                    />
                  ))}
                </ul>
              )}
            </Section>
            <Section title="Commits" count={commits.length}>
              {log.error && !log.data ? <p className="py-1 pl-6 text-xs text-destructive">{log.error}</p> : null}
              {log.data && commits.length === 0 ? <p className="py-1 pl-6 text-xs text-muted-foreground">No commits on this branch yet</p> : null}
              <ul>
                {commits.map((c) => (
                  <CommitItem key={c.sha} commit={c} selectedPath={commitSel?.sha === c.sha ? commitSel.path : null} onSelectFile={(path) => selectCommitFile(c.sha, path)} />
                ))}
              </ul>
            </Section>
          </div>
        </div>
      </ScrollArea>
      <AlertDialog open={discarding !== null} onOpenChange={(open) => (open ? null : setDiscarding(null))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {discarding && discarding.length === 1 ? `Discard changes in ${baseName(discarding[0] ?? "")}?` : `Discard ${discarding?.length ?? 0} changes?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              This cannot be undone. Untracked files are deleted.
              {discarding && discarding.length > 1 ? (
                <span className="mt-2 block max-h-32 overflow-auto font-mono text-xs">
                  {discarding.map((p) => (
                    <span key={p} className="block truncate">
                      {p}
                    </span>
                  ))}
                </span>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const paths = discarding ?? [];
                setDiscarding(null);
                void run("discard", () => ws.discard(paths), paths.length === 1 ? "Changes discarded" : `${paths.length} changes discarded`);
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );

  const commitPane = commitSel ? (
    <CommitDiffPane
      sel={commitSel}
      commit={commits.find((c) => c.sha === commitSel.sha) ?? null}
      state={commitDiffs[commitSel.sha] ?? { data: null, error: null, loading: true }}
      theme={theme}
      mobile={mobile}
      onSelect={(path) => setCommitSel({ sha: commitSel.sha, path })}
      onRetry={() => void loadCommit(commitSel.sha, true)}
      onClose={() => setCommitSel(null)}
    />
  ) : null;

  const diffPane = commitPane ?? (selected ? (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-xs">
        <FileDiff className="size-3.5 text-muted-foreground" />
        <span className="min-w-0 truncate font-mono">{selected.path}</span>
        <ToneBadge tone={selected.staged ? "success" : "muted"}>{selected.staged ? "Staged" : "Working tree"}</ToneBadge>
        {diffLoading ? <Spinner className="ml-auto size-3.5" /> : null}
      </div>
      <div className="min-h-0 flex-1">
        {diffError && !diff ? (
          <EmptyState title="Could not load the diff" className="h-full">
            {diffError}
          </EmptyState>
        ) : diff?.binary ? (
          <EmptyState title="Binary file" className="h-full">
            Binary files are not compared here.
          </EmptyState>
        ) : diff ? (
          <DiffEditor
            original={diff.original}
            modified={diff.modified}
            language={languageFor(diff.path, diff.language)}
            originalModelPath={`diff/original/${selected.staged ? "staged" : "work"}/${selected.path}`}
            modifiedModelPath={`diff/modified/${selected.staged ? "staged" : "work"}/${selected.path}`}
            keepCurrentOriginalModel
            keepCurrentModifiedModel
            theme={theme}
            loading={<Spinner label="Loading editor" />}
            options={{
              readOnly: true,
              originalEditable: false,
              renderSideBySide: !mobile,
              automaticLayout: true,
              minimap: { enabled: false },
              fontSize: 13,
              scrollBeyondLastLine: false,
            }}
          />
        ) : (
          <EmptyState icon={<Spinner />} title="Loading diff…" className="h-full" />
        )}
      </div>
    </div>
  ) : (
    <EmptyState icon={<FileDiff />} title="Select a change" className="h-full">
      Pick a changed file to compare it with the last commit, or a file in a commit to see what that commit changed.
    </EmptyState>
  ));

  return <SplitPane id={`changes-${projectId}-${taskId}`} first={scm} second={diffPane} firstSize="32%" firstMin="240px" className="h-full" />;
}
