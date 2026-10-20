import type { IssueSeverity, TesterFormat } from "@nightshift/core";

export type Finding = {
  title: string;
  detail: string;
  severity: IssueSeverity;
  file?: string;
  line?: number;
  decision?: { question: string; options: string[] };
};

export type ParsedResult = { findings: Finding[]; summary: string; ranOk: boolean; error: string | null };

const tail = (text: string, lines = 60) => text.trim().split("\n").slice(-lines).join("\n");

export function severityOf(value: unknown, fallback: IssueSeverity = "major"): IssueSeverity {
  const v = String(value ?? "").toLowerCase();
  if (/block|critical|fatal/.test(v)) return "blocker";
  if (/major|high|error|serious/.test(v)) return "major";
  if (/minor|medium|warn/.test(v)) return "minor";
  if (/info|low|nit|note|advis/.test(v)) return "info";
  return fallback;
}

function findJson(text: string): unknown {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates = [...fenced, text];
  for (const c of candidates) {
    const start = c.indexOf("{");
    const end = c.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      return JSON.parse(c.slice(start, end + 1));
    } catch {}
  }
  return null;
}

export function findingsFromJson(value: unknown): Finding[] | null {
  if (!value || typeof value !== "object" || !Array.isArray((value as { findings?: unknown }).findings)) return null;
  return ((value as { findings: Array<Record<string, unknown>> }).findings)
    .filter((f) => f && typeof f === "object" && (f.title || f.claim || f.detail))
    .map((f) => {
      const decision = f.decision as { question?: unknown; options?: unknown } | undefined;
      return {
        title: String(f.title ?? f.claim ?? f.detail).slice(0, 300),
        detail: String(f.detail ?? f.failure ?? f.title ?? "").slice(0, 4000),
        severity: severityOf(f.severity),
        ...(typeof f.file === "string" && f.file ? { file: f.file } : {}),
        ...(Number.isFinite(Number(f.line)) && f.line !== undefined && f.line !== null ? { line: Number(f.line) } : {}),
        ...(decision?.question
          ? { decision: { question: String(decision.question), options: Array.isArray(decision.options) ? decision.options.map(String).slice(0, 6) : [] } }
          : {}),
      };
    });
}

export function parseNightshiftJson(stdout: string, code: number): ParsedResult {
  const json = findJson(stdout) as { summary?: unknown } | null;
  const findings = findingsFromJson(json);
  if (!findings) {
    return code === 0
      ? { findings: [], summary: "No JSON findings printed; the command passed.", ranOk: true, error: null }
      : { findings: [], summary: "", ranOk: false, error: `The tester exited with ${code} without printing the JSON result: ${tail(stdout, 20)}` };
  }
  return { findings, summary: String(json?.summary ?? `${findings.length} finding(s)`), ranOk: true, error: null };
}

const UMBRA_LINE = /^\s*\[([a-z]+)\]\s+(.+?):(\d+|\?)\s+\(([^)]*)\)\s+-\s+(.+)$/i;

export function parseUmbra(stdout: string, stderr: string, code: number): ParsedResult {
  const text = `${stdout}\n${stderr}`;
  const verdict = text.match(/verdict:\s*(BLOCKED|INCONCLUSIVE|APPROVED)[^\n]*/i);
  if (!verdict) {
    return { findings: [], summary: "", ranOk: false, error: `Umbra did not report a verdict (exit ${code}): ${tail(text, 20)}` };
  }
  const findings: Finding[] = [];
  let section: "blocking" | "advisory" | "unadjudicated" | null = null;
  const lines = stdout.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^blocking \(\d+\)/i.test(line.trim())) section = "blocking";
    else if (/^advisory \(\d+\)/i.test(line.trim())) section = "advisory";
    else if (/^UNADJUDICATED \(\d+\)/.test(line.trim())) section = "unadjudicated";
    else if (/^\d+ candidate finding/.test(line.trim()) || /^awaiting human decision/.test(line.trim())) section = null;
    const m = line.match(UMBRA_LINE);
    if (!m || !section) continue;
    const [, sev, file, lineNo, lens, claim] = m;
    const failure = lines[i + 1]?.trim().startsWith("failure:") ? lines[i + 1].trim().slice(8).trim() : "";
    const base = {
      title: claim.slice(0, 300),
      detail: [failure && `Failure: ${failure}`, `Lens: ${lens}`].filter(Boolean).join("\n"),
      ...(file !== "?" ? { file } : {}),
      ...(lineNo !== "?" ? { line: Number(lineNo) } : {}),
    };
    if (section === "blocking") findings.push({ ...base, severity: severityOf(sev) === "info" || severityOf(sev) === "minor" ? "major" : severityOf(sev) });
    else if (section === "advisory") findings.push({ ...base, severity: severityOf(sev) === "blocker" ? "minor" : severityOf(sev, "minor") === "major" ? "minor" : severityOf(sev, "minor") });
    else
      findings.push({
        ...base,
        severity: "major",
        decision: { question: `Umbra could not decide whether this is a real problem: "${claim.slice(0, 200)}". What should the agent do?`, options: ["Fix it", "Ignore it"] },
      });
  }
  const outcome = verdict[1].toUpperCase();
  if (outcome === "INCONCLUSIVE" && !findings.some((f) => f.decision)) {
    findings.push({
      title: "Umbra could not judge every serious claim",
      detail: tail(stdout, 40),
      severity: "major",
      decision: { question: "Umbra's review was inconclusive. Should the agent keep going or should a human look first?", options: ["Continue to the PR", "Stop for a human review"] },
    });
  }
  return { findings, summary: verdict[0].trim(), ranOk: true, error: null };
}

export function parseExitCode(name: string, stdout: string, stderr: string, code: number): ParsedResult {
  if (code === 0) return { findings: [], summary: "Passed", ranOk: true, error: null };
  return {
    findings: [{ title: `${name} failed (exit ${code})`, detail: tail(`${stdout}\n${stderr}`, 80), severity: "blocker" }],
    summary: `Failed with exit ${code}`,
    ranOk: true,
    error: null,
  };
}

export function parseTesterOutput(format: TesterFormat, name: string, stdout: string, stderr: string, code: number): ParsedResult {
  if (format === "umbra") return parseUmbra(stdout, stderr, code);
  if (format === "nightshift-json") return parseNightshiftJson(stdout, code);
  return parseExitCode(name, stdout, stderr, code);
}

export function parseReviewAnswer(answer: string): Finding[] {
  const json = findingsFromJson(findJson(answer));
  if (json) return json;
  const items = answer
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^(\d+[.)]|[-*])\s+/.test(l))
    .map((l) => l.replace(/^(\d+[.)]|[-*])\s+/, ""));
  const list = items.length ? items : [answer.trim()];
  return list.map((text) => {
    const loc = text.match(/^([\w./-]+\.\w+)(?::(\d+))?\s*[:—-]\s*(.+)$/);
    return {
      title: (loc ? loc[3] : text).slice(0, 300),
      detail: text,
      severity: "major" as const,
      ...(loc ? { file: loc[1] } : {}),
      ...(loc?.[2] ? { line: Number(loc[2]) } : {}),
    };
  });
}
