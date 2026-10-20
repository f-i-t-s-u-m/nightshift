import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { CheckConfig, DatabaseConfig, PreviewConfig, PreviewService, ProjectDoc, ProjectInspection, ProjectKind } from "@nightshift/core";
import { run } from "@nightshift/git";

type Pkg = {
  name?: string;
  main?: string;
  exports?: unknown;
  workspaces?: string[] | { packages?: string[] };
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  prisma?: { seed?: string };
};

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
};

const readText = (file: string, max = 200_000) => {
  try {
    return readFileSync(file, "utf8").slice(0, max);
  } catch {
    return "";
  }
};

const has = (root: string, ...files: string[]) => files.some((f) => existsSync(path.join(root, f)));

const FRAMEWORKS: Array<[string, string]> = [
  ["next", "Next.js"],
  ["nuxt", "Nuxt"],
  ["@remix-run/react", "Remix"],
  ["@sveltejs/kit", "SvelteKit"],
  ["astro", "Astro"],
  ["vite", "Vite"],
  ["react", "React"],
  ["vue", "Vue"],
  ["svelte", "Svelte"],
  ["expo", "Expo"],
  ["react-native", "React Native"],
  ["electron", "Electron"],
  ["@tauri-apps/api", "Tauri"],
  ["hono", "Hono"],
  ["express", "Express"],
  ["fastify", "Fastify"],
  ["@nestjs/core", "NestJS"],
  ["prisma", "Prisma"],
  ["@prisma/client", "Prisma"],
  ["drizzle-orm", "Drizzle"],
  ["typeorm", "TypeORM"],
  ["tailwindcss", "Tailwind CSS"],
  ["storybook", "Storybook"],
  ["@storybook/react", "Storybook"],
  ["vitest", "Vitest"],
  ["jest", "Jest"],
  ["@playwright/test", "Playwright"],
  ["turbo", "Turborepo"],
];

function expandWorkspaces(root: string, patterns: string[]): string[] {
  const out: string[] = [];
  for (const pattern of patterns) {
    const clean = pattern.replace(/\/\*\*?$/, "");
    if (pattern.endsWith("*")) {
      const dir = path.join(root, clean);
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory() && existsSync(path.join(full, "package.json"))) out.push(path.join(clean, name));
      }
    } else if (existsSync(path.join(root, clean, "package.json"))) out.push(clean);
  }
  return out;
}

function pnpmWorkspaces(root: string): string[] {
  const text = readText(path.join(root, "pnpm-workspace.yaml"));
  return [...text.matchAll(/^\s*-\s*['"]?([^'"\n]+)['"]?\s*$/gm)].map((m) => m[1].trim());
}

function title(markdown: string, fallback: string) {
  return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? fallback;
}

function excerpt(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^#+\s+.*$/gm, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

export function readDocs(root: string): ProjectDoc[] {
  const candidates = ["README.md", "readme.md", "README", "AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "CONTEXT.md", "ARCHITECTURE.md", "docs/README.md"];
  const docs: ProjectDoc[] = [];
  for (const c of candidates) {
    const file = path.join(root, c);
    if (existsSync(file) && statSync(file).isFile() && !docs.some((d) => d.path.toLowerCase() === c.toLowerCase())) {
      const text = readText(file, 50_000);
      docs.push({ path: c, title: title(text, c), excerpt: excerpt(text) });
    }
  }
  const docsDir = path.join(root, "docs");
  if (existsSync(docsDir) && statSync(docsDir).isDirectory()) {
    for (const name of readdirSync(docsDir).filter((n) => n.endsWith(".md")).slice(0, 6)) {
      const rel = `docs/${name}`;
      if (docs.some((d) => d.path === rel)) continue;
      const text = readText(path.join(docsDir, name), 50_000);
      docs.push({ path: rel, title: title(text, name), excerpt: excerpt(text) });
    }
  }
  return docs;
}

async function gitInfo(root: string): Promise<ProjectInspection["git"]> {
  const isRepo = (await run("git", ["rev-parse", "--git-dir"], { cwd: root })).code === 0;
  if (!isRepo) return { isRepo, remote: null, remoteUrl: null, defaultBranch: null, github: false, dirty: false };
  const remotes = (await run("git", ["remote"], { cwd: root })).stdout.split("\n").filter(Boolean);
  const remote = remotes.includes("origin") ? "origin" : (remotes[0] ?? null);
  const remoteUrl = remote ? (await run("git", ["remote", "get-url", remote], { cwd: root })).stdout.trim() || null : null;
  let defaultBranch: string | null = null;
  if (remote) {
    const head = await run("git", ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`], { cwd: root });
    if (head.code === 0) defaultBranch = head.stdout.trim().replace(`${remote}/`, "");
  }
  if (!defaultBranch) {
    for (const b of ["main", "master", "develop"]) {
      if ((await run("git", ["rev-parse", "--verify", "--quiet", remote ? `refs/remotes/${remote}/${b}` : b], { cwd: root })).code === 0) {
        defaultBranch = b;
        break;
      }
    }
  }
  if (!defaultBranch) defaultBranch = (await run("git", ["branch", "--show-current"], { cwd: root })).stdout.trim() || null;
  const dirty = (await run("git", ["status", "--porcelain"], { cwd: root })).stdout.trim().length > 0;
  return { isRepo, remote, remoteUrl, defaultBranch, github: /github\.com[:/]/.test(remoteUrl ?? ""), dirty };
}

const FRONTEND_DEPS = ["next", "vite", "astro", "@sveltejs/kit", "nuxt", "@remix-run/react", "expo", "react-scripts"];
const BACKEND_DEPS = ["express", "hono", "fastify", "@nestjs/core", "koa", "@hono/node-server", "elysia"];

function monorepoServices(root: string, packages: string[], pm: string): PreviewService[] {
  const pass = pm === "npm" ? " --" : "";
  type App = { name: string; cwd: string; deps: Set<string>; script: string; frontend: boolean; backend: boolean; envKeys: string[] };
  const apps: App[] = [];
  const used = new Set<string>();
  for (const dir of packages) {
    const p = readJson<Pkg>(path.join(root, dir, "package.json"));
    const script = p?.scripts?.dev ? "dev" : p?.scripts?.start ? "start" : null;
    if (!p || !script) continue;
    const deps = new Set(Object.keys({ ...p.dependencies, ...p.devDependencies }));
    const frontend = FRONTEND_DEPS.some((d) => deps.has(d));
    const backend = !frontend && BACKEND_DEPS.some((d) => deps.has(d));
    const isApp = frontend || backend || dir.split("/")[0] === "apps" || dir.split("/")[0] === "services";
    if (!isApp || (!frontend && !backend && (p.main || p.exports) && dir.split("/")[0] === "packages")) continue;
    let name = path.basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "app";
    while (used.has(name)) name = `${name}-2`;
    used.add(name);
    const envText = [".env.example", ".env.sample", ".env.local.example"].map((c) => readText(path.join(root, dir, c))).join("\n");
    const envKeys = [...envText.matchAll(/^\s*([A-Z][A-Z0-9_]*(?:API|BACKEND|SERVER)[A-Z0-9_]*URL)\s*=/gm)].map((m) => m[1]!);
    apps.push({ name, cwd: dir, deps, script, frontend, backend, envKeys });
  }
  if (apps.length < 2) return [];
  const api = apps.find((a) => a.backend && /^(api|server|backend)/.test(a.name)) ?? apps.find((a) => a.backend);
  const primary = apps.find((a) => a.frontend && /^(web|app|site|frontend|client|dashboard)$/.test(a.name)) ?? apps.find((a) => a.frontend) ?? apps[0]!;
  return apps.map((a) => {
    const run = runScript(pm, a.script);
    let command = run;
    if (a.deps.has("expo")) command = `${pm === "bun" ? "bunx" : "npx"} expo start --web --port $PORT`;
    else if (a.deps.has("next")) command = `${run}${pass} -p $PORT -H 127.0.0.1`;
    else if (a.deps.has("vite") || a.deps.has("astro") || a.deps.has("@sveltejs/kit")) command = `${run}${pass} --port $PORT --host 127.0.0.1 --strictPort`;
    const env: Record<string, string> = {};
    if (api && api !== a && a.frontend) {
      const pub = a.deps.has("next") ? "NEXT_PUBLIC_API_URL" : a.deps.has("expo") ? "EXPO_PUBLIC_API_URL" : a.deps.has("vite") || a.deps.has("@sveltejs/kit") ? "VITE_API_URL" : null;
      if (pub) env[pub] = `{{${api.name}.publicUrl}}`;
      env.API_URL = `{{${api.name}.url}}`;
      for (const k of a.envKeys) env[k] = /^(NEXT_PUBLIC|VITE|EXPO_PUBLIC|PUBLIC|REACT_APP)_/.test(k) ? `{{${api.name}.publicUrl}}` : `{{${api.name}.url}}`;
    }
    return { name: a.name, command, cwd: a.cwd, portEnv: "PORT", readyPath: "/", ...(Object.keys(env).length ? { env } : {}), ...(a === primary ? { primary: true } : {}) };
  });
}

const runScript = (pm: string, script: string) => (pm === "npm" ? (script === "test" ? "npm test" : `npm run ${script}`) : `${pm} run ${script}`);

export async function inspectRepository(root: string): Promise<ProjectInspection> {
  if (!path.isAbsolute(root) || !existsSync(root) || !statSync(root).isDirectory()) throw new Error(`${root} is not a folder`);
  const notes: string[] = [];
  const pkg = readJson<Pkg>(path.join(root, "package.json"));
  const languages = new Set<string>();
  if (pkg) languages.add(has(root, "tsconfig.json") ? "TypeScript" : "JavaScript");
  if (has(root, "pyproject.toml", "requirements.txt", "setup.py")) languages.add("Python");
  if (has(root, "go.mod")) languages.add("Go");
  if (has(root, "Cargo.toml")) languages.add("Rust");
  if (has(root, "Gemfile")) languages.add("Ruby");
  if (has(root, "composer.json")) languages.add("PHP");

  let packageManager: ProjectInspection["packageManager"] = null;
  if (has(root, "bun.lock", "bun.lockb")) packageManager = "bun";
  else if (has(root, "pnpm-lock.yaml")) packageManager = "pnpm";
  else if (has(root, "yarn.lock")) packageManager = "yarn";
  else if (pkg) packageManager = "npm";
  else if (has(root, "uv.lock")) packageManager = "uv";
  else if (has(root, "poetry.lock")) packageManager = "poetry";
  else if (has(root, "requirements.txt")) packageManager = "pip";
  else if (has(root, "go.mod")) packageManager = "go";
  else if (has(root, "Cargo.toml")) packageManager = "cargo";

  const wsPatterns = Array.isArray(pkg?.workspaces) ? pkg.workspaces : (pkg?.workspaces?.packages ?? []);
  const patterns = [...wsPatterns, ...(has(root, "pnpm-workspace.yaml") ? pnpmWorkspaces(root) : [])];
  const packages = patterns.length ? expandWorkspaces(root, patterns) : [];
  const monorepo = packages.length
    ? { tool: has(root, "turbo.json") ? "Turborepo" : has(root, "nx.json") ? "Nx" : packageManager === "pnpm" ? "pnpm workspaces" : "workspaces", packages }
    : null;

  const allDeps = new Map<string, string[]>();
  const addDeps = (p: Pkg | null, where: string) => {
    for (const dep of Object.keys({ ...p?.dependencies, ...p?.devDependencies })) allDeps.set(dep, [...(allDeps.get(dep) ?? []), where]);
  };
  addDeps(pkg, ".");
  for (const p of packages) addDeps(readJson<Pkg>(path.join(root, p, "package.json")), p);
  const pyText = `${readText(path.join(root, "pyproject.toml"))}\n${readText(path.join(root, "requirements.txt"))}`.toLowerCase();
  const frameworks = new Set<string>();
  for (const [dep, label] of FRAMEWORKS) if (allDeps.has(dep)) frameworks.add(label);
  for (const py of ["django", "fastapi", "flask"]) if (pyText.includes(py)) frameworks.add(py[0].toUpperCase() + py.slice(1));
  const f = (label: string) => frameworks.has(label);

  const rootSchema = [path.join(root, "prisma", "schema.prisma"), path.join(root, "schema.prisma")].some(existsSync) || Boolean(pkg?.prisma && (pkg.prisma as { schema?: string }).schema);
  const prismaDirs = packages.filter((p) => existsSync(path.join(root, p, "prisma", "schema.prisma")) || existsSync(path.join(root, p, "schema.prisma")));
  const prismaSchema = [path.join(root, "prisma", "schema.prisma"), ...prismaDirs.map((p) => path.join(root, p, "prisma", "schema.prisma"))].find(existsSync);
  const prismaText = prismaSchema ? readText(prismaSchema) : "";
  const compose = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"].map((c) => readText(path.join(root, c))).join("\n");
  const envExample = [".env.example", ".env.sample", ".env.template"].map((c) => readText(path.join(root, c))).join("\n");
  let detectedDb: string | null = null;
  if (/provider\s*=\s*"postgresql"/.test(prismaText) || /image:\s*\S*(postgres|pgvector)/.test(compose) || /DATABASE_URL\s*=\s*"?postgres/i.test(envExample)) detectedDb = "postgres";
  else if (/provider\s*=\s*"mysql"/.test(prismaText) || /image:\s*\S*mysql/.test(compose)) detectedDb = "mysql";
  else if (/provider\s*=\s*"sqlite"/.test(prismaText)) detectedDb = "sqlite";
  const orm = f("Prisma") || prismaSchema ? "Prisma" : f("Drizzle") ? "Drizzle" : f("TypeORM") ? "TypeORM" : f("Django") ? "Django ORM" : null;

  let kind: ProjectKind = "other";
  if (f("Expo") || f("React Native")) kind = "mobile";
  else if (f("Electron") || f("Tauri")) kind = "desktop";
  else if (monorepo) kind = "monorepo";
  else if ((f("Next.js") || f("Nuxt") || f("Remix") || f("SvelteKit")) && orm) kind = "fullstack";
  else if (f("Next.js") || f("Nuxt") || f("Remix") || f("SvelteKit") || f("Astro") || f("Vite") || f("React") || f("Vue") || f("Svelte")) kind = "web";
  else if (f("Hono") || f("Express") || f("Fastify") || f("NestJS") || f("Django") || f("Fastapi") || f("Flask")) kind = "backend";
  else if (f("Storybook") || has(root, "tokens", "design-tokens", "figma")) kind = "design";
  else if (pkg && (pkg.main || pkg.exports)) kind = "library";

  const scripts = pkg?.scripts ?? {};
  const pm = packageManager ?? "npm";
  const js = ["bun", "pnpm", "yarn", "npm"].includes(pm);
  const install = js
    ? { bun: "bun install", pnpm: "pnpm install --frozen-lockfile", yarn: "yarn install --frozen-lockfile", npm: has(root, "package-lock.json") ? "npm ci" : "npm install" }[pm as "bun"]
    : pm === "uv"
      ? "uv sync"
      : pm === "poetry"
        ? "poetry install"
        : pm === "pip"
          ? "pip install -r requirements.txt"
          : pm === "go"
            ? "go mod download"
            : pm === "cargo"
              ? "cargo fetch"
              : undefined;
  const prismaRunner = pm === "bun" ? "bunx" : "npx";
  const prismaGenerate =
    orm !== "Prisma"
      ? undefined
      : rootSchema
        ? `${prismaRunner} prisma generate`
        : prismaDirs.length
          ? prismaDirs.map((d) => `(cd ${d} && ${prismaRunner} prisma generate)`).join(" && ")
          : undefined;
  const setupParts = [install, prismaGenerate].filter(Boolean);

  const checks: CheckConfig[] = [];
  const typecheckScript = ["typecheck", "type-check", "check-types", "tsc"].find((s) => scripts[s]);
  if (typecheckScript) checks.push({ name: "typecheck", command: runScript(pm, typecheckScript) });
  if (scripts.lint) checks.push({ name: "lint", command: runScript(pm, "lint") });
  if (scripts.test && !/no test specified/.test(scripts.test)) checks.push({ name: "tests", command: runScript(pm, "test") });
  if (!js && languages.has("Python") && (pyText.includes("pytest") || has(root, "tests", "pytest.ini"))) checks.push({ name: "tests", command: pm === "uv" ? "uv run pytest" : "pytest" });
  if (pm === "go") checks.push({ name: "tests", command: "go test ./..." });
  if (pm === "cargo") checks.push({ name: "tests", command: "cargo test" });
  if (!checks.length) notes.push("No test, typecheck or lint script was found. Add checks so Nightshift can verify the agent's work.");

  let preview: PreviewConfig | undefined;
  const dev = scripts.dev ? runScript(pm, "dev") : scripts.start ? runScript(pm, "start") : null;
  const pass = pm === "npm" ? " --" : "";
  if (f("Expo")) preview = { command: `${pm === "bun" ? "bunx" : "npx"} expo start --web --port $PORT`, portEnv: "PORT", readyPath: "/" };
  else if (dev && f("Next.js")) preview = { command: `${dev}${pass} -p $PORT -H 127.0.0.1`, portEnv: "PORT", readyPath: "/" };
  else if (dev && (f("Vite") || f("Astro") || f("SvelteKit"))) preview = { command: `${dev}${pass} --port $PORT --host 127.0.0.1 --strictPort`, portEnv: "PORT", readyPath: "/" };
  else if (dev) preview = { command: dev, portEnv: "PORT", readyPath: "/" };
  else if (f("Django")) preview = { command: "python manage.py runserver 127.0.0.1:$PORT", portEnv: "PORT", readyPath: "/" };
  else if (f("Fastapi")) preview = { command: "uvicorn main:app --host 127.0.0.1 --port $PORT", portEnv: "PORT", readyPath: "/" };
  const services = monorepo ? monorepoServices(root, packages, pm) : [];
  if (services.length) {
    const primary = services.find((s) => s.primary)!;
    preview = { services, command: primary.command, portEnv: "PORT", readyPath: "/" };
    notes.push(
      `This is a ${monorepo!.tool} monorepo. Each app gets its own preview URL: ${services.map((s) => `${s.name} (${s.cwd})`).join(", ")}. Apps can reach each other through {{name.url}} placeholders and NIGHTSHIFT_<NAME>_URL variables.`,
    );
  } else if (monorepo) notes.push(`This is a ${monorepo.tool} monorepo with ${packages.length} packages. Check the preview command points at the app you want to preview.`);
  if (preview && !services.length && !f("Next.js") && !f("Vite") && !f("Expo") && !f("Astro") && !f("SvelteKit")) notes.push("Make sure the dev server listens on the port in $PORT, or edit the preview command.");

  let database: DatabaseConfig = { mode: "none" };
  if (detectedDb === "postgres") {
    const runner = pm === "bun" ? "bunx" : "npx";
    const seed = pkg?.prisma?.seed || scripts["db:seed"] || scripts.seed;
    const setup =
      orm === "Prisma"
        ? rootSchema || prismaDirs.length === 1
          ? (() => {
              const steps = `${runner} prisma migrate deploy${seed ? ` && ${runner} prisma db seed` : ""}`;
              return [install, rootSchema ? steps : `(cd ${prismaDirs[0]} && ${steps})`].filter(Boolean).join(" && ");
            })()
          : undefined
        : scripts["db:setup"]
          ? [install, runScript(pm, "db:setup")].filter(Boolean).join(" && ")
          : scripts["db:migrate"]
            ? [install, runScript(pm, "db:migrate"), scripts["db:seed"] ? runScript(pm, "db:seed") : undefined].filter(Boolean).join(" && ")
            : undefined;
    database = {
      mode: "docker",
      engine: "postgres",
      image: /pgvector/.test(compose) || /extensions\s*=\s*\[[^\]]*vector/.test(prismaText) ? "pgvector/pgvector:pg16" : "postgres:17-alpine",
      envVar: "DATABASE_URL",
      ...(setup ? { setup } : {}),
    };
    if (!setup) notes.push("A Postgres database was detected but no migrate/seed command. Add one to the database setup so each task gets a ready database.");
  } else if (detectedDb) {
    notes.push(`A ${detectedDb} database was detected. Nightshift creates Postgres databases only for now; the database stays off.`);
  }

  const git = await gitInfo(root);
  if (!git.isRepo) notes.push("This folder is not a git repository. Nightshift needs git with a remote to create branches and pull requests.");
  else if (!git.remote) notes.push("The repository has no remote. Add one (for example a GitHub repository) so Nightshift can push branches.");
  if (git.dirty) notes.push("The repository has uncommitted changes. Agents work in separate worktrees from the remote branch, so local changes are not included.");

  return {
    path: root,
    name: pkg?.name?.replace(/^@[^/]+\//, "") || path.basename(root),
    kind,
    languages: [...languages],
    frameworks: [...frameworks],
    packageManager,
    monorepo,
    scripts,
    docs: readDocs(root),
    git,
    database: { detected: detectedDb, orm },
    suggested: {
      name: pkg?.name?.replace(/^@[^/]+\//, "") || path.basename(root),
      baseBranch: git.defaultBranch ?? "main",
      ...(setupParts.length ? { setup: setupParts.join(" && ") } : {}),
      checks,
      ...(preview ? { preview } : {}),
      database,
      gitHost: git.github ? "github" : "local",
    },
    notes,
  };
}
