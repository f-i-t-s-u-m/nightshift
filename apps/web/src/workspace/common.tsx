import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { FolderX } from "lucide-react";
import { useTheme } from "next-themes";
import type { GitFileStatus, WorkspaceInfo } from "@nightshift/core";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { isNotFound, messageOf, type WorkspaceApi } from "../api";
import { EmptyState } from "../components/TaskBits";
import { useDebouncedRefresh } from "../live";

export type WorkspaceTabProps = {
  projectId: string;
  taskId: string;
  ws: WorkspaceApi;
  workspace: WorkspaceInfo;
  active: boolean;
  onWorkspace: (next: WorkspaceInfo) => void;
};

export const GIT_STATUS: Record<GitFileStatus, { letter: string; label: string; className: string }> = {
  modified: { letter: "M", label: "Modified", className: "text-amber-600 dark:text-amber-400" },
  added: { letter: "A", label: "Added", className: "text-emerald-600 dark:text-emerald-400" },
  deleted: { letter: "D", label: "Deleted", className: "text-red-600 dark:text-red-400" },
  renamed: { letter: "R", label: "Renamed", className: "text-sky-600 dark:text-sky-400" },
  untracked: { letter: "U", label: "Untracked", className: "text-emerald-600 dark:text-emerald-400" },
  conflicted: { letter: "!", label: "Conflicted", className: "text-violet-600 dark:text-violet-400" },
};

export function GitLetter({ status, className }: { status: GitFileStatus; className?: string }) {
  const def = GIT_STATUS[status];
  return (
    <span className={cn("w-3 shrink-0 text-center font-mono text-xs font-semibold", def.className, className)} title={def.label}>
      {def.letter}
      <span className="sr-only"> ({def.label})</span>
    </span>
  );
}

export const baseName = (path: string) => path.split("/").pop() ?? path;
export const dirName = (path: string) => {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : "";
};

export function NoWorkspace() {
  return (
    <EmptyState icon={<FolderX />} title="No workspace yet" className="h-full">
      The agent creates it when it starts.
    </EmptyState>
  );
}

export function useWorkspaceRefresh(projectId: string, taskId: string, active: boolean, refresh: () => void, delayMs = 500) {
  const stale = useRef(false);
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  });
  useDebouncedRefresh(
    (event) => event.type === "task" && event.projectId === projectId && event.taskId === taskId,
    () => {
      if (activeRef.current) refresh();
      else stale.current = true;
    },
    delayMs,
  );
  useEffect(() => {
    if (active && stale.current) {
      stale.current = false;
      refresh();
    }
  }, [active, refresh]);
}

export type Loaded<T> = {
  data: T | null;
  error: string | null;
  missing: boolean;
  loading: boolean;
  reload: () => Promise<void>;
};

export function useLoad<T>(fn: () => Promise<T>, enabled = true): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(enabled);
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const res = await fnRef.current();
      if (mine !== seq.current) return;
      setData(res);
      setError(null);
      setMissing(false);
    } catch (err) {
      if (mine !== seq.current) return;
      setMissing(isNotFound(err));
      setError(messageOf(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);

  return { data, error, missing, loading, reload };
}

export function SplitPane({
  id,
  first,
  second,
  firstSize = "30%",
  firstMin = "180px",
  secondMin = "240px",
  className,
}: {
  id: string;
  first: ReactNode;
  second: ReactNode;
  firstSize?: string;
  firstMin?: string;
  secondMin?: string;
  className?: string;
}) {
  const mobile = useIsMobile();
  return (
    <ResizablePanelGroup key={mobile ? "v" : "h"} id={id} orientation={mobile ? "vertical" : "horizontal"} className={cn("min-h-0", className)}>
      <ResizablePanel id={`${id}-a`} defaultSize={mobile ? "40%" : firstSize} minSize={mobile ? "120px" : firstMin} className="min-h-0 min-w-0">
        {first}
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel id={`${id}-b`} minSize={mobile ? "160px" : secondMin} className="min-h-0 min-w-0">
        {second}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

export const useMonacoTheme = () => {
  const { resolvedTheme } = useTheme();
  return resolvedTheme === "dark" ? "vs-dark" : "light";
};
