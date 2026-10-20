import { useState, type ReactNode } from "react";
import { Bot, Check, CircleAlert, Container, Laptop, ListChecks, Sparkles, TriangleAlert, Wrench } from "lucide-react";
import type { PreviewDiagnosis, PreviewFix, PreviewServiceInfo } from "@nightshift/core";
import { formatDateTime, formatRelative } from "@nightshift/ui";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Spinner } from "../components/TaskBits";

export type ProblemService = Pick<PreviewServiceInfo, "name" | "status" | "error" | "hint" | "diagnosis" | "diagnosing" | "command" | "cwd">;

export const hasProblem = (s: ProblemService) => s.status === "failed" || Boolean(s.hint) || s.diagnosing;

export function HintLine({ hint, className }: { hint: string; className?: string }) {
  return (
    <p className={cn("flex items-start gap-1.5 text-xs leading-5 text-amber-700 dark:text-amber-300", className)}>
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span>
        <span className="sr-only">Warning: </span>
        {hint}
      </span>
    </p>
  );
}

function SourceTag({ diagnosis }: { diagnosis: PreviewDiagnosis }) {
  const ai = diagnosis.source === "ai";
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title={ai ? "Written by AI from the log" : "Matched a known problem in the log"}>
      {ai ? <Sparkles className="size-3 text-violet-600 dark:text-violet-400" aria-hidden="true" /> : <ListChecks className="size-3" aria-hidden="true" />}
      {ai ? "AI diagnosis" : "Rule check"}
      <span aria-hidden="true">·</span>
      <time dateTime={diagnosis.at} title={formatDateTime(diagnosis.at)}>
        {formatRelative(diagnosis.at)}
      </time>
    </span>
  );
}

function FixRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[6.5rem_minmax(0,1fr)] sm:gap-2">
      <dt className="text-xs text-muted-foreground sm:pt-1">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function DiffLines({ from, to }: { from: string | null; to: string }) {
  return (
    <div className="overflow-hidden rounded-md border font-mono text-xs leading-5">
      {from ? (
        <div className="flex gap-2 bg-red-500/10 px-2 py-1 text-red-800 dark:text-red-200">
          <span aria-hidden="true" className="select-none text-red-600 dark:text-red-400">
            −
          </span>
          <span className="sr-only">Now: </span>
          <code className="min-w-0 break-all">{from}</code>
        </div>
      ) : null}
      <div className="flex gap-2 bg-emerald-500/10 px-2 py-1 text-emerald-800 dark:text-emerald-200">
        <span aria-hidden="true" className="select-none text-emerald-600 dark:text-emerald-400">
          +
        </span>
        <span className="sr-only">{from ? "Becomes: " : "Add: "}</span>
        <code className="min-w-0 break-all">{to}</code>
      </div>
    </div>
  );
}

function Plain({ children }: { children: ReactNode }) {
  return <code className="inline-block max-w-full rounded bg-muted px-1.5 py-0.5 font-mono text-xs break-all">{children}</code>;
}

export function FixView({ fix, service, install }: { fix: PreviewFix; service: ProblemService; install: string | null }) {
  const env = Object.entries(fix.env ?? {});
  return (
    <dl className="grid gap-2.5">
      {fix.command && fix.command !== service.command ? (
        <FixRow label="Command">
          <DiffLines from={service.command || null} to={fix.command} />
        </FixRow>
      ) : null}
      {env.length ? (
        <FixRow label="Environment">
          <ul className="flex flex-wrap gap-1" aria-label="Environment variables to add">
            {env.map(([k, v]) => (
              <li key={k} className="max-w-full rounded-md bg-emerald-500/10 px-1.5 py-0.5 font-mono text-xs break-all text-emerald-800 dark:text-emerald-200">
                <span aria-hidden="true">+ </span>
                {k}={v}
              </li>
            ))}
          </ul>
        </FixRow>
      ) : null}
      {fix.install && fix.install !== install ? (
        <FixRow label="Install first">
          <DiffLines from={install} to={fix.install} />
        </FixRow>
      ) : null}
      {fix.cwd && fix.cwd !== service.cwd ? (
        <FixRow label="Folder">
          <DiffLines from={service.cwd} to={fix.cwd} />
        </FixRow>
      ) : null}
      {fix.target || fix.containerPort ? (
        <FixRow label="Runs in">
          <span className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-xs text-emerald-800 dark:text-emerald-200">
            {fix.target === "machine" ? <Laptop className="size-3 shrink-0" aria-hidden="true" /> : <Container className="size-3 shrink-0" aria-hidden="true" />}
            {fix.target === "machine" ? (
              "Run on this machine"
            ) : fix.containerPort ? (
              <span>
                Run in a container on port <span className="font-mono">{fix.containerPort}</span>
              </span>
            ) : (
              "Run in a container"
            )}
          </span>
        </FixRow>
      ) : null}
      {fix.portEnv ? (
        <FixRow label="Port variable">
          <Plain>{fix.portEnv}</Plain>
        </FixRow>
      ) : null}
      {fix.readyPath ? (
        <FixRow label="Ready check">
          <Plain>{fix.readyPath}</Plain>
        </FixRow>
      ) : null}
    </dl>
  );
}

const fixIsEmpty = (fix: PreviewFix | null) => !fix || !Object.values(fix).some((v) => (v && typeof v === "object" ? Object.keys(v).length > 0 : Boolean(v)));

export function ProblemPanel({
  service,
  label,
  install,
  onDiagnose,
  onApplyFix,
  onAskAgent,
}: {
  service: ProblemService;
  label: string;
  install: string | null;
  onDiagnose: () => Promise<void>;
  onApplyFix: (fix: PreviewFix) => Promise<void>;
  onAskAgent: ((prompt: string) => Promise<void>) | null;
}) {
  const [busy, setBusy] = useState<"diagnose" | "fix" | "agent" | null>(null);
  const [asked, setAsked] = useState<string | null>(null);
  const failed = service.status === "failed";
  const d = service.diagnosis;
  const run = async (key: "diagnose" | "fix" | "agent", fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch {
      return;
    } finally {
      setBusy(null);
    }
  };
  const diagnosing = service.diagnosing || busy === "diagnose";
  const fix = d && !fixIsEmpty(d.fix) ? d.fix : null;
  return (
    <section
      aria-label={`What went wrong with ${label}`}
      className={cn(
        "grid gap-3 rounded-lg border p-3",
        failed ? "border-red-500/30 bg-red-500/[0.04] dark:bg-red-500/[0.06]" : "border-amber-500/30 bg-amber-500/[0.04] dark:bg-amber-500/[0.06]",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {failed ? (
          <CircleAlert className="size-4 shrink-0 text-red-600 dark:text-red-400" aria-hidden="true" />
        ) : (
          <TriangleAlert className="size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
        )}
        <h4 className="text-sm font-medium">{failed ? "What went wrong" : "Possible problem"}</h4>
        {d && !diagnosing ? <SourceTag diagnosis={d} /> : null}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-7 px-2 text-xs"
          disabled={diagnosing || busy !== null}
          onClick={() => void run("diagnose", onDiagnose)}
        >
          <Sparkles className="text-violet-600 dark:text-violet-400" /> {d && d.source === "ai" ? "Diagnose again" : "Diagnose with AI"}
        </Button>
      </div>

      {diagnosing ? (
        <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-3.5 text-violet-600 dark:text-violet-400" /> AI is reading the log…
        </div>
      ) : d ? (
        <div className="grid gap-1">
          <p className="text-sm font-medium text-foreground">{d.summary}</p>
          {d.cause ? <p className="text-sm text-muted-foreground">{d.cause}</p> : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {failed ? `${label} stopped before it was ready.` : `${label} may not start correctly.`} AI can read the log and suggest a fix.
        </p>
      )}

      {service.error ? (
        d ? (
          <details className="group text-xs">
            <summary className="cursor-pointer text-muted-foreground select-none hover:text-foreground">Error output</summary>
            <pre className="mt-1.5 max-h-40 overflow-auto rounded-md bg-zinc-950 p-2 font-mono text-xs leading-5 whitespace-pre-wrap break-all text-zinc-100">{service.error}</pre>
          </details>
        ) : (
          <pre className="max-h-40 overflow-auto rounded-md bg-zinc-950 p-2 font-mono text-xs leading-5 whitespace-pre-wrap break-all text-zinc-100">{service.error}</pre>
        )
      ) : null}

      {!diagnosing && d && (fix || d.agentPrompt) ? (
        <div className="grid gap-3 rounded-md border bg-background/70 p-3">
          {fix ? (
            <>
              <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Wrench className="size-3.5" aria-hidden="true" /> Proposed fix
              </div>
              <FixView fix={fix} service={service} install={install} />
              <p className="text-xs text-muted-foreground">Saved to the project's preview settings, so new tasks get it too.</p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">This needs a code change, not a settings change.</p>
          )}
          <div className="flex flex-wrap gap-2">
            {fix ? (
              <Button size="sm" disabled={busy !== null} onClick={() => void run("fix", () => onApplyFix(fix))}>
                {busy === "fix" ? <Spinner className="size-3" /> : <Wrench />} Apply fix and restart
              </Button>
            ) : null}
            {d.agentPrompt && onAskAgent ? (
              asked === d.at ? (
                <span role="status" className="inline-flex h-8 items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-300">
                  <Check className="size-4" /> Sent to the agent
                </span>
              ) : (
                <Button
                  size="sm"
                  variant={fix ? "outline" : "default"}
                  disabled={busy !== null}
                  onClick={() =>
                    void run("agent", async () => {
                      await onAskAgent(d.agentPrompt ?? "");
                      setAsked(d.at);
                    })
                  }
                >
                  {busy === "agent" ? <Spinner className="size-3" /> : <Bot />} Ask the agent to fix it
                </Button>
              )
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
