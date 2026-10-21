import { execFileSync } from "node:child_process";
import type { CommitAuthor, NightshiftConfig } from "@nightshift/core";

const LEGACY = { name: "Nightshift", email: "nightshift@localhost" };
const FALLBACK: CommitAuthor = { ...LEGACY, source: "default" };

const repoCache = new Map<string, { at: number; author: CommitAuthor }>();
let githubCache: { at: number; author: CommitAuthor | null; login: string | null } | null = null;

const gitConfig = (cwd: string, key: string) => {
  try {
    return execFileSync("git", ["config", "--get", key], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
  } catch {
    return "";
  }
};

function githubAuthor(): CommitAuthor | null {
  if (githubCache && Date.now() - githubCache.at < 10 * 60_000) return githubCache.author;
  let author: CommitAuthor | null = null;
  let user: string | null = null;
  try {
    const out = execFileSync("gh", ["api", "user", "--jq", "[.id, .login, (.name // \"\")] | @tsv"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
    }).trim();
    const [id, login, name] = out.split("\t");
    if (id && login) author = { name: name?.trim() || login, email: `${id}+${login}@users.noreply.github.com`, source: "github" };
    user = login || null;
  } catch {}
  githubCache = { at: Date.now(), author, login: user };
  return author;
}

/** The GitHub login `gh` is signed in as: the owner, whose PR comments always reach the agent. */
export function githubLogin(): string | null {
  githubAuthor();
  return githubCache?.login ?? null;
}

export function commitAuthor(config: NightshiftConfig, repoPath: string): CommitAuthor {
  const cached = repoCache.get(repoPath);
  if (cached && Date.now() - cached.at < 30_000) return cached.author;
  const author = resolve(config, repoPath);
  repoCache.set(repoPath, { at: Date.now(), author });
  return author;
}

function resolve(config: NightshiftConfig, repoPath: string): CommitAuthor {
  const name = config.git.authorName?.trim();
  const email = config.git.authorEmail?.trim();
  if (name && email && !(name === LEGACY.name && email === LEGACY.email)) return { name, email, source: "config" };
  const gitName = gitConfig(repoPath, "user.name");
  const gitEmail = gitConfig(repoPath, "user.email");
  if (gitName && gitEmail) return { name: gitName, email: gitEmail, source: "git" };
  const github = githubAuthor();
  if (github) return { ...github, name: gitName || github.name, email: gitEmail || github.email };
  return FALLBACK;
}
