import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { defaultImage, inferInstall } from "./local-files.ts";
import { EnvFileOverlays } from "./env-files.ts";
import type { DeviceMode, EnvEntry, EnvSource, PreviewConfig, PreviewDiagnosis, PreviewInfo, PreviewService, PreviewServiceInfo, PreviewTarget } from "@nightshift/core";

type Svc = {
  name: string;
  primary: boolean;
  host: string;
  port: number;
  inner: number;
  command: string;
  cwd: string | null;
  lanUrl: string | null;
  deviceUrl: string | null;
  containerName: string | null;
  child: ChildProcess | null;
  status: PreviewInfo["status"];
  startedAt: string | null;
  error: string | null;
  log: string[];
  /** The env the current process was started with (values unmasked). */
  env: EnvEntry[] | null;
};

type Group = {
  key: string;
  projectId: string;
  taskId: string;
  target: PreviewTarget;
  deviceMode: DeviceMode | null;
  services: Map<string, Svc>;
  installing: boolean;
  installed: boolean;
  installChild: ChildProcess | null;
  installLog: string[];
};

const MAX_LOG_LINES = 400;

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const previewHost = (projectId: string, taskId: string) => slug(`${taskId}-${projectId}`).slice(0, 60);

const serviceHost = (base: string, name: string) => slug(`${name}-${base}`).slice(0, 63);

const envName = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");

export function lanAddress(): string | null {
  const nets = networkInterfaces();
  const order = ["en0", "en1", "eth0", "wlan0", ...Object.keys(nets)];
  for (const name of order) {
    for (const n of nets[name] ?? []) if (n.family === "IPv4" && !n.internal) return n.address;
  }
  return null;
}

const toAllInterfaces = (command: string) => command.replace(/127\.0\.0\.1/g, "0.0.0.0");

const forContainer = (value: string) => value.replace(/\b(127\.0\.0\.1|localhost)\b/g, "host.docker.internal");

function expoCommand(command: string, mode: DeviceMode): string {
  if (!/expo start/.test(command)) return toAllInterfaces(command);
  const base = command.replace(/\s--web\b/, "");
  const flag = mode === "ios-simulator" ? "--ios" : mode === "android-emulator" ? "--android" : "--lan";
  return /--(lan|ios|android)\b/.test(base) ? base : base.replace(/expo start/, `expo start ${flag}`);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

export function previewHint(log: string[], port: number, status: PreviewInfo["status"], startedAt: string | null, portEnv = "PORT"): string | null {
  if (status === "stopped" || status === "running") return null;
  const text = log.slice(-200).join("\n");
  if (/EADDRINUSE|address already in use/i.test(text)) return "Another program already uses the port this app tries to open. Stop it, or make the app use $" + portEnv + ".";
  if (/command not found|not found: |ENOENT.*spawn|Cannot find module|ERR_MODULE_NOT_FOUND|Could not resolve/i.test(text)) return "Something the command needs is missing (a tool or dependency). Install dependencies first, e.g. set an install command, or check the command name.";
  if (/Missing script|script not found|error: Script not found/i.test(text)) return "The script in the command does not exist in this app's package.json.";
  const ports = [...text.matchAll(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|https?:\/\/[\w.-]+):(\d{2,5})\b|(?:listening|running|started|ready)[^\n]{0,40}?\bport\s*:?\s*(\d{2,5})/gi)]
    .map((m) => Number(m[1] ?? m[2]))
    .filter((n) => n && n !== port && n !== 9229);
  if (ports.length) return `The app listens on port ${ports.at(-1)} instead of $${portEnv} (${port}), so Nightshift cannot reach it. Make the dev command use $${portEnv}, for example "-p $${portEnv}" or "--port $${portEnv}".`;
  const age = startedAt ? Date.now() - Date.parse(startedAt) : 0;
  if (status === "starting" && age > 45_000) return `Still not answering on port ${port} after ${Math.round(age / 1000)} s. The app may listen on another port or be waiting for something (a database, an env variable).`;
  return null;
}

export function servicesOf(config: PreviewConfig): Array<PreviewService & { primary: boolean }> {
  const list: PreviewService[] = config.services?.length
    ? config.services
    : [{ name: "app", command: config.command, portEnv: config.portEnv, readyPath: config.readyPath, env: config.env, envFiles: config.envFiles, primary: true }];
  const primaryName = list.find((s) => s.primary && !s.shared)?.name ?? list.find((s) => !s.shared)?.name ?? list[0]?.name;
  return list.map((s) => ({ ...s, primary: s.name === primaryName && !s.shared }));
}

export const SHARED = "__shared__";

/** Shared services one app refers to through `{{name.*}}` or `NIGHTSHIFT_<NAME>_*` in its command or env (the project-wide env counts too). */
export function sharedUsedBy(config: PreviewConfig, service: PreviewService, shared: PreviewService[]): string[] {
  const text = [service.command, ...Object.values(config.env ?? {}), ...Object.values(service.env ?? {})].join("\n");
  return shared
    .filter((d) => new RegExp(`\\{\\{\\s*${d.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.`).test(text) || text.includes(`NIGHTSHIFT_${envName(d.name)}_`))
    .map((d) => d.name);
}

export function tcpProbe(port: number, host = "127.0.0.1", timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => done(false));
  });
}

/** Every app's file overrides, by path from the workspace root, with templates filled. */
export function overlayFiles(defs: PreviewService[], fill: (value: string) => string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const d of defs) {
    for (const [file, values] of Object.entries(d.envFiles ?? {})) {
      const rel = path.posix.join(d.cwd ?? "", file);
      out[rel] = { ...out[rel], ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, fill(v)])) };
    }
  }
  return out;
}

const SECRET_KEY = /SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_?KEY|_KEY$|^KEY$|SALT|SIGNING/i;

export const isSecretKey = (key: string) => SECRET_KEY.test(key);

/** The env layers a service gets, in the order they override each other (later wins). */
function envEntries(
  d: PreviewService,
  config: PreviewConfig,
  env: Record<string, string>,
  crossEnv: Record<string, string>,
  fill: (value: string) => string,
  own: Record<string, string>,
): EnvEntry[] {
  const out = new Map<string, EnvEntry>();
  const put = (source: EnvSource, values: Record<string, string> | undefined, filled = false) => {
    for (const [key, value] of Object.entries(values ?? {})) {
      out.delete(key);
      out.set(key, { key, value: filled ? fill(value) : value, source, secret: isSecretKey(key) });
    }
  };
  put("task", env);
  put("apps", crossEnv);
  put("preview", config.env, true);
  put("service", d.env, true);
  put("port", own);
  return [...out.values()];
}

export class PreviewManager {
  private readonly groups = new Map<string, Group>();
  private readonly pidFile: string;
  readonly diagnoses = new Map<string, { diagnosis: PreviewDiagnosis | null; diagnosing: boolean }>();
  readonly overlays: EnvFileOverlays;
  onFailed: ((projectId: string, taskId: string, service: string) => void) | null = null;
  sharedRoot: ((projectId: string) => string) | null = null;
  stablePort: ((projectId: string, service: string) => Promise<number>) | null = null;

  constructor(
    dataDir: string,
    private readonly daemonPort: () => number,
    private readonly onChange: (projectId: string, taskId: string) => void,
  ) {
    mkdirSync(dataDir, { recursive: true });
    this.pidFile = path.join(dataDir, "previews.json");
    this.overlays = new EnvFileOverlays(path.join(dataDir, "env-originals"));
  }

  reapLeftovers(): number[] {
    try {
      const ids = execFileSync("docker", ["ps", "-aq", "--filter", "label=nightshift.preview=1"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
        .split("\n")
        .filter(Boolean);
      if (ids.length) execFileSync("docker", ["rm", "-f", ...ids], { stdio: "ignore" });
    } catch {}
    if (!existsSync(this.pidFile)) return [];
    const pids = JSON.parse(readFileSync(this.pidFile, "utf8")) as number[];
    const killed: number[] = [];
    for (const pid of pids) {
      try {
        process.kill(-pid, "SIGKILL");
        killed.push(pid);
      } catch {}
    }
    writeFileSync(this.pidFile, "[]");
    return killed;
  }

  private savePids() {
    const pids: number[] = [];
    for (const g of this.groups.values()) {
      if (g.installChild?.pid) pids.push(g.installChild.pid);
      for (const s of g.services.values()) if (s.child?.pid) pids.push(s.child.pid);
    }
    writeFileSync(this.pidFile, JSON.stringify(pids));
  }

  private key(projectId: string, taskId: string) {
    return `${projectId}/${taskId}`;
  }

  url(host: string) {
    return `http://${host}.localhost:${this.daemonPort()}/`;
  }

  byHost(host: string): { port: number; status: PreviewInfo["status"] } | undefined {
    const name = host.replace(/:\d+$/, "").replace(/\.localhost$/, "");
    for (const g of this.groups.values()) {
      for (const s of g.services.values()) {
        if (s.status === "stopped") continue;
        if (s.host === name || (s.primary && name === previewHost(g.projectId, g.taskId))) return s;
      }
    }
    return undefined;
  }

  usedBy(projectId: string) {
    return [...this.groups.values()]
      .filter((x) => x.projectId === projectId && x.taskId !== SHARED && [...x.services.values()].some((s) => s.status !== "stopped"))
      .map((x) => x.taskId)
      .sort();
  }

  info(projectId: string, taskId: string, config: PreviewConfig | undefined): PreviewInfo {
    const g = this.groups.get(this.key(projectId, taskId));
    const sg = this.groups.get(this.key(projectId, SHARED));
    const defs = config?.command || config?.services?.length ? servicesOf(config) : [];
    const base = previewHost(projectId, taskId);
    const usedBy = defs.some((d) => d.shared) ? this.usedBy(projectId) : [];
    const services: PreviewServiceInfo[] = defs.map((d) => {
      const shared = Boolean(d.shared);
      const s = shared ? sg?.services.get(d.name) : g?.services.get(d.name);
      const live = s && s.status !== "stopped";
      const diagKey = `${this.key(projectId, shared ? SHARED : taskId)}/${d.name}`;
      return {
        shared,
        external: shared && !d.command.trim(),
        check: d.check ?? "http",
        usedBy: shared ? usedBy : [],
        name: d.name,
        primary: d.primary,
        status: s?.status ?? "stopped",
        url: live && (d.check ?? "http") === "http" && d.command.trim() ? this.url(d.primary ? base : s.host) : null,
        port: live ? s.port : shared && d.port ? d.port : null,
        lanUrl: live ? s.lanUrl : null,
        deviceUrl: live ? s.deviceUrl : null,
        command: d.command,
        cwd: d.cwd ?? null,
        error: s?.error ?? null,
        startedAt: s?.startedAt ?? null,
        hint: s ? previewHint(s.log, s.inner || s.port, s.status, s.startedAt, d.portEnv ?? "PORT") : null,
        diagnosis: this.diagnoses.get(diagKey)?.diagnosis ?? null,
        diagnosing: this.diagnoses.get(diagKey)?.diagnosing ?? false,
      };
    });
    const primary = services.find((s) => s.primary) ?? services.find((s) => !s.shared) ?? services[0];
    return {
      services,
      installing: Boolean(g?.installing),
      install: config?.install?.trim() || null,
      target: g?.target ?? config?.target ?? "machine",
      deviceMode: g?.deviceMode ?? (config?.target === "device" ? (config.device?.mode ?? "lan") : null),
      lanUrl: primary?.lanUrl ?? null,
      deviceUrl: primary?.deviceUrl ?? null,
      configured: defs.length > 0,
      status: g?.installing ? "starting" : (primary?.status ?? "stopped"),
      url: primary?.url ?? null,
      port: primary?.port ?? null,
      command: primary?.command ?? config?.command ?? null,
      startedAt: primary?.startedAt ?? null,
      error: primary?.error ?? null,
    };
  }

  private svcOf(projectId: string, taskId: string, service: string) {
    return this.groups.get(this.key(projectId, taskId))?.services.get(service) ?? this.groups.get(this.key(projectId, SHARED))?.services.get(service);
  }

  serviceLog(projectId: string, taskId: string, service: string, lines = 150) {
    return this.svcOf(projectId, taskId, service)?.log.slice(-lines).join("\n") ?? "";
  }

  logs(projectId: string, taskId: string, service?: string) {
    if (service) return this.svcOf(projectId, taskId, service)?.log.join("\n") ?? "";
    const g = this.groups.get(this.key(projectId, taskId));
    const sg = this.groups.get(this.key(projectId, SHARED));
    if (!g && !sg) return "";
    const lines = [...(g?.installLog ?? []).map((l) => `[install] ${l}`)];
    for (const s of [...(sg?.services.values() ?? []), ...(g?.services.values() ?? [])]) lines.push(...s.log.map((l) => `[${s.name}] ${l}`));
    return lines.slice(-MAX_LOG_LINES * 2).join("\n");
  }

  private push(target: string[], chunk: Buffer) {
    for (const line of chunk.toString("utf8").split("\n")) if (line) target.push(line);
    if (target.length > MAX_LOG_LINES) target.splice(0, target.length - MAX_LOG_LINES);
  }

  async start(projectId: string, taskId: string, root: string, config: PreviewConfig, env: Record<string, string>, only?: string): Promise<PreviewInfo> {
    const all = servicesOf(config);
    if (only && !all.some((d) => d.name === only)) throw new Error(`No preview service named ${only}`);
    const sharedDefs = all.filter((d) => d.shared);
    if (taskId !== SHARED && sharedDefs.length) {
      const sharedRoot = this.sharedRoot?.(projectId) ?? root;
      if (only && sharedDefs.some((d) => d.name === only)) {
        await this.start(projectId, SHARED, sharedRoot, config, {}, only);
        return this.info(projectId, taskId, config);
      }
      if (only) {
        for (const name of sharedUsedBy(config, all.find((d) => d.name === only)!, sharedDefs)) await this.start(projectId, SHARED, sharedRoot, config, {}, name);
      } else await this.start(projectId, SHARED, sharedRoot, config, {});
    }
    const defs = taskId === SHARED ? sharedDefs : all.filter((d) => !d.shared);
    const target = config.target ?? "machine";
    const deviceMode = target === "device" ? (config.device?.mode ?? "lan") : null;
    const lan = lanAddress();
    if (target === "device" && !lan) throw new Error("No Wi-Fi or Ethernet address was found, so a device cannot reach this Mac");
    const key = this.key(projectId, taskId);
    let g = this.groups.get(key);
    if (!g) {
      g = { key, projectId, taskId, target, deviceMode, services: new Map(), installing: false, installed: false, installChild: null, installLog: [] };
      this.groups.set(key, g);
    }
    g.target = target;
    g.deviceMode = deviceMode;
    const base = previewHost(projectId, taskId);
    for (const d of defs) {
      if (!g.services.has(d.name)) {
        g.services.set(d.name, {
          name: d.name,
          primary: d.primary,
          host: taskId === SHARED ? slug(`${d.name}-${projectId}`).slice(0, 63) : serviceHost(base, d.name),
          port: taskId === SHARED ? (d.port ?? (this.stablePort ? await this.stablePort(projectId, d.name) : await freePort())) : await freePort(),
          inner: 0,
          command: d.command,
          cwd: d.cwd ?? null,
          lanUrl: null,
          deviceUrl: null,
          containerName: null,
          child: null,
          status: "stopped",
          startedAt: null,
          error: null,
          log: [],
          env: null,
        });
      }
    }
    const wanted = defs.filter((d) => !only || d.name === only).filter((d) => {
      const s = g!.services.get(d.name)!;
      return s.status !== "running" && s.status !== "starting";
    });
    for (const d of wanted) {
      const s = g.services.get(d.name)!;
      Object.assign(s, { status: "starting", error: null, startedAt: new Date().toISOString(), log: [] });
    }
    this.onChange(projectId, taskId);
    void this.launch(g, root, config, defs, wanted, env, lan).catch((error) => {
      for (const d of wanted) Object.assign(g!.services.get(d.name)!, { status: "failed", error: error instanceof Error ? error.message : String(error) });
      this.onChange(projectId, taskId);
    });
    return this.info(projectId, taskId, config);
  }

  private templateVars(g: Group, defs: Array<PreviewService & { primary: boolean }>, lan: string | null) {
    const vars: Record<string, string> = {};
    const env: Record<string, string> = {};
    const base = previewHost(g.projectId, g.taskId);
    const sg = g.taskId === SHARED ? null : this.groups.get(this.key(g.projectId, SHARED));
    const entries = [
      ...defs.flatMap((d) => {
        const s = g.services.get(d.name);
        return s ? [{ d, s }] : [];
      }),
      ...[...(sg?.services.values() ?? [])].map((s) => ({ d: { name: s.name, primary: false } as PreviewService & { primary: boolean }, s })),
    ];
    for (const { d, s } of entries) {
      vars[`${d.name}.host`] = "127.0.0.1";
      env[`NIGHTSHIFT_${envName(d.name)}_HOST`] = "127.0.0.1";
      env[`NIGHTSHIFT_${envName(d.name)}_PORT`] = String(s.port);
      const publicUrl = this.url(d.primary ? base : s.host).replace(/\/$/, "");
      const direct = `http://127.0.0.1:${s.port}`;
      vars[`${d.name}.url`] = direct;
      vars[`${d.name}.publicUrl`] = publicUrl;
      vars[`${d.name}.port`] = String(s.port);
      vars[`${d.name}.lanUrl`] = lan ? `http://${lan}:${s.port}` : direct;
      env[`NIGHTSHIFT_${envName(d.name)}_URL`] = direct;
      env[`NIGHTSHIFT_${envName(d.name)}_PUBLIC_URL`] = publicUrl;
    }
    return { vars, env };
  }

  private async launch(g: Group, root: string, config: PreviewConfig, defs: Array<PreviewService & { primary: boolean }>, wanted: typeof defs, env: Record<string, string>, lan: string | null) {
    const container = g.target === "container";
    const image = config.container?.image ?? defaultImage(root);
    const volume = `nightshift-nm-${previewHost(g.projectId, g.taskId)}`;
    if (config.install?.trim() && !g.installed && g.taskId !== SHARED) {
      g.installing = true;
      g.installLog = [];
      this.onChange(g.projectId, g.taskId);
      const child = container
        ? spawn("docker", ["run", "--rm", "--label", "nightshift=1", "--label", "nightshift.preview=1", "-v", `${root}:/workspace`, "-v", `${volume}:/workspace/node_modules`, "-w", "/workspace", image, "sh", "-c", config.install], {
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
          })
        : spawn("sh", ["-c", config.install], { cwd: root, detached: true, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
      g.installChild = child;
      this.savePids();
      child.stdout!.on("data", (c) => this.push(g.installLog, c));
      child.stderr!.on("data", (c) => this.push(g.installLog, c));
      const code = await new Promise<number | null>((resolve) => child.on("exit", (c) => resolve(c)));
      g.installChild = null;
      g.installing = false;
      this.savePids();
      if (code !== 0) throw new Error(`Install failed (exit ${code}): ${g.installLog.slice(-5).join(" ")}`);
      g.installed = true;
    }
    const { vars, env: crossEnv } = this.templateVars(g, defs, lan);
    const fill = (value: string) => value.replace(/\{\{\s*([\w-]+\.(?:url|publicUrl|port|lanUrl|host))\s*\}\}/g, (m, k: string) => vars[k] ?? m);
    // Env-file overrides are for Nightshift's own worktrees; a task working in the owner's project folder leaves its files alone.
    if (g.taskId !== SHARED && !this.isProjectFolder(g.projectId, root)) {
      const notes = this.overlays.apply(g.projectId, g.taskId, root, overlayFiles(defs, fill));
      for (const d of wanted) {
        const own = Object.keys(d.envFiles ?? {}).map((f) => path.posix.join(d.cwd ?? "", f));
        for (const note of notes) if (own.some((f) => note.includes(f))) g.services.get(d.name)!.log.push(`[nightshift] ${note}`);
      }
    }
    for (const d of wanted) {
      const s = g.services.get(d.name)!;
      if (s.status !== "starting") continue;
      if (d.shared && !d.command.trim()) {
        s.inner = s.port;
        const ok = await tcpProbe(s.port);
        s.status = ok ? "running" : "failed";
        s.error = ok ? null : `Nothing answers on 127.0.0.1:${s.port}. Start it yourself, or give this shared service a command so Nightshift runs it.`;
        s.log = [ok ? `Using the service already running on 127.0.0.1:${s.port}` : s.error!];
        if (!ok) this.onFailed?.(g.projectId, g.taskId, s.name);
        continue;
      }
      const portEnv = d.portEnv ?? "PORT";
      const ownContainer = !container && d.target === "container" && g.target !== "device";
      const inContainer = container || ownContainer;
      s.inner = inContainer ? (d.containerPort ?? (defs.length === 1 ? config.containerPort : undefined) ?? s.port) : s.port;
      let command = d.command;
      let readyPath = d.readyPath ?? "/";
      s.lanUrl = null;
      s.deviceUrl = null;
      if (g.target === "device") {
        command = g.deviceMode === "lan" ? toAllInterfaces(command) : expoCommand(command, g.deviceMode!);
        if (/expo start/.test(command)) readyPath = "/status";
        s.lanUrl = `http://${lan}:${s.port}/`;
        if (g.deviceMode === "expo-go" && /expo start/.test(command)) s.deviceUrl = `exp://${lan}:${s.port}`;
      }
      const host = g.target === "device" || inContainer ? "0.0.0.0" : "127.0.0.1";
      s.env = envEntries(d, config, env, crossEnv, fill, { [portEnv]: String(s.inner), BROWSER: "none", HOST: host });
      const extraEnv: Record<string, string> = Object.fromEntries(s.env.filter((e) => e.key !== "HOST").map((e) => [e.key, e.value]));
      const cwd = path.join(root, d.cwd ?? "");
      let child: ChildProcess;
      if (inContainer) {
        s.containerName = `nightshift-preview-${s.host}`;
        const install = ownContainer ? (config.install?.trim() || inferInstall(root)) : null;
        const nmVolume = ownContainer ? `nightshift-nm-${s.host}` : config.install?.trim() ? `${volume}:/workspace/node_modules` : "/workspace/node_modules";
        await new Promise<void>((resolve) => spawn("docker", ["rm", "-f", s.containerName!], { stdio: "ignore" }).on("exit", () => resolve()));
        const envFlags = Object.entries({ ...extraEnv, HOST: "0.0.0.0" }).flatMap(([k, v]) => ["-e", `${k}=${forContainer(v)}`]);
        child = spawn(
          "docker",
          [
            "run",
            "--rm",
            "--name",
            s.containerName,
            "--label",
            "nightshift=1",
            "--label",
            "nightshift.preview=1",
            "--add-host=host.docker.internal:host-gateway",
            "-v",
            `${root}:/workspace`,
            "-v",
            ownContainer ? `${nmVolume}:/workspace/node_modules` : nmVolume,
            "-w",
            path.posix.join("/workspace", d.cwd ?? ""),
            "-p",
            `127.0.0.1:${s.port}:${s.inner}`,
            ...envFlags,
            image,
            "sh",
            "-c",
            install ? `cd /workspace && ${install} && cd ${path.posix.join("/workspace", d.cwd ?? "")} && ${toAllInterfaces(command)}` : toAllInterfaces(command),
          ],
          { detached: true, stdio: ["ignore", "pipe", "pipe"] },
        );
      } else {
        s.containerName = null;
        child = spawn("sh", ["-c", command], {
          cwd,
          detached: true,
          env: { ...process.env, ...extraEnv, HOST: g.target === "device" ? "0.0.0.0" : "127.0.0.1" },
          stdio: ["ignore", "pipe", "pipe"],
        });
      }
      s.child = child;
      child.stdout!.on("data", (c) => this.push(s.log, c));
      child.stderr!.on("data", (c) => this.push(s.log, c));
      child.on("exit", (code, signal) => {
        if (s.child !== child) return;
        if (s.status !== "stopped") {
          s.status = "failed";
          s.error = `Exited with ${signal ?? `code ${code}`}`;
          this.onChange(g.projectId, g.taskId);
          this.onFailed?.(g.projectId, g.taskId, s.name);
        }
        s.child = null;
        this.savePids();
      });
      this.savePids();
      void this.waitReady(s, readyPath, inContainer, d.check ?? "http").then(() => {
        this.onChange(g.projectId, g.taskId);
        if (s.status === "failed") this.onFailed?.(g.projectId, g.taskId, s.name);
      });
    }
    this.onChange(g.projectId, g.taskId);
  }

  private async waitReady(s: Svc, readyPath: string, container: boolean, check: "http" | "tcp" = "http") {
    const deadline = Date.now() + (container ? 600_000 : 180_000);
    while (Date.now() < deadline && s.status === "starting" && check === "tcp") {
      if (await tcpProbe(s.port)) {
        s.status = "running";
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    while (Date.now() < deadline && s.status === "starting") {
      try {
        const res = await fetch(`http://127.0.0.1:${s.port}${readyPath}`, { signal: AbortSignal.timeout(2000) });
        if (res.status < 500) {
          s.status = "running";
          return;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    if (s.status === "starting") {
      s.status = "failed";
      s.error = "The dev server did not answer in time";
    }
  }

  async waitUntilSettled(projectId: string, taskId: string, timeoutMs = 180_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const g = this.groups.get(this.key(projectId, taskId));
      if (!g || (!g.installing && ![...g.services.values()].some((s) => s.status === "starting"))) return;
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  async stop(projectId: string, taskId: string, only?: string) {
    const sg = this.groups.get(this.key(projectId, SHARED));
    if (taskId !== SHARED && only && sg?.services.has(only) && !this.groups.get(this.key(projectId, taskId))?.services.has(only)) {
      await this.stop(projectId, SHARED, only);
      this.onChange(projectId, taskId);
      return;
    }
    const g = this.groups.get(this.key(projectId, taskId));
    if (!g) return;
    if (!only && g.installChild?.pid) {
      try {
        process.kill(-g.installChild.pid, "SIGKILL");
      } catch {}
      g.installing = false;
    }
    if (!only) g.installed = false;
    for (const s of g.services.values()) {
      if (only && s.name !== only) continue;
      s.status = "stopped";
      if (s.containerName) spawn("docker", ["rm", "-f", s.containerName], { stdio: "ignore" });
      const pid = s.child?.pid;
      if (pid) {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {}
        setTimeout(() => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {}
        }, 3000).unref();
      }
    }
    this.savePids();
    this.onChange(projectId, taskId);
    if (taskId !== SHARED && !only && sg && [...sg.services.values()].some((x) => x.status !== "stopped") && this.usedBy(projectId).length === 0) await this.stop(projectId, SHARED);
  }

  async waitStopped(projectId: string, taskId: string, only?: string, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const groups = [this.groups.get(this.key(projectId, taskId)), only ? this.groups.get(this.key(projectId, SHARED)) : undefined].filter(Boolean) as Group[];
      if (!groups.some((g) => [...g.services.values()].some((s) => (!only || s.name === only) && s.child))) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }


  /** Writes the file overrides again with the ports of the task's running apps (after they were restored for a merge). */
  reapplyOverlays(projectId: string, taskId: string, root: string, config: PreviewConfig) {
    const g = this.groups.get(this.key(projectId, taskId));
    if (!g || ![...g.services.values()].some((s) => s.status !== "stopped") || this.isProjectFolder(projectId, root)) return;
    const defs = servicesOf(config).filter((d) => !d.shared);
    const { vars } = this.templateVars(g, defs, g.target === "device" ? lanAddress() : null);
    this.overlays.apply(projectId, taskId, root, overlayFiles(defs, (value) => value.replace(/\{\{\s*([\w-]+\.(?:url|publicUrl|port|lanUrl|host))\s*\}\}/g, (m, k: string) => vars[k] ?? m)));
  }

  private isProjectFolder(projectId: string, root: string) {
    const folder = this.sharedRoot?.(projectId);
    return Boolean(folder) && path.resolve(folder!) === path.resolve(root);
  }

  runningEnv(projectId: string, taskId: string, service: string): EnvEntry[] | null {
    const s = this.svcOf(projectId, taskId, service);
    return s && s.status !== "stopped" && s.env ? s.env : null;
  }

  /** The env `service` gets on its next start, with the ports known now. */
  plannedEnv(projectId: string, taskId: string, config: PreviewConfig, env: Record<string, string>, service: string, fillOut?: { fill: (value: string) => string }): EnvEntry[] {
    const all = servicesOf(config);
    const d = all.find((x) => x.name === service);
    if (!d) throw new Error(`No preview service named ${service}`);
    const groupTask = d.shared ? SHARED : taskId;
    const defs = all.filter((x) => Boolean(x.shared) === Boolean(d.shared));
    const target = config.target ?? "machine";
    const g: Group = this.groups.get(this.key(projectId, groupTask)) ?? {
      key: this.key(projectId, groupTask),
      projectId,
      taskId: groupTask,
      target,
      deviceMode: null,
      services: new Map(),
      installing: false,
      installed: false,
      installChild: null,
      installLog: [],
    };
    const { vars, env: crossEnv } = this.templateVars(g, defs, target === "device" ? lanAddress() : null);
    const fill = (value: string) => value.replace(/\{\{\s*([\w-]+\.(?:url|publicUrl|port|lanUrl|host))\s*\}\}/g, (m, k: string) => vars[k] ?? m);
    if (fillOut) fillOut.fill = fill;
    const s = g.services.get(d.name);
    const inContainer = target === "container" || (d.target === "container" && target !== "device");
    const inner = s?.inner || (inContainer ? d.containerPort : undefined) || s?.port;
    const host = target === "device" || inContainer ? "0.0.0.0" : "127.0.0.1";
    return envEntries(d, config, d.shared ? {} : env, crossEnv, fill, { [d.portEnv ?? "PORT"]: inner ? String(inner) : "(a free port, picked at start)", BROWSER: "none", HOST: host });
  }

  forget(projectId: string, taskId: string) {
    this.groups.delete(this.key(projectId, taskId));
    this.overlays.drop(projectId, taskId);
  }

  async stopAll() {
    for (const g of this.groups.values()) await this.stop(g.projectId, g.taskId);
  }
}
