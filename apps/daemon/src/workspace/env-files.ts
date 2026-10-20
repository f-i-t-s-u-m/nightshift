import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureIgnored } from "./local-files.ts";

/** The files Vite, Next.js and Bun load in development, in the order they override each other. The environment wins over them. */
export const STANDARD_ENV_FILES = [".env", ".env.development", ".env.local", ".env.development.local"];

const ENV_NAME = /(^|[._-])env([._-]|$)|^\.dev\.vars$/i;
const NOT_ENV = /(example|sample|template|schema|\.d\.ts|\.[cm]?[jt]sx?|\.json|\.md)$/i;
const LOADER = /\.(c|m)?[jt]s$|^package\.json$/;

/** Env-style files directly in `dir`: the standard ones plus names like `.public.env.local` or `.dev.vars`. */
export function envFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found = readdirSync(dir).filter((name) => {
    if (!ENV_NAME.test(name) || NOT_ENV.test(name)) return false;
    try {
      const st = statSync(path.join(dir, name));
      return st.isFile() && st.size < 256 * 1024;
    } catch {
      return false;
    }
  });
  return [...STANDARD_ENV_FILES.filter((f) => found.includes(f)), ...found.filter((f) => !STANDARD_ENV_FILES.includes(f)).sort()];
}

/** Which config or script files directly in `dir` mention each env file by name (they may load it over the environment). */
export function loadersOf(dir: string, names: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = Object.fromEntries(names.map((n) => [n, []]));
  if (!existsSync(dir) || !names.length) return out;
  for (const file of readdirSync(dir).filter((f) => LOADER.test(f)).slice(0, 60)) {
    let text = "";
    try {
      const full = path.join(dir, file);
      if (statSync(full).size > 200 * 1024) continue;
      text = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    for (const name of names) {
      // `.public.env.local` is often built as `.public.env.${mode}`, so its stem counts too (when it is distinctive).
      const stem = name.replace(/\.[^.]+$/, "");
      if (text.includes(name) || (stem.length > 5 && text.includes(stem))) out[name]!.push(file);
    }
  }
  return out;
}

const quote = (value: string) => (/[\s#"'`$\\]/.test(value) ? JSON.stringify(value) : value);

/** Sets `key` in dotenv text: replaces its first line (keeping `export`), or appends it. */
export function setDotenvValue(text: string, key: string, value: string): string {
  const line = new RegExp(`^(\\s*(?:export\\s+)?${key}\\s*=).*$`, "m");
  if (line.test(text)) return text.replace(line, (_m, head: string) => `${head}${quote(value)}`);
  return `${text}${text && !text.endsWith("\n") ? "\n" : ""}${key}=${quote(value)}\n`;
}

type Manifest = Record<string, { tracked: boolean }>;

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });

const slug = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, "_");

/**
 * Writes Nightshift's values into env files in a task's workspace. The original is kept under the data dir,
 * tracked files are marked skip-worktree so neither the agent nor Nightshift commits the edit, untracked ones
 * are added to git's info/exclude. `restore` puts every original back (needed before merging the base branch).
 */
export class EnvFileOverlays {
  constructor(private readonly dataDir: string) {}

  private dir(projectId: string, taskId: string) {
    return path.join(this.dataDir, slug(projectId), slug(taskId));
  }

  private manifest(projectId: string, taskId: string): Manifest {
    const file = path.join(this.dir(projectId, taskId), "manifest.json");
    try {
      return JSON.parse(readFileSync(file, "utf8")) as Manifest;
    } catch {
      return {};
    }
  }

  private saveManifest(projectId: string, taskId: string, manifest: Manifest) {
    mkdirSync(this.dir(projectId, taskId), { recursive: true });
    writeFileSync(path.join(this.dir(projectId, taskId), "manifest.json"), JSON.stringify(manifest));
  }

  private backup(projectId: string, taskId: string, rel: string) {
    return path.join(this.dir(projectId, taskId), "originals", rel);
  }

  /** The file's content before Nightshift changed it, or null when it is not changed. */
  original(projectId: string, taskId: string, rel: string): string | null {
    const file = this.backup(projectId, taskId, rel);
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  }

  /** Applies `files` (path from the workspace root → values) and restores files no longer listed. Returns one line per file written. */
  apply(projectId: string, taskId: string, root: string, files: Record<string, Record<string, string>>): string[] {
    const manifest = this.manifest(projectId, taskId);
    for (const rel of Object.keys(manifest)) if (!(rel in files)) this.restoreOne(projectId, taskId, root, rel, manifest);
    const notes: string[] = [];
    for (const [rel, values] of Object.entries(files)) {
      const full = path.join(root, rel);
      const saved = this.original(projectId, taskId, rel);
      if (saved === null && !existsSync(full)) {
        notes.push(`${rel} does not exist in this workspace; nothing written`);
        continue;
      }
      const original = saved ?? readFileSync(full, "utf8");
      if (saved === null) {
        mkdirSync(path.dirname(this.backup(projectId, taskId, rel)), { recursive: true });
        writeFileSync(this.backup(projectId, taskId, rel), original);
      }
      let text = original;
      for (const [key, value] of Object.entries(values)) text = setDotenvValue(text, key, value);
      writeFileSync(full, text);
      let tracked = false;
      try {
        git(root, ["ls-files", "--error-unmatch", "--", rel]);
        tracked = true;
      } catch {}
      if (tracked) git(root, ["update-index", "--skip-worktree", "--", rel]);
      else ensureIgnored(root, rel);
      manifest[rel] = { tracked };
      notes.push(`wrote ${Object.keys(values).join(", ")} into ${rel} (this workspace only, hidden from git)`);
    }
    this.saveManifest(projectId, taskId, manifest);
    return notes;
  }

  private restoreOne(projectId: string, taskId: string, root: string, rel: string, manifest: Manifest) {
    const entry = manifest[rel];
    if (entry?.tracked) {
      try {
        git(root, ["update-index", "--no-skip-worktree", "--", rel]);
      } catch {}
    }
    const original = this.original(projectId, taskId, rel);
    if (original !== null && existsSync(root)) writeFileSync(path.join(root, rel), original);
    rmSync(this.backup(projectId, taskId, rel), { force: true });
    delete manifest[rel];
  }

  /** Paths (from the workspace root) Nightshift has changed in this task. */
  applied(projectId: string, taskId: string): string[] {
    return Object.keys(this.manifest(projectId, taskId));
  }

  /** Puts every changed file back as it was. */
  restore(projectId: string, taskId: string, root: string): string[] {
    const manifest = this.manifest(projectId, taskId);
    const files = Object.keys(manifest);
    for (const rel of files) this.restoreOne(projectId, taskId, root, rel, manifest);
    this.saveManifest(projectId, taskId, manifest);
    return files;
  }

  /** Forgets a task whose workspace is gone. */
  drop(projectId: string, taskId: string) {
    rmSync(this.dir(projectId, taskId), { recursive: true, force: true });
  }
}
