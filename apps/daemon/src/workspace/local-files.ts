import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { EnvRewrite, LocalFileCandidate, LocalFilesConfig, LocalFilesScan, LocalFilesStatus, PreviewConfig, PreviewService } from "@nightshift/core";
import type { Ask } from "./preview-ai.ts";

const LOCAL_FILE = /(^|\/)(\.env(\.[\w.-]+)?|\.dev\.vars|local\.settings\.json|config\.local\.[\w]+)$/;
const EXAMPLE = /\.(example|sample|template|dist|defaults?)$/;
const MAX_BYTES = 256 * 1024;
const PUBLIC_KEY = /^(NEXT_PUBLIC_|VITE_|EXPO_PUBLIC_|PUBLIC_|REACT_APP_|NUXT_PUBLIC_|GATSBY_)/;
const LOCAL_URL = /^(https?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(?::(\d{2,5}))?(\/[^\s"']*)?$/i;
const FRAMEWORK_PORTS: Array<[RegExp, number]> = [
  [/\bnext\b/, 3000],
  [/\bvite\b/, 5173],
  [/\bastro\b/, 4321],
  [/\bexpo\b/, 8081],
  [/\bnuxt\b/, 3000],
  [/\bwrangler\b/, 8787],
];

export const safeRel = (p: string) => {
  const clean = p.trim().replace(/^\.?\/+/, "");
  if (!clean || clean.split("/").some((s) => s === ".." || s === "" || s === ".git") || path.isAbsolute(clean)) return null;
  return clean;
};

export function parseEnv(text: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    out.push({ key: m[1]!, value });
  }
  return out;
}

const readText = (file: string) => {
  try {
    return statSync(file).size > MAX_BYTES ? "" : readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

const HEAVY_DIRS = new Set(["node_modules", ".git", ".next", ".turbo", "dist", "build", "out", ".cache", "coverage", ".expo", ".vercel", ".wrangler", "target", "vendor", ".venv", "__pycache__"]);

function walkForLocalFiles(root: string, rel: string, depth: number): string[] {
  const out: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(path.join(root, rel));
  } catch {
    return out;
  }
  for (const name of names) {
    if (HEAVY_DIRS.has(name)) continue;
    const child = rel ? `${rel}/${name}` : name;
    let st;
    try {
      st = lstatSync(path.join(root, child));
    } catch {
      continue;
    }
    if (st.isFile() && LOCAL_FILE.test(child)) out.push(child);
    else if (st.isDirectory() && depth > 0) out.push(...walkForLocalFiles(root, child, depth - 1));
  }
  return out;
}

function ignoredLocalFiles(root: string): string[] {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const entries = out.split("\0").filter(Boolean);
    const files = entries.filter((p) => !p.endsWith("/"));
    for (const dir of entries.filter((p) => p.endsWith("/") && !p.split("/").some((part) => HEAVY_DIRS.has(part)))) files.push(...walkForLocalFiles(root, dir.replace(/\/$/, ""), 4));
    return [...new Set(files)].filter((p) => LOCAL_FILE.test(p) && !EXAMPLE.test(p)).sort();
  } catch {
    return [];
  }
}

function servicePorts(root: string, services: PreviewService[]): Map<number, string> {
  const ports = new Map<number, string>();
  const portIn = (text: string) =>
    [...text.matchAll(/(?:-p|--port|PORT=|port:\s*|\.listen\(\s*|port\s*=\s*)\s*(\d{3,5})\b/g)].map((m) => Number(m[1])).filter((n) => n >= 1000 && n < 65536);
  for (const s of services) {
    const dir = path.join(root, s.cwd ?? "");
    const pkg = readText(path.join(dir, "package.json"));
    let scripts = "";
    try {
      const parsed = JSON.parse(pkg) as { scripts?: Record<string, string> };
      scripts = [parsed.scripts?.dev, parsed.scripts?.start].filter(Boolean).join(" ");
    } catch {}
    const envPorts = [".env", ".env.local", ".env.development"].flatMap((f) => parseEnv(readText(path.join(dir, f))).filter((e) => e.key === "PORT").map((e) => Number(e.value)));
    const sources = ["src/index.ts", "src/index.js", "src/server.ts", "server.ts", "server.js", "index.ts", "index.js", "src/main.ts"].map((f) => readText(path.join(dir, f)).slice(0, 20_000)).join("\n");
    const found = [...envPorts, ...portIn(scripts), ...portIn(sources)];
    const framework = FRAMEWORK_PORTS.find(([re]) => re.test(`${scripts} ${s.command}`))?.[1];
    for (const p of found) if (!ports.has(p)) ports.set(p, s.name);
    if (!found.length && framework && !ports.has(framework)) ports.set(framework, s.name);
  }
  return ports;
}

function rewriteValue(key: string, url: string, service: string) {
  const m = url.match(LOCAL_URL)!;
  const suffix = m[4] && m[4] !== "/" ? m[4].replace(/\/$/, "") : "";
  return `{{${service}.${PUBLIC_KEY.test(key) ? "publicUrl" : "url"}}}${suffix}`;
}

export async function scanLocalFiles(root: string, preview: PreviewConfig | undefined, current: LocalFilesConfig | undefined, ask: Ask | null): Promise<LocalFilesScan> {
  const notes: string[] = [];
  const paths = ignoredLocalFiles(root);
  const configured = new Set(current?.paths ?? []);
  const candidates: LocalFileCandidate[] = paths.map((p) => {
    const abs = path.join(root, p);
    return { path: p, size: statSync(abs).size, keys: parseEnv(readText(abs)).map((e) => e.key), configured: configured.has(p) };
  });
  for (const p of configured) if (!paths.includes(p)) notes.push(`${p} is selected but not in the project folder.`);
  const services: PreviewService[] = preview?.services?.length ? preview.services : preview?.command ? [{ name: "app", command: preview.command }] : [];
  const ports = servicePorts(root, services);
  const rewrites: EnvRewrite[] = [];
  const unmapped: Array<{ file: string; key: string; value: string }> = [];
  for (const c of candidates) {
    for (const { key, value } of parseEnv(readText(path.join(root, c.path)))) {
      const m = value.match(LOCAL_URL);
      if (!m) continue;
      const port = Number(m[3] ?? (m[1]!.toLowerCase() === "https" ? 443 : 80));
      const service = ports.get(port);
      if (service && services.length > 1) rewrites.push({ file: c.path, key, was: value, value: rewriteValue(key, value, service), service });
      else if (services.length > 1) unmapped.push({ file: c.path, key, value });
    }
  }
  let source: LocalFilesScan["source"] = "rules";
  if (unmapped.length && ask && services.length > 1) {
    try {
      const text = await ask(
        "You map local development URLs in .env files to the apps of a monorepo. Answer only with JSON: {\"map\": [{\"file\": \"...\", \"key\": \"...\", \"service\": \"<app name or null>\"}]}. Use null when the URL is not one of the apps (for example a database, Redis, or an external tool).",
        [
          `Apps: ${services.map((s) => `${s.name} (folder ${s.cwd ?? "."}, command ${s.command})`).join("; ")}`,
          `Known ports: ${[...ports].map(([p, s]) => `${p}=${s}`).join(", ") || "none"}`,
          "Values to map:",
          ...unmapped.map((u) => `- ${u.file} ${u.key}=${u.value}`),
        ].join("\n"),
      );
      const raw = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
      const map = (JSON.parse(raw) as { map?: Array<{ file?: string; key?: string; service?: string | null }> }).map ?? [];
      for (const u of unmapped) {
        const hit = map.find((x) => x.file === u.file && x.key === u.key);
        if (hit?.service && services.some((s) => s.name === hit.service)) {
          rewrites.push({ file: u.file, key: u.key, was: u.value, value: rewriteValue(u.key, u.value, hit.service), service: hit.service });
          source = "ai";
        }
      }
    } catch {}
  }
  const left = unmapped.filter((u) => !rewrites.some((r) => r.file === u.file && r.key === u.key));
  if (left.length) notes.push(`${left.length} local URL${left.length === 1 ? "" : "s"} could not be matched to an app: ${left.map((u) => `${u.key} (${u.file})`).join(", ")}.`);
  return { root, candidates, rewrites, notes, source };
}

export function ensureIgnored(worktree: string, rel: string) {
  try {
    execFileSync("git", ["check-ignore", "-q", rel], { cwd: worktree, stdio: "ignore" });
  } catch {
    try {
      const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: worktree, encoding: "utf8" }).trim();
      const file = path.join(path.resolve(worktree, common), "info", "exclude");
      mkdirSync(path.dirname(file), { recursive: true });
      const current = existsSync(file) ? readFileSync(file, "utf8") : "";
      if (!current.split("\n").includes(`/${rel}`)) appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}/${rel}\n`);
    } catch {}
  }
}

export function syncLocalFiles(projectRoot: string, worktree: string, config: LocalFilesConfig | undefined, overwrite: boolean) {
  const copied: string[] = [];
  const skipped: string[] = [];
  const missing: string[] = [];
  for (const raw of config?.paths ?? []) {
    const rel = safeRel(raw);
    if (!rel) continue;
    const src = path.join(projectRoot, rel);
    const dest = path.join(worktree, rel);
    if (!existsSync(src) || !statSync(src).isFile()) {
      missing.push(rel);
      continue;
    }
    if (existsSync(dest) && !overwrite) {
      skipped.push(rel);
      continue;
    }
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    ensureIgnored(worktree, rel);
    copied.push(rel);
  }
  return { copied, skipped, missing };
}

export function localFilesStatus(projectRoot: string, worktree: string, config: LocalFilesConfig | undefined, syncedAt: string | null): LocalFilesStatus | null {
  if (!config?.paths.length) return null;
  const present: string[] = [];
  const missing: string[] = [];
  const changed: string[] = [];
  for (const raw of config.paths) {
    const rel = safeRel(raw);
    if (!rel) continue;
    const src = path.join(projectRoot, rel);
    const dest = path.join(worktree, rel);
    if (!existsSync(src)) missing.push(rel);
    if (existsSync(dest)) {
      present.push(rel);
      if (existsSync(src) && !readFileSync(src).equals(readFileSync(dest))) changed.push(rel);
    }
  }
  return { configured: config.paths, present, missing, changed, syncedAt };
}

export function rewriteEnv(config: LocalFilesConfig | undefined, service: PreviewService | null): Record<string, string> {
  const env: Record<string, string> = {};
  for (const r of config?.rewrites ?? []) {
    const dir = path.posix.dirname(r.file) === "." ? "" : path.posix.dirname(r.file);
    const cwd = (service?.cwd ?? "").replace(/^\.\/|\/$/g, "");
    if (service && dir && dir !== cwd) continue;
    env[r.key] = r.value;
  }
  return env;
}

export function normalizeLocalFiles(input: LocalFilesConfig | null | undefined): LocalFilesConfig | undefined {
  if (!input) return undefined;
  const paths = [...new Set((input.paths ?? []).map((p) => safeRel(String(p))).filter((p): p is string => Boolean(p)))].slice(0, 100);
  const rewrites = (input.rewrites ?? [])
    .filter((r) => r && safeRel(String(r.file)) && /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(String(r.key)) && typeof r.value === "string" && r.value.length < 2000)
    .map((r) => ({ file: safeRel(String(r.file))!, key: String(r.key), value: r.value, was: String(r.was ?? ""), service: r.service ? String(r.service) : null }))
    .slice(0, 200);
  if (!paths.length && !rewrites.length) return undefined;
  return { paths, agentCanRead: Boolean(input.agentCanRead), rewrites };
}

export function inferInstall(root: string): string | null {
  const has = (f: string) => existsSync(path.join(root, f));
  if (has("bun.lock") || has("bun.lockb")) return "bun install";
  if (has("pnpm-lock.yaml")) return "corepack enable && pnpm install --frozen-lockfile";
  if (has("yarn.lock")) return "corepack enable && yarn install --frozen-lockfile";
  if (has("package-lock.json")) return "npm ci";
  if (has("package.json")) return "npm install --no-audit --no-fund";
  return null;
}

export function defaultImage(root: string) {
  return existsSync(path.join(root, "bun.lock")) || existsSync(path.join(root, "bun.lockb")) ? "oven/bun:1" : "node:22-alpine";
}
