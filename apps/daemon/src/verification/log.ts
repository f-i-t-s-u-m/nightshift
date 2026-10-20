import { randomUUID } from "node:crypto";
import type { Decision, DecisionKind, Issue, IssueSource, StepKind, StepStatus, VerificationStep } from "@nightshift/core";
import type { Store } from "@nightshift/store";
import type { Finding } from "./parsers.ts";

type Doc = { round: number; steps: VerificationStep[]; issues: Issue[]; decisions: Decision[] };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 120);

export class VerificationLog {
  constructor(
    private readonly store: Store,
    private readonly onChange: (runId: string) => void,
  ) {}

  private key(runId: string) {
    return `verify:${runId}`;
  }

  doc(runId: string): Doc {
    return this.store.setting<Doc>(this.key(runId), { round: 1, steps: [], issues: [], decisions: [] });
  }

  private save(runId: string, doc: Doc) {
    this.store.setSetting(this.key(runId), doc);
    this.onChange(runId);
  }

  private mutate<T>(runId: string, fn: (doc: Doc) => T): T {
    const doc = this.doc(runId);
    const out = fn(doc);
    this.save(runId, doc);
    return out;
  }

  round(runId: string) {
    return this.doc(runId).round;
  }

  nextRound(runId: string) {
    return this.mutate(runId, (d) => {
      if (d.steps.length) d.round += 1;
      return d.round;
    });
  }

  startStep(runId: string, kind: StepKind, title: string, detail?: string, testerId?: string): string {
    return this.mutate(runId, (d) => {
      for (const s of d.steps) if (s.status === "running" && s.kind === kind) s.status = "skipped";
      const step: VerificationStep = { id: randomUUID(), round: d.round, kind, title, status: "running", startedAt: new Date().toISOString(), issueIds: [], ...(detail ? { detail } : {}), ...(testerId ? { testerId } : {}) };
      d.steps.push(step);
      return step.id;
    });
  }

  noteStep(runId: string, stepId: string, note: string | null) {
    this.mutate(runId, (d) => {
      const s = d.steps.find((x) => x.id === stepId);
      if (!s) return;
      if (note) s.note = note;
      else delete s.note;
    });
  }

  finishStep(runId: string, stepId: string, status: StepStatus, extra: { detail?: string; output?: string; issueIds?: string[]; title?: string } = {}) {
    this.mutate(runId, (d) => {
      const s = d.steps.find((x) => x.id === stepId);
      if (!s) return;
      s.status = status;
      s.endedAt = new Date().toISOString();
      delete s.note;
      if (extra.detail !== undefined) s.detail = extra.detail;
      if (extra.output !== undefined) s.output = extra.output.slice(-20_000);
      if (extra.title) s.title = extra.title;
      if (extra.issueIds) s.issueIds = [...new Set([...s.issueIds, ...extra.issueIds])];
    });
  }

  reconcile(runId: string, source: IssueSource, sourceName: string, findings: Finding[]): Issue[] {
    return this.mutate(runId, (d) => {
      const now = new Date().toISOString();
      const current: Issue[] = [];
      const seen = new Set<string>();
      for (const f of findings) {
        const key = norm(f.title);
        if (seen.has(key)) continue;
        seen.add(key);
        const existing = d.issues.find((i) => i.source === source && i.sourceName === sourceName && norm(i.title) === key && i.status !== "fixed");
        if (existing) {
          existing.round = d.round;
          existing.detail = f.detail || existing.detail;
          current.push(existing);
          continue;
        }
        const issue: Issue = {
          id: randomUUID(),
          runId,
          source,
          sourceName,
          title: f.title,
          detail: f.detail,
          severity: f.severity,
          ...(f.file ? { file: f.file } : {}),
          ...(f.line !== undefined ? { line: f.line } : {}),
          status: "open",
          round: d.round,
          foundAt: now,
        };
        d.issues.push(issue);
        current.push(issue);
      }
      for (const i of d.issues) {
        if (i.source === source && i.sourceName === sourceName && (i.status === "open" || i.status === "needs_decision") && !seen.has(norm(i.title)) && !i.decisionId) {
          i.status = "fixed";
          i.resolvedAt = now;
          i.fixedRound = d.round;
        }
      }
      return current;
    });
  }

  resolveSource(runId: string, source: IssueSource) {
    this.mutate(runId, (d) => {
      const now = new Date().toISOString();
      for (const i of d.issues) if (i.source === source && i.status === "open") Object.assign(i, { status: "fixed", resolvedAt: now, fixedRound: d.round });
    });
  }

  setIssueStatus(runId: string, issueId: string, status: Issue["status"]): Issue | null {
    return this.mutate(runId, (d) => {
      const i = d.issues.find((x) => x.id === issueId);
      if (!i) return null;
      i.status = status;
      if (status === "fixed" || status === "dismissed") i.resolvedAt = new Date().toISOString();
      else delete i.resolvedAt;
      return { ...i };
    });
  }

  addDecision(runId: string, input: { kind: DecisionKind; question: string; context: string; options: string[]; source: string; issueId?: string }): Decision {
    return this.mutate(runId, (d) => {
      const dup = d.decisions.find((x) => x.status === "open" && x.question === input.question);
      if (dup) return dup;
      const decision: Decision = {
        id: randomUUID(),
        runId,
        kind: input.kind,
        question: input.question,
        context: input.context,
        options: input.options,
        status: "open",
        askedAt: new Date().toISOString(),
        source: input.source,
      };
      d.decisions.push(decision);
      if (input.issueId) {
        const issue = d.issues.find((i) => i.id === input.issueId);
        if (issue) Object.assign(issue, { status: "needs_decision", decisionId: decision.id });
      }
      return decision;
    });
  }

  answerDecision(runId: string, decisionId: string, answer: string): Decision | null {
    return this.mutate(runId, (d) => {
      const decision = d.decisions.find((x) => x.id === decisionId);
      if (!decision || decision.status !== "open") return null;
      Object.assign(decision, { status: "answered", answer, answeredAt: new Date().toISOString() });
      const ignore = /^(ignore|won'?t|no\b|dismiss|keep it|continue to the pr|open the pr)/i.test(answer.trim());
      for (const i of d.issues) {
        if (i.decisionId !== decisionId) continue;
        i.status = ignore ? "dismissed" : "open";
        if (ignore) i.resolvedAt = new Date().toISOString();
      }
      return { ...decision };
    });
  }

  answerOpenDecisions(runId: string, answer: string) {
    for (const d of this.doc(runId).decisions.filter((x) => x.status === "open")) this.answerDecision(runId, d.id, answer);
  }

  openDecisions(runId: string) {
    return this.doc(runId).decisions.filter((d) => d.status === "open");
  }

  openBlocking(runId: string) {
    return this.doc(runId).issues.filter((i) => i.status === "open" && (i.severity === "blocker" || i.severity === "major"));
  }

  openIssues(runId: string) {
    return this.doc(runId).issues.filter((i) => i.status === "open" || i.status === "needs_decision");
  }
}
