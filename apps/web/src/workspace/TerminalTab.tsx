import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { EyeOff, Plus, RotateCcw, SquareTerminal, TriangleAlert, X } from "lucide-react";
import { useTheme } from "next-themes";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { TerminalInfo, TerminalStreamEvent } from "@nightshift/core";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { isNotFound, messageOf, type WorkspaceApi } from "../api";
import { EmptyState, Spinner } from "../components/TaskBits";
import { NoWorkspace, type WorkspaceTabProps } from "./common";

const MAX_TERMINALS = 5;
const LIST_POLL_MS = 10000;
const INPUT_BATCH_MS = 8;
const RESIZE_DEBOUNCE_MS = 100;
const MAX_RETRY_MS = 10000;
const FONT_SIZE = 13;
const LINE_HEIGHT = 1.2;
const MONO_FALLBACK = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

const DARK_THEME: ITheme = {
  background: "#0a0a0a",
  foreground: "#e5e5e5",
  cursor: "#e5e5e5",
  cursorAccent: "#0a0a0a",
  selectionBackground: "#3b82f659",
  selectionInactiveBackground: "#ffffff26",
  black: "#262626",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#facc15",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#d4d4d4",
  brightBlack: "#737373",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde047",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#fafafa",
};

const LIGHT_THEME: ITheme = {
  background: "#ffffff",
  foreground: "#171717",
  cursor: "#171717",
  cursorAccent: "#ffffff",
  selectionBackground: "#2563eb33",
  selectionInactiveBackground: "#0000001a",
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#9a6700",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#7d4e00",
  brightBlue: "#218bff",
  brightMagenta: "#a475f9",
  brightCyan: "#3192aa",
  brightWhite: "#8c959f",
};

type ConnState = "connecting" | "live" | "retrying";

type SessionEvents = {
  onExit: (id: string, code: number | null) => void;
  onConnection: (id: string, state: ConnState) => void;
  onStreamError: (id: string) => void;
  onInputError: (id: string, message: string) => void;
};

const monoFont = () => getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || MONO_FALLBACK;

const decode = (b64: string) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const exitText = (code: number | null) => (code === null ? "exited" : `exited (${code})`);

class TerminalSession {
  readonly host: HTMLDivElement;
  readonly term: Terminal;
  exited: boolean;
  private readonly fit = new FitAddon();
  private readonly observer: ResizeObserver;
  private opened = false;
  private disposed = false;
  private source: EventSource | null = null;
  private retries = 0;
  private retryTimer = 0;
  private pending = "";
  private sending = false;
  private flushTimer = 0;
  private resizeTimer = 0;
  private fitFrame = 0;
  private sent: { cols: number; rows: number } | null = null;

  constructor(
    readonly id: string,
    private readonly ws: WorkspaceApi,
    private readonly events: SessionEvents,
    theme: ITheme,
    light: boolean,
    exited: boolean,
  ) {
    this.exited = exited;
    this.host = document.createElement("div");
    this.host.className = "absolute inset-0 pt-2 pr-1 pb-1 pl-3";
    this.host.style.display = "none";
    this.term = new Terminal({
      fontFamily: monoFont(),
      fontSize: FONT_SIZE,
      lineHeight: LINE_HEIGHT,
      scrollback: 5000,
      cursorBlink: !exited,
      theme,
      minimumContrastRatio: light ? 3 : 1,
      allowProposedApi: false,
    });
    this.term.loadAddon(this.fit);
    this.term.attachCustomKeyEventHandler((e) => {
      if (!e.metaKey || e.ctrlKey || e.altKey) return true;
      if (e.type === "keydown" && e.key.toLowerCase() === "k") {
        e.preventDefault();
        e.stopPropagation();
        this.term.clear();
      }
      return false;
    });
    this.term.onData((data) => this.queueInput(data));
    this.term.onResize(() => this.scheduleResize());
    this.observer = new ResizeObserver(() => this.requestFit());
  }

  mount(parent: HTMLElement) {
    if (this.host.parentElement !== parent) parent.appendChild(this.host);
  }

  show() {
    this.host.style.display = "";
    if (!this.opened) {
      this.term.open(this.host);
      this.opened = true;
      this.observer.observe(this.host);
    }
    this.refit();
  }

  hide() {
    this.host.style.display = "none";
  }

  focus() {
    if (this.opened) this.term.focus();
  }

  setTheme(theme: ITheme, light: boolean) {
    this.term.options.theme = theme;
    this.term.options.minimumContrastRatio = light ? 3 : 1;
  }

  size() {
    return { cols: this.term.cols, rows: this.term.rows };
  }

  connect() {
    if (this.disposed || this.source) return;
    window.clearTimeout(this.retryTimer);
    this.events.onConnection(this.id, this.retries > 0 ? "retrying" : "connecting");
    const source = new EventSource(this.ws.terminalStreamUrl(this.id));
    this.source = source;
    source.onopen = () => {
      this.retries = 0;
      this.events.onConnection(this.id, "live");
      this.sent = null;
      this.scheduleResize();
    };
    source.onmessage = (msg) => {
      let event: TerminalStreamEvent;
      try {
        event = JSON.parse(msg.data) as TerminalStreamEvent;
      } catch {
        return;
      }
      this.handle(event);
    };
    source.onerror = () => {
      source.close();
      if (this.source !== source) return;
      this.source = null;
      if (this.disposed) return;
      this.events.onStreamError(this.id);
      if (this.exited) {
        this.events.onConnection(this.id, "live");
        return;
      }
      const delay = Math.min(MAX_RETRY_MS, 500 * 2 ** this.retries);
      this.retries += 1;
      this.events.onConnection(this.id, "retrying");
      this.retryTimer = window.setTimeout(() => this.connect(), delay);
    };
  }

  disconnect() {
    window.clearTimeout(this.retryTimer);
    this.retries = 0;
    if (this.source) {
      this.source.close();
      this.source = null;
    }
  }

  dispose() {
    this.disposed = true;
    this.disconnect();
    window.clearTimeout(this.flushTimer);
    window.clearTimeout(this.resizeTimer);
    window.cancelAnimationFrame(this.fitFrame);
    this.observer.disconnect();
    this.term.dispose();
    this.host.remove();
  }

  private handle(event: TerminalStreamEvent) {
    if (event.type === "reset") {
      this.term.reset();
      return;
    }
    if (event.type === "output") {
      this.term.write(decode(event.data));
      return;
    }
    this.markExited();
    this.term.write(`\r\n\x1b[2m[process exited with code ${event.code ?? "unknown"}]\x1b[0m\r\n`);
    this.events.onExit(this.id, event.code);
  }

  markExited() {
    this.exited = true;
    this.pending = "";
    this.term.options.cursorBlink = false;
    this.term.options.disableStdin = true;
  }

  private requestFit() {
    window.cancelAnimationFrame(this.fitFrame);
    this.fitFrame = window.requestAnimationFrame(() => this.refit());
  }

  private refit() {
    if (!this.opened || this.disposed || this.host.clientWidth === 0 || this.host.clientHeight === 0) return;
    try {
      this.fit.fit();
    } catch {
      return;
    }
  }

  private scheduleResize() {
    window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      if (this.disposed || this.exited || !this.opened) return;
      const { cols, rows } = this.term;
      if (this.sent && this.sent.cols === cols && this.sent.rows === rows) return;
      this.sent = { cols, rows };
      this.ws.terminalResize(this.id, { cols, rows }).catch(() => {
        this.sent = null;
      });
    }, RESIZE_DEBOUNCE_MS);
  }

  private queueInput(data: string) {
    if (this.exited || this.disposed) return;
    this.pending += data;
    if (!this.sending && !this.flushTimer) this.flushTimer = window.setTimeout(() => this.flush(), INPUT_BATCH_MS);
  }

  private flush() {
    this.flushTimer = 0;
    if (this.sending || !this.pending || this.disposed) return;
    const data = this.pending;
    this.pending = "";
    this.sending = true;
    this.ws
      .terminalInput(this.id, data)
      .catch((err: unknown) => {
        if (!this.disposed) this.events.onInputError(this.id, messageOf(err));
      })
      .finally(() => {
        this.sending = false;
        if (this.pending && !this.disposed) this.flush();
      });
  }
}

const estimateSize = (el: HTMLElement | null) => {
  const width = el?.clientWidth ?? 0;
  const height = el?.clientHeight ?? 0;
  if (!width || !height) return { cols: 80, rows: 24 };
  return {
    cols: Math.max(20, Math.floor((width - 16) / (FONT_SIZE * 0.6))),
    rows: Math.max(5, Math.floor((height - 12) / Math.ceil(FONT_SIZE * LINE_HEIGHT + 1))),
  };
};

export default function TerminalTab({ taskId, ws, workspace, active }: WorkspaceTabProps) {
  const { resolvedTheme } = useTheme();
  const light = resolvedTheme !== "dark";
  const theme = light ? LIGHT_THEME : DARK_THEME;
  const [terminals, setTerminals] = useState<TerminalInfo[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [conn, setConn] = useState<Record<string, ConnState>>({});
  const sessions = useRef(new Map<string, TerminalSession>());
  const body = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const mutations = useRef(0);
  const themeRef = useRef({ theme, light });
  themeRef.current = { theme, light };
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const keepTabFocus = useRef(false);

  const reloadSeq = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++reloadSeq.current;
    const startedAt = mutations.current;
    try {
      const res = await ws.listTerminals();
      if (mine !== reloadSeq.current || startedAt !== mutations.current) return;
      setTerminals(res.terminals);
      setMissing(false);
      setLoadError(null);
    } catch (err) {
      if (mine !== reloadSeq.current) return;
      if (isNotFound(err)) setMissing(true);
    }
  }, [ws]);

  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  const events = useRef<SessionEvents>({
    onExit: (id, code) => setTerminals((prev) => prev?.map((t) => (t.id === id ? { ...t, exited: true, exitCode: code } : t)) ?? prev),
    onConnection: (id, state) => setConn((prev) => (prev[id] === state ? prev : { ...prev, [id]: state })),
    onStreamError: () => void reloadRef.current(),
    onInputError: (_id, message) => setError(`Couldn't send input: ${message}`),
  });

  const init = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await ws.listTerminals();
      setMissing(false);
      if (res.terminals.length > 0) {
        setTerminals(res.terminals);
        setSelectedId((res.terminals.find((t) => !t.exited) ?? res.terminals[0])!.id);
        return;
      }
      mutations.current++;
      const created = await ws.createTerminal(estimateSize(body.current));
      setTerminals([created]);
      setSelectedId(created.id);
    } catch (err) {
      if (isNotFound(err)) setMissing(true);
      else setLoadError(messageOf(err));
      started.current = false;
    }
  }, [ws]);

  useEffect(() => {
    if (!workspace.exists || started.current) return;
    started.current = true;
    void init();
  }, [workspace.exists, init]);

  useEffect(() => {
    const map = sessions.current;
    const list = terminals ?? [];
    const ids = new Set(list.map((t) => t.id));
    for (const [id, session] of map) {
      if (!ids.has(id)) {
        session.dispose();
        map.delete(id);
      }
    }
    for (const t of list) {
      let session = map.get(t.id);
      if (!session) {
        session = new TerminalSession(t.id, ws, events.current, themeRef.current.theme, themeRef.current.light, t.exited);
        map.set(t.id, session);
      } else if (t.exited && !session.exited) session.markExited();
      if (body.current) session.mount(body.current);
    }
    if (list.length > 0 && (selectedId === null || !ids.has(selectedId))) setSelectedId(list[0]!.id);
    if (list.length === 0 && selectedId !== null) setSelectedId(null);
  }, [terminals, ws, selectedId]);

  useEffect(() => {
    for (const [id, session] of sessions.current) {
      if (id === selectedId) {
        session.show();
        session.connect();
      } else {
        session.hide();
        session.disconnect();
      }
    }
  }, [selectedId, terminals]);

  useEffect(() => {
    if (!active || !selectedId) return;
    const frame = window.requestAnimationFrame(() => {
      const session = sessions.current.get(selectedId);
      if (!session) return;
      session.show();
      if (keepTabFocus.current) keepTabFocus.current = false;
      else session.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, selectedId, terminals === null]);

  useEffect(() => {
    for (const session of sessions.current.values()) session.setTheme(theme, light);
  }, [theme, light]);

  useEffect(() => {
    if (!active || terminals === null) return;
    void reload();
    const timer = window.setInterval(() => void reload(), LIST_POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, terminals === null, reload]);

  useEffect(() => {
    const map = sessions.current;
    return () => {
      for (const session of map.values()) session.dispose();
      map.clear();
    };
  }, []);

  const currentSize = () => sessions.current.get(selectedId ?? "")?.size() ?? estimateSize(body.current);

  const remove = (id: string) => {
    mutations.current++;
    const prev = terminals ?? [];
    const idx = prev.findIndex((t) => t.id === id);
    const next = prev.filter((t) => t.id !== id);
    setTerminals((cur) => cur?.filter((t) => t.id !== id) ?? cur);
    if (id === selectedId) setSelectedId(next[Math.min(idx, next.length - 1)]?.id ?? null);
    return ws.closeTerminal(id).catch((err: unknown) => {
      if (isNotFound(err)) return;
      setError(`Couldn't close the terminal: ${messageOf(err)}`);
      void reload();
    });
  };

  const create = async (replace?: TerminalInfo) => {
    if (creating) return;
    setCreating(true);
    setError(null);
    mutations.current++;
    const size = currentSize();
    const position = replace ? (terminals ?? []).findIndex((t) => t.id === replace.id) : -1;
    try {
      if (replace) await remove(replace.id);
      const info = await ws.createTerminal(size);
      mutations.current++;
      setTerminals((prev) => {
        const list = prev ?? [];
        return position >= 0 ? [...list.slice(0, position), info, ...list.slice(position)] : [...list, info];
      });
      setSelectedId(info.id);
    } catch (err) {
      if (isNotFound(err)) setMissing(true);
      else setError(messageOf(err));
    } finally {
      setCreating(false);
    }
  };

  const close = (t: TerminalInfo) => {
    if (!t.exited && !window.confirm(`Close "${t.title}"? The shell and anything running in it will be stopped.`)) return;
    remove(t.id);
  };

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const list = terminals ?? [];
    let next = -1;
    if (e.key === "ArrowRight") next = (index + 1) % list.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + list.length) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    else if (e.key === "Delete" && list[index]) {
      e.preventDefault();
      close(list[index]);
      return;
    }
    if (next < 0 || !list[next]) return;
    e.preventDefault();
    keepTabFocus.current = list[next].id !== selectedId;
    setSelectedId(list[next].id);
    tabRefs.current.get(list[next].id)?.focus();
  };

  if (!workspace.exists || missing) return <NoWorkspace />;

  const list = terminals ?? [];
  const selected = list.find((t) => t.id === selectedId) ?? null;
  const atLimit = list.length >= MAX_TERMINALS;
  const selectedConn = selected ? conn[selected.id] : undefined;
  const panelId = `terminal-panel-${taskId}`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center border-b bg-muted/30">
        <ScrollArea className="min-w-0 flex-1">
          <div role="tablist" aria-label="Terminals" className="flex h-9">
            {list.map((t, index) => {
              const isSelected = t.id === selectedId;
              return (
                <div
                  key={t.id}
                  className={cn(
                    "group flex shrink-0 items-center border-r text-[13px]",
                    isSelected ? "bg-background text-foreground" : "text-muted-foreground hover:bg-background/60",
                  )}
                  onMouseDown={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      close(t);
                    }
                  }}
                >
                  <button
                    ref={(el) => {
                      if (el) tabRefs.current.set(t.id, el);
                      else tabRefs.current.delete(t.id);
                    }}
                    type="button"
                    role="tab"
                    id={`terminal-tab-${t.id}`}
                    aria-selected={isSelected}
                    aria-controls={panelId}
                    tabIndex={isSelected ? 0 : -1}
                    title={`${t.title} · ${t.cwd}${t.exited ? ` · ${exitText(t.exitCode)}` : ""}`}
                    className={cn(
                      "flex h-full items-center gap-1.5 pr-1 pl-3 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
                      t.exited && "opacity-60",
                    )}
                    onClick={() => setSelectedId(t.id)}
                    onKeyDown={(e) => onTabKey(e, index)}
                  >
                    <SquareTerminal className="size-3.5 shrink-0" />
                    <span className="max-w-40 truncate">{t.title}</span>
                    {t.exited ? <span className="text-[11px] text-muted-foreground">{exitText(t.exitCode)}</span> : null}
                    {isSelected && conn[t.id] === "retrying" ? <Spinner className="size-3" /> : null}
                  </button>
                  <button
                    type="button"
                    aria-label={`Close ${t.title}`}
                    title={t.exited ? "Close" : "Close and stop the shell"}
                    className="mr-1 flex size-5 items-center justify-center rounded hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    onClick={() => close(t)}
                  >
                    <X className={cn("size-3.5", !isSelected && "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100")} />
                  </button>
                </div>
              );
            })}
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
        <div className="flex shrink-0 items-center gap-1 px-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={atLimit ? 0 : -1} className="inline-flex rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="New terminal"
                  disabled={creating || atLimit || terminals === null}
                  onClick={() => void create()}
                >
                  {creating ? <Spinner className="size-3.5" /> : <Plus />}
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>{atLimit ? `Close a terminal first (max ${MAX_TERMINALS})` : "New terminal"}</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
        <EyeOff className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">Your terminal in this task's worktree. The agent can't see it.</span>
        {selectedConn === "retrying" ? (
          <span role="status" className="shrink-0 text-amber-700 dark:text-amber-300">
            Reconnecting…
          </span>
        ) : null}
        <span className="hidden shrink-0 items-center gap-1 sm:inline-flex">
          <Kbd>⌘K</Kbd> clear
        </span>
      </div>
      {workspace.agentBusy ? (
        <div role="status" className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-800 dark:text-amber-200">
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
          <span>The agent is working in this folder right now; commands you run can collide with its changes.</span>
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">{error}</span>
          <button
            type="button"
            aria-label="Dismiss"
            className="flex size-5 items-center justify-center rounded hover:bg-destructive/15 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={() => setError(null)}
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}
      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={selected ? `terminal-tab-${selected.id}` : undefined}
        aria-label={selected ? undefined : "Terminal"}
        className="relative min-h-0 flex-1 overflow-hidden"
        style={{ background: theme.background }}
      >
        <div ref={body} className="absolute inset-0" />
        {terminals === null ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background">
            {loadError ? (
              <EmptyState
                icon={<SquareTerminal />}
                title="Couldn't open a terminal"
                action={
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      started.current = true;
                      void init();
                    }}
                  >
                    <RotateCcw /> Try again
                  </Button>
                }
              >
                {loadError}
              </EmptyState>
            ) : (
              <Spinner label="Starting terminal" />
            )}
          </div>
        ) : list.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background">
            <EmptyState
              icon={<SquareTerminal />}
              title="No terminals open"
              action={
                <Button size="sm" variant="outline" disabled={creating} onClick={() => void create()}>
                  {creating ? <Spinner className="size-3.5" /> : <Plus />} New terminal
                </Button>
              }
            >
              Open a shell in this task's worktree to run commands yourself.
            </EmptyState>
          </div>
        ) : null}
      </div>
      {selected?.exited ? (
        <div role="status" className="flex shrink-0 items-center gap-2 border-t bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">
            The shell {selected.exitCode === null ? "exited" : `exited with code ${selected.exitCode}`}.
          </span>
          <Button size="xs" variant="outline" disabled={creating} onClick={() => void create(selected)}>
            {creating ? <Spinner className="size-3" /> : <RotateCcw />} Restart
          </Button>
          <Button size="xs" variant="ghost" onClick={() => close(selected)}>
            Close
          </Button>
        </div>
      ) : null}
    </div>
  );
}
