import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Container, Copy, Database, ExternalLink, Eye, EyeOff, Globe, Laptop, MonitorSmartphone, Package, Play, Plus, QrCode, RefreshCw, RotateCcw, Share2, Smartphone, Sparkles, Square, SquareTerminal, Trash2, Unplug } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import type { DatabaseInfo, DeviceMode, PreviewDetectResponse, PreviewDiagnosis, PreviewFix, PreviewInfo, PreviewServiceInfo, PreviewTarget, WorkspaceInfo } from "@nightshift/core";
import type { Tone } from "@nightshift/ui";
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
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { api, messageOf } from "../api";
import { useLive } from "../live";
import type { CheckConfig, DatabaseConfig, PreviewConfig, Project } from "@nightshift/core";
import { Notice } from "../components/Notice";
import { Dot, Spinner, ToneBadge } from "../components/TaskBits";
import { taskHref } from "../routing";
import { NoWorkspace, copyText, useWorkspaceRefresh, type WorkspaceTabProps } from "./common";
import { HintLine, ProblemPanel, hasProblem } from "./PreviewProblem";
import { DetectingPanel, SetupPanel, suggestionServices } from "./PreviewSetup";
import { LocalFilesCard, LocalFilesHintCard, useLocalFilesHint } from "./LocalFilesCard";
import { EnvButton } from "./ServiceEnv";

const LOG_POLL_MS = 3000;

const PREVIEW_TONE: Record<PreviewInfo["status"], Tone> = { stopped: "muted", starting: "warning", running: "success", failed: "danger" };
const DB_TONE: Record<DatabaseInfo["status"], Tone> = { none: "muted", creating: "warning", ready: "success", failed: "danger" };
const DB_MODE: Record<DatabaseInfo["mode"], string> = { none: "None", docker: "Docker Postgres", existing: "Existing Postgres server" };

const TARGET: Record<PreviewTarget, { label: string; icon: ReactNode }> = {
  machine: { label: "This machine", icon: <Laptop className="size-3" /> },
  container: { label: "Container", icon: <Container className="size-3" /> },
  device: { label: "Device", icon: <Smartphone className="size-3" /> },
};

const DEVICE: Record<DeviceMode, string> = { lan: "Wi-Fi link", "expo-go": "Expo Go", "ios-simulator": "iOS Simulator", "android-emulator": "Android emulator" };

const targetLabel = (p: PreviewInfo) => {
  const t = TARGET[p.target ?? "machine"];
  return p.target === "device" && p.deviceMode ? `${t.label} · ${DEVICE[p.deviceMode]}` : t.label;
};

type DeviceView = Pick<PreviewInfo, "target" | "deviceMode" | "status" | "deviceUrl" | "lanUrl">;

function DevicePanel({ preview }: { preview: DeviceView }) {
  const link = preview.deviceUrl ?? preview.lanUrl;
  if (preview.target !== "device" && !link) return null;
  if (preview.deviceMode === "ios-simulator" || preview.deviceMode === "android-emulator") {
    return (
      <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3 text-sm">
        <MonitorSmartphone className="size-5 shrink-0 text-muted-foreground" />
        <span>Opens in the {preview.deviceMode === "ios-simulator" ? "simulator" : "emulator"} on this Mac{preview.status === "running" ? "" : " when the preview starts"}.</span>
      </div>
    );
  }
  if (!link) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
        <Smartphone className="size-5 shrink-0" />
        Start the preview to get a QR code for your {preview.deviceMode === "expo-go" ? "phone" : "device"}.
      </div>
    );
  }
  const expo = preview.deviceMode === "expo-go" || link.startsWith("exp://");
  return (
    <div className="flex flex-col items-center gap-4 rounded-lg border bg-muted/30 p-4 sm:flex-row sm:items-start">
      <div className="shrink-0 rounded-lg bg-white p-2">
        <QRCodeSVG value={link} size={148} level="M" bgColor="#ffffff" fgColor="#000000" title={`QR code for ${link}`} />
      </div>
      <div className="grid min-w-0 gap-2 text-center sm:text-left">
        <div className="font-medium">{expo ? "Scan with Expo Go" : "Scan with your phone's camera"}</div>
        <p className="text-xs text-muted-foreground">{expo ? "Open Expo Go on a phone on the same Wi-Fi and scan this code." : "Your phone must be on the same Wi-Fi as this computer."}</p>
        <div className="flex min-w-0 items-center justify-center gap-1 sm:justify-start">
          <code className="min-w-0 truncate font-mono text-xs" title={link}>
            {link}
          </code>
          <CopyButton value={link} label="Copy device link" />
        </div>
      </div>
    </div>
  );
}

type ContainerPorts = Record<string, number | null>;

const containerPorts = (config: PreviewConfig | undefined): ContainerPorts => {
  const out: ContainerPorts = {};
  if (!config || config.target === "device") return out;
  for (const s of config.services ?? []) if ((s.target ?? (config.target === "container" ? "container" : "machine")) === "container") out[s.name] = s.containerPort ?? null;
  return out;
};

const singleContainerPort = (config: PreviewConfig | undefined, containers: ContainerPorts) => {
  const first = config?.services?.[0];
  if (first) return containers[first.name] ?? null;
  return config?.target === "container" ? (config.containerPort ?? null) : null;
};

function ContainerBadge({ port, className }: { port: number | null; className?: string }) {
  return (
    <ToneBadge tone="neutral" title={port ? `Runs in a Docker container and listens on port ${port} inside it. Nightshift maps it to the port of this task.` : "Runs in a Docker container."} className={className}>
      <Container className="size-3" aria-hidden="true" />
      container{port ? <span className="font-mono">:{port}</span> : null}
    </ToneBadge>
  );
}

const maskUrl = (url: string) => url.replace(/\/\/([^:/@]+):([^@]+)@/, (_m, user: string) => `//${user}:••••••••@`);

function CopyButton({ value, label }: { value: string; label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          onClick={async () => {
            if (await copyText(value)) toast.success("Copied to clipboard");
            else toast.error("Could not copy");
          }}
        >
          <Copy />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] items-center gap-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function ConfirmAction({
  title,
  description,
  confirm,
  onConfirm,
  children,
}: {
  title: string;
  description: string;
  confirm: string;
  onConfirm: () => void;
  children: (open: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {children(() => setOpen(true))}
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>{description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onConfirm}>
              {confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

const VIEWPORT = "[data-slot=scroll-area-viewport]";
const PREFIX = /^\[([^\]]+)\] /;

function LogLines({ log, prefixed }: { log: string; prefixed: boolean }) {
  if (!prefixed) return <>{log}</>;
  return (
    <>
      {log.split("\n").map((line, i) => {
        const m = PREFIX.exec(line);
        return (
          <span key={i} className="block min-h-5">
            {m ? <span className="text-sky-300/80">[{m[1]}] </span> : null}
            {m ? line.slice(m[0].length) : line}
          </span>
        );
      })}
    </>
  );
}

function LogView({ log, logError, label, header, prefixed = false }: { log: string | null; logError: string | null; label: string; header?: ReactNode; prefixed?: boolean }) {
  const anchor = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = anchor.current?.closest<HTMLElement>(VIEWPORT);
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  useLayoutEffect(() => {
    const el = anchor.current?.closest<HTMLElement>(VIEWPORT);
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [log]);
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-100 shadow-xs">
      {header ? <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-xs text-zinc-400">{header}</div> : null}
      <ScrollArea className="h-64">
        <pre className="p-3 font-mono text-xs leading-5 whitespace-pre-wrap break-all focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring" tabIndex={0} aria-label={label}>
          {logError && log === null ? logError : log === null ? "Loading…" : log ? <LogLines log={log} prefixed={prefixed} /> : <span className="text-zinc-500">No output yet.</span>}
        </pre>
        <div ref={anchor} />
      </ScrollArea>
    </div>
  );
}

function ConsoleHeader({ service }: { service: PreviewServiceInfo | null }) {
  if (!service) {
    return (
      <>
        <span className="font-medium text-zinc-200">All apps</span>
        <span>Each line starts with the app's name</span>
      </>
    );
  }
  const tone = PREVIEW_TONE[service.status];
  return (
    <>
      <Dot tone={tone} pulse={service.status === "starting"} className="size-1.5" />
      <span className="font-medium text-zinc-200">{service.name}</span>
      {service.shared ? <span className="text-violet-300/90">{service.external ? "shared · outside Nightshift" : "shared"}</span> : null}
      <span>{service.status}</span>
      {service.port ? <span>· port {service.port}</span> : null}
      {service.command ? (
        <code className="ml-auto min-w-0 max-w-full truncate font-mono text-zinc-500" title={service.command}>
          $ {service.command}
        </code>
      ) : null}
    </>
  );
}

type PreviewAction = "start" | "stop" | "restart";

const isLive = (status: PreviewInfo["status"]) => status === "running" || status === "starting";

type Fixer = {
  diagnose: (service?: string) => Promise<void>;
  applyFix: (fix: PreviewFix, service?: string) => Promise<void>;
  askAgent: (prompt: string) => Promise<void>;
};

function ActionButton({ label, icon, busy, disabled, onClick }: { label: string; icon: ReactNode; busy: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} disabled={disabled} onClick={onClick}>
          {busy ? <Spinner className="size-3" /> : icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function LinkLine({ url, name, status }: { url: string; name: string; status: PreviewInfo["status"] }) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className={cn("min-w-0 truncate font-mono text-xs underline-offset-4 hover:underline", status !== "running" && "text-muted-foreground")}
        aria-disabled={status !== "running"}
      >
        {url}
      </a>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button asChild variant="ghost" size="icon-sm">
            <a href={url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${name} in a new tab`}>
              <ExternalLink />
            </a>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Open in a new tab</TooltipContent>
      </Tooltip>
      <CopyButton value={url} label={`Copy ${name} link`} />
    </div>
  );
}

/** The app's port; while it runs (and speaks HTTP) a click opens it on 127.0.0.1 in a new tab, like the link. */
function PortLink({ port, status, web = true }: { port: number; status: PreviewInfo["status"]; web?: boolean }) {
  const code = <code className="font-mono text-foreground">{port}</code>;
  if (!web || status !== "running") return code;
  return (
    <a href={`http://127.0.0.1:${port}`} target="_blank" rel="noopener noreferrer" title={`Open http://127.0.0.1:${port} in a new tab`} className="underline-offset-4 hover:underline">
      {code}
    </a>
  );
}

const INTERACTIVE = "a,button,summary,details,section,input,[role=tab]";

function ServiceRow({
  service,
  preview,
  busy,
  selected,
  consoleId,
  onSelect,
  onAction,
  fixer,
  container,
  projectId,
  taskId,
}: {
  container: { port: number | null } | null;
  projectId: string;
  taskId: string;
  service: PreviewServiceInfo;
  preview: PreviewInfo;
  busy: string | null;
  selected: boolean;
  consoleId: string;
  onSelect: () => void;
  onAction: (a: PreviewAction, service: string) => void;
  fixer: Fixer;
}) {
  const [qr, setQr] = useState(false);
  const live = isLive(service.status);
  const tone = PREVIEW_TONE[service.status];
  const key = (a: PreviewAction) => busy === `${a}:${service.name}`;
  const device = { target: preview.target, deviceMode: preview.deviceMode, status: service.status, deviceUrl: service.deviceUrl, lanUrl: service.lanUrl };
  const hasDevice = Boolean(service.deviceUrl || service.lanUrl);
  return (
    <li
      className={cn(
        "grid cursor-pointer gap-2 rounded-lg border p-3 transition-colors",
        selected ? "border-primary/50 bg-primary/[0.03] ring-1 ring-primary/20 dark:bg-primary/[0.07]" : "hover:bg-muted/40",
        service.status === "failed" && !selected && "border-red-500/30",
      )}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
        if (window.getSelection()?.toString()) return;
        onSelect();
      }}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Dot tone={tone} pulse={service.status === "starting"} className="size-2" />
        <span className="font-medium">{service.name}</span>
        {service.primary ? (
          <ToneBadge tone="info" title="The main app. The task's preview link points here.">
            main
          </ToneBadge>
        ) : null}
        {container ? <ContainerBadge port={container.port} /> : null}
        {service.cwd ? (
          <code className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={service.cwd}>
            {service.cwd}
          </code>
        ) : null}
        <span className="sr-only">Status: {service.status}</span>
        <div className="ml-auto flex items-center gap-0.5">
          <span className={cn("mr-1 text-xs", service.status === "failed" ? "text-red-600 dark:text-red-400" : "text-muted-foreground")} aria-hidden="true">
            {service.status}
          </span>
          <Button
            variant={selected ? "secondary" : "ghost"}
            size="sm"
            className="h-8 px-2"
            aria-pressed={selected}
            aria-controls={consoleId}
            aria-label={`Show ${service.name} console`}
            onClick={onSelect}
          >
            <SquareTerminal />
            <span className="hidden sm:inline">Console</span>
          </Button>
          <EnvButton projectId={projectId} taskId={taskId} service={service.name} label={service.name} onRestart={() => onAction("restart", service.name)} />
          {hasDevice ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant={qr ? "secondary" : "ghost"} size="icon-sm" aria-label={`${qr ? "Hide" : "Show"} device QR code for ${service.name}`} aria-pressed={qr} onClick={() => setQr((v) => !v)}>
                  <QrCode />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{qr ? "Hide QR code" : "Show QR code"}</TooltipContent>
            </Tooltip>
          ) : null}
          <ActionButton label={`Start ${service.name}`} icon={<Play />} busy={key("start")} disabled={busy !== null || live || preview.installing} onClick={() => onAction("start", service.name)} />
          <ActionButton label={`Restart ${service.name}`} icon={<RotateCcw />} busy={key("restart")} disabled={busy !== null || !live} onClick={() => onAction("restart", service.name)} />
          <ActionButton label={`Stop ${service.name}`} icon={<Square />} busy={key("stop")} disabled={busy !== null || !live} onClick={() => onAction("stop", service.name)} />
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        {service.url ? (
          <LinkLine url={service.url} name={service.name} status={service.status} />
        ) : (
          <span className="text-xs text-muted-foreground">{service.status === "starting" ? "Starting…" : service.status === "failed" ? "Not running" : "Stopped"}</span>
        )}
        {service.port ? (
          <span className="text-xs text-muted-foreground">
            port <PortLink port={service.port} status={service.status} />
          </span>
        ) : null}
      </div>
      <code className="block truncate font-mono text-xs text-muted-foreground" title={service.command}>
        $ {service.command}
      </code>
      {service.hint ? <HintLine hint={service.hint} /> : null}
      {hasProblem(service) ? (
        <ProblemPanel
          service={service}
          label={service.name}
          install={preview.install}
          onDiagnose={() => fixer.diagnose(service.name)}
          onApplyFix={(fix) => fixer.applyFix(fix, service.name)}
          onAskAgent={fixer.askAgent}
        />
      ) : null}
      {qr && hasDevice ? <DevicePanel preview={device} /> : null}
    </li>
  );
}

type SharedCheck = "http" | "tcp";

const sharedChecks = (config: PreviewConfig | undefined): Record<string, SharedCheck> =>
  Object.fromEntries((config?.services ?? []).filter((s) => s.shared).map((s) => [s.name, s.check ?? "http"]));

const taskList = (ids: string[]) => (ids.length <= 3 ? ids.join(", ") : `${ids.slice(0, 3).join(", ")} and ${ids.length - 3} more`);

function UsedBy({ projectId, taskId, usedBy }: { projectId: string; taskId: string; usedBy: string[] }) {
  if (!usedBy.length) return <span className="text-xs text-muted-foreground">Not used by any task right now</span>;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      <span className="mr-0.5 text-xs text-muted-foreground">Used by</span>
      <ul className="contents">
        {usedBy.map((id) => (
          <li key={id} className="contents">
            {id === taskId ? (
              <span className="inline-flex h-5 items-center rounded-md border border-primary/30 bg-primary/5 px-1.5 font-mono text-[0.6875rem]" title="This task">
                {id}
                <span className="ml-1 font-sans text-muted-foreground">this task</span>
              </span>
            ) : (
              <a
                href={taskHref(projectId, id)}
                className="inline-flex h-5 items-center rounded-md border bg-background px-1.5 font-mono text-[0.6875rem] transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                aria-label={`Task ${id}`}
              >
                {id}
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SharedServiceRow({
  service,
  projectId,
  taskId,
  check,
  install,
  busy,
  selected,
  consoleId,
  onSelect,
  onAction,
  fixer,
}: {
  service: PreviewServiceInfo;
  projectId: string;
  taskId: string;
  check: SharedCheck;
  install: string | null;
  busy: string | null;
  selected: boolean;
  consoleId: string;
  onSelect: () => void;
  onAction: (a: PreviewAction, service: string) => void;
  fixer: Fixer;
}) {
  const [confirm, setConfirm] = useState<PreviewAction | null>(null);
  const live = isLive(service.status);
  const tone = PREVIEW_TONE[service.status];
  const key = (a: PreviewAction) => busy === `${a}:${service.name}`;
  const others = service.usedBy.filter((id) => id !== taskId);
  const run = (a: PreviewAction) => (a !== "start" && others.length ? setConfirm(a) : onAction(a, service.name));
  const link = check === "http" && service.url;
  return (
    <>
      <li
        className={cn(
          "grid cursor-pointer gap-2 rounded-lg border border-violet-500/25 bg-violet-500/[0.025] p-3 transition-colors dark:bg-violet-500/[0.05]",
          selected ? "border-primary/50 ring-1 ring-primary/20" : "hover:bg-violet-500/[0.06] dark:hover:bg-violet-500/[0.09]",
          service.status === "failed" && !selected && "border-red-500/30",
        )}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
          if (window.getSelection()?.toString()) return;
          onSelect();
        }}
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Dot tone={tone} pulse={service.status === "starting"} className="size-2" />
          <span className="font-medium">{service.name}</span>
          <ToneBadge tone="accent" title="One copy for the whole project, used by every task's preview and the agent">
            <Share2 className="size-3" aria-hidden="true" />
            shared
          </ToneBadge>
          {service.external ? (
            <ToneBadge tone="neutral" title="Already running outside Nightshift. Nightshift does not start or stop it, it only checks that it answers.">
              <Unplug className="size-3" aria-hidden="true" />
              external
            </ToneBadge>
          ) : null}
          <span className="sr-only">Status: {service.status}</span>
          <div className="ml-auto flex items-center gap-0.5">
            <span className={cn("mr-1 text-xs", service.status === "failed" ? "text-red-600 dark:text-red-400" : "text-muted-foreground")} aria-hidden="true">
              {service.status}
            </span>
            <Button
              variant={selected ? "secondary" : "ghost"}
              size="sm"
              className="h-8 px-2"
              aria-pressed={selected}
              aria-controls={consoleId}
              aria-label={`Show ${service.name} console`}
              onClick={onSelect}
            >
              <SquareTerminal />
              <span className="hidden sm:inline">Console</span>
            </Button>
            {service.external ? null : <EnvButton projectId={projectId} taskId={taskId} service={service.name} label={service.name} onRestart={() => run("restart")} />}
            {service.external ? null : (
              <>
                <ActionButton label={`Start ${service.name} for the project`} icon={<Play />} busy={key("start")} disabled={busy !== null || live} onClick={() => run("start")} />
                <ActionButton label={`Restart ${service.name} for the project`} icon={<RotateCcw />} busy={key("restart")} disabled={busy !== null || !live} onClick={() => run("restart")} />
                <ActionButton label={`Stop ${service.name} for the project`} icon={<Square />} busy={key("stop")} disabled={busy !== null || !live} onClick={() => run("stop")} />
              </>
            )}
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          {link ? (
            <LinkLine url={link} name={service.name} status={service.status} />
          ) : check === "tcp" && service.port ? (
            <span className="text-xs text-muted-foreground" title="Nightshift checks that the port accepts connections">
            {service.status === "running" ? "Accepting connections" : service.status === "starting" ? "Starting…" : "Not reachable"} <span aria-hidden="true">·</span> TCP check
          </span>
          ) : (
            <span className="text-xs text-muted-foreground">{service.status === "starting" ? "Starting…" : service.status === "failed" ? "Not running" : "Stopped"}</span>
          )}
          {service.port ? (
            <span className="text-xs text-muted-foreground">
              port <PortLink port={service.port} status={service.status} web={check === "http"} />
            </span>
          ) : null}
        </div>
        <UsedBy projectId={projectId} taskId={taskId} usedBy={service.usedBy} />
        {service.external ? (
          <p className="text-xs text-muted-foreground">Runs outside Nightshift. Every task points at it.</p>
        ) : service.command ? (
          <code className="block truncate font-mono text-xs text-muted-foreground" title={service.command}>
            $ {service.command}
          </code>
        ) : null}
        {service.hint ? <HintLine hint={service.hint} /> : null}
        {hasProblem(service) ? (
          <ProblemPanel
            service={service}
            label={service.name}
            install={install}
            onDiagnose={() => fixer.diagnose(service.name)}
            onApplyFix={(fix) => fixer.applyFix(fix, service.name)}
            onAskAgent={fixer.askAgent}
          />
        ) : null}
      </li>
        <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {confirm === "restart" ? "Restart" : "Stop"} {service.name} for every task?
              </AlertDialogTitle>
              <AlertDialogDescription>
                This affects every task using it. {taskList(others)} {others.length === 1 ? "uses" : "use"} {service.name} too, and{" "}
                {confirm === "restart" ? "their previews lose it while it restarts." : "their previews lose it until it starts again."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant={confirm === "stop" ? "destructive" : "default"}
                onClick={() => {
                  if (confirm) onAction(confirm, service.name);
                  setConfirm(null);
                }}
              >
                {confirm === "restart" ? "Restart for every task" : "Stop for every task"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
    </>
  );
}

const ALL = "__all";

function MultiPreview({
  preview,
  busy,
  onAction,
  log,
  logError,
  logService,
  onLogService,
  fixer,
  containers,
  checks,
  projectId,
  taskId,
}: {
  containers: ContainerPorts;
  checks: Record<string, SharedCheck>;
  projectId: string;
  taskId: string;
  preview: PreviewInfo;
  busy: string | null;
  onAction: (a: PreviewAction, service?: string) => void;
  log: string | null;
  logError: string | null;
  logService: string | null;
  onLogService: (service: string | null) => void;
  fixer: Fixer;
}) {
  const services = preview.services;
  const apps = services.filter((s) => !s.shared);
  const shared = services.filter((s) => s.shared);
  const anyLive = preview.installing || apps.some((s) => isLive(s.status));
  const allLive = apps.every((s) => isLive(s.status));
  const anyStarted = apps.some((s) => s.startedAt);
  const sharedHeading = useId();
  const allBusy = (a: PreviewAction) => busy === `${a}:all`;
  const consoleId = useId();
  const selected = services.find((s) => s.name === logService) ?? null;
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {preview.url && preview.status === "running" ? (
          <Button asChild size="sm">
            <a href={preview.url} target="_blank" rel="noopener noreferrer">
              <Globe /> Open preview
            </a>
          </Button>
        ) : null}
        <Button size="sm" variant="outline" disabled={busy !== null || allLive} onClick={() => onAction("start")}>
          {allBusy("start") ? <Spinner className="size-3" /> : <Play />} Start all
        </Button>
        <Button size="sm" variant="outline" disabled={busy !== null || !anyLive} onClick={() => onAction("restart")}>
          {allBusy("restart") ? <Spinner className="size-3" /> : <RotateCcw />} Restart all
        </Button>
        <Button size="sm" variant="outline" disabled={busy !== null || !anyLive} onClick={() => onAction("stop")}>
          {allBusy("stop") ? <Spinner className="size-3" /> : <Square />} Stop all
        </Button>
      </div>
      {preview.install || preview.installing ? (
        <p className="flex items-center gap-2 text-sm" role="status">
          {preview.installing ? (
            <>
              <Spinner className="size-3" /> Installing dependencies…
            </>
          ) : (
            <>
              <Package className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 text-muted-foreground">
                <code className="font-mono text-xs text-foreground">{preview.install}</code> {anyStarted ? "ran before the apps started" : "runs once before the apps start"}
              </span>
            </>
          )}
        </p>
      ) : null}
      <section className="grid gap-2" aria-labelledby={shared.length ? `${sharedHeading}-apps` : undefined} aria-label={shared.length ? undefined : "Apps"}>
        {shared.length ? (
          <h3 id={`${sharedHeading}-apps`} className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Laptop className="size-3.5" aria-hidden="true" /> This task's apps
          </h3>
        ) : null}
        <ul className="grid gap-2">
          {apps.map((s) => (
            <ServiceRow
              key={s.name}
              service={s}
              preview={preview}
              busy={busy}
              selected={s.name === logService}
              consoleId={consoleId}
              onSelect={() => onLogService(s.name)}
              onAction={onAction}
              fixer={fixer}
              container={s.name in containers && (preview.target !== "container" || containers[s.name] !== null) ? { port: containers[s.name] } : null}
              projectId={projectId}
              taskId={taskId}
            />
          ))}
        </ul>
      </section>
      {shared.length ? (
        <section aria-labelledby={sharedHeading} className="grid gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <h3 id={sharedHeading} className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Share2 className="size-3.5 text-violet-600 dark:text-violet-400" aria-hidden="true" /> Shared services
            </h3>
            <span className="text-xs text-muted-foreground">One copy for the whole project. Starting this task's preview starts them.</span>
          </div>
          <ul className="grid gap-2">
            {shared.map((s) => (
              <SharedServiceRow
                key={s.name}
                service={s}
                projectId={projectId}
                taskId={taskId}
                check={checks[s.name] ?? (s.url ? "http" : "tcp")}
                install={preview.install}
                busy={busy}
                selected={s.name === logService}
                consoleId={consoleId}
                onSelect={() => onLogService(s.name)}
                onAction={onAction}
                fixer={fixer}
              />
            ))}
          </ul>
        </section>
      ) : null}
      <Tabs id={consoleId} value={selected?.name ?? ALL} onValueChange={(v) => onLogService(v === ALL ? null : v)} className="gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-1.5 text-sm font-medium">
            <SquareTerminal className="size-4 text-muted-foreground" aria-hidden="true" /> Console
          </h3>
          <div className="-mx-1 max-w-full overflow-x-auto px-1">
            <TabsList aria-label="Show the console of">
              <TabsTrigger value={ALL} className="px-2.5">
                All
              </TabsTrigger>
              {services.map((s) => (
                <TabsTrigger key={s.name} value={s.name} className="px-2.5">
                  <Dot tone={PREVIEW_TONE[s.status]} pulse={s.status === "starting"} className="size-1.5" />
                  {s.name}
                  {s.shared ? <Share2 className="size-3 text-violet-600 dark:text-violet-400" aria-hidden="true" /> : null}
                  <span className="sr-only">, {s.shared ? "shared, " : ""}{s.status}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        </div>
        {[ALL, ...services.map((s) => s.name)].map((v) => (
          <TabsContent key={v} value={v}>
            <LogView log={log} logError={logError} label={v === ALL ? "Console output of all apps" : `Console output of ${v}`} header={<ConsoleHeader service={selected} />} prefixed={v === ALL} />
          </TabsContent>
        ))}
      </Tabs>
    </>
  );
}

function SinglePreview({
  preview,
  service,
  busy,
  onAction,
  log,
  logError,
  fixer,
  containerPort,
  projectId,
  taskId,
}: {
  containerPort: number | null;
  projectId: string;
  taskId: string;
  preview: PreviewInfo;
  service: PreviewServiceInfo;
  busy: string | null;
  onAction: (a: PreviewAction) => void;
  log: string | null;
  logError: string | null;
  fixer: Fixer;
}) {
  const live = isLive(preview.status);
  const problem = hasProblem(service);
  return (
    <>
      <dl className="grid gap-2">
        <Row label="Link">
          {preview.url ? <LinkLine url={preview.url} name="preview" status={preview.status} /> : <span className="text-muted-foreground">{preview.status === "starting" ? "Starting…" : "Not running"}</span>}
        </Row>
        {preview.port ? (
          <Row label="Port">
            <span className="text-xs">
              <PortLink port={preview.port} status={preview.status} />
            </span>
          </Row>
        ) : null}
        {containerPort ? (
          <Row label="Runs in">
            <ContainerBadge port={containerPort} />
          </Row>
        ) : null}
        {preview.command ? (
          <Row label="Command">
            <code className="block truncate font-mono text-xs" title={preview.command}>
              {preview.command}
            </code>
          </Row>
        ) : null}
        {preview.startedAt ? (
          <Row label="Started">
            <time dateTime={preview.startedAt} title={formatDateTime(preview.startedAt)}>
              {formatRelative(preview.startedAt)}
            </time>
          </Row>
        ) : null}
      </dl>
      {service.hint ? <HintLine hint={service.hint} /> : null}
      <div className="flex flex-wrap gap-2">
        {preview.url && preview.status === "running" ? (
          <Button asChild size="sm">
            <a href={preview.url} target="_blank" rel="noopener noreferrer">
              <Globe /> Open preview
            </a>
          </Button>
        ) : null}
        <Button size="sm" variant="outline" disabled={busy !== null || live} onClick={() => onAction("start")}>
          {busy === "start" ? <Spinner className="size-3" /> : <Play />} Start
        </Button>
        <Button size="sm" variant="outline" disabled={busy !== null || !live} onClick={() => onAction("restart")}>
          {busy === "restart" ? <Spinner className="size-3" /> : <RotateCcw />} Restart
        </Button>
        <Button size="sm" variant="outline" disabled={busy !== null || !live} onClick={() => onAction("stop")}>
          {busy === "stop" ? <Spinner className="size-3" /> : <Square />} Stop
        </Button>
        <EnvButton projectId={projectId} taskId={taskId} label="The preview" onRestart={() => onAction("restart")} />
      </div>
      {problem ? (
        <ProblemPanel service={service} label="The preview" install={preview.install} onDiagnose={() => fixer.diagnose()} onApplyFix={(fix) => fixer.applyFix(fix)} onAskAgent={fixer.askAgent} />
      ) : preview.error ? (
        <Notice tone="danger" title="Preview failed">
          {preview.error}
        </Notice>
      ) : null}
      <DevicePanel preview={preview} />
      <section className="space-y-2" aria-label="Console">
        <h3 className="flex items-center gap-1.5 text-sm font-medium">
          <SquareTerminal className="size-4 text-muted-foreground" aria-hidden="true" /> Console
        </h3>
        <LogView log={log} logError={logError} label="Console output of the preview" header={<ConsoleHeader service={service} />} />
      </section>
    </>
  );
}

const singleService = (preview: PreviewInfo): PreviewServiceInfo =>
  preview.services[0] ?? {
    name: "app",
    primary: true,
    status: preview.status,
    url: preview.url,
    port: preview.port,
    lanUrl: preview.lanUrl,
    deviceUrl: preview.deviceUrl,
    command: preview.command ?? "",
    cwd: null,
    error: preview.error,
    startedAt: preview.startedAt,
    hint: null,
    diagnosis: null,
    diagnosing: false,
    shared: false,
    external: false,
    usedBy: [],
  };

const withLocalDiagnoses = (preview: PreviewInfo, local: Record<string, PreviewDiagnosis>): PreviewInfo => {
  const services = (preview.services ?? []).map((s) => {
    const l = local[s.name];
    const fresher = l && l.startedAt === s.startedAt && (!s.diagnosis || Date.parse(l.at) > Date.parse(s.diagnosis.at));
    return {
      ...s,
      hint: s.hint ?? null,
      diagnosing: Boolean(s.diagnosing),
      diagnosis: fresher ? l : (s.diagnosis ?? null),
    };
  });
  return { ...preview, services };
};

function DatabaseCard({ db, busy, onAction, className }: { db: DatabaseInfo; busy: string | null; onAction: (a: "create" | "reset" | "drop") => void; className?: string }) {
  const [reveal, setReveal] = useState(false);
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Database className="size-4" /> Database
        </CardTitle>
        <CardDescription>{DB_MODE[db.mode]}</CardDescription>
        <CardAction>
          <ToneBadge tone={DB_TONE[db.status]}>
            <Dot tone={DB_TONE[db.status]} pulse={db.status === "creating"} className="size-1.5" />
            {db.status}
          </ToneBadge>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        {!db.configured ? (
          <p className="text-sm text-muted-foreground">This project has no database. Pick Docker Postgres or an existing server under Database when you create a project.</p>
        ) : (
          <>
            <dl className="grid gap-2">
              <Row label="Database">{db.name ? <code className="font-mono text-xs">{db.name}</code> : <span className="text-muted-foreground">Not created</span>}</Row>
              {db.envVar ? (
                <Row label="Env variable">
                  <code className="font-mono text-xs">{db.envVar}</code>
                </Row>
              ) : null}
              <Row label="Connection">
                {db.url ? (
                  <div className="flex min-w-0 items-center gap-1">
                    <code className="min-w-0 truncate font-mono text-xs" title={reveal ? db.url : undefined}>
                      {reveal ? db.url : maskUrl(db.url)}
                    </code>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={reveal ? "Hide password" : "Show password"} aria-pressed={reveal} onClick={() => setReveal((v) => !v)}>
                          {reveal ? <EyeOff /> : <Eye />}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{reveal ? "Hide password" : "Show password"}</TooltipContent>
                    </Tooltip>
                    <CopyButton value={db.url} label="Copy connection URL" />
                  </div>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </Row>
              <Row label="Last seeded">
                {db.seededAt ? (
                  <time dateTime={db.seededAt} title={formatDateTime(db.seededAt)}>
                    {formatRelative(db.seededAt)}
                  </time>
                ) : (
                  <span className="text-muted-foreground">Never</span>
                )}
              </Row>
            </dl>
            {db.error ? <Notice tone="danger" title="Database error">{db.error}</Notice> : null}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={busy !== null || db.status === "ready" || db.status === "creating"} onClick={() => onAction("create")}>
                {busy === "create" ? <Spinner className="size-3" /> : <Plus />} Create
              </Button>
              <ConfirmAction
                title="Reset the database?"
                description="All data in this worktree's database is deleted, then the setup command migrates and seeds it again."
                confirm="Reset database"
                onConfirm={() => onAction("reset")}
              >
                {(open) => (
                  <Button size="sm" variant="outline" disabled={busy !== null || db.status === "none" || db.status === "creating"} onClick={open}>
                    {busy === "reset" ? <Spinner className="size-3" /> : <RefreshCw />} Reset
                  </Button>
                )}
              </ConfirmAction>
              <ConfirmAction
                title="Drop the database?"
                description="The database and all of its data are deleted. You can create a fresh one afterwards."
                confirm="Drop database"
                onConfirm={() => onAction("drop")}
              >
                {(open) => (
                  <Button size="sm" variant="destructive" disabled={busy !== null || db.status === "none"} onClick={open}>
                    {busy === "drop" ? <Spinner className="size-3" /> : <Trash2 />} Drop
                  </Button>
                )}
              </ConfirmAction>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

type Suggestions = {
  missing: { preview: PreviewConfig | null; database: DatabaseConfig | null; checks: CheckConfig[]; setup: string | null };
  inspection: { kind: string; frameworks: string[]; packageManager: string | null };
};

const hasExtras = (m: Suggestions["missing"]) => Boolean((m.database && m.database.mode !== "none") || m.checks.length || m.setup);

const currentProject = async (projectId: string): Promise<Project> => {
  const current: Project | undefined = (await api.projects()).projects.find((x) => x.id === projectId);
  if (!current) throw new Error("Project not found");
  return current;
};

function DetectedCard({ projectId, data, onApplied }: { projectId: string; data: Suggestions; onApplied: () => void }) {
  const [saving, setSaving] = useState(false);
  const m = data.missing;
  const apply = async () => {
    setSaving(true);
    try {
      const current = await currentProject(projectId);
      await api.updateProject(projectId, {
        ...(m.database ? { database: m.database } : {}),
        ...(m.checks.length ? { checks: [...current.checks, ...m.checks] } : {}),
        ...(m.setup ? { repo: { setup: m.setup } } : {}),
      });
      toast.success("Project settings updated", { description: "New tasks use them now." });
      onApplied();
    } catch (err) {
      toast.error("Could not update the project", { description: messageOf(err) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card className="border-primary/40">
      <CardHeader>
        <CardTitle>Detected in this task's workspace</CardTitle>
        <CardDescription>
          The agent's work looks like a {data.inspection.kind} project{data.inspection.frameworks.length ? ` (${data.inspection.frameworks.join(", ")})` : ""}
          {data.inspection.packageManager ? ` using ${data.inspection.packageManager}` : ""}. The project is missing these settings:
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {m.database && m.database.mode !== "none" ? (
          <p>
            Database: Docker Postgres{"setup" in m.database && m.database.setup ? <> · seed with <code className="font-mono text-xs">{m.database.setup}</code></> : null}
          </p>
        ) : null}
        {m.setup ? (
          <p>
            Setup: <code className="font-mono text-xs">{m.setup}</code>
          </p>
        ) : null}
        {m.checks.length ? (
          <p>
            Checks:{" "}
            {m.checks.map((c) => (
              <code key={c.name} className="mr-2 font-mono text-xs">
                {c.command}
              </code>
            ))}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button size="sm" onClick={() => void apply()} disabled={saving}>
            {saving ? <Spinner /> : null} Use these settings
          </Button>
          <Button size="sm" variant="ghost" asChild>
            <a href={`#/projects/${encodeURIComponent(projectId)}/settings`}>Edit in project settings</a>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

type DetectState = { state: "idle" } | { state: "loading" } | { state: "done"; result: PreviewDetectResponse } | { state: "error"; error: string };

const dismissKey = (projectId: string) => `nightshift.previewSuggestion.dismissed.${projectId}`;

const readDismissed = (projectId: string) => {
  try {
    return window.localStorage.getItem(dismissKey(projectId));
  } catch {
    return null;
  }
};

const writeDismissed = (projectId: string, sig: string) => {
  try {
    window.localStorage.setItem(dismissKey(projectId), sig);
  } catch {
    return;
  }
};

const appsLabel = (n: number) => `${n} app${n === 1 ? "" : "s"}`;

export default function PreviewTab({ projectId, taskId, ws, workspace, active, onWorkspace }: WorkspaceTabProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [logService, setLogService] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestions | null>(null);
  const [detect, setDetect] = useState<DetectState>({ state: "idle" });
  const [applying, setApplying] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(() => readDismissed(projectId));
  const [local, setLocal] = useState<Record<string, PreviewDiagnosis>>({});
  const { projects } = useLive();
  const project = projects?.find((p) => p.id === projectId);
  const projectPreview = project?.preview;
  const localHint = useLocalFilesHint(projectId, workspace.localFiles ?? null, active && workspace.exists);
  const containers = containerPorts(projectPreview);
  const detectAbort = useRef<AbortController | null>(null);
  const preview = withLocalDiagnoses(workspace.preview, local);
  const services = preview.services;
  const apps = services.filter((s) => !s.shared);
  const sharedCount = services.length - apps.length;
  const multi = services.length > 1;
  const selectedLog = multi && logService && services.some((s) => s.name === logService) ? logService : null;

  const loadLog = useCallback(async () => {
    if (!workspace.exists || !workspace.preview.configured) return;
    try {
      setLog((await ws.previewLogs(selectedLog ?? undefined)).log);
      setLogError(null);
    } catch (err) {
      setLogError(messageOf(err));
    }
  }, [ws, workspace.exists, workspace.preview.configured, selectedLog]);

  const loadSuggestions = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/workspace/suggestions`);
      const body = (await res.json()) as Suggestions & { error?: string };
      if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
      setSuggestions(body);
    } catch {
      setSuggestions(null);
    }
  }, [projectId, taskId]);

  const refresh = useCallback(() => {
    void ws
      .info()
      .then(onWorkspace)
      .catch(() => undefined);
    void loadLog();
  }, [ws, onWorkspace, loadLog]);

  useEffect(() => {
    if (active) void loadLog();
  }, [active, loadLog]);

  useEffect(() => {
    if (workspace.exists) void loadSuggestions();
  }, [workspace.exists, loadSuggestions]);

  useEffect(() => () => detectAbort.current?.abort(), []);

  useWorkspaceRefresh(projectId, taskId, active, refresh);

  const settling = preview.status === "starting" || preview.installing === true || services.some((s) => s.status === "starting" || s.diagnosing);
  const polling = active && (isLive(preview.status) || settling || services.some((s) => isLive(s.status)));
  useEffect(() => {
    if (!polling) return;
    const timer = window.setInterval(() => {
      void loadLog();
      if (settling) refresh();
    }, LOG_POLL_MS);
    return () => window.clearInterval(timer);
  }, [polling, loadLog, refresh, settling]);

  const act = async (key: string, fn: () => Promise<WorkspaceInfo>, done: string) => {
    setBusy(key);
    try {
      onWorkspace(await fn());
      toast.success(done);
      void loadLog();
    } catch (err) {
      toast.error("Action failed", { description: messageOf(err) });
    } finally {
      setBusy(null);
    }
  };

  const fixer: Fixer = {
    diagnose: async (service) => {
      try {
        const d = await ws.previewDiagnose(service);
        setLocal((m) => ({ ...m, [d.service || service || singleService(preview).name]: d }));
        refresh();
      } catch (err) {
        toast.error("Could not diagnose", { description: messageOf(err) });
        throw err;
      }
    },
    applyFix: async (fix, service) => {
      try {
        onWorkspace(await ws.previewFix(fix, service));
        setLocal((m) => {
          const next = { ...m };
          delete next[service ?? singleService(preview).name];
          return next;
        });
        toast.success("Fix saved", { description: `${service ?? "The preview"} is restarting with the new settings.` });
        void loadLog();
      } catch (err) {
        toast.error("Could not apply the fix", { description: messageOf(err) });
        throw err;
      }
    },
    askAgent: async (prompt) => {
      try {
        const res = await api.sendMessage(projectId, taskId, { text: prompt });
        toast.success("Sent to the agent", { description: res.effect });
      } catch (err) {
        toast.error("Could not message the agent", { description: messageOf(err) });
        throw err;
      }
    },
  };

  const runDetect = async () => {
    detectAbort.current?.abort();
    const ctrl = new AbortController();
    detectAbort.current = ctrl;
    setDetect({ state: "loading" });
    try {
      const result = await ws.previewDetect(ctrl.signal);
      if (!ctrl.signal.aborted) setDetect({ state: "done", result });
    } catch (err) {
      if (!ctrl.signal.aborted) setDetect({ state: "error", error: messageOf(err) });
    }
  };

  const cancelDetect = () => {
    detectAbort.current?.abort();
    detectAbort.current = null;
    setDetect({ state: "idle" });
  };

  const applyPreview = async (next: PreviewConfig) => {
    setApplying(true);
    try {
      const current = await currentProject(projectId);
      const keep = current.preview
        ? {
            ...(current.preview.target ? { target: current.preview.target } : {}),
            ...(current.preview.container ? { container: current.preview.container } : {}),
            ...(current.preview.device ? { device: current.preview.device } : {}),
          }
        : {};
      await api.updateProject(projectId, { preview: { ...next, ...keep } });
      const n = suggestionServices(next).length;
      toast.success("Preview updated", { description: n > 1 ? `${appsLabel(n)} set up. Start them below.` : "Start it below." });
      setDetect({ state: "idle" });
      setLog(null);
      refresh();
      void loadSuggestions();
    } catch (err) {
      toast.error("Could not update the preview", { description: messageOf(err) });
    } finally {
      setApplying(false);
    }
  };

  if (!workspace.exists) return <NoWorkspace />;

  const rule = suggestions?.missing.preview ?? null;
  const ruleApps = suggestionServices(rule).length;
  const ruleSig = rule ? JSON.stringify(rule) : "";
  const showRule = Boolean(rule) && detect.state === "idle" && dismissed !== ruleSig && (!preview.configured || (ruleApps > 1 && !multi));

  const setup =
    detect.state === "loading" ? (
      <DetectingPanel onCancel={cancelDetect} />
    ) : detect.state === "error" ? (
      <Notice
        tone="danger"
        title="AI could not read the workspace"
        action={
          <div className="flex gap-1">
            <Button size="sm" variant="outline" onClick={() => void runDetect()}>
              Try again
            </Button>
            <Button size="sm" variant="ghost" onClick={cancelDetect}>
              Close
            </Button>
          </div>
        }
      >
        {detect.error}
      </Notice>
    ) : detect.state === "done" ? (
      (() => {
        const { suggestion, notes, source } = detect.result;
        const n = suggestionServices(suggestion).length;
        return (
          <SetupPanel
            source="ai"
            title={!suggestion ? "Nothing to change" : source === "ai" ? "AI suggestion" : "Suggested setup"}
            description={
              !suggestion
                ? "AI did not find a better preview setup for this workspace."
                : `${n > 1 ? `${appsLabel(n)}, each with its own dev server, link and console.` : "One dev server for this workspace."}${source === "rules" ? " AI was not available, so this comes from the built-in checks." : ""}`
            }
            suggestion={suggestion}
            notes={notes}
            current={preview}
            primary="Use this setup"
            secondary={suggestion ? "Discard" : "Close"}
            applying={applying}
            onApply={() => suggestion && void applyPreview(suggestion)}
            onDismiss={() => setDetect({ state: "idle" })}
          />
        );
      })()
    ) : showRule && rule ? (
      <SetupPanel
        source="rules"
        title={ruleApps > 1 ? `This workspace has ${appsLabel(ruleApps)}` : "Found a dev server command"}
        description={
          ruleApps > 1
            ? preview.configured
              ? <>The preview runs one command{preview.command ? <> (<code className="font-mono text-xs">{preview.command}</code>)</> : null}. Give each app its own dev server, link and console instead.</>
              : "Set them up so each app gets its own dev server, link and console."
            : "This project has no preview yet."
        }
        suggestion={rule}
        notes={[]}
        current={preview}
        primary={ruleApps > 1 ? `Use these ${ruleApps} apps` : "Use this command"}
        secondary={preview.configured ? "Keep a single command" : "Not now"}
        applying={applying}
        onApply={() => void applyPreview(rule)}
        onDismiss={() => {
          writeDismissed(projectId, ruleSig);
          setDismissed(ruleSig);
        }}
      />
    ) : null;

  const running = apps.filter((s) => s.status === "running").length;
  const anyLive = preview.installing || apps.some((s) => isLive(s.status));
  const multiTone: Tone = apps.some((s) => s.status === "failed") ? "danger" : running === apps.length ? "success" : anyLive ? "warning" : "muted";
  const extras = suggestions && hasExtras(suggestions.missing) && (!preview.configured || !workspace.database.configured) ? suggestions : null;
  const localFiles = workspace.localFiles && workspace.localFiles.configured.length ? workspace.localFiles : null;
  const localCard = localFiles || localHint;

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto grid max-w-5xl gap-4 p-4 lg:grid-cols-2">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Globe className="size-4" /> Preview
            </CardTitle>
            <CardDescription>
              {!preview.configured
                ? "Not set up yet."
                : multi
                  ? `${apps.length > 1 ? `${appsLabel(apps.length)} in this task's worktree, each with its own link and console` : "A dev server in this task's worktree"}${sharedCount ? `, plus ${sharedCount} shared service${sharedCount === 1 ? "" : "s"}` : ""}.`
                  : "A dev server running in this task's worktree."}
            </CardDescription>
            <CardAction className="flex flex-wrap items-center justify-end gap-1.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={detect.state === "loading"} aria-label="Detect with AI" onClick={() => void runDetect()}>
                    {detect.state === "loading" ? <Spinner className="size-3" /> : <Sparkles className="text-violet-600 dark:text-violet-400" />}
                    <span className="hidden sm:inline">Detect with AI</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>AI reads package.json, turbo.json and READMEs and suggests how to run the apps</TooltipContent>
              </Tooltip>
              {preview.configured ? (
                <ToneBadge tone="neutral" title="Where the preview runs" className="hidden sm:inline-flex">
                  {TARGET[preview.target ?? "machine"].icon}
                  {targetLabel(preview)}
                </ToneBadge>
              ) : null}
              {preview.configured ? (
                multi ? (
                  <ToneBadge tone={multiTone}>
                    <Dot tone={multiTone} pulse={preview.installing || services.some((s) => s.status === "starting")} className="size-1.5" />
                    {running}/{apps.length} running
                  </ToneBadge>
                ) : (
                  <ToneBadge tone={PREVIEW_TONE[preview.status]}>
                    <Dot tone={PREVIEW_TONE[preview.status]} pulse={preview.status === "starting"} className="size-1.5" />
                    {preview.status}
                  </ToneBadge>
                )
              ) : null}
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-4">
            {setup}
            {!preview.configured ? (
              setup ? null : (
                <p className="text-sm text-muted-foreground">
                  This project has no preview command. Use Detect with AI, or add one in{" "}
                  <a className="underline underline-offset-4 hover:text-foreground" href={`#/projects/${encodeURIComponent(projectId)}/settings`}>
                    project settings
                  </a>
                  .
                </p>
              )
            ) : multi ? (
              <MultiPreview
                preview={preview}
                busy={busy}
                log={log}
                logError={logError}
                logService={selectedLog}
                fixer={fixer}
                containers={containers}
                checks={sharedChecks(projectPreview)}
                projectId={projectId}
                taskId={taskId}
                onLogService={(v) => {
                  setLogService(v);
                  setLog(null);
                }}
                onAction={(a, service) =>
                  void act(
                    `${a}:${service ?? "all"}`,
                    () => ws.preview(a, service),
                    `${service ?? "All apps"} ${a === "start" ? "starting" : a === "stop" ? "stopped" : "restarting"}`,
                  )
                }
              />
            ) : (
              <SinglePreview
                preview={preview}
                service={singleService(preview)}
                containerPort={singleContainerPort(projectPreview, containers)}
                projectId={projectId}
                taskId={taskId}
                busy={busy}
                log={log}
                logError={logError}
                fixer={fixer}
                onAction={(a) => void act(a, () => ws.preview(a), a === "start" ? "Preview starting" : a === "stop" ? "Preview stopped" : "Preview restarting")}
              />
            )}
          </CardContent>
        </Card>
        <DatabaseCard
          className={extras || localCard ? undefined : "lg:col-span-2"}
          db={workspace.database}
          busy={busy}
          onAction={(a) => void act(a, () => ws.database(a), a === "create" ? "Database created" : a === "reset" ? "Database reset" : "Database dropped")}
        />
        {extras ? (
          <DetectedCard
            projectId={projectId}
            data={extras}
            onApplied={() => {
              refresh();
              void loadSuggestions();
            }}
          />
        ) : null}
        {localFiles ? (
          <LocalFilesCard
            className={extras ? "lg:col-span-2" : undefined}
            projectId={projectId}
            taskId={taskId}
            status={localFiles}
            agentCanRead={project ? Boolean(project.localFiles?.agentCanRead) : null}
            onStatus={(next) => onWorkspace({ ...workspace, localFiles: next })}
          />
        ) : localHint ? (
          <LocalFilesHintCard className={extras ? "lg:col-span-2" : undefined} projectId={projectId} scan={localHint} />
        ) : null}
      </div>
    </ScrollArea>
  );
}
