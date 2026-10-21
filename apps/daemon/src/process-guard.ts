import { execFile } from "node:child_process";
import { readlinkSync } from "node:fs";
import { totalmem } from "node:os";
import { killTree } from "@nightshift/git";

/**
 * Watches every process Nightshift starts (agent commands, checks, testers, setup, previews, terminals) and stops a
 * runaway tree before it takes the machine down. Imported projects' scripts cannot be trusted to be sane: a package
 * whose `"lint": "turbo lint"` calls itself spawned ~1,200 turbo processes and exhausted memory twice (D37).
 *
 * Processes are remembered once seen, so a tree keeps being watched after its parent exits and launchd adopts it.
 */

type Proc = { pid: number; ppid: number; rss: number; command: string };

export type Runaway = { pid: number; command: string; cwd: string | null; processes: number; memoryBytes: number; reason: string };

/** The same command running inside itself this many times is a script that calls itself. */
export const RECURSION_DEPTH = 5;
/** Most processes one tree may run at once. */
export const MAX_TREE_PROCESSES = 800;
/** Largest share of the machine's memory one tree may hold. */
export const MAX_TREE_MEMORY_SHARE = 0.4;

function processTable(): Promise<Proc[] | null> {
  return new Promise((resolve) =>
    execFile("ps", ["-A", "-o", "pid=,ppid=,rss=,command="], { maxBuffer: 64 << 20 }, (err, out) => {
      if (err) return resolve(null);
      const procs: Proc[] = [];
      for (const line of out.split("\n")) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]) * 1024, command: m[4].trim() });
      }
      resolve(procs);
    }),
  );
}

function cwdOf(pid: number): Promise<string | null> {
  try {
    return Promise.resolve(readlinkSync(`/proc/${pid}/cwd`));
  } catch {}
  return new Promise((resolve) =>
    execFile("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], (err, out) => {
      const line = err ? undefined : out.split("\n").find((l) => l.startsWith("n"));
      resolve(line ? line.slice(1) : null);
    }),
  );
}

export class ProcessGuard {
  private readonly tracked = new Set<number>();
  private timer: NodeJS.Timeout | undefined;
  private busy = false;

  constructor(
    private readonly onRunaway: (runaway: Runaway) => void,
    private readonly root = process.pid,
    private readonly intervalMs = 1000,
  ) {}

  start() {
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const procs = await processTable();
      if (procs) await this.check(procs);
    } finally {
      this.busy = false;
    }
  }

  private async check(procs: Proc[]) {
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    const children = new Map<number, number[]>();
    for (const p of procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p.pid]);
    for (const pid of this.tracked) if (!byPid.has(pid)) this.tracked.delete(pid);
    const queue = [this.root, ...this.tracked];
    while (queue.length) {
      for (const child of children.get(queue.pop()!) ?? []) {
        if (child === this.root || this.tracked.has(child)) continue;
        this.tracked.add(child);
        queue.push(child);
      }
    }

    const victims = new Map<number, string>();
    for (const pid of this.tracked) {
      const command = byPid.get(pid)!.command;
      let same = 1;
      let top = pid;
      let up = byPid.get(pid)!.ppid;
      for (let steps = 0; steps < 64 && this.tracked.has(up); steps++) {
        const parent = byPid.get(up)!;
        if (parent.command === command) {
          same++;
          top = up;
        }
        up = parent.ppid;
      }
      if (same >= RECURSION_DEPTH && !victims.has(top)) victims.set(top, `the command runs inside itself (${same} levels deep): a script that calls itself`);
    }

    const memoryLimit = totalmem() * MAX_TREE_MEMORY_SHARE;
    for (const pid of this.tracked) {
      const parent = byPid.get(pid)!.ppid;
      if (parent !== this.root && this.tracked.has(parent)) continue;
      const { processes, memoryBytes } = this.measure(pid, byPid, children);
      if (processes > MAX_TREE_PROCESSES) victims.set(pid, `it was running ${processes} processes (limit ${MAX_TREE_PROCESSES})`);
      else if (memoryBytes > memoryLimit) victims.set(pid, `it held ${(memoryBytes / 2 ** 30).toFixed(1)} GB of memory (limit ${Math.round(MAX_TREE_MEMORY_SHARE * 100)}% of this machine)`);
    }

    for (const [pid, reason] of victims) {
      const proc = byPid.get(pid);
      if (!proc || !this.tracked.has(pid)) continue;
      const { processes, memoryBytes } = this.measure(pid, byPid, children);
      const cwd = await cwdOf(pid);
      await killTree(new Set([pid]));
      for (const gone of this.subtree(pid, children)) this.tracked.delete(gone);
      this.onRunaway({ pid, command: proc.command, cwd, processes, memoryBytes, reason });
    }
  }

  private subtree(pid: number, children: Map<number, number[]>) {
    const out = [pid];
    for (let i = 0; i < out.length; i++) for (const c of children.get(out[i]) ?? []) if (this.tracked.has(c)) out.push(c);
    return out;
  }

  private measure(pid: number, byPid: Map<number, Proc>, children: Map<number, number[]>) {
    const members = this.subtree(pid, children);
    return { processes: members.length, memoryBytes: members.reduce((sum, p) => sum + (byPid.get(p)?.rss ?? 0), 0) };
  }
}
