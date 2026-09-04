import { setTimeout as delay } from "node:timers/promises";

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
  hasCurrentConsent,
  type ConfigStore,
  type OptimizerConfig,
} from "./config.ts";
import {
  PROTOCOL_VERSION,
  isBridgeResponse,
  isHealthyStatus,
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
export const NUDGE_TYPE = "token-optimizer-nudge";
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

export function sessionDescriptor(ctx: ExtensionContext): SessionDescriptor {
  const file = ctx.sessionManager.getSessionFile();
  const model = ctx.model;
  return {
    id: ctx.sessionManager.getSessionId(),
    cwd: ctx.cwd,
    ...(file === undefined ? {} : { file }),
    ...(model === undefined
      ? {}
      : { provider: model.provider, model: model.id }),
    ...(ctx.thinkingLevel === undefined
      ? {}
      : { reasoningLevel: ctx.thinkingLevel }),
  };
}

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

  async start(
    ctx: ExtensionContext,
    reason: SessionStartEvent["reason"],
  ): Promise<void> {
    this.warned.clear();
    this.shutdownPromise = undefined;
    if (!(await this.refresh(ctx))) return;

    const response = await this.request(
      ctx,
      "session_start",
      { args: { reason } },
      "lifecycle",
    );
    if (response === undefined) return;
    const recovery = response.contexts?.[0];
    if (recovery?.scope !== "recovery") return;
    const generation = this.generation;
    try {
      this.pi.sendMessage(
        {
          customType: RECOVERY_TYPE,
          content: recovery.text,
          display: false,
        },
        { triggerTurn: false },
      );
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
      session = sessionDescriptor(ctx);
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
      status = await this.bridge.run(
        {
          protocolVersion: PROTOCOL_VERSION,
          action: "status",
          session,
        },
        { timeoutMs: BRIDGE_TIMEOUT_MS, signal: ctx.signal },
      );
    } catch {
      if (generation === this.generation) this.warn(ctx, "bridge");
    }
    if (generation !== this.generation) return false;

    this.compatible = isHealthyStatus(status);
    if (!this.compatible) this.warn(ctx, "bridge");
    this.activeState =
      this.compatible &&
      config !== undefined &&
      config.enabled &&
      hasCurrentConsent(config) &&
      status?.data?.active === true;
    this.finalizable = this.activeState;
    this.setStatus(
      ctx,
      config === undefined || !this.compatible
        ? "optimizer unavailable"
        : this.activeState
          ? "optimizer on"
          : "optimizer off",
    );
    return this.activeState;
  }

  isActive(): boolean {
    return this.activeState;
  }

  async compacted(ctx: ExtensionContext): Promise<void> {
    if (!this.activeState) return;
    await this.request(ctx, "post_compact", {});
  }

  async runControl(
    action: Extract<BridgeAction, "status" | "doctor" | "dashboard" | "expand">,
    ctx: ExtensionContext,
    args: Record<string, unknown> | undefined,
    signal: AbortSignal | undefined,
  ): Promise<BridgeResponse | null> {
    try {
      return await this.bridge.run(
        {
          protocolVersion: PROTOCOL_VERSION,
          action,
          session: sessionDescriptor(ctx),
          ...(args === undefined ? {} : { args }),
        },
        { timeoutMs: BRIDGE_TIMEOUT_MS, signal },
      );
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
    if (!this.activeState) return;
    const response = await this.request(ctx, "before_prompt", {
      args: { prompt: event.prompt },
    });
    if (response === undefined) return;
    const nudge = response.contexts?.[0];
    if (nudge?.scope !== "nudge") return;
    return {
      message: {
        customType: NUDGE_TYPE,
        content: nudge.text,
        display: false,
      },
    };
  }

  filterContext(
    event: ContextEvent,
  ): { messages: ContextEvent["messages"] } | void {
    const isNudge = (message: ContextEvent["messages"][number]) =>
      message.role === "custom" && message.customType === NUDGE_TYPE;
    const newest = event.messages.findLastIndex(isNudge);
    if (newest === -1 || event.messages.findIndex(isNudge) === newest) return;
    return {
      messages: event.messages.filter(
        (message, index) => !isNudge(message) || index === newest,
      ),
    };
  }

  settled(ctx: ExtensionContext): void {
    if (!this.activeState) return;
    try {
      const session = sessionDescriptor(ctx);
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
        const session = sessionDescriptor(ctx);
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
    if (!this.activeState) return;
    const generation = this.generation;
    let tool: ToolDescriptor;
    try {
      tool = this.toolDescriptor(event.toolCallId, event.toolName, event.input);
    } catch {
      this.warn(ctx, "metadata");
      return;
    }

    const response = await this.request(ctx, "pre_tool", { tool });
    if (response === undefined) return;
    try {
      const reason = this.blockReason(response, tool);
      if (reason !== undefined) return { block: true, reason };

      if (
        response.decision === "allow" &&
        tool.kind === "builtin" &&
        tool.name === "Bash" &&
        isToolCallEventType("bash", event) &&
        this.isCommandUpdate(response.updatedInput)
      ) {
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
    if (!this.activeState) return;
    const generation = this.generation;
    let tool: ToolDescriptor;
    try {
      tool = this.toolDescriptor(event.toolCallId, event.toolName, event.input);
    } catch {
      this.warn(ctx, "metadata");
      return;
    }

    let hasImages: boolean;
    let text: string;
    let fullOutputPath: string | undefined;
    try {
      hasImages = event.content.some((block) => block.type === "image");
      text = event.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      fullOutputPath =
        tool.kind === "builtin" &&
        tool.name === "Bash" &&
        isBashToolResult(event) &&
        typeof event.details?.fullOutputPath === "string" &&
        event.details.fullOutputPath.length > 0
          ? event.details.fullOutputPath
          : undefined;
    } catch {
      if (generation === this.generation) this.warn(ctx, "bridge");
      return;
    }
    const response = await this.request(ctx, "post_tool", {
      tool,
      args: {
        text,
        isError: event.isError,
        hasImages,
        ...(fullOutputPath === undefined ? {} : { fullOutputPath }),
      },
    });
    if (
      response === undefined ||
      event.isError ||
      hasImages ||
      response.replacementText === undefined
    )
      return;
    return { content: [{ type: "text", text: response.replacementText }] };
  }

  private async request(
    ctx: ExtensionContext,
    action: BridgeAction,
    extra: Pick<BridgeRequest, "tool" | "args">,
    failure: FailureClass = "bridge",
  ): Promise<BridgeResponse | undefined> {
    const generation = this.generation;
    let session: SessionDescriptor;
    let signal: AbortSignal | undefined;
    try {
      session = sessionDescriptor(ctx);
      signal = ctx.signal;
    } catch {
      this.warn(ctx, "lifecycle");
      return undefined;
    }

    let response: BridgeResponse | null;
    try {
      response = await this.bridge.run(
        {
          protocolVersion: PROTOCOL_VERSION,
          action,
          session,
          ...(extra.tool === undefined ? {} : { tool: extra.tool }),
          ...(extra.args === undefined ? {} : { args: extra.args }),
        },
        { timeoutMs: BRIDGE_TIMEOUT_MS, signal },
      );
    } catch {
      if (generation === this.generation) this.warn(ctx, failure);
      return undefined;
    }
    if (generation !== this.generation || !this.activeState) return undefined;
    if (!isBridgeResponse(response, action) || !response.ok) {
      this.warn(ctx, failure);
      return undefined;
    }
    return response;
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
      work.push(
        Promise.resolve()
          .then(() =>
            this.bridge.run(finalize, {
              timeoutMs: BRIDGE_TIMEOUT_MS,
            }),
          )
          .then((response) => {
            if (!isBridgeResponse(response, "finalize") || !response.ok)
              throw new Error();
          }),
      );
    }
    await this.withinBudget(
      Promise.allSettled(work).then((results) => {
        if (results.some((result) => result.status === "rejected"))
          this.warn(ctx, "lifecycle");
      }),
    );
  }

  private async withinBudget(work: Promise<unknown>): Promise<void> {
    await Promise.race([
      work.catch(() => {}),
      delay(SHUTDOWN_BUDGET_MS, undefined, { ref: false }),
    ]);
  }

  private toolDescriptor(
    id: string,
    name: string,
    input: Record<string, unknown>,
  ): ToolDescriptor {
    const builtin =
      this.pi.getAllTools().find((tool) => tool.name === name)?.sourceInfo
        .source === "builtin";
    if (!builtin || BUILTIN_NAMES[name] === undefined) {
      return {
        id,
        name,
        kind: builtin ? "builtin" : "external",
        input: { ...input },
      };
    }

    const normalized = { ...input };
    if (PATH_TO_FILE_PATH.has(name) && "path" in normalized) {
      normalized.file_path = normalized.path;
      delete normalized.path;
    }
    return {
      id,
      name: BUILTIN_NAMES[name],
      kind: "builtin",
      input: normalized,
    };
  }

  private blockReason(
    response: { decision?: "allow" | "block"; data?: Record<string, unknown> },
    tool: ToolDescriptor,
  ): string | undefined {
    if (
      response.decision !== "block" ||
      (tool.kind === "builtin" && tool.name !== "Read") ||
      typeof response.data?.reason !== "string" ||
      response.data.reason.trim().length === 0
    ) {
      return undefined;
    }
    return typeof response.data.additionalContext === "string" &&
      response.data.additionalContext.trim().length > 0
      ? `${response.data.reason}\n\n${response.data.additionalContext}`
      : response.data.reason;
  }

  private isCommandUpdate(
    value: Record<string, unknown> | undefined,
  ): value is { command: string } {
    return (
      value !== undefined &&
      Object.keys(value).length === 1 &&
      typeof value.command === "string" &&
      value.command.trim().length > 0
    );
  }
}
