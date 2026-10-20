import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { run, runOk } from "./exec.ts";

export type GitAuthor = { name: string; email: string };

export function authorEnv(author: GitAuthor | (() => GitAuthor)) {
  const a = typeof author === "function" ? author() : author;
  return { GIT_AUTHOR_NAME: a.name, GIT_AUTHOR_EMAIL: a.email, GIT_COMMITTER_NAME: a.name, GIT_COMMITTER_EMAIL: a.email };
}

export class Workspaces {
  private lock: Promise<unknown> = Promise.resolve();

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => {});
    return next;
  }

  constructor(
    readonly repoPath: string,
    readonly workspacesDir: string,
    readonly remote: string,
    readonly baseBranch: string,
    readonly author: GitAuthor | (() => GitAuthor),
  ) {}

  private git(cwd: string, args: string[]) {
    return runOk("git", args, {
      cwd,
      env: {
        ...authorEnv(this.author),
        GIT_TERMINAL_PROMPT: "0",
      },
    });
  }

  pathFor(taskId: string) {
    return path.join(this.workspacesDir, taskId.replace(/[^a-zA-Z0-9._-]/g, "_"));
  }

  /** `from`: the remote branch a new `branch` starts from (default `base`). */
  ensure(taskId: string, branch: string, base = this.baseBranch, from?: string): Promise<string> {
    return this.serialized(() => this.ensureUnlocked(taskId, branch, base, from));
  }

  private async ensureUnlocked(taskId: string, branch: string, base: string, from?: string): Promise<string> {
    const dir = this.pathFor(taskId);
    if (existsSync(path.join(dir, ".git"))) return dir;
    mkdirSync(this.workspacesDir, { recursive: true });
    await this.git(this.repoPath, ["fetch", "--quiet", this.remote, `+${base}:refs/remotes/${this.remote}/${base}`]);
    await this.git(this.repoPath, ["worktree", "prune"]);
    const remoteBranch = await run("git", ["ls-remote", "--heads", this.remote, branch], { cwd: this.repoPath });
    if (remoteBranch.stdout.trim()) {
      await this.git(this.repoPath, ["fetch", "--quiet", this.remote, `${branch}:refs/remotes/${this.remote}/${branch}`]);
      await this.git(this.repoPath, ["worktree", "add", "--quiet", "-B", branch, dir, `${this.remote}/${branch}`]);
    } else {
      const start = from && from !== base ? from : base;
      if (start !== base) await this.git(this.repoPath, ["fetch", "--quiet", this.remote, `+${start}:refs/remotes/${this.remote}/${start}`]);
      await this.git(this.repoPath, ["worktree", "add", "--quiet", "-B", branch, dir, `${this.remote}/${start}`]);
    }
    return dir;
  }

  async headSha(dir: string): Promise<string> {
    return (await this.git(dir, ["rev-parse", "HEAD"])).trim();
  }

  async hasChanges(dir: string): Promise<boolean> {
    return (await this.git(dir, ["status", "--porcelain"])).trim().length > 0;
  }

  private async commitAllUnlocked(dir: string, message: string): Promise<string | null> {
    if (!(await this.hasChanges(dir))) return null;
    await this.git(dir, ["add", "-A"]);
    await this.git(dir, ["commit", "--quiet", "--no-verify", "-m", message]);
    return this.headSha(dir);
  }

  async listRemoteBranches(): Promise<Array<{ name: string; sha: string }>> {
    const out = await runOk("git", ["ls-remote", "--heads", this.remote], { cwd: this.repoPath, timeoutMs: 30_000, env: { GIT_TERMINAL_PROMPT: "0" } });
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, ref] = line.split(/\s+/);
        return { name: ref.replace(/^refs\/heads\//, ""), sha };
      });
  }

  async aheadOfBase(dir: string, base = this.baseBranch): Promise<number> {
    const out = await this.git(dir, ["rev-list", "--count", `${this.remote}/${base}..HEAD`]);
    return Number(out.trim());
  }

  async remoteHead(branch: string): Promise<string | null> {
    const out = await run("git", ["ls-remote", "--heads", this.remote, branch], { cwd: this.repoPath });
    const sha = out.stdout.trim().split(/\s+/)[0];
    return sha || null;
  }

  push(dir: string, branch: string): Promise<{ pushed: boolean; sha: string }> {
    return this.serialized(async () => {
      const sha = await this.headSha(dir);
      if ((await this.remoteHead(branch)) === sha) return { pushed: false, sha };
      await this.git(dir, ["push", "--quiet", "--force-with-lease", this.remote, `HEAD:refs/heads/${branch}`]);
      return { pushed: true, sha };
    });
  }

  commitAll(dir: string, message: string): Promise<string | null> {
    return this.serialized(() => this.commitAllUnlocked(dir, message));
  }

  async diffStat(dir: string, base = this.baseBranch): Promise<string> {
    return (await this.git(dir, ["diff", "--stat", `${this.remote}/${base}...HEAD`])).trim();
  }

  async remove(dir: string) {
    await run("git", ["worktree", "remove", "--force", dir], { cwd: this.repoPath });
  }
}
