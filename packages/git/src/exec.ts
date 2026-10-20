import { spawn } from "node:child_process";

export type ExecResult = { code: number; stdout: string; stderr: string };

export function run(
  command: string,
  args: string[],
  /**
   * `signal`: aborting stops the command. `group`: run it in its own process group and stop the whole group
   * (a `sh -c "cd x && tool"` passes SIGTERM to nothing), SIGKILL 10 s later if it is still there.
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
    child.on("exit", () => (exited = true));
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
