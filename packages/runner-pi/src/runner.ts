import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  createRegistry,
  defineExtension,
  Harness,
  LiveDoc,
  UsageDoc,
  watchEvents,
  type AgentEventStream,
  type Extension,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import type { AgentActivity, AgentCreate, AgentMessage, AgentRunner, AgentSettled, ModelUsage, TranscriptItem } from "@nightshift/core";
import { createGuardExtension } from "./guard.ts";
import { ProcessReaper } from "./reaper.ts";
import { createTaskToolsExtension, createTeamExtension, submitPlanTool, type RunBridge } from "./task-tools.ts";

const ctx = BACKGROUND_CONTEXT;

type EntryMessage = { role: string; content?: unknown; toolName?: string; toolCallId?: string; isError?: boolean; timestamp?: number };

type Entry = { id: unknown; kind: string; data?: unknown; model?: EntryMessage[] };

type Settled = { status: "done" | "unanswered"; reason?: unknown; answer?: unknown };

type AnyConversation = {
  id: unknown;
  submit(d: unknown, c: unknown): Promise<{ id: unknown; wait(c: unknown): Promise<Settled> }>;
  abort(c: unknown, options?: unknown): Promise<void>;
  configure(change: unknown, c: unknown): Promise<void>;
  compact(instructions: string | undefined, c: unknown): Promise<unknown>;
  entries(query: unknown, limit: number, cursor: unknown, c: unknown): Promise<{ items: Entry[] }>;
  commit<T>(change: (tx: { entry(token: unknown, id: unknown): Promise<Entry | undefined> }) => Promise<T>, c: unknown): Promise<T>;
};

type AnyHarness = {
  resume(): void;
  close(c: unknown): Promise<unknown>;
  closed: Promise<{ reason: string; error?: unknown }>;
  conversation(id: unknown, c: unknown): Promise<AnyConversation | undefined>;
  createConversation(options: unknown, c: unknown): Promise<AnyConversation>;
  snapshot<T>(doc: unknown, id: unknown, c: unknown): Promise<T>;
  inspect(c: unknown): Promise<{ tasks: Array<{ state: { kind?: string; status?: string; reason?: unknown } | string; record: { id: unknown; kind?: string } }> }>;
};

type PiUsage = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };

type LiveState = {
  run?: unknown;
  generation?: { message?: { content?: Array<{ type: string; text?: string; name?: string }> } };
  tools?: Array<{ name: string; status: string; output?: string }>;
};

export type ModelRef = { provider: string; modelId: string };

export type PiRunnerOptions = {
  dataDir: string;
  models: Models;
  model: ModelRef;
  reviewModel?: ModelRef;
  bridge: RunBridge;
  envFor?: (cwd: string) => Record<string, string>;
  extensions?: Extension[];
  onFatal?: (error: unknown) => void;
  onReport?: (report: unknown) => void;
  streamTimeoutMs?: number;
};

export const MESSAGE_ENTRY_KIND = "nightshift.message";

const TERMINATING_TOOLS = new Set(["ask_question", "submit_plan"]);

const USER_KINDS = new Set(["pi.user", MESSAGE_ENTRY_KIND]);

const piId = (id: string) => (/^\d+$/.test(id) ? Number(id) : id) as unknown as string;

const iso = (ms?: number) => (typeof ms === "number" ? new Date(ms).toISOString() : null);

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && typeof c === "object" && "type" in c && c.type === "text" && "text" in c ? String(c.text) : ""))
    .join("")
    .trim();
}

function toolSummary(name: string, args: Record<string, unknown>): string {
  if (name === "bash" && typeof args.command === "string") return args.command.split("\n")[0].slice(0, 160);
  if (typeof args.path === "string") return args.path;
  if (typeof args.question === "string") return args.question.slice(0, 160);
  if (typeof args.plan === "string") return args.plan.split("\n")[0].slice(0, 160);
  if (typeof args.body === "string") return args.body.slice(0, 160);
  const text = JSON.stringify(args);
  return text === "{}" ? "" : text.slice(0, 160);
}

function userContent(message: AgentMessage) {
  return message.images?.length
    ? [{ type: "text", text: message.text }, ...message.images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }))]
    : message.text;
}

function entryData(message: AgentMessage, messageIds: string[] = []) {
  return { author: message.author, text: message.text, attachments: message.attachments ?? [], messageIds };
}

export class PiRunner implements AgentRunner {
  private defaultModel!: ModelRef;
  private reviewModel!: ModelRef;
  private tools!: { read: unknown; bash: unknown; write: unknown; edit: unknown; submitPlan: unknown };
  private planExt!: Extension;
  private teamExt!: Extension;

  private constructor(
    private readonly harness: AnyHarness,
    readonly reaper: ProcessReaper,
    readonly reaped: number[],
  ) {}

  static async open(options: PiRunnerOptions): Promise<PiRunner> {
    const reaper = new ProcessReaper(path.join(options.dataDir, "pids"));
    const reaped = reaper.reapAll();

    let images: unknown;
    try {
      const mod = await import("@earendil-works/pi-durable/images/node");
      images = await (mod as { createNodePhotonImages(): Promise<unknown> }).createNodePhotonImages();
    } catch {
      images = undefined;
    }
    const read = createReadTool(images ? ({ images } as never) : undefined);
    const write = createWriteTool();
    const edit = createEditTool();
    const bash = createBashTool({
      prepare: (execution, api) => {
        execution.command = reaper.wrap(execution.command, String((api as unknown as { conversationId: string }).conversationId));
      },
    });

    const submitPlan = submitPlanTool(options.bridge);
    const coding = defineExtension({ name: "nightshift-coding", tools: [read, write, edit, bash] });
    const taskTools = createTaskToolsExtension(options.bridge);
    const guard = createGuardExtension(
      (id) => options.bridge.contextFor(id)?.cwd,
      (id) => {
        const rc = options.bridge.contextFor(id);
        return rc ? options.bridge.protectedFiles(rc) : [];
      },
    );
    const planExt = defineExtension({ name: "nightshift-plan", tools: [submitPlan] });
    const teamExt = createTeamExtension(options.bridge);
    const registry = createRegistry();
    const defaults = [coding, taskTools, guard, ...(options.extensions ?? [])];
    for (const extension of [...defaults, planExt, teamExt]) registry.install(extension);

    const storage = await openNodeSqliteStorage(path.join(options.dataDir, "pi.sqlite"));
    const harness = (await Harness.open(
      storage,
      {
        models: options.models,
        registry,
        env: ({ cwd }: { cwd?: string }) => (cwd ? new NodeExecutionEnv({ cwd, shellEnv: { ...process.env, ...(options.envFor?.(cwd) ?? {}) } }) : undefined),
        settings: {
          extensions: defaults,
          stream: { timeoutMs: options.streamTimeoutMs ?? 300_000 },
          retry: { maxRetries: 6 },
          compaction: { enabled: true },
        },
        onReport: options.onReport,
      } as never,
      ctx,
    )) as unknown as AnyHarness;
    harness.closed.then((end) => {
      if (end.reason === "failed") options.onFatal?.(end.error);
    });
    const runner = new PiRunner(harness, reaper, reaped);
    runner.defaultModel = options.model;
    runner.reviewModel = options.reviewModel ?? options.model;
    runner.tools = { read, bash, write, edit, submitPlan };
    runner.planExt = planExt;
    runner.teamExt = teamExt;
    harness.resume();
    return runner;
  }

  async health(): Promise<{ blocked: string[]; tasks: number }> {
    const inspection = await this.harness.inspect(ctx);
    const blocked = inspection.tasks
      .filter((t) => (typeof t.state === "string" ? t.state === "blocked" : t.state.kind === "blocked" || t.state.status === "blocked"))
      .map((t) => `${t.record.kind ?? "task"} ${String(t.record.id)}: ${JSON.stringify((t.state as { reason?: unknown }).reason ?? t.state)}`);
    return { blocked, tasks: inspection.tasks.length };
  }

  private async conversation(id: string) {
    const conversation = await this.harness.conversation(piId(id), ctx);
    if (!conversation) throw new Error(`conversation ${id} not found`);
    return conversation;
  }

  async create(input: AgentCreate): Promise<string> {
    const conversation = await this.harness.createConversation(
      { ownership: { kind: "ownerless" }, agent: { model: input.model ?? this.defaultModel, cwd: input.cwd, instructions: input.instructions } },
      ctx,
    );
    return String(conversation.id);
  }

  /** A team worker: the coding tools only (no task tools: it cannot ask the owner, comment or delegate). */
  async createWorker(input: { cwd: string; instructions: string; model?: ModelRef }): Promise<string> {
    const conversation = await this.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: input.model ?? this.defaultModel, cwd: input.cwd, instructions: input.instructions, tools: [this.tools.read, this.tools.write, this.tools.edit, this.tools.bash] },
      },
      ctx,
    );
    return String(conversation.id);
  }

  /** Gives a lead conversation the team extension (delegate tool and team section), or takes it away again. */
  async setTeam(conversationId: string, on: boolean): Promise<void> {
    const conversation = await this.conversation(conversationId);
    await conversation.configure(on ? { extensions: { add: [this.teamExt] } } : { extensions: null }, ctx);
  }

  async createReviewer(input: { cwd: string; instructions: string; model?: ModelRef }): Promise<string> {
    const conversation = await this.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: input.model ?? this.reviewModel, cwd: input.cwd, instructions: input.instructions, tools: [this.tools.read, this.tools.bash] },
      },
      ctx,
    );
    return String(conversation.id);
  }

  private async settle(conversation: AnyConversation, settled: Settled): Promise<AgentSettled> {
    let answer: string | null = null;
    let terminated = false;
    if (settled.answer !== undefined && settled.answer !== null) {
      const entry = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
      for (const m of entry?.model ?? []) {
        if (m.role !== "assistant") continue;
        const text = textOf(m.content);
        if (text) answer = text;
        if (Array.isArray(m.content)) {
          for (const block of m.content as Array<{ type: string; name?: string }>) if (block.type === "toolCall" && block.name && TERMINATING_TOOLS.has(block.name)) terminated = true;
        }
      }
    }
    return {
      status: settled.status,
      reason: settled.reason === undefined ? undefined : typeof settled.reason === "string" ? settled.reason : JSON.stringify(settled.reason),
      answer,
      terminated,
    };
  }

  async ask(conversationId: string, message: AgentMessage, requestId: string, mode: "steer" | "followUp" = "followUp", messageIds: string[] = []): Promise<AgentSettled> {
    const conversation = await this.conversation(conversationId);
    const submission = await conversation.submit(
      { type: "input", content: userContent(message), requestId, whenBusy: mode, entry: { kind: MESSAGE_ENTRY_KIND, data: entryData(message, messageIds) } },
      ctx,
    );
    return this.settle(conversation, await submission.wait(ctx));
  }

  async note(conversationId: string, message: AgentMessage, requestId: string, messageIds: string[]): Promise<void> {
    const conversation = await this.conversation(conversationId);
    await conversation.submit(
      {
        type: "write",
        requestId,
        entry: { kind: MESSAGE_ENTRY_KIND, data: entryData(message, messageIds), model: [{ role: "user", content: userContent(message), timestamp: Date.now() }] },
      },
      ctx,
    );
  }

  async seen(conversationId: string, messageId: string): Promise<boolean | null> {
    const conversation = await this.conversation(conversationId);
    const page = await conversation.entries({}, 300, undefined, ctx);
    let answeredAfter = false;
    for (const entry of page.items) {
      if (entry.kind === "pi.assistant") answeredAfter = true;
      if (entry.kind === MESSAGE_ENTRY_KIND && ((entry.data as { messageIds?: string[] } | undefined)?.messageIds ?? []).includes(messageId)) return answeredAfter;
    }
    return null;
  }

  async plan(conversationId: string, message: AgentMessage, requestId: string): Promise<AgentSettled> {
    const conversation = await this.conversation(conversationId);
    await conversation.configure({ extensions: { add: [this.planExt] }, tools: [this.tools.read, this.tools.bash, this.tools.submitPlan] }, ctx);
    try {
      return await this.ask(conversationId, message, requestId);
    } finally {
      await conversation.configure({ extensions: null, tools: null }, ctx);
    }
  }

  async contextStats(conversationId: string): Promise<{ tokens: number | null; turns: number }> {
    const conversation = await this.conversation(conversationId);
    const page = await conversation.entries({}, 400, undefined, ctx);
    let tokens: number | null = null;
    let turns = 0;
    let compactedAfter = false;
    for (const entry of page.items) {
      if (entry.kind === "pi.compaction" && tokens === null) compactedAfter = true;
      if (USER_KINDS.has(entry.kind)) turns++;
      if (tokens === null && !compactedAfter && entry.kind === "pi.assistant") {
        const usage = (entry.model?.[0] as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } } | undefined)?.usage;
        if (usage) tokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) + (usage.output ?? 0);
      }
    }
    return { tokens, turns };
  }

  async compact(conversationId: string, instructions: string): Promise<void> {
    const conversation = await this.conversation(conversationId);
    await conversation.compact(instructions, ctx);
  }

  async transcript(conversationId: string, limit = 600): Promise<TranscriptItem[]> {
    const conversation = await this.conversation(conversationId);
    const page = await conversation.entries({}, limit, undefined, ctx);
    const items: TranscriptItem[] = [];
    const tools = new Map<string, Extract<TranscriptItem, { kind: "tool" }>>();
    for (const entry of [...page.items].reverse()) {
      const id = String(entry.id);
      const first = entry.model?.[0];
      if (entry.kind === MESSAGE_ENTRY_KIND) {
        const data = (entry.data ?? {}) as { author?: string; text?: string; attachments?: []; messageIds?: string[] };
        items.push({
          kind: "user",
          id,
          at: iso(first?.timestamp),
          author: (data.author as Extract<TranscriptItem, { kind: "user" }>["author"]) ?? "system",
          text: data.text ?? textOf(first?.content),
          attachments: data.attachments ?? [],
          ...(data.messageIds?.length ? { messageIds: data.messageIds } : {}),
        });
        continue;
      }
      if (entry.kind === "pi.user") {
        items.push({ kind: "user", id, at: iso(first?.timestamp), author: "system", text: textOf(first?.content), attachments: [] });
        continue;
      }
      if (entry.kind === "pi.compaction") {
        items.push({ kind: "user", id, at: null, author: "system", text: "Earlier conversation was summarised to save context.", attachments: [] });
        continue;
      }
      for (const m of entry.model ?? []) {
        if (m.role === "assistant" && Array.isArray(m.content)) {
          for (const block of m.content as Array<{ type: string; text?: string; id?: string; name?: string; arguments?: Record<string, unknown> }>) {
            if (block.type === "text" && block.text?.trim()) items.push({ kind: "assistant", id: `${id}:${items.length}`, at: iso(m.timestamp), text: block.text.trim() });
            if (block.type === "toolCall" && block.id && block.name) {
              const args = block.arguments ?? {};
              const item = {
                kind: "tool" as const,
                id: block.id,
                at: iso(m.timestamp),
                name: block.name,
                summary: toolSummary(block.name, args),
                args: JSON.stringify(args, null, 2).slice(0, 8000),
                result: null,
                isError: false,
                running: true,
              };
              tools.set(block.id, item);
              items.push(item);
            }
          }
        }
        if (m.role === "toolResult" && m.toolCallId) {
          const item = tools.get(m.toolCallId);
          if (item) {
            item.result = textOf(m.content).slice(0, 8000) || "(no output)";
            item.isError = Boolean(m.isError);
            item.running = false;
          }
        }
      }
    }
    return items;
  }

  async events(conversationId: string): Promise<AgentEventStream> {
    return watchEvents(this.harness as never, piId(conversationId) as never, ctx);
  }

  async abort(conversationId: string): Promise<void> {
    await (await this.conversation(conversationId)).abort(ctx, { background: true });
  }

  async activity(conversationId: string): Promise<AgentActivity> {
    const live = ((await this.harness.snapshot<LiveState>(LiveDoc, piId(conversationId), ctx)) ?? {}) as LiveState;
    const running = live.tools?.find((t) => t.status === "running") ?? live.tools?.find((t) => t.status === "pending");
    const tail = running?.output?.trim().split("\n").at(-1)?.slice(0, 200) ?? null;
    const partial = live.generation?.message?.content;
    const lastText = partial ? textOf(partial).slice(-200) || null : null;
    const calling = partial?.filter((c) => c.type === "toolCall").map((c) => c.name).at(-1) ?? null;
    return { busy: Boolean(live.run), tool: running?.name ?? calling, detail: tail, lastText };
  }

  async usage(conversationId: string): Promise<ModelUsage> {
    const state = ((await this.harness.snapshot<{ models?: Record<string, PiUsage> }>(UsageDoc, piId(conversationId), ctx)) ?? {}) as {
      models?: Record<string, PiUsage>;
    };
    const out: ModelUsage = {};
    for (const [model, u] of Object.entries(state.models ?? {})) {
      out[model] = {
        inputTokens: u.input ?? 0,
        outputTokens: u.output ?? 0,
        cacheReadTokens: u.cacheRead ?? 0,
        cacheWriteTokens: u.cacheWrite ?? 0,
        costUsd: u.cost?.total ?? 0,
      };
    }
    return out;
  }

  async close(): Promise<void> {
    await this.harness.close(ctx);
  }
}
