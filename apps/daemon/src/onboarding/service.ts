import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { STARTERS, type NightshiftConfig, type ProjectInspection, type ScaffoldInput } from "@nightshift/core";
import { run, runOk } from "@nightshift/git";
import { inspectRepository } from "./inspect.ts";
import { commitAuthor } from "../identity.ts";

export type Summarize = (system: string, prompt: string) => Promise<string>;

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "project";

const GIT_URL = /^(https:\/\/[\w.-]+\/[\w./-]+?(\.git)?|git@[\w.-]+:[\w./-]+?(\.git)?|ssh:\/\/[\w@.-]+(:\d+)?\/[\w./-]+?(\.git)?|file:\/\/\/[\w./-]+)\/?$/;

export class OnboardingService {
  constructor(
    private readonly config: NightshiftConfig,
    private readonly summarize: Summarize,
  ) {}

  reposDir() {
    return path.join(this.config.dataDir, "repos");
  }

  async inspect(input: { path?: string; gitUrl?: string }): Promise<ProjectInspection> {
    if (input.gitUrl) return inspectRepository(await this.clone(input.gitUrl.trim()));
    const p = input.path?.trim().replace(/^~(?=\/|$)/, homedir());
    if (!p) throw new Error("Give a folder path or a git URL");
    return inspectRepository(path.resolve(p));
  }

  async clone(url: string): Promise<string> {
    if (!GIT_URL.test(url)) throw new Error("That does not look like a git URL (https://…, git@host:owner/repo, ssh://… or file:///…)");
    const name = slug(url.replace(/\.git\/?$/, "").split(/[/:]/).filter(Boolean).at(-1) ?? "repo");
    const dir = path.join(this.reposDir(), name);
    mkdirSync(this.reposDir(), { recursive: true });
    if (existsSync(path.join(dir, ".git"))) {
      const current = (await run("git", ["remote", "get-url", "origin"], { cwd: dir })).stdout.trim();
      if (current === url) {
        await run("git", ["fetch", "--quiet", "origin"], { cwd: dir, timeoutMs: 5 * 60_000 });
        return dir;
      }
      throw new Error(`${dir} already holds a different repository (${current})`);
    }
    const res = await run("git", ["clone", "--quiet", url, dir], { timeoutMs: 15 * 60_000, env: { GIT_TERMINAL_PROMPT: "0" } });
    if (res.code !== 0) throw new Error(`Clone failed: ${(res.stderr || res.stdout).trim().slice(-400)}. For private repositories, sign in with \`gh auth login\` and \`gh auth setup-git\`.`);
    return dir;
  }

  async scaffold(input: ScaffoldInput, options: { localRemote?: boolean } = {}): Promise<{ repoPath: string; remote: string; starter: (typeof STARTERS)[number] }> {
    const starter = STARTERS.find((s) => s.id === input.starterId);
    if (!starter) throw new Error("Unknown starter");
    if (!input.name?.trim()) throw new Error("A project needs a name");
    if (!input.description?.trim()) throw new Error("Describe what to build");
    const parent = path.resolve((input.parentDir?.trim() || this.reposDir()).replace(/^~(?=\/|$)/, homedir()));
    const dir = path.join(parent, slug(input.name));
    if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} already exists and is not empty`);
    mkdirSync(dir, { recursive: true });
    const remotesDir = path.join(this.config.dataDir, "remotes");
    mkdirSync(remotesDir, { recursive: true });
    const bare = path.join(remotesDir, `${slug(input.name)}-${Date.now().toString(36)}.git`);
    const author = commitAuthor(this.config, parent);
    const env = { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email };
    if (options.localRemote !== false) await runOk("git", ["init", "--quiet", "--bare", "-b", "main", bare]);
    await runOk("git", ["init", "--quiet", "-b", "main"], { cwd: dir });
    writeFileSync(path.join(dir, "README.md"), `# ${input.name.trim()}\n\n${input.description.trim()}\n`);
    writeFileSync(path.join(dir, ".gitignore"), "node_modules/\ndist/\n.env\n.env.*\n!.env.example\n.DS_Store\n");
    await runOk("git", ["add", "."], { cwd: dir });
    await runOk("git", ["commit", "--quiet", "-m", "Start project"], { cwd: dir, env });
    if (options.localRemote === false) return { repoPath: dir, remote: "", starter };
    await runOk("git", ["remote", "add", "origin", bare], { cwd: dir });
    await runOk("git", ["push", "--quiet", "-u", "origin", "main"], { cwd: dir });
    return { repoPath: dir, remote: bare, starter };
  }

  async brief(root: string, inspection: ProjectInspection): Promise<string> {
    const docs = inspection.docs
      .slice(0, 6)
      .map((d) => `### ${d.path}\n${readFileSync(path.join(root, d.path), "utf8").slice(0, 6000)}`)
      .join("\n\n");
    const facts = JSON.stringify(
      {
        kind: inspection.kind,
        languages: inspection.languages,
        frameworks: inspection.frameworks,
        packageManager: inspection.packageManager,
        monorepo: inspection.monorepo,
        scripts: inspection.scripts,
        database: inspection.database,
      },
      null,
      2,
    );
    const system =
      "You write project briefs for autonomous AI software engineers. Be concrete and short (under 350 words). Use markdown headings: What it is, Stack, Structure, How to run and test, Conventions, Watch out for. Only state what the material supports; say 'unknown' instead of guessing.";
    const answer = await this.summarize(system, `Facts detected from the repository:\n${facts}\n\nDocuments:\n${docs || "(none found)"}\n\nWrite the project brief.`);
    if (!answer.trim()) throw new Error("The model returned an empty brief");
    return answer.trim();
  }
}
