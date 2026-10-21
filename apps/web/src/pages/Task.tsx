import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Database,
  ExternalLink,
  FilePen,
  FileText,
  FolderTree,
  GitBranch,
  GitCompareArrows,
  GitPullRequest,
  Globe,
  ListChecks,
  MessageSquare,
  PanelRight,
  Pause,
  Play,
  PlayCircle,
  RotateCcw,
  History,
  Search,
  SendHorizontal,
  ShieldCheck,
  Square,
  SquareTerminal,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type {
  AttachmentRef,
  ControlAction,
  OperatorMessage,
  Run,
  RunEvent,
  TaskComment,
  TaskSession,
  TaskViewResponse,
  TranscriptAuthor,
  TranscriptItem,
  WorkspaceInfo,
} from "@nightshift/core";
import { formatDateTime, formatTime, formatTokens } from "@nightshift/ui";
import { Cost } from "../billing";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { ROUTES, api, isNotFound, messageOf, workspaceApi } from "../api";
import { useAgentStream, type AgentStreamState } from "../agentStream";
import { AttachButton, AttachmentThumbs, UploadTray, useUploads } from "../components/attachments";
import { Markdown } from "../components/Markdown";
import { Notice } from "../components/Notice";
import { ContextMeter, LARGE_CONTEXT, LargeContextHint, NewSessionDialog, SessionsList, contextRatio, useCanStartNew } from "../components/sessions";
import { EmptyState, Page, PhaseBadge, Spinner, StatusPill, TONE_DOT } from "../components/TaskBits";
import { projectHref, useNow } from "../routing";
import { TaskTypeMenu } from "../components/taskTypes";
import { useDebouncedRefresh, useLive } from "../live";
import { ChecksTab, DecisionCards, DecisionCount, OriginBadge, attentionCount, openDecisionsOf, useVerification } from "../components/verification";
import { CONTROLS, EVENT_TONES, isActive } from "../phases";

const FilesTab = lazy(() => import("../workspace/FilesTab"));
const ChangesTab = lazy(() => import("../workspace/ChangesTab"));
const ActionsTab = lazy(() => import("../workspace/ActionsTab"));
const PreviewTab = lazy(() => import("../workspace/PreviewTab"));
const TerminalTab = lazy(() => import("../workspace/TerminalTab"));

const ACTIVE_POLL_MS = 2000;
const FALLBACK_POLL_MS = 5000;
const STICK_PX = 80;

const AUTHOR_LABELS: Record<TranscriptAuthor, string> = {
  task: "Task",
  operator: "You",
  answer: "Answer",
  feedback: "PR feedback",
  system: "Nightshift",
};

const QUESTION_PREFIX = "Question from Nightshift";
const PLAN_PREFIX = "Plan from Nightshift";
const APPROVE_TEXT = "The plan looks good. Go ahead.";

const TOOL_ICONS: Record<string, LucideIcon> = {
  bash: Terminal,
  shell: Terminal,
  read: FileText,
  edit: FilePen,
  write: FilePen,
  grep: Search,
  find: Search,
  glob: Search,
  ls: FolderTree,
  preview: Globe,
  database: Database,
  submit_plan: ListChecks,
};

const toolIcon = (name: string): LucideIcon => TOOL_ICONS[name] ?? TOOL_ICONS[name.split(/[_.:]/)[0] ?? ""] ?? Wrench;

const CONTROL_ICONS: Record<ControlAction, LucideIcon> = { pause: Pause, resume: Play, stop: Square, retry: RotateCcw, complete: CircleCheck };

type Outgoing = {
  key: string;
  text: string;
  attachments: AttachmentRef[];
  state: "sending" | "queued" | "delivered" | "failed";
  error?: string;
  serverId?: string;
};

type TabId = "conversation" | "checks" | "files" | "changes" | "actions" | "terminal" | "preview";

const TABS: Array<{ id: TabId; label: string; short: string; icon: LucideIcon }> = [
  { id: "conversation", label: "Conversation", short: "Chat", icon: MessageSquare },
  { id: "checks", label: "Checks & review", short: "Checks", icon: ShieldCheck },
  { id: "files", label: "Files", short: "Files", icon: FolderTree },
  { id: "changes", label: "Changes", short: "Changes", icon: GitCompareArrows },
  { id: "actions", label: "Actions", short: "Actions", icon: PlayCircle },
  { id: "terminal", label: "Terminal", short: "Terminal", icon: SquareTerminal },
  { id: "preview", label: "Preview & DB", short: "Preview", icon: Globe },
];

const norm = (text: string) => text.replace(/\s+/g, " ").trim();

const stripPrefix = (body: string, prefix: string) => body.slice(prefix.length).replace(/^[\s:.-]+/, "");

function ToolRow({ item }: { item: Extract<TranscriptItem, { kind: "tool" }> }) {
  const Icon = toolIcon(item.name);
  return (
    <Collapsible className={cn("group/tool rounded-md border bg-card text-xs", item.isError && "border-red-500/40")}>
      <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/tool:rotate-90" />
        {item.running ? <Spinner className="size-3.5" /> : item.isError ? <CircleAlert className="size-3.5 shrink-0 text-red-500" /> : <Icon className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className="shrink-0 font-mono font-medium">{item.name}</span>
        <span className="min-w-0 truncate text-muted-foreground">{item.summary}</span>
        {item.running ? <span className="sr-only">running</span> : null}
        {item.isError ? <span className="ml-auto shrink-0 rounded bg-red-500/15 px-1.5 text-red-700 dark:text-red-300">error</span> : null}
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 border-t px-2.5 py-2">
        {item.args ? (
          <div>
            <div className="mb-1 font-medium text-muted-foreground">Input</div>
            <pre className="max-h-64 overflow-auto rounded bg-muted p-2 font-mono whitespace-pre-wrap break-all">{item.args}</pre>
          </div>
        ) : null}
        <div>
          <div className="mb-1 font-medium text-muted-foreground">{item.isError ? "Error" : "Result"}</div>
          {item.result !== null ? (
            <pre className="max-h-80 overflow-auto rounded bg-muted p-2 font-mono whitespace-pre-wrap break-all">{item.result}</pre>
          ) : (
            <div className="text-muted-foreground">{item.running ? "Running…" : "No output"}</div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function Stamp({ at }: { at: string | null }) {
  if (!at) return null;
  return (
    <time className="text-xs text-muted-foreground" dateTime={at} title={formatDateTime(at)}>
      {formatTime(at).slice(0, 5)}
    </time>
  );
}

function MessageHead({ author, children }: { author: string; children?: ReactNode }) {
  return (
    <div className="mb-1 flex items-center gap-2">
      <span className="text-xs font-medium">{author}</span>
      {children}
    </div>
  );
}

function Bubble({ mine, tone, children }: { mine: boolean; tone?: TranscriptAuthor; children: ReactNode }) {
  return (
    <div
      className={cn(
        "rounded-xl px-3.5 py-2.5",
        mine ? "rounded-br-sm bg-primary text-primary-foreground [&_a]:text-primary-foreground" : "rounded-bl-sm border bg-card",
        tone === "system" && "border-dashed bg-muted/50 text-muted-foreground",
        tone === "feedback" && "border-violet-500/30 bg-violet-500/5",
      )}
    >
      {children}
    </div>
  );
}

function TranscriptView({ items }: { items: TranscriptItem[] }) {
  return (
    <>
      {items.map((item) => {
        if (item.kind === "tool") return <ToolRow key={item.id} item={item} />;
        if (item.kind === "assistant")
          return (
            <article key={item.id} className="py-1">
              <MessageHead author="Agent">
                <Stamp at={item.at} />
              </MessageHead>
              <Markdown text={item.text} />
            </article>
          );
        const mine = item.author === "operator";
        return (
          <article key={item.id} className={cn("flex flex-col py-1", mine ? "items-end pl-8 sm:pl-16" : "items-start pr-8 sm:pr-16")}>
            <MessageHead author={AUTHOR_LABELS[item.author] ?? item.author}>
              <Stamp at={item.at} />
            </MessageHead>
            <Bubble mine={mine} tone={item.author}>
              {item.text ? <Markdown text={item.text} /> : null}
              <AttachmentThumbs attachments={item.attachments} />
            </Bubble>
          </article>
        );
      })}
    </>
  );
}

function OutgoingView({ items, onRetry }: { items: Outgoing[]; onRetry: (key: string) => void }) {
  return (
    <>
      {items.map((m) => (
        <article key={m.key} className={cn("flex flex-col items-end py-1 pl-8 sm:pl-16", m.state === "sending" && "opacity-70")}>
          <MessageHead author="You">
            <span className="text-xs text-muted-foreground">
              {m.state === "sending" ? "Sending…" : m.state === "queued" ? "Queued for the agent" : m.state === "delivered" ? "Delivered" : "Not sent"}
            </span>
          </MessageHead>
          <Bubble mine>
            {m.text ? <Markdown text={m.text} /> : null}
            <AttachmentThumbs attachments={m.attachments} />
          </Bubble>
          {m.state === "failed" ? (
            <div className="mt-1 text-xs text-destructive" role="alert">
              {m.error}{" "}
              <button type="button" className="font-medium underline underline-offset-4" onClick={() => onRetry(m.key)}>
                Try again
              </button>
            </div>
          ) : null}
        </article>
      ))}
    </>
  );
}

function LiveBlock({ stream }: { stream: AgentStreamState }) {
  if (!stream.connected || (!stream.text && !stream.thinking && stream.tools.length === 0)) return null;
  return (
    <div className="space-y-2" aria-live="polite">
      {stream.text || stream.thinking ? (
        <article className="py-1">
          <MessageHead author="Agent">
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <span className="size-1.5 animate-pulse rounded-full bg-sky-500" aria-hidden="true" />
              {stream.thinking ? "Thinking…" : "Writing…"}
            </span>
          </MessageHead>
          {stream.text ? <Markdown text={stream.text} /> : null}
        </article>
      ) : null}
      {stream.tools.map((tool) => {
        const Icon = toolIcon(tool.name);
        return (
          <div key={tool.id} className="rounded-md border border-sky-500/30 bg-card text-xs">
            <div className="flex items-center gap-2 px-2.5 py-1.5">
              <Spinner className="size-3.5" />
              <Icon className="size-3.5 text-muted-foreground" />
              <span className="font-mono font-medium">{tool.name}</span>
              <span className="text-muted-foreground">running</span>
            </div>
            {tool.output ? (
              <pre className="max-h-48 overflow-auto border-t bg-zinc-950 p-2 font-mono text-[11px] leading-4 whitespace-pre-wrap break-all text-zinc-100">{tool.output.slice(-6000)}</pre>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** While the run waits on its PR: what the watcher saw at its last check, and when it looks again. */
function WatchStrip({ view }: { view: TaskViewResponse }) {
  const now = useNow(15_000);
  const w = view.prWatch;
  if (!w || !view.run) return null;
  const next = Math.max(0, Math.round((Date.parse(w.nextAt) - now) / 60_000));
  return (
    <div className="flex shrink-0 items-center gap-3 border-t bg-muted/40 px-4 py-2 text-sm" role="status" aria-live="polite">
      <GitPullRequest className={cn("size-4 shrink-0", w.ok ? "text-muted-foreground" : "text-destructive")} />
      <div className="min-w-0 flex-1">
        <div className={cn("truncate", !w.ok && "text-destructive")} title={w.line}>
          {w.line}
        </div>
        <div className="text-xs text-muted-foreground">
          {view.run.paused ? "Paused: not checking" : (
            <>
              Checked <time dateTime={w.checkedAt} title={formatDateTime(w.checkedAt)}>{formatTime(w.checkedAt).slice(0, 5)}</time> · next check {next ? `in about ${next} min` : "soon"}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function NowStrip({ view }: { view: TaskViewResponse }) {
  const { run, live } = view;
  if (run && !isActive(run.phase)) return <WatchStrip view={view} />;
  if (!run) return null;
  const tool = live?.tool;
  const detail = live?.detail ?? run.activity;
  return (
    <div className="flex shrink-0 items-center gap-3 border-t bg-muted/40 px-4 py-2 text-sm" role="status" aria-live="polite">
      <Spinner />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <strong className="shrink-0 font-medium">{run.paused ? "Paused" : live?.busy === false ? "Waiting" : tool ? `Running ${tool}` : run.phase === "reviewing" ? "Reviewing" : "Working"}</strong>
          {detail ? <span className="truncate text-muted-foreground">{detail}</span> : null}
        </div>
        {live?.lastText ? <div className="truncate text-xs text-muted-foreground">{live.lastText}</div> : null}
      </div>
    </div>
  );
}

function Timeline({ events }: { events: RunEvent[] }) {
  if (events.length === 0) return <div className="text-sm text-muted-foreground">No events yet</div>;
  return (
    <ol className="space-y-2" aria-label="Run events">
      {events.map((event) => {
        const tone = EVENT_TONES[event.type] ?? "neutral";
        return (
          <li key={event.id} className="grid grid-cols-[auto_1fr] gap-x-2 text-xs">
            <span className={cn("mt-1.5 size-1.5 rounded-full", TONE_DOT[tone])} aria-hidden="true" />
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-muted-foreground">
                <span className="font-medium text-foreground">{event.type}</span>
                <time dateTime={event.at} title={formatDateTime(event.at)}>
                  {formatTime(event.at)}
                </time>
              </div>
              {event.type === "plan" ? (
                <div className="mt-1 line-clamp-4 whitespace-pre-wrap text-muted-foreground">{event.message}</div>
              ) : (
                <div className="break-words text-muted-foreground">{event.message}</div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Comments({ comments }: { comments: TaskComment[] }) {
  if (comments.length === 0) return <div className="text-sm text-muted-foreground">No comments</div>;
  return (
    <ul className="space-y-3">
      {comments.map((c) => {
        const question = c.body.startsWith(QUESTION_PREFIX);
        const plan = c.body.startsWith(PLAN_PREFIX);
        return (
          <li key={c.id} className={cn("rounded-md border p-3", question && "border-violet-500/40 bg-violet-500/5", plan && "border-sky-500/40 bg-sky-500/5")}>
            <div className="mb-1 flex items-center justify-between gap-2 text-xs">
              <strong className="font-medium">{question ? "Agent question" : plan ? "Agent plan" : c.author}</strong>
              <time className="text-muted-foreground" dateTime={c.createdAt} title={formatDateTime(c.createdAt)}>
                {formatDateTime(c.createdAt)}
              </time>
            </div>
            <Markdown text={question ? stripPrefix(c.body, QUESTION_PREFIX) : plan ? stripPrefix(c.body, PLAN_PREFIX) : c.body} />
          </li>
        );
      })}
    </ul>
  );
}

function DetailSection({ title, count, children, defaultOpen = true }: { title: string; count?: number; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-b last:border-b-0">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset">
        <ChevronRight className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-90")} />
        {title}
        {count !== undefined ? <span className="ml-auto rounded-full bg-muted px-2 text-xs tabular-nums text-muted-foreground">{count}</span> : null}
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 px-4 pb-4">{children}</CollapsibleContent>
    </Collapsible>
  );
}

function PlanCard({ plan, awaiting }: { plan: { text: string; at: string }; awaiting: boolean }) {
  return (
    <Card className={cn("gap-2 py-3", awaiting ? "ring-violet-500/50" : "ring-sky-500/30")}>
      <CardHeader className="px-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <ListChecks className="size-4 text-sky-600 dark:text-sky-400" />
          Plan
          {awaiting ? <span className="ml-auto rounded bg-violet-500/15 px-1.5 text-xs font-medium text-violet-700 dark:text-violet-300">Waiting for approval</span> : null}
        </CardTitle>
        <div className="text-xs text-muted-foreground">{formatDateTime(plan.at)}</div>
      </CardHeader>
      <CardContent className="max-h-96 overflow-auto px-3">
        <Markdown text={plan.text} />
      </CardContent>
    </Card>
  );
}

function RunControls({ run, onDone }: { run: Run; onDone: () => Promise<void> }) {
  const [pending, setPending] = useState<ControlAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDone, setConfirmDone] = useState(false);
  const [reason, setReason] = useState("");
  const control = async (action: ControlAction) => {
    setPending(action);
    setError(null);
    try {
      await api.control(run.id, action, action === "complete" ? reason.trim() : undefined);
      if (action === "complete") setReason("");
      await onDone();
    } catch (err) {
      setError(`Could not ${action}: ${messageOf(err)}`);
    } finally {
      setPending(null);
    }
  };
  const shown = CONTROLS.filter((c) => c.enabled(run));
  if (shown.length === 0 && !error) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Run controls">
      {shown.map((c) => {
        const Icon = CONTROL_ICONS[c.action];
        return (
          <Button
            key={c.action}
            size="sm"
            variant={c.danger ? "destructive" : "outline"}
            disabled={pending !== null}
            aria-busy={pending === c.action}
            onClick={() => (c.action === "complete" ? setConfirmDone(true) : void control(c.action))}
          >
            {pending === c.action ? <Spinner className="size-3" /> : <Icon />}
            {c.label}
          </Button>
        );
      })}
      {error ? (
        <span className="text-xs text-destructive" role="alert">
          {error}
        </span>
      ) : null}
      <AlertDialog open={confirmDone} onOpenChange={setConfirmDone}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark this task as done?</AlertDialogTitle>
            <AlertDialogDescription>
              Use this when the task is finished or no longer needs Nightshift, for example it was fixed elsewhere or is blocked by something outside this branch. The agent and its testers
              stop, open decisions close, and the task moves to Done. The pull request stays open and is no longer watched; merge or close it on GitHub yourself.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-1.5">
            <label htmlFor={`done-reason-${run.id}`} className="text-sm font-medium">
              Why (optional)
            </label>
            <Textarea
              id={`done-reason-${run.id}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. The CI failure comes from main and is fixed in PR #1300"
              rows={3}
            />
            <p className="text-xs text-muted-foreground">Posted as a comment on the task.</p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void control("complete")}>Mark as done</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Composer({
  view,
  awaitingApproval,
  readOnly,
  onSend,
}: {
  view: TaskViewResponse;
  awaitingApproval: boolean;
  readOnly?: boolean;
  onSend: (text: string, attachments: AttachmentRef[]) => void;
}) {
  const uploads = useUploads();
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const allowed = view.canMessage.allowed && !readOnly;
  const canSend = allowed && !uploads.uploading && (text.trim().length > 0 || uploads.attachments.length > 0);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!canSend) return;
    onSend(text.trim(), uploads.attachments);
    setText("");
    uploads.clear();
    ref.current?.focus();
  };

  return (
    <form className="shrink-0 border-t bg-background px-3 pt-2 pb-3 sm:px-4" onSubmit={submit} {...uploads.dropProps}>
      {awaitingApproval && allowed ? (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-violet-500/40 bg-violet-500/10 px-3 py-2 text-sm text-violet-900 dark:text-violet-100" id="composer-hint">
          <ListChecks className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 font-medium">Approve the plan or ask for changes</span>
          <Button type="button" size="sm" onClick={() => onSend(APPROVE_TEXT, [])}>
            Approve plan
          </Button>
        </div>
      ) : (
        <div id="composer-hint" className={cn("mb-1.5 text-xs", allowed ? "text-muted-foreground" : "text-amber-700 dark:text-amber-300")}>
          {readOnly ? "You are viewing an older session. Go back to the current session to write to the agent." : view.canMessage.effect}
        </div>
      )}
      <div
        className={cn(
          "rounded-xl border bg-card shadow-xs focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
          uploads.dragging && "border-dashed border-primary",
          !allowed && "opacity-70",
        )}
      >
        <div className="px-3 pt-2">
          <UploadTray uploads={uploads} />
        </div>
        <label htmlFor="composer-input" className="sr-only">
          Message to the agent
        </label>
        <Textarea
          ref={ref}
          id="composer-input"
          rows={1}
          value={text}
          disabled={!allowed}
          aria-describedby="composer-hint composer-keys"
          placeholder={readOnly ? "Read-only: older session" : !allowed ? "Messaging is not available right now" : awaitingApproval ? "Approve, or describe what to change in the plan…" : "Write to the agent…"}
          className="max-h-48 min-h-11 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
          onChange={(e) => setText(e.target.value)}
          onPaste={uploads.onPaste}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="flex items-center gap-2 px-2 pb-2">
          {allowed ? <AttachButton uploads={uploads} compact /> : null}
          <span id="composer-keys" className="hidden text-xs text-muted-foreground sm:inline">
            Enter to send · Shift+Enter for a new line
          </span>
          <Button type="submit" size="sm" className="ml-auto" disabled={!canSend}>
            {uploads.uploading ? "Uploading…" : "Send"}
            <SendHorizontal />
          </Button>
        </div>
      </div>
      {uploads.dragging ? <div className="mt-1 text-center text-xs text-muted-foreground">Drop pictures to attach</div> : null}
    </form>
  );
}

function Details({
  view,
  plan,
  awaitingApproval,
  sessions,
}: {
  view: TaskViewResponse;
  plan: { text: string; at: string } | null;
  awaitingApproval: boolean;
  sessions: ReactNode;
}) {
  const { task, run } = view;
  const events = [...view.events].sort((a, b) => a.id - b.id);
  const questions = view.comments.filter((c) => c.body.startsWith(QUESTION_PREFIX)).length;
  return (
    <div>
      {plan ? (
        <div className="border-b p-3">
          <PlanCard plan={plan} awaiting={awaitingApproval} />
        </div>
      ) : null}
      {sessions}
      <DetailSection title="Description">
        {task.body ? <Markdown text={task.body} /> : <div className="text-sm text-muted-foreground">No description</div>}
        {task.acceptanceCriteria?.length ? (
          <>
            <div className="text-xs font-medium text-muted-foreground">Acceptance criteria</div>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {task.acceptanceCriteria.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </>
        ) : null}
        {view.attachments.length > 0 ? (
          <>
            <div className="text-xs font-medium text-muted-foreground">Attachments</div>
            <AttachmentThumbs attachments={view.attachments} size="sm" />
          </>
        ) : null}
      </DetailSection>
      <DetailSection title={questions > 0 ? "Comments and questions" : "Comments"} count={view.comments.length}>
        <Comments comments={view.comments} />
      </DetailSection>
      {view.runs.length > 1 ? (
        <DetailSection title="Runs" count={view.runs.length} defaultOpen={false}>
          <ul className="space-y-2 text-sm">
            {view.runs.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2">
                <PhaseBadge phase={r.phase} />
                <span className="text-xs text-muted-foreground">{formatDateTime(r.createdAt)}</span>
                {r.prUrl ? (
                  <a href={r.prUrl} target="_blank" rel="noopener noreferrer" className="text-xs underline underline-offset-4">
                    PR
                  </a>
                ) : null}
                {r.id === run?.id ? <span className="text-xs text-muted-foreground">current</span> : null}
              </li>
            ))}
          </ul>
        </DetailSection>
      ) : null}
      <DetailSection title="Events" count={events.length} defaultOpen={false}>
        <Timeline events={events} />
      </DetailSection>
    </div>
  );
}

function TabFallback() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner label="Loading" />
    </div>
  );
}

let outgoingSeq = 0;

export function TaskPage({ projectId, taskId }: { projectId: string; taskId: string }) {
  const { connection, refreshProjects } = useLive();
  const mobile = useIsMobile();
  const [view, setView] = useState<TaskViewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [outgoing, setOutgoing] = useState<Outgoing[]>([]);
  const [detailsOpen, setDetailsOpen] = useState(() => window.matchMedia?.("(min-width: 1180px)").matches ?? true);
  const [tab, setTab] = useState<TabId>("conversation");
  const [visited, setVisited] = useState<Set<TabId>>(() => new Set(["conversation"]));
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const loadSeq = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const forceBottom = useRef(true);
  const ws = useMemo(() => workspaceApi(projectId, taskId), [projectId, taskId]);
  const verification = useVerification(projectId, taskId);

  const load = useCallback(async () => {
    const mine = ++loadSeq.current;
    try {
      const res = await api.task(projectId, taskId, sessionId);
      if (mine !== loadSeq.current) return;
      setView(res);
      setError(null);
      setNotFound(false);
    } catch (err) {
      if (mine !== loadSeq.current) return;
      setNotFound(isNotFound(err));
      setError(messageOf(err));
    }
  }, [projectId, taskId, sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const runActive = view?.run ? isActive(view.run.phase) : false;
  const runId = view?.run?.id ?? null;

  const stream = useAgentStream(ROUTES.stream(projectId, taskId), runActive, () => void load());

  useEffect(() => {
    const ms = runActive && !stream.connected ? ACTIVE_POLL_MS : connection === "live" ? 0 : FALLBACK_POLL_MS;
    if (!ms) return;
    const timer = window.setInterval(() => void load(), ms);
    return () => window.clearInterval(timer);
  }, [runActive, stream.connected, connection, load]);

  useDebouncedRefresh(
    (event) =>
      (event.type === "task" && event.projectId === projectId && event.taskId === taskId) ||
      (event.type === "run" && event.run.projectId === projectId && event.run.taskId === taskId) ||
      (event.type === "event" && runId !== null && event.event.runId === runId),
    () => void load(),
  );

  const transcriptLength = view?.transcript.length ?? 0;
  const lastItem = view?.transcript[transcriptLength - 1];
  const lastSignature = lastItem ? `${lastItem.id}:${lastItem.kind === "tool" ? `${lastItem.running}${lastItem.result?.length ?? 0}` : lastItem.text.length}` : "";
  const streamSignature = `${stream.text.length}:${stream.tools.map((t) => t.output.length).join(",")}`;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (forceBottom.current || atBottom.current) {
      el.scrollTop = el.scrollHeight;
      if (view) forceBottom.current = false;
    }
  }, [view, transcriptLength, lastSignature, outgoing.length, streamSignature, tab]);

  const selectTab = (next: string) => {
    const id = next as TabId;
    setTab(id);
    setVisited((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    if (id === "conversation") forceBottom.current = atBottom.current;
  };

  const sessionList = view?.sessions ?? [];
  const activeSession = sessionList.find((s) => s.active) ?? null;
  const viewingOld = sessionId !== null && sessionId !== activeSession?.id;
  const viewedSession = viewingOld ? (sessionList.find((s) => s.id === sessionId) ?? null) : activeSession;
  const switching = view !== null && view.session !== null && (sessionId ?? activeSession?.id ?? view.session) !== view.session;
  const canStart = useCanStartNew(projectId, taskId, `${runId}:${view?.run?.phase ?? ""}:${sessionList.map((s) => `${s.id}${s.active ? "*" : ""}`).join(",")}`);
  const largeContext = (contextRatio(activeSession) ?? 0) > LARGE_CONTEXT && canStart?.allowed !== false;

  const selectSession = (s: TaskSession) => {
    forceBottom.current = true;
    setSessionId(s.active ? null : s.id);
    if (mobile) setDetailsOpen(false);
  };

  const onWorkspace = useCallback((next: WorkspaceInfo) => setView((v) => (v ? { ...v, workspace: next } : v)), []);

  const transcript = view?.transcript ?? [];
  const userItems = transcript.filter(
    (i): i is Extract<TranscriptItem, { kind: "user" }> =>
      i.kind === "user" && (i.author === "operator" || i.author === "answer" || (i.messageIds?.length ?? 0) > 0),
  );
  const deliveredIds = new Set(userItems.flatMap((i) => i.messageIds ?? []));
  const byIds = userItems.some((i) => i.messageIds !== undefined);
  const operatorTexts = new Set(userItems.map((i) => norm(i.text)));
  const inTranscript = (id: string | undefined, text: string) => (byIds ? id !== undefined && deliveredIds.has(id) : operatorTexts.has(norm(text)));
  const serverMessages = view?.messages ?? [];
  const serverIds = new Set(serverMessages.map((m) => m.id));
  const recentlyDelivered = (m: OperatorMessage) =>
    m.delivered && m.deliveredAt !== null && m.runId === view?.run?.id && Date.now() - Date.parse(m.deliveredAt) < 120_000;
  const fromServer: Outgoing[] = serverMessages
    .filter((m: OperatorMessage) => (!m.delivered || recentlyDelivered(m)) && !inTranscript(m.id, m.text))
    .map((m) => ({ key: `s-${m.id}`, text: m.text, attachments: m.attachments, state: m.delivered ? "delivered" : "queued", serverId: m.id }));
  const pendingLocal = outgoing.filter((m) => !(m.serverId && (serverIds.has(m.serverId) || inTranscript(m.serverId, m.text))));
  const shownOutgoing = [...fromServer, ...pendingLocal];

  const send = async (key: string, text: string, attachments: AttachmentRef[]) => {
    try {
      const res = await api.sendMessage(projectId, taskId, { text, attachmentIds: attachments.map((a) => a.id) });
      setOutgoing((prev) => prev.map((m) => (m.key === key ? { ...m, state: res.message.delivered ? "delivered" : "queued", serverId: res.message.id } : m)));
      void load();
      void refreshProjects();
    } catch (err) {
      setOutgoing((prev) => prev.map((m) => (m.key === key ? { ...m, state: "failed", error: messageOf(err) } : m)));
    }
  };

  const onSend = (text: string, attachments: AttachmentRef[]) => {
    const key = `o${++outgoingSeq}`;
    forceBottom.current = true;
    setOutgoing((prev) => [...prev, { key, text, attachments, state: "sending" }]);
    void send(key, text, attachments);
  };

  const onRetry = (key: string) => {
    const item = outgoing.find((m) => m.key === key);
    if (!item) return;
    setOutgoing((prev) => prev.map((m) => (m.key === key ? { ...m, state: "sending", error: undefined } : m)));
    void send(key, item.text, item.attachments);
  };

  if (!view) {
    return (
      <Page>
        <a className="text-sm text-muted-foreground hover:text-foreground" href={projectHref(projectId)}>
          ← Project
        </a>
        {notFound ? (
          <Notice tone="warning" title="Task not found">
            No task <code>{taskId}</code> in this project.
          </Notice>
        ) : error ? (
          <Notice tone="danger" title="Could not load task">
            {error}
          </Notice>
        ) : (
          <div className="space-y-3">
            <Skeleton className="h-7 w-2/3" />
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-96 w-full" />
          </div>
        )}
      </Page>
    );
  }

  const { task, run, project } = view;
  const workspace = view.workspace;
  const planEvents = view.events.filter((e) => e.type === "plan").sort((a, b) => b.id - a.id);
  const planComment = [...view.comments].reverse().find((c) => c.body.startsWith(PLAN_PREFIX));
  const latestAgentComment = [...view.comments].reverse().find((c) => c.authorIsAgent);
  const plan = planEvents[0]
    ? { text: planEvents[0].message, at: planEvents[0].at }
    : planComment
      ? { text: stripPrefix(planComment.body, PLAN_PREFIX), at: planComment.createdAt }
      : null;
  const awaitingApproval = run?.phase === "needs_info" && Boolean(latestAgentComment?.body.startsWith(PLAN_PREFIX));
  const previewUrl = workspace?.preview.status === "running" ? workspace.preview.url : null;
  const runningServices = (workspace?.preview.services ?? []).filter((s) => s.status === "running" && s.url);
  const decisions = verification.data ? verification.data.decisions : [];
  const decisionCount = verification.data ? openDecisionsOf(verification.data).length : (view.openDecisions ?? 0);
  const checksBadge = verification.data ? attentionCount(verification.data) : decisionCount;

  const chat = (
    <section className="flex h-full min-h-0 flex-col" aria-label="Agent conversation">
      {viewingOld ? (
        <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b bg-sky-500/10 px-4 py-2 text-sm" role="status">
          {switching ? <Spinner className="size-3.5" /> : <History className="size-4 shrink-0 text-sky-700 dark:text-sky-300" />}
          <span className="font-medium">Viewing {viewedSession?.label ?? "an older session"} (read-only)</span>
          <span className="text-muted-foreground">·</span>
          <button type="button" className="font-medium underline underline-offset-4 hover:text-foreground" onClick={() => setSessionId(null)}>
            Back to current session
          </button>
        </div>
      ) : null}
      {!viewingOld && decisionCount > 0 && verification.data ? (
        <div className="max-h-[50%] shrink-0 overflow-y-auto border-b bg-violet-500/[0.03] px-3 py-3 sm:px-6">
          <DecisionCards
            className="mx-auto max-w-3xl"
            projectId={projectId}
            taskId={taskId}
            decisions={decisions}
            onAnswered={() => {
              void verification.load();
              void load();
              void refreshProjects();
            }}
          />
        </div>
      ) : null}
      <div
        ref={scroller}
        className={cn("min-h-0 flex-1 overflow-y-auto", switching && "opacity-60")}
        tabIndex={0}
        aria-label="Conversation"
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
        }}
      >
        <div className="mx-auto max-w-3xl space-y-3 px-3 py-4 sm:px-6">
          {run?.error ? (
            <Notice tone="danger" title="Run error">
              <pre className="font-mono text-xs whitespace-pre-wrap">{run.error}</pre>
            </Notice>
          ) : null}
          {awaitingApproval && plan && !viewingOld ? <PlanCard plan={plan} awaiting /> : null}
          {viewingOld && view.transcript.length === 0 && !switching ? <EmptyState icon={<History />} title="Nothing in this session">This session has no messages.</EmptyState> : null}
          {!viewingOld && view.transcript.length === 0 && shownOutgoing.length === 0 ? (
            <EmptyState icon={<MessageSquare />} title={run ? "The agent has not said anything yet" : "No agent on this task yet"}>
              {run ? "Messages and tool calls show up here as the agent works." : task.status === "ready_for_ai" ? "An agent picks this task up when a slot is free." : "This task has no run."}
            </EmptyState>
          ) : null}
          <TranscriptView items={view.transcript} />
          {viewingOld ? null : (
            <>
              <LiveBlock stream={stream} />
              <OutgoingView items={shownOutgoing} onRetry={onRetry} />
            </>
          )}
        </div>
      </div>
      {viewingOld ? null : <NowStrip view={view} />}
      {largeContext && !viewingOld ? <LargeContextHint className="mx-3 mt-2 sm:mx-4" onNew={() => setNewSessionOpen(true)} /> : null}
      <Composer view={view} awaitingApproval={awaitingApproval && !viewingOld} readOnly={viewingOld} onSend={onSend} />
    </section>
  );

  const sessionsSection =
    sessionList.length > 0 || run ? (
      <DetailSection title="Sessions" count={sessionList.length}>
        <SessionsList sessions={sessionList} viewingId={viewingOld ? sessionId : (activeSession?.id ?? null)} canStart={canStart} onSelect={selectSession} onNew={() => setNewSessionOpen(true)} />
      </DetailSection>
    ) : null;

  const details = <Details view={view} plan={plan} awaitingApproval={awaitingApproval} sessions={sessionsSection} />;

  const wsProps = workspace ? { projectId, taskId, ws, workspace, active: false, onWorkspace } : null;

  const workspaceTab = (id: Exclude<TabId, "conversation" | "checks">, node: (props: NonNullable<typeof wsProps>) => ReactNode) => (
    <TabsContent key={id} value={id} forceMount className="mt-0 min-h-0 flex-1 data-[state=inactive]:hidden">
      {visited.has(id) ? (
        wsProps ? (
          <Suspense fallback={<TabFallback />}>{node({ ...wsProps, active: tab === id })}</Suspense>
        ) : (
          <EmptyState title="Workspace info unavailable" className="h-full">
            The daemon did not return workspace details for this task.
          </EmptyState>
        )
      ) : null}
    </TabsContent>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 space-y-2 border-b px-4 pt-3 pb-2 sm:px-6">
        <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
          <h1 className="min-w-0 flex-1 basis-64 text-lg leading-snug font-semibold">{task.title || task.id}</h1>
          <div className="flex flex-wrap items-center gap-1.5">
            {runningServices.length > 1 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline">
                    <Globe /> Open preview <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-72">
                  <DropdownMenuLabel>Services</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {runningServices.map((s) => (
                    <DropdownMenuItem key={s.name} asChild>
                      <a href={s.url ?? undefined} target="_blank" rel="noopener noreferrer" className="grid gap-0.5">
                        <span className="flex items-center gap-2 font-medium">
                          {s.name}
                          {s.primary ? <span className="text-xs font-normal text-muted-foreground">main</span> : null}
                          <ExternalLink className="ml-auto size-3.5 text-muted-foreground" />
                        </span>
                        <span className="truncate font-mono text-xs text-muted-foreground">{s.url}</span>
                      </a>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (runningServices[0]?.url ?? previewUrl) ? (
              <Button asChild size="sm" variant="outline">
                <a href={runningServices[0]?.url ?? previewUrl ?? undefined} target="_blank" rel="noopener noreferrer">
                  <Globe /> Open preview
                </a>
              </Button>
            ) : null}
            {run ? <RunControls run={run} onDone={load} /> : null}
            {tab === "conversation" ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="icon-sm" variant={detailsOpen ? "secondary" : "ghost"} aria-pressed={detailsOpen} aria-label="Task details" onClick={() => setDetailsOpen((v) => !v)}>
                    <PanelRight />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{detailsOpen ? "Hide details" : "Show details"}</TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <StatusPill status={task.status} />
          <TaskTypeMenu projectId={projectId} taskId={taskId} type={view.type} runActive={runActive} onChanged={(type) => setView((v) => (v ? { ...v, type } : v))} />
          {run && (run.phase !== task.status || run.paused) ? <PhaseBadge phase={run.phase} paused={run.paused} /> : null}
          {decisionCount > 0 ? (
            <button type="button" className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50" onClick={() => selectTab("checks")}>
              <DecisionCount count={decisionCount} className="hover:bg-violet-500/25" />
            </button>
          ) : null}
          <OriginBadge origin={view.origin} />
          <span className="font-mono">{task.id}</span>
          {run?.branch ? (
            <span className="max-w-64 truncate font-mono" title={`Branch ${run.branch}`}>
              {run.branch}
            </span>
          ) : null}
          {view.baseBranch ? (
            <span className="inline-flex max-w-56 items-center gap-1 font-mono" title={`Base branch ${view.baseBranch}`}>
              <GitBranch className="size-3.5 shrink-0" />
              <span className="truncate">base: {view.baseBranch}</span>
            </span>
          ) : null}
          {run?.prUrl ? (
            <a className="inline-flex items-center gap-1 hover:text-foreground" href={run.prUrl} target="_blank" rel="noopener noreferrer">
              <GitPullRequest className="size-3.5" />
              PR {run.prNumber ? `#${run.prNumber}` : ""}
            </a>
          ) : null}
          {run ? (
            <span title={`${formatTokens(run.usage.inputTokens)} in · ${formatTokens(run.usage.outputTokens)} out · ${run.model}`}>
              <Cost usd={run.usage.costUsd} model={run.model} /> · <span className="font-mono">{run.model}</span>
            </span>
          ) : null}
          {activeSession ? (
            <button
              type="button"
              className="rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              title={`${activeSession.label} context${activeSession.contextTokens !== null && activeSession.contextWindow ? `: ${activeSession.contextTokens.toLocaleString()} of ${activeSession.contextWindow.toLocaleString()} tokens` : " size unknown"}`}
              onClick={() => {
                selectTab("conversation");
                setDetailsOpen(true);
              }}
            >
              <ContextMeter session={activeSession} compact />
            </button>
          ) : null}
          {task.url ? (
            <a className="inline-flex items-center gap-1 hover:text-foreground" href={task.url} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="size-3.5" /> Open in source
            </a>
          ) : null}
          {project.planMode && project.planMode !== "off" ? <span>{project.planMode === "approve" ? "Plan mode: approval" : "Plan mode: on"}</span> : null}
        </div>
        {error ? <div className="text-xs text-amber-700 dark:text-amber-300">Showing last known state: {error}</div> : null}
      </header>
      <Tabs value={tab} onValueChange={selectTab} className="min-h-0 flex-1 gap-0">
        <div className="shrink-0 overflow-x-auto border-b px-2 sm:px-4">
          <TabsList variant="line" className="h-10 w-max">
            {TABS.map((t) => (
              <TabsTrigger key={t.id} value={t.id} className="px-2.5">
                <t.icon />
                <span className="sm:hidden">{t.short}</span>
                <span className="hidden sm:inline">{t.label}</span>
                {t.id === "checks" && checksBadge > 0 ? (
                  <span
                    className={cn(
                      "ml-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums",
                      decisionCount > 0 ? "bg-violet-600 text-white" : "bg-amber-500/20 text-amber-800 dark:text-amber-200",
                    )}
                    aria-label={`${checksBadge} open`}
                  >
                    {checksBadge}
                  </span>
                ) : null}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="conversation" forceMount className="mt-0 min-h-0 flex-1 data-[state=inactive]:hidden">
          {mobile ? (
            <>
              {chat}
              <Sheet open={detailsOpen} onOpenChange={setDetailsOpen}>
                <SheetContent side="right" className="w-[90vw] gap-0 p-0 sm:max-w-md">
                  <SheetHeader className="border-b">
                    <SheetTitle>Details</SheetTitle>
                    <SheetDescription className="sr-only">Sessions, task description, plan, comments and events</SheetDescription>
                  </SheetHeader>
                  <ScrollArea className="min-h-0 flex-1">{details}</ScrollArea>
                </SheetContent>
              </Sheet>
            </>
          ) : (
            <ResizablePanelGroup id={`task-${projectId}-${taskId}`} orientation="horizontal" className="h-full">
              <ResizablePanel id="chat" minSize="360px" className="min-w-0">
                {chat}
              </ResizablePanel>
              {detailsOpen ? (
                <>
                  <ResizableHandle withHandle />
                  <ResizablePanel id="details" defaultSize="32%" minSize="260px" maxSize="55%" className="min-w-0">
                    <aside id="task-details" aria-label="Task details" className="h-full bg-sidebar/30">
                      <ScrollArea className="h-full">{details}</ScrollArea>
                    </aside>
                  </ResizablePanel>
                </>
              ) : null}
            </ResizablePanelGroup>
          )}
        </TabsContent>
        <TabsContent value="checks" forceMount className="mt-0 min-h-0 flex-1 data-[state=inactive]:hidden">
          {visited.has("checks") ? <ChecksTab projectId={projectId} taskId={taskId} verification={verification} /> : null}
        </TabsContent>
        {workspaceTab("files", (p) => <FilesTab {...p} />)}
        {workspaceTab("changes", (p) => <ChangesTab {...p} />)}
        {workspaceTab("actions", (p) => <ActionsTab {...p} />)}
        {workspaceTab("terminal", (p) => <TerminalTab {...p} />)}
        {workspaceTab("preview", (p) => <PreviewTab {...p} />)}
      </Tabs>
      <NewSessionDialog
        projectId={projectId}
        taskId={taskId}
        open={newSessionOpen}
        onOpenChange={setNewSessionOpen}
        onDone={() => {
          forceBottom.current = true;
          setSessionId(null);
          void load();
          void refreshProjects();
        }}
      />
    </div>
  );
}
