import { spawn } from "node:child_process";

export type ExecResult = { code: number; stdout: string; stderr: string };

export function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = options.timeoutMs ? setTimeout(() => child.kill("SIGTERM"), options.timeoutMs) : undefined;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
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
