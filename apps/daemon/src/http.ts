import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as netConnect } from "node:net";
import { WorkspaceError } from "./workspace/service.ts";
import { githubStatus } from "./github.ts";
import path from "node:path";
import type { ControlAction, RunDetailResponse, ServerEvent, TaskType, UsageResponse } from "@nightshift/core";
import type { Store } from "@nightshift/store";
import type { Orchestrator } from "./orchestrator.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function hostAllowed(req: IncomingMessage) {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "");
  return LOOPBACK.has(host);
}

function previewHostOf(req: IncomingMessage): string | null {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
  return host.endsWith(".localhost") && host !== "localhost" ? host : null;
}

function originAllowed(req: IncomingMessage) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return LOOPBACK.has(new URL(origin).hostname) || new URL(origin).hostname === "[::1]";
  } catch {
    return false;
  }
}

const MAX_UPLOAD = 10 * 1024 * 1024;

const IMAGE_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

async function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw Object.assign(new Error("File is larger than 10 MB"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function startHttp(options: {
  orchestrator: Orchestrator;
  store: Store;
  host: string;
  port: number;
  webDir: string | null;
  uploadsDir: string;
  modelsService: import("./models/service.ts").ModelsService;
}): Promise<Server> {
  const ms = options.modelsService;
  const { orchestrator, store } = options;

  const usage = (): UsageResponse => ({
    billing: options.modelsService.billing(),
    today: store.usageOn(),
    days: store.usageDays(30),
    byRun: store.listRuns(500).map((r) => ({ runId: r.id, projectId: r.projectId, taskId: r.taskId, taskTitle: r.taskTitle, usage: r.usage })),
    byModel: store.usageByModel(),
  });

  const serveStatic = (req: IncomingMessage, res: ServerResponse, pathname: string) => {
    if (!options.webDir || !existsSync(options.webDir)) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("Nightshift daemon is running. The dashboard is not built: run `bun run build` in the nightshift repo.");
      return;
    }
    const root = path.resolve(options.webDir);
    let file = path.resolve(root, `.${decodeURIComponent(pathname)}`);
    if (pathname.startsWith("/assets/") && (!file.startsWith(root) || !existsSync(file))) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("Not found");
      return;
    }
    if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(root, "index.html");
    const hashed = file.includes(`${path.sep}assets${path.sep}`);
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
    });
    createReadStream(file).pipe(res);
  };

  const proxy = (req: IncomingMessage, res: ServerResponse, host: string) => {
    const preview = orchestrator.workspace.previews.byHost(host);
    if (!preview || preview.status === "stopped") {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(`No running preview for ${host}. Start it from the task's Preview tab in Nightshift.`);
      return;
    }
    const upstream = httpRequest(
      { host: "127.0.0.1", port: preview.port, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${preview.port}` } },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", (error) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(`Preview is not answering: ${error.message}`);
    });
    req.pipe(upstream);
  };

  const terminalRoute = async (req: IncomingMessage, res: ServerResponse, projectId: string, taskId: string, rest: string) => {
    const terms = orchestrator.workspace.terminals;
    const m = req.method;
    if (rest === "/terminals" && m === "GET") return send(res, 200, { terminals: terms.list(projectId, taskId) });
    if (rest === "/terminals" && m === "POST") {
      const b = (await readJson(req)) as { cols?: number; rows?: number };
      return send(res, 200, orchestrator.workspace.openTerminal(projectId, taskId, b));
    }
    const one = rest.match(/^\/terminals\/([^/]+)(?:\/(stream|input|resize))?$/);
    if (!one) return send(res, 404, { error: "not_found" });
    const id = decodeURIComponent(one[1]!);
    if (one[2] === "stream" && m === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
      const unsubscribe = terms.subscribe(projectId, taskId, id, (event) => res.write(`data: ${JSON.stringify(event)}\n\n`));
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => {
        clearInterval(ping);
        unsubscribe();
      });
      return;
    }
    if (one[2] === "input" && m === "POST") {
      terms.input(projectId, taskId, id, String(((await readJson(req)) as { data?: unknown }).data ?? ""));
      return send(res, 200, { ok: true });
    }
    if (one[2] === "resize" && m === "POST") {
      const b = (await readJson(req)) as { cols?: number; rows?: number };
      terms.resize(projectId, taskId, id, Number(b.cols), Number(b.rows));
      return send(res, 200, { ok: true });
    }
    if (!one[2] && m === "DELETE") {
      terms.close(projectId, taskId, id);
      orchestrator.emitter.emit("event", { type: "task", projectId, taskId });
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: "not_found" });
  };

  const workspaceRoute = async (req: IncomingMessage, res: ServerResponse, url: URL, projectId: string, taskId: string, rest: string) => {
    const ws = orchestrator.workspace;
    const body = async () => (await readJson(req)) as Record<string, unknown>;
    const paths = async () => ((await body()).paths as string[] | undefined) ?? [];
    const m = req.method;
    if (rest === "" && m === "GET") return send(res, 200, ws.info(projectId, taskId));
    const service = url.searchParams.get("service") || undefined;
    if (rest === "/preview/start" && m === "POST") return send(res, 200, await ws.startPreview(projectId, taskId, false, service));
    if (rest === "/preview/restart" && m === "POST") return send(res, 200, await ws.startPreview(projectId, taskId, true, service));
    if (rest === "/preview/stop" && m === "POST") return send(res, 200, await ws.stopPreview(projectId, taskId, service));
    if (rest === "/local-files/sync" && m === "POST") return send(res, 200, ws.syncLocalFiles(projectId, taskId, Boolean((await body()).overwrite)));
    if (rest === "/preview/diagnose" && m === "POST") return send(res, 200, await ws.diagnosePreview(projectId, taskId, service));
    if (rest === "/preview/fix" && m === "POST") return send(res, 200, await ws.fixPreview(projectId, taskId, ((await body()).fix ?? {}) as never, service));
    if (rest === "/preview/detect" && m === "POST") return send(res, 200, await ws.detectPreview(projectId, taskId));
    if (rest === "/preview/logs" && m === "GET") return send(res, 200, { log: ws.previews.logs(projectId, taskId, service) });
    if (rest === "/preview/env" && m === "PUT") return send(res, 200, await ws.setServiceEnv(projectId, taskId, service, (await body()) as never));
    if (rest === "/preview/env" && m === "GET") return send(res, 200, ws.serviceEnv(projectId, taskId, service, url.searchParams.get("reveal") === "1"));
    if (rest === "/database/create" && m === "POST") return send(res, 200, await ws.createDatabase(projectId, taskId));
    if (rest === "/database/reset" && m === "POST") return send(res, 200, await ws.createDatabase(projectId, taskId, true));
    if (rest === "/database/drop" && m === "POST") return send(res, 200, await ws.dropDatabase(projectId, taskId));
    if (rest === "/files" && m === "GET") {
      const dir = url.searchParams.get("path") ?? "";
      return send(res, 200, { path: dir, entries: await ws.ops(projectId, taskId).list(dir) });
    }
    if (rest === "/file" && m === "GET") return send(res, 200, ws.ops(projectId, taskId).read(url.searchParams.get("path") ?? ""));
    if (rest === "/files/create" && m === "POST") {
      const b = await body();
      const ops = ws.ops(projectId, taskId);
      ws.editable(projectId, taskId);
      return send(res, 200, ops.create(String(b.path ?? ""), b.kind === "folder" ? "folder" : "file"));
    }
    if (rest === "/git/pull-base" && m === "POST") {
      ws.editable(projectId, taskId);
      return send(res, 200, await ws.pullBase(projectId, taskId));
    }
    if (rest === "/file" && m === "PUT") {
      const b = await body();
      const ops = ws.ops(projectId, taskId);
      ws.editable(projectId, taskId);
      ops.write(String(b.path ?? ""), String(b.content ?? ""));
      return send(res, 200, { ok: true });
    }
    if (rest === "/git/status" && m === "GET") return send(res, 200, await ws.ops(projectId, taskId).status());
    if (rest === "/git/diff" && m === "GET")
      return send(res, 200, await ws.ops(projectId, taskId).diff(url.searchParams.get("path") ?? "", url.searchParams.get("staged") === "1"));
    if (rest === "/git/commit" && m === "GET") return send(res, 200, await ws.ops(projectId, taskId).commitDiff(url.searchParams.get("sha") ?? ""));
    if (rest === "/git/log" && m === "GET") {
      const info = ws.info(projectId, taskId);
      return send(res, 200, { commits: await ws.ops(projectId, taskId).log(info.branch ?? "") });
    }
    if (rest.startsWith("/git/") && m === "POST") {
      const ops = ws.ops(projectId, taskId);
      ws.editable(projectId, taskId);
      const action = rest.slice(5);
      if (action === "stage") await ops.stage(await paths());
      else if (action === "unstage") await ops.unstage(await paths());
      else if (action === "discard") await ops.discard(await paths());
      else if (action === "commit") return send(res, 200, { ok: true, sha: await ops.commit(String((await body()).message ?? "")) });
      else if (action === "push") await ws.push(projectId, taskId);
      else return send(res, 404, { error: "not_found" });
      return send(res, 200, { ok: true });
    }
    if (rest === "/actions" && m === "GET") return send(res, 200, await ws.actions(projectId, taskId));
    if (rest === "/suggestions" && m === "GET") return send(res, 200, await orchestrator.workspaceSuggestions(projectId, taskId));
    const logMatch = rest.match(/^\/actions\/([^/]+)\/log$/);
    if (logMatch && m === "GET") {
      const id = decodeURIComponent(logMatch[1]);
      return send(res, 200, { id, log: await ws.actionLog(projectId, taskId, id) });
    }
    return send(res, 404, { error: "not_found" });
  };

  const server = createServer(async (req, res) => {
    try {
      const preview = previewHostOf(req);
      if (preview) return proxy(req, res, preview);
      if (!hostAllowed(req)) return send(res, 403, { error: "forbidden_host" });
      const url = new URL(req.url ?? "/", "http://localhost");
      const p = url.pathname;
      if (!p.startsWith("/api/")) return serveStatic(req, res, p);
      if (req.method !== "GET" && !originAllowed(req)) return send(res, 403, { error: "forbidden_origin" });

      if (p === "/api/status" && req.method === "GET") return send(res, 200, orchestrator.status());
      if (p === "/api/runs" && req.method === "GET") return send(res, 200, { runs: store.listRuns(500) });
      if (p === "/api/usage" && req.method === "GET") return send(res, 200, usage());
      if (p === "/api/kill-switch" && req.method === "POST") {
        const body = await readJson(req);
        return send(res, 200, { killSwitch: await orchestrator.setKillSwitch(Boolean(body.on)) });
      }
      if (p === "/api/events" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        const write = (event: ServerEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
        write({ type: "status", status: orchestrator.status() });
        const listener = (event: ServerEvent) => write(event);
        orchestrator.emitter.on("event", listener);
        const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
        req.on("close", () => {
          clearInterval(heartbeat);
          orchestrator.emitter.off("event", listener);
        });
        return;
      }
      if (p === "/api/fs/list" && req.method === "GET") {
        try {
          const { listFolders } = await import("./fs-browser.ts");
          return send(res, 200, listFolders(url.searchParams.get("path") ?? undefined, url.searchParams.get("hidden") === "1", [{ label: "Nightshift repos", path: orchestrator.onboarding.reposDir() }]));
        } catch (error) {
          return send(res, (error as { status?: number }).status ?? 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (p === "/api/fs/mkdir" && req.method === "POST") {
        try {
          const { makeFolder } = await import("./fs-browser.ts");
          const b = await readJson(req);
          return send(res, 200, { path: makeFolder(String(b.parent ?? ""), String(b.name ?? "")) });
        } catch (error) {
          return send(res, (error as { status?: number }).status ?? 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (p.startsWith("/api/models")) {
        try {
          if (p === "/api/models" && req.method === "GET") return send(res, 200, await ms.overview());
          if (p === "/api/models/settings" && req.method === "PUT") return send(res, 200, { settings: ms.saveSettings((await readJson(req)) as never) });
          if (p === "/api/models/catalog" && req.method === "GET")
            return send(res, 200, ms.catalog(url.searchParams.get("provider") || undefined, url.searchParams.get("q") || undefined, Number(url.searchParams.get("limit") ?? 200)));
          const prov = p.match(/^\/api\/models\/providers\/([^/]+)(\/(api-key|test|login))?$/);
          if (prov) {
            const id = decodeURIComponent(prov[1]);
            if (prov[3] === "api-key" && req.method === "POST") return send(res, 200, await ms.setApiKey(id, String((await readJson(req)).key ?? "")));
            if (prov[3] === "test" && req.method === "POST") return send(res, 200, await ms.test(id, ((await readJson(req)).modelId as string | undefined) || undefined));
            if (prov[3] === "login" && req.method === "POST") return send(res, 200, ms.startLogin(id));
            if (!prov[2] && req.method === "DELETE") return send(res, 200, await ms.disconnect(id));
          }
          const login = p.match(/^\/api\/models\/logins\/([^/]+)(\/(answer|cancel))?$/);
          if (login) {
            const id = decodeURIComponent(login[1]);
            if (!login[2] && req.method === "GET") return send(res, 200, ms.login(id));
            if (login[3] === "answer" && req.method === "POST") {
              const b = await readJson(req);
              return send(res, 200, ms.answer(id, String(b.promptId ?? ""), String(b.value ?? "")));
            }
            if (login[3] === "cancel" && req.method === "POST") return send(res, 200, ms.cancel(id));
          }
          return send(res, 404, { error: "not_found" });
        } catch (error) {
          return send(res, (error as { status?: number }).status ?? 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (p === "/api/github" && req.method === "GET") return send(res, 200, await githubStatus());
      const move = p.match(/^\/api\/projects\/([^/]+)\/move-to-github$/);
      if (move && req.method === "POST") {
        const id = decodeURIComponent(move[1]);
        if (!orchestrator.projects.has(id)) return send(res, 404, { error: "Project not found" });
        try {
          return send(res, 200, await orchestrator.moveToGithub(id, (await readJson(req)) as never));
        } catch (error) {
          return send(res, (error as { status?: number }).status ?? 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (p === "/api/settings/limits") {
        try {
          if (req.method === "GET") return send(res, 200, { limits: orchestrator.budgets, defaults: orchestrator.defaultBudgets() });
          if (req.method === "PUT") {
            const body = (await readJson(req)) as { limits?: Record<string, number> | null };
            return send(res, 200, { limits: orchestrator.saveBudgets(body.limits === null ? null : ((body.limits ?? {}) as never)), defaults: orchestrator.defaultBudgets() });
          }
        } catch (error) {
          return send(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (p.startsWith("/api/skills")) {
        const sk = orchestrator.skills;
        try {
          if (p === "/api/skills" && req.method === "GET") return send(res, 200, { skills: sk.list() });
          if (p === "/api/skills" && req.method === "POST") return send(res, 200, { skill: sk.create((await readJson(req)) as never) });
          if (p === "/api/skills/discover" && req.method === "POST") return send(res, 200, await sk.discover((await readJson(req)) as never));
          if (p === "/api/skills/import" && req.method === "POST") return send(res, 200, { skills: sk.importSkills((await readJson(req)) as never) });
          const one = p.match(/^\/api\/skills\/([^/]+)$/);
          if (one) {
            const id = decodeURIComponent(one[1]);
            if (req.method === "GET") return send(res, 200, { skill: sk.get(id) });
            if (req.method === "PUT") return send(res, 200, { skill: sk.save(id, String((await readJson(req)).content ?? "")) });
            if (req.method === "PATCH") return send(res, 200, { skill: sk.setEnabled(id, Boolean((await readJson(req)).enabled)) });
            if (req.method === "DELETE") {
              sk.remove(id);
              return send(res, 200, { ok: true });
            }
          }
          return send(res, 404, { error: "not_found" });
        } catch (error) {
          const e = error as { status?: number; code?: string };
          return send(res, e.status ?? 400, { error: error instanceof Error ? error.message : String(error), ...(e.code ? { code: e.code } : {}) });
        }
      }
      const localScan = p.match(/^\/api\/projects\/([^/]+)\/local-files\/scan$/);
      if (localScan && req.method === "GET") {
        const id = decodeURIComponent(localScan[1]);
        if (!orchestrator.projects.has(id)) return send(res, 404, { error: "Project not found" });
        try {
          return send(res, 200, await orchestrator.workspace.scanLocalFiles(id, url.searchParams.get("ai") === "1"));
        } catch (error) {
          return send(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      const projectSkills = p.match(/^\/api\/projects\/([^/]+)\/skills$/);
      if (projectSkills && req.method === "GET") {
        const id = decodeURIComponent(projectSkills[1]);
        if (!orchestrator.projects.has(id)) return send(res, 404, { error: "Project not found" });
        return send(res, 200, { skills: orchestrator.skills.projectSkills(orchestrator.projects.get(id)!.project) });
      }
      if (p === "/api/projects" && req.method === "GET") return send(res, 200, { projects: await orchestrator.listProjects() });
      if (p === "/api/starters" && req.method === "GET") {
        const { PROJECT_KINDS, STARTERS } = await import("@nightshift/core");
        return send(res, 200, { kinds: PROJECT_KINDS, starters: STARTERS });
      }
      if ((p === "/api/projects/inspect" || p === "/api/projects/scaffold") && req.method === "POST") {
        try {
          const body = (await readJson(req)) as never;
          if (p.endsWith("inspect")) return send(res, 200, { inspection: await orchestrator.onboarding.inspect(body) });
          return send(res, 200, await orchestrator.scaffoldProject(body));
        } catch (error) {
          return send(res, (error as { status?: number }).status ?? 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      const filesMatch = p.match(/^\/api\/projects\/([^/]+)\/files\/search$/);
      if (filesMatch && req.method === "GET") {
        const id = decodeURIComponent(filesMatch[1]);
        if (!orchestrator.projects.has(id)) return send(res, 404, { error: "Project not found" });
        return send(res, 200, orchestrator.searchFiles(id, url.searchParams.get("q") ?? "", url.searchParams.get("task") || undefined));
      }
      const folderMatch = p.match(/^\/api\/projects\/([^/]+)\/(folder|pulls)$/);
      if (folderMatch && req.method === "GET") {
        const id = decodeURIComponent(folderMatch[1]);
        if (!orchestrator.projects.has(id)) return send(res, 404, { error: "Project not found" });
        try {
          if (folderMatch[2] === "pulls") return send(res, 200, { pulls: await orchestrator.continuablePrs(id) });
          return send(res, 200, await orchestrator.folderStatus(id));
        } catch (error) {
          return send(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      const projectOnly = p.match(/^\/api\/projects\/([^/]+)(\/brief)?$/);
      if (projectOnly && (req.method === "PATCH" || (!projectOnly[2] && req.method === "DELETE") || (projectOnly[2] && req.method === "POST"))) {
        const id = decodeURIComponent(projectOnly[1]);
        if (!orchestrator.projects.has(id)) return send(res, 404, { error: "Project not found" });
        try {
          if (projectOnly[2]) return send(res, 200, { brief: await orchestrator.generateBrief(id) });
          if (req.method === "DELETE") return send(res, 200, await orchestrator.deleteProject(id, { removeWorkspaces: url.searchParams.get("workspaces") === "remove" }));
          return send(res, 200, { project: await orchestrator.updateProject(id, (await readJson(req)) as never) });
        } catch (error) {
          return send(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (p === "/api/projects" && req.method === "POST") {
        try {
          return send(res, 200, { project: await orchestrator.createProject((await readJson(req)) as never) });
        } catch (error) {
          return send(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (p === "/api/uploads" && req.method === "POST") {
        const mimeType = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
        if (!IMAGE_EXT[mimeType]) return send(res, 415, { error: "Only PNG, JPEG, GIF and WebP pictures can be attached" });
        let body: Buffer;
        try {
          body = await readRaw(req, MAX_UPLOAD);
        } catch (error) {
          return send(res, 413, { error: (error as Error).message });
        }
        if (!body.length) return send(res, 400, { error: "Empty file" });
        const id = randomUUID();
        mkdirSync(options.uploadsDir, { recursive: true });
        const file = path.join(options.uploadsDir, `${id}${IMAGE_EXT[mimeType]}`);
        writeFileSync(file, body);
        let name = `picture${IMAGE_EXT[mimeType]}`;
        try {
          name = decodeURIComponent(String(req.headers["x-file-name"] ?? name)).replace(/[\\/]/g, "_").slice(0, 200) || name;
        } catch {}
        const a = store.addAttachment({ id, name, mimeType, size: body.length, path: file });
        return send(res, 200, { attachment: { id: a.id, name: a.name, mimeType: a.mimeType, size: a.size, url: `/api/uploads/${a.id}` } });
      }
      const uploadMatch = p.match(/^\/api\/uploads\/([^/]+)$/);
      if (uploadMatch && req.method === "GET") {
        const a = store.attachment(decodeURIComponent(uploadMatch[1]));
        if (!a || !existsSync(a.path)) return send(res, 404, { error: "not_found" });
        res.writeHead(200, { "content-type": a.mimeType, "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff" });
        createReadStream(a.path).pipe(res);
        return;
      }
      const streamMatch = p.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)\/stream$/);
      if (streamMatch && req.method === "GET") {
        const run = store.latestRunForTask(decodeURIComponent(streamMatch[1]), decodeURIComponent(streamMatch[2]));
        if (!run?.conversationId) return send(res, 404, { error: "The agent has not started on this task yet" });
        const runner = orchestrator.runner as unknown as {
          events(id: string): Promise<{ snapshot: unknown; start(cb: (events: unknown[]) => Promise<void> | void): void; stop(): Promise<void> }>;
        };
        const stream = await runner.events(run.conversationId);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(`event: snapshot\ndata: ${JSON.stringify({ runId: run.id, snapshot: stream.snapshot })}\n\n`);
        stream.start((events) => {
          res.write(`event: events\ndata: ${JSON.stringify(events)}\n\n`);
        });
        const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
        req.on("close", () => {
          clearInterval(heartbeat);
          void stream.stop();
        });
        return;
      }
      const wsMatch = p.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)\/workspace(\/.*)?$/);
      if (wsMatch) {
        const projectId = decodeURIComponent(wsMatch[1]);
        const taskId = decodeURIComponent(wsMatch[2]);
        if (!orchestrator.projects.has(projectId)) return send(res, 404, { error: "Project not found" });
        const rest = wsMatch[3] ?? "";
        if (rest.startsWith("/terminals")) {
          try {
            return await terminalRoute(req, res, projectId, taskId, rest);
          } catch (error) {
            return send(res, (error as { status?: number }).status ?? 400, { error: error instanceof Error ? error.message : String(error) });
          }
        }
        try {
          const result = await workspaceRoute(req, res, url, projectId, taskId, rest);
          if (req.method !== "GET") orchestrator.emitter.emit("event", { type: "task", projectId, taskId });
          return result;
        } catch (error) {
          const status = error instanceof WorkspaceError ? error.status : ((error as { status?: number }).status ?? 400);
          const extra = error as { code?: string; conflicts?: string[]; baseBranch?: string };
          return send(res, status, {
            error: error instanceof Error ? error.message : String(error),
            ...(extra.code ? { code: extra.code } : {}),
            ...(extra.conflicts ? { conflicts: extra.conflicts } : {}),
            ...(extra.baseBranch ? { baseBranch: extra.baseBranch } : {}),
          });
        }
      }
      const branchMatch = p.match(/^\/api\/projects\/([^/]+)\/branches$/);
      if (branchMatch && req.method === "GET") {
        const id = decodeURIComponent(branchMatch[1]);
        if (!orchestrator.projects.has(id)) return send(res, 404, { error: "Project not found" });
        return send(res, 200, await orchestrator.branches(id, url.searchParams.get("q") || undefined));
      }
      const verifyMatch = p.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)\/(decisions|issues|testers)\/([^/]+)(\/run|\/stop)?$/);
      if (verifyMatch && req.method === "POST") {
        const [projectId, taskId, kind, id] = [verifyMatch[1], verifyMatch[2], verifyMatch[3], verifyMatch[4]].map(decodeURIComponent);
        if (!orchestrator.projects.has(projectId)) return send(res, 404, { error: "Project not found" });
        try {
          const body = await readJson(req);
          if (kind === "decisions") return send(res, 200, await orchestrator.answerDecision(projectId, taskId, id, String(body.answer ?? "")));
          if (kind === "issues") return send(res, 200, { issue: orchestrator.setIssueStatus(projectId, taskId, id, body.status === "open" ? "open" : "dismissed") });
          if (kind === "testers" && verifyMatch[5] === "/stop") return send(res, 200, orchestrator.stopTester(projectId, taskId, id));
          if (kind === "testers" && verifyMatch[5]) return send(res, 200, await orchestrator.runTesterNow(projectId, taskId, id));
        } catch (error) {
          return send(res, (error as { status?: number }).status ?? 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      const trigMatch = p.match(/^\/api\/projects\/([^/]+)\/triggers$/);
      if (trigMatch) {
        const id = decodeURIComponent(trigMatch[1]);
        if (!orchestrator.projects.has(id)) return send(res, 404, { error: "Project not found" });
        if (req.method === "GET") return send(res, 200, orchestrator.triggerView(id));
        if (req.method === "PATCH") {
          try {
            return send(res, 200, await orchestrator.setTriggers(id, ((await readJson(req)).triggers ?? {}) as never));
          } catch (error) {
            return send(res, 400, { error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
      const projectMatch = p.match(/^\/api\/projects\/([^/]+)(?:\/tasks(?:\/([^/]+)(?:\/(messages|sessions|verification|type|archive|team))?)?)?$/);
      if (projectMatch) {
        const projectId = decodeURIComponent(projectMatch[1]);
        const taskId = projectMatch[2] ? decodeURIComponent(projectMatch[2]) : null;
        const sub = projectMatch[3];
        const isTasks = p.includes("/tasks");
        try {
          if (!orchestrator.projects.has(projectId)) return send(res, 404, { error: "Project not found" });
          if (!isTasks && req.method === "GET") return send(res, 200, { project: await orchestrator.projectSummary(orchestrator.projects.get(projectId)!) });
          if (isTasks && !taskId && req.method === "GET") return send(res, 200, await orchestrator.projectTasks(projectId));
          if (isTasks && !taskId && req.method === "POST") return send(res, 200, { task: await orchestrator.createTask(projectId, (await readJson(req)) as never) });
          if (taskId && !sub && req.method === "GET") return send(res, 200, await orchestrator.taskView(projectId, taskId, url.searchParams.get("session") || undefined));
          if (taskId && sub === "team" && req.method === "PUT") {
            const workers = ((await readJson(req)) as { workers?: number | null }).workers;
            return send(res, 200, orchestrator.setTaskTeam(projectId, taskId, workers === null || workers === undefined ? null : Number(workers)));
          }
          if (taskId && sub === "type" && req.method === "PUT") return send(res, 200, orchestrator.setTaskType(projectId, taskId, ((await readJson(req)) as { type?: TaskType | null }).type ?? null));
          if (taskId && sub === "archive" && req.method === "PUT") return send(res, 200, await orchestrator.setArchived(projectId, taskId, Boolean(((await readJson(req)) as { archived?: unknown }).archived)));
          if (taskId && sub === "verification" && req.method === "GET") return send(res, 200, orchestrator.verificationView(projectId, taskId));
          if (taskId && sub === "sessions" && req.method === "GET") {
            const run = store.latestRunForTask(projectId, taskId);
            return send(res, 200, { sessions: await orchestrator.sessionsFor(projectId, taskId), canStartNew: orchestrator.canStartSession(run) });
          }
          if (taskId && sub === "sessions" && req.method === "POST") return send(res, 200, await orchestrator.newSession(projectId, taskId, (await readJson(req)) as never));
          if (taskId && sub === "messages" && req.method === "POST") {
            const body = (await readJson(req)) as { text?: string; attachmentIds?: string[] };
            return send(res, 200, await orchestrator.sendMessage(projectId, taskId, body.text ?? "", body.attachmentIds ?? []));
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return send(res, /not.?found/i.test(message) ? 404 : 400, { error: message });
        }
      }
      const runMatch = p.match(/^\/api\/runs\/([^/]+)(?:\/(pause|resume|stop|retry|complete))?$/);
      if (runMatch) {
        const id = decodeURIComponent(runMatch[1]);
        const action = runMatch[2] as ControlAction | undefined;
        if (!action && req.method === "GET") {
          const run = store.getRun(id);
          if (!run) return send(res, 404, { error: "not_found" });
          const body: RunDetailResponse = { run, events: store.listEvents(id), modelUsage: store.runModelUsage(id), prWatch: orchestrator.prWatch(id) };
          return send(res, 200, body);
        }
        if (action && req.method === "POST") {
          try {
            const reason = action === "complete" ? (await readJson(req)).reason : undefined;
            const run = await orchestrator.control(id, action, typeof reason === "string" ? reason : undefined);
            return send(res, 200, { ok: true, run });
          } catch (error) {
            return send(res, 409, { error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
      send(res, 404, { error: "not_found" });
    } catch (error) {
      if (!res.headersSent) send(res, 500, { error: String(error) });
    }
  });

  server.on("upgrade", (req, socket, head) => {
    const host = previewHostOf(req);
    const preview = host ? orchestrator.workspace.previews.byHost(host) : undefined;
    if (!preview) {
      socket.destroy();
      return;
    }
    const upstream = netConnect(preview.port, "127.0.0.1", () => {
      const headers = Object.entries({ ...req.headers, host: `127.0.0.1:${preview.port}` })
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
        .join("\r\n");
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });

  return new Promise((resolve) => server.listen(options.port, options.host, () => resolve(server)));
}
