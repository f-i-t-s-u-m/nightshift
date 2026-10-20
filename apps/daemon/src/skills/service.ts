import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  NightshiftConfig,
  Project,
  ProjectSkill,
  Skill,
  SkillCandidate,
  SkillDetail,
  SkillDiscoverInput,
  SkillDiscovery,
  SkillImportInput,
  SkillSource,
  SkillWriteInput,
} from "@nightshift/core";
import { taskTypeInfo, type TaskType } from "@nightshift/core";
import { run } from "@nightshift/git";
import type { Store } from "@nightshift/store";
import { parseSkill, renderSkill, skillId } from "./frontmatter.ts";

export class SkillError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code?: string,
  ) {
    super(message);
  }
}

type Meta = { source: SkillSource; installedAt: string; updatedAt: string };

export type RunSkill = { id: string; name: string; description: string; path: string; taskTypes: TaskType[] };

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", "__pycache__", ".venv"]);
const MAX_FILES = 500;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 30 * 1024 * 1024;
const REPO_SKILL_DIRS = [".claude/skills", ".agents/skills"];
const RUN_DIR = ".nightshift/skills";

const GIT_URL = /^(https:\/\/[\w.-]+\/[\w./-]+?(\.git)?|git@[\w.-]+:[\w./-]+?(\.git)?|ssh:\/\/[\w@.-]+(:\d+)?\/[\w./-]+?(\.git)?|file:\/\/\/[\w./-]+)\/?$/;

const defaultBuiltinDir = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "builtin-skills");

function listFiles(root: string): { files: string[]; size: number } {
  const files: string[] = [];
  let size = 0;
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === ".DS_Store") continue;
      const full = path.join(dir, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(full, rel ? `${rel}/${name}` : name);
        continue;
      }
      if (!st.isFile()) continue;
      files.push(rel ? `${rel}/${name}` : name);
      size += st.size;
      if (files.length > MAX_FILES) throw new SkillError(`The skill folder has more than ${MAX_FILES} files`);
      if (st.size > MAX_FILE_BYTES) throw new SkillError(`${rel ? `${rel}/` : ""}${name} is larger than 5 MB`);
      if (size > MAX_TOTAL_BYTES) throw new SkillError("The skill folder is larger than 30 MB");
    }
  };
  walk(root, "");
  return { files, size };
}

function findSkillDirs(root: string, maxDepth = 7): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    if (names.includes("SKILL.md")) {
      out.push(dir);
      return;
    }
    if (depth >= maxDepth) return;
    for (const name of names.sort()) {
      if (SKIP_DIRS.has(name) || name.startsWith(".") && name !== ".claude" && name !== ".agents") continue;
      const full = path.join(dir, name);
      try {
        if (lstatSync(full).isDirectory()) walk(full, depth + 1);
      } catch {}
    }
  };
  walk(root, 0);
  return out;
}

function installedPluginPaths(claudeDir: string): string[] {
  try {
    const data = JSON.parse(readFileSync(path.join(claudeDir, "plugins", "installed_plugins.json"), "utf8")) as { plugins?: Record<string, unknown> };
    const out: string[] = [];
    for (const entry of Object.values(data.plugins ?? {})) {
      for (const install of Array.isArray(entry) ? entry : [entry]) {
        const p = (install as { installPath?: unknown })?.installPath;
        if (typeof p === "string" && path.isAbsolute(p)) out.push(p);
      }
    }
    return out;
  } catch {
    return [];
  }
}

const inside = (root: string, target: string) => {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

export class SkillsService {
  private readonly sources = new Map<string, { root: string; label: string; source: SkillSource; base: string }>();
  private readonly excluded = new Set<string>();

  constructor(
    private readonly config: NightshiftConfig,
    private readonly store: Store,
    private readonly builtinDir = defaultBuiltinDir(),
  ) {
    mkdirSync(this.installedDir(), { recursive: true });
  }

  private installedDir() {
    return path.join(this.config.dataDir, "skills");
  }

  private meta(): Record<string, Meta> {
    return this.store.setting<Record<string, Meta>>("skills:meta", {});
  }

  private enabledMap(): Record<string, boolean> {
    return this.store.setting<Record<string, boolean>>("skills:enabled", {});
  }

  private dirOf(id: string): { dir: string; builtin: boolean } | null {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return null;
    const installed = path.join(this.installedDir(), id);
    if (existsSync(path.join(installed, "SKILL.md"))) return { dir: installed, builtin: false };
    const builtin = path.join(this.builtinDir, id);
    if (existsSync(path.join(builtin, "SKILL.md"))) return { dir: builtin, builtin: true };
    return null;
  }

  private describe(id: string, dir: string, builtin: boolean): Skill {
    const parsed = parseSkill(readFileSync(path.join(dir, "SKILL.md"), "utf8"));
    const { files, size } = listFiles(dir);
    const meta = this.meta()[id];
    const mtime = statSync(path.join(dir, "SKILL.md")).mtime.toISOString();
    return {
      id,
      name: parsed.name,
      description: parsed.description,
      source: builtin ? { kind: "builtin" } : (meta?.source ?? { kind: "folder" }),
      files,
      sizeBytes: size,
      enabled: this.enabledMap()[id] ?? true,
      builtin,
      taskTypes: parsed.taskTypes,
      installedAt: meta?.installedAt ?? mtime,
      updatedAt: meta?.updatedAt ?? mtime,
    };
  }

  list(): Skill[] {
    const out: Skill[] = [];
    const seen = new Set<string>();
    for (const [base, builtin] of [
      [this.installedDir(), false],
      [this.builtinDir, true],
    ] as const) {
      if (!existsSync(base)) continue;
      for (const id of readdirSync(base).sort()) {
        if (seen.has(id) || !existsSync(path.join(base, id, "SKILL.md"))) continue;
        try {
          out.push(this.describe(id, path.join(base, id), builtin));
          seen.add(id);
        } catch {}
      }
    }
    return out.sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name));
  }

  get(id: string): SkillDetail {
    const found = this.dirOf(id);
    if (!found) throw new SkillError("No skill with that id", 404);
    return { ...this.describe(id, found.dir, found.builtin), content: readFileSync(path.join(found.dir, "SKILL.md"), "utf8") };
  }

  private touch(id: string, source?: SkillSource) {
    const all = this.meta();
    const now = new Date().toISOString();
    all[id] = { source: source ?? all[id]?.source ?? { kind: "written" }, installedAt: source ? now : (all[id]?.installedAt ?? now), updatedAt: now };
    this.store.setSetting("skills:meta", all);
  }

  private claimId(name: string, replace: boolean): string {
    const id = skillId(name);
    if (!id) throw new SkillError("The skill name needs letters or numbers");
    if (existsSync(path.join(this.builtinDir, id, "SKILL.md"))) throw new SkillError(`"${name}" has the same name as a built-in skill. Rename it in its SKILL.md first.`, 409, "builtin");
    if (!replace && existsSync(path.join(this.installedDir(), id))) throw new SkillError(`A skill named "${name}" is already installed`, 409, "exists");
    return id;
  }

  create(input: SkillWriteInput): SkillDetail {
    const content = renderSkill({ name: input.name ?? "", description: input.description ?? "", body: input.body ?? "" });
    const parsed = parseSkill(content);
    if (!parsed.body.trim()) throw new SkillError("Write the skill's instructions");
    const id = this.claimId(parsed.name, false);
    mkdirSync(path.join(this.installedDir(), id), { recursive: true });
    writeFileSync(path.join(this.installedDir(), id, "SKILL.md"), content);
    this.touch(id, { kind: "written" });
    return this.get(id);
  }

  save(id: string, content: string): SkillDetail {
    const found = this.dirOf(id);
    if (!found) throw new SkillError("No skill with that id", 404);
    if (found.builtin) throw new SkillError("Built-in skills are read-only");
    if (typeof content !== "string" || content.length > 500_000) throw new SkillError("SKILL.md is missing or too large");
    try {
      parseSkill(content);
    } catch (error) {
      throw new SkillError((error as Error).message);
    }
    writeFileSync(path.join(found.dir, "SKILL.md"), content);
    this.touch(id);
    return this.get(id);
  }

  setEnabled(id: string, enabled: boolean): SkillDetail {
    if (!this.dirOf(id)) throw new SkillError("No skill with that id", 404);
    this.store.setSetting("skills:enabled", { ...this.enabledMap(), [id]: Boolean(enabled) });
    return this.get(id);
  }

  remove(id: string) {
    const found = this.dirOf(id);
    if (!found) throw new SkillError("No skill with that id", 404);
    if (found.builtin) throw new SkillError("Built-in skills can be turned off but not deleted");
    rmSync(found.dir, { recursive: true, force: true });
    const meta = this.meta();
    delete meta[id];
    this.store.setSetting("skills:meta", meta);
    const enabled = this.enabledMap();
    delete enabled[id];
    this.store.setSetting("skills:enabled", enabled);
  }

  private async cloneSource(url: string): Promise<{ root: string; base: string; label: string }> {
    let repoUrl = url.trim();
    let sub = "";
    let branch: string | undefined;
    const tree = repoUrl.match(/^(https:\/\/github\.com\/[\w.-]+\/[\w.-]+?)(?:\.git)?\/(?:tree|blob)\/([^/]+)(?:\/(.+?))?\/?$/);
    if (tree) {
      repoUrl = tree[1]!;
      branch = tree[2];
      sub = (tree[3] ?? "").replace(/\/SKILL\.md$/, "");
    }
    if (!GIT_URL.test(repoUrl)) throw new SkillError("That does not look like a git URL (https://…, git@host:owner/repo, ssh://… or file:///…)");
    const dir = path.join(this.config.dataDir, "skill-sources", createHash("sha256").update(`${repoUrl}#${branch ?? ""}`).digest("hex").slice(0, 16));
    mkdirSync(path.dirname(dir), { recursive: true });
    const env = { GIT_TERMINAL_PROMPT: "0" };
    if (existsSync(path.join(dir, ".git"))) {
      await run("git", ["fetch", "--quiet", "--depth", "1", "origin", ...(branch ? [branch] : [])], { cwd: dir, timeoutMs: 5 * 60_000, env });
      await run("git", ["reset", "--quiet", "--hard", "FETCH_HEAD"], { cwd: dir, env });
    } else {
      const res = await run("git", ["clone", "--quiet", "--depth", "1", ...(branch ? ["--branch", branch] : []), repoUrl, dir], { timeoutMs: 10 * 60_000, env });
      if (res.code !== 0) {
        rmSync(dir, { recursive: true, force: true });
        throw new SkillError(`Clone failed: ${(res.stderr || res.stdout).trim().slice(-400)}. For private repositories, sign in with \`gh auth login\` and \`gh auth setup-git\`.`);
      }
    }
    const root = path.resolve(dir, sub);
    if (!inside(dir, root) || !existsSync(root)) throw new SkillError(`${sub} was not found in the repository`);
    return { root, base: dir, label: `${repoUrl.replace(/^https:\/\//, "")}${sub ? `/${sub}` : ""}` };
  }

  async discover(input: SkillDiscoverInput): Promise<SkillDiscovery> {
    let root: string;
    let base: string;
    let label: string;
    let source: SkillSource;
    let scanRoots: string[];
    if (input.claudeCode) {
      root = path.join(homedir(), ".claude");
      base = root;
      label = "Claude Code (~/.claude)";
      source = { kind: "claude-code" };
      scanRoots = [...new Set([path.join(root, "skills"), path.join(root, "plugins", "synced"), path.join(root, "plugins", "cache"), ...installedPluginPaths(root)])].filter(existsSync);
    } else if (input.gitUrl?.trim()) {
      const cloned = await this.cloneSource(input.gitUrl);
      root = cloned.root;
      base = cloned.base;
      label = cloned.label;
      source = { kind: "git", ref: input.gitUrl.trim() };
      scanRoots = [root];
    } else if (input.path?.trim()) {
      root = path.resolve(input.path.trim().replace(/^~(?=\/|$)/, homedir()));
      if (!existsSync(root) || !statSync(root).isDirectory()) throw new SkillError(`${root} is not a folder`);
      base = root;
      label = root.replace(homedir(), "~");
      source = { kind: "folder" };
      scanRoots = [root];
    } else throw new SkillError("Choose Claude Code, a folder or a git URL");
    const sourceId = randomUUID();
    this.sources.set(sourceId, { root, label, source, base });
    const dirs = [...new Set(scanRoots.flatMap((r) => findSkillDirs(r, input.claudeCode ? 8 : 7)))];
    const installed = new Set(this.list().map((s) => s.id));
    const seenSkills = new Set<string>();
    const candidates: SkillCandidate[] = dirs.map((dir) => {
      const rel = path.relative(root, dir) || ".";
      try {
        const parsed = parseSkill(readFileSync(path.join(dir, "SKILL.md"), "utf8"));
        const { files } = listFiles(dir);
        const id = skillId(parsed.name);
        return { path: rel, name: parsed.name, description: parsed.description, files: files.length, installedId: installed.has(id) ? id : null, error: null };
      } catch (error) {
        return { path: rel, name: path.basename(dir), description: "", files: 0, installedId: null, error: (error as Error).message };
      }
    });
    const unique = candidates.filter((c) => {
      if (c.error) return true;
      const key = `${c.name}\n${c.description}`;
      if (seenSkills.has(key)) return false;
      seenSkills.add(key);
      return true;
    });
    return { sourceId, label, candidates: unique };
  }

  importSkills(input: SkillImportInput): Skill[] {
    const src = this.sources.get(input.sourceId);
    if (!src) throw new SkillError("That scan has expired. Scan the source again.", 404);
    if (!Array.isArray(input.paths) || !input.paths.length) throw new SkillError("Choose at least one skill to import");
    const plan: Array<{ id: string; dir: string; name: string }> = [];
    for (const rel of input.paths) {
      const dir = path.resolve(src.root, rel);
      if (!inside(src.root, dir) || !existsSync(path.join(dir, "SKILL.md"))) throw new SkillError(`${rel} is not a skill in this source`);
      let parsed;
      try {
        parsed = parseSkill(readFileSync(path.join(dir, "SKILL.md"), "utf8"));
      } catch (error) {
        throw new SkillError(`${rel}: ${(error as Error).message}`);
      }
      listFiles(dir);
      const id = this.claimId(parsed.name, Boolean(input.replace));
      if (plan.some((p) => p.id === id)) throw new SkillError(`Two selected skills are both named "${parsed.name}"`);
      plan.push({ id, dir, name: parsed.name });
    }
    for (const p of plan) {
      const target = path.join(this.installedDir(), p.id);
      const temp = `${target}.importing-${Date.now()}`;
      cpSync(p.dir, temp, {
        recursive: true,
        filter: (from) => {
          const name = path.basename(from);
          if (from !== p.dir && (SKIP_DIRS.has(name) || name === ".DS_Store")) return false;
          return !lstatSync(from).isSymbolicLink();
        },
      });
      rmSync(target, { recursive: true, force: true });
      cpSync(temp, target, { recursive: true });
      rmSync(temp, { recursive: true, force: true });
      const rel = path.relative(src.base, p.dir);
      this.touch(p.id, { ...src.source, path: src.source.kind === "folder" ? p.dir : rel || undefined });
    }
    return plan.map((p) => this.describe(p.id, path.join(this.installedDir(), p.id), false));
  }

  private repoSkills(root: string): Array<{ id: string; name: string; description: string; path: string; taskTypes: TaskType[] }> {
    const out: Array<{ id: string; name: string; description: string; path: string; taskTypes: TaskType[] }> = [];
    for (const rel of REPO_SKILL_DIRS) {
      const dir = path.join(root, rel);
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir).sort()) {
        const file = path.join(dir, name, "SKILL.md");
        if (!existsSync(file)) continue;
        try {
          const parsed = parseSkill(readFileSync(file, "utf8"));
          const id = `repo-${skillId(parsed.name)}`;
          if (!out.some((s) => s.id === id)) out.push({ id, name: parsed.name, description: parsed.description, path: `${rel}/${name}/SKILL.md`, taskTypes: parsed.taskTypes });
        } catch {}
      }
    }
    return out;
  }

  projectSkills(project: Project, root = project.repo.path): ProjectSkill[] {
    const overrides = project.skills ?? {};
    const own: ProjectSkill[] = this.list().map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      origin: "nightshift",
      path: `${RUN_DIR}/${s.id}/SKILL.md`,
      globalEnabled: s.enabled,
      override: overrides[s.id] ?? null,
      enabled: overrides[s.id] ?? s.enabled,
    }));
    const repo: ProjectSkill[] = (existsSync(root) ? this.repoSkills(root) : []).map((s) => ({
      ...s,
      origin: "repository",
      globalEnabled: true,
      override: overrides[s.id] ?? null,
      enabled: overrides[s.id] ?? true,
    }));
    return [...own, ...repo];
  }

  private excludeRunDir(worktree: string) {
    if (this.excluded.has(worktree)) return;
    try {
      const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: worktree, encoding: "utf8" }).trim();
      const file = path.join(path.resolve(worktree, common), "info", "exclude");
      mkdirSync(path.dirname(file), { recursive: true });
      const current = existsSync(file) ? readFileSync(file, "utf8") : "";
      if (!current.split("\n").includes("/.nightshift/")) writeFileSync(file, `${current}${current && !current.endsWith("\n") ? "\n" : ""}/.nightshift/\n`);
      this.excluded.add(worktree);
    } catch {}
  }

  forRun(project: Project, worktree: string): RunSkill[] {
    if (!existsSync(worktree)) return [];
    const enabled = this.projectSkills(project, worktree).filter((s) => s.enabled);
    const own = enabled.filter((s) => s.origin === "nightshift");
    this.excludeRunDir(worktree);
    const target = path.join(worktree, RUN_DIR);
    const stamps = own.map((s) => {
      const found = this.dirOf(s.id)!;
      return `${s.id}:${statSync(path.join(found.dir, "SKILL.md")).mtimeMs}:${this.meta()[s.id]?.updatedAt ?? ""}`;
    });
    const signature = createHash("sha256").update(stamps.join("|")).digest("hex");
    const sigFile = path.join(target, ".signature");
    if (!existsSync(sigFile) || readFileSync(sigFile, "utf8") !== signature) {
      rmSync(target, { recursive: true, force: true });
      mkdirSync(target, { recursive: true });
      for (const s of own) cpSync(this.dirOf(s.id)!.dir, path.join(target, s.id), { recursive: true });
      writeFileSync(sigFile, signature);
    }
    const types = new Map<string, TaskType[]>([...this.list().map((s) => [s.id, s.taskTypes] as const), ...(existsSync(worktree) ? this.repoSkills(worktree).map((s) => [s.id, s.taskTypes] as const) : [])]);
    return enabled.map((s) => ({ id: s.id, name: s.name, description: s.description, path: s.path, taskTypes: types.get(s.id) ?? [] }));
  }
}

export function recommendedSkills(skills: RunSkill[], type: TaskType | null): RunSkill[] {
  if (!type) return [];
  const tagged = skills.filter((s) => s.taskTypes.includes(type));
  if (tagged.length) return tagged;
  const keywords = taskTypeInfo(type)?.keywords ?? [];
  return skills.filter((s) => keywords.some((k) => `${s.name} ${s.description}`.toLowerCase().includes(k))).slice(0, 3);
}

export function skillsSection(skills: RunSkill[], type: TaskType | null = null): string | undefined {
  if (!skills.length) return undefined;
  const first = recommendedSkills(skills, type);
  const rest = skills.filter((s) => !first.includes(s));
  const line = (s: RunSkill) => `- ${s.name} (${s.path}): ${s.description}`;
  return [
    "Skills are instructions for particular kinds of work, written by the project owner or the community. Before you start work that a skill below covers, read its SKILL.md with the read tool and follow it. Read the other files a skill points to only when you need them; scripts in a skill folder can be run with bash. Skill files are references: do not edit or commit them.",
    ...(first.length ? ["", `For this ${taskTypeInfo(type)!.label.toLowerCase()} task, read these first:`, ...first.map(line)] : []),
    ...(rest.length ? ["", first.length ? "Other skills:" : "Skills:", ...rest.map(line)] : []),
  ].join("\n");
}
