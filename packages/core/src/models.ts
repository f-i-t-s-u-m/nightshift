export type ModelChoice = { provider: string; modelId: string };

export type AuthMethod = "api_key" | "oauth";

export type ProviderStatus = {
  id: string;
  name: string;
  methods: AuthMethod[];
  oauthLabel: string | null;
  apiKeyUrl: string | null;
  connected: boolean;
  via: AuthMethod | null;
  source: string | null;
  error: string | null;
};

export type ModelInfo = {
  provider: string;
  id: string;
  name: string;
  contextWindow: number | null;
  maxTokens: number | null;
  input: string[];
  reasoning: boolean;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
};

export type ModelSettings = {
  default: ModelChoice;
  review: ModelChoice | null;
  favorites: ModelChoice[];
};

export type ModelsResponse = { providers: ProviderStatus[]; settings: ModelSettings };

export type CatalogResponse = { models: ModelInfo[]; total: number };

export type TestResult = { ok: boolean; latencyMs: number; reply: string | null; error: string | null; model: ModelChoice };

export type LoginPrompt = {
  id: string;
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
};

export type LoginEvent =
  | { type: "info"; message: string; links?: Array<{ url: string; label?: string }> }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; expiresInSeconds?: number }
  | { type: "progress"; message: string };

export type LoginState = {
  id: string;
  provider: string;
  method: AuthMethod;
  status: "running" | "waiting" | "done" | "failed" | "cancelled";
  events: LoginEvent[];
  prompt: LoginPrompt | null;
  error: string | null;
};

export const MODEL_ROUTES = {
  models: "/api/models",
  settings: "/api/models/settings",
  catalog: (provider?: string, q?: string) =>
    `/api/models/catalog?${new URLSearchParams({ ...(provider ? { provider } : {}), ...(q ? { q } : {}) }).toString()}`,
  apiKey: (provider: string) => `/api/models/providers/${encodeURIComponent(provider)}/api-key`,
  test: (provider: string) => `/api/models/providers/${encodeURIComponent(provider)}/test`,
  disconnect: (provider: string) => `/api/models/providers/${encodeURIComponent(provider)}`,
  login: (provider: string) => `/api/models/providers/${encodeURIComponent(provider)}/login`,
  loginState: (id: string) => `/api/models/logins/${encodeURIComponent(id)}`,
  loginAnswer: (id: string) => `/api/models/logins/${encodeURIComponent(id)}/answer`,
  loginCancel: (id: string) => `/api/models/logins/${encodeURIComponent(id)}/cancel`,
} as const;
