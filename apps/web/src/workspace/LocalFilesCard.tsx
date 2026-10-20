import { useEffect, useState } from "react";
import { ArrowRight, Check, CircleSlash, FileKey2, FileWarning, Lock, RefreshCw, Unlock } from "lucide-react";
import { toast } from "sonner";
import type { LocalFilesScan, LocalFilesStatus } from "@nightshift/core";
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
import { cn } from "@/lib/utils";
import { messageOf, scanLocalFiles, syncLocalFiles } from "../api";
import { plural } from "../components/skills";
import { Spinner, ToneBadge } from "../components/TaskBits";
import { projectSettingsHref } from "../routing";

const scans = new Map<string, Promise<LocalFilesScan | null>>();

const cachedScan = (projectId: string) => {
  let p = scans.get(projectId);
  if (!p) {
    p = scanLocalFiles(projectId).catch(() => null);
    scans.set(projectId, p);
  }
  return p;
};

const nothingConfigured = (status: LocalFilesStatus | null) => !status || status.configured.length === 0;

export function useLocalFilesHint(projectId: string, status: LocalFilesStatus | null, enabled: boolean) {
  const [scan, setScan] = useState<LocalFilesScan | null>(null);
  const want = enabled && nothingConfigured(status);
  useEffect(() => {
    if (!want) return;
    let live = true;
    void cachedScan(projectId).then((s) => {
      if (live) setScan(s);
    });
    return () => {
      live = false;
    };
  }, [projectId, want]);
  return want && scan && scan.candidates.length ? scan : null;
}

type FileState = "copied" | "changed" | "missing" | "pending";

const stateOf = (s: LocalFilesStatus, path: string): FileState =>
  s.missing.includes(path) ? "missing" : s.changed.includes(path) ? "changed" : s.present.includes(path) ? "copied" : "pending";

const STATE: Record<FileState, { label: string; className: string; icon: typeof Check }> = {
  copied: { label: "Copied", className: "text-emerald-700 dark:text-emerald-300", icon: Check },
  changed: { label: "Changed in project folder", className: "text-amber-700 dark:text-amber-300", icon: FileWarning },
  missing: { label: "Not in project folder", className: "text-red-700 dark:text-red-300", icon: CircleSlash },
  pending: { label: "Not copied yet", className: "text-muted-foreground", icon: CircleSlash },
};

export function LocalFilesHintCard({ projectId, scan, className }: { projectId: string; scan: LocalFilesScan; className?: string }) {
  const names = scan.candidates.map((c) => c.path);
  return (
    <Card className={cn("border-dashed", className)}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileKey2 className="size-4" /> Local files
        </CardTitle>
        <CardDescription>
          The project folder has {plural(names.length, "gitignored env file")} that this task did not get, like{" "}
          {names.slice(0, 2).map((n, i) => (
            <span key={n}>
              {i ? ", " : ""}
              <code className="font-mono text-xs break-all">{n}</code>
            </span>
          ))}
          {names.length > 2 ? ` and ${names.length - 2} more` : ""}. If the app needs them to start, choose which to copy into new tasks.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button size="sm" variant="outline" asChild>
          <a href={projectSettingsHref(projectId)}>
            Choose files in settings <ArrowRight />
          </a>
        </Button>
      </CardContent>
    </Card>
  );
}

export function LocalFilesCard({
  projectId,
  taskId,
  status,
  agentCanRead,
  className,
  onStatus,
}: {
  projectId: string;
  taskId: string;
  status: LocalFilesStatus;
  agentCanRead: boolean | null;
  className?: string;
  onStatus: (next: LocalFilesStatus) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const copied = status.present.filter((p) => status.configured.includes(p)).length;
  const changed = status.changed.filter((p) => status.configured.includes(p)).length;
  const missing = status.missing.length;
  const pending = status.configured.filter((p) => stateOf(status, p) === "pending").length;

  const sync = async () => {
    setSyncing(true);
    try {
      const res = await syncLocalFiles(projectId, taskId, true);
      onStatus(res.status);
      const details = [res.missing.length ? `Not in the project folder: ${res.missing.join(", ")}.` : null, res.copied.length ? "Restart the preview to use them." : null].filter(Boolean).join(" ");
      if (res.copied.length) toast.success(`Copied ${plural(res.copied.length, "file")} from the project folder`, { description: details || undefined });
      else if (res.missing.length) toast.warning("Nothing was copied", { description: details });
      else toast.success("Already up to date");
    } catch (err) {
      toast.error("Could not sync local files", { description: messageOf(err) });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileKey2 className="size-4" /> Local files
        </CardTitle>
        <CardDescription>
          Gitignored files copied from the project folder.
          {status.syncedAt ? (
            <>
              {" "}
              Synced{" "}
              <time dateTime={status.syncedAt} title={formatDateTime(status.syncedAt)}>
                {formatRelative(status.syncedAt)}
              </time>
              .
            </>
          ) : null}
        </CardDescription>
        <CardAction>
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={syncing} onClick={() => setConfirm(true)} aria-label="Sync from project folder">
            {syncing ? <Spinner className="size-3" /> : <RefreshCw />}
            <span className="hidden sm:inline">Sync from project folder</span>
            <span className="sm:hidden">Sync</span>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="flex flex-wrap items-center gap-1.5 text-sm" role="status">
          <span className="sr-only">Local files: </span>
          <ToneBadge tone={copied ? "success" : "muted"}>{copied} copied</ToneBadge>
          {changed ? <ToneBadge tone="warning">{changed} changed in project folder</ToneBadge> : null}
          {missing ? <ToneBadge tone="danger">{missing} missing</ToneBadge> : null}
          {pending ? <ToneBadge tone="muted">{pending} not copied yet</ToneBadge> : null}
        </p>
        <ul className="divide-y rounded-lg border">
          {status.configured.map((path) => {
            const st = STATE[stateOf(status, path)];
            const Icon = st.icon;
            return (
              <li key={path} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2">
                <code className="min-w-0 flex-1 font-mono text-xs break-all">{path}</code>
                <span className={cn("inline-flex items-center gap-1 text-xs", st.className)}>
                  <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                  {st.label}
                </span>
              </li>
            );
          })}
        </ul>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          {agentCanRead === null ? (
            <span />
          ) : (
            <span className="inline-flex items-center gap-1.5">
              {agentCanRead ? <Unlock className="size-3.5 text-amber-600 dark:text-amber-400" aria-hidden="true" /> : <Lock className="size-3.5" aria-hidden="true" />}
              {agentCanRead ? "The agent can read these files" : "Hidden from the agent"}
            </span>
          )}
          <a className="underline underline-offset-4 hover:text-foreground" href={projectSettingsHref(projectId)}>
            Change in settings
          </a>
        </div>
      </CardContent>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace this task's copies with the project folder's versions?</AlertDialogTitle>
            <AlertDialogDescription>
              {plural(status.configured.length, "file")} will be copied again from the project folder. Edits made to them in this task are lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void sync()}>Replace copies</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
