export type GithubVisibility = "private" | "public";

export type GithubStatus = {
  installed: boolean;
  loggedIn: boolean;
  login: string | null;
  orgs: string[];
  protocol: "https" | "ssh";
  message: string | null;
};

export type GithubRepoInput = { owner: string; name: string; visibility: GithubVisibility; description?: string };

export type MoveToGithubResult = {
  project: import("./projects.ts").ProjectSummary;
  repoUrl: string;
  remoteUrl: string;
  branches: string[];
  pullRequests: Array<{ taskId: string; branch: string; url: string | null; error: string | null }>;
  backupRemote: string;
};

export const GITHUB_ROUTES = {
  status: "/api/github",
  moveProject: (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/move-to-github`,
} as const;
