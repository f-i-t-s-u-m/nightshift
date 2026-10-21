import type { PrComment } from "@nightshift/git";

/**
 * Review bots repeat findings that are already fixed: Greptile answered a retest with "the finding still applies" on a
 * migration that was fixed, and only a second retest said so. A finding is identified across repeats by its file and
 * its title, and a reply in a thread counts as its thread's finding, so a stale repeat can be recognised (D39).
 */

/** The first comment of the thread `comment` is in. */
function rootOf(comment: PrComment, all: PrComment[]) {
  let root = comment;
  for (let hops = 0; root.replyTo && hops < 20; hops++) {
    const parent = all.find((c) => c.id === root.replyTo);
    if (!parent) break;
    root = parent;
  }
  return root;
}

/**
 * The finding's title: its first bold phrase of two words or more (a lone bold word is usually the tool's name, like
 * "**Umbra**"), else the start of the comment, whose first line alone can be a label like "Umbra · minor · verified".
 */
export function findingTitle(body: string) {
  const bold = [...body.matchAll(/\*\*([^*\n]+)\*\*/g)].map((m) => m[1].trim()).find((t) => t.split(/\s+/).length >= 2);
  return (bold ?? body)
    .replace(/<[^>]*>/g, " ")
    .replace(/[`*_#>[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/** Identifies an inline finding across repeats, by its thread's first comment; null for comments that are not about a file. */
export function finding(comment: PrComment, all: PrComment[]): { key: string; title: string } | null {
  const root = rootOf(comment, all);
  if (!root.path) return null;
  const title = findingTitle(root.body);
  return { key: `${root.path}|${title.toLowerCase()}`, title };
}

/** Hidden marker on every comment Nightshift posts on a PR, so the PR watcher never takes its own comments as feedback. */
export const nightshiftMark = (key: string) => `<!-- nightshift:${key} -->`;

export const isNightshiftComment = (body: string) => body.includes("<!-- nightshift:");

/** A command for a bot or CI, like "@greptile-apps retest" or "/retest": one short line starting with @ or /. */
export function isCommand(body: string) {
  const text = body.replace(/<!--[\s\S]*?-->/g, "").trim();
  return /^[@/][\w-]/.test(text) && !text.includes("\n") && text.length <= 100 && text.split(/\s+/).length <= 6;
}

/** An inline thread's id, or "pr" for the PR's main conversation. */
function threadOf(comment: PrComment, all: PrComment[]) {
  const root = rootOf(comment, all);
  return root.path ? root.id : "pr";
}

/**
 * An answer to a command (a bot's "Retested: …" after "@greptile-apps retest"): the comment just before it in the same
 * inline thread is a command, or, on the PR's main thread, a command that mentions its author.
 */
export function answersCommand(comment: PrComment, all: PrComment[]) {
  const thread = threadOf(comment, all);
  const before = all.filter((c) => c.id !== comment.id && c.createdAt <= comment.createdAt && threadOf(c, all) === thread).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  if (!before || !isCommand(before.body)) return false;
  if (thread !== "pr") return true;
  const login = comment.author.replace(/\[bot\]$/, "").toLowerCase();
  return Boolean(login) && before.body.toLowerCase().includes(`@${login}`);
}
