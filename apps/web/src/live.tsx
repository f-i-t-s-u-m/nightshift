import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ProjectSummary, Run, ServerEvent, StatusResponse } from "@nightshift/core";
import { api, messageOf, ROUTES } from "./api";

export type Connection = "connecting" | "live" | "polling" | "offline";

type Listener = (event: ServerEvent) => void;

type LiveState = {
  status: StatusResponse | null;
  runs: Record<string, Run> | null;
  projects: ProjectSummary[] | null;
  projectsError: string | null;
  refreshProjects: () => Promise<void>;
  connection: Connection;
  lastError: string | null;
  lastUpdate: number | null;
  refresh: () => Promise<boolean>;
  patchStatus: (patch: Partial<StatusResponse>) => void;
  subscribe: (listener: Listener) => () => void;
};

const LiveContext = createContext<LiveState | null>(null);

const POLL_MS = 5000;
const STREAM_RETRY_EVERY = 3;

const indexRuns = (runs: Run[]) => Object.fromEntries(runs.map((r) => [r.id, r]));

const parseEvent = (raw: string): ServerEvent | null => {
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object" && "type" in value) return value as ServerEvent;
  } catch {
    return null;
  }
  return null;
};

export function LiveProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [runs, setRuns] = useState<Record<string, Run> | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const listeners = useRef(new Set<Listener>());
  const projectsTimer = useRef<number | undefined>(undefined);

  const refreshProjects = useCallback(async () => {
    try {
      const res = await api.projects();
      setProjects(res.projects);
      setProjectsError(null);
    } catch (err) {
      setProjectsError(messageOf(err));
    }
  }, []);

  const scheduleProjects = useCallback(() => {
    if (projectsTimer.current !== undefined) return;
    projectsTimer.current = window.setTimeout(() => {
      projectsTimer.current = undefined;
      void refreshProjects();
    }, 400);
  }, [refreshProjects]);

  const refresh = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([api.status(), api.runs()]);
      void refreshProjects();
      setStatus(s);
      setRuns(indexRuns(r.runs));
      setLastError(null);
      setLastUpdate(Date.now());
      return true;
    } catch (err) {
      setLastError(messageOf(err));
      return false;
    }
  }, [refreshProjects]);

  const patchStatus = useCallback((patch: Partial<StatusResponse>) => {
    setStatus((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const subscribe = useCallback((listener: Listener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let stream: EventSource | null = null;
    let pollTimer: number | undefined;
    let pollCount = 0;

    const dispatch = (event: ServerEvent) => {
      if (event.type === "status") setStatus(event.status);
      if (event.type === "run") setRuns((prev) => ({ ...(prev ?? {}), [event.run.id]: event.run }));
      if (event.type === "projects" || event.type === "task" || event.type === "run") scheduleProjects();
      setLastUpdate(Date.now());
      for (const listener of listeners.current) listener(event);
    };

    const stopPolling = () => {
      if (pollTimer !== undefined) window.clearInterval(pollTimer);
      pollTimer = undefined;
    };

    const openStream = () => {
      if (disposed || stream || typeof EventSource === "undefined") return;
      const es = new EventSource(ROUTES.events);
      stream = es;
      es.onopen = () => {
        if (disposed) return;
        setConnection("live");
        stopPolling();
        void refresh();
      };
      es.onmessage = (msg) => {
        const event = parseEvent(msg.data);
        if (event) dispatch(event);
      };
      es.onerror = () => {
        es.close();
        if (stream === es) stream = null;
        if (!disposed) startPolling();
      };
    };

    const poll = async () => {
      const ok = await refresh();
      if (disposed) return;
      setConnection(ok ? "polling" : "offline");
      if (ok && !stream && pollCount % STREAM_RETRY_EVERY === 0) openStream();
      pollCount += 1;
    };

    function startPolling() {
      if (pollTimer !== undefined || disposed) return;
      pollCount = 0;
      void poll();
      pollTimer = window.setInterval(() => void poll(), POLL_MS);
    }

    startPolling();

    return () => {
      disposed = true;
      stopPolling();
      stream?.close();
      stream = null;
    };
  }, [refresh, scheduleProjects]);

  const value = useMemo<LiveState>(
    () => ({ status, runs, projects, projectsError, refreshProjects, connection, lastError, lastUpdate, refresh, patchStatus, subscribe }),
    [status, runs, projects, projectsError, refreshProjects, connection, lastError, lastUpdate, refresh, patchStatus, subscribe],
  );

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): LiveState {
  const ctx = useContext(LiveContext);
  if (!ctx) throw new Error("useLive must be used inside LiveProvider");
  return ctx;
}

export function useServerEvents(listener: Listener) {
  const { subscribe } = useLive();
  const ref = useRef(listener);
  useEffect(() => {
    ref.current = listener;
  });
  useEffect(() => subscribe((event) => ref.current(event)), [subscribe]);
}

export function useDebouncedRefresh(match: (event: ServerEvent) => boolean, refresh: () => void, delayMs = 300) {
  const timer = useRef<number | undefined>(undefined);
  const matchRef = useRef(match);
  const refreshRef = useRef(refresh);
  useEffect(() => {
    matchRef.current = match;
    refreshRef.current = refresh;
  });
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useServerEvents((event) => {
    if (!matchRef.current(event)) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => refreshRef.current(), delayMs);
  });
}
