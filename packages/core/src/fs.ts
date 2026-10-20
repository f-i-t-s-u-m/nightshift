export type FsEntry = {
  name: string;
  path: string;
  isGitRepo: boolean;
  hasPackageJson: boolean;
  hidden: boolean;
};

export type FsListResponse = {
  path: string;
  parent: string | null;
  home: string;
  isGitRepo: boolean;
  entries: FsEntry[];
  truncated: boolean;
  shortcuts: Array<{ label: string; path: string }>;
};

export type FsMkdirResponse = { path: string };

export const FS_ROUTES = {
  list: (path?: string, hidden = false) =>
    `/api/fs/list?${new URLSearchParams({ ...(path ? { path } : {}), ...(hidden ? { hidden: "1" } : {}) }).toString()}`,
  mkdir: "/api/fs/mkdir",
} as const;
