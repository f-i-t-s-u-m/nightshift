import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { run } from "@nightshift/git";

const SERVICE = "dev.nightshift.credentials";

class Lock {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }
}

function writePrivate(file: string, content: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

export class FileCredentialStore implements CredentialStore {
  private readonly lock = new Lock();
  constructor(readonly file: string) {}

  private load(): Record<string, Credential> {
    return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Record<string, Credential>) : {};
  }

  async read(providerId: string) {
    return this.load()[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.load()).map(([providerId, c]) => ({ providerId, type: c.type }));
  }

  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>) {
    return this.lock.run(async () => {
      const all = this.load();
      const next = await fn(all[providerId]);
      if (next) all[providerId] = next;
      else delete all[providerId];
      writePrivate(this.file, JSON.stringify(all, null, 2));
      return next;
    });
  }

  async delete(providerId: string) {
    await this.modify(providerId, async () => undefined);
  }
}

export class KeychainCredentialStore implements CredentialStore {
  private readonly lock = new Lock();
  constructor(readonly indexFile: string) {}

  private index(): Record<string, Credential["type"]> {
    return existsSync(this.indexFile) ? (JSON.parse(readFileSync(this.indexFile, "utf8")) as Record<string, Credential["type"]>) : {};
  }

  private saveIndex(index: Record<string, Credential["type"]>) {
    writePrivate(this.indexFile, JSON.stringify(index, null, 2));
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const res = await run("security", ["find-generic-password", "-s", SERVICE, "-a", providerId, "-w"]);
    if (res.code !== 0) return undefined;
    try {
      return JSON.parse(res.stdout.trim()) as Credential;
    } catch {
      return undefined;
    }
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.index()).map(([providerId, type]) => ({ providerId, type }));
  }

  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>) {
    return this.lock.run(async () => {
      const next = await fn(await this.read(providerId));
      const index = this.index();
      if (next) {
        const res = await run("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", providerId, "-l", `Nightshift ${providerId}`, "-w", JSON.stringify(next)]);
        if (res.code !== 0) throw new Error(`Could not save to the macOS Keychain: ${res.stderr.trim()}`);
        index[providerId] = next.type;
      } else {
        await run("security", ["delete-generic-password", "-s", SERVICE, "-a", providerId]);
        delete index[providerId];
      }
      this.saveIndex(index);
      return next;
    });
  }

  async delete(providerId: string) {
    await this.modify(providerId, async () => undefined);
  }
}

export function createCredentialStore(dataDir: string): { store: CredentialStore; kind: "keychain" | "file" } {
  const wanted = process.env.NIGHTSHIFT_CREDENTIALS ?? (process.platform === "darwin" ? "keychain" : "file");
  if (wanted === "keychain") return { store: new KeychainCredentialStore(path.join(dataDir, "credentials-index.json")), kind: "keychain" };
  return { store: new FileCredentialStore(path.join(dataDir, "credentials.json")), kind: "file" };
}
