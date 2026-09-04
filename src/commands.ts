import { lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  CONSENT_NOTICE_VERSION,
  type ConfigStore,
  type OptimizerConfig,
} from "./config.ts";
import {
  MAX_EXPANSION_LINES,
  MAX_ID_LENGTH,
  PROTOCOL_VERSION,
  isBridgeResponse,
  type BridgeAction,
  type BridgeResponse,
} from "./protocol.ts";

const COMMANDS = [
  "status",
  "doctor",
  "dashboard",
  "enable",
  "disable",
  "consent",
  "expand",
  "purge",
] as const;
const CONSENT_COMMANDS = ["show", "grant", "reset"] as const;
const USAGE = "Usage: /token-optimizer status|doctor|dashboard|enable|disable|consent show|grant|reset|expand <id>|purge";
const CONSENT_NOTICE = "Token Optimizer processes current Pi session activity locally, stores credential-redacted archives and metrics under the Pi agent directory, and sends no optimizer data over the network.";

type ControlAction = Extract<BridgeAction, "status" | "doctor" | "dashboard" | "expand">;

type CommandAdapter = {
  runControl(
    action: ControlAction,
    ctx: ExtensionContext,
    args: Record<string, unknown> | undefined,
    signal: AbortSignal | undefined,
  ): Promise<BridgeResponse | null>;
  refresh(ctx: ExtensionContext): Promise<boolean>;
  disableForSession(ctx: ExtensionContext): void;
  drainBridge(): Promise<void>;
};

export interface TokenOptimizerCommandOptions {
  supported?: boolean;
  now?: () => Date;
  platform?: NodeJS.Platform;
}

function completions(prefix: string): Array<{ value: string; label: string }> | null {
  const normalized = prefix.replace(/^\s+/, "");
  const values = normalized.startsWith("consent ")
    ? CONSENT_COMMANDS.map((command) => `consent ${command}`)
    : normalized.includes(" ") ? [] : [...COMMANDS];
  const matches = values.filter((value) => value.startsWith(normalized));
  return matches.length === 0 ? null : matches.map((value) => ({ value, label: value }));
}

function parsed(args: string): string[] | undefined {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 1 && COMMANDS.includes(tokens[0] as typeof COMMANDS[number])) {
    if (tokens[0] !== "consent" && tokens[0] !== "expand") return tokens;
  }
  if (tokens.length === 2
    && tokens[0] === "consent"
    && CONSENT_COMMANDS.includes(tokens[1] as typeof CONSENT_COMMANDS[number])) return tokens;
  if (tokens.length === 2 && tokens[0] === "expand") return tokens;
  return undefined;
}

function notify(
  ctx: ExtensionContext,
  message: string,
  level: "info" | "warning" | "error" = "info",
): void {
  ctx.ui.notify(message, level);
}

function validArchiveId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_ID_LENGTH
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function validExpansionArgs(value: unknown): value is {
  archiveId: string;
  offset?: number;
  limit?: number;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const args = value as Record<string, unknown>;
  return Object.keys(args).every((key) => ["archiveId", "offset", "limit"].includes(key))
    && validArchiveId(args.archiveId)
    && (args.offset === undefined || (Number.isSafeInteger(args.offset) && (args.offset as number) >= 0))
    && (args.limit === undefined
      || (Number.isSafeInteger(args.limit)
        && (args.limit as number) >= 1
        && (args.limit as number) <= MAX_EXPANSION_LINES));
}

function validHealth(response: BridgeResponse | null): boolean {
  return isBridgeResponse(response, "status")
    && response.ok
    && response.data?.runtime === "pi"
    && response.data.protocolVersion === PROTOCOL_VERSION
    && response.data.healthy === true;
}

async function status(
  ctx: ExtensionContext,
  adapter: CommandAdapter,
  config: OptimizerConfig,
  supported: boolean,
): Promise<void> {
  const response = supported
    ? await adapter.runControl("status", ctx, undefined, ctx.signal)
    : null;
  const bridge = validHealth(response) ? "healthy" : "unavailable";
  notify(ctx, [
    "Token Optimizer status",
    `Enabled: ${config.enabled ? "yes" : "no"}`,
    `Consent: ${config.consent.granted ? "granted" : "not granted"}`,
    `Pi integration: ${supported ? "supported" : "unsupported (requires Pi 0.84.4+)"}`,
    `Python bridge: ${bridge}`,
  ].join("\n"), bridge === "healthy" || !supported ? "info" : "warning");
}

type Expansion = {
  text: string;
  offset: number;
  nextOffset?: number;
};

function expansion(
  response: BridgeResponse | null,
  archiveId: string,
  offset: number,
): Expansion | undefined {
  if (!isBridgeResponse(response, "expand") || !response.ok) return undefined;
  const data = response.data;
  if (data?.archiveId !== archiveId
    || data.offset !== offset
    || typeof data.text !== "string"
    || (data.nextOffset !== undefined
      && (!Number.isSafeInteger(data.nextOffset) || (data.nextOffset as number) <= offset))) {
    return undefined;
  }
  return {
    text: data.text,
    offset,
    ...(data.nextOffset === undefined ? {} : { nextOffset: data.nextOffset as number }),
  };
}

function doctorText(response: BridgeResponse | null): string | undefined {
  if (!isBridgeResponse(response, "doctor") || !response.ok || response.data === undefined) {
    return undefined;
  }
  const data = response.data;
  const checks = typeof data.checks === "object" && data.checks !== null && !Array.isArray(data.checks)
    ? Object.entries(data.checks).map(([name, passed]) => `${name}=${passed === true ? "yes" : "no"}`).join(", ")
    : "unavailable";
  return [
    `Doctor: ${data.healthy === true ? "healthy" : "unhealthy"}`,
    `Python: ${typeof data.pythonVersion === "string" ? data.pythonVersion : "unavailable"}`,
    `Upstream: ${typeof data.upstreamVersion === "string" ? data.upstreamVersion : "unavailable"}`,
    `Checks: ${checks}`,
  ].join("\n");
}

async function purge(
  ctx: ExtensionContext,
  adapter: CommandAdapter,
  config: ConfigStore,
): Promise<void> {
  const preview = await config.previewPurge();
  const summary = `root=${preview.root}\nfiles=${preview.count}\nbytes=${preview.bytes}`;
  notify(ctx, `Purge preview\n${summary}`);
  if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
    notify(ctx, `Purge refused without confirmation.\n${summary}`, "warning");
    return;
  }
  if (!await ctx.ui.confirm("Purge Pi Token Optimizer data?", summary)) {
    notify(ctx, "Purge cancelled.");
    return;
  }
  adapter.disableForSession(ctx);
  await adapter.drainBridge();
  const result = await config.purgeData();
  notify(ctx, result.purged
    ? `Purged ${result.count} files (${result.bytes} bytes) from ${result.root}.`
    : `Nothing to purge at ${result.root}.`);
}

async function dashboard(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: ExtensionContext,
  adapter: CommandAdapter,
  config: ConfigStore,
  platform: NodeJS.Platform,
): Promise<void> {
  const root = (await config.previewPurge()).root;
  const expected = join(root, "dashboard.html");
  const response = await adapter.runControl("dashboard", ctx, undefined, ctx.signal);
  const path = response?.data?.path;
  if (!isBridgeResponse(response, "dashboard")
    || !response.ok
    || response.data?.available !== true
    || response.data.status !== "ready"
    || typeof path !== "string"
    || resolve(path) !== resolve(expected)) {
    notify(ctx, "Dashboard unavailable.", "warning");
    return;
  }
  try {
    const [rootInfo, fileInfo, canonicalRoot, canonicalFile] = await Promise.all([
      lstat(root),
      lstat(expected),
      realpath(root),
      realpath(expected),
    ]);
    if (rootInfo.isSymbolicLink()
      || !rootInfo.isDirectory()
      || fileInfo.isSymbolicLink()
      || !fileInfo.isFile()
      || canonicalRoot !== resolve(root)
      || canonicalFile !== resolve(expected)
      || dirname(canonicalFile) !== canonicalRoot) {
      notify(ctx, "Dashboard unavailable.", "warning");
      return;
    }
  } catch {
    notify(ctx, "Dashboard unavailable.", "warning");
    return;
  }

  const opener = platform === "darwin" ? "open" : platform === "linux" ? "xdg-open" : undefined;
  if (opener === undefined) {
    notify(ctx, `Dashboard ready at ${expected}; opener unavailable.`, "warning");
    return;
  }
  try {
    const result = await pi.exec(opener, [expected]);
    if (result.code === 0 && !result.killed) {
      notify(ctx, `Dashboard opened: ${expected}`);
      return;
    }
  } catch {}
  notify(ctx, `Dashboard ready at ${expected}; opener unavailable.`, "warning");
}

export function registerTokenOptimizerCommand(
  pi: Pick<ExtensionAPI, "registerCommand" | "exec">,
  adapter: CommandAdapter,
  config: ConfigStore,
  options: TokenOptimizerCommandOptions = {},
): void {
  const supported = options.supported ?? true;
  pi.registerCommand("token-optimizer", {
    description: "Manage Pi Token Optimizer",
    getArgumentCompletions: completions,
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const command = parsed(args);
      if (command === undefined) {
        notify(ctx, USAGE, "warning");
        return;
      }

      try {
        if (command[0] === "purge") {
          await purge(ctx, adapter, config);
          return;
        }
        if (command[0] === "expand") {
          const archiveId = command[1];
          if (!validArchiveId(archiveId)) {
            notify(ctx, "Invalid archive id.", "warning");
            return;
          }
          if (!supported) {
            notify(ctx, "Expansion unavailable: Pi 0.84.4 or newer is required.", "warning");
            return;
          }
          const page = expansion(
            await adapter.runControl("expand", ctx, { archiveId }, ctx.signal),
            archiveId,
            0,
          );
          if (page === undefined) {
            notify(ctx, "Expansion unavailable.", "warning");
            return;
          }
          notify(ctx, page.text);
          if (page.nextOffset !== undefined) {
            notify(ctx, `More archive content is available at next offset: ${page.nextOffset}.`);
          }
          return;
        }
        if (command[0] === "doctor") {
          if (!supported) {
            notify(ctx, "Doctor unavailable: Pi 0.84.4 or newer is required.", "warning");
            return;
          }
          const result = doctorText(await adapter.runControl("doctor", ctx, undefined, ctx.signal));
          notify(ctx, result ?? "Doctor unavailable: Python bridge failed.",
            result === undefined ? "warning" : "info");
          return;
        }
        if (command[0] === "dashboard") {
          if (!supported) {
            notify(ctx, "Dashboard unavailable: Pi 0.84.4 or newer is required.", "warning");
            return;
          }
          await dashboard(pi, ctx, adapter, config, options.platform ?? process.platform);
          return;
        }

        const current = await config.load();
        if (command[0] === "status") {
          await status(ctx, adapter, current, supported);
          return;
        }
        if (command[0] === "consent" && command[1] === "show") {
          notify(ctx, `${CONSENT_NOTICE}\n\nConsent: ${current.consent.granted ? `granted${current.consent.grantedAt === undefined ? "" : ` at ${current.consent.grantedAt}`}` : "not granted"}.`);
          return;
        }
        if (command[0] === "consent" && command[1] === "grant") {
          await config.save({
            ...current,
            consent: {
              granted: true,
              noticeVersion: CONSENT_NOTICE_VERSION,
              grantedAt: (options.now ?? (() => new Date()))().toISOString(),
            },
          });
          const active = !current.enabled || !supported ? false : await adapter.refresh(ctx);
          notify(ctx, `Consent granted.${current.enabled && !active ? " Optimizer remains unavailable." : ""}`,
            current.enabled && !active ? "warning" : "info");
          return;
        }
        if (command[0] === "disable") {
          adapter.disableForSession(ctx);
          await config.save({ ...current, enabled: false });
          notify(ctx, "Token Optimizer disabled.");
          return;
        }
        if (command[0] === "consent" && command[1] === "reset") {
          adapter.disableForSession(ctx);
          await config.save({
            ...current,
            consent: { granted: false, noticeVersion: CONSENT_NOTICE_VERSION },
          });
          notify(ctx, "Token Optimizer consent reset; activity is disabled.");
          return;
        }
        if (command[0] === "enable") {
          if (!current.consent.granted
            || current.consent.noticeVersion !== CONSENT_NOTICE_VERSION) {
            notify(ctx, "Cannot enable Token Optimizer: grant current consent first.", "warning");
            return;
          }
          await config.save({ ...current, enabled: true });
          if (!supported || !await adapter.refresh(ctx)) {
            notify(ctx, "Token Optimizer enabled locally; activation awaits a compatible runtime or reload.", "warning");
            return;
          }
          notify(ctx, "Token Optimizer enabled.");
          return;
        }
        notify(ctx, `Token Optimizer ${command.join(" ")} unavailable.`, "warning");
      } catch {
        notify(ctx, "Token Optimizer command failed.", "error");
      }
    },
  });
}

const ExpandParameters = Type.Object({
  archiveId: Type.String({
    minLength: 1,
    maxLength: MAX_ID_LENGTH,
    pattern: "^[A-Za-z0-9_-]+$",
  }),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_EXPANSION_LINES })),
}, { additionalProperties: false });

export function registerExpandTool(
  pi: Pick<ExtensionAPI, "registerTool">,
  adapter: CommandAdapter,
  options: Pick<TokenOptimizerCommandOptions, "supported"> = {},
): void {
  const supported = options.supported ?? true;
  pi.registerTool({
    name: "token_optimizer_expand",
    label: "Token Optimizer Expand",
    description: "Read up to 50 KiB or 2000 lines from a local Token Optimizer archive, with pagination metadata.",
    parameters: ExpandParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!supported) {
        throw new Error("Token Optimizer archive expansion unavailable: Pi 0.84.4 or newer is required");
      }
      if (!validExpansionArgs(params)) throw new Error("Invalid archive expansion arguments");
      const offset = params.offset ?? 0;
      const args = {
        archiveId: params.archiveId,
        ...(params.offset === undefined ? {} : { offset: params.offset }),
        ...(params.limit === undefined ? {} : { limit: params.limit }),
      };
      const page = expansion(
        await adapter.runControl("expand", ctx, args, signal),
        params.archiveId,
        offset,
      );
      if (page === undefined) {
        throw new Error("Token Optimizer archive expansion unavailable");
      }
      return {
        content: [
          { type: "text" as const, text: page.text },
          ...(page.nextOffset === undefined ? [] : [{
            type: "text" as const,
            text: `Continue with token_optimizer_expand using archiveId ${params.archiveId} and offset ${page.nextOffset}.`,
          }]),
        ],
        details: {
          archiveId: params.archiveId,
          offset: page.offset,
          nextOffset: page.nextOffset,
        },
      };
    },
  });
}
