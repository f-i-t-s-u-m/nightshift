import { useEffect, useState } from "react";
import { Bot, Boxes, ChartColumn, FolderGit2, Laptop, ListTodo, Moon, Plus, Sparkles, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import type { TaskListItem } from "@nightshift/core";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { api } from "../api";
import { useLive } from "../live";
import { modelsHref, navigate, projectHref, skillsHref, taskHref } from "../routing";
import { statusDef } from "../phases";
import { Spinner } from "./TaskBits";

type ProjectTasks = { projectId: string; projectName: string; tasks: TaskListItem[] };

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { projects } = useLive();
  const { setTheme } = useTheme();
  const [tasks, setTasks] = useState<ProjectTasks[] | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open || !projects) return;
    let cancelled = false;
    Promise.all(
      projects.map((p) =>
        api
          .tasks(p.id)
          .then((res) => ({ projectId: p.id, projectName: p.name, tasks: res.tasks }))
          .catch(() => ({ projectId: p.id, projectName: p.name, tasks: [] })),
      ),
    ).then((all) => {
      if (!cancelled) setTasks(all);
    });
    return () => {
      cancelled = true;
    };
  }, [open, projects]);

  const go = (href: string) => {
    onOpenChange(false);
    navigate(href);
  };

  const run = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };

  return (
    <CommandDialog className="sm:max-w-xl" open={open} onOpenChange={onOpenChange} title="Jump to" description="Search projects, tasks and pages">
      <Command>
        <CommandInput placeholder="Search projects and tasks…" />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>
          {projects && projects.length > 0 ? (
            <CommandGroup heading="Projects">
              {projects.map((p) => (
                <CommandItem key={p.id} value={`project ${p.name} ${p.id}`} onSelect={() => go(projectHref(p.id))}>
                  <FolderGit2 />
                  <span className="truncate">{p.name}</span>
                  {p.activeRuns > 0 ? <CommandShortcut>{p.activeRuns} working</CommandShortcut> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          {tasks === null ? (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
              <Spinner className="size-3" /> Loading tasks…
            </div>
          ) : (
            tasks
              .filter((g) => g.tasks.length > 0)
              .map((g) => (
                <CommandGroup key={g.projectId} heading={`Tasks · ${g.projectName}`}>
                  {g.tasks.map((t) => (
                    <CommandItem key={t.id} value={`task ${t.id} ${t.title} ${g.projectName}`} onSelect={() => go(taskHref(g.projectId, t.id))}>
                      <ListTodo />
                      <span className="truncate">{t.title || t.id}</span>
                      <CommandShortcut className="font-mono">{t.id}</CommandShortcut>
                      <span className="sr-only">{statusDef(t.status).label}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))
          )}
          <CommandSeparator />
          <CommandGroup heading="Pages">
            <CommandItem value="page new project" onSelect={() => go("#/projects/new")}>
              <Plus /> New project
            </CommandItem>
            <CommandItem value="page agents" onSelect={() => go("#/agents")}>
              <Bot /> Agents
            </CommandItem>
            <CommandItem value="page models" keywords={["settings", "provider", "api key", "openrouter", "anthropic", "openai", "sign in"]} onSelect={() => go(modelsHref)}>
              <Boxes /> Models
            </CommandItem>
            <CommandItem value="page skills" keywords={["settings", "skill", "claude code", "instructions", "import"]} onSelect={() => go(skillsHref)}>
              <Sparkles /> Skills
            </CommandItem>
            <CommandItem value="page usage" onSelect={() => go("#/usage")}>
              <ChartColumn /> Usage
            </CommandItem>
          </CommandGroup>
          <CommandGroup heading="Theme">
            <CommandItem value="light theme" keywords={["mode", "appearance"]} onSelect={() => run(() => setTheme("light"))}>
              <Sun /> Light theme
            </CommandItem>
            <CommandItem value="dark theme" keywords={["mode", "appearance", "night"]} onSelect={() => run(() => setTheme("dark"))}>
              <Moon /> Dark theme
            </CommandItem>
            <CommandItem value="system theme" keywords={["mode", "appearance", "auto"]} onSelect={() => run(() => setTheme("system"))}>
              <Laptop /> System theme
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
