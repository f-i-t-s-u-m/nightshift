import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { CheckConfig, TaskComment, TaskDetail } from "@nightshift/core";

export type RunContext = { runId: string; projectId: string; taskId: string; cwd: string };

export interface RunBridge {
  contextFor(conversationId: string): RunContext | undefined;
  getTask(run: RunContext): Promise<TaskDetail>;
  listComments(run: RunContext): Promise<TaskComment[]>;
  postComment(run: RunContext, body: string, idempotencyKey: string): Promise<void>;
  askQuestion(run: RunContext, question: string, idempotencyKey: string, options?: string[]): Promise<void>;
  checks(run: RunContext): CheckConfig[];
  proposePrComment(run: RunContext, input: { body: string; replyTo?: string; reason: string }): Promise<string>;
  reportNotCausedHere(run: RunContext, input: { ci?: Array<{ check: string; reason: string }>; feedback?: Array<{ id: string; reason: string }> }, idempotencyKey: string): Promise<string>;
  submitPlan(run: RunContext, plan: string, idempotencyKey: string): Promise<void>;
  preview(run: RunContext, action: "start" | "restart" | "stop" | "status", probe?: string, service?: string): Promise<string>;
  database(run: RunContext, action: "info" | "reset"): Promise<string>;
  skills(run: RunContext): string | undefined;
  taskGuide(run: RunContext): string | undefined;
  localFilesNote(run: RunContext): string | undefined;
  protectedFiles(run: RunContext): string[];
}

export function submitPlanTool(bridge: RunBridge) {
  return defineTool({
    name: "submit_plan",
    description: "Submit your implementation plan (files to change, approach, how you will verify it, open questions). Planning ends when you call this.",
    parameters: Type.Object({ plan: Type.String() }),
    replay: "safe",
    execute: async (args, api) => {
      const a = api as unknown as Api;
      const run = bridge.contextFor(String(a.conversationId));
      if (!run) throw new Error("This conversation is not attached to a Nightshift run.");
      await bridge.submitPlan(run, args.plan, `plan:${a.conversationId}:${a.callId}`);
      return { ...text("Plan submitted."), control: { terminate: true as const } };
    },
  });
}

const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });

type Api = {
  conversationId: string;
  callId: string;
  executeTool(name: string, args: Record<string, unknown>, context: unknown, options?: { progress?: boolean }): Promise<{ structuredOutput?: unknown; isError?: boolean }>;
};

export function createTaskToolsExtension(bridge: RunBridge) {
  const ctxOf = (api: Api) => {
    const run = bridge.contextFor(String(api.conversationId));
    if (!run) throw new Error("This conversation is not attached to a Nightshift run.");
    return run;
  };

  const getTask = defineTool({
    name: "get_task",
    description: "Read the task you are working on: title, description, acceptance criteria and attachments.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api) => {
      const task = await bridge.getTask(ctxOf(api as unknown as Api));
      return text(JSON.stringify(task, null, 2));
    },
  });

  const listComments = defineTool({
    name: "list_comments",
    description: "Read the comments on the task, oldest first. Human answers to your questions appear here.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api) => {
      const comments = await bridge.listComments(ctxOf(api as unknown as Api));
      return text(comments.length ? comments.map((c) => `[${c.createdAt}] ${c.author}${c.authorIsAgent ? " (agent)" : ""}: ${c.body}`).join("\n\n") : "No comments.");
    },
  });

  const postComment = defineTool({
    name: "post_comment",
    description: "Post a short progress note on the task for the humans following it. Use sparingly.",
    parameters: Type.Object({ body: Type.String() }),
    replay: "safe",
    execute: async (args, api) => {
      const a = api as unknown as Api;
      await bridge.postComment(ctxOf(a), args.body, `comment:${a.conversationId}:${a.callId}`);
      return text("Comment posted.");
    },
  });

  const askQuestion = defineTool({
    name: "ask_question",
    description:
      "Ask the task owner a question when the task is unclear or a product decision is needed. The task moves to Needs info and your work pauses until someone answers; the answer arrives as a new message. Do not guess instead of asking.",
    parameters: Type.Object({ question: Type.String(), options: Type.Optional(Type.Array(Type.String())) }),
    replay: "safe",
    execute: async (args, api) => {
      const a = api as unknown as Api;
      await bridge.askQuestion(ctxOf(a), args.question, `question:${a.conversationId}:${a.callId}`, args.options);
      return { ...text("Question posted. Stop now; you will be resumed with the answer."), control: { terminate: true as const } };
    },
  });

  const runChecks = defineTool({
    name: "run_checks",
    description: "Run the repository's configured checks (tests, typecheck, lint) in your workspace and get pass/fail with output tails.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api, context) => {
      const a = api as unknown as Api;
      const checks = bridge.checks(ctxOf(a));
      if (checks.length === 0) return text("No checks are configured for this repository. Run the relevant tests yourself with bash.");
      const lines: string[] = [];
      let failed = 0;
      for (const check of checks) {
        const result = await a.executeTool("bash", { command: check.command, timeout: Math.round((check.timeoutMs ?? 600_000) / 1000) }, context, { progress: false });
        const out = result.structuredOutput as { output?: string; exitCode?: number } | undefined;
        if (out === undefined && result.isError) {
          lines.push(`## ${check.name}: INTERRUPTED (the check did not finish; run run_checks again)`);
          failed++;
          continue;
        }
        const ok = out?.exitCode === 0;
        if (!ok) failed++;
        lines.push(`## ${check.name}: ${ok ? "PASS" : "FAIL"} (exit ${out?.exitCode ?? "unknown"})`);
        if (!ok && out?.output) lines.push(out.output.split("\n").slice(-60).join("\n"));
      }
      lines.unshift(failed === 0 ? `All ${checks.length} checks passed.` : `${failed} of ${checks.length} checks failed.`);
      return text(lines.join("\n"));
    },
  });

  const reportNotCausedHere = defineTool({
    name: "report_not_caused_here",
    description:
      "Report PR feedback that is not yours to fix in this branch, instead of changing code for it: a failing CI check this branch did not cause (it fails without your change, or the failing code is not in your diff, e.g. it comes from the base branch or another pull request), or a review finding that is already fixed in the current code or does not apply (review bots repeat stale findings). Verify each one first: compare with the base branch, read the current code. Give the evidence in the reason. Nightshift then stops holding the task on it and tells the reviewer why. Never use it for something you could fix.",
    parameters: Type.Object({
      ci: Type.Optional(Type.Array(Type.Object({ check: Type.String({ description: "The failing check's name, as in the feedback message" }), reason: Type.String() }))),
      feedback: Type.Optional(Type.Array(Type.Object({ id: Type.String({ description: "The review comment id in brackets from the feedback message" }), reason: Type.String() }))),
    }),
    replay: "safe",
    execute: async (args, api) => {
      const a = api as unknown as Api;
      return text(await bridge.reportNotCausedHere(ctxOf(a), args, `not-caused-here:${a.conversationId}:${a.callId}`));
    },
  });

  const proposePrComment = defineTool({
    name: "propose_pr_comment",
    description:
      "Propose a comment on the pull request, e.g. asking a review bot to re-check a finding you fixed (\"@greptile-apps retest\" as a reply in its thread). Nothing is posted until the task owner approves it, and it does not wait for that: carry on. One proposal per thread per commit, and a few per task, so use it only when a comment is really needed; explanations for the reviewer belong in your summary or report_not_caused_here.",
    parameters: Type.Object({
      body: Type.String({ description: "The exact comment text" }),
      replyTo: Type.Optional(Type.String({ description: "The review comment id in brackets from the feedback message, to reply in its thread" })),
      reason: Type.String({ description: "Why this comment is needed, shown to the owner" }),
    }),
    replay: "safe",
    execute: async (args, api) => text(await bridge.proposePrComment(ctxOf(api as unknown as Api), args)),
  });

  const preview = defineTool({
    name: "preview",
    description:
      "Manage this task's preview (the project's dev server running from your workspace, reachable at PREVIEW_URL). action: start | restart | stop | status. Pass path (e.g. \"/\" or \"/api/health\") to fetch that page from the running preview and see the response. In a monorepo the preview has several services (e.g. web, api), each with its own URL; pass service to act on or probe one of them, or leave it out to act on all and probe the primary one.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("start"), Type.Literal("restart"), Type.Literal("stop"), Type.Literal("status")]),
      path: Type.Optional(Type.String()),
      service: Type.Optional(Type.String()),
    }),
    execute: async (args, api) => text(await bridge.preview(ctxOf(api as unknown as Api), args.action, args.path, args.service)),
  });

  const database = defineTool({
    name: "database",
    description:
      "This task's own database (created and seeded for your workspace; its URL is in your shell environment). action: info | reset. reset drops it, recreates it and runs the project's migrate+seed command again.",
    parameters: Type.Object({ action: Type.Union([Type.Literal("info"), Type.Literal("reset")]) }),
    execute: async (args, api) => text(await bridge.database(ctxOf(api as unknown as Api), args.action)),
  });

  const skills = section("skills", (input) => {
    const run = bridge.contextFor(String(input.conversationId));
    return run ? bridge.skills(run) : undefined;
  });

  const taskType = section("task-type", (input) => {
    const run = bridge.contextFor(String(input.conversationId));
    return run ? bridge.taskGuide(run) : undefined;
  });

  const localFiles = section("local-files", (input) => {
    const run = bridge.contextFor(String(input.conversationId));
    return run ? bridge.localFilesNote(run) : undefined;
  });

  return defineExtension({ name: "nightshift-task", tools: [getTask, listComments, postComment, askQuestion, runChecks, reportNotCausedHere, proposePrComment, preview, database], sections: [taskType, skills, localFiles] });
}
