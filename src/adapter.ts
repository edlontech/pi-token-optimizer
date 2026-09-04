import {
  isBashToolResult,
  isToolCallEventType,
  type BeforeAgentStartEvent,
  type BeforeAgentStartEventResult,
  type ContextEvent,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionStartEvent,
  type ToolCallEvent,
  type ToolCallEventResult,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

import type { BridgeClient } from "./bridge.ts";
import {
  CONSENT_NOTICE_VERSION,
  type ConfigStore,
  type OptimizerConfig,
} from "./config.ts";
import {
  PROTOCOL_VERSION,
  isBridgeResponse,
  type BridgeAction,
  type BridgeRequest,
  type BridgeResponse,
  type SessionDescriptor,
  type ToolDescriptor,
} from "./protocol.ts";

const BRIDGE_TIMEOUT_MS = 2_500;
const SHUTDOWN_BUDGET_MS = 3_000;
const STATUS_KEY = "token-optimizer";
const RECOVERY_TYPE = "token-optimizer-recovery";
const NUDGE_TYPE = "token-optimizer-nudge";
const BUILTIN_NAMES: Readonly<Record<string, string>> = {
  bash: "Bash",
  read: "Read",
  grep: "Grep",
  find: "Glob",
  ls: "Glob",
  edit: "Edit",
  write: "Write",
};
const PATH_TO_FILE_PATH = new Set(["read", "edit", "write"]);
const FAILURE_MESSAGES = {
  config: "Token Optimizer config unavailable.",
  bridge: "Token Optimizer bridge unavailable.",
  metadata: "Token Optimizer tool metadata unavailable.",
  lifecycle: "Token Optimizer lifecycle unavailable.",
} as const;

type FailureClass = keyof typeof FAILURE_MESSAGES;

type PiAPI = Pick<ExtensionAPI, "getAllTools" | "sendMessage">;
type BridgeRunner = Pick<BridgeClient, "run" | "runTracked" | "drainOrKill">;
type ConfigLoader = Pick<ConfigStore, "load">;

export class PiAdapter {
  private compatible = false;
  private activeState = false;
  private finalizable = false;
  private generation = 0;
  private retired = false;
  private shutdownPromise?: Promise<void>;
  private readonly warned = new Set<FailureClass>();

  constructor(
    private readonly pi: PiAPI,
    private readonly bridge: BridgeRunner,
    private readonly configStore: ConfigLoader,
  ) {}

  async start(ctx: ExtensionContext, reason: SessionStartEvent["reason"]): Promise<void> {
    this.warned.clear();
    this.shutdownPromise = undefined;
    if (!await this.refresh(ctx)) return;

    const generation = this.generation;
    let session: SessionDescriptor;
    let signal: AbortSignal | undefined;
    try {
      session = this.session(ctx);
      signal = ctx.signal;
    } catch {
      this.warn(ctx, "lifecycle");
      return;
    }

    try {
      const response = await this.bridge.run({
        protocolVersion: PROTOCOL_VERSION,
        action: "session_start",
        session,
        args: { reason },
      }, { timeoutMs: BRIDGE_TIMEOUT_MS, signal });
      if (generation !== this.generation || !this.active()) return;
      if (!isBridgeResponse(response, "session_start") || !response.ok) {
        this.warn(ctx, "lifecycle");
        return;
      }
      const recovery = response.contexts?.[0];
      if (recovery?.scope !== "recovery") return;
      this.pi.sendMessage({
        customType: RECOVERY_TYPE,
        content: recovery.text,
        display: false,
      }, { triggerTurn: false });
    } catch {
      if (generation === this.generation) this.warn(ctx, "lifecycle");
    }
  }

  async refresh(ctx: ExtensionContext): Promise<boolean> {
    const generation = ++this.generation;
    this.compatible = false;
    this.activeState = false;
    this.finalizable = false;
    if (this.retired) {
      this.setStatus(ctx, "optimizer off");
      return false;
    }
    let session: SessionDescriptor;
    try {
      session = this.session(ctx);
    } catch {
      this.warn(ctx, "lifecycle");
      return false;
    }

    let config: OptimizerConfig | undefined;
    try {
      config = await this.configStore.load();
    } catch {
      this.warn(ctx, "config");
    }
    if (generation !== this.generation) return false;

    let status: BridgeResponse | null | undefined;
    try {
      status = await this.bridge.run({
        protocolVersion: PROTOCOL_VERSION,
        action: "status",
        session,
      }, { timeoutMs: BRIDGE_TIMEOUT_MS, signal: ctx.signal });
    } catch {
      if (generation === this.generation) this.warn(ctx, "bridge");
    }
    if (generation !== this.generation) return false;

    this.compatible = isBridgeResponse(status, "status")
      && status.ok
      && status.data?.runtime === "pi"
      && status.data.protocolVersion === PROTOCOL_VERSION
      && status.data.healthy === true;
    if (!this.compatible) this.warn(ctx, "bridge");
    this.activeState = this.compatible
      && config !== undefined
      && this.hasConsent(config)
      && status?.data?.active === true;
    this.finalizable = this.activeState;
    this.setStatus(ctx, config === undefined || !this.compatible
      ? "optimizer unavailable"
      : this.activeState ? "optimizer on" : "optimizer off");
    return this.activeState;
  }

  isActive(): boolean {
    return this.active();
  }

  async compacted(ctx: ExtensionContext): Promise<void> {
    if (!this.active()) return;
    const generation = this.generation;
    try {
      const response = await this.bridge.run({
        protocolVersion: PROTOCOL_VERSION,
        action: "post_compact",
        session: this.session(ctx),
      }, { timeoutMs: BRIDGE_TIMEOUT_MS, signal: ctx.signal });
      if (generation === this.generation
        && (!isBridgeResponse(response, "post_compact") || !response.ok)) {
        this.warn(ctx, "bridge");
      }
    } catch {
      if (generation === this.generation) this.warn(ctx, "bridge");
    }
  }

  async runControl(
    action: Extract<BridgeAction, "status" | "doctor" | "dashboard" | "expand">,
    ctx: ExtensionContext,
    args: Record<string, unknown> | undefined,
    signal: AbortSignal | undefined,
  ): Promise<BridgeResponse | null> {
    try {
      return await this.bridge.run({
        protocolVersion: PROTOCOL_VERSION,
        action,
        session: this.session(ctx),
        ...(args === undefined ? {} : { args }),
      }, { timeoutMs: BRIDGE_TIMEOUT_MS, signal });
    } catch {
      return null;
    }
  }

  drainBridge(): Promise<void> {
    this.retired = true;
    this.generation += 1;
    this.activeState = false;
    this.finalizable = false;
    return this.bridge.drainOrKill(BRIDGE_TIMEOUT_MS);
  }

  async beforePrompt(
    event: BeforeAgentStartEvent,
    ctx: ExtensionContext,
  ): Promise<BeforeAgentStartEventResult | void> {
    if (!this.active()) return;
    const generation = this.generation;
    let session: SessionDescriptor;
    try {
      session = this.session(ctx);
    } catch {
      this.warn(ctx, "lifecycle");
      return;
    }

    try {
      const response = await this.bridge.run({
        protocolVersion: PROTOCOL_VERSION,
        action: "before_prompt",
        session,
        args: { prompt: event.prompt },
      }, { timeoutMs: BRIDGE_TIMEOUT_MS, signal: ctx.signal });
      if (generation !== this.generation || !this.active()) return;
      if (!isBridgeResponse(response, "before_prompt") || !response.ok) {
        this.warn(ctx, "bridge");
        return;
      }
      const nudge = response.contexts?.[0];
      if (nudge?.scope !== "nudge") return;
      return {
        message: {
          customType: NUDGE_TYPE,
          content: nudge.text,
          display: false,
        },
      };
    } catch {
      if (generation === this.generation) this.warn(ctx, "bridge");
    }
  }

  filterContext(event: ContextEvent): { messages: ContextEvent["messages"] } | void {
    let newest = -1;
    let count = 0;
    for (let index = event.messages.length - 1; index >= 0; index -= 1) {
      const message = event.messages[index];
      if (message.role !== "custom" || message.customType !== NUDGE_TYPE) continue;
      count += 1;
      if (newest === -1) newest = index;
    }
    if (count < 2) return;
    return {
      messages: event.messages.filter((message, index) => message.role !== "custom"
        || message.customType !== NUDGE_TYPE
        || index === newest),
    };
  }

  settled(ctx: ExtensionContext): void {
    if (!this.active()) return;
    try {
      const session = this.session(ctx);
      if (session.file === undefined) return;
      this.bridge.runTracked({
        protocolVersion: PROTOCOL_VERSION,
        action: "rollup",
        session,
      });
    } catch {
      this.warn(ctx, "lifecycle");
    }
  }

  shutdown(ctx: ExtensionContext): Promise<void> {
    this.generation += 1;
    this.activeState = false;
    this.setStatus(ctx, undefined);
    if (this.shutdownPromise !== undefined) return this.shutdownPromise;

    let finalize: BridgeRequest | undefined;
    if (this.finalizable) {
      try {
        const session = this.session(ctx);
        if (session.file !== undefined) {
          finalize = {
            protocolVersion: PROTOCOL_VERSION,
            action: "finalize",
            session,
          };
        }
      } catch {
        this.warn(ctx, "lifecycle");
      }
    }
    this.shutdownPromise = this.finishShutdown(finalize, ctx);
    return this.shutdownPromise;
  }

  disableForSession(ctx: ExtensionContext): void {
    this.generation += 1;
    this.activeState = false;
    this.finalizable = false;
    this.setStatus(ctx, "optimizer off");
  }

  async beforeTool(
    event: ToolCallEvent,
    ctx: ExtensionContext,
  ): Promise<ToolCallEventResult | void> {
    if (!this.active()) return;
    const generation = this.generation;
    let tool: ToolDescriptor;
    let session: SessionDescriptor;
    try {
      tool = this.toolDescriptor(event.toolCallId, event.toolName, event.input);
    } catch {
      this.warn(ctx, "metadata");
      return;
    }
    try {
      session = this.session(ctx);
    } catch {
      this.warn(ctx, "lifecycle");
      return;
    }

    try {
      const response = await this.bridge.run({
        protocolVersion: PROTOCOL_VERSION,
        action: "pre_tool",
        session,
        tool,
      }, { timeoutMs: BRIDGE_TIMEOUT_MS, signal: ctx.signal });
      if (generation !== this.generation || !this.active()) return;
      if (!isBridgeResponse(response, "pre_tool") || !response.ok) {
        this.warn(ctx, "bridge");
        return;
      }

      const reason = this.blockReason(response, tool);
      if (reason !== undefined) return { block: true, reason };

      if (response.decision === "allow"
        && tool.kind === "builtin"
        && tool.name === "Bash"
        && isToolCallEventType("bash", event)
        && this.isCommandUpdate(response.updatedInput)) {
        event.input.command = response.updatedInput.command;
      }
    } catch {
      if (generation === this.generation) this.warn(ctx, "bridge");
    }
  }

  async afterTool(
    event: ToolResultEvent,
    ctx: ExtensionContext,
  ): Promise<{ content: ToolResultEvent["content"] } | void> {
    if (!this.active()) return;
    const generation = this.generation;
    let tool: ToolDescriptor;
    let session: SessionDescriptor;
    try {
      tool = this.toolDescriptor(event.toolCallId, event.toolName, event.input);
    } catch {
      this.warn(ctx, "metadata");
      return;
    }
    try {
      session = this.session(ctx);
    } catch {
      this.warn(ctx, "lifecycle");
      return;
    }

    try {
      const hasImages = event.content.some((block) => block.type === "image");
      const text = event.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const fullOutputPath = tool.kind === "builtin"
        && tool.name === "Bash"
        && isBashToolResult(event)
        && typeof event.details?.fullOutputPath === "string"
        && event.details.fullOutputPath.length > 0
        ? event.details.fullOutputPath
        : undefined;
      const response = await this.bridge.run({
        protocolVersion: PROTOCOL_VERSION,
        action: "post_tool",
        session,
        tool,
        args: {
          text,
          isError: event.isError,
          hasImages,
          ...(fullOutputPath === undefined ? {} : { fullOutputPath }),
        },
      }, { timeoutMs: BRIDGE_TIMEOUT_MS, signal: ctx.signal });
      if (generation !== this.generation || !this.active()) return;
      if (!isBridgeResponse(response, "post_tool") || !response.ok) {
        this.warn(ctx, "bridge");
        return;
      }
      if (event.isError || hasImages || response.replacementText === undefined) return;
      return { content: [{ type: "text", text: response.replacementText }] };
    } catch {
      if (generation === this.generation) this.warn(ctx, "bridge");
    }
  }

  private active(): boolean {
    return this.activeState;
  }

  private hasConsent(config: OptimizerConfig): boolean {
    return config.enabled
      && config.consent.granted
      && config.consent.noticeVersion === CONSENT_NOTICE_VERSION;
  }

  private session(ctx: ExtensionContext): SessionDescriptor {
    const file = ctx.sessionManager.getSessionFile();
    return {
      id: ctx.sessionManager.getSessionId(),
      cwd: ctx.cwd,
      ...(file === undefined ? {} : { file }),
      ...(ctx.model === undefined ? {} : { provider: ctx.model.provider, model: ctx.model.id }),
      ...(ctx.thinkingLevel === undefined ? {} : { reasoningLevel: ctx.thinkingLevel }),
    };
  }

  private setStatus(ctx: ExtensionContext, text: string | undefined): void {
    try {
      ctx.ui?.setStatus(STATUS_KEY, text);
    } catch {
      this.warn(ctx, "lifecycle");
    }
  }

  private warn(ctx: ExtensionContext, failure: FailureClass): void {
    if (!ctx.hasUI || this.warned.has(failure)) return;
    this.warned.add(failure);
    try {
      ctx.ui?.notify(FAILURE_MESSAGES[failure], "warning");
    } catch {}
  }

  private async finishShutdown(
    finalize: BridgeRequest | undefined,
    ctx: ExtensionContext,
  ): Promise<void> {
    const work: Promise<unknown>[] = [
      Promise.resolve().then(() => this.bridge.drainOrKill(BRIDGE_TIMEOUT_MS)),
    ];
    if (finalize !== undefined) {
      work.push(Promise.resolve().then(() => this.bridge.run(finalize, {
        timeoutMs: BRIDGE_TIMEOUT_MS,
      })).then((response) => {
        if (!isBridgeResponse(response, "finalize") || !response.ok) throw new Error();
      }));
    }
    await this.withinBudget(Promise.allSettled(work).then((results) => {
      if (results.some((result) => result.status === "rejected")) this.warn(ctx, "lifecycle");
    }));
  }

  private withinBudget(work: Promise<unknown>): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, SHUTDOWN_BUDGET_MS);
      work.then(() => {
        clearTimeout(timer);
        resolve();
      }, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private toolDescriptor(
    id: string,
    name: string,
    input: Record<string, unknown>,
  ): ToolDescriptor {
    const builtin = this.pi.getAllTools().find((tool) => tool.name === name)?.sourceInfo.source
      === "builtin";
    if (!builtin || BUILTIN_NAMES[name] === undefined) {
      return { id, name, kind: builtin ? "builtin" : "external", input: { ...input } };
    }

    const normalized = { ...input };
    if (PATH_TO_FILE_PATH.has(name) && "path" in normalized) {
      normalized.file_path = normalized.path;
      delete normalized.path;
    }
    return { id, name: BUILTIN_NAMES[name], kind: "builtin", input: normalized };
  }

  private blockReason(
    response: { decision?: "allow" | "block"; data?: Record<string, unknown> },
    tool: ToolDescriptor,
  ): string | undefined {
    if (response.decision !== "block"
      || (tool.kind === "builtin" && tool.name !== "Read")
      || typeof response.data?.reason !== "string"
      || response.data.reason.trim().length === 0) {
      return undefined;
    }
    return typeof response.data.additionalContext === "string"
      && response.data.additionalContext.trim().length > 0
      ? `${response.data.reason}\n\n${response.data.additionalContext}`
      : response.data.reason;
  }

  private isCommandUpdate(value: Record<string, unknown> | undefined): value is { command: string } {
    return value !== undefined
      && Object.keys(value).length === 1
      && typeof value.command === "string"
      && value.command.trim().length > 0;
  }
}
