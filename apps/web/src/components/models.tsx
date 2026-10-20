import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Brain, ChevronsUpDown, Image as ImageIcon, Star } from "lucide-react";
import { toast } from "sonner";
import type { ModelChoice, ModelInfo, ModelSettings, ModelsResponse, ProviderStatus } from "@nightshift/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { messageOf, modelsApi } from "../api";
import { Spinner } from "./TaskBits";

type ModelsStore = { data: ModelsResponse | null; error: string | null; loading: boolean };

let store: ModelsStore = { data: null, error: null, loading: false };
const subscribers = new Set<() => void>();
const emit = (next: Partial<ModelsStore>) => {
  store = { ...store, ...next };
  for (const fn of subscribers) fn();
};

export const refreshModels = async () => {
  emit({ loading: true });
  try {
    const data = await modelsApi.get();
    emit({ data, error: null, loading: false });
  } catch (err) {
    emit({ error: messageOf(err), loading: false });
  }
};

export const setModelSettings = (settings: ModelSettings) => {
  if (store.data) emit({ data: { ...store.data, settings } });
};

export const setProviderStatus = (provider: ProviderStatus) => {
  if (store.data) emit({ data: { ...store.data, providers: store.data.providers.map((p) => (p.id === provider.id ? provider : p)) } });
};

export function useModels() {
  const snapshot = useSyncExternalStore(
    (fn) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    () => store,
  );
  useEffect(() => {
    if (!store.data && !store.loading) void refreshModels();
  }, []);
  return snapshot;
}

export const choiceKey = (c: ModelChoice) => `${c.provider}/${c.modelId}`;
export const sameChoice = (a: ModelChoice | null | undefined, b: ModelChoice | null | undefined) => Boolean(a && b && a.provider === b.provider && a.modelId === b.modelId);

const infoCache = new Map<string, ModelInfo>();
const infoSubs = new Set<() => void>();
const pending = new Set<string>();
let infoVersion = 0;

const remember = (models: ModelInfo[]) => {
  let changed = false;
  for (const m of models) {
    const key = choiceKey({ provider: m.provider, modelId: m.id });
    if (!infoCache.has(key)) changed = true;
    infoCache.set(key, m);
  }
  if (changed) {
    infoVersion++;
    for (const fn of infoSubs) fn();
  }
};

const resolveInfo = (c: ModelChoice) => {
  const key = choiceKey(c);
  if (infoCache.has(key) || pending.has(key)) return;
  pending.add(key);
  modelsApi
    .catalog(c.provider, c.modelId)
    .then((res) => remember(res.models))
    .catch(() => undefined)
    .finally(() => pending.delete(key));
};

export function useModelInfo(choices: Array<ModelChoice | null | undefined>) {
  useSyncExternalStore(
    (fn) => {
      infoSubs.add(fn);
      return () => infoSubs.delete(fn);
    },
    () => infoVersion,
  );
  const keys = choices.filter((c): c is ModelChoice => Boolean(c)).map(choiceKey).join(",");
  useEffect(() => {
    for (const k of keys ? keys.split(",") : []) {
      const i = k.indexOf("/");
      resolveInfo({ provider: k.slice(0, i), modelId: k.slice(i + 1) });
    }
  }, [keys]);
  return (c: ModelChoice) => infoCache.get(choiceKey(c)) ?? null;
}

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

export const formatContext = (n: number | null) => (n ? `${compact.format(n)} ctx` : null);

const price = (n: number) => `$${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}`;

export const formatPrice = (cost: ModelInfo["cost"]) => {
  if (!cost) return null;
  if (cost.input === 0 && cost.output === 0) return "Free";
  return `${price(cost.input)} / ${price(cost.output)} per 1M`;
};

export const providerName = (providers: ProviderStatus[] | undefined, id: string) => providers?.find((p) => p.id === id)?.name ?? id;

const PROVIDER_STYLE: Record<string, string> = {
  anthropic: "bg-orange-500/15 text-orange-700 dark:text-orange-300",
  openai: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  openrouter: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
};

export function ProviderMark({ id, name, className }: { id: string; name: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-sm font-semibold", PROVIDER_STYLE[id] ?? "bg-muted text-muted-foreground", className)}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function ModelBadges({ model }: { model: ModelInfo }) {
  return (
    <>
      {model.input.includes("image") ? (
        <Badge variant="outline" className="h-5 gap-1 px-1.5 text-[10px]" title="Accepts images">
          <ImageIcon className="size-3" /> Images
        </Badge>
      ) : null}
      {model.reasoning ? (
        <Badge variant="outline" className="h-5 gap-1 px-1.5 text-[10px]" title="Supports extended reasoning">
          <Brain className="size-3" /> Reasoning
        </Badge>
      ) : null}
    </>
  );
}

export function ModelMeta({ model }: { model: ModelInfo }) {
  const parts = [formatContext(model.contextWindow), formatPrice(model.cost)].filter(Boolean);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
      <code className="truncate font-mono">{model.id}</code>
      {parts.map((p) => (
        <span key={p} className="whitespace-nowrap">
          · {p}
        </span>
      ))}
    </span>
  );
}

export function useToggleFavorite() {
  const { data } = useModels();
  return useCallback(
    async (choice: ModelChoice) => {
      const settings = data?.settings;
      if (!settings) return;
      const exists = settings.favorites.some((f) => sameChoice(f, choice));
      const favorites = exists ? settings.favorites.filter((f) => !sameChoice(f, choice)) : [...settings.favorites, choice];
      const prev = settings;
      setModelSettings({ ...settings, favorites });
      try {
        const res = await modelsApi.saveSettings({ ...settings, favorites });
        setModelSettings({ ...res.settings });
        toast.success(exists ? "Removed from favorites" : "Added to favorites");
      } catch (err) {
        setModelSettings(prev);
        toast.error("Could not update favorites", { description: messageOf(err) });
      }
    },
    [data?.settings],
  );
}

type NullOption = { label: ReactNode; text: string };

function FavoriteStar({ active, onToggle, label }: { active: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <Star className={cn("size-4", active && "fill-amber-400 text-amber-500")} />
    </button>
  );
}

function ModelItem({
  model,
  selected,
  favorite,
  connected,
  providerLabel,
  onPick,
  onToggleFavorite,
}: {
  model: ModelInfo;
  selected: boolean;
  favorite: boolean;
  connected: boolean;
  providerLabel: string;
  onPick: () => void;
  onToggleFavorite: () => void;
}) {
  return (
    <CommandItem
      value={`${model.provider}/${model.id}`}
      onSelect={onPick}
      data-checked={selected}
      aria-disabled={!connected || undefined}
      className={cn("items-start gap-2 py-2", !connected && "opacity-60")}
    >
      <FavoriteStar active={favorite} onToggle={onToggleFavorite} label={favorite ? `Remove ${model.name} from favorites` : `Add ${model.name} to favorites`} />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="truncate font-medium">{model.name}</span>
          <ModelBadges model={model} />
          {!connected ? (
            <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
              {providerLabel} not connected
            </Badge>
          ) : null}
        </span>
        <ModelMeta model={model} />
      </span>
    </CommandItem>
  );
}

const PROVIDER_FILTERS = (providers: ProviderStatus[]) => [{ id: "", name: "All" }, ...providers.map((p) => ({ id: p.id, name: p.name }))];

export function ModelSearch({
  value,
  onPick,
  nullOption,
  onPickNull,
  autoFocus,
}: {
  value: ModelChoice | null;
  onPick: (m: ModelInfo) => void;
  nullOption?: NullOption;
  onPickNull?: () => void;
  autoFocus?: boolean;
}) {
  const { data } = useModels();
  const toggleFavorite = useToggleFavorite();
  const providers = useMemo(() => data?.providers ?? [], [data?.providers]);
  const favorites = useMemo(() => data?.settings.favorites ?? [], [data?.settings.favorites]);
  const info = useModelInfo(favorites);
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("");
  const [results, setResults] = useState<{ models: ModelInfo[]; total: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    setLoading(true);
    const timer = window.setTimeout(
      () => {
        modelsApi
          .catalog(provider || undefined, query.trim() || undefined)
          .then((res) => {
            if (mine !== seq.current) return;
            remember(res.models);
            setResults(res);
            setError(null);
          })
          .catch((err) => {
            if (mine === seq.current) setError(messageOf(err));
          })
          .finally(() => {
            if (mine === seq.current) setLoading(false);
          });
      },
      query ? 250 : 0,
    );
    return () => window.clearTimeout(timer);
  }, [query, provider]);

  const connectedIds = new Set(providers.filter((p) => p.connected).map((p) => p.id));
  const isFav = (m: ModelInfo) => favorites.some((f) => f.provider === m.provider && f.modelId === m.id);
  const q = query.trim().toLowerCase();
  const favModels = favorites
    .map((f) => info(f) ?? ({ provider: f.provider, id: f.modelId, name: f.modelId, contextWindow: null, maxTokens: null, input: ["text"], reasoning: false, cost: null } satisfies ModelInfo))
    .filter((m) => (!provider || m.provider === provider) && (!q || `${m.id} ${m.name}`.toLowerCase().includes(q)));
  const favKeys = new Set(favModels.map((m) => `${m.provider}/${m.id}`));
  const rest = (results?.models ?? []).filter((m) => !favKeys.has(`${m.provider}/${m.id}`));
  const groups = providers.map((p) => ({ provider: p, models: rest.filter((m) => m.provider === p.id) })).filter((g) => g.models.length > 0);
  const others = rest.filter((m) => !providers.some((p) => p.id === m.provider));
  if (others.length) groups.push({ provider: { id: "other", name: "Other" } as ProviderStatus, models: others });

  const pick = (m: ModelInfo) => {
    if (!connectedIds.has(m.provider)) {
      toast.warning(`Connect ${providerName(providers, m.provider)} first`, { description: "Add an API key or sign in on the Models page, then pick this model." });
      return;
    }
    onPick(m);
  };

  const item = (m: ModelInfo) => (
    <ModelItem
      key={`${m.provider}/${m.id}`}
      model={m}
      selected={sameChoice(value, { provider: m.provider, modelId: m.id })}
      favorite={isFav(m)}
      connected={connectedIds.has(m.provider)}
      providerLabel={providerName(providers, m.provider)}
      onPick={() => pick(m)}
      onToggleFavorite={() => void toggleFavorite({ provider: m.provider, modelId: m.id })}
    />
  );

  return (
    <Command shouldFilter={false} className="rounded-lg!">
      <CommandInput placeholder="Search models by name or id…" value={query} onValueChange={setQuery} autoFocus={autoFocus} />
      <div className="flex flex-wrap items-center gap-1 border-b px-2 py-1.5" role="group" aria-label="Filter by provider">
        {PROVIDER_FILTERS(providers).map((p) => (
          <Button key={p.id || "all"} type="button" size="xs" variant={provider === p.id ? "secondary" : "ghost"} aria-pressed={provider === p.id} onClick={() => setProvider(p.id)}>
            {p.name}
          </Button>
        ))}
        {loading ? <Spinner className="ml-auto size-3.5" label="Searching" /> : null}
      </div>
      <CommandList className="max-h-[min(420px,60vh)]">
        {error ? <div className="px-3 py-4 text-sm text-destructive">{error}</div> : null}
        {!loading && !error && favModels.length === 0 && groups.length === 0 ? <CommandEmpty>No models match “{query}”.</CommandEmpty> : null}
        {nullOption && !q ? (
          <CommandGroup>
            <CommandItem value="__null__" onSelect={() => onPickNull?.()} data-checked={value === null}>
              <span className="inline-flex size-7 shrink-0" aria-hidden="true" />
              {nullOption.label}
            </CommandItem>
          </CommandGroup>
        ) : null}
        {favModels.length ? <CommandGroup heading="Favorites">{favModels.map(item)}</CommandGroup> : null}
        {groups.map((g) => (
          <CommandGroup key={g.provider.id} heading={g.provider.name}>
            {g.models.map(item)}
          </CommandGroup>
        ))}
        {results && results.total > results.models.length ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            Showing {results.models.length} of {results.total}. Type to narrow the list.
          </p>
        ) : null}
      </CommandList>
    </Command>
  );
}

export function ModelPicker({
  id,
  value,
  onChange,
  nullOption,
  ariaDescribedBy,
  disabled,
}: {
  id?: string;
  value: ModelChoice | null;
  onChange: (next: ModelChoice | null) => void;
  nullOption?: NullOption;
  ariaDescribedBy?: string;
  disabled?: boolean;
}) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const { data } = useModels();
  const info = useModelInfo([value]);
  const current = value ? info(value) : null;
  const provider = value ? data?.providers.find((p) => p.id === value.provider) : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id ?? uid}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-describedby={ariaDescribedBy}
          disabled={disabled}
          className="h-auto min-h-9 w-full justify-between gap-2 py-1.5 text-left font-normal"
        >
          {value ? (
            <span className="flex min-w-0 items-center gap-2">
              <ProviderMark id={value.provider} name={provider?.name ?? value.provider} className="size-6 rounded-md text-xs" />
              <span className="grid min-w-0">
                <span className="truncate">{current?.name ?? value.modelId}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {provider?.name ?? value.provider} · {value.modelId}
                </span>
              </span>
              {provider && !provider.connected ? (
                <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                  Not connected
                </Badge>
              ) : null}
            </span>
          ) : (
            <span className="truncate">{nullOption?.label ?? <span className="text-muted-foreground">Choose a model</span>}</span>
          )}
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(36rem,calc(100vw-2rem))] p-0" align="start">
        <ModelSearch
          autoFocus
          value={value}
          nullOption={nullOption}
          onPickNull={() => {
            onChange(null);
            setOpen(false);
          }}
          onPick={(m) => {
            onChange({ provider: m.provider, modelId: m.id });
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

export function useModelLabel() {
  const { data } = useModels();
  const info = useModelInfo([data?.settings.default, data?.settings.review]);
  return (c: ModelChoice | null | undefined) => (c ? (info(c)?.name ?? c.modelId) : null);
}
