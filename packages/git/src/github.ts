import { run, runOk } from "./exec.ts";
import type { ActionRun } from "@nightshift/core";
import type { CheckState, OpenPr, PrCheck, PrHost, PrInfo, PrStatus } from "./pr-host.ts";

type GhCheck = {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  detailsUrl?: string;
  targetUrl?: string;
};

function checkState(c: GhCheck): CheckState {
  if (c.__typename === "StatusContext" || c.state) {
    const s = (c.state ?? "").toUpperCase();
    if (s === "SUCCESS") return "success";
    if (s === "FAILURE" || s === "ERROR") return "failure";
    return "pending";
  }
  if ((c.status ?? "").toUpperCase() !== "COMPLETED") return "pending";
  const conclusion = (c.conclusion ?? "").toUpperCase();
  if (conclusion === "SUCCESS") return "success";
  if (["NEUTRAL", "SKIPPED"].includes(conclusion)) return "neutral";
  return "failure";
}

export class GithubPrHost implements PrHost {
  readonly name = "github";

  constructor(readonly repoPath: string) {}

  private gh(args: string[]) {
    return runOk("gh", args, { cwd: this.repoPath, env: { GH_PROMPT_DISABLED: "1" } });
  }

  async listOpen(): Promise<OpenPr[]> {
    const out = await this.gh(["pr", "list", "--state", "open", "--limit", "100", "--json", "number,url,headRefName,baseRefName,headRefOid,title"]);
    return (JSON.parse(out) as Array<{ number: number; url: string; headRefName: string; baseRefName: string; headRefOid: string; title: string }>).map((p) => ({
      number: p.number,
      url: p.url,
      branch: p.headRefName,
      base: p.baseRefName,
      headSha: p.headRefOid,
      title: p.title,
    }));
  }

  async issues(label: string): Promise<Array<{ number: number; title: string; body: string; url: string }>> {
    const out = await this.gh(["issue", "list", "--state", "open", "--label", label, "--limit", "50", "--json", "number,title,body,url"]);
    return JSON.parse(out) as Array<{ number: number; title: string; body: string; url: string }>;
  }

  async findOpen(branch: string): Promise<PrInfo | null> {
    const out = await this.gh(["pr", "list", "--head", branch, "--state", "open", "--json", "number,url,headRefOid", "--limit", "1"]);
    const list = JSON.parse(out) as Array<{ number: number; url: string; headRefOid: string }>;
    const pr = list[0];
    return pr ? { number: pr.number, url: pr.url, headSha: pr.headRefOid } : null;
  }

  async create(input: { branch: string; base: string; title: string; body: string }): Promise<PrInfo> {
    await this.gh(["pr", "create", "--head", input.branch, "--base", input.base, "--title", input.title, "--body", input.body]);
    const pr = await this.findOpen(input.branch);
    if (!pr) throw new Error(`PR for ${input.branch} not found after create`);
    return pr;
  }

  async status(number: number): Promise<PrStatus> {
    const out = await this.gh(["pr", "view", String(number), "--json", "state,headRefOid,statusCheckRollup,reviews,comments"]);
    const pr = JSON.parse(out) as {
      state: string;
      headRefOid: string;
      statusCheckRollup: GhCheck[];
      reviews: Array<{ id: string; author: { login: string }; state: string; body: string; submittedAt: string }>;
      comments: Array<{ id: string; author: { login: string }; body: string; createdAt: string }>;
    };
    const inline = await run("gh", ["api", `repos/{owner}/{repo}/pulls/${number}/comments`, "--paginate"], { cwd: this.repoPath });
    const inlineComments =
      inline.code === 0
        ? (JSON.parse(inline.stdout || "[]") as Array<{ id: number; user: { login: string }; body: string; created_at: string; path: string; line?: number; in_reply_to_id?: number }>).map(
            (c) => ({ id: `inline-${c.id}`, author: c.user.login, body: c.body, createdAt: c.created_at, path: c.path, line: c.line, ...(c.in_reply_to_id ? { replyTo: `inline-${c.in_reply_to_id}` } : {}) }),
          )
        : [];
    const state = pr.state.toUpperCase();
    return {
      state: state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : "open",
      headSha: pr.headRefOid,
      checks: (pr.statusCheckRollup ?? []).map(
        (c): PrCheck => ({ name: c.name ?? c.context ?? "check", state: checkState(c), detailsUrl: c.detailsUrl ?? c.targetUrl }),
      ),
      reviews: (pr.reviews ?? []).map((r) => ({ id: r.id, author: r.author?.login ?? "", state: r.state, body: r.body, submittedAt: r.submittedAt })),
      comments: [
        ...(pr.comments ?? []).map((c) => ({ id: c.id, author: c.author?.login ?? "", body: c.body, createdAt: c.createdAt })),
        ...inlineComments,
      ],
    };
  }

  async runs(branch: string): Promise<ActionRun[]> {
    const out = await this.gh(["run", "list", "--branch", branch, "--limit", "30", "--json", "databaseId,workflowName,displayTitle,status,conclusion,url,headBranch,headSha,event,createdAt"]);
    const list = JSON.parse(out) as Array<{
      databaseId: number;
      workflowName: string;
      displayTitle: string;
      status: string;
      conclusion: string;
      url: string;
      headBranch: string;
      headSha: string;
      event: string;
      createdAt: string;
    }>;
    return list.map((r) => ({
      id: String(r.databaseId),
      name: r.workflowName || r.displayTitle,
      status: r.status === "completed" ? "completed" : r.status === "in_progress" ? "in_progress" : "queued",
      conclusion: (r.conclusion || null) as ActionRun["conclusion"],
      url: r.url,
      branch: r.headBranch,
      sha: r.headSha,
      event: r.event,
      createdAt: r.createdAt,
      source: "github",
    }));
  }

  async runLog(id: string): Promise<string> {
    const res = await run("gh", ["run", "view", id, "--log"], { cwd: this.repoPath, timeoutMs: 120_000 });
    if (res.code !== 0) {
      const failed = await run("gh", ["run", "view", id], { cwd: this.repoPath, timeoutMs: 60_000 });
      return failed.stdout || res.stderr;
    }
    return res.stdout.split("\n").slice(-3000).join("\n");
  }

  async baseChecks(branch: string): Promise<PrCheck[]> {
    const shas = JSON.parse(await this.gh(["api", `repos/{owner}/{repo}/commits?sha=${branch}&per_page=5`, "--jq", "[.[].sha]"])) as string[];
    const latest = new Map<string, PrCheck>();
    for (const sha of shas) {
      const runs = JSON.parse(await this.gh(["api", `repos/{owner}/{repo}/commits/${sha}/check-runs?per_page=100`, "--jq", "[.check_runs[] | {name, status, conclusion, started_at, html_url}]"])) as Array<{
        name: string;
        status: string;
        conclusion: string | null;
        started_at: string | null;
        html_url: string;
      }>;
      const statuses = JSON.parse(await this.gh(["api", `repos/{owner}/{repo}/commits/${sha}/status`, "--jq", "[.statuses[] | {context, state, target_url}]"])) as Array<{ context: string; state: string; target_url: string | null }>;
      const here = new Map<string, PrCheck>();
      for (const r of runs.sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? ""))) here.set(r.name, { name: r.name, state: checkState({ status: r.status, conclusion: r.conclusion ?? undefined }), detailsUrl: r.html_url });
      for (const st of statuses) here.set(st.context, { name: st.context, state: checkState({ __typename: "StatusContext", state: st.state }), detailsUrl: st.target_url ?? undefined });
      for (const [name, check] of here) if (check.state !== "pending" && !latest.has(name)) latest.set(name, check);
    }
    return [...latest.values()];
  }

  async comment(number: number, body: string, replyTo?: string): Promise<void> {
    const inline = replyTo?.match(/^inline-(\d+)$/)?.[1];
    if (inline) await this.gh(["api", "-X", "POST", `repos/{owner}/{repo}/pulls/${number}/comments/${inline}/replies`, "-f", `body=${body}`]);
    else await this.gh(["pr", "comment", String(number), "--body", body]);
  }

  async failureLog(check: PrCheck): Promise<string | null> {
    const runId = check.detailsUrl?.match(/actions\/runs\/(\d+)/)?.[1];
    if (!runId) return null;
    const out = await run("gh", ["run", "view", runId, "--log-failed"], { cwd: this.repoPath, timeoutMs: 60_000 });
    if (out.code !== 0) return null;
    return out.stdout.split("\n").slice(-150).join("\n");
  }
}
