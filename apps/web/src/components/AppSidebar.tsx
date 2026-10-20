import { useEffect } from "react";
import { Bot, Boxes, ChartColumn, CircleAlert, ListTodo, MoonStar, MoreHorizontal, Pause, Plus, Power, Search, Settings, Sparkles } from "lucide-react";
import type { ProjectSummary } from "@nightshift/core";
import type { Tone } from "@nightshift/ui";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { Kbd } from "@/components/ui/kbd";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { modelsHref, projectHref, projectSettingsHref, skillsHref, type Route } from "../routing";
import { KindIcon } from "./projectKinds";
import { useLive, type Connection } from "../live";
import { Dot } from "./TaskBits";

const CONNECTION: Record<Connection, { tone: Tone; label: string }> = {
  connecting: { tone: "muted", label: "Connecting" },
  live: { tone: "success", label: "Live" },
  polling: { tone: "warning", label: "Polling" },
  offline: { tone: "danger", label: "Offline" },
};

const attention = (p: ProjectSummary) => Math.max(p.taskCounts.needs_info ?? 0, p.openDecisions ?? 0);

function ProjectItem({ project, current }: { project: ProjectSummary; current: boolean }) {
  const needs = attention(project);
  const hints = [
    project.paused ? "paused" : null,
    project.activeRuns > 0 ? `${project.activeRuns} agent${project.activeRuns === 1 ? "" : "s"} working` : null,
    needs > 0 ? `${needs} need${needs === 1 ? "s" : ""} info` : null,
    project.sourceError ? "task source error" : null,
  ].filter(Boolean);
  const label = hints.length ? `${project.name}: ${hints.join(", ")}` : project.name;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={current} tooltip={label} className="pr-20">
        <a href={projectHref(project.id)} aria-current={current ? "page" : undefined} title={label}>
          <KindIcon kind={project.kind} className={cn(project.paused && "text-muted-foreground")} />
          <span className={cn("truncate", project.paused && "text-muted-foreground")}>{project.name}</span>
        </a>
      </SidebarMenuButton>
      <SidebarMenuBadge className="right-7 gap-1.5">
        {project.paused ? <Pause className="size-3.5 text-amber-600 dark:text-amber-400" aria-label="Paused" /> : null}
        {project.sourceError ? <CircleAlert className="size-3.5 text-red-500" aria-label="Task source error" /> : null}
        {project.activeRuns > 0 ? (
          <span className="inline-flex items-center gap-1 text-sky-600 dark:text-sky-400" aria-label={`${project.activeRuns} agents working`}>
            <Dot tone="info" pulse className="size-1.5" />
            {project.activeRuns}
          </span>
        ) : null}
        {needs > 0 ? (
          <span className="rounded bg-violet-500/15 px-1 text-violet-700 dark:text-violet-300" aria-label={`${needs} tasks need info`}>
            {needs}
          </span>
        ) : null}
      </SidebarMenuBadge>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction showOnHover aria-label={`${project.name} options`}>
            <MoreHorizontal />
          </SidebarMenuAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start">
          <DropdownMenuItem asChild>
            <a href={projectHref(project.id)}>
              <ListTodo /> Tasks
            </a>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href={projectSettingsHref(project.id)}>
              <Settings /> Settings
            </a>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}

export function AppSidebar({ route, onSearch }: { route: Route; onSearch: () => void }) {
  const { projects, projectsError, status, connection } = useLive();
  const { setOpenMobile, isMobile } = useSidebar();
  const conn = CONNECTION[connection];
  const currentProject = route.name === "project" || route.name === "task" || route.name === "projectSettings" ? route.projectId : null;

  useEffect(() => {
    if (isMobile) setOpenMobile(false);
  }, [route, isMobile, setOpenMobile]);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg">
              <a href="#/">
                <span className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                  <MoonStar className="size-4" />
                </span>
                <span className="grid flex-1 text-left leading-tight">
                  <span className="truncate font-semibold">Nightshift</span>
                  <span
                    className="flex items-center gap-1.5 truncate text-xs text-muted-foreground"
                    title={connection === "offline" ? "Daemon not reachable" : `Connection: ${conn.label}`}
                  >
                    <Dot tone={conn.tone} pulse={connection === "live"} className="size-1.5" />
                    {conn.label}
                  </span>
                </span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={onSearch} tooltip="Search (⌘K)" className="text-muted-foreground">
              <Search />
              <span className="flex-1">Search</span>
              <Kbd className="group-data-[collapsible=icon]:hidden">⌘K</Kbd>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {status?.killSwitch ? (
          <SidebarGroup className="py-0">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="Kill switch on" className="bg-red-500/10 text-red-700 hover:bg-red-500/15 dark:text-red-300">
                  <a href="#/agents">
                    <Power />
                    <span>Kill switch on: agents stopped</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        ) : null}
        <SidebarGroup>
          <SidebarGroupLabel id="side-projects">Projects</SidebarGroupLabel>
          <SidebarGroupAction asChild title="New project">
            <a href="#/projects/new" aria-label="New project">
              <Plus />
            </a>
          </SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu aria-labelledby="side-projects">
              {projects === null ? (
                projectsError ? (
                  <li className="px-2 py-1.5 text-xs text-muted-foreground">Could not load projects</li>
                ) : (
                  [0, 1, 2].map((i) => (
                    <SidebarMenuItem key={i}>
                      <SidebarMenuSkeleton showIcon />
                    </SidebarMenuItem>
                  ))
                )
              ) : projects.length === 0 ? (
                <li className="px-2 py-1.5 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">No projects yet</li>
              ) : (
                projects.map((p) => <ProjectItem key={p.id} project={p} current={p.id === currentProject} />)
              )}
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={route.name === "newProject"} tooltip="New project" className="text-muted-foreground">
                  <a href="#/projects/new" aria-current={route.name === "newProject" ? "page" : undefined}>
                    <Plus />
                    <span>New project</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={route.name === "agents"} tooltip="Agents">
              <a href="#/agents" aria-current={route.name === "agents" ? "page" : undefined}>
                <Bot />
                <span>Agents</span>
              </a>
            </SidebarMenuButton>
            {status ? (
              <SidebarMenuBadge>
                {status.slots.filter((s) => s.runId).length}/{status.slots.length}
              </SidebarMenuBadge>
            ) : null}
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={route.name === "models"} tooltip="Models">
              <a href={modelsHref} aria-current={route.name === "models" ? "page" : undefined}>
                <Boxes />
                <span>Models</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={route.name === "skills"} tooltip="Skills">
              <a href={skillsHref} aria-current={route.name === "skills" ? "page" : undefined}>
                <Sparkles />
                <span>Skills</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={route.name === "usage"} tooltip="Usage">
              <a href="#/usage" aria-current={route.name === "usage" ? "page" : undefined}>
                <ChartColumn />
                <span>Usage</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
