import { execFileSync } from "node:child_process";
import { existsSync, openSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * `@path/to/file`, or `@name:path` inside the reference folder `name`, after the start or a space or bracket
 * (so e-mail addresses are not mentions); no spaces in the path. `@name:` alone mentions the reference's top folder.
 */
const MENTION = /(^|[\s([{"'`])@((?:[a-z0-9][a-z0-9-]*:)?(?:(?:[\w.@-]+\/)*[\w.@-]*[\w-])?)/g;

/** Never read from a reference folder: hidden files, env and key files, credentials, dependencies. */
const SECRET_NAME = /^\.|^\.?env(\..*)?$|\.(pem|key|p12|pfx|keystore|jks)$|^id_(rsa|dsa|ecdsa|ed25519)|credential|secret|\.npmrc$|\.netrc$/i;
export const referenceBlocked = (rel: string) => rel.split(/[\\/]/).some((part) => part === "node_modules" || part === ".git" || SECRET_NAME.test(part));

const MAX_FILES = 20;
const MAX_FILE_BYTES = 60_000;
const MAX_TOTAL_BYTES = 200_000;
const MAX_DIR_ENTRIES = 200;

export const MENTIONS_HEADING = "Files the owner pointed to with @";

/** The distinct paths a text mentions with @, in order. */
export function mentionedPaths(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION)) {
    const p = m[2]!.replace(/(?<=[^:])[.,;!?]+$/, "");
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
export function expandMentions(text: string, root: string, protectedPaths: string[] = [], references: Array<{ name: string; path: string }> = []): { text: string; files: string[] } {
  if (!root || !existsSync(root) || text.includes(MENTIONS_HEADING)) return { text, files: [] };
  const blocks: string[] = [];
  const files: string[] = [];
  let total = 0;
  for (const token of mentionedPaths(text)) {
    const ref = token.match(/^([a-z0-9][a-z0-9-]*):(.*)$/);
    const reference = ref ? references.find((r) => r.name === ref[1]) : undefined;
    if (ref && !reference) continue;
    const base = path.resolve(reference ? reference.path : root);
    const rel = ref ? ref[2]! || "." : token;
    const full = path.resolve(base, rel);
    if (full !== base && !full.startsWith(base + path.sep)) continue;
    const inside = path.relative(base, full) || ".";
    if (inside.split(path.sep).includes(".git") || !existsSync(full)) continue;
    const clean = reference ? `${reference.name}:${inside === "." ? "" : inside}` : inside;
    files.push(clean);
    if (reference && inside !== "." && referenceBlocked(inside)) {
      blocks.push(`### ${clean}\n(not shown: hidden, secret or dependency files of a reference folder are never read)`);
      continue;
    }
    if (!reference && protectedPaths.includes(clean)) {
      blocks.push(`### ${clean}\n(not shown: it holds the owner's secrets)`);
      continue;
    }
    const st = statSync(full);
    if (st.isDirectory()) {
      const entries = readdirSync(full, { withFileTypes: true })
        .filter((e) => e.name !== ".git" && e.name !== "node_modules" && !(reference && SECRET_NAME.test(e.name)))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
      blocks.push(`### ${clean}${clean.endsWith(":") ? "" : "/"} (folder${reference ? `, read-only reference at ${reference.path}` : ""})\n${entries.slice(0, MAX_DIR_ENTRIES).join("\n")}${entries.length > MAX_DIR_ENTRIES ? `\n…and ${entries.length - MAX_DIR_ENTRIES} more` : ""}`);
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
    blocks.push(`### ${clean}${reference ? ` (read-only reference: ${path.join(reference.path, inside)})` : ""}\n\`\`\`${lang}\n${head.toString("utf8")}\n\`\`\`${cut}`);
  }
  if (!blocks.length) return { text, files };
  return { text: `${text}\n\n---\n${MENTIONS_HEADING} (as they are in your workspace now):\n\n${blocks.join("\n\n")}`, files };
}

const listCache = new Map<string, { at: number; files: string[] }>();

/** Up to 20,000 files under `root`, skipping hidden folders and dependencies (for folders that are not git checkouts). */
function walk(root: string): string[] {
  const out: string[] = [];
  const queue = [""];
  while (queue.length && out.length < 20_000) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(path.join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) queue.push(rel);
      else if (e.isFile()) out.push(rel);
    }
  }
  return out;
}

/** Files in a git checkout (tracked and untracked, not ignored), or in a plain folder, plus their folders, cached for 15 s. */
export function listFiles(root: string, reference = false): string[] {
  const hit = listCache.get(root);
  if (hit && Date.now() - hit.at < 15_000) return hit.files;
  let files: string[] = [];
  try {
    files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] })
      .split("\0")
      .filter(Boolean);
  } catch {}
  // Not a git checkout, or one that ignores this folder (git lists nothing): look at the files themselves.
  if (!files.length) files = walk(root);
  if (reference) files = files.filter((f) => !referenceBlocked(f));
  const dirs = new Set<string>();
  for (const f of files) for (let d = path.posix.dirname(f); d !== "."; d = path.posix.dirname(d)) dirs.add(`${d}/`);
  const all = [...dirs, ...files];
  listCache.set(root, { at: Date.now(), files: all });
  return all;
}

/** Fuzzy file search: every query character in order; the file name, consecutive runs and short paths rank higher. */
export function searchFiles(root: string, query: string, limit = 30, reference = false): string[] {
  const all = listFiles(root, reference);
  const q = query.toLowerCase().replace(/^\.\//, "");
  // No query yet: the top level, folders first.
  if (!q) return all.filter((f) => !f.replace(/\/$/, "").includes("/")).sort((a, b) => Number(b.endsWith("/")) - Number(a.endsWith("/")) || a.localeCompare(b)).slice(0, limit);
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
