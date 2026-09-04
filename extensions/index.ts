import {
  VERSION,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { PiAdapter } from "../src/adapter.ts";
import { BridgeClient } from "../src/bridge.ts";
import {
  registerExpandTool,
  registerTokenOptimizerCommand,
} from "../src/commands.ts";
import { prepareOptimizedCompaction } from "../src/compaction.ts";
import {
  CONSENT_NOTICE,
  CONSENT_NOTICE_VERSION,
  createConfigStore,
  hasCurrentConsent,
  type ConfigStore,
} from "../src/config.ts";

const MINIMUM_PI_VERSION = [0, 84, 4] as const;
const VERSION_PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export interface TokenOptimizerRegistrationOptions {
  version?: string;
  agentDir?: string;
}

export function supportsPiVersion(version: string): boolean {
  const match = VERSION_PATTERN.exec(version.trim());
  if (match === null) return false;
  const current = match.slice(1, 4).map(Number);
  if (
    current.some((part) => !Number.isSafeInteger(part)) ||
    match[4]
      ?.split(".")
      .some((part) => part.length > 1 && /^\d+$/.test(part) && part[0] === "0")
  ) {
    return false;
  }
  for (let index = 0; index < MINIMUM_PI_VERSION.length; index += 1) {
    if (current[index] !== MINIMUM_PI_VERSION[index]) {
      return current[index] > MINIMUM_PI_VERSION[index];
    }
  }
  return match[4] === undefined;
}

async function requestConsent(
  config: ConfigStore,
  ctx: ExtensionContext,
): Promise<boolean> {
  if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) return false;

  let current;
  try {
    current = await config.load();
  } catch {
    return false;
  }
  if (hasCurrentConsent(current)) return false;

  try {
    if (!(await ctx.ui.confirm("Enable Pi Token Optimizer?", CONSENT_NOTICE)))
      return false;
    await config.save({
      ...current,
      consent: {
        granted: true,
        noticeVersion: CONSENT_NOTICE_VERSION,
        grantedAt: new Date().toISOString(),
      },
    });
    return true;
  } catch {
    return false;
  }
}

export function registerTokenOptimizer(
  pi: ExtensionAPI,
  options: TokenOptimizerRegistrationOptions = {},
): void {
  const supported = supportsPiVersion(options.version ?? VERSION);
  const agentDir = options.agentDir ?? getAgentDir();
  const config = createConfigStore(agentDir);
  const bridge = new BridgeClient(agentDir);
  const adapter = new PiAdapter(pi, bridge, config);

  registerTokenOptimizerCommand(pi, adapter, config, { supported });
  if (!supported) return;

  registerExpandTool(pi, adapter);
  let sessionReason: Parameters<PiAdapter["start"]>[1];
  let consentAttempt: Promise<boolean> | undefined;
  let consentStart: Promise<void> | undefined;
  pi.on("session_start", async (event, ctx) => {
    sessionReason = event.reason;
    consentAttempt = undefined;
    consentStart = undefined;
    const granted =
      ctx.mode === "tui"
        ? await (consentAttempt = requestConsent(config, ctx))
        : false;
    const start = Promise.resolve()
      .then(() => adapter.start(ctx, event.reason))
      .catch(() => {});
    if (granted) consentStart = start;
    await start;
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      await adapter.shutdown(ctx);
    } catch {}
  });
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const granted = await (consentAttempt ??= requestConsent(config, ctx));
      if (granted) {
        consentStart ??= Promise.resolve()
          .then(() => adapter.start(ctx, sessionReason))
          .catch(() => {});
        await consentStart;
      }
      return await adapter.beforePrompt(event, ctx);
    } catch {
      return;
    }
  });
  pi.on("context", (event) => {
    try {
      return adapter.filterContext(event);
    } catch {
      return;
    }
  });
  pi.on("tool_call", async (event, ctx) => {
    try {
      return await adapter.beforeTool(event, ctx);
    } catch {
      return;
    }
  });
  pi.on("tool_result", async (event, ctx) => {
    try {
      return await adapter.afterTool(event, ctx);
    } catch {
      return;
    }
  });
  pi.on("agent_settled", (_event, ctx) => {
    try {
      adapter.settled(ctx);
    } catch {}
  });
  pi.on("session_before_compact", async (event, ctx) => {
    try {
      if (!adapter.isActive()) return;
      return await prepareOptimizedCompaction(event, ctx, bridge);
    } catch {
      return;
    }
  });
  pi.on("session_compact", async (_event, ctx) => {
    try {
      await adapter.compacted(ctx);
    } catch {}
  });
  pi.on("session_compact_failed", () => {});
}

export default function tokenOptimizer(pi: ExtensionAPI): void {
  registerTokenOptimizer(pi);
}
