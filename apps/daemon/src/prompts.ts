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
