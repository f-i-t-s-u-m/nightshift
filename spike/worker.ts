import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { ctx, log, openSpike, type Plan } from "./lib.ts";

const [scenario, runDir, phase] = process.argv.slice(2);
mkdirSync(runDir, { recursive: true });

const marker = (name: string) => path.join(runDir, name);

const plans: Record<string, Plan> = {
  "task:long-bash": { tool: "bash", args: { command: `sleep 8 && echo finished > ${marker("bash-marker.txt")}` } },
  "task:pr-safe": { tool: "create_pr_safe", args: { branch: "nightshift/1-demo" } },
  "task:pr-naive": { tool: "create_pr_naive", args: { branch: "nightshift/2-demo" } },
  "task:steer": { tool: "bash", args: { command: "sleep 3 && echo working" } },
  "task:read-outside": { tool: "read", args: { path: "/etc/hosts" } },
  "task:parallel": { tool: "bash", args: { command: "sleep 6 && echo done > result.txt" } },
};

const confine = scenario === "confine";
const { harness, modelRef } = await openSpike(runDir, plans, { confine });

async function conversationFor(name: string, cwd: string) {
  const idsFile = path.join(runDir, "conversations.json");
  const ids: Record<string, string> = existsSync(idsFile) ? JSON.parse(readFileSync(idsFile, "utf8")) : {};
  if (ids[name]) return (await (harness as never as { conversation(id: string, c: unknown): Promise<unknown> }).conversation(ids[name], ctx)) as never;
  const conv = (await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: modelRef, cwd } } as never, ctx)) as never as { id: string };
  ids[name] = conv.id;
  writeFileSync(idsFile, JSON.stringify(ids));
  return conv as never;
}

type Conv = {
  id: string;
  submit(d: unknown, c: unknown): Promise<{ id: string; wait(c: unknown): Promise<{ status: string; reason?: unknown }> }>;
  viewState(c: unknown): Promise<{ value: { entries: Array<{ kind: string; data?: unknown; model?: unknown }> } }>;
};

async function runOne(conv: Conv, content: string, requestId: string) {
  const sub = await conv.submit({ type: "input", content, requestId }, ctx);
  log(runDir, `submitted ${requestId} -> ${sub.id}`);
  const settled = await sub.wait(ctx);
  log(runDir, `settled ${requestId}: ${settled.status}`);
  return settled;
}

async function transcript(conv: Conv) {
  const view = await conv.viewState(ctx);
  return view.value.entries.map((e) => ({ kind: e.kind, model: JSON.stringify(e.model ?? e.data ?? "").slice(0, 300) }));
}

const out: Record<string, unknown> = { scenario, phase };

if (phase === "resume") (harness as never as { resume(): void }).resume();

if (scenario === "long-bash" || scenario === "pr-safe" || scenario === "pr-naive" || scenario === "confine") {
  const key = scenario === "confine" ? "task:read-outside" : `task:${scenario}`;
  const conv = (await conversationFor("main", runDir)) as Conv;
  const settled = await runOne(conv, `Please do ${key}`, `req:${scenario}`);
  out.status = settled.status;
  out.transcript = await transcript(conv);
}

if (scenario === "steer") {
  const conv = (await conversationFor("main", runDir)) as Conv;
  const first = await conv.submit({ type: "input", content: "Please do task:steer", requestId: "req:steer-1" }, ctx);
  await new Promise((r) => setTimeout(r, 1000));
  const steer = await conv.submit({ type: "input", content: "Review comment: rename the variable", whenBusy: "steer", requestId: "req:steer-2" }, ctx);
  out.first = (await first.wait(ctx)).status;
  out.steer = (await steer.wait(ctx)).status;
  out.transcript = await transcript(conv);
}

if (scenario === "dedupe") {
  const conv = (await conversationFor("main", runDir)) as Conv;
  const a = await conv.submit({ type: "input", content: "CI failed: test X", requestId: "task-1:ci-123" }, ctx);
  const b = await conv.submit({ type: "input", content: "CI failed: test X", requestId: "task-1:ci-123" }, ctx);
  await a.wait(ctx);
  out.sameSubmission = a.id === b.id;
  out.userEntries = (await transcript(conv)).filter((e) => e.kind === "pi.user").length;
}

if (scenario === "parallel") {
  const names = ["task-a", "task-b", "task-c"];
  const runs = names.map(async (n) => {
    const wt = path.join(runDir, "workspaces", n);
    mkdirSync(wt, { recursive: true });
    const conv = (await conversationFor(n, wt)) as Conv;
    const s = await runOne(conv, "Please do task:parallel", `req:${n}`);
    return [n, s.status, existsSync(path.join(wt, "result.txt"))];
  });
  out.results = await Promise.all(runs);
}

const usage = await (harness as never as { usage(c: unknown): Promise<unknown> }).usage(ctx);
out.usage = usage;
writeFileSync(path.join(runDir, `result-${phase}.json`), JSON.stringify(out, null, 2));
log(runDir, `phase ${phase} complete`);
await harness.close(ctx);
process.exit(0);
