import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, Check, Pause, RefreshCw, Wand2 } from "lucide-react";
import { toast } from "sonner";
import type { ProjectInspection, ProjectSummary } from "@nightshift/core";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api, isNotFound, messageOf } from "../api";
import { Notice } from "../components/Notice";
import { BriefField, ProjectFormSections, formFromProject, formToUpdate, formValid, suggestionsFor, type ProjectForm } from "../components/ProjectForm";
import { KindIcon } from "../components/projectKinds";
import { ListenersCard, TestersCard } from "../components/ProjectVerification";
import { ProjectGithubCard } from "../components/ProjectGithub";
import { ProjectDeleteCard } from "../components/ProjectDelete";
import { ProjectSkillsCard } from "../components/ProjectSkills";
import { ProjectLocalFilesCard } from "../components/ProjectLocalFiles";
import { Page, PageHeader, Spinner, ToneBadge } from "../components/TaskBits";
import { navigate, projectHref } from "../routing";
import { useLive } from "../live";

function Suggestions({ inspection, form, onApply, onDismiss }: { inspection: ProjectInspection; form: ProjectForm; onApply: (next: ProjectForm) => void; onDismiss: () => void }) {
  const list = suggestionsFor(form, inspection);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Suggestions from the repository</CardTitle>
        <CardDescription>
          {list.length ? "Apply what you want, then save. Nothing changes until you save." : "Your settings already match what Nightshift found."}
        </CardDescription>
        <CardAction>
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Close
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-3">
        {inspection.notes.map((n, i) => (
          <Notice key={i} tone="warning">
            {n}
          </Notice>
        ))}
        {list.length ? (
          <>
            <ul className="divide-y rounded-lg border">
              {list.map((s) => (
                <li key={s.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className="font-mono text-xs font-semibold text-emerald-600 dark:text-emerald-400" aria-hidden="true">
                    +
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="text-muted-foreground">Suggested: </span>
                    {s.label}
                  </span>
                  <Button type="button" size="sm" variant="outline" onClick={() => onApply(s.apply(form))}>
                    Apply
                  </Button>
                </li>
              ))}
            </ul>
            <div>
              <Button type="button" size="sm" onClick={() => onApply(list.reduce((acc, s) => s.apply(acc), form))}>
                <Check /> Apply all
              </Button>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function ProjectSettings({ projectId }: { projectId: string }) {
  const { refreshProjects } = useLive();
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [initial, setInitial] = useState<ProjectForm | null>(null);
  const [form, setForm] = useState<ProjectForm | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [inspection, setInspection] = useState<ProjectInspection | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.tasks(projectId);
      const f = formFromProject(res.project);
      setProject(res.project);
      setInitial(f);
      setForm(f);
      setLoadError(null);
    } catch (err) {
      setNotFound(isNotFound(err));
      setLoadError(messageOf(err));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!project || !initial || !form) {
    return (
      <Page narrow>
        {notFound ? (
          <Notice tone="warning" title="Project not found">
            No project with id <code>{projectId}</code>. <a href="#/">Go home</a>.
          </Notice>
        ) : loadError ? (
          <Notice tone="danger" title="Could not load the project">
            {loadError}
          </Notice>
        ) : (
          <div className="space-y-4">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-48 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        )}
      </Page>
    );
  }

  const update = formToUpdate(initial, form);
  const dirty = Object.keys(update).length > 0;
  const valid = formValid(form);

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!dirty || !valid || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await api.updateProject(projectId, update);
      const f = formFromProject(res.project);
      setProject(res.project);
      setInitial(f);
      setForm(f);
      toast.success("Settings saved");
      void refreshProjects();
    } catch (err) {
      setSaveError(messageOf(err));
    } finally {
      setSaving(false);
    }
  };

  const reanalyze = async () => {
    setInspecting(true);
    setInspectError(null);
    try {
      const res = await api.inspect({ path: project.repo.path });
      setInspection(res.inspection);
    } catch (err) {
      setInspectError(messageOf(err));
    } finally {
      setInspecting(false);
    }
  };

  return (
    <Page narrow>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <KindIcon kind={project.kind} className="size-5 text-muted-foreground" />
            {project.name} settings
          </span>
        }
        description={project.paused ? <ToneBadge tone="warning"><Pause className="size-3" /> Paused</ToneBadge> : "Changes apply to tasks agents start after you save."}
        actions={
          <>
            <Button variant="ghost" asChild>
              <a href={projectHref(projectId)}>
                <ArrowLeft /> Back
              </a>
            </Button>
            <Button variant="outline" onClick={() => void reanalyze()} disabled={inspecting}>
              {inspecting ? <Spinner className="size-3.5" /> : <RefreshCw />}
              Re-analyze repository
            </Button>
          </>
        }
      />
      {inspectError ? (
        <Notice tone="danger" title="Could not analyze the repository">
          {inspectError}
        </Notice>
      ) : null}
      {inspection ? <Suggestions inspection={inspection} form={form} onApply={setForm} onDismiss={() => setInspection(null)} /> : null}
      <form className="space-y-4" onSubmit={(e) => void save(e)} noValidate>
        <ProjectFormSections value={form} onChange={setForm} mode="edit" prefix="ps" />
        <ProjectLocalFilesCard
          projectId={projectId}
          root={project.repo.path}
          value={form.localFiles}
          apps={form.previewOn ? form.previewServices.map((s) => s.name.trim()).filter(Boolean) : []}
          disabled={saving}
          onChange={(localFiles) => setForm((f) => (f ? { ...f, localFiles } : f))}
        />
        <ProjectGithubCard
          project={project}
          onMoved={() => {
            void load();
            void refreshProjects();
          }}
        />
        <TestersCard value={form.testers} onChange={(testers) => setForm((f) => (f ? { ...f, testers } : f))} prefix="ps-tester" />
        <ListenersCard projectId={projectId} branchPrefix={project.repo.branchPrefix} />
        <ProjectSkillsCard projectId={projectId} />
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wand2 className="size-4 text-muted-foreground" /> Project brief
            </CardTitle>
            <CardDescription>What the project is, its stack and conventions. Injected into every agent's instructions.</CardDescription>
          </CardHeader>
          <CardContent>
            <BriefField id="ps-brief" projectId={projectId} value={form.brief} onChange={(brief) => setForm((f) => (f ? { ...f, brief } : f))} disabled={saving} />
          </CardContent>
        </Card>
        {saveError ? (
          <Notice tone="danger" title="Could not save">
            {saveError}
          </Notice>
        ) : null}
        <div className="sticky bottom-0 z-10 -mx-4 flex items-center justify-end gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur md:-mx-8 md:px-8">
          {dirty ? <span className="mr-auto text-sm text-muted-foreground">Unsaved changes</span> : null}
          <Button type="button" variant="outline" disabled={!dirty || saving} onClick={() => setForm(initial)}>
            Discard
          </Button>
          <Button type="submit" disabled={!dirty || !valid || saving}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>
      <ProjectDeleteCard
        project={project}
        onDeleted={() => {
          void refreshProjects();
          navigate("#/", true);
        }}
      />
    </Page>
  );
}
