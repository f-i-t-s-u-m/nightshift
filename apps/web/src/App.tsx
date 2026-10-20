import { useEffect, useState } from "react";
import { ChevronRight, MoonStar, Search, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Kbd } from "@/components/ui/kbd";
import { DAEMON_ADDRESS } from "./api";
import { LightboxProvider } from "./components/attachments";
import { AppSidebar } from "./components/AppSidebar";
import { CommandPalette } from "./components/CommandPalette";
import { Notice } from "./components/Notice";
import { EmptyState, Page as PageShell } from "./components/TaskBits";
import { ThemeToggle } from "./components/ThemeToggle";
import { navigate, projectHref, useRoute, type Route } from "./routing";
import { useLive } from "./live";
import { Agents } from "./pages/Agents";
import { NewProject } from "./pages/NewProject";
import { ProjectPage } from "./pages/Project";
import { ProjectSettings } from "./pages/ProjectSettings";
import { RunRedirect } from "./pages/RunRedirect";
import { TaskPage } from "./pages/Task";
import { Usage } from "./pages/Usage";
import { Models } from "./pages/Models";
import { Skills } from "./pages/Skills";

function Home() {
  const { projects, projectsError } = useLive();
  const first = projects?.[0];

  useEffect(() => {
    if (first) navigate(projectHref(first.id), true);
  }, [first]);

  if (projects === null) {
    return (
      <PageShell narrow>
        {projectsError ? (
          <EmptyState title="Could not load projects">{projectsError}</EmptyState>
        ) : (
          <div className="space-y-3">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}
      </PageShell>
    );
  }
  if (first) return null;
  return (
    <PageShell narrow>
      <EmptyState
        className="py-24"
        icon={<MoonStar />}
        title={<span className="text-xl">Welcome to Nightshift</span>}
        action={
          <Button asChild>
            <a href="#/projects/new">Create your first project</a>
          </Button>
        }
      >
        A project connects Nightshift to a code repository. Add tasks to it and agents pick them up, work on a branch and open a pull request for you to
        review.
      </EmptyState>
    </PageShell>
  );
}

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case "home":
      return <Home />;
    case "agents":
      return <Agents />;
    case "usage":
      return <Usage />;
    case "models":
      return <Models />;
    case "skills":
      return <Skills />;
    case "newProject":
      return <NewProject />;
    case "project":
      return <ProjectPage key={route.projectId} projectId={route.projectId} />;
    case "projectSettings":
      return <ProjectSettings key={route.projectId} projectId={route.projectId} />;
    case "task":
      return <TaskPage key={`${route.projectId}/${route.taskId}`} projectId={route.projectId} taskId={route.taskId} />;
    case "run":
      return <RunRedirect key={route.id} id={route.id} />;
    case "missing":
      return (
        <PageShell narrow>
          <Notice tone="warning" title="Page not found">
            Nothing lives at <code>{route.path}</code>. <a href="#/">Go home</a>.
          </Notice>
        </PageShell>
      );
  }
}

function Crumbs({ route }: { route: Route }) {
  const { projects } = useLive();
  const projectName = (id: string) => projects?.find((p) => p.id === id)?.name ?? id;
  const items: Array<{ label: string; href?: string }> = [];
  if (route.name === "agents") items.push({ label: "Agents" });
  if (route.name === "usage") items.push({ label: "Usage" });
  if (route.name === "models") items.push({ label: "Settings" }, { label: "Models" });
  if (route.name === "skills") items.push({ label: "Settings" }, { label: "Skills" });
  if (route.name === "newProject") items.push({ label: "New project" });
  if (route.name === "project") items.push({ label: projectName(route.projectId) });
  if (route.name === "projectSettings") items.push({ label: projectName(route.projectId), href: projectHref(route.projectId) }, { label: "Settings" });
  if (route.name === "task") items.push({ label: projectName(route.projectId), href: projectHref(route.projectId) }, { label: route.taskId });
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
        {items.map((item, i) => (
          <li key={i} className="flex min-w-0 items-center gap-1">
            {i > 0 ? <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" /> : null}
            {item.href ? (
              <a href={item.href} className="truncate hover:text-foreground">
                {item.label}
              </a>
            ) : (
              <span className={i === items.length - 1 ? "truncate font-medium text-foreground" : "truncate"} aria-current={i === items.length - 1 ? "page" : undefined}>
                {item.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function App() {
  const route = useRoute();
  const { connection, status, refresh } = useLive();
  const [paletteOpen, setPaletteOpen] = useState(false);

  return (
    <LightboxProvider>
      <SidebarProvider>
        <AppSidebar route={route} onSearch={() => setPaletteOpen(true)} />
        <SidebarInset className="h-svh min-w-0 overflow-hidden">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
            <SidebarTrigger />
            <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
            <Crumbs route={route} />
            <div className="ml-auto flex items-center gap-1">
              {status?.killSwitch ? (
                <Button asChild size="sm" variant="destructive">
                  <a href="#/agents">Kill switch on</a>
                </Button>
              ) : null}
              <Button variant="outline" size="sm" className="hidden text-muted-foreground sm:inline-flex" onClick={() => setPaletteOpen(true)}>
                <Search />
                Search
                <Kbd>⌘K</Kbd>
              </Button>
              <Button variant="ghost" size="icon" className="sm:hidden" aria-label="Search" onClick={() => setPaletteOpen(true)}>
                <Search />
              </Button>
              <ThemeToggle />
            </div>
          </header>
          {connection === "offline" ? (
            <div className="shrink-0 border-b px-3 py-2">
              <Notice
                tone="danger"
                title="Daemon not reachable"
                action={
                  <Button size="sm" variant="outline" onClick={() => void refresh()}>
                    Retry now
                  </Button>
                }
              >
                <span className="inline-flex items-center gap-1">
                  <WifiOff className="size-3.5" />
                  Nothing answers at <code>{DAEMON_ADDRESS}</code>. Start it with <code>nightshift start</code>. Retrying every 5s
                  {status ? "; showing last known data" : ""}.
                </span>
              </Notice>
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-auto">
            <Page route={route} />
          </div>
        </SidebarInset>
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      </SidebarProvider>
    </LightboxProvider>
  );
}
