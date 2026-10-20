import { isTaskType, type TaskType } from "@nightshift/core";

export type SkillMeta = { name: string; description: string; body: string; taskTypes: TaskType[] };

const unquote = (v: string) => {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    const inner = t.slice(1, -1);
    return t.startsWith('"') ? inner.replace(/\\"/g, '"').replace(/\\n/g, "\n") : inner.replace(/''/g, "'");
  }
  return t;
};

export function parseFrontmatter(text: string): { data: Record<string, string>; body: string } | null {
  const match = text.replace(/^﻿/, "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const lines = match[1]!.split(/\r?\n/);
  const data: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    const value = m[2]!;
    if (/^[|>][-+]?\s*$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1]!.trim() === "")) block.push(lines[++i]!.trim());
      data[key] = (value.startsWith(">") ? block.join(" ") : block.join("\n")).trim();
    } else if (value.trim() === "" && i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1]!)) {
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1]!)) items.push(unquote(lines[++i]!.replace(/^\s+-\s+/, "")));
      data[key] = items.join(", ");
    } else if (value.trim() === "") {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!) && !/^\s+-\s/.test(lines[i + 1]!)) block.push(lines[++i]!.trim());
      data[key] = block.join(" ").trim();
    } else data[key] = unquote(value);
  }
  return { data, body: match[2]! };
}

export function parseSkill(text: string): SkillMeta {
  const fm = parseFrontmatter(text);
  if (!fm) throw new Error("SKILL.md must start with a --- frontmatter block that has a name and a description");
  const name = fm.data.name?.trim();
  const description = fm.data.description?.trim();
  if (!name) throw new Error("SKILL.md frontmatter has no name");
  if (!description) throw new Error("SKILL.md frontmatter has no description");
  if (name.length > 64) throw new Error("The skill name is longer than 64 characters");
  if (description.length > 1024) throw new Error("The skill description is longer than 1024 characters");
  const taskTypes = (fm.data["task-types"] ?? fm.data.taskTypes ?? "")
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((t) => unquote(t).trim().toLowerCase())
    .filter(isTaskType);
  return { name, description, body: fm.body, taskTypes: [...new Set(taskTypes)] };
}

const yamlString = (v: string) => (/^[\w .,()/-]+$/.test(v) && !/^\s|\s$/.test(v) ? v : JSON.stringify(v));

export function renderSkill(input: { name: string; description: string; body: string }) {
  return `---\nname: ${yamlString(input.name.trim())}\ndescription: ${yamlString(input.description.trim().replace(/\s*\n\s*/g, " "))}\n---\n\n${input.body.trim()}\n`;
}

export const skillId = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
