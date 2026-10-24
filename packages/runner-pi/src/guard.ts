import path from "node:path";
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";

const FILE_TOOLS = new Set(["read", "write", "edit"]);

const BLOCKED_COMMANDS: Array<[RegExp, string]> = [
  [/(^|[\s;&|(])git\s+push\b/, "Nightshift pushes for you after the work is done; do not push."],
  [/(^|[\s;&|(])gh\s+(pr|api|release|repo)\b/, "Nightshift manages pull requests; do not use gh. To comment on the pull request, use propose_pr_comment (the owner approves it first)."],
  [/(^|[\s;&|(])sudo\b/, "sudo is not allowed."],
  [/(^|[\s;&|(])git\s+(checkout|switch)\s+(-b\s+)?(main|master)\b/, "Stay on the task branch."],
  [/\.env\.(dev|prod|production|staging)\b/, "Shared or production env files are off limits."],
];

export function insideRoot(root: string, target: string): boolean {
  const resolved = path.resolve(root, target);
  const rel = path.relative(root, resolved);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function protectedHit(root: string, files: string[], target: string): string | null {
  const resolved = path.resolve(root, target);
  return files.find((f) => path.resolve(root, f) === resolved) ?? null;
}

export function protectedInCommand(files: string[], command: string): string | null {
  for (const f of files) {
    const base = path.posix.basename(f);
    const pattern = new RegExp(`(^|[\\s'"=/<>(|;&])(${escape(f)}|${escape(base)})($|[\\s'";|&)>])`);
    if (pattern.test(command)) return f;
  }
  return null;
}

const PROTECTED_MESSAGE = (f: string) =>
  `${f} is a local file with the owner's secrets; the owner has not allowed you to read or change it. Its values are already active for the app. If you need a new or changed variable, add it to the matching .env.example and tell the owner.`;

/** Hidden files, env and key files, credentials and dependencies are never read from a reference folder. */
const REFERENCE_SECRET = /^\.|^\.?env(\..*)?$|\.(pem|key|p12|pfx|keystore|jks)$|^id_(rsa|dsa|ecdsa|ed25519)|credential|secret|\.npmrc$|\.netrc$/i;

/** The reference folder (read-only) a path falls in, or null; "blocked" for its hidden or secret files. */
export function referenceHit(roots: string[], cwd: string, target: string): string | null | "blocked" {
  const resolved = path.resolve(cwd, target);
  for (const root of roots) {
    if (!insideRoot(root, resolved)) continue;
    const rel = path.relative(root, resolved);
    return rel.split(path.sep).some((part) => part === "node_modules" || part === ".git" || REFERENCE_SECRET.test(part)) ? "blocked" : root;
  }
  return null;
}

export function createGuardExtension(
  cwdFor: (conversationId: string) => string | undefined,
  protectedFor: (conversationId: string) => string[] = () => [],
  referencesFor: (conversationId: string) => string[] = () => [],
) {
  return defineExtension({
    name: "nightshift-guard",
    hooks: [
      hook(ToolTask, {
        beforeTool: (call: { name: string; arguments?: Record<string, unknown> }, api: { conversationId: string }) => {
          const args = call.arguments ?? {};
          const root = cwdFor(String(api.conversationId));
          if (FILE_TOOLS.has(call.name)) {
            const target = typeof args.path === "string" ? args.path : undefined;
            if (!root) return { block: "No workspace for this conversation." };
            if (target && !insideRoot(root, target)) {
              // Reference folders are read-only: reading is allowed, changing never.
              const ref = referenceHit(referencesFor(String(api.conversationId)), root, target);
              if (ref === "blocked") return { block: "Hidden, secret and dependency files of a reference folder are off limits." };
              if (ref && call.name === "read") return undefined;
              if (ref) return { block: `${ref} is a read-only reference folder: you may read it but never change it. Make your changes in the task workspace (${root}).` };
              return { block: `Only paths inside the task workspace (${root}) are allowed, and reading inside the project's reference folders.` };
            }
            const hit = target ? protectedHit(root, protectedFor(String(api.conversationId)), target) : null;
            if (hit) return { block: PROTECTED_MESSAGE(hit) };
          }
          if (call.name === "bash" && typeof args.command === "string") {
            for (const [pattern, reason] of BLOCKED_COMMANDS) if (pattern.test(args.command)) return { block: reason };
            const hit = protectedInCommand(protectedFor(String(api.conversationId)), args.command);
            if (hit) return { block: PROTECTED_MESSAGE(hit) };
          }
          return undefined;
        },
      } as never),
    ],
  });
}
