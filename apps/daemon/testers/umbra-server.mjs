#!/usr/bin/env node
/**
 * Nightshift tester: Umbra's review on the owner's Claude subscription (Umbra "path B").
 *
 * `umbra review` on the command line needs a metered ANTHROPIC_API_KEY. A subscription review runs inside the
 * Umbra server instead (`bun run serve` in the Umbra checkout, with Docker running): this script starts it with
 * POST /api/pathb-run, follows the run on /api/stream, reads the verdict from /api/history/<runId> and prints it
 * in Nightshift's tester JSON format. Progress goes to stderr; only the result goes to stdout.
 *
 *   node umbra-server.mjs [--url http://127.0.0.1:4173] [--profile full|lite] [--exec | --no-exec] [--timeout-minutes 70]
 *
 * Reads NIGHTSHIFT_WORKTREE, NIGHTSHIFT_BASE, NIGHTSHIFT_TASK (and NIGHTSHIFT_REMOTE) that Nightshift sets for testers.
 * Exits 0 with JSON when Umbra produced a verdict, 1 with a plain message when it could not run.
 */
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return fallback;
  return args[i].includes("=") ? args[i].slice(args[i].indexOf("=") + 1) : (args[i + 1] ?? fallback);
};
const url = String(flag("url", process.env.UMBRA_URL || "http://127.0.0.1:4173")).replace(/\/$/, "");
const profile = flag("profile", "full") === "lite" ? "lite" : "full";
const exec = args.includes("--exec") ? true : args.includes("--no-exec") ? false : undefined;
const timeoutMs = Number(flag("timeout-minutes", "70")) * 60_000;
const retryMs = Number(flag("retry-seconds", "30")) * 1000;
const pollMs = Number(flag("poll-seconds", "30")) * 1000;
const deadline = Date.now() + timeoutMs;

const log = (msg) => process.stderr.write(`[umbra] ${msg}\n`);
const fail = (msg) => {
  process.stdout.write(`Umbra could not review this change: ${msg}\n`);
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const worktree = process.env.NIGHTSHIFT_WORKTREE;
const baseBranch = process.env.NIGHTSHIFT_BASE;
const task = (process.env.NIGHTSHIFT_TASK || "").trim();
if (!worktree || !baseBranch || !task) fail("run it as a Nightshift tester (NIGHTSHIFT_WORKTREE, NIGHTSHIFT_BASE and NIGHTSHIFT_TASK are not set)");

const git = (...a) => execFileSync("git", a, { cwd: worktree, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const remote = process.env.NIGHTSHIFT_REMOTE || "origin";
let base;
let head;
try {
  const baseRef = [`${remote}/${baseBranch}`, baseBranch].find((ref) => {
    try {
      git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
      return true;
    } catch {
      return false;
    }
  });
  if (!baseRef) fail(`the base branch ${baseBranch} was not found in the workspace`);
  // SHAs, not names: Umbra reviews a clone of the workspace, where the remote's branch names do not exist.
  base = git("merge-base", baseRef, "HEAD");
  head = git("rev-parse", "HEAD");
} catch (error) {
  fail(`git failed in ${worktree}: ${error.stderr || error.message}`);
}
if (base === head) fail("there are no commits on this branch yet, so there is nothing to review");

const request = async (path, init = {}) => {
  const res = await fetch(`${url}${path}`, { ...init, signal: AbortSignal.timeout(init.timeout ?? 30_000) });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body, text };
};

try {
  await request("/api/health", { timeout: 5000 });
} catch {
  fail(`the Umbra server is not running at ${url}. Start it in the Umbra folder with \`bun run serve\` (Docker Desktop must be running too), then run this tester again.`);
}

// Follow Umbra's live events from before the run starts, so run.done / run.failed cannot slip past.
const events = [];
const stream = new AbortController();
(async () => {
  while (!stream.signal.aborted) {
    try {
      const res = await fetch(`${url}/api/stream`, { headers: { accept: "text/event-stream" }, signal: stream.signal });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data:")) continue;
            try {
              events.push(JSON.parse(line.slice(5).trim()));
            } catch {}
          }
        }
      }
    } catch {}
    if (!stream.signal.aborted) await sleep(2000);
  }
})();

let runId = null;
const cancel = async () => {
  if (!runId) return;
  log(`cancelling Umbra run ${runId}`);
  await request("/api/cancel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId }), timeout: 5000 }).catch(() => {});
};
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    void cancel().finally(() => process.exit(1));
  });
}

// One path-B run at a time on the Umbra server: wait for a free turn.
log(`reviewing ${base.slice(0, 8)}..${head.slice(0, 8)} on ${url} (profile ${profile}${exec === undefined ? "" : exec ? ", exec" : ", no exec"})`);
for (;;) {
  const res = await request("/api/pathb-run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task, targetRepo: worktree, funnel: "review", base, head, profile, ...(exec === undefined ? {} : { exec }) }),
  }).catch((error) => fail(`could not reach ${url}: ${error.message}`));
  if (res.status === 200 && res.body?.runId) {
    runId = res.body.runId;
    break;
  }
  const error = res.body?.error ?? res.text.slice(0, 500);
  if (res.status === 409 && /already active/i.test(error) && Date.now() + retryMs < deadline) {
    log(`${error}; trying again in ${Math.round(retryMs / 1000)} s`);
    await sleep(retryMs);
    continue;
  }
  fail(`the Umbra server refused the review (${res.status}): ${error}`);
}
log(`started ${runId}; follow it at ${url}`);

const mine = () => events.filter((e) => e && e.runId === runId);
let seen = 0;
let doneAt = 0;
let lastPoll = 0;
let detail = null;
while (Date.now() < deadline) {
  const list = mine();
  for (const e of list.slice(seen)) {
    if (e.kind === "phase") log(`phase: ${e.phase ?? e.name ?? JSON.stringify(e)}`);
    else if (e.kind === "log" && e.level !== "info") log(`${e.level}: ${e.msg}`);
    else if (e.kind === "run.done") log("Umbra finished; reading the verdict");
  }
  seen = list.length;
  const failed = list.find((e) => e.kind === "run.failed");
  if (failed) {
    stream.abort();
    const cause = failed.detail?.cause ? `\nCause: ${failed.detail.cause}` : "";
    const tail = failed.detail?.logTail ? `\n${String(failed.detail.logTail).split("\n").slice(-15).join("\n")}` : "";
    fail(`run ${runId} failed: ${failed.error}${cause}${tail}`);
  }
  if (!doneAt && list.some((e) => e.kind === "run.done")) doneAt = Date.now();
  // The verdict is recorded after the session ends, a little after run.done; poll more often then.
  if (Date.now() - lastPoll >= (doneAt ? 5000 : pollMs)) {
    lastPoll = Date.now();
    const res = await request(`/api/history/${encodeURIComponent(runId)}`).catch(() => null);
    if (res?.status === 200 && res.body && !res.body.error) {
      detail = res.body;
      break;
    }
    if (res?.status === 200 && res.body?.error) fail(`Umbra recorded run ${runId} but could not read it: ${res.body.error}`);
  }
  if (doneAt && Date.now() - doneAt > 5 * 60_000) fail(`run ${runId} reported done, but its verdict never appeared in Umbra's history (check the Umbra server log)`);
  await sleep(1000);
}
stream.abort();
if (!detail) {
  await cancel();
  fail(`run ${runId} did not finish within ${Math.round(timeoutMs / 60_000)} minutes`);
}

// The same rule as Umbra's resolveReview: verified blocker/major block, verified minor/nit advise, unruled blocker/major hold.
const findings = Array.isArray(detail.findings) ? detail.findings : [];
const serious = (f) => f.severity === "blocker" || f.severity === "major";
const verified = findings.filter((f) => f.verdict === "verified");
const blocking = verified.filter(serious);
const advisory = verified.filter((f) => !serious(f));
const unruled = findings.filter((f) => f.verdict === "insufficient");
const holding = unruled.filter(serious);
const refuted = findings.filter((f) => f.verdict === "rejected");
const outcome = blocking.length ? "BLOCKED" : holding.length ? "INCONCLUSIVE" : "APPROVED";
const where = (f) => (f.file ? { file: f.file, ...(Number.isFinite(f.line) && f.line > 0 ? { line: f.line } : {}) } : {});
const describe = (f) =>
  [
    f.failureScenario && `Scenario: ${f.failureScenario}`,
    f.lens && `Lens: ${f.lens}${f.category ? ` (${f.category})` : ""}`,
    Number.isFinite(f.confidence) && `Confidence: ${Math.round(f.confidence * 100)}%`,
    f.notRuled && `Not ruled: ${f.notRuled}`,
    `Umbra run: ${runId}`,
  ]
    .filter(Boolean)
    .join("\n");
const out = [
  ...blocking.map((f) => ({ title: f.claim, detail: describe(f), severity: f.severity === "blocker" ? "blocker" : "major", ...where(f) })),
  ...advisory.map((f) => ({ title: f.claim, detail: describe(f), severity: f.severity === "nit" ? "info" : "minor", ...where(f) })),
  ...holding.map((f) => ({
    title: f.claim,
    detail: describe(f),
    severity: "major",
    ...where(f),
    decision: { question: `Umbra could not decide whether this is a real problem: "${String(f.claim).slice(0, 200)}". What should the agent do?`, options: ["Fix it", "Ignore it"] },
  })),
  ...unruled.filter((f) => !serious(f)).map((f) => ({ title: f.claim, detail: describe(f), severity: "info", ...where(f) })),
];
const summary = `verdict: ${outcome} · ${blocking.length} blocking, ${advisory.length} advisory, ${holding.length} undecided, ${refuted.length} refuted (Umbra path B on your subscription, run ${runId})`;
process.stdout.write(`${JSON.stringify({ summary, findings: out }, null, 2)}\n`);
process.exit(0);
