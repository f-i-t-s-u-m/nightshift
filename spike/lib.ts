import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness, hook, ToolTask } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const ctx = BACKGROUND_CONTEXT;

export type Plan = { tool: string; args: Record<string, unknown> };

type Msg = { role: string; content: unknown };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === "object" && "text" in c ? String(c.text) : "")).join("");
  return "";
}

export function log(runDir: string, line: string) {
  appendFileSync(path.join(runDir, "log.txt"), `${new Date().toISOString()} [${process.pid}] ${line}\n`);
}

export function readPrs(file: string): Array<{ branch: string; number: number }> {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
}

function fakeGhCreate(file: string, branch: string) {
  const prs = readPrs(file);
  const pr = { branch, number: prs.length + 1 };
  prs.push(pr);
  writeFileSync(file, JSON.stringify(prs));
  return pr;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function prTools(runDir: string) {
  const prsFile = path.join(runDir, "prs.json");
  const createPrSafe = defineTool({
    name: "create_pr_safe",
    description: "Open a pull request for a branch, at most once",
    parameters: Type.Object({ branch: Type.String() }),
    replay: "safe",
    execute: async (args) => {
      const existing = readPrs(prsFile).find((p) => p.branch === args.branch);
      if (existing) {
        log(runDir, `create_pr_safe found existing PR #${existing.number}`);
        return { output: [{ type: "text", text: `PR #${existing.number} already open` }] };
      }
      const pr = fakeGhCreate(prsFile, args.branch);
      log(runDir, `create_pr_safe created PR #${pr.number}, now slow before returning`);
      await sleep(6000);
      return { output: [{ type: "text", text: `opened PR #${pr.number}` }] };
    },
  });
  const createPrNaive = defineTool({
    name: "create_pr_naive",
    description: "Open a pull request for a branch",
    parameters: Type.Object({ branch: Type.String() }),
    replay: "safe",
    execute: async (args) => {
      const pr = fakeGhCreate(prsFile, args.branch);
      log(runDir, `create_pr_naive created PR #${pr.number}, now slow before returning`);
      await sleep(6000);
      return { output: [{ type: "text", text: `opened PR #${pr.number}` }] };
    },
  });
  return defineExtension({ name: "pr", tools: [createPrSafe, createPrNaive] });
}

export function confineToCwd(runDir: string) {
  return defineExtension({
    name: "confine",
    hooks: [
      hook(ToolTask, {
        beforeTool: (call: { name: string; arguments?: Record<string, unknown>; args?: Record<string, unknown> }) => {
          const a = (call.arguments ?? call.args ?? {}) as Record<string, unknown>;
          const p = typeof a.path === "string" ? a.path : undefined;
          if (p && (path.isAbsolute(p) || p.split(/[\\/]/).includes(".."))) {
            log(runDir, `confine blocked ${call.name} ${p}`);
            return { block: "Only paths inside the task worktree are allowed" };
          }
          return undefined;
        },
      }),
    ],
  });
}

export async function openSpike(runDir: string, plans: Record<string, Plan>, options: { confine?: boolean } = {}) {
  const faux = fauxProvider({
    models: [{ id: "spike-model", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }],
  });
  const respond = (context: { messages: Msg[] }) => {
    const msgs = context.messages;
    const last = msgs.at(-1)!;
    const userTexts = msgs.filter((m) => m.role === "user").map((m) => textOf(m.content));
    log(runDir, `model called; last=${last.role}; users=${JSON.stringify(userTexts)}`);
    if (last.role === "user") {
      const text = textOf(last.content);
      const isFirstUser = userTexts.length === 1;
      const key = Object.keys(plans).find((k) => text.includes(k));
      if (isFirstUser && key) {
        const plan = plans[key];
        return fauxAssistantMessage(fauxToolCall(plan.tool, plan.args), { stopReason: "toolUse" });
      }
      return fauxAssistantMessage(fauxText(`ack: ${text}`));
    }
    return fauxAssistantMessage(fauxText(`finished after tool: ${textOf(last.content).slice(0, 200)}`));
  };
  faux.setResponses(Array.from({ length: 200 }, () => respond as never));

  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();

  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(prTools(runDir));
  if (options.confine) registry.install(confineToCwd(runDir));

  const storage = await openNodeSqliteStorage(path.join(runDir, "session.sqlite"));
  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      env: ({ cwd }: { cwd?: string }) => new NodeExecutionEnv({ cwd: cwd ?? runDir }),
    } as never,
    ctx,
  );
  const modelRef = { provider: model.provider, modelId: model.id };
  return { harness, modelRef, faux };
}
