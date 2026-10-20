import { useEffect, useRef, useState } from "react";
import { ChevronsUpDown, GitBranch } from "lucide-react";
import type { Branch } from "@nightshift/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api, messageOf } from "../api";
import { Spinner } from "./TaskBits";

type Result = { branches: Branch[]; total: number; error: string | null };

export function BranchPicker({
  id,
  projectId,
  value,
  defaultBranch,
  onChange,
  onDefaultBranch,
}: {
  id?: string;
  projectId: string;
  value: string;
  defaultBranch: string;
  onChange: (name: string) => void;
  onDefaultBranch?: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const reportDefault = useRef(onDefaultBranch);
  reportDefault.current = onDefaultBranch;

  useEffect(() => {
    const mine = ++seq.current;
    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(
      () => {
        api
          .branches(projectId, query.trim() || undefined, controller.signal)
          .then((res) => {
            if (mine !== seq.current) return;
            setResult({ branches: res.branches, total: res.total, error: res.error });
            if (res.defaultBranch) reportDefault.current?.(res.defaultBranch);
          })
          .catch((err: unknown) => {
            if (mine === seq.current && !controller.signal.aborted) setResult({ branches: [], total: 0, error: messageOf(err) });
          })
          .finally(() => {
            if (mine === seq.current) setLoading(false);
          });
      },
      query ? 250 : 0,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [projectId, query]);

  const error = result?.error ?? null;
  const branches = result?.branches ?? [];
  const pick = (name: string) => {
    onChange(name);
    setOpen(false);
    setQuery("");
  };

  return (
    <div className="grid gap-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button id={id} type="button" variant="outline" role="combobox" aria-expanded={open} className="w-full justify-between font-normal">
            <span className="flex min-w-0 items-center gap-2">
              <GitBranch className="text-muted-foreground" />
              <span className="truncate font-mono text-sm">{value || <span className="font-sans text-muted-foreground">Choose a branch…</span>}</span>
              {value === defaultBranch ? (
                <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                  default
                </Badge>
              ) : null}
            </span>
            <ChevronsUpDown className="text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-(--radix-popover-trigger-width) min-w-72 p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput placeholder="Search branches…" value={query} onValueChange={setQuery} />
            <CommandList className="max-h-[min(320px,50vh)]">
              {error ? (
                <div className="px-3 py-4 text-sm text-destructive" role="alert">
                  {error}
                </div>
              ) : null}
              {!error && loading && !result ? (
                <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
                  <Spinner className="size-3.5" /> Loading branches…
                </div>
              ) : null}
              {!error && result && branches.length === 0 && !loading ? <CommandEmpty>No branches match “{query}”.</CommandEmpty> : null}
              {branches.length > 0 ? (
                <CommandGroup heading={loading ? "Searching…" : result && result.total > branches.length ? `${branches.length} of ${result.total} branches` : undefined}>
                  {branches.map((b) => (
                    <CommandItem key={b.name} value={b.name} onSelect={() => pick(b.name)} data-checked={b.name === value}>
                      <GitBranch className="text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate font-mono text-sm">{b.name}</span>
                      {b.isDefault ? (
                        <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                          default
                        </Badge>
                      ) : null}
                      <span className="font-mono text-xs text-muted-foreground">{b.sha.slice(0, 7)}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {error ? <p className="text-xs text-amber-700 dark:text-amber-300">Could not list branches. The task starts from {value}.</p> : null}
    </div>
  );
}
