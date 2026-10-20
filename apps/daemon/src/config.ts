import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { defaultConfig, mergeConfig, validateConfig, type NightshiftConfig } from "@nightshift/core";

export const defaultConfigPath = () => process.env.NIGHTSHIFT_CONFIG ?? path.join(homedir(), ".nightshift", "config.json");

export function loadConfig(file = defaultConfigPath()): NightshiftConfig {
  const base = defaultConfig(homedir());
  if (!existsSync(file)) throw new Error(`No config at ${file}. Run \`nightshift init --repo <path>\` first.`);
  const config = mergeConfig(base, JSON.parse(readFileSync(file, "utf8")));
  const problems = validateConfig(config);
  if (problems.length) throw new Error(`Invalid config ${file}:\n- ${problems.join("\n- ")}`);
  return config;
}

export function writeConfig(file: string, config: Partial<NightshiftConfig>) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

export function loadEnvFile(config: NightshiftConfig) {
  const file = path.join(config.dataDir, ".env");
  if (existsSync(file)) process.loadEnvFile(file);
}
