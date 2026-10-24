import type { CheckConfig, TaskComment, TaskDetail } from "@nightshift/core";
import type { PrCheck, PrComment, PrReview } from "@nightshift/git";

export function operatorNotes(texts: string[]) {
  if (!texts.length) return "";
  return ["", "## Messages from the operator", ...texts.map((t) => `- ${t || "(see attached pictures)"}`)].join("\n");
}

export function instructions(checksConfig: CheckConfig[], cwd: string, branch: string, brief?: string) {
  const checks = checksConfig.length
    ? `The repository checks are: ${checksConfig.map((c) => `${c.name} (\`${c.command}\`)`).join(", ")}. Run them with the run_checks tool before you finish.`
    : "No checks are configured; run the relevant tests yourself with bash before you finish.";
  return [
    "You are Nightshift, an autonomous software engineer. You work alone on one task from the team's task board; a human reviews your pull request.",
    `Your workspace is a git worktree at ${cwd} on branch ${branch}. Work only inside it.`,
    "Read the repository's AGENTS.md, CLAUDE.md and README first if they exist, and follow their conventions.",
    "Do not push, open pull requests or switch branches: Nightshift commits, pushes and opens the pull request for you when you finish.",
    checks,
    "If the task is unclear or needs a product decision, call ask_question instead of guessing, then stop.",
    "The operator may send you messages and screenshots while you work. Treat them as instructions from the task owner and adjust your work.",
    "Keep changes focused on the task. Do not touch unrelated files.",
    "When you are done, reply with a short summary of what you changed and why, written for the pull request description. Mention anything you could not verify.",
    ...(brief ? ["", "## Project brief (from the project owner)", brief] : []),
  ].join("\n");
}

export function taskPrompt(task: TaskDetail, comments: TaskComment[]) {
  const parts = [`# Task ${task.id}: ${task.title}`, "", task.body || "(no description)"];
  if (task.acceptanceCriteria?.length) parts.push("", "## Acceptance criteria", ...task.acceptanceCriteria.map((c) => `- ${c}`));
  if (task.attachments?.length) parts.push("", "## Attachments", ...task.attachments.map((a) => `- ${a.name}${a.url ? ` (${a.url})` : ""}`));
  const human = comments.filter((c) => !c.authorIsAgent);
  if (human.length) parts.push("", "## Comments", ...human.map((c) => `- ${c.author}: ${c.body}`));
  parts.push("", "Complete this task in your workspace, run the checks, then reply with your summary.");
  return parts.join("\n");
}

export function answerPrompt(comments: TaskComment[]) {
  return [
    "The task owner answered your question:",
    "",
    ...comments.map((c) => `${c.author}: ${c.body}`),
    "",
    "Continue the task with this answer, run the checks, then reply with your updated summary.",
  ].join("\n");
}

export function feedbackPrompt(input: { failing: Array<{ check: PrCheck; log: string | null }>; reviews: PrReview[]; comments: PrComment[] }) {
  const parts = [
    "New feedback arrived on your pull request. Address all of it in your workspace, run the checks, then reply with a short summary of the changes.",
    "If a failing check is not caused by this branch (it also fails without your change, or the failing code is not in your diff), or a review finding is already fixed in the current code or does not apply, verify that, then call report_not_caused_here with the evidence instead of changing code. Fix everything that is yours.",
    "To ask a review bot to re-check a finding you fixed, use propose_pr_comment (the owner approves it before it is posted).",
  ];
  if (input.failing.length) {
    parts.push("", "## CI failed");
    for (const f of input.failing) {
      parts.push(`### ${f.check.name}${f.check.detailsUrl ? ` (${f.check.detailsUrl})` : ""}`);
      if (f.log) parts.push("```", f.log, "```");
    }
  }
  if (input.reviews.length) {
    parts.push("", "## Reviews");
    for (const r of input.reviews) parts.push(`- ${r.author} (${r.state}): ${r.body || "(no text)"}`);
  }
  if (input.comments.length) {
    parts.push("", "## Review comments");
    for (const c of input.comments) parts.push(`- [${c.id}] ${c.author}${c.path ? ` on ${c.path}${c.line ? `:${c.line}` : ""}` : ""}: ${c.body}`);
  }
  return parts.join("\n");
}

export function localChecksPrompt(output: string, round: number) {
  return [
    `The repository checks fail on your change (verification round ${round}). Fix the failures, run the checks again, then reply with your updated summary.`,
    "",
    "```",
    output,
    "```",
  ].join("\n");
}

export function prBody(task: TaskDetail, summary: string | null, diffStat: string, preExistingFailures: string[] = []) {
  return [
    summary ?? "Automated change by Nightshift.",
    "",
    `Task: ${task.url ?? task.id}`,
    ...(preExistingFailures.length ? ["", `Checks already failing on the base branch before this change: ${preExistingFailures.join(", ")}.`] : []),
    "",
    "<details><summary>Changed files</summary>",
    "",
    "```",
    diffStat || "(none)",
    "```",
    "</details>",
    "",
    "Opened by Nightshift. A human must review and merge.",
  ].join("\n");
}

/** The team lead's section: what delegating does and when to use it. */
export function teamLeadGuide(maxWorkers: number) {
  return [
    `You lead a team: you can hand independent parts of this task to up to ${maxWorkers} worker agents with the delegate tool.`,
    "They work in parallel, each in its own copy of your workspace that starts from your current state (Nightshift commits your changes so far first). They cannot ask questions, comment on the task or see each other's work.",
    "Delegate when the task splits cleanly into parts that touch different files (for example the API and the UI, separate modules, or the tests). Do small or tightly coupled work yourself: overlapping pieces cause merge conflicts.",
    "Give every piece a self-contained brief: the goal, where to change things, constraints, and how to check it. List the files each piece will mostly touch.",
    "When the workers finish, Nightshift merges their branches into your workspace and resumes you with their summaries. Then check the combined change, fix what does not fit, merge any branch left to you, run the checks and reply with your summary. You may delegate again if needed.",
  ].join("\n");
}

export function teamWorkerInstructions(cwd: string, branch: string, brief?: string) {
  return [
    "You are a worker agent in a team of AI software engineers. A lead agent gave you one piece of a task; a human reviews the final pull request.",
    `Your workspace is a git worktree at ${cwd} on branch ${branch}. Work only inside it.`,
    "Other workers change other parts of the same code at the same time in their own copies, so stay strictly within your piece: do not reformat, rename or move code outside it.",
    "Do not commit, push or switch branches; Nightshift commits your work and merges it for the lead.",
    "You cannot ask questions. If something blocks you, do what you can and say exactly what is missing.",
    "Run the tests and checks that cover your piece with bash before you finish.",
    ...(brief ? ["", "## Project brief", brief] : []),
  ].join("\n");
}

export function teamWorkerPrompt(task: TaskDetail, piece: { index: number; title: string; brief: string; files: string[] }, setupNote: string) {
  return [
    `# Your piece (worker ${piece.index}): ${piece.title}`,
    "",
    piece.brief,
    ...(piece.files.length ? ["", "Files you will mostly touch:", ...piece.files.map((f) => `- ${f}`)] : []),
    "",
    `## The whole task, for context only: ${task.id}: ${task.title}`,
    "",
    (task.body || "(no description)").slice(0, 6000),
    ...(setupNote ? ["", setupNote] : []),
    "",
    "Do only your piece. End with a short summary: what you changed (files), how you checked it, and anything the lead must know.",
  ].join("\n");
}

export function teamResultsPrompt(
  handout: number,
  workers: Array<{ index: number; title: string; status: string; branch: string; summary: string | null; error: string | null; merge: string | null; conflicts: string[] }>,
) {
  const lines = [`Results from your team (hand-out ${handout}):`, ""];
  for (const w of workers) {
    const outcome =
      w.status !== "done"
        ? `did not finish (${w.status}${w.error ? `: ${w.error}` : ""})`
        : w.merge === "merged"
          ? "merged into your workspace"
          : w.merge === "conflict"
            ? `NOT merged: conflicts in ${w.conflicts.join(", ")}. Merge it yourself with \`git merge ${w.branch}\`, resolve the conflicts and commit.`
            : "made no changes";
    lines.push(`## Worker ${w.index}: ${w.title}`, `Outcome: ${outcome}`, ...(w.summary ? ["Summary:", w.summary.slice(0, 3000)] : []), "");
  }
  lines.push("Check the combined change now: fix what does not fit together, finish anything a worker could not do, run the checks, then reply with your summary (or delegate again).");
  return lines.join("\n");
}
