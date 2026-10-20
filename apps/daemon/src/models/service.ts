import { randomUUID } from "node:crypto";
import type { AuthEvent, AuthPrompt, CredentialStore, Models } from "@earendil-works/pi-ai";
import type {
  CatalogResponse,
  LoginEvent,
  LoginPrompt,
  LoginState,
  ModelChoice,
  ModelInfo,
  ModelSettings,
  ModelsResponse,
  ProviderStatus,
  TestResult,
} from "@nightshift/core";
import type { Store } from "@nightshift/store";

const PROVIDER_META: Record<string, { oauthLabel: string; apiKeyUrl: string }> = {
  anthropic: { oauthLabel: "Claude Pro/Max subscription", apiKeyUrl: "https://console.anthropic.com/settings/keys" },
  openai: { oauthLabel: "ChatGPT subscription (Sign in with ChatGPT)", apiKeyUrl: "https://platform.openai.com/api-keys" },
  openrouter: { oauthLabel: "OpenRouter account (creates a key for you)", apiKeyUrl: "https://openrouter.ai/settings/keys" },
};

type Session = {
  state: LoginState;
  answer: ((value: string) => void) | null;
  abort: AbortController;
  finishedAt: number | null;
};

export type ModelsServiceOptions = {
  models: Models;
  credentials: CredentialStore;
  store: Store;
  providers: string[];
  fallback: ModelChoice;
};

export class ModelsService {
  private readonly sessions = new Map<string, Session>();
  private billingCache: Record<string, "subscription" | "api" | "none"> = {};

  billing(): Record<string, "subscription" | "api" | "none"> {
    return { ...this.billingCache };
  }

  async refreshBilling() {
    const next: Record<string, "subscription" | "api" | "none"> = {};
    for (const id of this.o.providers) {
      try {
        const check = await this.o.models.checkAuth(id);
        next[id] = !check ? "none" : check.type === "oauth" ? "subscription" : "api";
      } catch {
        next[id] = "none";
      }
    }
    this.billingCache = next;
    return this.billing();
  }

  constructor(private readonly o: ModelsServiceOptions) {}

  settings(): ModelSettings {
    const saved = this.o.store.setting<ModelSettings | null>("modelSettings", null);
    return saved ?? { default: this.o.fallback, review: null, favorites: [] };
  }

  saveSettings(next: ModelSettings): ModelSettings {
    for (const choice of [next.default, ...(next.review ? [next.review] : [])]) {
      if (!this.o.models.getModel(choice.provider, choice.modelId)) throw new Error(`Unknown model ${choice.provider}/${choice.modelId}`);
    }
    const clean: ModelSettings = {
      default: { provider: next.default.provider, modelId: next.default.modelId },
      review: next.review ? { provider: next.review.provider, modelId: next.review.modelId } : null,
      favorites: (next.favorites ?? [])
        .filter((f) => this.o.models.getModel(f.provider, f.modelId))
        .map((f) => ({ provider: f.provider, modelId: f.modelId })),
    };
    this.o.store.setSetting("modelSettings", clean);
    return clean;
  }

  private async status(id: string): Promise<ProviderStatus> {
    const provider = this.o.models.getProvider(id);
    const auth = (provider?.auth ?? {}) as { apiKey?: unknown; oauth?: unknown };
    const methods = [...(auth.apiKey ? (["api_key"] as const) : []), ...(auth.oauth ? (["oauth"] as const) : [])];
    let connected = false;
    let via: ProviderStatus["via"] = null;
    let source: string | null = null;
    let error: string | null = null;
    try {
      const check = await this.o.models.checkAuth(id);
      if (check) {
        connected = true;
        via = check.type;
        const stored = await this.o.credentials.read(id);
        source = stored ? (stored.type === "oauth" ? "Signed in (subscription)" : "Stored API key") : (check.source ?? "environment");
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    return {
      id,
      name: provider?.name ?? id,
      methods: [...methods],
      oauthLabel: auth.oauth ? (PROVIDER_META[id]?.oauthLabel ?? "Subscription sign-in") : null,
      apiKeyUrl: PROVIDER_META[id]?.apiKeyUrl ?? null,
      connected,
      via,
      source,
      error,
    };
  }

  async overview(): Promise<ModelsResponse> {
    void this.refreshBilling();
    return { providers: await Promise.all(this.o.providers.map((id) => this.status(id))), settings: this.settings() };
  }

  catalog(provider: string | undefined, q: string | undefined, limit = 200): CatalogResponse {
    const favorites = new Set(this.settings().favorites.map((f) => `${f.provider}/${f.modelId}`));
    const terms = (q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const all: ModelInfo[] = [];
    for (const id of provider ? [provider] : this.o.providers) {
      for (const m of this.o.models.getModels(id)) {
        const hay = `${m.provider} ${m.id} ${m.name ?? ""}`.toLowerCase();
        if (terms.length && !terms.every((t) => hay.includes(t))) continue;
        const cost = (m as { cost?: ModelInfo["cost"] }).cost;
        all.push({
          provider: m.provider,
          id: m.id,
          name: m.name ?? m.id,
          contextWindow: m.contextWindow ?? null,
          maxTokens: m.maxTokens ?? null,
          input: [...((m as { input?: string[] }).input ?? ["text"])],
          reasoning: Boolean((m as { reasoning?: boolean }).reasoning),
          cost: cost ? { input: cost.input, output: cost.output, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite } : null,
        });
      }
    }
    all.sort((a, b) => Number(favorites.has(`${b.provider}/${b.id}`)) - Number(favorites.has(`${a.provider}/${a.id}`)));
    return { models: all.slice(0, limit), total: all.length };
  }

  async setApiKey(provider: string, key: string): Promise<ProviderStatus> {
    if (!this.o.providers.includes(provider)) throw new Error("Unknown provider");
    const clean = key.trim();
    if (clean.length < 8 || /\s/.test(clean)) throw new Error("That does not look like an API key");
    await this.o.credentials.modify(provider, async () => ({ type: "api_key", key: clean }));
    await this.refreshBilling();
    return this.status(provider);
  }

  async disconnect(provider: string): Promise<ProviderStatus> {
    try {
      await this.o.models.logout(provider);
    } catch {}
    await this.o.credentials.delete(provider);
    await this.refreshBilling();
    return this.status(provider);
  }

  async test(provider: string, modelId?: string): Promise<TestResult> {
    const settings = this.settings();
    const choice: ModelChoice =
      modelId ? { provider, modelId } : settings.default.provider === provider ? settings.default : { provider, modelId: this.o.models.getModels(provider)[0]?.id ?? "" };
    const model = this.o.models.getModel(choice.provider, choice.modelId);
    const started = Date.now();
    if (!model) return { ok: false, latencyMs: 0, reply: null, error: `Unknown model ${choice.provider}/${choice.modelId}`, model: choice };
    try {
      const answer = await this.o.models.complete(
        model,
        { messages: [{ role: "user", content: "Reply with the single word OK.", timestamp: Date.now() }] },
        { signal: AbortSignal.timeout(45_000), maxTokens: 20 } as never,
      );
      const a = answer as { stopReason?: string; errorMessage?: string; content?: Array<{ type: string; text?: string }> };
      if (a.stopReason === "error") return { ok: false, latencyMs: Date.now() - started, reply: null, error: a.errorMessage ?? "Model error", model: choice };
      const reply = (a.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("").trim();
      return { ok: true, latencyMs: Date.now() - started, reply, error: null, model: choice };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - started, reply: null, error: e instanceof Error ? e.message : String(e), model: choice };
    }
  }

  startLogin(provider: string): LoginState {
    if (!this.o.providers.includes(provider)) throw new Error("Unknown provider");
    for (const [id, s] of this.sessions) if (s.finishedAt && Date.now() - s.finishedAt > 10 * 60_000) this.sessions.delete(id);
    const id = randomUUID();
    const session: Session = {
      state: { id, provider, method: "oauth", status: "running", events: [], prompt: null, error: null },
      answer: null,
      abort: new AbortController(),
      finishedAt: null,
    };
    this.sessions.set(id, session);
    const interaction = {
      signal: session.abort.signal,
      notify: (event: AuthEvent) => {
        session.state.events.push(event as LoginEvent);
      },
      prompt: (prompt: AuthPrompt) =>
        new Promise<string>((resolve, reject) => {
          const p: LoginPrompt = {
            id: randomUUID(),
            type: prompt.type,
            message: prompt.message,
            ...("placeholder" in prompt && prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
            ...(prompt.type === "select" ? { options: prompt.options.map((o) => ({ ...o })) } : {}),
          };
          session.state.prompt = p;
          session.state.status = "waiting";
          session.answer = (value) => {
            session.state.prompt = null;
            session.state.status = "running";
            session.answer = null;
            resolve(value);
          };
          const onAbort = () => {
            session.state.prompt = null;
            reject(new Error("Sign-in was cancelled"));
          };
          prompt.signal?.addEventListener("abort", onAbort, { once: true });
          session.abort.signal.addEventListener("abort", onAbort, { once: true });
        }),
    };
    let deviceId = this.o.store.setting<string | null>("deviceId", null);
    if (!deviceId) {
      deviceId = randomUUID();
      this.o.store.setSetting("deviceId", deviceId);
    }
    const stableId = deviceId;
    void this.o.models
      .login(provider, "oauth", interaction, { signal: session.abort.signal, getDeviceId: () => stableId, agentName: "Nightshift" } as never)
      .then(() => {
        session.state.status = "done";
        session.state.prompt = null;
        void this.refreshBilling();
      })
      .catch((e: unknown) => {
        session.state.status = session.abort.signal.aborted ? "cancelled" : "failed";
        session.state.error = session.abort.signal.aborted ? null : e instanceof Error ? e.message : String(e);
        session.state.prompt = null;
      })
      .finally(() => {
        session.finishedAt = Date.now();
      });
    return session.state;
  }

  login(id: string): LoginState {
    const s = this.sessions.get(id);
    if (!s) throw Object.assign(new Error("Sign-in session not found"), { status: 404 });
    return s.state;
  }

  answer(id: string, promptId: string, value: string): LoginState {
    const s = this.sessions.get(id);
    if (!s) throw Object.assign(new Error("Sign-in session not found"), { status: 404 });
    if (!s.state.prompt || s.state.prompt.id !== promptId || !s.answer) throw new Error("This question was already answered");
    s.answer(value);
    return s.state;
  }

  cancel(id: string): LoginState {
    const s = this.sessions.get(id);
    if (!s) throw Object.assign(new Error("Sign-in session not found"), { status: 404 });
    s.abort.abort();
    s.state.status = "cancelled";
    s.state.prompt = null;
    return s.state;
  }
}
