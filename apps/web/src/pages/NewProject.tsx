import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { BookOpen, Check, ChevronRight, Database, FolderInput, FolderSearch, GitBranch, Laptop, Package, Sparkles, Terminal, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { PROJECT_KINDS, STARTERS, type GithubVisibility, type ProjectInspection, type ProjectKind, type ProjectSummary, type Starter } from "@nightshift/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { api, messageOf } from "../api";
import { FolderPicker } from "../components/FolderPicker";
import { GithubMark, GithubRepoFields, GithubSetupNotice, GithubStatusSkeleton, RepoPreview, SignedInAs, githubReady, repoNameError, repoSlug, useGithubStatus } from "../components/github";
import { Notice } from "../components/Notice";
import {
  BriefField,
  Field,
  PlanModeField,
  ProjectFormSections,
  SwitchRow,
  formFromInspection,
  formToInput,
  formValid,
  type PlanMode,
  type ProjectForm,
} from "../components/ProjectForm";
import { KindIcon, kindDef } from "../components/projectKinds";
import { Page, PageHeader, Spinner } from "../components/TaskBits";
import { navigate, projectHref, projectSettingsHref, taskHref } from "../routing";
import { useLive } from "../live";

const isGitUrl = (v: string) => /^(https?:\/\/|ssh:\/\/|git@)/.test(v.trim()) || /\.git$/.test(v.trim());

const PM_LABEL: Record<string, string> = { bun: "Bun", pnpm: "pnpm", yarn: "Yarn", npm: "npm", pip: "pip", poetry: "Poetry", uv: "uv", go: "Go modules", cargo: "Cargo" };

function Fact({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <span className="mt-0.5 text-muted-foreground [&_svg]:size-4">{icon}</span>
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd className="text-sm">{children}</dd>
      </div>
    </div>
  );
}

function Chips({ items, empty = "None detected" }: { items: string[]; empty?: string }) {
  if (items.length === 0) return <span className="text-muted-foreground">{empty}</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {items.map((x) => (
        <Badge key={x} variant="secondary">
          {x}
        </Badge>
      ))}
    </span>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const monorepoLabel = (i: ProjectInspection) => {
  if (!i.monorepo) return "";
  const apps = i.suggested.preview?.services?.length ?? 0;
  return `Monorepo (${i.monorepo.tool} · ${apps ? plural(apps, "app") : plural(i.monorepo.packages.length, "package")})`;
};

function InspectionView({ inspection: i }: { inspection: ProjectInspection }) {
  const [scriptsOpen, setScriptsOpen] = useState(false);
  const appServices = i.suggested.preview?.services ?? [];
  const scripts = Object.entries(i.scripts);
  const kind = kindDef(i.kind);
  return (
    <Card>
      <CardHeader>
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <KindIcon kind={i.kind} className="size-5" />
          </span>
          <div className="min-w-0">
            <CardTitle className="truncate">{i.name}</CardTitle>
            <CardDescription className="truncate">
              Looks like a <span className="font-medium text-foreground">{kind.label.toLowerCase()}</span> · <span className="font-mono text-xs">{i.path}</span>
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid gap-5">
        {i.notes.map((n, idx) => (
          <Notice key={idx} tone="warning">
            {n}
          </Notice>
        ))}
        {i.git.dirty && !i.notes.some((n) => /uncommitted/i.test(n)) ? (
          <Notice tone="warning" title="Uncommitted changes">
            The repository has uncommitted changes. Agents branch from the last commit, so they will not see them.
          </Notice>
        ) : null}
        <dl className="grid gap-4 sm:grid-cols-2">
          <Fact icon={<Terminal />} label="Languages">
            <Chips items={i.languages} />
          </Fact>
          <Fact icon={<Sparkles />} label="Frameworks">
            <Chips items={i.frameworks} />
          </Fact>
          <Fact icon={<Package />} label="Package manager">
            {i.packageManager ? (PM_LABEL[i.packageManager] ?? i.packageManager) : <span className="text-muted-foreground">None detected</span>}
          </Fact>
          <Fact icon={<Database />} label="Database">
            {i.database.detected || i.database.orm ? [i.database.detected, i.database.orm].filter(Boolean).join(" · ") : <span className="text-muted-foreground">None detected</span>}
          </Fact>
          <Fact icon={<GitBranch />} label="Git">
            {i.git.isRepo ? (
              <span className="grid min-w-0 gap-0.5">
                <span>
                  {i.git.github ? "GitHub" : i.git.remoteUrl ? "Remote" : "Local only"}
                  {i.git.defaultBranch ? (
                    <>
                      {" "}
                      · default branch <code className="font-mono text-xs">{i.git.defaultBranch}</code>
                    </>
                  ) : null}
                </span>
                {i.git.remoteUrl ? (
                  <span className="truncate font-mono text-xs text-muted-foreground" title={i.git.remoteUrl}>
                    {i.git.remote ?? "remote"}: {i.git.remoteUrl}
                  </span>
                ) : null}
              </span>
            ) : (
              <span className="text-amber-700 dark:text-amber-300">Not a git repository</span>
            )}
          </Fact>
          {i.monorepo ? (
            <Fact icon={<FolderInput />} label={monorepoLabel(i)}>
              <span className="grid gap-2">
                {appServices.length ? (
                  <span className="grid gap-1">
                    {appServices.map((s) => (
                      <span key={s.name} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                        <span className="font-medium">{s.name}</span>
                        {s.cwd ? <code className="font-mono text-xs text-muted-foreground">{s.cwd}</code> : null}
                        {s.primary ? <span className="text-xs text-muted-foreground">main preview</span> : null}
                      </span>
                    ))}
                  </span>
                ) : null}
                <span className="flex flex-wrap gap-1">
                  {i.monorepo.packages.map((p) => (
                    <code key={p} className="rounded bg-muted px-1 font-mono text-xs">
                      {p}
                    </code>
                  ))}
                </span>
              </span>
            </Fact>
          ) : null}
        </dl>
        {scripts.length > 0 ? (
          <Collapsible open={scriptsOpen} onOpenChange={setScriptsOpen}>
            <CollapsibleTrigger className="flex items-center gap-1 text-sm font-medium hover:underline">
              <ChevronRight className={cn("size-4 transition-transform", scriptsOpen && "rotate-90")} />
              Scripts <span className="font-normal text-muted-foreground">({scripts.length})</span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <dl className="mt-2 grid gap-1 rounded-lg border bg-muted/30 p-3 font-mono text-xs">
                {scripts.map(([k, v]) => (
                  <div key={k} className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-3">
                    <dt className="font-semibold">{k}</dt>
                    <dd className="truncate text-muted-foreground" title={v}>
                      {v}
                    </dd>
                  </div>
                ))}
              </dl>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
        {i.docs.length > 0 ? (
          <div className="grid gap-2">
            <h3 className="flex items-center gap-1.5 text-sm font-medium">
              <BookOpen className="size-4 text-muted-foreground" /> Docs found
            </h3>
            <ul className="grid gap-2">
              {i.docs.map((d) => (
                <li key={d.path} className="rounded-lg border p-3">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-sm font-medium">{d.title}</span>
                    <code className="font-mono text-xs text-muted-foreground">{d.path}</code>
                  </div>
                  {d.excerpt ? <p className="mt-1 line-clamp-3 text-sm whitespace-pre-line text-muted-foreground">{d.excerpt}</p> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function CreatedPanel({ project }: { project: ProjectSummary }) {
  const [brief, setBrief] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.updateProject(project.id, { brief: brief.trim() });
      toast.success("Brief saved");
      navigate(projectHref(project.id));
    } catch (err) {
      setError(messageOf(err));
      setSaving(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Check className="size-5 text-emerald-600 dark:text-emerald-400" />
          {project.name} is ready
        </CardTitle>
        <CardDescription>
          Optionally add a project brief: what the project is, its stack and conventions. Every agent reads it before it starts. Nightshift can draft one from the
          repository.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <BriefField id="created-brief" projectId={project.id} value={brief} onChange={setBrief} disabled={saving} />
        {error ? (
          <Notice tone="danger" title="Could not save the brief">
            {error}
          </Notice>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button asChild variant="ghost">
            <a href={projectSettingsHref(project.id)}>Open settings</a>
          </Button>
          <Button asChild variant="outline">
            <a href={projectHref(project.id)}>Skip for now</a>
          </Button>
          <Button onClick={() => void save()} disabled={!brief.trim() || saving}>
            {saving ? "Saving…" : "Save brief and open project"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ImportPanel() {
  const { refreshProjects } = useLive();
  const [source, setSource] = useState("");
  const [analyzing, setAnalyzing] = useState<"path" | "git" | null>(null);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [inspection, setInspection] = useState<ProjectInspection | null>(null);
  const [form, setForm] = useState<ProjectForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<ProjectSummary | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const value = source.trim();
  const git = isGitUrl(value);
  const sourceOk = value !== "" && (git || value.startsWith("/"));

  const analyze = async (e: FormEvent) => {
    e.preventDefault();
    if (!sourceOk || analyzing) return;
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setAnalyzing(git ? "git" : "path");
    setAnalyzeError(null);
    setInspection(null);
    setForm(null);
    setError(null);
    try {
      const res = await api.inspect(git ? { gitUrl: value } : { path: value }, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setInspection(res.inspection);
      setForm(formFromInspection(res.inspection));
    } catch (err) {
      if (!ctrl.signal.aborted) setAnalyzeError(messageOf(err));
    } finally {
      if (!ctrl.signal.aborted) setAnalyzing(null);
    }
  };

  const cancel = () => {
    abort.current?.abort();
    setAnalyzing(null);
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!form || !formValid(form) || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.createProject(formToInput(form));
      await refreshProjects();
      toast.success("Project created");
      setCreated(res.project);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  if (created) return <CreatedPanel project={created} />;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Where is the project?</CardTitle>
          <CardDescription>A folder on this machine, or a git URL to clone. Nightshift reads it and suggests the settings.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-2 sm:flex-row sm:items-start" onSubmit={(e) => void analyze(e)} noValidate>
            <div className="grid flex-1 gap-2">
              <Label htmlFor="imp-source" className="sr-only">
                Folder path or git URL
              </Label>
              <Input
                id="imp-source"
                className="font-mono"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="/Users/you/code/repo or git@github.com:org/repo.git"
                aria-invalid={value !== "" && !sourceOk}
                aria-describedby="imp-source-hint"
                spellCheck={false}
                autoCapitalize="off"
                autoFocus
                disabled={analyzing !== null}
              />
              <p id="imp-source-hint" className={cn("text-xs text-muted-foreground", value !== "" && !sourceOk && "text-destructive")}>
                {value === ""
                  ? "Absolute folder path, or an https / ssh git URL"
                  : !sourceOk
                    ? "Use an absolute path that starts with /, or a git URL"
                    : git
                      ? "Git URL: Nightshift clones it into ~/.nightshift/repos first"
                      : "Local folder"}
              </p>
            </div>
            <Button type="button" variant="outline" disabled={analyzing !== null} onClick={() => setBrowsing(true)}>
              <FolderSearch /> Browse…
            </Button>
            {analyzing ? (
              <Button type="button" variant="outline" onClick={cancel}>
                Cancel
              </Button>
            ) : (
              <Button type="submit" disabled={!sourceOk}>
                <Wand2 /> Analyze
              </Button>
            )}
          </form>
          <FolderPicker
            open={browsing}
            onOpenChange={setBrowsing}
            title="Choose the project folder"
            description="Pick an existing repository on this Mac, or create a new folder for it."
            initialPath={source}
            selectLabel="Use this folder"
            onSelect={(picked) => setSource(picked)}
          />
        </CardContent>
      </Card>

      {analyzing ? (
        <Card aria-busy="true">
          <CardContent className="grid gap-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Spinner />
              {analyzing === "git" ? "Cloning the repository and reading it. Large repositories can take a minute…" : "Reading the project…"}
            </div>
            <div className="flex items-center gap-3">
              <Skeleton className="size-10 rounded-lg" />
              <div className="grid flex-1 gap-2">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {[0, 1, 2, 3].map((k) => (
                <Skeleton key={k} className="h-10" />
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {analyzeError ? (
        <Notice tone="danger" title="Could not analyze the project">
          {analyzeError}
        </Notice>
      ) : null}

      {inspection && form ? (
        <>
          <InspectionView inspection={inspection} />
          <div>
            <h2 className="text-lg font-semibold">Settings</h2>
            <p className="text-sm text-muted-foreground">Prefilled from the analysis. Change anything before creating the project; you can edit it later too.</p>
          </div>
          <form className="space-y-4" onSubmit={(e) => void create(e)} noValidate>
            <ProjectFormSections value={form} onChange={setForm} mode="create" prefix="imp" />
            {error ? (
              <Notice tone="danger" title="Could not create the project">
                {error}
              </Notice>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button asChild variant="outline">
                <a href="#/">Cancel</a>
              </Button>
              <Button type="submit" disabled={!formValid(form) || busy}>
                {busy ? "Creating…" : "Create project"}
              </Button>
            </div>
          </form>
        </>
      ) : null}
    </div>
  );
}

const startersFor = (kind: ProjectKind): Starter[] => {
  const own = STARTERS.filter((s) => s.kind === kind);
  const empty = STARTERS.filter((s) => s.id === "empty" && s.kind !== kind);
  return [...own, ...empty];
};

function StarterSummary({ starter }: { starter: Starter }) {
  const items: string[] = [];
  if (starter.preview) items.push("Preview");
  if (starter.checks.length) items.push(`Checks: ${starter.checks.map((c) => c.name).join(", ")}`);
  if (starter.database && starter.database.mode !== "none") items.push(starter.database.mode === "docker" ? "Docker Postgres" : "Postgres");
  return items.length ? (
    <span className="flex flex-wrap gap-1">
      {items.map((x) => (
        <Badge key={x} variant="secondary" className="font-normal">
          {x}
        </Badge>
      ))}
    </span>
  ) : (
    <span className="text-xs text-muted-foreground">No preview, checks or database</span>
  );
}

type CodeHost = "local" | "github";

const HOSTS: Array<{ value: CodeHost; label: string; hint: string; icon: ReactNode }> = [
  { value: "local", label: "This Mac only", hint: "A local git remote in ~/.nightshift. Pull requests are tracked inside Nightshift.", icon: <Laptop /> },
  { value: "github", label: "GitHub", hint: "A real repository. Pull requests and CI run on GitHub.", icon: <GithubMark /> },
];

function StartPanel() {
  const { refreshProjects } = useLive();
  const uid = useId();
  const [kind, setKind] = useState<ProjectKind>("web");
  const [starterId, setStarterId] = useState<string>(() => startersFor("web")[0]?.id ?? "empty");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [parentDir, setParentDir] = useState("");
  const [pickingParent, setPickingParent] = useState(false);
  const [planMode, setPlanMode] = useState<PlanMode>("off");
  const [review, setReview] = useState(true);
  const [host, setHost] = useState<CodeHost>("local");
  const [ghOwner, setGhOwner] = useState("");
  const [ghName, setGhName] = useState<string | null>(null);
  const [ghVisibility, setGhVisibility] = useState<GithubVisibility>("private");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gh = useGithubStatus(host === "github");

  const starters = startersFor(kind);
  const parent = parentDir.trim();
  const parentOk = parent === "" || parent.startsWith("/") || parent.startsWith("~");
  const onGithub = host === "github";
  const ghReady = githubReady(gh.status);
  const repo = {
    owner: ghOwner || gh.status?.login || "",
    name: ghName ?? repoSlug(name),
    visibility: ghVisibility,
  };
  const githubOk = !onGithub || (ghReady && Boolean(repo.owner) && !repoNameError(repo.name));
  const valid = Boolean(name.trim() && description.trim() && starters.some((s) => s.id === starterId) && parentOk && githubOk);

  const pickKind = (k: ProjectKind) => {
    setKind(k);
    setStarterId(startersFor(k)[0]?.id ?? "empty");
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.scaffold({
        name: name.trim(),
        kind,
        starterId,
        description: description.trim(),
        ...(parent ? { parentDir: parent } : {}),
        planMode,
        review,
        ...(onGithub ? { github: repo } : {}),
      });
      await refreshProjects();
      toast.success(onGithub ? "Project created on GitHub" : "Project created", { description: "An agent is setting it up." });
      navigate(taskHref(res.project.id, res.taskId));
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  };

  return (
    <form className="space-y-4" onSubmit={(e) => void submit(e)} noValidate>
      <Card>
        <CardHeader>
          <CardTitle>What kind of project?</CardTitle>
        </CardHeader>
        <CardContent>
          <RadioGroup value={kind} onValueChange={(v) => pickKind(v as ProjectKind)} aria-label="Project kind" className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            {PROJECT_KINDS.map((k) => (
              <Label
                key={k.kind}
                htmlFor={`${uid}-kind-${k.kind}`}
                className={cn(
                  "relative flex cursor-pointer flex-col items-start gap-2 rounded-lg border p-3 font-normal transition-colors hover:bg-muted/50 has-focus-visible:ring-3 has-focus-visible:ring-ring/50",
                  kind === k.kind && "border-primary bg-muted/40",
                )}
              >
                <RadioGroupItem value={k.kind} id={`${uid}-kind-${k.kind}`} className="sr-only" />
                <span className={cn("flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground", kind === k.kind && "bg-primary text-primary-foreground")}>
                  <KindIcon kind={k.kind} />
                </span>
                <span className="font-medium">{k.label}</span>
                <span className="text-xs leading-snug text-muted-foreground">{k.description}</span>
              </Label>
            ))}
          </RadioGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Starter</CardTitle>
          <CardDescription>The agent scaffolds this in a fresh repository; Nightshift sets up the preview, checks and database it lists.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <RadioGroup value={starterId} onValueChange={setStarterId} aria-label="Starter" className="grid gap-2">
            {starters.map((s) => (
              <Label
                key={s.id}
                htmlFor={`${uid}-st-${s.id}`}
                className={cn("flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal transition-colors hover:bg-muted/50", starterId === s.id && "border-primary bg-muted/40")}
              >
                <RadioGroupItem value={s.id} id={`${uid}-st-${s.id}`} className="mt-0.5" />
                <span className="grid min-w-0 gap-1.5">
                  <span className="font-medium">{s.label}</span>
                  <StarterSummary starter={s} />
                  {s.preview ? (
                    <code className="truncate font-mono text-xs text-muted-foreground" title={s.preview.command}>
                      {s.preview.command}
                    </code>
                  ) : null}
                </span>
              </Label>
            ))}
          </RadioGroup>
          {starters.every((s) => s.kind !== kind) ? (
            <p className="text-xs text-muted-foreground">No ready-made starter for this kind yet. The agent starts from an empty repository and follows your description.</p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Field id="st-name" label="Name">
            <Input id="st-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme shop" required />
          </Field>
          <Field id="st-desc" label="What should we build?" hint="This becomes the agent's first task. Describe the product, screens, data and anything it must use or avoid.">
            <Textarea
              id="st-desc"
              rows={6}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
              aria-describedby="st-desc-hint"
              placeholder="A small storefront with a product list, a cart and a checkout page. Use Stripe test mode for payments."
            />
          </Field>
          <Field
            id="st-parent"
            label="Parent folder"
            optional
            error={!parentOk}
            hint={!parentOk ? "Use an absolute path" : "The repository is created in a new folder inside this one. Defaults to ~/.nightshift/repos."}
          >
            <div className="flex gap-2">
              <Input
                id="st-parent"
                className="font-mono"
                value={parentDir}
                onChange={(e) => setParentDir(e.target.value)}
                placeholder="~/.nightshift/repos"
                aria-describedby="st-parent-hint"
                aria-invalid={!parentOk}
                spellCheck={false}
              />
              <Button type="button" variant="outline" onClick={() => setPickingParent(true)}>
                <FolderSearch /> Browse…
              </Button>
            </div>
            <FolderPicker
              open={pickingParent}
              onOpenChange={setPickingParent}
              title="Where should the new repository go?"
              description="Nightshift creates a new folder for the project inside the folder you pick. You can also create a folder here first."
              initialPath={parentDir}
              selectLabel="Create the project here"
              onSelect={(picked) => setParentDir(picked)}
            />
          </Field>
          <PlanModeField id="st-plan" value={planMode} onChange={setPlanMode} />
          <SwitchRow id="st-review" label="AI review before PR" hint="A reviewer model checks the diff before the agent pushes." checked={review} onChange={setReview} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Where the code lives</CardTitle>
          <CardDescription>You can move a project from this Mac to GitHub later in its settings.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <RadioGroup value={host} onValueChange={(v) => setHost(v as CodeHost)} aria-label="Where the code lives" className="grid gap-2 sm:grid-cols-2">
            {HOSTS.map((h) => (
              <Label
                key={h.value}
                htmlFor={`${uid}-host-${h.value}`}
                className={cn(
                  "relative flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal transition-colors hover:bg-muted/50 has-focus-visible:ring-3 has-focus-visible:ring-ring/50",
                  host === h.value && "border-primary bg-muted/40",
                )}
              >
                <RadioGroupItem value={h.value} id={`${uid}-host-${h.value}`} className="sr-only absolute!" />
                <span
                  className={cn(
                    "flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground [&_svg]:size-4",
                    host === h.value && "bg-primary text-primary-foreground",
                  )}
                >
                  {h.icon}
                </span>
                <span className="grid min-w-0 gap-1">
                  <span className="font-medium">{h.label}</span>
                  <span className="text-xs leading-snug text-muted-foreground">{h.hint}</span>
                </span>
              </Label>
            ))}
          </RadioGroup>
          {onGithub ? (
            gh.loading && !gh.status ? (
              <GithubStatusSkeleton />
            ) : !ghReady ? (
              <GithubSetupNotice status={gh.status} error={gh.error} loading={gh.loading} onRetry={() => void gh.reload()} />
            ) : gh.status ? (
              <div className="grid gap-4 border-t pt-4">
                <SignedInAs login={gh.status.login ?? ""} />
                <GithubRepoFields
                  prefix="st-gh"
                  status={gh.status}
                  value={repo}
                  onChange={(next) => {
                    setGhOwner(next.owner);
                    if (next.name !== repo.name) setGhName(next.name);
                    setGhVisibility(next.visibility);
                  }}
                  disabled={busy}
                />
                <RepoPreview owner={repo.owner} name={repo.name} visibility={repo.visibility}>
                  and pushes the starter.
                </RepoPreview>
              </div>
            ) : null
          ) : null}
        </CardContent>
      </Card>

      {error ? (
        <Notice tone="danger" title="Could not create the project">
          {error}
        </Notice>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {onGithub && !ghReady && !gh.loading ? <span className="mr-auto text-sm text-muted-foreground">Set up the GitHub CLI, or keep the code on this Mac.</span> : null}
        <Button asChild variant="outline">
          <a href="#/">Cancel</a>
        </Button>
        <Button type="submit" disabled={!valid || busy}>
          {busy ? <Spinner className="size-3.5 text-primary-foreground" /> : onGithub ? <GithubMark /> : null}
          {busy ? (onGithub ? "Creating the repository…" : "Creating…") : onGithub ? "Create project on GitHub" : "Create and start building"}
        </Button>
      </div>
    </form>
  );
}

export function NewProject() {
  return (
    <Page narrow>
      <PageHeader title="New project" description="Bring an existing repository, or let an agent start a new one for you." />
      <Tabs defaultValue="import" className="gap-4">
        <TabsList className="grid h-auto w-full grid-cols-2 group-data-horizontal/tabs:h-auto">
          <TabsTrigger value="import" className="h-auto flex-col items-start gap-0.5 px-3 py-2 text-left whitespace-normal">
            <span className="flex items-center gap-1.5 font-medium">
              <FolderInput className="size-4" /> Import existing
            </span>
            <span className="hidden text-xs font-normal text-muted-foreground sm:block">A folder or a git URL</span>
          </TabsTrigger>
          <TabsTrigger value="new" className="h-auto flex-col items-start gap-0.5 px-3 py-2 text-left whitespace-normal">
            <span className="flex items-center gap-1.5 font-medium">
              <Sparkles className="size-4" /> Start new
            </span>
            <span className="hidden text-xs font-normal text-muted-foreground sm:block">Web, mobile, backend, design…</span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="import">
          <ImportPanel />
        </TabsContent>
        <TabsContent value="new">
          <StartPanel />
        </TabsContent>
      </Tabs>
    </Page>
  );
}
