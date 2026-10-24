import { execFileSync } from "node:child_process";
import { existsSync, openSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** `@path/to/file` after the start or a space or bracket (so e-mail addresses are not mentions); no spaces in the path. */
const MENTION = /(^|[\s([{"'`])@((?:[\w.@-]+\/)*[\w.@-]*[\w-])/g;

const MAX_FILES = 20;
const MAX_FILE_BYTES = 60_000;
const MAX_TOTAL_BYTES = 200_000;
const MAX_DIR_ENTRIES = 200;

export const MENTIONS_HEADING = "Files the owner pointed to with @";

/** The distinct paths a text mentions with @, in order. */
export function mentionedPaths(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION)) {
    const p = m[2]!.replace(/[.,;:!?]+$/, "");
    if (p && !out.includes(p)) out.push(p);
  }
  return out.slice(0, MAX_FILES);
}

const LANGS: Record<string, string> = { ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mjs: "js", cjs: "js", json: "json", md: "md", py: "python", go: "go", rs: "rust", css: "css", html: "html", sql: "sql", sh: "bash", yml: "yaml", yaml: "yaml", prisma: "prisma", toml: "toml" };

function readHead(file: string, bytes: number): Buffer {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/**
 * Appends the contents of the files (or the entries of folders) the text mentions with @, read from `root`.
 * Paths outside `root`, `.git`, and the owner's protected files are not shown; paths that do not exist are ignored
 * (an @ before something that is not a path stays plain text).
 */
export function expandMentions(text: string, root: string, protectedPaths: string[] = []): { text: string; files: string[] } {
  if (!root || !existsSync(root) || text.includes(MENTIONS_HEADING)) return { text, files: [] };
  const base = path.resolve(root);
  const blocks: string[] = [];
  const files: string[] = [];
  let total = 0;
  for (const rel of mentionedPaths(text)) {
    const full = path.resolve(base, rel);
    if (full !== base && !full.startsWith(base + path.sep)) continue;
    const clean = path.relative(base, full) || ".";
    if (clean.split(path.sep).includes(".git") || !existsSync(full)) continue;
    files.push(clean);
    if (protectedPaths.includes(clean)) {
      blocks.push(`### ${clean}\n(not shown: it holds the owner's secrets)`);
      continue;
    }
    const st = statSync(full);
    if (st.isDirectory()) {
      const entries = readdirSync(full, { withFileTypes: true })
        .filter((e) => e.name !== ".git" && e.name !== "node_modules")
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
      blocks.push(`### ${clean}/ (folder)\n${entries.slice(0, MAX_DIR_ENTRIES).join("\n")}${entries.length > MAX_DIR_ENTRIES ? `\n…and ${entries.length - MAX_DIR_ENTRIES} more` : ""}`);
      continue;
    }
    if (!st.isFile()) continue;
    const room = Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - total);
    if (room <= 0) {
      blocks.push(`### ${clean}\n(not shown: the mentioned files are too large together; read it yourself)`);
      continue;
    }
    const head = readHead(full, Math.min(room, st.size));
    if (head.subarray(0, 8000).includes(0)) {
      blocks.push(`### ${clean}\n(binary file, ${st.size} bytes; not shown)`);
      continue;
    }
    total += head.length;
    const lang = LANGS[path.extname(clean).slice(1).toLowerCase()] ?? "";
    const cut = st.size > head.length ? `\n(… cut at ${head.length} of ${st.size} bytes; read the rest yourself)` : "";
    blocks.push(`### ${clean}\n\`\`\`${lang}\n${head.toString("utf8")}\n\`\`\`${cut}`);
  }
  if (!blocks.length) return { text, files };
  return { text: `${text}\n\n---\n${MENTIONS_HEADING} (as they are in your workspace now):\n\n${blocks.join("\n\n")}`, files };
}

const listCache = new Map<string, { at: number; files: string[] }>();

/** Files in a git checkout (tracked and untracked, not ignored) plus their folders, cached for 15 s. */
export function listFiles(root: string): string[] {
  const hit = listCache.get(root);
  if (hit && Date.now() - hit.at < 15_000) return hit.files;
  let files: string[] = [];
  try {
    files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] })
      .split("\0")
      .filter(Boolean);
  } catch {}
  const dirs = new Set<string>();
  for (const f of files) for (let d = path.posix.dirname(f); d !== "."; d = path.posix.dirname(d)) dirs.add(`${d}/`);
  const all = [...dirs, ...files];
  listCache.set(root, { at: Date.now(), files: all });
  return all;
}

/** Fuzzy file search: every query character in order; the file name, consecutive runs and short paths rank higher. */
export function searchFiles(root: string, query: string, limit = 30): string[] {
  const all = listFiles(root);
  const q = query.toLowerCase().replace(/^\.\//, "");
  if (!q) return all.filter((f) => !f.endsWith("/") && !f.includes("/")).slice(0, limit);
  const scored: Array<{ f: string; score: number }> = [];
  for (const f of all) {
    const lower = f.toLowerCase();
    let i = 0;
    let score = 0;
    let run = 0;
    for (let j = 0; j < lower.length && i < q.length; j++) {
      if (lower[j] === q[i]) {
        i++;
        run++;
        score += run * 2;
      } else run = 0;
    }
    if (i < q.length) continue;
    const name = path.posix.basename(f.replace(/\/$/, "")).toLowerCase();
    if (name.includes(q)) score += 40;
    if (name.startsWith(q)) score += 20;
    if (lower.includes(q)) score += 15;
    score -= f.length / 20;
    scored.push({ f, score });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.f);
}
