import { useState } from "react";
import { BookOpen, Bug, ChevronDown, CircleHelp, FlaskConical, Palette, Plus, ScanSearch, Sparkles, TrendingUp, Wand2, Wrench, type LucideIcon } from "lucide-react";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import { toast } from "sonner";
import { TASK_TYPES, taskTypeInfo, type TaskType } from "@nightshift/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { api, messageOf } from "../api";
import { Spinner } from "./TaskBits";

export const DEFAULT_TASK_TYPE: TaskType = "feature";

export const TASK_TYPE_META: Record<TaskType, { icon: LucideIcon; badge: string; text: string; chip: string }> = {
  feature: {
    icon: Sparkles,
    badge: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
    text: "text-sky-600 dark:text-sky-400",
    chip: "data-[state=checked]:border-sky-500/60 data-[state=checked]:bg-sky-500/10 data-[state=checked]:ring-sky-500/30",
  },
  bug: {
    icon: Bug,
    badge: "bg-red-500/15 text-red-700 dark:text-red-300",
    text: "text-red-600 dark:text-red-400",
    chip: "data-[state=checked]:border-red-500/60 data-[state=checked]:bg-red-500/10 data-[state=checked]:ring-red-500/30",
  },
  improvement: {
    icon: TrendingUp,
    badge: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    text: "text-emerald-600 dark:text-emerald-400",
    chip: "data-[state=checked]:border-emerald-500/60 data-[state=checked]:bg-emerald-500/10 data-[state=checked]:ring-emerald-500/30",
  },
  refactor: {
    icon: Wand2,
    badge: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
    text: "text-violet-600 dark:text-violet-400",
    chip: "data-[state=checked]:border-violet-500/60 data-[state=checked]:bg-violet-500/10 data-[state=checked]:ring-violet-500/30",
  },
  design: {
    icon: Palette,
    badge: "bg-pink-500/15 text-pink-700 dark:text-pink-300",
    text: "text-pink-600 dark:text-pink-400",
    chip: "data-[state=checked]:border-pink-500/60 data-[state=checked]:bg-pink-500/10 data-[state=checked]:ring-pink-500/30",
  },
  docs: {
    icon: BookOpen,
    badge: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    text: "text-amber-600 dark:text-amber-400",
    chip: "data-[state=checked]:border-amber-500/60 data-[state=checked]:bg-amber-500/10 data-[state=checked]:ring-amber-500/30",
  },
  test: {
    icon: FlaskConical,
    badge: "bg-teal-500/15 text-teal-700 dark:text-teal-300",
    text: "text-teal-600 dark:text-teal-400",
    chip: "data-[state=checked]:border-teal-500/60 data-[state=checked]:bg-teal-500/10 data-[state=checked]:ring-teal-500/30",
  },
  chore: {
    icon: Wrench,
    badge: "bg-muted text-muted-foreground",
    text: "text-muted-foreground",
    chip: "data-[state=checked]:border-foreground/30 data-[state=checked]:bg-muted data-[state=checked]:ring-foreground/10",
  },
  review: {
    icon: ScanSearch,
    badge: "bg-orange-500/15 text-orange-700 dark:text-orange-300",
    text: "text-orange-600 dark:text-orange-400",
    chip: "data-[state=checked]:border-orange-500/60 data-[state=checked]:bg-orange-500/10 data-[state=checked]:ring-orange-500/30",
  },
};

export const taskTypeLabel = (type: TaskType | null | undefined) => taskTypeInfo(type)?.label ?? null;

export function TaskTypeIcon({ type, className }: { type: TaskType; className?: string }) {
  const meta = TASK_TYPE_META[type];
  const Icon = meta.icon;
  return <Icon aria-hidden="true" className={cn("size-3.5 shrink-0", meta.text, className)} />;
}

export function TaskTypeBadge({ type, className }: { type: TaskType | null | undefined; className?: string }) {
  const info = taskTypeInfo(type);
  if (!info) return null;
  const meta = TASK_TYPE_META[info.type];
  const Icon = meta.icon;
  return (
    <Badge variant="secondary" title={`${info.label}: ${info.description}`} className={cn("gap-1", meta.badge, className)}>
      <Icon aria-hidden="true" />
      {info.label}
    </Badge>
  );
}

export function TaskTypePicker({ value, onChange, labelledBy, describedBy, disabled }: { value: TaskType; onChange: (type: TaskType) => void; labelledBy: string; describedBy: string; disabled?: boolean }) {
  return (
    <RadioGroupPrimitive.Root
      value={value}
      onValueChange={(v) => onChange(v as TaskType)}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      disabled={disabled}
      className="grid grid-cols-2 gap-1.5 sm:grid-cols-4"
    >
      {TASK_TYPES.map((t) => {
        const meta = TASK_TYPE_META[t.type];
        const Icon = meta.icon;
        return (
          <RadioGroupPrimitive.Item
            key={t.type}
            value={t.type}
            className={cn(
              "group flex h-9 min-w-0 items-center gap-2 rounded-lg border bg-background px-2.5 text-left text-sm text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-[state=checked]:font-medium data-[state=checked]:text-foreground data-[state=checked]:ring-1 dark:bg-input/30 dark:hover:bg-input/50",
              meta.chip,
            )}
          >
            <Icon aria-hidden="true" className={cn("size-4 shrink-0 opacity-70 group-data-[state=checked]:opacity-100", meta.text)} />
            <span className="truncate">{t.label}</span>
          </RadioGroupPrimitive.Item>
        );
      })}
    </RadioGroupPrimitive.Root>
  );
}

export function TaskTypeGuidance({ type }: { type: TaskType | null }) {
  const info = taskTypeInfo(type);
  if (!info) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="icon-xs" variant="ghost" className="text-muted-foreground" aria-label={`What the agent does for ${info.label} tasks`}>
          <CircleHelp />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)] gap-2 p-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <TaskTypeIcon type={info.type} className="size-4" />
          What the agent does for {info.label} tasks
        </div>
        <ul className="grid list-disc gap-1.5 pl-5 text-xs leading-relaxed text-muted-foreground marker:text-muted-foreground/60">
          {info.guidance.map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ul>
        {info.review.length > 0 ? (
          <div className="grid gap-1 border-t pt-2">
            <div className="text-xs font-medium">The review checks</div>
            <ul className="grid list-disc gap-1 pl-5 text-xs leading-relaxed text-muted-foreground marker:text-muted-foreground/60">
              {info.review.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

export function TaskTypeMenu({
  projectId,
  taskId,
  type,
  runActive,
  onChanged,
}: {
  projectId: string;
  taskId: string;
  type: TaskType | null;
  runActive: boolean;
  onChanged: (type: TaskType | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const info = taskTypeInfo(type);

  const change = async (next: TaskType | null) => {
    if (busy || next === type) return;
    setBusy(true);
    try {
      const res = await api.setTaskType(projectId, taskId, next);
      onChanged(res.type);
      const label = taskTypeLabel(res.type);
      toast.success(label ? `Type set to ${label}` : "Type cleared", runActive ? { description: "The agent uses this from its next step." } : undefined);
    } catch (err) {
      toast.error("Could not change the type", { description: messageOf(err) });
    } finally {
      setBusy(false);
    }
  };

  const meta = info ? TASK_TYPE_META[info.type] : null;
  const Icon = meta?.icon ?? Plus;

  return (
    <span className="inline-flex items-center gap-0.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={busy}
            aria-label={info ? `Task type: ${info.label}. Change type` : "Set task type"}
            className={cn(
              "inline-flex h-5 items-center gap-1 rounded-4xl border border-transparent px-2 text-xs font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60 [&_svg]:size-3",
              meta ? cn(meta.badge, "hover:brightness-95 dark:hover:brightness-125") : "border-dashed border-border text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {busy ? <Spinner className="size-3 text-current" /> : <Icon aria-hidden="true" />}
            {info ? info.label : "Set type"}
            <ChevronDown aria-hidden="true" className="opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuLabel>Task type</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={type ?? ""} onValueChange={(v) => void change(v as TaskType)}>
            {TASK_TYPES.map((t) => (
              <DropdownMenuRadioItem key={t.type} value={t.type} className="items-start py-1.5">
                <TaskTypeIcon type={t.type} className="mt-0.5 size-4" />
                <span className="grid gap-0.5">
                  <span>{t.label}</span>
                  <span className="text-xs leading-snug text-muted-foreground">{t.description}</span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {type ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void change(null)} className="text-muted-foreground">
                Clear type
              </DropdownMenuItem>
            </>
          ) : null}
          {runActive ? <p className="px-2 pt-1 pb-1.5 text-xs text-muted-foreground">Changes apply from the agent's next step.</p> : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <TaskTypeGuidance type={type} />
    </span>
  );
}
