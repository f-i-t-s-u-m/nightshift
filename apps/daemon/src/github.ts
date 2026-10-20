import type { GithubRepoInput, GithubStatus } from "@nightshift/core";
import { run } from "@nightshift/git";

export class GithubError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const env = { GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" };

export const tail = (r: { stdout: string; stderr: string }) => (r.stderr || r.stdout).trim().split("\n").slice(-4).join(" ").slice(-500);

export function pushHint(protocol: "https" | "ssh") {
  return protocol === "https"
    ? "Git could not sign in to GitHub. Run `gh auth setup-git` once so git uses your GitHub CLI login, then try again."
    : "Git could not sign in to GitHub over SSH. Check `ssh -T git@github.com`, or switch to https with `gh config set git_protocol https` and `gh auth setup-git`.";
}

export async function githubStatus(): Promise<GithubStatus> {
  const version = await run("gh", ["--version"], { env, timeoutMs: 10_000 }).catch(() => null);
  if (!version || version.code !== 0) return { installed: false, loggedIn: false, login: null, orgs: [], protocol: "https", message: "The GitHub CLI (gh) is not installed. Install it with `brew install gh`." };
  const protocolOut = await run("gh", ["config", "get", "git_protocol", "-h", "github.com"], { env, timeoutMs: 10_000 }).catch(() => null);
  const protocol = protocolOut?.stdout.trim() === "ssh" ? "ssh" : "https";
  const user = await run("gh", ["api", "user", "--jq", ".login"], { env, timeoutMs: 20_000 });
  const login = user.code === 0 ? user.stdout.trim() : "";
  if (!login) return { installed: true, loggedIn: false, login: null, orgs: [], protocol, message: `Not signed in to GitHub. Run \`gh auth login\`. (${tail(user) || "no user"})` };
  const orgsOut = await run("gh", ["api", "user/orgs", "--paginate", "--jq", ".[].login"], { env, timeoutMs: 20_000 });
  const orgs = orgsOut.code === 0 ? orgsOut.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
  return { installed: true, loggedIn: true, login, orgs, protocol, message: null };
}

export function validateRepoInput(input: GithubRepoInput | undefined): GithubRepoInput {
  const owner = input?.owner?.trim() ?? "";
  const name = input?.name?.trim() ?? "";
  if (!OWNER.test(owner)) throw new GithubError("Choose a GitHub account or organisation");
  if (!NAME.test(name) || name === "." || name === "..") throw new GithubError("The repository name can use letters, numbers, dots, dashes and underscores (up to 100)");
  const visibility = input?.visibility === "public" ? "public" : "private";
  const description = input?.description?.trim().slice(0, 300) || undefined;
  return { owner, name, visibility, ...(description ? { description } : {}) };
}

export async function ensureReady(repo: GithubRepoInput): Promise<{ status: GithubStatus; reuse: boolean }> {
  const status = await githubStatus();
  if (!status.installed || !status.loggedIn) throw new GithubError(status.message ?? "GitHub is not available");
  const exists = await run("gh", ["repo", "view", `${repo.owner}/${repo.name}`, "--json", "isEmpty", "--jq", ".isEmpty"], { env, timeoutMs: 30_000 });
  if (exists.code !== 0) return { status, reuse: false };
  if (exists.stdout.trim() === "true") return { status, reuse: true };
  throw new GithubError(`github.com/${repo.owner}/${repo.name} already exists. Choose another name.`, 409);
}

export function pushUrl(status: GithubStatus, urls: { https: string; ssh: string }) {
  return status.protocol === "ssh" ? urls.ssh : urls.https;
}

export async function repoUrls(repo: GithubRepoInput): Promise<{ url: string; https: string; ssh: string }> {
  const view = await run("gh", ["repo", "view", `${repo.owner}/${repo.name}`, "--json", "url,sshUrl"], { env, timeoutMs: 30_000 });
  if (view.code !== 0) throw new GithubError(`Could not read the new repository: ${tail(view)}`);
  const data = JSON.parse(view.stdout) as { url: string; sshUrl: string };
  return { url: data.url, https: `${data.url.replace(/\/$/, "")}.git`, ssh: data.sshUrl };
}

export async function createRepo(repo: GithubRepoInput) {
  const args = ["repo", "create", `${repo.owner}/${repo.name}`, `--${repo.visibility}`];
  if (repo.description) args.push("--description", repo.description);
  const res = await run("gh", args, { env, timeoutMs: 2 * 60_000 });
  if (res.code !== 0) throw new GithubError(`GitHub could not create ${repo.owner}/${repo.name}: ${tail(res)}`);
}

export async function setDefaultBranch(repo: GithubRepoInput, branch: string) {
  await run("gh", ["repo", "edit", `${repo.owner}/${repo.name}`, "--default-branch", branch], { env, timeoutMs: 30_000 }).catch(() => null);
}
