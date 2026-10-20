import { useState, type FormEvent, type ReactNode } from "react";
import { ArrowUpRight, Check, CircleAlert, GitBranch, GitPullRequest, Laptop, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import type { GithubRepoInput, MoveToGithubResult, ProjectSummary } from "@nightshift/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { api, messageOf } from "../api";
import { GithubMark, GithubRepoFields, GithubSetupNotice, GithubStatusSkeleton, RepoPreview, SignedInAs, githubReady, repoNameError, repoSlug, useGithubStatus } from "./github";
import { Notice } from "./Notice";
import { Spinner } from "./TaskBits";

const BACKUP_REMOTE = "nightshift-local";

const STEPS: Array<{ key: string; text: ReactNode }> = [
  { key: "create", text: "Creates the repository on GitHub." },
  { key: "copy", text: "Copies every branch and tag to it." },
  { key: "origin", text: <>Points the <code className="font-mono text-xs">origin</code> remote at GitHub.</> },
  { key: "backup", text: <>Keeps the current copy as the remote <code className="font-mono text-xs">{BACKUP_REMOTE}</code>.</> },
  { key: "host", text: "Switches the project to GitHub pull requests." },
  { key: "prs", text: "Opens GitHub pull requests for tasks that have open local ones." },
];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : /(s|sh|ch|x)$/.test(word) ? "es" : "s"}`;

function MoveResult({ result }: { result: MoveToGithubResult }) {
  const prs = result.pullRequests;
  const failed = prs.filter((p) => !p.url).length;
  return (
    <div className="grid gap-4">
      <a
        href={result.repoUrl}
        target="_blank"
        rel="noreferrer"
        className="group flex min-w-0 items-center gap-3 rounded-lg border bg-muted/30 p-3 transition-colors hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-foreground text-background">
          <GithubMark className="size-4.5" />
        </span>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="truncate font-medium">{result.repoUrl.replace(/^https?:\/\//, "")}</span>
          <span className="truncate font-mono text-xs text-muted-foreground" title={result.remoteUrl}>
            origin: {result.remoteUrl}
          </span>
        </span>
        <ArrowUpRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" aria-hidden="true" />
        <span className="sr-only">(opens in a new tab)</span>
      </a>

      <div className="grid gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-medium">
          <GitBranch className="size-4 text-muted-foreground" aria-hidden="true" /> {plural(result.branches.length, "branch")} copied
        </h3>
        {result.branches.length ? (
          <ul className="flex flex-wrap gap-1" aria-label="Branches">
            {result.branches.slice(0, 12).map((b) => (
              <li key={b}>
                <Badge variant="secondary" className="font-mono font-normal">
                  {b}
                </Badge>
              </li>
            ))}
            {result.branches.length > 12 ? (
              <li>
                <Badge variant="outline" className="font-normal">
                  +{result.branches.length - 12} more
                </Badge>
              </li>
            ) : null}
          </ul>
        ) : null}
      </div>

      <div className="grid gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-medium">
          <GitPullRequest className="size-4 text-muted-foreground" aria-hidden="true" />
          {prs.length ? `${plural(prs.length - failed, "pull request")} opened on GitHub` : "Pull requests"}
        </h3>
        {prs.length ? (
          <ul className="divide-y rounded-lg border">
            {prs.map((p) => (
              <li key={`${p.taskId}-${p.branch}`} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <span className="font-medium">{p.taskId}</span>
                <code className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={p.branch}>
                  {p.branch}
                </code>
                {p.url ? (
                  <a href={p.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline">
                    View pull request <ArrowUpRight className="size-3.5" aria-hidden="true" />
                    <span className="sr-only">for {p.taskId} (opens in a new tab)</span>
                  </a>
                ) : (
                  <span className="flex w-full items-start gap-1.5 text-xs text-destructive">
                    <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
                    <span className="grid gap-0.5">
                      <span>{p.error ? `Not opened: ${p.error.replace(/\.?$/, ".")}` : "Not opened."}</span>
                      <span className="text-muted-foreground">The branch is on GitHub, so you can open the pull request there.</span>
                    </span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No tasks had open local pull requests.</p>
        )}
      </div>

      <Notice title="Nothing was deleted">
        The copy on this Mac is still there as the git remote <code className="font-mono text-xs whitespace-nowrap">{result.backupRemote}</code>. Remove it with{" "}
        <code className="font-mono text-xs">git remote remove {result.backupRemote}</code> once you are happy with GitHub.
      </Notice>
    </div>
  );
}

function MoveToGithubDialog({
  project,
  open,
  onOpenChange,
  onMoved,
}: {
  project: ProjectSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMoved: (result: MoveToGithubResult) => void;
}) {
  const gh = useGithubStatus(open);
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState<Omit<GithubRepoInput, "owner">>(() => ({ name: repoSlug(project.name) || repoSlug(project.id), visibility: "private", description: "" }));
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MoveToGithubResult | null>(null);

  const status = gh.status;
  const ready = githubReady(status);
  const input: GithubRepoInput = { ...repo, owner: owner || status?.login || "" };
  const valid = ready && Boolean(input.owner) && !repoNameError(input.name);
  const canMove = valid && confirmed && !busy;

  const close = (next: boolean) => {
    if (busy) return;
    onOpenChange(next);
    if (!next && result) {
      setResult(null);
      setConfirmed(false);
      setError(null);
    }
  };

  const move = async (e: FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!canMove) return;
    setBusy(true);
    setError(null);
    try {
      const description = input.description?.trim();
      const res = await api.moveToGithub(project.id, { owner: input.owner, name: input.name, visibility: input.visibility, ...(description ? { description } : {}) });
      setResult(res);
      toast.success(`${project.name} moved to GitHub`);
      onMoved(res);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        showCloseButton={!busy}
        onEscapeKeyDown={(e) => busy && e.preventDefault()}
        onInteractOutside={(e) => busy && e.preventDefault()}
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
      >
        {result ? (
          <>
            <DialogHeader className="border-b px-5 pt-5 pb-4">
              <DialogTitle className="flex items-center gap-2">
                <span className="flex size-6 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                  <Check className="size-3.5" />
                </span>
                Moved to GitHub
              </DialogTitle>
              <DialogDescription>New tasks branch from GitHub and open their pull requests there.</DialogDescription>
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <MoveResult result={result} />
            </div>
            <DialogFooter className="m-0 border-t bg-muted/30 px-5 py-3">
              <Button type="button" variant="outline" asChild>
                <a href={result.repoUrl} target="_blank" rel="noreferrer">
                  <GithubMark /> Open on GitHub
                </a>
              </Button>
              <Button type="button" onClick={() => close(false)} autoFocus>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={(e) => void move(e)} noValidate className="flex min-h-0 flex-1 flex-col" aria-busy={busy}>
            <DialogHeader className="border-b px-5 pt-5 pb-4">
              <DialogTitle className="flex items-center gap-2">
                <GithubMark /> Move to GitHub
              </DialogTitle>
              <DialogDescription>
                Uploads {project.name} to a new GitHub repository. Agents then push branches and open pull requests there.
              </DialogDescription>
            </DialogHeader>
            <div className="grid min-h-0 flex-1 gap-5 overflow-y-auto px-5 py-4">
              {gh.loading && !status ? (
                <GithubStatusSkeleton />
              ) : !ready ? (
                <GithubSetupNotice status={status} error={gh.error} loading={gh.loading} onRetry={() => void gh.reload()} />
              ) : status ? (
                <>
                  <SignedInAs login={status.login ?? ""} />
                  <GithubRepoFields
                    prefix="mv-gh"
                    status={status}
                    value={input}
                    onChange={(next) => {
                      setOwner(next.owner);
                      setRepo({ name: next.name, visibility: next.visibility, description: next.description });
                    }}
                    withDescription
                    disabled={busy}
                  />
                  <RepoPreview owner={input.owner} name={input.name} visibility={input.visibility}>
                    and uploads this project&rsquo;s git history.
                  </RepoPreview>
                </>
              ) : null}

              <section className="grid gap-2" aria-labelledby="mv-gh-steps">
                <h3 id="mv-gh-steps" className="text-sm font-medium">
                  What happens
                </h3>
                <ol className="grid gap-1.5 text-sm">
                  {STEPS.map((s, i) => (
                    <li key={s.key} className="flex items-start gap-2.5">
                      <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-[0.6875rem] text-muted-foreground tabular-nums">
                        {i + 1}
                      </span>
                      <span>{s.text}</span>
                    </li>
                  ))}
                </ol>
                <p className="flex items-start gap-2.5 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-200">
                  <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  Nothing is deleted. Your local repository and its history stay exactly where they are.
                </p>
              </section>

              {ready ? (
                <Label
                  htmlFor="mv-gh-confirm"
                  className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal has-disabled:cursor-not-allowed has-data-[state=checked]:border-primary has-data-[state=checked]:bg-muted/40"
                >
                  <Checkbox id="mv-gh-confirm" checked={confirmed} onCheckedChange={(v) => setConfirmed(v === true)} disabled={busy} className="mt-0.5" />
                  <span className="grid gap-1">
                    <span className="font-medium">I understand this uploads the code to GitHub</span>
                    <span className="text-xs text-muted-foreground">
                      {input.visibility === "public" ? "The repository is public: anyone can read the code and its full history." : "Everyone with access to the repository can read the code and its full history."}
                    </span>
                  </span>
                </Label>
              ) : null}

            </div>
            {busy || error ? (
              <div className="border-t px-5 py-3">
                {busy ? (
                  <div className="flex items-center gap-2 text-sm" role="status">
                    <Spinner className="shrink-0" />
                    Creating the repository and copying branches. This can take a minute; keep this window open.
                  </div>
                ) : (
                  <Notice tone="danger" title="Could not move the project">
                    {error}
                  </Notice>
                )}
              </div>
            ) : null}
            <DialogFooter className="m-0 border-t bg-muted/30 px-5 py-3">
              <Button type="button" variant="outline" onClick={() => close(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={!canMove}>
                {busy ? <Spinner className="size-3.5 text-primary-foreground" /> : <GithubMark />}
                {busy ? "Moving…" : "Move to GitHub"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

const AUTHOR_SOURCE: Record<string, string> = {
  git: "from this repository's git config",
  github: "from your GitHub account",
  config: "from Nightshift's config file",
  default: "no git identity found: set git config user.name and user.email",
};

function CommitAuthorLine({ project }: { project: ProjectSummary }) {
  const a = project.commitAuthor;
  if (!a) return null;
  return (
    <p className="mt-2 text-xs text-muted-foreground">
      Commits are made as <span className="font-medium text-foreground">{a.name}</span> <span className="font-mono">&lt;{a.email}&gt;</span>
      <span className={a.source === "default" ? "text-amber-700 dark:text-amber-300" : undefined}> · {AUTHOR_SOURCE[a.source] ?? a.source}</span>
    </p>
  );
}

export function ProjectGithubCard({ project, onMoved }: { project: ProjectSummary; onMoved: () => void }) {
  const [open, setOpen] = useState(false);
  const local = project.gitHost === "local";
  return (
    <>
      {local ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <GithubMark className="text-muted-foreground" /> GitHub
            </CardTitle>
            <CardDescription>This project&rsquo;s code is only on this Mac. Pull requests are tracked inside Nightshift, and there is no CI or off-site backup.</CardDescription>
            <CardAction>
              <Button type="button" variant="outline" onClick={() => setOpen(true)}>
                Move to GitHub…
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            <p className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <Laptop className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate font-mono" title={project.repo.path}>
                {project.repo.path}
              </span>
              <span aria-hidden="true">·</span>
              <span className="shrink-0">
                remote <code className="font-mono">{project.repo.remote}</code>
              </span>
            </p>
            <CommitAuthorLine project={project} />
          </CardContent>
        </Card>
      ) : (
        <div className="rounded-xl border px-4 py-3 text-sm text-muted-foreground">
          <div className="flex min-w-0 items-center gap-2">
            <GithubMark className="text-foreground" />
            <span className="min-w-0 flex-1">Code and pull requests live on GitHub.</span>
            <span className="shrink-0 text-xs">
              remote <code className="font-mono">{project.repo.remote}</code>
            </span>
          </div>
          <CommitAuthorLine project={project} />
        </div>
      )}
      <MoveToGithubDialog project={project} open={open} onOpenChange={setOpen} onMoved={() => onMoved()} />
    </>
  );
}
