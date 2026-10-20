import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, Copy, ExternalLink, Eye, EyeOff, KeyRound, LogIn, Plug, Plus, RefreshCw, Star, Unplug, X } from "lucide-react";
import { toast } from "sonner";
import type { LoginEvent, LoginState, ModelChoice, ModelSettings, ProviderStatus, TestResult } from "@nightshift/core";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { messageOf, modelsApi } from "../api";
import { Notice } from "../components/Notice";
import { Field } from "../components/ProjectForm";
import { Page, PageHeader, Spinner, ToneBadge } from "../components/TaskBits";
import {
  ModelBadges,
  ModelMeta,
  ModelPicker,
  ModelSearch,
  ProviderMark,
  refreshModels,
  sameChoice,
  setModelSettings,
  setProviderStatus,
  useModelInfo,
  useModels,
  useToggleFavorite,
} from "../components/models";
import { copyText } from "../workspace/common";

const SUBSCRIPTION_NOTE = "Uses your personal plan's limits. Check the provider's terms for automated or third-party use.";

async function copy(value: string) {
  if (await copyText(value)) toast.success("Copied to clipboard");
  else toast.error("Could not copy");
}

function ApiKeyForm({ provider }: { provider: ProviderStatus }) {
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = `key-${provider.id}`;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!key.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const next = await modelsApi.saveApiKey(provider.id, key.trim());
      setProviderStatus(next);
      setKey("");
      setShow(false);
      toast.success(`${provider.name} API key saved`);
      void refreshModels();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="grid gap-2" onSubmit={(e) => void save(e)}>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={inputId}>API key</Label>
        {provider.apiKeyUrl ? (
          <a href={provider.apiKeyUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            Get a key <ExternalLink className="size-3" />
          </a>
        ) : null}
      </div>
      <div className="flex gap-2">
        <InputGroup className="min-w-0 flex-1">
          <InputGroupInput
            id={inputId}
            type={show ? "text" : "password"}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={provider.connected && provider.via === "api_key" ? "Enter a new key to replace the current one" : "Paste your API key"}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            aria-invalid={Boolean(error)}
            aria-describedby={`${inputId}-hint`}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton size="icon-xs" aria-label={show ? "Hide key" : "Show key"} aria-pressed={show} onClick={() => setShow((v) => !v)}>
              {show ? <EyeOff /> : <Eye />}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        <Button type="submit" disabled={!key.trim() || saving}>
          {saving ? <Spinner className="size-3.5" /> : <KeyRound />}
          Save key
        </Button>
      </div>
      <p id={`${inputId}-hint`} className={error ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
        {error ?? "Stored by the Nightshift daemon on this machine. Billed to your API account."}
      </p>
    </form>
  );
}

function SubscriptionPanel({ provider, onSignIn, starting }: { provider: ProviderStatus; onSignIn: () => void; starting: boolean }) {
  const signedIn = provider.connected && provider.via === "oauth";
  return (
    <div className="grid gap-3">
      <p className="text-sm">
        Sign in with your <span className="font-medium">{provider.oauthLabel ?? `${provider.name} account`}</span> instead of using an API key.
      </p>
      <div>
        <Button type="button" variant={signedIn ? "outline" : "default"} onClick={onSignIn} disabled={starting}>
          {starting ? <Spinner className="size-3.5" /> : <LogIn />}
          {signedIn ? "Sign in again" : "Sign in"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{SUBSCRIPTION_NOTE}</p>
    </div>
  );
}

function TestOutcome({ result }: { result: TestResult }) {
  return result.ok ? (
    <Notice title={`Connected in ${result.latencyMs} ms`}>
      <span className="font-mono text-xs">{result.model.modelId}</span>
      {result.reply ? <> replied “{result.reply.slice(0, 160)}”</> : null}
    </Notice>
  ) : (
    <Notice tone="danger" title="Test failed">
      {result.error ?? "The provider did not answer."}
    </Notice>
  );
}

function ProviderCard({ provider, settings, onLogin }: { provider: ProviderStatus; settings: ModelSettings; onLogin: (state: LoginState) => void }) {
  const [method, setMethod] = useState(provider.via ?? provider.methods[0] ?? "api_key");
  const [starting, setStarting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    if (provider.via) setMethod(provider.via);
  }, [provider.via]);

  const signIn = async () => {
    setStarting(true);
    try {
      onLogin(await modelsApi.login(provider.id));
    } catch (err) {
      toast.error(`Could not start sign-in for ${provider.name}`, { description: messageOf(err) });
    } finally {
      setStarting(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const modelId = settings.default.provider === provider.id ? settings.default.modelId : undefined;
      setResult(await modelsApi.test(provider.id, modelId));
    } catch (err) {
      setResult({ ok: false, latencyMs: 0, reply: null, error: messageOf(err), model: { provider: provider.id, modelId: "" } });
    } finally {
      setTesting(false);
    }
  };

  const disconnect = async () => {
    setDisconnecting(true);
    try {
      await modelsApi.disconnect(provider.id);
      setResult(null);
      toast.success(`${provider.name} disconnected`);
      await refreshModels();
    } catch (err) {
      toast.error(`Could not disconnect ${provider.name}`, { description: messageOf(err) });
    } finally {
      setDisconnecting(false);
    }
  };

  const supportsKey = provider.methods.includes("api_key");
  const supportsOauth = provider.methods.includes("oauth");
  const badge = provider.error
    ? { tone: "danger" as const, label: "Error" }
    : provider.connected
      ? { tone: "success" as const, label: provider.via === "oauth" ? "Signed in" : "Connected" }
      : { tone: "muted" as const, label: "Not connected" };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-3">
          <ProviderMark id={provider.id} name={provider.name} />
          {provider.name}
        </CardTitle>
        <CardDescription>
          {provider.connected ? <>Using {provider.source ?? (provider.via === "oauth" ? "subscription sign-in" : "an API key")}</> : "Add an API key or sign in to use its models."}
        </CardDescription>
        <CardAction>
          <ToneBadge tone={badge.tone}>{badge.label}</ToneBadge>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4">
        {provider.error ? (
          <Notice tone="danger" title="Connection problem">
            {provider.error}
          </Notice>
        ) : null}
        {supportsKey && supportsOauth ? (
          <Tabs value={method} onValueChange={(v) => setMethod(v as typeof method)}>
            <TabsList className="w-full sm:w-auto">
              <TabsTrigger value="api_key">
                <KeyRound /> API key
              </TabsTrigger>
              <TabsTrigger value="oauth">
                <LogIn /> Subscription sign-in
              </TabsTrigger>
            </TabsList>
            <TabsContent value="api_key" className="pt-2">
              <ApiKeyForm provider={provider} />
            </TabsContent>
            <TabsContent value="oauth" className="pt-2">
              <SubscriptionPanel provider={provider} onSignIn={() => void signIn()} starting={starting} />
            </TabsContent>
          </Tabs>
        ) : supportsKey ? (
          <ApiKeyForm provider={provider} />
        ) : supportsOauth ? (
          <SubscriptionPanel provider={provider} onSignIn={() => void signIn()} starting={starting} />
        ) : null}
        {result ? <TestOutcome result={result} /> : null}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2 border-t">
        <Button type="button" variant="outline" size="sm" onClick={() => void test()} disabled={!provider.connected || testing}>
          {testing ? <Spinner className="size-3" /> : <Plug />}
          Test connection
        </Button>
        <Button type="button" variant="ghost" size="sm" className="ml-auto text-destructive hover:text-destructive" onClick={() => setConfirm(true)} disabled={!provider.connected || disconnecting}>
          {disconnecting ? <Spinner className="size-3" /> : <Unplug />}
          Disconnect
        </Button>
      </CardFooter>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {provider.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Nightshift forgets the stored {provider.via === "oauth" ? "sign-in" : "API key"}. Agents set to use {provider.name} models stop working until you connect it again. A key set in an
              environment variable stays in use until you remove it there.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void disconnect()}>
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function EventView({ event, last, running }: { event: LoginEvent; last: boolean; running: boolean }) {
  switch (event.type) {
    case "auth_url":
      return (
        <div className="grid gap-2 rounded-lg border bg-muted/40 p-3">
          {event.instructions ? <p className="text-sm">{event.instructions}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <a href={event.url} target="_blank" rel="noopener noreferrer">
                <ExternalLink /> Open sign-in page
              </a>
            </Button>
            <Button type="button" variant="outline" onClick={() => void copy(event.url)}>
              <Copy /> Copy link
            </Button>
          </div>
          <code className="truncate font-mono text-xs text-muted-foreground" title={event.url}>
            {event.url}
          </code>
        </div>
      );
    case "device_code":
      return (
        <div className="grid justify-items-center gap-2 rounded-lg border bg-muted/40 p-4 text-center">
          <p className="text-sm">Enter this code on the sign-in page</p>
          <div className="flex items-center gap-2">
            <code className="rounded-md bg-background px-3 py-2 font-mono text-2xl font-semibold tracking-[0.2em]">{event.userCode}</code>
            <Button type="button" variant="ghost" size="icon" aria-label="Copy code" onClick={() => void copy(event.userCode)}>
              <Copy />
            </Button>
          </div>
          <Button asChild variant="outline" size="sm">
            <a href={event.verificationUri} target="_blank" rel="noopener noreferrer">
              <ExternalLink /> {event.verificationUri}
            </a>
          </Button>
          {event.expiresInSeconds ? <p className="text-xs text-muted-foreground">Expires in {Math.round(event.expiresInSeconds / 60)} minutes</p> : null}
        </div>
      );
    case "info":
      return (
        <p className="text-sm text-muted-foreground">
          {event.message}
          {event.links?.map((l) => (
            <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer" className="ml-2 underline underline-offset-4">
              {l.label ?? l.url}
            </a>
          ))}
        </p>
      );
    case "progress":
      return (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          {last && running ? <Spinner className="size-3.5" /> : <Check className="size-3.5" />}
          {event.message}
        </p>
      );
  }
}

function PromptForm({ login, onAnswered }: { login: LoginState; onAnswered: (s: LoginState) => void }) {
  const prompt = login.prompt;
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!prompt) return null;

  const send = async (answer: string) => {
    if (!answer.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      onAnswered(await modelsApi.answer(login.id, prompt.id, answer.trim()));
      setValue("");
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSending(false);
    }
  };

  const id = `prompt-${prompt.id}`;
  if (prompt.type === "select") {
    return (
      <div className="grid gap-2">
        <Label htmlFor={id}>{prompt.message}</Label>
        <RadioGroup id={id} value={value} onValueChange={setValue} className="grid gap-2">
          {(prompt.options ?? []).map((o) => (
            <Label key={o.id} htmlFor={`${id}-${o.id}`} className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal hover:bg-muted/50">
              <RadioGroupItem value={o.id} id={`${id}-${o.id}`} className="mt-0.5" />
              <span className="grid gap-0.5">
                <span className="font-medium">{o.label}</span>
                {o.description ? <span className="text-xs text-muted-foreground">{o.description}</span> : null}
              </span>
            </Label>
          ))}
        </RadioGroup>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <div>
          <Button type="button" onClick={() => void send(value)} disabled={!value || sending}>
            {sending ? <Spinner className="size-3.5" /> : null} Continue
          </Button>
        </div>
      </div>
    );
  }
  return (
    <form
      className="grid gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void send(value);
      }}
    >
      <Label htmlFor={id}>{prompt.message}</Label>
      <div className="flex gap-2">
        <Input
          id={id}
          autoFocus
          type={prompt.type === "secret" ? "password" : "text"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={prompt.placeholder}
          className={prompt.type === "text" ? undefined : "font-mono"}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={Boolean(error)}
        />
        <Button type="submit" disabled={!value.trim() || sending}>
          {sending ? <Spinner className="size-3.5" /> : null} Submit
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : prompt.type === "manual_code" ? <p className="text-xs text-muted-foreground">Copy the code from the page you signed in on and paste it here.</p> : null}
    </form>
  );
}

function LoginDialog({ initial, provider, onClose }: { initial: LoginState; provider: ProviderStatus | undefined; onClose: () => void }) {
  const [login, setLogin] = useState(initial);
  const [cancelling, setCancelling] = useState(false);
  const finished = useRef(false);
  const active = login.status === "running" || login.status === "waiting";
  const name = provider?.name ?? login.provider;

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      modelsApi
        .loginState(login.id)
        .then(setLogin)
        .catch(() => undefined);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [active, login.id]);

  useEffect(() => {
    if (login.status !== "done" || finished.current) return;
    finished.current = true;
    toast.success(`Signed in to ${name}`);
    void refreshModels();
    onClose();
  }, [login.status, name, onClose]);

  const cancel = async () => {
    if (!active) return onClose();
    setCancelling(true);
    try {
      await modelsApi.cancelLogin(login.id);
    } catch {
      setCancelling(false);
    }
    onClose();
  };

  const retry = async () => {
    try {
      setLogin(await modelsApi.login(login.provider));
    } catch (err) {
      toast.error("Could not start sign-in", { description: messageOf(err) });
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (!open ? void cancel() : undefined)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Sign in to {name}</DialogTitle>
          <DialogDescription>{provider?.oauthLabel ? `Connect your ${provider.oauthLabel}.` : "Follow the steps below."}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3" aria-live="polite">
          {login.events.map((e, i) => (
            <EventView key={i} event={e} last={i === login.events.length - 1} running={active && !login.prompt} />
          ))}
          {login.events.length === 0 && active ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="size-3.5" /> Starting…
            </p>
          ) : null}
          {login.prompt ? <PromptForm key={login.prompt.id} login={login} onAnswered={setLogin} /> : null}
          {login.status === "failed" ? (
            <Notice tone="danger" title="Sign-in failed">
              {login.error ?? "The provider rejected the sign-in."}
            </Notice>
          ) : null}
          {login.status === "cancelled" ? <Notice tone="warning">Sign-in was cancelled.</Notice> : null}
          <p className="text-xs text-muted-foreground">{SUBSCRIPTION_NOTE}</p>
        </div>
        <DialogFooter>
          {login.status === "failed" || login.status === "cancelled" ? (
            <>
              <Button type="button" variant="outline" onClick={onClose}>
                Close
              </Button>
              <Button type="button" onClick={() => void retry()}>
                <RefreshCw /> Try again
              </Button>
            </>
          ) : (
            <Button type="button" variant="outline" onClick={() => void cancel()} disabled={cancelling}>
              {cancelling ? <Spinner className="size-3.5" /> : <X />} Cancel
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DefaultModels({ settings }: { settings: ModelSettings }) {
  const [agent, setAgent] = useState<ModelChoice>(settings.default);
  const [review, setReview] = useState<ModelChoice | null>(settings.review);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAgent(settings.default);
    setReview(settings.review);
  }, [settings.default, settings.review]);

  const agentInfo = useModelInfo([agent]);
  const dirty = !sameChoice(agent, settings.default) || !(review === null ? settings.review === null : sameChoice(review, settings.review));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await modelsApi.saveSettings({ ...settings, default: agent, review });
      setModelSettings(res.settings);
      toast.success("Models saved");
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Default models</CardTitle>
        <CardDescription>Used by every project unless its settings pick a different model.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <Field id="models-agent" label="Agent model" hint="Writes the code, runs the checks and opens the pull request.">
          <ModelPicker id="models-agent" value={agent} onChange={(c) => c && setAgent(c)} ariaDescribedBy="models-agent-hint" />
        </Field>
        <Field id="models-review" label="Reviewer model" hint="Reviews the diff before the agent pushes, when AI review is on for a project.">
          <ModelPicker
            id="models-review"
            value={review}
            onChange={setReview}
            ariaDescribedBy="models-review-hint"
            nullOption={{ label: <>Same as agent model ({agentInfo(agent)?.name ?? agent.modelId})</>, text: "Same as agent model" }}
          />
        </Field>
        {error ? (
          <Notice tone="danger" title="Could not save">
            {error}
          </Notice>
        ) : null}
      </CardContent>
      <CardFooter className="flex justify-end gap-2 border-t">
        {dirty ? <span className="mr-auto text-sm text-muted-foreground">Unsaved changes</span> : null}
        <Button
          type="button"
          variant="outline"
          disabled={!dirty || saving}
          onClick={() => {
            setAgent(settings.default);
            setReview(settings.review);
          }}
        >
          Discard
        </Button>
        <Button type="button" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </CardFooter>
    </Card>
  );
}

function Favorites({ settings, providers }: { settings: ModelSettings; providers: ProviderStatus[] }) {
  const [open, setOpen] = useState(false);
  const toggle = useToggleFavorite();
  const info = useModelInfo(settings.favorites);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Favorite models</CardTitle>
        <CardDescription>Starred models are listed first in every model picker. Add any OpenRouter model here to make it easy to pick.</CardDescription>
        <CardAction>
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button type="button" size="sm" variant="outline">
                <Plus /> Add models
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[min(36rem,calc(100vw-2rem))] p-0" align="end">
              <ModelSearch
                autoFocus
                value={null}
                onPick={(m) => {
                  if (!settings.favorites.some((f) => f.provider === m.provider && f.modelId === m.id)) void toggle({ provider: m.provider, modelId: m.id });
                }}
              />
            </PopoverContent>
          </Popover>
        </CardAction>
      </CardHeader>
      <CardContent>
        {settings.favorites.length === 0 ? (
          <p className="text-sm text-muted-foreground">No favorites yet. Use Add models, or the star next to any model in a picker.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {settings.favorites.map((f) => {
              const m = info(f);
              const p = providers.find((x) => x.id === f.provider);
              return (
                <li key={`${f.provider}/${f.modelId}`} className="flex items-center gap-3 px-3 py-2">
                  <ProviderMark id={f.provider} name={p?.name ?? f.provider} className="size-7 rounded-md text-xs" />
                  <div className="grid min-w-0 flex-1 gap-0.5">
                    <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
                      <span className="truncate font-medium">{m?.name ?? f.modelId}</span>
                      {m ? <ModelBadges model={m} /> : null}
                      {p && !p.connected ? <span className="text-xs text-muted-foreground">{p.name} not connected</span> : null}
                    </span>
                    {m ? <ModelMeta model={m} /> : <code className="truncate font-mono text-xs text-muted-foreground">{f.modelId}</code>}
                  </div>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${m?.name ?? f.modelId} from favorites`} title="Remove from favorites" onClick={() => void toggle(f)}>
                    <Star className="fill-amber-400 text-amber-500" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function Models() {
  const { data, error, loading } = useModels();
  const [login, setLogin] = useState<LoginState | null>(null);

  useEffect(() => {
    void refreshModels();
  }, []);

  return (
    <Page narrow>
      <PageHeader
        title="Models"
        description="Connect model providers and choose which models agents use."
        actions={
          <Button variant="outline" onClick={() => void refreshModels()} disabled={loading}>
            {loading ? <Spinner className="size-3.5" /> : <RefreshCw />} Refresh
          </Button>
        }
      />
      {error && !data ? (
        <Notice tone="danger" title="Could not load models">
          {error}
        </Notice>
      ) : null}
      {!data ? (
        error ? null : (
          <div className="space-y-4">
            <Skeleton className="h-48 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        )
      ) : (
        <>
          <section className="space-y-3" aria-labelledby="models-providers">
            <h2 id="models-providers" className="text-sm font-medium text-muted-foreground">
              Providers
            </h2>
            {data.providers.map((p) => (
              <ProviderCard key={p.id} provider={p} settings={data.settings} onLogin={setLogin} />
            ))}
          </section>
          <section className="space-y-3" aria-labelledby="models-choice">
            <h2 id="models-choice" className="text-sm font-medium text-muted-foreground">
              Model choice
            </h2>
            <DefaultModels settings={data.settings} />
            <Favorites settings={data.settings} providers={data.providers} />
          </section>
        </>
      )}
      {login ? <LoginDialog key={login.id} initial={login} provider={data?.providers.find((p) => p.id === login.provider)} onClose={() => setLogin(null)} /> : null}
    </Page>
  );
}
