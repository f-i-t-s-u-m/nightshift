import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", ".nightshift", "spike-runs");
const worker = path.join(import.meta.dirname, "worker.ts");

function runWorker(scenario: string, dir: string, phase: string, killAfterMs?: number) {
  return new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    const child = spawn(process.execPath, [worker, scenario, dir, phase], { stdio: ["ignore", "inherit", "inherit"] });
    let timer: NodeJS.Timeout | undefined;
    if (killAfterMs !== undefined) timer = setTimeout(() => child.kill("SIGKILL"), killAfterMs);
    child.on("exit", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

const read = (dir: string, f: string) => (existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), "utf8") : null);

const scenarios: Array<{ name: string; killAfterMs?: number }> = [
  { name: "long-bash", killAfterMs: 2500 },
  { name: "pr-safe", killAfterMs: 2500 },
  { name: "pr-naive", killAfterMs: 2500 },
  { name: "steer" },
  { name: "dedupe" },
  { name: "parallel", killAfterMs: 2500 },
  { name: "confine" },
];

const only = process.argv[2];
for (const s of scenarios.filter((x) => !only || x.name === only)) {
  const dir = path.join(root, s.name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  console.log(`\n=== ${s.name}`);
  if (s.killAfterMs !== undefined) {
    const first = await runWorker(s.name, dir, "start", s.killAfterMs);
    console.log(`start phase exit: ${JSON.stringify(first)}`);
    if (s.name === "long-bash") {
      await new Promise((r) => setTimeout(r, 7000));
      console.log(`bash marker after kill (orphan check): ${JSON.stringify(read(dir, "bash-marker.txt"))}`);
    }
    const second = await runWorker(s.name, dir, "resume");
    console.log(`resume phase exit: ${JSON.stringify(second)}`);
    console.log(read(dir, "result-resume.json"));
  } else {
    const only = await runWorker(s.name, dir, "start");
    console.log(`exit: ${JSON.stringify(only)}`);
    console.log(read(dir, "result-start.json"));
  }
  const prs = read(dir, "prs.json");
  if (prs) console.log(`prs.json: ${prs}`);
}
