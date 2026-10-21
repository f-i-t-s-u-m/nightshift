import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { run } from "./exec.ts";
import type { OpenPr, PrCheck, PrComment, PrHost, PrInfo, PrReview, PrStatus } from "./pr-host.ts";

export type LocalPr = PrStatus & {
  checksSha?: string | null;
  number: number;
  branch: string;
  base: string;
  title: string;
  body: string;
  createdAt: string;
};

export class LocalPrHost implements PrHost {
  readonly name = "local";

  constructor(
    readonly file: string,
    readonly repoPath: string,
    readonly remote: string,
  ) {}

  read(): LocalPr[] {
    return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as LocalPr[]) : [];
  }

  write(prs: LocalPr[]) {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(prs, null, 2));
    renameSync(tmp, this.file);
  }

  private async remoteHead(branch: string) {
    const out = await run("git", ["ls-remote", "--heads", this.remote, branch], { cwd: this.repoPath });
    return out.stdout.trim().split(/\s+/)[0] || null;
  }

  async listOpen(): Promise<OpenPr[]> {
    const out: OpenPr[] = [];
    for (const p of this.read().filter((x) => x.state === "open")) out.push({ number: p.number, url: `local://pr/${p.number}`, branch: p.branch, base: p.base, headSha: await this.remoteHead(p.branch) });
    return out;
  }

  async findOpen(branch: string): Promise<PrInfo | null> {
    const pr = this.read().find((p) => p.branch === branch && p.state === "open");
    return pr ? { number: pr.number, url: `local://pr/${pr.number}`, headSha: await this.remoteHead(branch) } : null;
  }

  async create(input: { branch: string; base: string; title: string; body: string }): Promise<PrInfo> {
    const prs = this.read();
    const number = prs.reduce((max, p) => Math.max(max, p.number), 0) + 1;
    prs.push({
      number,
      branch: input.branch,
      base: input.base,
      title: input.title,
      body: input.body,
      state: "open",
      headSha: null,
      checks: [],
      reviews: [],
      comments: [],
      createdAt: new Date().toISOString(),
    });
    this.write(prs);
    return { number, url: `local://pr/${number}`, headSha: await this.remoteHead(input.branch) };
  }

  async status(number: number): Promise<PrStatus> {
    const pr = this.read().find((p) => p.number === number);
    if (!pr) throw new Error(`local PR ${number} not found`);
    const head = await this.remoteHead(pr.branch);
    const checks = pr.checksSha && pr.checksSha === head ? pr.checks : [];
    return { state: pr.state, headSha: head, checks, reviews: pr.reviews, comments: pr.comments };
  }

  async comment(number: number, body: string, replyTo?: string): Promise<void> {
    this.update(number, (pr) => {
      pr.comments.push({ id: `local-${pr.comments.length + 1}`, author: "nightshift", body, createdAt: new Date().toISOString(), ...(replyTo ? { replyTo } : {}) });
    });
  }

  async failureLog(check: PrCheck): Promise<string | null> {
    return check.summary ?? null;
  }

  update(number: number, change: (pr: LocalPr) => void) {
    const prs = this.read();
    const pr = prs.find((p) => p.number === number);
    if (!pr) throw new Error(`local PR ${number} not found`);
    change(pr);
    this.write(prs);
  }

  async setChecks(number: number, checks: PrCheck[]) {
    const pr = this.read().find((p) => p.number === number);
    if (!pr) throw new Error(`local PR ${number} not found`);
    const head = await this.remoteHead(pr.branch);
    this.update(number, (p) => {
      p.checks = checks;
      p.checksSha = head;
    });
  }

  addComment(number: number, comment: Omit<PrComment, "id" | "createdAt">) {
    this.update(number, (pr) => pr.comments.push({ ...comment, id: `c${pr.comments.length + 1}`, createdAt: new Date().toISOString() }));
  }

  addReview(number: number, review: Omit<PrReview, "id" | "submittedAt">) {
    this.update(number, (pr) => pr.reviews.push({ ...review, id: `r${pr.reviews.length + 1}`, submittedAt: new Date().toISOString() }));
  }

  merge(number: number) {
    this.update(number, (pr) => (pr.state = "merged"));
  }
}
