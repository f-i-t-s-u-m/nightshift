import { execFile, spawn } from "node:child_process";

export type ExecResult = { code: number; stdout: string; stderr: string };

/** Most processes a `group` command may run at once before it is stopped as a runaway. */
export const MAX_PROCESSES = 500;

function processTable(): Promise<Map<number, number> | null> {
  return new Promise((resolve) =>
    execFile("ps", ["-A", "-o", "pid=,ppid="], { maxBuffer: 16 << 20 }, (err, out) => {
      if (err) return resolve(null);
      const table = new Map<number, number>();
      for (const line of out.split("\n")) {
        const [pid, ppid] = line.trim().split(/\s+/).map(Number);
        if (pid > 0 && Number.isFinite(ppid)) table.set(pid, ppid);
      }
      resolve(table);
    }),
  );
}

/** Adds every live descendant of `tracked` to it and drops the pids that are gone. Orphans keep their place because their pid was seen earlier. */
function grow(tracked: Set<number>, table: Map<number, number>) {
  for (const pid of tracked) if (!table.has(pid)) tracked.delete(pid);
  let added = true;
  while (added) {
    added = false;
    for (const [pid, ppid] of table) {
      if (!tracked.has(pid) && tracked.has(ppid)) {
        tracked.add(pid);
        added = true;
      }
    }
  }
}

/** Freezes the tree first so a process cannot start a new child between the scan and the kill, then kills it. */
async function killTree(tracked: Set<number>) {
  for (let i = 0; i < 5 && tracked.size; i++) {
    const table = await processTable();
    if (!table) break;
    const before = tracked.size;
    grow(tracked, table);
    for (const pid of tracked) {
      try {
        process.kill(pid, "SIGSTOP");
      } catch {}
    }
    if (i > 0 && tracked.size === before) break;
  }
  for (const pid of tracked) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  tracked.clear();
}

export function run(
  command: string,
  args: string[],
  /**
   * `signal`: aborting stops the command. `group`: run it in its own process group and stop the whole group
   * (a `sh -c "cd x && tool"` passes SIGTERM to nothing), SIGKILL 10 s later if it is still there. A group command
   * is also watched as a process tree, because tools like turbo start each task in a new process group: whatever it
   * leaves running when it exits is killed, and it is stopped if more than MAX_PROCESSES run at once (a script that
   * calls itself, like `"lint": "turbo lint"` inside a turbo package, otherwise spawns until memory runs out).
   */
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string; signal?: AbortSignal; group?: boolean } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: Boolean(options.group),
    });
    let stdout = "";
    let stderr = "";
    let exited = false;
    const kill = (signal: NodeJS.Signals) => {
      if (exited) return;
      try {
        if (options.group && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {}
    };
    const stop = () => {
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 10_000).unref();
    };
    const timer = options.timeoutMs ? setTimeout(stop, options.timeoutMs) : undefined;
    if (options.signal?.aborted) stop();
    options.signal?.addEventListener("abort", stop, { once: true });
    const tracked = new Set<number>(options.group && child.pid ? [child.pid] : []);
    let sampling = false;
    let reaped = false;
    const sampler = tracked.size
      ? setInterval(async () => {
          if (sampling || reaped) return;
          sampling = true;
          const table = await processTable();
          sampling = false;
          if (!table || reaped) return;
          grow(tracked, table);
          if (tracked.size > MAX_PROCESSES) {
            stderr += `\n[nightshift] Stopped: the command was running more than ${MAX_PROCESSES} processes at once. A script that calls itself (for example "lint": "turbo lint" inside a turbo package) does this.\n`;
            reaped = true;
            void killTree(tracked);
          }
        }, 500)
      : undefined;
    sampler?.unref();
    child.on("exit", () => {
      exited = true;
      if (sampler) clearInterval(sampler);
      if (tracked.size && !reaped) {
        reaped = true;
        void killTree(tracked);
      }
    });
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export async function runOk(command: string, args: string[], options: Parameters<typeof run>[2] = {}): Promise<string> {
  const result = await run(command, args, options);
  if (result.code !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout;
}
