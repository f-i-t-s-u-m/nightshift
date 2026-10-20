import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { inspectRepository } from "../onboarding/inspect.ts";
import type { Ask } from "./preview-ai.ts";

export type SetupDiagnosis = { summary: string; cause: string; command: string | null; source: "ai" | "rules" };

export function tailLines(text: string, maxChars = 4000) {
  const clean = text.replace(/\r/g, "").trimEnd();
  if (clean.length <= maxChars) return clean;
  const cut = clean.slice(-maxChars);
  const nl = cut.indexOf("\n");
  return nl >= 0 ? cut.slice(nl + 1) : cut;
}

export function lastError(text: string) {
  const lines = text.replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /error|failed|not found|cannot|could not|ENOENT|EACCES/i.test(l)) ?? lines.at(-1) ?? "The setup command failed";
}

async function rulesSetup(root: string, command: string, output: string): Promise<SetupDiagnosis | null> {
  if (/Could not find Prisma Schema|prisma\/schema\.prisma: file not found/i.test(output)) {
    const suggested = (await inspectRepository(root)).suggested.setup ?? null;
    const fixed = suggested && suggested !== command ? suggested : null;
    return {
      summary: "Prisma generate ran in a folder that has no Prisma schema.",
      cause: "This repository keeps its Prisma schemas inside the apps, so `prisma generate` has to run in each app's folder, not at the repository root.",
      command: fixed,
      source: "rules",
    };
  }
  const missing = output.match(/(?:command not found|not found):?\s*([\w.-]+)|sh: ([\w.-]+): command not found/);
  if (missing) return { summary: `A command the setup needs is not installed: ${missing[1] ?? missing[2]}.`, cause: "Install it on this Mac, or change the setup command.", command: null, source: "rules" };
  return null;
}

export async function diagnoseSetup(ask: Ask | null, root: string, command: string, output: string): Promise<SetupDiagnosis> {
  const rules = await rulesSetup(root, command, output).catch(() => null);
  if (!ask) return rules ?? { summary: lastError(output), cause: "See the setup log.", command: null, source: "rules" };
  const read = (f: string) => {
    try {
      return readFileSync(path.join(root, f), "utf8").slice(0, 3000);
    } catch {
      return "";
    }
  };
  let inspection = "";
  try {
    const i = await inspectRepository(root);
    inspection = `Package manager ${i.packageManager}; monorepo ${i.monorepo?.tool ?? "no"} (${(i.monorepo?.packages ?? []).join(", ")}); frameworks ${i.frameworks.join(", ")}; rule-based setup suggestion: ${i.suggested.setup ?? "none"}`;
  } catch {}
  const system = [
    "You fix the setup command Nightshift runs in a fresh git worktree of a repository before an AI agent starts working on a task (install dependencies, generate clients). It runs with sh -c from the repository root.",
    'Answer only with JSON: {"summary": "one sentence for the owner", "cause": "what went wrong, citing the log", "command": "the corrected full setup command, or null if the setup command is not the problem"}.',
    "Keep the command minimal and safe: install and code generation only, no database migrations against shared databases, no deleting files. Run tools inside the folders that need them with (cd dir && ...).",
  ].join("\n");
  const prompt = [
    `Setup command: ${command}`,
    inspection,
    rules ? `Rule-based finding: ${rules.summary} ${rules.cause}${rules.command ? ` Suggested: ${rules.command}` : ""}` : "",
    "",
    "Output (end):",
    "```",
    tailLines(output, 6000),
    "```",
    "",
    "--- package.json ---",
    read("package.json"),
    existsSync(path.join(root, "turbo.json")) ? `--- turbo.json ---\n${read("turbo.json")}` : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
  try {
    const text = await ask(system, prompt);
    const raw = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    const data = JSON.parse(raw) as { summary?: string; cause?: string; command?: string | null };
    const fixed = typeof data.command === "string" && data.command.trim() && data.command.trim() !== command ? data.command.trim().slice(0, 2000) : null;
    return { summary: String(data.summary ?? "").slice(0, 400) || lastError(output), cause: String(data.cause ?? "").slice(0, 1500), command: fixed ?? rules?.command ?? null, source: "ai" };
  } catch {
    return rules ?? { summary: lastError(output), cause: "See the setup log.", command: null, source: "rules" };
  }
}
