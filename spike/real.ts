import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { confineToCwd } from "./lib.ts";

const ctx = BACKGROUND_CONTEXT;
const runDir = path.resolve(import.meta.dirname, "..", ".nightshift", "spike-runs", "real");

const candidates = [
  { provider: "anthropic", modelId: process.env.NIGHTSHIFT_ANTHROPIC_MODEL ?? "claude-sonnet-5-5", key: "ANTHROPIC_API_KEY" },
  { provider: "openai", modelId: process.env.NIGHTSHIFT_OPENAI_MODEL ?? "gpt-6-sol", key: "OPENAI_API_KEY" },
].filter((c) => process.env[c.key]);

if (candidates.length === 0) {
  console.error("No ANTHROPIC_API_KEY or OPENAI_API_KEY in .env");
  process.exit(1);
}

function makeRepo(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "demo", type: "module" }));
  writeFileSync(
    path.join(dir, "price.js"),
    "export function totalWithTax(items, taxRate) {\n  const subtotal = items.reduce((sum, item) => sum + item.price, 0);\n  return subtotal + taxRate;\n}\n",
  );
  writeFileSync(
    path.join(dir, "price.test.js"),
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { totalWithTax } from "./price.js";\n\ntest("adds tax as a percentage", () => {\n  assert.equal(totalWithTax([{ price: 100 }, { price: 50 }], 0.2), 180);\n});\n',
  );
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["-c", "user.name=nightshift", "-c", "user.email=nightshift@local", "commit", "-qm", "base"], { cwd: dir });
}

const models = createModels();
models.setProvider(anthropicProvider());
models.setProvider(openaiProvider());

const registry = createRegistry();
registry.install(CodingTools);
registry.install(confineToCwd(runDir));

mkdirSync(runDir, { recursive: true });
const harness = await Harness.open(
  await openNodeSqliteStorage(path.join(runDir, `session-${Date.now()}.sqlite`)),
  { models, registry, env: ({ cwd }: { cwd?: string }) => new NodeExecutionEnv({ cwd: cwd ?? runDir }) } as never,
  ctx,
);

const task =
  "WonderCall task #1: Customers report that totals with tax are wrong. `node --test` fails. Find the cause in this repo, fix it, run `node --test` until it passes, and reply with a one-paragraph summary of the change.";

const results = await Promise.all(
  candidates.map(async (c) => {
    const repo = path.join(runDir, `repo-${c.provider}`);
    makeRepo(repo);
    const started = Date.now();
    const conv = (await harness.createConversation(
      { ownership: { kind: "ownerless" }, agent: { model: { provider: c.provider, modelId: c.modelId }, cwd: repo } } as never,
      ctx,
    )) as never as { submit(d: unknown, x: unknown): Promise<{ wait(x: unknown): Promise<{ status: string; reason?: unknown }> }> };
    const settled = await (await conv.submit({ type: "input", content: task, requestId: `task-1:${c.provider}` }, ctx)).wait(ctx);
    let testsPass = false;
    try {
      execFileSync("node", ["--test"], { cwd: repo, stdio: "ignore" });
      testsPass = true;
    } catch {}
    const diff = execFileSync("git", ["diff"], { cwd: repo, encoding: "utf8" });
    return { provider: c.provider, model: c.modelId, status: settled.status, reason: settled.reason, testsPass, seconds: Math.round((Date.now() - started) / 1000), diff };
  }),
);

const usage = await (harness as never as { usage(c: unknown): Promise<unknown> }).usage(ctx);
console.log(JSON.stringify({ results, usage }, null, 2));
writeFileSync(path.join(runDir, "result.json"), JSON.stringify({ results, usage }, null, 2));
await harness.close(ctx);
process.exit(0);
