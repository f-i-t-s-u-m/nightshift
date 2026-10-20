import type { ReactNode } from "react";
import { Info, LayoutGrid, Package, Sparkles } from "lucide-react";
import type { PreviewConfig, PreviewInfo, PreviewService } from "@nightshift/core";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Spinner, ToneBadge } from "../components/TaskBits";

const AI_BOX = "border-violet-500/30 bg-violet-500/[0.04] dark:bg-violet-500/[0.07]";
const AI_ICON = "bg-violet-500/10 text-violet-600 dark:text-violet-400";

type RowState = { label: string; tone: "muted" | "info" | "warning" | "neutral"; previous: string | null };

const rowState = (s: PreviewService, current: PreviewInfo): RowState => {
  const multi = current.services.length > 1;
  const match = multi ? current.services.find((x) => x.name === s.name) : undefined;
  if (!current.configured || !multi) return { label: "not set up", tone: "muted", previous: null };
  if (!match) return { label: "new", tone: "info", previous: null };
  if (match.command !== s.command) return { label: "changed", tone: "warning", previous: match.command };
  return { label: "unchanged", tone: "neutral", previous: null };
};

function SuggestedServiceRow({ service, current }: { service: PreviewService; current: PreviewInfo }) {
  const env = Object.entries(service.env ?? {});
  const state = rowState(service, current);
  return (
    <li className="grid gap-1.5 rounded-lg border border-dashed bg-background/70 p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span aria-hidden="true" className="inline-block size-2 shrink-0 rounded-full border border-muted-foreground/60" />
        <span className="font-medium">{service.name}</span>
        {service.primary ? (
          <ToneBadge tone="info" title="The main app. The task's preview link points here.">
            main
          </ToneBadge>
        ) : null}
        {service.shared ? (
          <ToneBadge tone="accent" title="One copy for the whole project, used by every task">
            shared{service.port ? <span className="font-mono">:{service.port}</span> : null}
          </ToneBadge>
        ) : null}
        {service.cwd ? (
          <code className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={service.cwd}>
            {service.cwd}
          </code>
        ) : null}
        <ToneBadge tone={state.tone} className="ml-auto">
          {state.label}
        </ToneBadge>
      </div>
      {state.previous ? (
        <code className="block truncate font-mono text-xs text-muted-foreground line-through decoration-muted-foreground/50" title={`Now: ${state.previous}`}>
          <span className="sr-only">Now: </span>$ {state.previous}
        </code>
      ) : null}
      <code className="block truncate font-mono text-xs" title={service.command}>
        $ {service.command}
      </code>
      {env.length ? (
        <ul className="flex flex-wrap gap-1" aria-label={`Environment for ${service.name}`}>
          {env.map(([k, v]) => (
            <li key={k} className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground" title={`${k}=${v}`}>
              {k}={v}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function SingleSuggestion({ suggestion, current }: { suggestion: PreviewConfig; current: PreviewInfo }) {
  const now = current.configured ? current.command : null;
  const same = now === suggestion.command;
  return (
    <div className="grid gap-1.5 rounded-lg border border-dashed bg-background/70 p-3">
      <div className="text-xs text-muted-foreground">{same ? "Same command as now" : now ? "Command" : "Dev server command"}</div>
      {now && !same ? (
        <code className="block truncate font-mono text-xs text-muted-foreground line-through decoration-muted-foreground/50" title={`Now: ${now}`}>
          <span className="sr-only">Now: </span>$ {now}
        </code>
      ) : null}
      <code className="block truncate font-mono text-xs" title={suggestion.command}>
        $ {suggestion.command}
      </code>
    </div>
  );
}

export const suggestionServices = (s: PreviewConfig | null | undefined) => s?.services ?? [];

export function SetupPanel({
  source,
  title,
  description,
  suggestion,
  notes,
  current,
  primary,
  secondary,
  applying,
  onApply,
  onDismiss,
}: {
  source: "ai" | "rules";
  title: ReactNode;
  description?: ReactNode;
  suggestion: PreviewConfig | null;
  notes: string[];
  current: PreviewInfo;
  primary: string;
  secondary: string;
  applying: boolean;
  onApply: () => void;
  onDismiss: () => void;
}) {
  const services = suggestionServices(suggestion);
  return (
    <section aria-label="Suggested preview setup" className={cn("grid gap-3 rounded-xl border p-3 sm:p-4", source === "ai" ? AI_BOX : "border-primary/25 bg-muted/30")}>
      <div className="flex items-start gap-2.5">
        <span className={cn("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md", source === "ai" ? AI_ICON : "bg-primary/10 text-primary")} aria-hidden="true">
          {source === "ai" ? <Sparkles className="size-4" /> : <LayoutGrid className="size-4" />}
        </span>
        <div className="grid min-w-0 gap-0.5">
          <h3 className="text-sm font-medium">{title}</h3>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
      </div>
      {suggestion ? (
        services.length ? (
          <ul className="grid gap-2" aria-label="Suggested apps">
            {services.map((s) => (
              <SuggestedServiceRow key={s.name} service={s} current={current} />
            ))}
          </ul>
        ) : (
          <SingleSuggestion suggestion={suggestion} current={current} />
        )
      ) : null}
      {suggestion?.install ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Package className="size-3.5 shrink-0" aria-hidden="true" />
          <span>
            Runs <code className="font-mono text-foreground">{suggestion.install}</code> once before the apps start.
          </span>
        </p>
      ) : null}
      {notes.length ? (
        <ul className="grid gap-1" aria-label="Notes">
          {notes.map((n) => (
            <li key={n} className="flex items-start gap-1.5 text-xs leading-5 text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>{n}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {suggestion ? (
          <Button size="sm" disabled={applying} onClick={onApply}>
            {applying ? <Spinner className="size-3" /> : null} {primary}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" disabled={applying} onClick={onDismiss}>
          {secondary}
        </Button>
      </div>
    </section>
  );
}

export function DetectingPanel({ onCancel }: { onCancel: () => void }) {
  return (
    <section aria-label="Detecting the preview setup" className={cn("grid gap-3 rounded-xl border p-3 sm:p-4", AI_BOX)}>
      <div className="flex items-start gap-2.5">
        <span className={cn("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md", AI_ICON)} aria-hidden="true">
          <Sparkles className="size-4" />
        </span>
        <div className="grid min-w-0 flex-1 gap-0.5" role="status">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <Spinner className="size-3.5" /> Detecting with AI
          </h3>
          <p className="text-sm text-muted-foreground">Reading package.json, turbo.json and READMEs… This can take up to half a minute.</p>
        </div>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <div className="grid gap-2" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-14 animate-pulse rounded-lg border border-dashed bg-background/60" style={{ animationDelay: `${i * 150}ms` }} />
        ))}
      </div>
    </section>
  );
}
