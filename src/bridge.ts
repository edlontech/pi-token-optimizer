import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  MAX_RESPONSE_BYTES,
  type BridgeRequest,
  type BridgeResponse,
  validateBridgeRequest,
  validateBridgeResponse,
} from "./protocol.ts";

export interface BridgeRunOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface BridgeClientOptions {
  launcherPath?: string;
  bridgePath?: string;
  environment?: NodeJS.ProcessEnv;
  trackedTimeoutMs?: number;
}

const DEFAULT_LAUNCHER_PATH = fileURLToPath(
  new URL(
    "../vendor/token-optimizer/hooks/python-launcher.sh",
    import.meta.url,
  ),
);
const DEFAULT_BRIDGE_PATH = fileURLToPath(
  new URL("../python/pi_bridge.py", import.meta.url),
);
const REQUIRED_ENV_KEYS = [
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PATH",
  "TEMP",
  "TMP",
  "TMPDIR",
];
const PI_ENV_KEYS = new Set([
  "TOKEN_OPTIMIZER_RUNTIME",
  "TOKEN_OPTIMIZER_PI_HOME",
  "TOKEN_OPTIMIZER_SNAPSHOT_DIR",
]);
const FOREIGN_IDENTITY =
  /(CLAUDE|CODEX|OPENCODE|OPEN_CODE|HERMES|COPILOT|CURSOR)/i;
const CREDENTIAL =
  /(^|_)(API_?KEY|AUTH|CREDENTIALS?|PASSWORD|PASSWD|SECRET|TOKEN)($|_)/i;
const TERMINATION_GRACE_MS = 100;

function sanitizedEnvironment(
  source: NodeJS.ProcessEnv,
  agentDir: string,
  request: BridgeRequest,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of REQUIRED_ENV_KEYS) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  for (const [key, value] of Object.entries(source)) {
    const featureName = key.slice("TOKEN_OPTIMIZER_".length);
    if (
      key.startsWith("TOKEN_OPTIMIZER_") &&
      !PI_ENV_KEYS.has(key) &&
      !FOREIGN_IDENTITY.test(featureName) &&
      !CREDENTIAL.test(featureName) &&
      value !== undefined
    ) {
      env[key] = value;
    }
  }

  env.PWD = request.session.cwd;
  env.PYTHONDONTWRITEBYTECODE = "1";
  env.PYTHONIOENCODING = "utf-8";
  env.PYTHONUTF8 = "1";
  env.TOKEN_OPTIMIZER_RUNTIME = "pi";
  env.TOKEN_OPTIMIZER_PI_HOME = agentDir;
  env.TOKEN_OPTIMIZER_SNAPSHOT_DIR = join(agentDir, "token-optimizer", "data");
  env.PI_SESSION_ID = request.session.id;
  if (request.session.file !== undefined)
    env.PI_SESSION_FILE = request.session.file;
  if (request.session.provider !== undefined)
    env.PI_PROVIDER = request.session.provider;
  if (request.session.model !== undefined) env.PI_MODEL = request.session.model;
  if (request.session.reasoningLevel !== undefined) {
    env.PI_REASONING_LEVEL = request.session.reasoningLevel;
  }
  return env;
}

function signalProcessGroup(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (child.pid === undefined || child.pid <= 0) return;
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
  } catch {}
}

export class BridgeClient {
  private readonly agentDir: string;
  private readonly launcherPath: string;
  private readonly bridgePath: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly trackedTimeoutMs: number;
  private tracked?: { controller: AbortController; done: Promise<void> };
  private pending?: BridgeRequest;
  private draining = false;

  constructor(agentDir: string, options: BridgeClientOptions = {}) {
    this.agentDir = resolve(agentDir);
    this.launcherPath = options.launcherPath ?? DEFAULT_LAUNCHER_PATH;
    this.bridgePath = options.bridgePath ?? DEFAULT_BRIDGE_PATH;
    this.environment = options.environment ?? process.env;
    this.trackedTimeoutMs = options.trackedTimeoutMs ?? 2_500;
  }

  async run(
    request: BridgeRequest,
    options: BridgeRunOptions,
  ): Promise<BridgeResponse | null> {
    try {
      validateBridgeRequest(request);
      if (
        !Number.isFinite(options.timeoutMs) ||
        options.timeoutMs <= 0 ||
        options.signal?.aborted
      ) {
        return null;
      }
      return await this.spawnOnce(request, JSON.stringify(request), options);
    } catch {
      return null;
    }
  }

  runTracked(request: BridgeRequest): void {
    if (
      this.draining ||
      (request.action !== "rollup" && request.action !== "finalize")
    )
      return;
    if (this.tracked !== undefined) {
      this.pending = request;
      return;
    }
    this.startTracked(request);
  }

  async drainOrKill(timeoutMs: number): Promise<void> {
    this.draining = true;
    this.pending = undefined;
    const deadline = Date.now() + Math.max(0, timeoutMs);

    while (this.tracked !== undefined) {
      const state = this.tracked;
      const remaining = deadline - Date.now();
      if (remaining > 0 && (await this.waitFor(state.done, remaining)))
        continue;

      state.controller.abort();
      await this.waitFor(state.done, TERMINATION_GRACE_MS);
      if (this.tracked === state) this.tracked = undefined;
      break;
    }
  }

  private startTracked(request: BridgeRequest): void {
    const controller = new AbortController();
    const state = { controller, done: Promise.resolve() };
    this.tracked = state;
    state.done = this.run(request, {
      timeoutMs: this.trackedTimeoutMs,
      signal: controller.signal,
    }).then(() => {
      if (this.tracked !== state) return;
      this.tracked = undefined;
      const pending = this.pending;
      this.pending = undefined;
      if (!this.draining && pending !== undefined) this.startTracked(pending);
    });
  }

  private waitFor(done: Promise<void>, timeoutMs: number): Promise<boolean> {
    return Promise.race([
      done.then(
        () => true,
        () => true,
      ),
      delay(timeoutMs, false, { ref: false }),
    ]);
  }

  private spawnOnce(
    request: BridgeRequest,
    payload: string,
    options: BridgeRunOptions,
  ): Promise<BridgeResponse | null> {
    const deadline = Date.now() + options.timeoutMs;
    return new Promise((resolveResult) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.launcherPath, [this.bridgePath], {
          cwd: request.session.cwd,
          detached: process.platform !== "win32",
          env: sanitizedEnvironment(this.environment, this.agentDir, request),
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        resolveResult(null);
        return;
      }

      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let failed = false;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;
      let terminationTimer: NodeJS.Timeout | undefined;

      const cleanup = () => {
        clearTimeout(deadlineTimer);
        if (killTimer !== undefined) clearTimeout(killTimer);
        if (terminationTimer !== undefined) clearTimeout(terminationTimer);
        options.signal?.removeEventListener("abort", stop);
      };
      const finish = (result: BridgeResponse | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolveResult(result);
      };
      const releaseChild = () => {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        child.removeAllListeners();
        for (const stream of [child.stdin, child.stdout, child.stderr]) {
          stream.removeAllListeners();
          stream.on("error", () => {});
        }
      };
      const forceStop = () => {
        if (settled) return;
        failed = true;
        signalProcessGroup(child, "SIGKILL");
        releaseChild();
        finish(null);
      };
      const stop = () => {
        if (settled || failed) return;
        failed = true;
        signalProcessGroup(child, "SIGTERM");
        killTimer = setTimeout(forceStop, TERMINATION_GRACE_MS);
      };
      const remainingMs = Math.max(0, deadline - Date.now());
      const deadlineTimer = setTimeout(forceStop, remainingMs);
      if (options.timeoutMs > TERMINATION_GRACE_MS) {
        terminationTimer = setTimeout(
          stop,
          Math.max(0, remainingMs - TERMINATION_GRACE_MS),
        );
      }

      options.signal?.addEventListener("abort", stop, { once: true });
      if (options.signal?.aborted) stop();
      child.once("error", stop);
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        stream.on("error", stop);
      }
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_RESPONSE_BYTES) {
          stop();
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.resume();
      child.once("close", (code) => {
        if (failed) {
          finish(null);
          return;
        }
        if (code !== 0 || stdoutBytes > MAX_RESPONSE_BYTES) {
          finish(null);
          return;
        }
        try {
          const parsed: unknown = JSON.parse(
            Buffer.concat(stdout).toString("utf8"),
          );
          finish(validateBridgeResponse(parsed, request.action));
        } catch {
          finish(null);
        }
      });

      try {
        if (failed) child.stdin.destroy();
        else child.stdin.end(payload);
      } catch {
        stop();
      }
    });
  }
}
