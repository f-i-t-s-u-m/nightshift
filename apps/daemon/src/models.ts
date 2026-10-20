import { pathToFileURL } from "node:url";
import { createModels, type CredentialStore, type Models } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { ModelChoice, NightshiftConfig } from "@nightshift/core";
import { createCredentialStore } from "./models/credentials.ts";

export type ModelSetup = {
  models: Models;
  model: ModelChoice;
  credentials: CredentialStore;
  credentialsKind: "keychain" | "file";
  providers: string[];
};

export const CONNECTABLE_PROVIDERS = ["anthropic", "openai", "openrouter"];

export async function createModelSetup(config: NightshiftConfig): Promise<ModelSetup> {
  const { store: credentials, kind } = createCredentialStore(config.dataDir);
  const testModule = process.env.NIGHTSHIFT_TEST_MODELS;
  if (testModule) {
    const mod = (await import(pathToFileURL(testModule).href)) as {
      createTestModels(credentials: CredentialStore): { models: Models; model: ModelChoice; providers: string[] };
    };
    const t = mod.createTestModels(credentials);
    return { ...t, credentials, credentialsKind: kind };
  }
  const models = createModels({ credentials });
  models.setProvider(anthropicProvider());
  models.setProvider(openaiProvider());
  models.setProvider(openrouterProvider());
  return { models, model: config.model, credentials, credentialsKind: kind, providers: CONNECTABLE_PROVIDERS };
}
