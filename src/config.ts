import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, parse, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export const CONFIG_SCHEMA_VERSION = 1 as const;
export const CONSENT_NOTICE_VERSION = 1 as const;
export const CONSENT_NOTICE = "Pi Token Optimizer processes session activity locally and persists credential-redacted read-cache source excerpts, tool archives, metrics, and continuity checkpoints containing brief conversation snippets under the Pi agent directory. Local retention limits apply, and /token-optimizer purge removes this stored optimizer data. The optimizer sends no external telemetry. During custom compaction, Pi sends the current session context together with optimizer guidance to your selected Pi provider as a normal model call.";
export const TOKEN_OPTIMIZER_DIRECTORY = "token-optimizer";

export interface OptimizerConfig {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  enabled: boolean;
  consent: {
    granted: boolean;
    noticeVersion: typeof CONSENT_NOTICE_VERSION;
    grantedAt?: string;
  };
}

export interface PurgePreview {
  root: string;
  count: number;
  bytes: number;
}

export interface PurgeResult extends PurgePreview {
  purged: boolean;
}

export interface ConfigStore {
  load(): Promise<OptimizerConfig>;
  save(config: OptimizerConfig): Promise<void>;
  previewPurge(): Promise<PurgePreview>;
  purgeData(): Promise<PurgeResult>;
}

const DEFAULT_CONFIG: OptimizerConfig = {
  schemaVersion: CONFIG_SCHEMA_VERSION,
  enabled: true,
  consent: { granted: false, noticeVersion: CONSENT_NOTICE_VERSION },
};
const CONFIG_FILE = "config.json";
const MAX_CONFIG_BYTES = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 128) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function parseLoadedConfig(value: unknown): OptimizerConfig {
  if (!isRecord(value)) throw new TypeError("Invalid optimizer config");
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new TypeError("Invalid optimizer config enabled state");
  }
  if (value.schemaVersion !== undefined && !Number.isSafeInteger(value.schemaVersion)) {
    throw new TypeError("Invalid optimizer config schema version");
  }
  if (typeof value.schemaVersion === "number" && value.schemaVersion > CONFIG_SCHEMA_VERSION) {
    throw new TypeError("Unsupported optimizer config schema version");
  }
  if (value.consent !== undefined && !isRecord(value.consent)) {
    throw new TypeError("Invalid optimizer config consent state");
  }

  const consent = value.consent as Record<string, unknown> | undefined;
  if (consent?.granted !== undefined && typeof consent.granted !== "boolean") {
    throw new TypeError("Invalid optimizer config consent grant");
  }
  if (consent?.noticeVersion !== undefined && !Number.isSafeInteger(consent.noticeVersion)) {
    throw new TypeError("Invalid optimizer config notice version");
  }

  const granted = consent?.granted === true
    && consent.noticeVersion === CONSENT_NOTICE_VERSION;
  if (granted && consent.grantedAt !== undefined && !isIsoDate(consent.grantedAt)) {
    throw new TypeError("Invalid optimizer config consent date");
  }

  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    enabled: typeof value.enabled === "boolean" ? value.enabled : true,
    consent: {
      granted,
      noticeVersion: CONSENT_NOTICE_VERSION,
      ...(granted && isIsoDate(consent?.grantedAt) ? { grantedAt: consent.grantedAt } : {}),
    },
  };
}

function validateSavedConfig(value: unknown): asserts value is OptimizerConfig {
  if (!isRecord(value)
    || Object.keys(value).some((key) => !["schemaVersion", "enabled", "consent"].includes(key))
    || value.schemaVersion !== CONFIG_SCHEMA_VERSION
    || typeof value.enabled !== "boolean"
    || !isRecord(value.consent)
    || Object.keys(value.consent).some((key) => !["granted", "noticeVersion", "grantedAt"].includes(key))
    || typeof value.consent.granted !== "boolean"
    || value.consent.noticeVersion !== CONSENT_NOTICE_VERSION
    || (value.consent.grantedAt !== undefined && !isIsoDate(value.consent.grantedAt))) {
    throw new TypeError("Invalid optimizer config");
  }
}

function missing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

async function optionalLstat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

function pathsFor(agentDirInput: string): { agentDir: string; root: string; configPath: string } {
  if (agentDirInput.trim().length === 0) throw new Error("Invalid agent directory");
  const agentDir = resolve(agentDirInput);
  const filesystemRoot = parse(agentDir).root;
  if (agentDir === filesystemRoot || agentDir === resolve(homedir())) {
    throw new Error("Unsafe agent directory");
  }

  const root = resolve(agentDir, TOKEN_OPTIMIZER_DIRECTORY);
  if (dirname(root) !== agentDir
    || basename(root) !== TOKEN_OPTIMIZER_DIRECTORY
    || root === agentDir
    || root === filesystemRoot
    || root === resolve(homedir())) {
    throw new Error("Unsafe optimizer root");
  }
  return { agentDir, root, configPath: resolve(root, CONFIG_FILE) };
}

async function verifyDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`${label} is a symlink`);
  if (!info.isDirectory()) throw new Error(`${label} is not a directory`);
  if (await realpath(path) !== path) throw new Error(`${label} does not resolve exactly`);
}

async function inspectRoot(agentDir: string, root: string): Promise<boolean> {
  const agentInfo = await optionalLstat(agentDir);
  if (agentInfo === undefined) return false;
  await verifyDirectory(agentDir, "Agent directory");

  const rootInfo = await optionalLstat(root);
  if (rootInfo === undefined) return false;
  await verifyDirectory(root, "Optimizer root");
  if (dirname(await realpath(root)) !== await realpath(agentDir)) {
    throw new Error("Optimizer root resolves outside the agent directory");
  }
  return true;
}

async function ensureRoot(agentDir: string, root: string): Promise<void> {
  await verifyDirectory(agentDir, "Agent directory");

  const current = await optionalLstat(root);
  if (current?.isSymbolicLink()) throw new Error("Optimizer root is a symlink");
  if (current === undefined) await mkdir(root, { mode: 0o700 });
  await verifyDirectory(root, "Optimizer root");
  await chmod(root, 0o700);
}

async function scan(path: string): Promise<{ count: number; bytes: number }> {
  let count = 0;
  let bytes = 0;
  for (const entry of await readdir(path)) {
    const child = resolve(path, entry);
    const info = await lstat(child);
    if (info.isDirectory() && !info.isSymbolicLink()) {
      const nested = await scan(child);
      count += nested.count;
      bytes += nested.bytes;
    } else {
      count += 1;
      bytes += info.size;
    }
  }
  return { count, bytes };
}

class FileConfigStore implements ConfigStore {
  readonly #agentDir: string;
  readonly #root: string;
  readonly #configPath: string;

  constructor(agentDir: string) {
    ({ agentDir: this.#agentDir, root: this.#root, configPath: this.#configPath } = pathsFor(agentDir));
  }

  async load(): Promise<OptimizerConfig> {
    if (!await inspectRoot(this.#agentDir, this.#root)) return structuredClone(DEFAULT_CONFIG);
    const info = await optionalLstat(this.#configPath);
    if (info === undefined) return structuredClone(DEFAULT_CONFIG);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("Optimizer config is not a regular file");
    if (info.size > MAX_CONFIG_BYTES) throw new Error("Optimizer config is too large");

    try {
      return parseLoadedConfig(JSON.parse(await readFile(this.#configPath, "utf8")));
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("Invalid optimizer config JSON", { cause: error });
      throw error;
    }
  }

  async save(config: OptimizerConfig): Promise<void> {
    validateSavedConfig(config);
    await ensureRoot(this.#agentDir, this.#root);

    const existing = await optionalLstat(this.#configPath);
    if (existing !== undefined && (existing.isSymbolicLink() || !existing.isFile())) {
      throw new Error("Optimizer config is not a regular file");
    }

    const temporary = `${this.#configPath}.tmp-${process.pid}-${randomUUID()}`;
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.#configPath);
      await chmod(this.#configPath, 0o600);
      const directory = await open(this.#root, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await handle?.close();
      await rm(temporary, { force: true });
    }
  }

  async previewPurge(): Promise<PurgePreview> {
    if (!await inspectRoot(this.#agentDir, this.#root)) {
      return { root: this.#root, count: 0, bytes: 0 };
    }
    return { root: this.#root, ...await scan(this.#root) };
  }

  async purgeData(): Promise<PurgeResult> {
    const preview = await this.previewPurge();
    if (!await inspectRoot(this.#agentDir, this.#root)) return { ...preview, purged: false };
    await rm(this.#root, { recursive: true });
    return { ...preview, purged: true };
  }
}

export function createConfigStore(agentDir: string): ConfigStore {
  return new FileConfigStore(agentDir);
}
