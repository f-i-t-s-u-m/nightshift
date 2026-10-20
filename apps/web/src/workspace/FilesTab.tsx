import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { ChevronRight, File as FileIcon, FilePlus, Folder, FolderOpen, FolderPlus, Lock, RefreshCw, Save, X } from "lucide-react";
import { toast } from "sonner";
import type { FileEntry, GitFileStatus, GitStatusResponse } from "@nightshift/core";
import { Button } from "@/components/ui/button";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { isConflict, isNotFound, messageOf } from "../api";
import { EmptyState, Spinner } from "../components/TaskBits";
import { GIT_STATUS, GitLetter, NoWorkspace, SplitPane, baseName, useMonacoTheme, useWorkspaceRefresh, type WorkspaceTabProps } from "./common";
import { languageFor, monaco } from "./monaco";

type DirState = { entries: FileEntry[] | null; loading: boolean; error: string | null };

type OpenFile = {
  path: string;
  saved: string;
  value: string;
  language: string;
  binary: boolean;
  tooLarge: boolean;
  size: number;
  loading: boolean;
  saving: boolean;
  error: string | null;
};

const statusMapOf = (status: GitStatusResponse | null) => {
  const files = new Map<string, GitFileStatus>();
  const dirs = new Map<string, GitFileStatus>();
  if (!status) return { files, dirs };
  for (const c of [...status.staged, ...status.unstaged]) {
    files.set(c.path, c.status);
    const parts = c.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!dirs.has(dir) || c.status === "conflicted") dirs.set(dir, c.status === "deleted" ? "modified" : c.status);
    }
  }
  return { files, dirs };
};

function TreeLevel({
  dir,
  depth,
  dirs,
  expanded,
  activePath,
  gitFiles,
  gitDirs,
  onToggle,
  onOpen,
}: {
  dir: string;
  depth: number;
  dirs: Record<string, DirState>;
  expanded: Set<string>;
  activePath: string | null;
  gitFiles: Map<string, GitFileStatus>;
  gitDirs: Map<string, GitFileStatus>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  const state = dirs[dir];
  const pad = { paddingLeft: `${depth * 12 + 8}px` };
  if (!state || (state.loading && !state.entries)) {
    return (
      <div role="none" style={pad} className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
        <Spinner className="size-3" /> Loading…
      </div>
    );
  }
  if (state.error && !state.entries) {
    return (
      <div role="none" style={pad} className="py-1 text-xs text-destructive">
        {state.error}
      </div>
    );
  }
  const entries = [...(state.entries ?? [])].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  if (entries.length === 0) {
    return (
      <div role="none" style={pad} className="py-1 text-xs text-muted-foreground">
        Empty folder
      </div>
    );
  }
  return (
    <>
      {entries.map((entry) => {
        const isDir = entry.type === "dir";
        const open = isDir && expanded.has(entry.path);
        const git = entry.git ?? (isDir ? gitDirs.get(entry.path) : gitFiles.get(entry.path));
        const tone = git ? GIT_STATUS[git].className : "";
        return (
          <div key={entry.path} role="treeitem" aria-expanded={isDir ? open : undefined} aria-selected={entry.path === activePath} aria-level={depth + 1}>
            <button
              type="button"
              style={pad}
              className={cn(
                "flex h-7 w-full items-center gap-1.5 pr-2 text-left text-[13px] hover:bg-muted focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
                entry.path === activePath && "bg-muted",
                tone,
              )}
              onClick={() => (isDir ? onToggle(entry.path) : onOpen(entry.path))}
              title={entry.path}
            >
              {isDir ? (
                <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
              ) : (
                <span className="w-3.5 shrink-0" />
              )}
              {isDir ? (
                open ? (
                  <FolderOpen className="size-4 shrink-0 text-sky-600 dark:text-sky-400" />
                ) : (
                  <Folder className="size-4 shrink-0 text-sky-600 dark:text-sky-400" />
                )
              ) : (
                <FileIcon className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className={cn("min-w-0 flex-1 truncate", !git && "text-foreground", git === "deleted" && "line-through")}>{entry.name}</span>
              {git ? isDir ? <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" /> : <GitLetter status={git} /> : null}
            </button>
            {open ? (
              <div role="group">
                <TreeLevel
                  dir={entry.path}
                  depth={depth + 1}
                  dirs={dirs}
                  expanded={expanded}
                  activePath={activePath}
                  gitFiles={gitFiles}
                  gitDirs={gitDirs}
                  onToggle={onToggle}
                  onOpen={onOpen}
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

export default function FilesTab({ projectId, taskId, ws, workspace, active }: WorkspaceTabProps) {
  const theme = useMonacoTheme();
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [missing, setMissing] = useState(false);
  const [gitStatus, setGitStatus] = useState<GitStatusResponse | null>(null);
  const [files, setFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [targetDir, setTargetDir] = useState("");
  const [creating, setCreating] = useState<{ kind: "file" | "folder"; name: string; busy: boolean; error: string | null } | null>(null);
  const locked = workspace.agentBusy;
  const filesRef = useRef(files);
  filesRef.current = files;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  const loadDir = useCallback(
    async (dir: string) => {
      setDirs((prev) => ({ ...prev, [dir]: { entries: prev[dir]?.entries ?? null, loading: true, error: null } }));
      try {
        const res = await ws.files(dir);
        setDirs((prev) => ({ ...prev, [dir]: { entries: res.entries, loading: false, error: null } }));
        if (dir === "") setMissing(false);
      } catch (err) {
        if (dir === "" && isNotFound(err)) setMissing(true);
        setDirs((prev) => ({ ...prev, [dir]: { entries: prev[dir]?.entries ?? null, loading: false, error: messageOf(err) } }));
      }
    },
    [ws],
  );

  const loadStatus = useCallback(async () => {
    try {
      setGitStatus(await ws.gitStatus());
    } catch {
      setGitStatus(null);
    }
  }, [ws]);

  const patchFile = (path: string, patch: Partial<OpenFile>) => setFiles((prev) => prev.map((f) => (f.path === path ? { ...f, ...patch } : f)));

  const fetchFile = useCallback(
    async (path: string, keepValue = false) => {
      try {
        const res = await ws.file(path);
        setFiles((prev) =>
          prev.map((f) =>
            f.path === path
              ? {
                  ...f,
                  saved: res.content,
                  value: keepValue && f.value !== f.saved ? f.value : res.content,
                  language: languageFor(path, res.language),
                  binary: res.binary,
                  tooLarge: res.tooLarge,
                  size: res.size,
                  loading: false,
                  error: null,
                }
              : f,
          ),
        );
      } catch (err) {
        patchFile(path, { loading: false, error: messageOf(err) });
      }
    },
    [ws],
  );

  const refresh = useCallback(() => {
    void loadDir("");
    for (const dir of expandedRef.current) void loadDir(dir);
    void loadStatus();
    for (const f of filesRef.current) if (f.value === f.saved && !f.saving) void fetchFile(f.path, true);
  }, [loadDir, loadStatus, fetchFile]);

  useEffect(() => {
    void loadDir("");
    void loadStatus();
  }, [loadDir, loadStatus]);

  useWorkspaceRefresh(projectId, taskId, active, refresh);

  const toggle = (path: string) => {
    setTargetDir(path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else {
        next.add(path);
        if (!dirs[path]?.entries) void loadDir(path);
      }
      return next;
    });
  };

  const openFile = (path: string) => {
    setActivePath(path);
    setTargetDir(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
    if (filesRef.current.some((f) => f.path === path)) return;
    setFiles((prev) => [
      ...prev,
      { path, saved: "", value: "", language: languageFor(path), binary: false, tooLarge: false, size: 0, loading: true, saving: false, error: null },
    ]);
    void fetchFile(path);
  };

  const closeFile = (path: string) => {
    const f = filesRef.current.find((x) => x.path === path);
    if (f && f.value !== f.saved && !window.confirm(`Close ${baseName(path)} without saving your changes?`)) return;
    const idx = filesRef.current.findIndex((x) => x.path === path);
    const rest = filesRef.current.filter((x) => x.path !== path);
    setFiles(rest);
    monaco.editor.getModel(monaco.Uri.file(path))?.dispose();
    if (activePath === path) setActivePath(rest[Math.min(idx, rest.length - 1)]?.path ?? null);
  };

  const startCreate = (kind: "file" | "folder") => {
    if (locked) {
      toast.error("The agent is working in this workspace", { description: "Pause it or wait until it finishes to add files." });
      return;
    }
    setCreating({ kind, name: "", busy: false, error: null });
  };

  const submitCreate = async () => {
    if (!creating || creating.busy) return;
    const name = creating.name.trim().replace(/^\/+|\/+$/g, "");
    if (!name) {
      setCreating({ ...creating, error: `Type a ${creating.kind} name` });
      return;
    }
    const path = targetDir ? `${targetDir}/${name}` : name;
    setCreating({ ...creating, busy: true, error: null });
    try {
      await ws.create({ path, kind: creating.kind });
      setCreating(null);
      const parts = path.split("/");
      const parents = parts.slice(0, creating.kind === "folder" ? parts.length : parts.length - 1).map((_, i) => parts.slice(0, i + 1).join("/"));
      setExpanded((prev) => new Set([...prev, ...parents]));
      await Promise.all(["", ...parents].map((d) => loadDir(d)));
      void loadStatus();
      if (creating.kind === "file") openFile(path);
      else setTargetDir(path);
      toast.success(creating.kind === "file" ? `Created ${path}` : `Created folder ${path}`, creating.kind === "folder" ? { description: "Git does not track empty folders: add a file to it before committing." } : undefined);
    } catch (err) {
      setCreating((c) => (c ? { ...c, busy: false, error: messageOf(err) } : c));
    }
  };

  const current = files.find((f) => f.path === activePath) ?? null;

  const save = useCallback(async () => {
    const f = filesRef.current.find((x) => x.path === activePath);
    if (!f || f.saving || f.binary || f.tooLarge || f.loading) return;
    if (locked) {
      toast.error("The agent is working in this workspace", { description: "Editing is locked until it stops." });
      return;
    }
    if (f.value === f.saved) return;
    const content = f.value;
    patchFile(f.path, { saving: true });
    try {
      await ws.saveFile(f.path, content);
      patchFile(f.path, { saving: false, saved: content });
      toast.success(`Saved ${baseName(f.path)}`);
      void loadStatus();
    } catch (err) {
      patchFile(f.path, { saving: false });
      toast.error(isConflict(err) ? "The agent is working in this workspace" : `Could not save ${baseName(f.path)}`, { description: messageOf(err) });
    }
  }, [activePath, locked, ws, loadStatus]);

  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  const onMount: OnMount = (editor, m) => {
    editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => void saveRef.current());
  };

  const { files: gitFiles, dirs: gitDirs } = useMemo(() => statusMapOf(gitStatus), [gitStatus]);

  if (missing || !workspace.exists) return <NoWorkspace />;

  const explorer = (
    <div className="flex h-full min-h-0 flex-col bg-sidebar/40">
      <div className="flex h-9 shrink-0 items-center justify-between border-b px-3">
        <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Explorer</span>
        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-xs" aria-label="New file" disabled={locked} onClick={() => startCreate("file")}>
                <FilePlus />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{locked ? "Locked while the agent works" : "New file"}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-xs" aria-label="New folder" disabled={locked} onClick={() => startCreate("folder")}>
                <FolderPlus />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{locked ? "Locked while the agent works" : "New folder"}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-xs" aria-label="Refresh explorer" onClick={refresh}>
                <RefreshCw />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh</TooltipContent>
          </Tooltip>
        </div>
      </div>
      {creating ? (
        <form
          className="shrink-0 space-y-1 border-b bg-background/60 px-2 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            void submitCreate();
          }}
        >
          <label htmlFor={`new-entry-${taskId}`} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            {creating.kind === "file" ? <FilePlus className="size-3.5" /> : <FolderPlus className="size-3.5" />}
            New {creating.kind} in <code className="truncate font-mono">{targetDir ? `${targetDir}/` : "/"}</code>
          </label>
          <input
            id={`new-entry-${taskId}`}
            autoFocus
            value={creating.name}
            disabled={creating.busy}
            placeholder={creating.kind === "file" ? "name.ts or folder/name.ts" : "folder or folder/sub"}
            aria-invalid={creating.error ? true : undefined}
            aria-describedby={creating.error ? `new-entry-error-${taskId}` : undefined}
            onChange={(e) => setCreating({ ...creating, name: e.target.value, error: null })}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setCreating(null);
              }
            }}
            onBlur={() => {
              if (!creating.name.trim() && !creating.busy) setCreating(null);
            }}
            className="h-7 w-full rounded-md border bg-background px-2 font-mono text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-ring aria-invalid:border-destructive"
          />
          {creating.error ? (
            <p id={`new-entry-error-${taskId}`} className="text-[11px] text-destructive">
              {creating.error}
            </p>
          ) : (
            <p className="text-[11px] text-muted-foreground">Enter to create · Esc to cancel</p>
          )}
        </form>
      ) : null}
      <ScrollArea className="min-h-0 flex-1">
        <div role="tree" aria-label="Files" className="py-1">
          {dirs[""]?.entries === null && dirs[""]?.loading ? (
            <div className="space-y-2 p-3">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-4" style={{ width: `${80 - i * 9}%` }} />
              ))}
            </div>
          ) : (
            <TreeLevel
              dir=""
              depth={0}
              dirs={dirs}
              expanded={expanded}
              activePath={activePath}
              gitFiles={gitFiles}
              gitDirs={gitDirs}
              onToggle={toggle}
              onOpen={openFile}
            />
          )}
        </div>
      </ScrollArea>
    </div>
  );

  const editorPane = (
    <div className="flex h-full min-h-0 flex-col">
      {files.length > 0 ? (
        <ScrollArea className="shrink-0 border-b bg-muted/30">
          <div role="tablist" aria-label="Open files" className="flex h-9">
            {files.map((f) => {
              const dirty = f.value !== f.saved;
              const selected = f.path === activePath;
              const git = gitFiles.get(f.path);
              return (
                <div
                  key={f.path}
                  className={cn(
                    "group flex shrink-0 items-center border-r text-[13px]",
                    selected ? "bg-background text-foreground" : "text-muted-foreground hover:bg-background/60",
                  )}
                  onMouseDown={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      closeFile(f.path);
                    }
                  }}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    title={f.path}
                    className={cn("flex h-full items-center gap-1.5 pr-1 pl-3 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset", git && GIT_STATUS[git].className)}
                    onClick={() => setActivePath(f.path)}
                  >
                    <FileIcon className="size-3.5" />
                    <span className="max-w-48 truncate">{baseName(f.path)}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Close ${baseName(f.path)}${dirty ? " (unsaved)" : ""}`}
                    className="mr-1 flex size-5 items-center justify-center rounded hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    onClick={() => closeFile(f.path)}
                  >
                    {dirty ? (
                      <>
                        <span className="size-2 rounded-full bg-foreground group-hover:hidden" aria-hidden="true" />
                        <X className="hidden size-3.5 group-hover:block" />
                      </>
                    ) : (
                      <X className={cn("size-3.5", !selected && "opacity-0 group-hover:opacity-100")} />
                    )}
                  </button>
                </div>
              );
            })}
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      ) : null}
      {locked ? (
        <div role="status" className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-800 dark:text-amber-200">
          <Lock className="size-3.5 shrink-0" />
          <span>The agent is working in this workspace. Files are read-only until it stops.</span>
        </div>
      ) : null}
      {current ? (
        <>
          <div className="flex h-8 shrink-0 items-center gap-2 border-b px-3 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate font-mono">{current.path}</span>
            {current.value !== current.saved ? <span className="hidden sm:inline">Unsaved changes</span> : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={locked || current.saving || current.value === current.saved}
                  onClick={() => void save()}
                >
                  {current.saving ? <Spinner className="size-3" /> : <Save />}
                  Save
                </Button>
              </TooltipTrigger>
              <TooltipContent>Save (⌘S / Ctrl+S)</TooltipContent>
            </Tooltip>
          </div>
          <div className="min-h-0 flex-1">
            {current.loading ? (
              <EmptyState icon={<Spinner />} title="Opening file…" className="h-full" />
            ) : current.error ? (
              <EmptyState title="Could not open this file" className="h-full">
                {current.error}
              </EmptyState>
            ) : current.binary ? (
              <EmptyState title="Binary file" className="h-full">
                This file is not shown because it is binary.
              </EmptyState>
            ) : current.tooLarge ? (
              <EmptyState title="File too large" className="h-full">
                {`This file is ${Math.round(current.size / 1024)} KB, too large to open here.`}
              </EmptyState>
            ) : (
              <Editor
                path={current.path}
                language={current.language}
                value={current.value}
                theme={theme}
                onMount={onMount}
                onChange={(value) => patchFile(current.path, { value: value ?? "" })}
                loading={<Spinner label="Loading editor" />}
                options={{
                  readOnly: locked,
                  readOnlyMessage: { value: "The agent is working in this workspace. Editing is locked until it stops." },
                  automaticLayout: true,
                  minimap: { enabled: false },
                  fontSize: 13,
                  scrollBeyondLastLine: false,
                  renderWhitespace: "selection",
                  tabSize: 2,
                }}
              />
            )}
          </div>
        </>
      ) : (
        <EmptyState icon={<FileIcon />} title="No file open" className="h-full">
          Pick a file in the explorer to view or edit it.
        </EmptyState>
      )}
    </div>
  );

  return <SplitPane id={`files-${projectId}-${taskId}`} first={explorer} second={editorPane} firstSize="26%" className="h-full" />;
}
