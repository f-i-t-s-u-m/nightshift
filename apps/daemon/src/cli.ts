#!/usr/bin/env node
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  API_ROUTES,
  defaultConfig,
  type RunDetailResponse,
  type RunsResponse,
  type StatusResponse,
  type UsageResponse,
  type UsageTotals,
} from "@nightshift/core";
import { run as exec } from "@nightshift/git";
import { defaultConfigPath, loadConfig, loadEnvFile, writeConfig } from "./config.ts";
import { installService, uninstallService } from "./launchd.ts";
import { startDaemon } from "./service.ts";

const argv = process.argv.slice(2);
const command = argv[0] ?? "help";
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(`--${name}`);
const configFile = flag("config") ?? defaultConfigPath();

const HELP = `nightshift - a local, always-on AI engineering team

Usage:
  nightshift init [--slots <n>] [--model <provider/model>] [--repo <path> --source-url <url>]   (optional; serve creates a default config)
  nightshift serve                 run in the foreground
  nightshift start                 install and start the macOS background service (launchd)
  nightshift stop                  stop and remove the background service
  nightshift status                what each agent is doing
  nightshift runs                  list runs
  nightshift logs <run-id> [-f]    events of one run
  nightshift pause|resume|stop-run|retry <run-id>
  nightshift usage                 tokens and cost
  nightshift kill-switch on|off    stop all agents / allow them again
  nightshift dashboard             open the dashboard

Options:
  --config <file>   config file (default ~/.nightshift/config.json or $NIGHTSHIFT_CONFIG)

Secrets (ANTHROPIC_API_KEY, OPENAI_API_KEY, WONDERCALL_AGENT_TOKEN) go in <dataDir>/.env.`;

function baseUrl() {
  const config = loadConfig(configFile);
  return `http://${config.http.host}:${config.http.port}`;
}

async function api<T>(route: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${route}`, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  } catch {
    throw new Error(`Nightshift is not running at ${baseUrl()}. Start it with \`nightshift start\` or \`nightshift serve\`.`);
  }
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

const money = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
const tokens = (u: UsageTotals) => u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;

async function main() {
  switch (command) {
    case "init": {
      const repo = flag("repo");
      const base = defaultConfig(homedir());
      const model = flag("model");
      const config: Record<string, unknown> = {
        slots: Number(flag("slots") ?? 2),
        ...(model ? { model: { provider: model.split("/")[0], modelId: model.split("/").slice(1).join("/") } } : {}),
        ...(repo
          ? {
              repo: { path: path.resolve(repo), remote: "origin", baseBranch: flag("base") ?? "main", branchPrefix: "nightshift/" },
              source: { type: "wondercall-mcp", url: flag("source-url") ?? base.source.url, tokenEnv: base.source.tokenEnv },
              git: { host: has("local") ? "local" : "github", authorName: "", authorEmail: "" },
            }
          : {}),
      };
      if (existsSync(configFile) && !has("force")) throw new Error(`${configFile} exists; pass --force to overwrite`);
      writeConfig(configFile, config as never);
      console.log(`Wrote ${configFile}`);
      console.log(`Start it with \`nightshift serve\`, open http://${base.http.host}:${base.http.port}, connect a model on the Models page and add a project.`);
      return;
    }
    case "serve": {
      if (!existsSync(configFile)) {
        writeConfig(configFile, { slots: 2 } as never);
        console.log(`Created ${configFile} with defaults`);
      }
      const config = loadConfig(configFile);
      loadEnvFile(config);
      const daemon = await startDaemon(config);
      const shutdown = async () => {
        setTimeout(() => process.exit(0), 5000).unref();
        await daemon.stop().catch(() => {});
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      return;
    }
    case "start": {
      const config = loadConfig(configFile);
      const file = await installService({ cli: fileURLToPath(import.meta.url), configFile: path.resolve(configFile), logDir: config.dataDir });
      console.log(`Installed ${file}; Nightshift starts now and at every login. Dashboard: http://${config.http.host}:${config.http.port}`);
      return;
    }
    case "stop": {
      await uninstallService();
      console.log("Background service stopped and removed.");
      return;
    }
    case "status": {
      const s = await api<StatusResponse>(API_ROUTES.status);
      console.log(`Nightshift ${s.version} · ${s.model} · source ${s.source.name} ${s.source.connected ? "connected" : `DISCONNECTED${s.source.lastError ? ` (${s.source.lastError})` : ""}`}`);
      if (s.killSwitch) console.log("KILL SWITCH ON: no agent is working.");
      console.log(`Today: ${money(s.usageToday.costUsd)} of ${money(s.budgets.perDayUsd)}, ${tokens(s.usageToday)} tokens`);
      for (const slot of s.slots) console.log(`  slot ${slot.slot}: ${slot.taskId ? `${slot.taskId} ${slot.taskTitle} [${slot.phase}] ${slot.activity ?? ""}` : "idle"}`);
      console.log(`  ${Object.entries(s.counts).map(([k, v]) => `${k}=${v}`).join("  ")}`);
      return;
    }
    case "runs": {
      const { runs } = await api<RunsResponse>(API_ROUTES.runs);
      for (const r of runs) console.log(`${r.id}  ${r.phase.padEnd(16)} ${r.taskId}  ${r.taskTitle}  ${r.prUrl ?? ""}  ${money(r.usage.costUsd)}`);
      return;
    }
    case "logs": {
      const id = argv[1];
      if (!id) throw new Error("logs <run-id>");
      let last = 0;
      for (;;) {
        const detail = await api<RunDetailResponse>(API_ROUTES.run(id));
        for (const e of detail.events.filter((e) => e.id > last)) console.log(`${e.at}  ${e.type.padEnd(8)} ${e.message}`);
        last = detail.events.at(-1)?.id ?? last;
        if (!has("f") && !argv.includes("-f")) return;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    case "pause":
    case "resume":
    case "retry":
    case "stop-run": {
      const id = argv[1];
      if (!id) throw new Error(`${command} <run-id>`);
      const action = command === "stop-run" ? "stop" : command;
      await api(API_ROUTES.control(id, action), { method: "POST" });
      console.log(`${action}: ok`);
      return;
    }
    case "usage": {
      const u = await api<UsageResponse>(API_ROUTES.usage);
      console.log(`Today: ${money(u.today.costUsd)}, ${tokens(u.today)} tokens`);
      for (const [model, usage] of Object.entries(u.byModel)) console.log(`  ${model}: ${money(usage.costUsd)}, ${tokens(usage)} tokens`);
      for (const d of u.days.slice(0, 14)) console.log(`  ${d.day} ${d.model}: ${money(d.usage.costUsd)}`);
      return;
    }
    case "kill-switch": {
      const on = argv[1] === "on";
      if (!["on", "off"].includes(argv[1] ?? "")) throw new Error("kill-switch on|off");
      const res = await api<{ killSwitch: boolean }>(API_ROUTES.killSwitch, { method: "POST", body: JSON.stringify({ on }) });
      console.log(`Kill switch ${res.killSwitch ? "ON" : "off"}`);
      return;
    }
    case "dashboard": {
      await exec("open", [baseUrl()]);
      console.log(baseUrl());
      return;
    }
    default:
      console.log(HELP);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
