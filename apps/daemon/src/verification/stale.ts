import type { PrComment } from "@nightshift/git";

/**
 * Review bots repeat findings that are already fixed: Greptile answered a retest with "the finding still applies" on a
 * migration that was fixed, and only a second retest said so. A finding is identified across repeats by its file and
 * its title, and a reply in a thread counts as its thread's finding, so a stale repeat can be recognised (D39).
 */

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
  let root = comment;
  for (let hops = 0; root.replyTo && hops < 20; hops++) {
    const parent = all.find((c) => c.id === root.replyTo);
    if (!parent) break;
    root = parent;
  }
  if (!root.path) return null;
  const title = findingTitle(root.body);
  return { key: `${root.path}|${title.toLowerCase()}`, title };
}
