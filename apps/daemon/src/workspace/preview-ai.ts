import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PreviewConfig, PreviewDetectResponse, PreviewDiagnosis, PreviewFix, PreviewService } from "@nightshift/core";
import { inspectRepository } from "../onboarding/inspect.ts";
import { normalizePreview } from "../projects.ts";

export type Ask = (system: string, prompt: string) => Promise<string>;

const read = (file: string, max = 6000) => {
  try {
    return readFileSync(file, "utf8").slice(0, max);
  } catch {
    return "";
  }
};

const jsonBlock = (text: string): unknown => {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1];
  const raw = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(raw);
};

const cleanFix = (input: unknown): PreviewFix | null => {
  if (!input || typeof input !== "object") return null;
  const f = input as Record<string, unknown>;
  const out: PreviewFix = {};
  if (typeof f.command === "string" && f.command.trim()) out.command = f.command.trim();
  if (typeof f.install === "string" && f.install.trim()) out.install = f.install.trim();
  if (typeof f.cwd === "string" && f.cwd.trim() && !f.cwd.includes("..")) out.cwd = f.cwd.trim().replace(/^\.\/|\/$/g, "");
  if (typeof f.portEnv === "string" && /^[A-Z_][A-Z0-9_]*$/.test(f.portEnv)) out.portEnv = f.portEnv;
  if (typeof f.readyPath === "string" && f.readyPath.startsWith("/")) out.readyPath = f.readyPath;
  if (f.target === "container" || f.target === "machine") out.target = f.target;
  if (Number.isInteger(Number(f.containerPort)) && Number(f.containerPort) > 0 && Number(f.containerPort) < 65536) {
    out.containerPort = Number(f.containerPort);
    out.target = "container";
  }
  if (f.env && typeof f.env === "object") {
    const env = Object.fromEntries(Object.entries(f.env as Record<string, unknown>).filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === "string")) as Record<string, string>;
    if (Object.keys(env).length) out.env = env;
  }
  return Object.keys(out).length ? out : null;
};

function appContext(root: string, cwd: string | null) {
  const dir = path.join(root, cwd ?? "");
  const pkg = read(path.join(dir, "package.json"), 4000);
  const rootPkg = cwd ? read(path.join(root, "package.json"), 2500) : "";
  const env = [".env.example", ".env.sample", ".env.local.example"].map((f) => read(path.join(dir, f), 1500)).filter(Boolean).join("\n");
  const configs = ["next.config.js", "next.config.mjs", "next.config.ts", "vite.config.ts", "vite.config.js", "wrangler.toml", "src/index.ts", "src/server.ts", "index.ts"]
    .filter((f) => existsSync(path.join(dir, f)))
    .slice(0, 2)
    .map((f) => `--- ${f} ---\n${read(path.join(dir, f), 1500)}`);
  return [pkg && `--- ${cwd ? `${cwd}/` : ""}package.json ---\n${pkg}`, rootPkg && `--- package.json (root) ---\n${rootPkg}`, env && `--- .env.example ---\n${env}`, ...configs].filter(Boolean).join("\n\n");
}

export function rulesDiagnosis(service: string, hint: string | null, startedAt: string | null, def: PreviewService, error: string | null): PreviewDiagnosis | null {
  if (!hint && !error) return null;
  const portEnv = def.portEnv ?? "PORT";
  let fix: PreviewFix | null = null;
  const listens = hint?.match(/listens on port (\d+)/);
  if (listens && !new RegExp(`\\$${portEnv}`).test(def.command)) {
    if (/\bnext\b|next dev/.test(def.command)) fix = { command: `${def.command} -p $${portEnv} -H 127.0.0.1` };
    else if (/\bvite\b|astro|svelte-kit/.test(def.command)) fix = { command: `${def.command} --port $${portEnv} --host 127.0.0.1 --strictPort` };
    else if (def.target !== "container") fix = { target: "container", containerPort: Number(listens[1]) };
  }
  return {
    service,
    at: new Date().toISOString(),
    startedAt,
    summary: fix?.target === "container" ? `${hint} Running it in its own container keeps port ${fix.containerPort} inside and gives each task a different port outside.` : (hint ?? `The dev server stopped: ${error}`),
    cause: hint ? "Found in the dev server's output." : "The process exited. Check the log for the first error.",
    fix,
    agentPrompt: null,
    source: "rules",
  };
}

export async function diagnose(
  ask: Ask,
  input: { root: string; service: string; def: PreviewService; config: PreviewConfig; log: string; hint: string | null; error: string | null; port: number | null; startedAt: string | null },
): Promise<PreviewDiagnosis> {
  const system = [
    "You diagnose why a local dev server did not start for Nightshift, a tool that runs each app of a repository on its own port.",
    `Nightshift starts the command with the environment variable ${input.def.portEnv ?? "PORT"} set to the port it will proxy, and waits until GET ${input.def.readyPath ?? "/"} answers. HOST is 127.0.0.1.`,
    "Answer only with JSON: {\"summary\": \"one sentence for the owner\", \"cause\": \"what is wrong, citing the log\", \"fix\": null or {\"command\"?: string, \"env\"?: {\"NAME\": \"value\"}, \"install\"?: string, \"cwd\"?: string, \"readyPath\"?: string, \"containerPort\"?: number}, \"agentPrompt\": null or \"instructions for the coding agent if the code itself must change\"}.",
    "If the app hard-codes its port and no command flag can change it, propose {\"containerPort\": <that port>}: Nightshift then runs the app in its own container with that port inside and a unique port outside, so several tasks can run it at once.",
    "Prefer a settings fix (command flags so the app uses the port variable, a missing install step, an env value, the right folder). Use {{name.url}} placeholders for another service's address. Only propose agentPrompt when the code must change (a crash, a missing file, a bug).",
  ].join("\n");
  const prompt = [
    `Service: ${input.service} (folder ${input.def.cwd ?? "."}), port ${input.port ?? "unknown"}`,
    `Command: ${input.def.command}`,
    input.def.env && Object.keys(input.def.env).length ? `Env: ${JSON.stringify(input.def.env)}` : "",
    input.config.install ? `Install step: ${input.config.install}` : "No install step runs before the services.",
    input.error ? `Nightshift says: ${input.error}` : "",
    input.hint ? `Rule-based hint: ${input.hint}` : "",
    "",
    "Last lines of the dev server output:",
    "```",
    input.log || "(no output)",
    "```",
    "",
    appContext(input.root, input.def.cwd ?? null),
  ]
    .filter((l) => l !== "")
    .join("\n");
  const text = await ask(system, prompt);
  const data = jsonBlock(text) as { summary?: string; cause?: string; fix?: unknown; agentPrompt?: unknown };
  return {
    service: input.service,
    at: new Date().toISOString(),
    startedAt: input.startedAt,
    summary: String(data.summary ?? "").slice(0, 400) || "The dev server did not start.",
    cause: String(data.cause ?? "").slice(0, 1500),
    fix: cleanFix(data.fix),
    agentPrompt: typeof data.agentPrompt === "string" && data.agentPrompt.trim() ? data.agentPrompt.trim().slice(0, 2000) : null,
    source: "ai",
  };
}

export async function detect(ask: Ask | null, root: string, current: PreviewConfig | undefined): Promise<PreviewDetectResponse> {
  const inspection = await inspectRepository(root);
  const rules = inspection.suggested.preview ?? null;
  const notes = inspection.notes.filter((n) => /preview|monorepo|port/i.test(n));
  if (!ask) return { suggestion: rules, notes: ["No model is connected, so this is the rule-based suggestion.", ...notes], source: "rules" };
  const apps = (inspection.monorepo?.packages ?? []).slice(0, 12);
  const readme = ["README.md", "readme.md", "CONTRIBUTING.md"].map((f) => read(path.join(root, f), 4000)).find(Boolean) ?? "";
  const turbo = read(path.join(root, "turbo.json"), 2000);
  const system = [
    "You set up local previews for Nightshift. Each app of a repository runs as its own service with its own port and link.",
    "Nightshift runs every service command from the service folder with a port variable (default PORT) set, HOST=127.0.0.1, and waits for GET readyPath to answer (any status below 500).",
    "Services can reference each other in env values with {{name.url}} (direct address, for server code) and {{name.publicUrl}} (browser link).",
    'Answer only with JSON: {"preview": {"install"?: string, "services": [{"name": "web", "cwd": "apps/web", "command": "...", "portEnv": "PORT", "readyPath": "/", "env"?: {...}, "primary"?: true}]}, "notes": ["short notes for the owner"]}. For a single app return one service with cwd "".',
    "Commands must make the app listen on the port variable (e.g. next dev -p $PORT -H 127.0.0.1, vite --port $PORT --host 127.0.0.1 --strictPort). Skip libraries and packages that are not runnable apps. Keep the rule-based suggestion where it is already right.",
  ].join("\n");
  const prompt = [
    `Package manager: ${inspection.packageManager ?? "unknown"}; frameworks: ${inspection.frameworks.join(", ") || "unknown"}; monorepo: ${inspection.monorepo?.tool ?? "no"}`,
    `Current preview settings: ${JSON.stringify(current ?? null)}`,
    `Rule-based suggestion: ${JSON.stringify(rules)}`,
    turbo && `--- turbo.json ---\n${turbo}`,
    appContext(root, null),
    ...apps.map((a) => appContext(root, a)),
    readme && `--- README (start) ---\n${readme}`,
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 60_000);
  try {
    const data = jsonBlock(await ask(system, prompt)) as { preview?: PreviewConfig & { services?: PreviewService[] }; notes?: unknown };
    const proposed = data.preview;
    if (!proposed?.services?.length) throw new Error("no services");
    const primary = proposed.services.find((s) => s.primary) ?? proposed.services[0]!;
    const suggestion = normalizePreview({
      ...(proposed.services.length > 1 ? { services: proposed.services } : {}),
      ...(proposed.install ? { install: proposed.install } : {}),
      command: proposed.services.length > 1 ? primary.command : primary.cwd ? `cd ${primary.cwd} && ${primary.command}` : primary.command,
      portEnv: primary.portEnv,
      readyPath: primary.readyPath,
      ...(proposed.services.length === 1 && primary.env ? { env: primary.env } : {}),
      target: current?.target ?? "machine",
      ...(current?.container ? { container: current.container } : {}),
      ...(current?.device ? { device: current.device } : {}),
    });
    const aiNotes = Array.isArray(data.notes) ? data.notes.filter((n): n is string => typeof n === "string").slice(0, 6) : [];
    return { suggestion: suggestion ?? rules, notes: aiNotes, source: "ai" };
  } catch (error) {
    return { suggestion: rules, notes: [`The AI suggestion could not be used (${error instanceof Error ? error.message : String(error)}), so this is the rule-based one.`, ...notes], source: "rules" };
  }
}

export function applyFix(preview: PreviewConfig, service: string | undefined, fix: PreviewFix): PreviewConfig {
  const next: PreviewConfig = structuredClone(preview);
  if (fix.install) next.install = fix.install;
  if (next.services?.length) {
    const target = next.services.find((s) => s.name === service) ?? next.services.find((s) => s.primary) ?? next.services[0]!;
    if (fix.command) target.command = fix.command;
    if (fix.cwd !== undefined) target.cwd = fix.cwd;
    if (fix.portEnv) target.portEnv = fix.portEnv;
    if (fix.readyPath) target.readyPath = fix.readyPath;
    if (fix.env) target.env = { ...target.env, ...fix.env };
    if (fix.target) target.target = fix.target;
    if (fix.containerPort) target.containerPort = fix.containerPort;
    if (target.primary || next.services.length === 1) next.command = target.command;
  } else {
    if (fix.command) next.command = fix.cwd ? `cd ${fix.cwd} && ${fix.command}` : fix.command;
    if (fix.portEnv) next.portEnv = fix.portEnv;
    if (fix.readyPath) next.readyPath = fix.readyPath;
    if (fix.env) next.env = { ...next.env, ...fix.env };
    if (fix.target) next.target = fix.target;
    if (fix.containerPort) next.containerPort = fix.containerPort;
  }
  return next;
}
