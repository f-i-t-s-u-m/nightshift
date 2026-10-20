import type { CheckConfig } from "./config.ts";
import type { DatabaseConfig, PreviewConfig } from "./workspace.ts";

export type ProjectKind = "web" | "mobile" | "backend" | "fullstack" | "desktop" | "library" | "design" | "monorepo" | "other";

export const PROJECT_KINDS: Array<{ kind: ProjectKind; label: string; description: string }> = [
  { kind: "web", label: "Web app", description: "A website or single-page app that runs in the browser." },
  { kind: "mobile", label: "Mobile app", description: "An iOS/Android app. Previews run in the browser (Expo web) or on a simulator/device." },
  { kind: "backend", label: "Backend / API", description: "A server or API with an optional database." },
  { kind: "fullstack", label: "Full-stack app", description: "Frontend and backend together, usually with a database." },
  { kind: "desktop", label: "Desktop app", description: "An Electron or Tauri app." },
  { kind: "library", label: "Library / package", description: "Code that other projects import; checks are tests and types." },
  { kind: "monorepo", label: "Monorepo", description: "Several apps and packages in one repository (Turborepo, Nx, workspaces)." },
  { kind: "design", label: "Design", description: "Design system, tokens and clickable HTML prototypes the agent builds from your briefs and pictures." },
  { kind: "other", label: "Other", description: "Anything else." },
];

export type Starter = {
  id: string;
  kind: ProjectKind;
  label: string;
  instructions: string;
  preview?: PreviewConfig;
  checks: CheckConfig[];
  database?: DatabaseConfig;
};

export const STARTERS: Starter[] = [
  {
    id: "vite-react",
    kind: "web",
    label: "Vite + React + TypeScript",
    instructions:
      "Scaffold a Vite + React + TypeScript app with npm in the repository root (do not create a subfolder). Add a `test` script using Vitest with one smoke test and a `typecheck` script (`tsc --noEmit`). The dev server must listen on the port in $PORT (vite --port $PORT --host 127.0.0.1).",
    preview: { command: "npm install --no-audit --no-fund && npx vite --port $PORT --host 127.0.0.1 --strictPort", portEnv: "PORT", readyPath: "/" },
    checks: [
      { name: "typecheck", command: "npm run typecheck" },
      { name: "tests", command: "npm test -- --run" },
    ],
  },
  {
    id: "nextjs",
    kind: "web",
    label: "Next.js (App Router, TypeScript)",
    instructions:
      "Scaffold a Next.js App Router project with TypeScript and Tailwind using npm in the repository root. Add `typecheck` (`tsc --noEmit`) and `test` (Vitest, one smoke test) scripts. `next dev -p $PORT -H 127.0.0.1` must work.",
    preview: { command: "npm install --no-audit --no-fund && npx next dev -p $PORT -H 127.0.0.1", portEnv: "PORT", readyPath: "/" },
    checks: [
      { name: "typecheck", command: "npm run typecheck" },
      { name: "lint", command: "npm run lint" },
    ],
  },
  {
    id: "expo",
    kind: "mobile",
    label: "Expo (React Native, TypeScript)",
    instructions:
      "Scaffold an Expo app with TypeScript (expo-router) using npm in the repository root. Make `npx expo start --web --port $PORT` work so the app can be previewed in the browser. Add `typecheck` and `test` (jest-expo, one smoke test) scripts.",
    preview: { command: "npm install --no-audit --no-fund && npx expo start --web --port $PORT", portEnv: "PORT", readyPath: "/" },
    checks: [{ name: "typecheck", command: "npm run typecheck" }],
  },
  {
    id: "hono-postgres",
    kind: "backend",
    label: "Hono API + Postgres (Drizzle)",
    instructions:
      "Scaffold a TypeScript Hono API on Node with Drizzle ORM for Postgres using npm in the repository root. Read DATABASE_URL from the environment, add a `users` table with a migration and a seed script, `GET /health` and `GET /users`. Listen on $PORT. Add `typecheck`, `test` (Vitest) and `db:setup` (migrate + seed) scripts.",
    preview: { command: "npm install --no-audit --no-fund && npm run dev", portEnv: "PORT", readyPath: "/health" },
    checks: [
      { name: "typecheck", command: "npm run typecheck" },
      { name: "tests", command: "npm test -- --run" },
    ],
    database: { mode: "docker", engine: "postgres", setup: "npm install --no-audit --no-fund && npm run db:setup" },
  },
  {
    id: "next-prisma",
    kind: "fullstack",
    label: "Next.js + Prisma + Postgres",
    instructions:
      "Scaffold a Next.js App Router app with Prisma for Postgres using npm in the repository root. Use DATABASE_URL from the environment, add a User model with a migration and a seed. Add `typecheck`, `test` (Vitest) and `db:setup` (`prisma migrate deploy && prisma db seed`) scripts. `next dev -p $PORT -H 127.0.0.1` must work.",
    preview: { command: "npm install --no-audit --no-fund && npx next dev -p $PORT -H 127.0.0.1", portEnv: "PORT", readyPath: "/" },
    checks: [{ name: "typecheck", command: "npm run typecheck" }],
    database: { mode: "docker", engine: "postgres", setup: "npm install --no-audit --no-fund && npm run db:setup" },
  },
  {
    id: "ts-library",
    kind: "library",
    label: "TypeScript library",
    instructions: "Scaffold a TypeScript library with npm: src/index.ts, `build` (tsc), `typecheck` and `test` (Vitest) scripts, a README with usage.",
    checks: [
      { name: "typecheck", command: "npm run typecheck" },
      { name: "tests", command: "npm test -- --run" },
    ],
  },
  {
    id: "design-system",
    kind: "design",
    label: "Design system + HTML prototypes",
    instructions:
      "Set up a design workspace: `tokens/` (colors, type, spacing as JSON + generated CSS variables), `components/` (static HTML/CSS components using the tokens), `prototypes/` (clickable HTML pages built from the components) and an `index.html` gallery linking everything. No build step: a static server must serve the root on $PORT (`npx serve -l $PORT .`). Pictures attached to tasks are references to recreate.",
    preview: { command: "npx --yes serve -l $PORT .", portEnv: "PORT", readyPath: "/" },
    checks: [],
  },
  {
    id: "empty",
    kind: "other",
    label: "Empty repository",
    instructions: "Create a README.md describing the project from the description below, and an AGENTS.md with conventions for future agents.",
    checks: [],
  },
];

export type ProjectDoc = { path: string; title: string; excerpt: string };

export type ProjectInspection = {
  path: string;
  name: string;
  kind: ProjectKind;
  languages: string[];
  frameworks: string[];
  packageManager: "bun" | "pnpm" | "yarn" | "npm" | "pip" | "poetry" | "uv" | "go" | "cargo" | null;
  monorepo: { tool: string; packages: string[] } | null;
  scripts: Record<string, string>;
  docs: ProjectDoc[];
  git: { isRepo: boolean; remote: string | null; remoteUrl: string | null; defaultBranch: string | null; github: boolean; dirty: boolean };
  database: { detected: string | null; orm: string | null };
  suggested: {
    name: string;
    baseBranch: string;
    setup?: string;
    checks: CheckConfig[];
    preview?: PreviewConfig;
    database: DatabaseConfig;
    gitHost: "github" | "local";
  };
  notes: string[];
};

export type InspectInput = { path?: string; gitUrl?: string };

export type InspectResponse = { inspection: ProjectInspection };

export type ScaffoldInput = {
  name: string;
  kind: ProjectKind;
  starterId: string;
  description: string;
  parentDir?: string;
  planMode?: "off" | "plan" | "approve";
  review?: boolean;
  github?: import("./github.ts").GithubRepoInput;
};

export type ScaffoldResponse = { project: import("./projects.ts").ProjectSummary; taskId: string };

export type ProjectUpdate = Partial<{
  name: string;
  kind: ProjectKind;
  brief: string;
  repo: { baseBranch?: string; branchPrefix?: string; setup?: string; remote?: string };
  checks: CheckConfig[];
  gitHost: "github" | "local";
  source: import("./projects.ts").ProjectSource;
  preview: PreviewConfig | null;
  database: DatabaseConfig;
  planMode: "off" | "plan" | "approve";
  review: boolean;
  paused: boolean;
  model: import("./models.ts").ModelChoice | null;
  reviewModel: import("./models.ts").ModelChoice | null;
  testers: import("./verification.ts").TesterConfig[];
  triggers: import("./verification.ts").TriggerConfig;
  skills: Record<string, boolean | null>;
  pushMode: "auto" | "approve";
  localFiles: import("./workspace.ts").LocalFilesConfig | null;
}>;

export type BriefResponse = { brief: string };

export type CommitDiffFile = {
  path: string;
  oldPath?: string;
  status: import("./workspace.ts").GitFileStatus;
  original: string;
  modified: string;
  language: string;
  binary: boolean;
  tooLarge: boolean;
};

export type CommitDiffResponse = { sha: string; subject: string; files: CommitDiffFile[] };

export const ONBOARDING_ROUTES = {
  inspect: "/api/projects/inspect",
  scaffold: "/api/projects/scaffold",
  starters: "/api/starters",
  brief: (id: string) => `/api/projects/${encodeURIComponent(id)}/brief`,
  commit: (p: string, t: string, sha: string) =>
    `/api/projects/${encodeURIComponent(p)}/tasks/${encodeURIComponent(t)}/workspace/git/commit?sha=${encodeURIComponent(sha)}`,
} as const;
