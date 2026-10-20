import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Project, ProjectSource } from "@nightshift/core";
import { humanize, phaseTone, type Tone } from "@nightshift/ui";
import { Badge } from "@/components/ui/badge";
import { statusDef } from "../phases";

export const TONE_BADGE: Record<Tone, string> = {
  neutral: "bg-secondary text-secondary-foreground",
  info: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  accent: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  warning: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  success: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  danger: "bg-red-500/15 text-red-700 dark:text-red-300",
  muted: "bg-muted text-muted-foreground",
};

export const TONE_DOT: Record<Tone, string> = {
  neutral: "bg-foreground/50",
  info: "bg-sky-500",
  accent: "bg-violet-500",
  warning: "bg-amber-500",
  success: "bg-emerald-500",
  danger: "bg-red-500",
  muted: "bg-muted-foreground/50",
};

export const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-foreground",
  info: "text-sky-600 dark:text-sky-400",
  accent: "text-violet-600 dark:text-violet-400",
  warning: "text-amber-600 dark:text-amber-400",
  success: "text-emerald-600 dark:text-emerald-400",
  danger: "text-red-600 dark:text-red-400",
  muted: "text-muted-foreground",
};

export function Dot({ tone, pulse, className }: { tone: Tone; pulse?: boolean; className?: string }) {
  return <span aria-hidden="true" className={cn("inline-block size-2 shrink-0 rounded-full", TONE_DOT[tone], pulse && "animate-pulse", className)} />;
}

export function ToneBadge({ tone, children, title, className }: { tone: Tone; children: ReactNode; title?: string; className?: string }) {
  return (
    <Badge variant="secondary" title={title} className={cn(TONE_BADGE[tone], className)}>
      {children}
    </Badge>
  );
}

export function StatusPill({ status }: { status: string }) {
  const def = statusDef(status);
  return (
    <ToneBadge tone={def.tone}>
      <Dot tone={def.tone} className="size-1.5" />
      {def.label}
    </ToneBadge>
  );
}

export function PhaseBadge({ phase, paused }: { phase: string | null | undefined; paused?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1">
      <ToneBadge tone={phaseTone(phase)}>{phase ? humanize(phase) : "idle"}</ToneBadge>
      {paused ? <ToneBadge tone="warning">paused</ToneBadge> : null}
    </span>
  );
}

export const sourceLabel = (source: ProjectSource) => (source.type === "local" ? "Nightshift tasks" : "WonderCall");

export function ProjectMeta({ project }: { project: Project }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
      <span className="truncate font-mono text-xs" title={project.repo.path}>
        {project.repo.path}
      </span>
      <span aria-hidden="true">·</span>
      <span title="Base branch" className="font-mono text-xs">
        {project.repo.baseBranch}
      </span>
      <span aria-hidden="true">·</span>
      <span>{sourceLabel(project.source)}</span>
      {project.gitHost === "local" ? (
        <>
          <span aria-hidden="true">·</span>
          <span>local git</span>
        </>
      ) : null}
    </div>
  );
}

export function Spinner({ label, className }: { label?: string; className?: string }) {
  return (
    <Loader2
      className={cn("size-4 animate-spin text-muted-foreground", className)}
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

export function EmptyState({
  title,
  children,
  icon,
  action,
  className,
}: {
  title: ReactNode;
  children?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 px-6 py-12 text-center", className)}>
      {icon ? <div className="mb-1 flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5">{icon}</div> : null}
      <div className="font-medium">{title}</div>
      {children ? <div className="max-w-md text-sm text-muted-foreground">{children}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function Page({ children, narrow, className }: { children: ReactNode; narrow?: boolean; className?: string }) {
  return <div className={cn("mx-auto w-full space-y-6 px-4 py-6 md:px-8", narrow ? "max-w-3xl" : "max-w-6xl", className)}>{children}</div>;
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <div className="text-sm text-muted-foreground">{description}</div> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}
