import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type {
  CommitDiffResponse,
  FileContent,
  FileEntry,
  GitChange,
  GitCommit,
  GitDiffResponse,
  GitFileStatus,
  GitStatusResponse,
  PullBaseResponse,
} from "@nightshift/core";
import { run, runOk } from "./exec.ts";
import { authorEnv, type GitAuthor } from "./workspaces.ts";

const MAX_FILE = 1024 * 1024;

const LANGUAGES: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".md": "markdown",
  ".mdx": "markdown",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".sql": "sql",
  ".prisma": "prisma",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".sh": "shell",
  ".toml": "ini",
  ".env": "ini",
  ".svg": "xml",
  ".xml": "xml",
};

export const languageOf = (file: string) => LANGUAGES[path.extname(file).toLowerCase()] ?? (path.basename(file).startsWith(".env") ? "ini" : "plaintext");

export function resolveInside(root: string, rel: string): string {
  const clean = rel.replace(/^\/+/, "");
  const abs = path.resolve(root, clean);
  const relative = path.relative(root, abs);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw Object.assign(new Error("Path is outside the workspace"), { status: 400 });
  if (relative.split(path.sep)[0] === ".git") throw Object.assign(new Error("The .git folder is not accessible"), { status: 400 });
  return abs;
}

const isBinary = (buf: Buffer) => buf.subarray(0, 8000).includes(0);

function statusLetter(code: string): GitFileStatus {
  if (code === "M" || code === "T") return "modified";
  if (code === "A") return "added";
  if (code === "D") return "deleted";
  if (code === "R" || code === "C") return "renamed";
  if (code === "U") return "conflicted";
  return "modified";
}

export class WorktreeOps {
  constructor(
    readonly root: string,
    readonly remote: string,
    readonly baseBranch: string,
    readonly author: GitAuthor | (() => GitAuthor),
  ) {}

  private git(args: string[], input?: string) {
    return runOk("git", args, {
      cwd: this.root,
      input,
      env: {
        ...authorEnv(this.author),
        GIT_TERMINAL_PROMPT: "0",
      },
    });
  }

  exists() {
    return existsSync(path.join(this.root, ".git"));
  }

  async status(): Promise<GitStatusResponse> {
    const out = await this.git(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
    const parts = out.split("\0");
    let branch = "";
    let upstream: string | null = null;
    let ahead = 0;
    let behind = 0;
    const staged: GitChange[] = [];
    const unstaged: GitChange[] = [];
    for (let i = 0; i < parts.length; i++) {
      const line = parts[i];
      if (!line) continue;
      if (line.startsWith("# branch.head ")) branch = line.slice(14);
      else if (line.startsWith("# branch.upstream ")) upstream = line.slice(18);
      else if (line.startsWith("# branch.ab ")) {
        const m = line.match(/\+(\d+) -(\d+)/);
        if (m) [ahead, behind] = [Number(m[1]), Number(m[2])];
      } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
        const fields = line.split(" ");
        const xy = fields[1];
        const file = line.startsWith("1 ") ? fields.slice(8).join(" ") : fields.slice(9).join(" ");
        const oldPath = line.startsWith("2 ") ? parts[++i] : undefined;
        if (xy[0] !== ".") staged.push({ path: file, status: statusLetter(xy[0]), ...(oldPath ? { oldPath } : {}) });
        if (xy[1] !== ".") unstaged.push({ path: file, status: statusLetter(xy[1]) });
      } else if (line.startsWith("u ")) {
        unstaged.push({ path: line.split(" ").slice(10).join(" "), status: "conflicted" });
      } else if (line.startsWith("? ")) {
        unstaged.push({ path: line.slice(2), status: "untracked" });
      }
    }
    if (branch && branch !== "(detached)") {
      const tracking = `refs/remotes/${this.remote}/${branch}`;
      const has = await run("git", ["rev-parse", "--verify", "--quiet", tracking], { cwd: this.root });
      if (has.code === 0) {
        const counts = await run("git", ["rev-list", "--left-right", "--count", `${tracking}...HEAD`], { cwd: this.root });
        const [b, a] = counts.stdout.trim().split(/\s+/).map(Number);
        if (Number.isFinite(a) && Number.isFinite(b)) [ahead, behind, upstream] = [a, b, `${this.remote}/${branch}`];
      } else {
        const base = await run("git", ["rev-list", "--count", `${this.remote}/${this.baseBranch}..HEAD`], { cwd: this.root });
        [ahead, behind, upstream] = [Number(base.stdout.trim()) || 0, 0, null];
      }
    }
    const baseRef = `refs/remotes/${this.remote}/${this.baseBranch}`;
    const baseCount = await run("git", ["rev-list", "--count", `HEAD..${baseRef}`], { cwd: this.root });
    const baseBehind = baseCount.code === 0 ? Number(baseCount.stdout.trim()) || 0 : 0;
    return { branch, upstream, ahead, behind, baseBranch: this.baseBranch, baseBehind, staged, unstaged };
  }

  async pullBase(): Promise<PullBaseResponse> {
    const env = { ...authorEnv(this.author), GIT_TERMINAL_PROMPT: "0" };
    const baseRef = `${this.remote}/${this.baseBranch}`;
    const fetched = await run("git", ["fetch", "--quiet", this.remote, `+${this.baseBranch}:refs/remotes/${baseRef}`], { cwd: this.root, env, timeoutMs: 5 * 60_000 });
    if (fetched.code !== 0) throw Object.assign(new Error(`Could not fetch ${baseRef}: ${(fetched.stderr || fetched.stdout).trim().slice(-300)}`), { status: 400 });
    const count = Number((await run("git", ["rev-list", "--count", `HEAD..${baseRef}`], { cwd: this.root })).stdout.trim()) || 0;
    const head = async () => (await run("git", ["rev-parse", "HEAD"], { cwd: this.root })).stdout.trim();
    if (count === 0) return { baseBranch: this.baseBranch, merged: 0, upToDate: true, sha: await head() };
    const branch = (await run("git", ["branch", "--show-current"], { cwd: this.root })).stdout.trim();
    const merged = await run("git", ["merge", "--no-edit", "-m", `Merge ${baseRef} into ${branch || "HEAD"}`, baseRef], { cwd: this.root, env, timeoutMs: 5 * 60_000 });
    if (merged.code !== 0) {
      const conflicts = (await run("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: this.root })).stdout.split("\n").filter(Boolean);
      if (conflicts.length || (await run("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: this.root })).code === 0) {
        await run("git", ["merge", "--abort"], { cwd: this.root });
        throw Object.assign(new Error(`${baseRef} conflicts with this task's changes in ${conflicts.length} file${conflicts.length === 1 ? "" : "s"}. Nothing was changed.`), {
          status: 409,
          code: "conflict",
          conflicts,
          baseBranch: this.baseBranch,
        });
      }
      throw Object.assign(new Error(`Could not merge ${baseRef}: ${(merged.stderr || merged.stdout).trim().slice(-400)}. Commit or discard your changes first.`), {
        status: 409,
        code: "dirty",
        conflicts: [],
        baseBranch: this.baseBranch,
      });
    }
    return { baseBranch: this.baseBranch, merged: count, upToDate: false, sha: await head() };
  }

  create(rel: string, kind: "file" | "folder") {
    const clean = rel.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    if (!clean || clean.split("/").some((part) => part === "" || part === "." || part === "..")) throw Object.assign(new Error("Give a name like src/new-file.ts"), { status: 400 });
    if (clean.split("/").some((part) => /[\0<>:"|?*]/.test(part))) throw Object.assign(new Error("That name has characters that are not allowed"), { status: 400 });
    const abs = resolveInside(this.root, clean);
    if (existsSync(abs)) throw Object.assign(new Error(`${clean} already exists`), { status: 409 });
    if (kind === "folder") mkdirSync(abs, { recursive: true });
    else {
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, "", { flag: "wx" });
    }
    return { path: clean, kind };
  }

  async fileStatuses(): Promise<Map<string, GitFileStatus>> {
    const s = await this.status();
    const map = new Map<string, GitFileStatus>();
    for (const c of [...s.staged, ...s.unstaged]) map.set(c.path, c.status);
    return map;
  }

  async list(dir: string): Promise<FileEntry[]> {
    const abs = resolveInside(this.root, dir || ".");
    const statuses = await this.fileStatuses();
    const entries = readdirSync(abs, { withFileTypes: true })
      .filter((d) => d.name !== ".git")
      .map((d): FileEntry => {
        const rel = path.relative(this.root, path.join(abs, d.name)).split(path.sep).join("/");
        const type = d.isDirectory() ? "dir" : "file";
        let git: GitFileStatus | undefined;
        if (type === "file") git = statuses.get(rel);
        else for (const [p, s] of statuses) if (p.startsWith(`${rel}/`)) git ??= s;
        const size = type === "file" ? statSync(path.join(abs, d.name), { throwIfNoEntry: false })?.size : undefined;
        return { name: d.name, path: rel, type, ...(size !== undefined ? { size } : {}), ...(git ? { git } : {}) };
      });
    return entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  }

  read(file: string): FileContent {
    const abs = resolveInside(this.root, file);
    if (!existsSync(abs) || statSync(abs).isDirectory()) throw Object.assign(new Error("File not found"), { status: 404 });
    const size = statSync(abs).size;
    if (size > MAX_FILE) return { path: file, content: "", binary: false, size, language: languageOf(file), tooLarge: true };
    const buf = readFileSync(abs);
    const binary = isBinary(buf);
    return { path: file, content: binary ? "" : buf.toString("utf8"), binary, size, language: languageOf(file), tooLarge: false };
  }

  write(file: string, content: string) {
    const abs = resolveInside(this.root, file);
    if (Buffer.byteLength(content) > MAX_FILE) throw Object.assign(new Error("File is larger than 1 MB"), { status: 413 });
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }

  private async show(spec: string): Promise<{ text: string; binary: boolean }> {
    const res = await run("git", ["show", spec], { cwd: this.root });
    if (res.code !== 0) return { text: "", binary: false };
    const binary = res.stdout.includes("\0");
    return { text: binary ? "" : res.stdout, binary };
  }

  async diff(file: string, staged: boolean): Promise<GitDiffResponse> {
    resolveInside(this.root, file);
    const original = await this.show(`HEAD:${file}`);
    let modified: { text: string; binary: boolean };
    if (staged) modified = await this.show(`:${file}`);
    else {
      const abs = path.join(this.root, file);
      if (existsSync(abs)) {
        const buf = readFileSync(abs);
        modified = { text: isBinary(buf) ? "" : buf.toString("utf8"), binary: isBinary(buf) };
      } else modified = { text: "", binary: false };
      if (!staged) {
        const index = await this.show(`:${file}`);
        if (index.text || index.binary) Object.assign(original, index);
      }
    }
    return { path: file, staged, original: original.text, modified: modified.text, language: languageOf(file), binary: original.binary || modified.binary };
  }

  async stage(paths: string[]) {
    paths.forEach((p) => resolveInside(this.root, p));
    if (paths.length) await this.git(["add", "--", ...paths]);
  }

  async unstage(paths: string[]) {
    paths.forEach((p) => resolveInside(this.root, p));
    if (paths.length) await this.git(["restore", "--staged", "--", ...paths]);
  }

  async discard(paths: string[]) {
    paths.forEach((p) => resolveInside(this.root, p));
    const status = await this.status();
    const untracked = new Set(status.unstaged.filter((c) => c.status === "untracked").map((c) => c.path));
    const tracked = paths.filter((p) => !untracked.has(p));
    const fresh = paths.filter((p) => untracked.has(p));
    if (tracked.length) await this.git(["restore", "--worktree", "--", ...tracked]);
    if (fresh.length) await this.git(["clean", "-f", "--", ...fresh]);
  }

  async commit(message: string): Promise<string> {
    if (!message.trim()) throw Object.assign(new Error("Write a commit message"), { status: 400 });
    const status = await this.status();
    if (!status.staged.length) throw Object.assign(new Error("Nothing is staged"), { status: 400 });
    await this.git(["commit", "--quiet", "--no-verify", "-F", "-"], message);
    return (await this.git(["rev-parse", "HEAD"])).trim();
  }

  async commitDiff(sha: string): Promise<CommitDiffResponse> {
    if (!/^[0-9a-f]{4,40}$/i.test(sha)) throw Object.assign(new Error("Not a commit id"), { status: 400 });
    const subject = (await this.git(["log", "-1", "--format=%s", sha])).trim();
    const parent = (await run("git", ["rev-parse", "--verify", "--quiet", `${sha}^`], { cwd: this.root })).stdout.trim();
    const names = await this.git(["show", "--format=", "--name-status", "-M", sha]);
    const files = [];
    for (const line of names.split("\n").filter(Boolean).slice(0, 80)) {
      const [code, a, b] = line.split("\t");
      const status = statusLetter(code[0]);
      const file = b ?? a;
      const oldPath = b ? a : undefined;
      const original = parent && status !== "added" ? await this.show(`${parent}:${oldPath ?? file}`) : { text: "", binary: false };
      const modified = status !== "deleted" ? await this.show(`${sha}:${file}`) : { text: "", binary: false };
      const tooLarge = original.text.length > MAX_FILE || modified.text.length > MAX_FILE;
      files.push({
        path: file,
        ...(oldPath ? { oldPath } : {}),
        status,
        original: tooLarge ? "" : original.text,
        modified: tooLarge ? "" : modified.text,
        language: languageOf(file),
        binary: original.binary || modified.binary,
        tooLarge,
      });
    }
    return { sha, subject, files };
  }

  async log(branch: string, limit = 50): Promise<GitCommit[]> {
    const range = `${this.remote}/${this.baseBranch}..HEAD`;
    const out = await this.git(["log", range, `-n${limit}`, "--format=%x1e%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%b%x1f", "--name-status"]);
    const remoteHead = (await run("git", ["rev-parse", "--verify", "--quiet", `refs/remotes/${this.remote}/${branch}`], { cwd: this.root })).stdout.trim();
    const pushedSet = new Set<string>();
    if (remoteHead) {
      const list = await run("git", ["rev-list", remoteHead, `^${this.remote}/${this.baseBranch}`], { cwd: this.root });
      for (const sha of list.stdout.split("\n")) if (sha) pushedSet.add(sha);
    }
    const commits: GitCommit[] = [];
    for (const record of out.split("\u001e")) {
      if (!record.trim()) continue;
      const [sha, shortSha, subject, author, date, body, names = ""] = record.split("\u001f");
      const files = names
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /^[AMDRTCU]\d*\t/.test(l))
        .map((l) => {
          const [code, ...parts] = l.split("\t");
          return { path: parts.at(-1)!, status: statusLetter(code[0]) };
        });
      commits.push({ sha, shortSha, subject, body: body.trim(), author, date, pushed: pushedSet.has(sha), files });
    }
    return commits;
  }
}
