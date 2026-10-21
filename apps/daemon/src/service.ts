import { appendFileSync, mkdirSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NightshiftConfig } from "@nightshift/core";
import { PiRunner } from "@nightshift/runner-pi";
import { Store } from "@nightshift/store";
import { createModelSetup } from "./models.ts";
import { ModelsService } from "./models/service.ts";
import { startHttp } from "./http.ts";
import { Orchestrator } from "./orchestrator.ts";
import { ProcessGuard } from "./process-guard.ts";

export type Daemon = {
  orchestrator: Orchestrator;
  store: Store;
  server: Server;
  url: string;
  stop(): Promise<void>;
};

const defaultWebDir = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");

export async function startDaemon(config: NightshiftConfig, options: { webDir?: string | null; quiet?: boolean } = {}): Promise<Daemon> {
  mkdirSync(config.dataDir, { recursive: true });
  const logFile = path.join(config.dataDir, "nightshift.log");
  const log = (line: string) => {
    appendFileSync(logFile, `${line}\n`);
    if (!options.quiet) console.log(line);
  };

  const store = new Store(path.join(config.dataDir, "nightshift.sqlite"));
  const { models, model, credentials, credentialsKind, providers } = await createModelSetup(config);
  const modelsService = new ModelsService({ models, credentials, store, providers, fallback: model });
  const modelLabel = `${model.provider}/${model.modelId}`;

  const summarize = async (system: string, prompt: string) => {
    const choice = modelsService.settings().default;
    const m = models.getModel(choice.provider, choice.modelId);
    if (!m) throw new Error(`Model ${choice.provider}/${choice.modelId} is not available`);
    const answer = await models.complete(m, { systemPrompt: system, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] });
    if ((answer as { stopReason?: string }).stopReason === "error") throw new Error((answer as { errorMessage?: string }).errorMessage ?? "Model error");
    return (answer.content ?? [])
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("")
      .trim();
  };
  const orchestrator = new Orchestrator({
    config,
    store,
    modelLabel,
    log,
    summarize,
    modelSettings: () => modelsService.settings(),
    modelExists: (c) => Boolean(models.getModel(c.provider, c.modelId)),
    billing: () => modelsService.billing(),
    contextWindowOf: (label) => {
      const [provider, ...rest] = label.split("/");
      return models.getModel(provider, rest.join("/"))?.contextWindow ?? null;
    },
  });
  const runner = await PiRunner.open({
    dataDir: config.dataDir,
    models,
    model,
    bridge: orchestrator.bridge,
    envFor: (cwd) => orchestrator.envForCwd(cwd),
    onReport: (report) => log(`pi: ${typeof report === "string" ? report : JSON.stringify(report).slice(0, 500)}`),
    onFatal: (error) => {
      log(`Pi storage failed: ${String(error)}; exiting so the service manager restarts Nightshift`);
      process.exit(1);
    },
  });
  if (runner.reaped.length) log(`Killed ${runner.reaped.length} leftover process(es) from a previous run: ${runner.reaped.join(", ")}`);
  orchestrator.attachRunner(runner);

  const server = await startHttp({
    orchestrator,
    store,
    host: config.http.host,
    port: config.http.port,
    webDir: options.webDir === undefined ? defaultWebDir() : options.webDir,
    uploadsDir: path.join(config.dataDir, "uploads"),
    modelsService,
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.http.port;
  const url = `http://${config.http.host}:${port}`;
  orchestrator.setPort(port ?? 0);
  const guard = new ProcessGuard((r) => {
    const where = r.cwd ? ` in ${r.cwd}` : "";
    log(`Stopped a runaway command${where}: ${r.command.slice(0, 200)} (${r.processes} processes, ${(r.memoryBytes / 2 ** 30).toFixed(1)} GB): ${r.reason}`);
    const run = r.cwd
      ? store
          .listRuns(5000)
          .filter((x) => x.worktree && (r.cwd === x.worktree || r.cwd!.startsWith(`${x.worktree}/`)))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
      : undefined;
    if (run) {
      const rel = r.cwd === run.worktree ? "" : ` (in ${path.relative(run.worktree!, r.cwd!)})`;
      orchestrator.event(run.id, "error", `Nightshift stopped a runaway command${rel}: \`${r.command.slice(0, 200)}\`. Reason: ${r.reason}. ${r.processes} processes were killed. Fix the script in the repository; running it again will be stopped again.`);
    }
  });
  guard.start();
  const reapedPreviews = orchestrator.workspace.previews.reapLeftovers();
  if (reapedPreviews.length) log(`Stopped ${reapedPreviews.length} leftover preview server(s)`);
  await modelsService.refreshBilling();
  await orchestrator.start();
  log(`Credentials are stored in the ${credentialsKind === "keychain" ? "macOS Keychain" : "data folder (owner-only file)"}`);
  log(`Nightshift ${modelLabel} on ${url} (slots ${config.slots}, projects: ${[...orchestrator.projects.keys()].join(", ") || "none yet"})`);

  return {
    orchestrator,
    store,
    server,
    url,
    stop: async () => {
      guard.stop();
      await orchestrator.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await runner.close();
      store.close();
    },
  };
}
