import { useCallback, useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Check, Copy, Globe, Lock, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import type { GithubRepoInput, GithubStatus, GithubVisibility } from "@nightshift/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { api, messageOf } from "../api";
import { Notice } from "./Notice";
import { Field } from "./ProjectForm";
import { Spinner } from "./TaskBits";

export function GithubMark({ className, ...props }: ComponentProps<"svg">) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={cn("size-4 shrink-0", className)} {...props}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export const repoSlug = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 100);

export const repoNameError = (name: string): string | null => {
  if (!name) return "Enter a repository name.";
  if (name.length > 100) return "Use 100 characters or fewer.";
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return "Use only letters, numbers, dots, dashes and underscores.";
  if (name === "." || name === "..") return "Choose a different name.";
  return null;
};

export const githubReady = (s: GithubStatus | null) => Boolean(s?.installed && s.loggedIn && s.login);

export const repoPath = (owner: string, name: string) => `github.com/${owner || "…"}/${name || "…"}`;

export function useGithubStatus(enabled: boolean) {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await api.github());
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const started = useRef(false);
  useEffect(() => {
    if (!enabled || started.current) return;
    started.current = true;
    void load();
  }, [enabled, load]);

  return { status, error, loading: loading || (enabled && !status && !error), reload: load };
}

function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy. Select the command and copy it yourself.");
    }
  };
  return (
    <div className="flex min-w-0 items-center gap-1 rounded-md border bg-background/60 py-0.5 pr-0.5 pl-2.5 text-foreground">
      <span className="font-mono text-xs text-muted-foreground select-none" aria-hidden="true">
        $
      </span>
      <code className="min-w-0 flex-1 truncate font-mono text-xs">{command}</code>
      <Button type="button" variant="ghost" size="icon-xs" onClick={() => void copy()} aria-label={copied ? "Copied" : `Copy ${command}`}>
        {copied ? <Check className="text-emerald-600 dark:text-emerald-400" /> : <Copy />}
      </Button>
    </div>
  );
}

export function GithubSetupNotice({
  status,
  error,
  loading,
  onRetry,
}: {
  status: GithubStatus | null;
  error: string | null;
  loading: boolean;
  onRetry: () => void;
}) {
  const retry = (
    <Button type="button" variant="outline" size="sm" onClick={onRetry} disabled={loading}>
      {loading ? <Spinner className="size-3.5" /> : <RefreshCw />} Check again
    </Button>
  );
  if (error) {
    return (
      <Notice tone="danger" title="Could not check GitHub" action={retry}>
        {error}
      </Notice>
    );
  }
  if (!status || githubReady(status)) return null;
  const installed = status.installed;
  const steps = installed ? ["gh auth login"] : ["brew install gh", "gh auth login"];
  if (status.protocol === "https") steps.push("gh auth setup-git");
  return (
    <Notice tone="warning" title={installed ? "Sign in to GitHub first" : "Install the GitHub CLI first"} action={retry}>
      <div className="grid gap-2.5">
        <div>
          {installed
            ? "Nightshift creates repositories and pull requests with the GitHub CLI (gh), and it is not signed in on this Mac. Run this in a terminal, then check again."
            : "Nightshift creates repositories and pull requests with the GitHub CLI (gh), which is not installed on this Mac. Run these in a terminal, then check again."}
        </div>
        <div className="grid max-w-md gap-1.5">
          {steps.map((c) => (
            <CommandLine key={c} command={c} />
          ))}
        </div>
        {status.protocol === "https" ? (
          <div className="text-xs">
            <code className="font-mono">gh auth setup-git</code> lets git push over https with your GitHub sign-in.
          </div>
        ) : null}
        {status.message ? <div className="text-xs opacity-80">GitHub CLI said: {status.message}</div> : null}
      </div>
    </Notice>
  );
}

export function GithubStatusSkeleton() {
  return (
    <div className="grid gap-3" aria-busy="true">
      <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Spinner /> Checking the GitHub CLI…
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Skeleton className="h-14" />
        <Skeleton className="h-14" />
      </div>
      <Skeleton className="h-16" />
    </div>
  );
}

export function SignedInAs({ login }: { login: string }) {
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <GithubMark className="size-3.5" /> Signed in to GitHub as <span className="font-medium text-foreground">@{login}</span>
    </p>
  );
}

const VISIBILITY: Array<{ value: GithubVisibility; label: string; hint: string; icon: ReactNode }> = [
  { value: "private", label: "Private", hint: "Only you and the people you add can see the code.", icon: <Lock /> },
  { value: "public", label: "Public", hint: "Anyone on the internet can see the code.", icon: <Globe /> },
];

export function GithubRepoFields({
  prefix,
  status,
  value,
  onChange,
  withDescription,
  disabled,
}: {
  prefix: string;
  status: GithubStatus;
  value: GithubRepoInput;
  onChange: (next: GithubRepoInput) => void;
  withDescription?: boolean;
  disabled?: boolean;
}) {
  const uid = useId();
  const id = (k: string) => `${prefix}-${k}`;
  const nameError = repoNameError(value.name);
  const owners = status.login ? [status.login] : [];
  const orgs = status.orgs.filter((o) => o !== status.login);
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Field id={id("owner")} label="Owner" className="content-start">
          <Select value={value.owner} onValueChange={(owner) => onChange({ ...value, owner })} disabled={disabled}>
            <SelectTrigger id={id("owner")} className="w-full">
              <SelectValue placeholder="Choose an owner" />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectGroup>
                <SelectLabel>Your account</SelectLabel>
                {owners.map((o) => (
                  <SelectItem key={o} value={o}>
                    <GithubMark className="text-muted-foreground" />
                    {o}
                  </SelectItem>
                ))}
              </SelectGroup>
              {orgs.length ? (
                <SelectGroup>
                  <SelectLabel>Organizations</SelectLabel>
                  {orgs.map((o) => (
                    <SelectItem key={o} value={o}>
                      {o}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ) : null}
            </SelectContent>
          </Select>
        </Field>
        <Field id={id("name")} label="Repository name" className="content-start" error={Boolean(nameError)} hint={nameError ?? "Letters, numbers, dots, dashes and underscores."}>
          <Input
            id={id("name")}
            className="font-mono"
            value={value.name}
            onChange={(e) => onChange({ ...value, name: e.target.value })}
            aria-invalid={Boolean(nameError)}
            aria-describedby={`${id("name")}-hint`}
            maxLength={120}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            disabled={disabled}
          />
        </Field>
      </div>
      <div className="grid gap-2">
        <span id={`${uid}-vis`} className="text-sm leading-none font-medium">
          Visibility
        </span>
        <RadioGroup
          value={value.visibility}
          onValueChange={(v) => onChange({ ...value, visibility: v as GithubVisibility })}
          aria-labelledby={`${uid}-vis`}
          className="grid gap-2 sm:grid-cols-2"
          disabled={disabled}
        >
          {VISIBILITY.map((v) => (
            <Label
              key={v.value}
              htmlFor={`${uid}-vis-${v.value}`}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal transition-colors hover:bg-muted/50 has-disabled:cursor-not-allowed has-disabled:opacity-60",
                value.visibility === v.value && "border-primary bg-muted/40",
              )}
            >
              <RadioGroupItem value={v.value} id={`${uid}-vis-${v.value}`} className="mt-0.5" />
              <span className="grid min-w-0 gap-1">
                <span className="flex items-center gap-1.5 font-medium [&_svg]:size-3.5 [&_svg]:text-muted-foreground">
                  {v.icon}
                  {v.label}
                </span>
                <span className="text-xs leading-snug text-muted-foreground">{v.hint}</span>
              </span>
            </Label>
          ))}
        </RadioGroup>
      </div>
      {withDescription ? (
        <Field id={id("desc")} label="Description" optional hint="Shown on the repository page on GitHub.">
          <Input
            id={id("desc")}
            value={value.description ?? ""}
            onChange={(e) => onChange({ ...value, description: e.target.value })}
            aria-describedby={`${id("desc")}-hint`}
            maxLength={350}
            disabled={disabled}
          />
        </Field>
      ) : null}
    </div>
  );
}

export function RepoPreview({ owner, name, visibility, children }: { owner: string; name: string; visibility: GithubVisibility; children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-lg border border-dashed bg-muted/30 px-3 py-2.5 text-sm" aria-live="polite">
      <GithubMark className="mt-0.5 text-muted-foreground" />
      <span className="min-w-0">
        Creates <span className="font-mono text-xs break-all text-foreground">{repoPath(owner, name)}</span> ({visibility}) {children}
      </span>
    </p>
  );
}
