import { useCallback, useEffect, useId, useState } from "react";
import { ArrowRight, FolderGit2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import type { ProjectSkill } from "@nightshift/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { messageOf, skillsApi } from "../api";
import { skillsHref } from "../routing";
import { Notice } from "./Notice";
import { Dot, EmptyState } from "./TaskBits";

type Choice = "default" | "on" | "off";

const toChoice = (override: boolean | null): Choice => (override === null ? "default" : override ? "on" : "off");
const fromChoice = (choice: Choice): boolean | null => (choice === "default" ? null : choice === "on");

function SkillRow({ skill, busy, onChange }: { skill: ProjectSkill; busy: boolean; onChange: (value: boolean | null) => void }) {
  const id = useId();
  const repo = skill.origin === "repository";
  return (
    <li className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Dot tone={skill.enabled ? "success" : "muted"} />
          <span id={`${id}-name`} className={cn("truncate text-sm font-medium", !skill.enabled && "text-muted-foreground")}>
            {skill.name}
          </span>
          {repo ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline" className="gap-1 font-normal text-muted-foreground" tabIndex={0}>
                  <FolderGit2 className="size-3 text-sky-600 dark:text-sky-400" aria-hidden="true" />
                  From this repository
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="font-mono text-xs">{skill.path}</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
        {skill.description ? <p className="line-clamp-2 pl-4 text-xs leading-relaxed text-muted-foreground">{skill.description}</p> : null}
      </div>
      <Select value={toChoice(skill.override)} onValueChange={(v) => onChange(fromChoice(v as Choice))} disabled={busy}>
        <SelectTrigger size="sm" className="w-full shrink-0 sm:ml-4 sm:w-40" aria-label={`${skill.name} in this project`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          <SelectItem value="default">Default ({skill.globalEnabled ? "on" : "off"})</SelectItem>
          <SelectItem value="on">On</SelectItem>
          <SelectItem value="off">Off</SelectItem>
        </SelectContent>
      </Select>
    </li>
  );
}

function Group({ title, skills, busy, onChange }: { title: string; skills: ProjectSkill[]; busy: Set<string>; onChange: (skill: ProjectSkill, value: boolean | null) => void }) {
  const id = useId();
  if (!skills.length) return null;
  return (
    <section aria-labelledby={id} className="grid gap-2">
      <h3 id={id} className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      <ul className="divide-y overflow-hidden rounded-lg border">
        {skills.map((s) => (
          <SkillRow key={s.id} skill={s} busy={busy.has(s.id)} onChange={(v) => onChange(s, v)} />
        ))}
      </ul>
    </section>
  );
}

export function ProjectSkillsCard({ projectId }: { projectId: string }) {
  const [skills, setSkills] = useState<ProjectSkill[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const res = await skillsApi.project(projectId);
      setSkills(res.skills);
      setError(null);
    } catch (err) {
      setError(messageOf(err));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const replace = (next: ProjectSkill) => setSkills((list) => (list ? list.map((s) => (s.id === next.id ? next : s)) : list));

  const change = async (skill: ProjectSkill, value: boolean | null) => {
    setBusy((b) => new Set(b).add(skill.id));
    replace({ ...skill, override: value, enabled: value ?? skill.globalEnabled });
    try {
      await skillsApi.setProjectSkill(projectId, skill.id, value);
      const enabled = value ?? skill.globalEnabled;
      toast.success(value === null ? `${skill.name} follows the default (${enabled ? "on" : "off"})` : `${skill.name} is ${enabled ? "on" : "off"} in this project`);
    } catch (err) {
      replace(skill);
      toast.error("Could not save the skill setting", { description: messageOf(err) });
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(skill.id);
        return next;
      });
    }
  };

  const own = skills?.filter((s) => s.origin === "nightshift") ?? [];
  const repo = skills?.filter((s) => s.origin === "repository") ?? [];
  const on = skills?.filter((s) => s.enabled).length ?? 0;

  return (
    <Card id="skills" className="scroll-mt-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="size-4 text-muted-foreground" /> Skills
        </CardTitle>
        <CardDescription>
          {skills && skills.length ? `${on} of ${skills.length} on for this project. ` : null}
          Default follows the setting on the Skills page. Changes save right away.
        </CardDescription>
        <CardAction>
          <Button type="button" variant="ghost" size="sm" asChild>
            <a href={skillsHref}>
              Manage skills <ArrowRight />
            </a>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-5">
        {error && !skills ? (
          <Notice
            tone="warning"
            title="Could not load skills"
            action={
              <Button type="button" size="sm" variant="outline" onClick={() => void load()}>
                Retry
              </Button>
            }
          >
            {error}
          </Notice>
        ) : skills === null ? (
          <div className="divide-y rounded-lg border" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-4 px-4 py-3">
                <div className="grid flex-1 gap-1.5">
                  <Skeleton className="h-3.5 w-1/4" />
                  <Skeleton className="h-3 w-3/4" />
                </div>
                <Skeleton className="h-7 w-40" />
              </div>
            ))}
          </div>
        ) : skills.length === 0 ? (
          <div className="rounded-lg border border-dashed">
            <EmptyState icon={<Sparkles />} title="No skills available" className="py-8" action={<Button type="button" variant="outline" size="sm" asChild><a href={skillsHref}>Add skills</a></Button>}>
              Add skills on the Skills page, or commit them to this repository under <code className="font-mono text-xs">.claude/skills</code>.
            </EmptyState>
          </div>
        ) : (
          <>
            <Group title="Nightshift skills" skills={own} busy={busy} onChange={(s, v) => void change(s, v)} />
            <Group title="From this repository" skills={repo} busy={busy} onChange={(s, v) => void change(s, v)} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
