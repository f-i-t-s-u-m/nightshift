import { useEffect, useState } from "react";
import type { RunLimits } from "@nightshift/core";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { api, messageOf } from "../api";
import { Notice } from "./Notice";

type Field = { key: "perRunUsd" | "perRunTokens" | "perDayUsd" | "maxFixRounds"; label: string; hint: string; unit: string; scale: number; step: string };

const FIELDS: Field[] = [
  { key: "perRunUsd", label: "Cost per task run", hint: "The task pauses and asks you before going over.", unit: "USD", scale: 1, step: "0.5" },
  { key: "perRunTokens", label: "Tokens per task run", hint: "Input, output and cache writes. Cached context the model re-reads is not counted.", unit: "million", scale: 1_000_000, step: "0.5" },
  { key: "perDayUsd", label: "Cost per day", hint: "No new tasks start once today's usage reaches this.", unit: "USD", scale: 1, step: "1" },
  { key: "maxFixRounds", label: "Fix rounds per task", hint: "After this many rounds of failing checks, the task asks you what to do.", unit: "rounds", scale: 1, step: "1" },
];

const toText = (limits: RunLimits, f: Field) => String(Number((limits[f.key] / f.scale).toFixed(2)));

export function LimitsCard() {
  const [limits, setLimits] = useState<RunLimits | null>(null);
  const [defaults, setDefaults] = useState<RunLimits | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const apply = (next: { limits: RunLimits; defaults: RunLimits }) => {
    setLimits(next.limits);
    setDefaults(next.defaults);
    setDraft(Object.fromEntries(FIELDS.map((f) => [f.key, toText(next.limits, f)])));
  };

  useEffect(() => {
    api.limits().then(apply, (err) => setError(messageOf(err)));
  }, []);

  if (!limits || !defaults) {
    return error ? (
      <Notice tone="danger" title="Could not load limits">
        {error}
      </Notice>
    ) : (
      <Skeleton className="h-56 w-full" />
    );
  }

  const parsed = FIELDS.map((f) => ({ f, value: Number(draft[f.key]) }));
  const invalid = parsed.filter(({ value }) => !Number.isFinite(value) || value <= 0).map(({ f }) => f.key);
  const dirty = FIELDS.some((f) => draft[f.key] !== toText(limits, f));
  const custom = FIELDS.some((f) => limits[f.key] !== defaults[f.key]);

  const save = async (input: Partial<RunLimits> | null) => {
    setSaving(true);
    try {
      apply(await api.saveLimits(input));
      toast.success(input === null ? "Limits reset to the defaults" : "Limits saved");
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card id="limits">
      <CardHeader>
        <CardTitle>Limits</CardTitle>
        <CardDescription>When a task reaches a limit it pauses and asks you whether to continue. Changes apply to running tasks right away.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
          {FIELDS.map((f) => {
            const id = `limit-${f.key}`;
            const bad = invalid.includes(f.key);
            return (
              <div key={f.key} className="grid gap-1.5">
                <Label htmlFor={id}>{f.label}</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id={id}
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step={f.step}
                    value={draft[f.key] ?? ""}
                    aria-invalid={bad || undefined}
                    aria-describedby={`${id}-hint`}
                    onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                    className="max-w-40 tabular-nums"
                  />
                  <span className="text-sm text-muted-foreground">{f.unit}</span>
                </div>
                <p id={`${id}-hint`} className="text-xs text-muted-foreground">
                  {bad ? <span className="text-destructive">Enter a number above 0. </span> : null}
                  {f.hint} Default {toText(defaults, f)} {f.unit}.
                </p>
              </div>
            );
          })}
        </div>
      </CardContent>
      <CardFooter className="justify-end gap-2">
        {custom ? (
          <Button variant="ghost" disabled={saving} onClick={() => void save(null)}>
            Reset to defaults
          </Button>
        ) : null}
        <Button disabled={!dirty || invalid.length > 0 || saving} onClick={() => void save(Object.fromEntries(parsed.map(({ f, value }) => [f.key, value * f.scale])) as Partial<RunLimits>)}>
          {saving ? "Saving…" : "Save limits"}
        </Button>
      </CardFooter>
    </Card>
  );
}
