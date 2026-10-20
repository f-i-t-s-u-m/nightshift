export type SkillSourceKind = "builtin" | "folder" | "git" | "claude-code" | "written";

export type SkillSource = { kind: SkillSourceKind; ref?: string; path?: string };

export type Skill = {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  files: string[];
  sizeBytes: number;
  enabled: boolean;
  builtin: boolean;
  taskTypes: import("./task-types.ts").TaskType[];
  installedAt: string;
  updatedAt: string;
};

export type SkillDetail = Skill & { content: string };

export type SkillCandidate = {
  path: string;
  name: string;
  description: string;
  files: number;
  installedId: string | null;
  error: string | null;
};

export type SkillDiscovery = { sourceId: string; label: string; candidates: SkillCandidate[] };

export type SkillDiscoverInput = { path?: string; gitUrl?: string; claudeCode?: boolean };

export type SkillImportInput = { sourceId: string; paths: string[]; replace?: boolean };

export type SkillWriteInput = { name: string; description: string; body: string };

export type ProjectSkillOrigin = "nightshift" | "repository";

export type ProjectSkill = {
  id: string;
  name: string;
  description: string;
  origin: ProjectSkillOrigin;
  path: string;
  globalEnabled: boolean;
  override: boolean | null;
  enabled: boolean;
};

export type SkillsResponse = { skills: Skill[] };
export type SkillResponse = { skill: SkillDetail };
export type ProjectSkillsResponse = { skills: ProjectSkill[] };

export const SKILL_ROUTES = {
  list: "/api/skills",
  skill: (id: string) => `/api/skills/${encodeURIComponent(id)}`,
  discover: "/api/skills/discover",
  import: "/api/skills/import",
  project: (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/skills`,
} as const;
