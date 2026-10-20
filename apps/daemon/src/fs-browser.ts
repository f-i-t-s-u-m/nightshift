import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { FsEntry, FsListResponse } from "@nightshift/core";

const MAX_ENTRIES = 500;

export class FsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function insideHome(target: string) {
  const home = realpathSync(homedir());
  const rel = path.relative(home, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function resolveDir(input: string | undefined): string {
  const raw = (input ?? "").trim().replace(/^~(?=\/|$)/, homedir()) || homedir();
  if (!path.isAbsolute(raw)) throw new FsError("Use an absolute path", 400);
  if (!existsSync(raw)) throw new FsError("That folder does not exist", 404);
  const real = realpathSync(raw);
  if (!statSync(real).isDirectory()) throw new FsError("That is not a folder", 400);
  if (!insideHome(real)) throw new FsError("Only folders inside your home folder can be browsed", 403);
  return real;
}

export function listFolders(input: string | undefined, showHidden: boolean, extraShortcuts: Array<{ label: string; path: string }>): FsListResponse {
  const dir = resolveDir(input);
  const home = realpathSync(homedir());
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    throw new FsError("This folder cannot be read", 403);
  }
  const entries: FsEntry[] = [];
  for (const name of names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))) {
    const hidden = name.startsWith(".");
    if (hidden && !showHidden) continue;
    const full = path.join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    entries.push({ name, path: full, isGitRepo: existsSync(path.join(full, ".git")), hasPackageJson: existsSync(path.join(full, "package.json")), hidden });
    if (entries.length >= MAX_ENTRIES) break;
  }
  const parent = dir === home ? null : path.dirname(dir);
  const shortcuts = [
    { label: "Home", path: home },
    ...["Developer", "Projects", "code", "Code", "src", "Documents", "Desktop"].map((n) => ({ label: n, path: path.join(home, n) })),
    ...extraShortcuts,
  ].filter((s, i, all) => existsSync(s.path) && all.findIndex((o) => o.path === s.path) === i);
  return { path: dir, parent, home, isGitRepo: existsSync(path.join(dir, ".git")), entries, truncated: entries.length >= MAX_ENTRIES, shortcuts };
}

export function makeFolder(parentInput: string, name: string): string {
  const parent = resolveDir(parentInput);
  const clean = (name ?? "").trim();
  if (!clean || clean === "." || clean === ".." || clean.length > 100 || /[/\\:*?"<>|\0]/.test(clean)) throw new FsError("Use a folder name without / \\ : * ? \" < > |", 400);
  const target = path.join(parent, clean);
  if (existsSync(target)) throw new FsError("A file or folder with that name already exists", 409);
  mkdirSync(target);
  return target;
}
