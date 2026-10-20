import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TerminalInfo, TerminalStreamEvent } from "@nightshift/core";

const BRIDGE = `
import os, pty, select, sys, fcntl, termios, struct, signal
shell = os.environ.get("NS_SHELL") or "/bin/zsh"
pid, fd = pty.fork()
if pid == 0:
    os.execvp(shell, [shell, "-l"])
def resize(cols, rows):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        os.kill(pid, signal.SIGWINCH)
    except Exception:
        pass
resize(int(os.environ.get("NS_COLS", "100")), int(os.environ.get("NS_ROWS", "30")))
ctl = b""
inputs = [fd, 0, 3]
while True:
    try:
        r, _, _ = select.select(inputs, [], [])
    except InterruptedError:
        continue
    if fd in r:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        os.write(1, data)
    if 0 in r:
        data = os.read(0, 65536)
        if not data:
            inputs.remove(0)
        else:
            os.write(fd, data)
    if 3 in r:
        data = os.read(3, 4096)
        if not data:
            inputs.remove(3)
        else:
            ctl += data
            while b"\\n" in ctl:
                line, ctl = ctl.split(b"\\n", 1)
                parts = line.split()
                if len(parts) == 2:
                    resize(int(parts[0]), int(parts[1]))
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else (status >> 8))
`;

const MAX_SCROLLBACK = 1024 * 1024;
const MAX_PER_TASK = 5;

type Session = {
  info: TerminalInfo;
  projectId: string;
  taskId: string;
  child: ChildProcess;
  chunks: Buffer[];
  size: number;
  listeners: Set<(event: TerminalStreamEvent) => void>;
};

export class TerminalError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export class TerminalManager {
  private readonly sessions = new Map<string, Session>();
  private readonly pidFile: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.pidFile = path.join(dataDir, "terminals.json");
  }

  reapLeftovers() {
    if (!existsSync(this.pidFile)) return;
    try {
      for (const pid of JSON.parse(readFileSync(this.pidFile, "utf8")) as number[]) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {}
      }
    } catch {}
    writeFileSync(this.pidFile, "[]");
  }

  private savePids() {
    writeFileSync(this.pidFile, JSON.stringify([...this.sessions.values()].filter((s) => !s.info.exited && s.child.pid).map((s) => s.child.pid)));
  }

  list(projectId: string, taskId: string): TerminalInfo[] {
    return [...this.sessions.values()].filter((s) => s.projectId === projectId && s.taskId === taskId).map((s) => ({ ...s.info }));
  }

  private session(projectId: string, taskId: string, id: string) {
    const s = this.sessions.get(id);
    if (!s || s.projectId !== projectId || s.taskId !== taskId) throw new TerminalError("No such terminal", 404);
    return s;
  }

  create(projectId: string, taskId: string, cwd: string, env: Record<string, string>, size: { cols?: number; rows?: number }): TerminalInfo {
    const live = this.list(projectId, taskId).filter((t) => !t.exited);
    if (live.length >= MAX_PER_TASK) throw new TerminalError(`Close a terminal first (max ${MAX_PER_TASK})`);
    const shell = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : "/bin/zsh";
    const cols = clamp(size.cols, 20, 500, 100);
    const rows = clamp(size.rows, 5, 200, 30);
    const inherited = { ...process.env };
    for (const key of ["TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TERM_SESSION_ID", "SHELL_SESSION_ID", "ITERM_SESSION_ID", "VSCODE_INJECTION", "INSIDE_EMACS"]) delete inherited[key];
    const child = spawn("python3", ["-c", BRIDGE], {
      cwd,
      detached: true,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      env: {
        ...inherited,
        ...env,
        TERM_PROGRAM: "Nightshift",
        SHELL_SESSIONS_DISABLE: "1",
        NS_SHELL: shell,
        NS_COLS: String(cols),
        NS_ROWS: String(rows),
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        NIGHTSHIFT_TERMINAL: "1",
      },
    });
    const id = randomUUID().slice(0, 8);
    const index = this.list(projectId, taskId).length + 1;
    const session: Session = {
      info: { id, title: `Terminal ${index}`, cwd, shell: path.basename(shell), createdAt: new Date().toISOString(), exited: false, exitCode: null },
      projectId,
      taskId,
      child,
      chunks: [],
      size: 0,
      listeners: new Set(),
    };
    const onData = (chunk: Buffer) => {
      session.chunks.push(chunk);
      session.size += chunk.length;
      while (session.size > MAX_SCROLLBACK && session.chunks.length > 1) session.size -= session.chunks.shift()!.length;
      const event: TerminalStreamEvent = { type: "output", data: chunk.toString("base64") };
      for (const l of session.listeners) l(event);
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.on("exit", (code) => {
      session.info.exited = true;
      session.info.exitCode = code;
      for (const l of session.listeners) l({ type: "exit", code });
      this.savePids();
    });
    child.on("error", (error) => onData(Buffer.from(`\r\nCould not start the terminal: ${error.message}\r\n`)));
    this.sessions.set(id, session);
    this.savePids();
    return { ...session.info };
  }

  subscribe(projectId: string, taskId: string, id: string, listener: (event: TerminalStreamEvent) => void): () => void {
    const s = this.session(projectId, taskId, id);
    listener({ type: "reset" });
    for (const chunk of s.chunks) listener({ type: "output", data: chunk.toString("base64") });
    if (s.info.exited) listener({ type: "exit", code: s.info.exitCode });
    s.listeners.add(listener);
    return () => s.listeners.delete(listener);
  }

  input(projectId: string, taskId: string, id: string, data: string) {
    const s = this.session(projectId, taskId, id);
    if (s.info.exited) throw new TerminalError("This terminal has exited", 409);
    if (typeof data !== "string" || data.length > 256 * 1024) throw new TerminalError("Input is missing or too large");
    s.child.stdin!.write(data);
  }

  resize(projectId: string, taskId: string, id: string, cols: number, rows: number) {
    const s = this.session(projectId, taskId, id);
    if (s.info.exited) return;
    const ctl = s.child.stdio[3] as NodeJS.WritableStream | null;
    ctl?.write(`${clamp(cols, 20, 500, 100)} ${clamp(rows, 5, 200, 30)}\n`);
  }

  close(projectId: string, taskId: string, id: string) {
    const s = this.session(projectId, taskId, id);
    this.kill(s);
    this.sessions.delete(id);
    this.savePids();
  }

  closeTask(projectId: string, taskId: string) {
    for (const s of [...this.sessions.values()]) if (s.projectId === projectId && s.taskId === taskId) {
      this.kill(s);
      this.sessions.delete(s.info.id);
    }
    this.savePids();
  }

  closeAll() {
    for (const s of this.sessions.values()) this.kill(s);
    this.sessions.clear();
    this.savePids();
  }

  private kill(s: Session) {
    const pid = s.child.pid;
    if (!pid || s.info.exited) return;
    try {
      process.kill(-pid, "SIGHUP");
    } catch {}
    setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }, 2000).unref();
  }
}

function clamp(value: unknown, min: number, max: number, fallback: number) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
