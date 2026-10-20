import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

type Proc = { pid: number; ppid: number };

function processTable(): Proc[] {
  const out = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  return out
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter(([pid, ppid]) => Number.isFinite(pid) && Number.isFinite(ppid))
    .map(([pid, ppid]) => ({ pid, ppid }));
}

function descendants(root: number, table: Proc[]): number[] {
  const out: number[] = [];
  const queue = [root];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const p of table) {
      if (p.ppid === parent) {
        out.push(p.pid);
        queue.push(p.pid);
      }
    }
  }
  return out;
}

export class ProcessReaper {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  fileFor(conversationId: string) {
    return path.join(this.dir, `${conversationId.replace(/[^a-zA-Z0-9._-]/g, "_")}.pids`);
  }

  wrap(command: string, conversationId: string) {
    const file = this.fileFor(conversationId).replace(/'/g, "'\\''");
    return `echo $$ >> '${file}'\n${command}`;
  }

  reapAll(): number[] {
    if (!existsSync(this.dir)) return [];
    const table = processTable();
    const killed: number[] = [];
    for (const name of readdirSync(this.dir)) {
      const file = path.join(this.dir, name);
      const pids = readFileSync(file, "utf8").split("\n").map(Number).filter((n) => n > 0);
      for (const pid of pids) {
        const proc = table.find((p) => p.pid === pid);
        if (!proc || proc.ppid !== 1) continue;
        for (const victim of [...descendants(pid, table).reverse(), pid]) {
          try {
            process.kill(victim, "SIGKILL");
            killed.push(victim);
          } catch {}
        }
      }
      rmSync(file, { force: true });
    }
    return killed;
  }

  note(conversationId: string, pid: number) {
    appendFileSync(this.fileFor(conversationId), `${pid}\n`);
  }
}
