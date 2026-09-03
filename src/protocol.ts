export const PROTOCOL_VERSION = 1 as const;
export const MAX_ID_LENGTH = 128;
export const MAX_DESCRIPTOR_STRING_BYTES = 4 * 1024;
export const MAX_TEXT_BYTES = 5 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 5.5 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 64 * 1024;
export const MAX_EXPANSION_TEXT_BYTES = 50 * 1024;
export const MAX_EXPANSION_LINES = 2_000;

export const BRIDGE_ACTIONS = [
  "status",
  "doctor",
  "pre_tool",
  "post_tool",
  "before_prompt",
  "session_start",
  "pre_compact",
  "post_compact",
  "rollup",
  "finalize",
  "dashboard",
  "expand",
] as const;

export type BridgeAction = typeof BRIDGE_ACTIONS[number];

export interface SessionDescriptor {
  id: string;
  cwd: string;
  file?: string;
  provider?: string;
  model?: string;
  reasoningLevel?: string;
}

export interface ToolDescriptor {
  id: string;
  name: string;
  kind: "builtin" | "external";
  input: Record<string, unknown>;
}

export interface BridgeRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  action: BridgeAction;
  session: SessionDescriptor;
  tool?: ToolDescriptor;
  args?: Record<string, unknown>;
}

export interface BridgeResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  ok: boolean;
  decision?: "allow" | "block";
  updatedInput?: Record<string, unknown>;
  replacementText?: string;
  archiveId?: string;
  contexts?: Array<{ scope: "nudge" | "recovery"; text: string }>;
  data?: Record<string, unknown>;
  errorCode?: string;
}

const ACTIONS = new Set<string>(BRIDGE_ACTIONS);
const REQUEST_KEYS = new Set(["protocolVersion", "action", "session", "tool", "args"]);
const SESSION_KEYS = new Set(["id", "cwd", "file", "provider", "model", "reasoningLevel"]);
const TOOL_KEYS = new Set(["id", "name", "kind", "input"]);
const RESPONSE_KEYS = new Set([
  "protocolVersion",
  "ok",
  "decision",
  "updatedInput",
  "replacementText",
  "archiveId",
  "contexts",
  "data",
  "errorCode",
]);
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function fits(value: string, bytes: number): boolean {
  return Buffer.byteLength(value, "utf8") <= bytes;
}

function isNonemptyString(value: unknown, bytes = MAX_DESCRIPTOR_STRING_BYTES): value is string {
  return typeof value === "string" && value.trim().length > 0 && fits(value, bytes);
}

function isBoundedString(value: unknown, bytes: number): value is string {
  return typeof value === "string" && fits(value, bytes);
}

function isId(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= MAX_ID_LENGTH
    && ID_PATTERN.test(value);
}

function isJsonValue(value: unknown, depth = 0, ancestors = new Set<object>()): boolean {
  if (depth >= 20) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return typeof value !== "string" || fits(value, MAX_TEXT_BYTES);
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;

  ancestors.add(value);
  let valid: boolean;
  if (Array.isArray(value)) {
    valid = value.length <= 10_000
      && value.every((item) => isJsonValue(item, depth + 1, ancestors));
  } else if (isRecord(value)) {
    const entries = Object.entries(value);
    valid = entries.length <= 1_000
      && entries.every(([key, item]) => fits(key, 256) && isJsonValue(item, depth + 1, ancestors));
  } else {
    valid = false;
  }
  ancestors.delete(value);
  return valid;
}

function encodedSizeAtMost(value: unknown, maxBytes: number): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= maxBytes;
  } catch {
    return false;
  }
}

function isSessionDescriptor(value: unknown): value is SessionDescriptor {
  if (!isRecord(value) || !hasOnlyKeys(value, SESSION_KEYS) || !isId(value.id)) return false;

  return isNonemptyString(value.cwd)
    && (value.file === undefined || isNonemptyString(value.file))
    && (value.provider === undefined || isNonemptyString(value.provider))
    && (value.model === undefined || isNonemptyString(value.model))
    && (value.reasoningLevel === undefined || isNonemptyString(value.reasoningLevel));
}

function isToolDescriptor(value: unknown): value is ToolDescriptor {
  return isRecord(value)
    && hasOnlyKeys(value, TOOL_KEYS)
    && isId(value.id)
    && isNonemptyString(value.name)
    && (value.kind === "builtin" || value.kind === "external")
    && isRecord(value.input)
    && isJsonValue(value.input);
}

function hasString(args: Record<string, unknown> | undefined, key: string): boolean {
  return args !== undefined && isBoundedString(args[key], MAX_TEXT_BYTES);
}

function hasRequiredRequestFields(request: BridgeRequest): boolean {
  switch (request.action) {
    case "pre_tool":
      return request.tool !== undefined;
    case "post_tool":
      return request.tool !== undefined
        && hasString(request.args, "text")
        && typeof request.args?.isError === "boolean"
        && typeof request.args.hasImages === "boolean"
        && (request.args.fullOutputPath === undefined
          || (request.tool.kind === "builtin"
            && request.tool.name === "bash"
            && isNonemptyString(request.args.fullOutputPath)));
    case "before_prompt":
      return request.args !== undefined
        && isNonemptyString(request.args.prompt, MAX_TEXT_BYTES);
    case "rollup":
    case "finalize":
      return request.session.file !== undefined;
    case "expand": {
      const args = request.args;
      if (args === undefined || !isId(args.archiveId)) return false;
      if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || (args.offset as number) < 0)) return false;
      if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || (args.limit as number) < 1 || (args.limit as number) > MAX_EXPANSION_LINES)) return false;
      return true;
    }
    default:
      return true;
  }
}

export function isBridgeRequest(value: unknown): value is BridgeRequest {
  if (!isRecord(value)
    || !hasOnlyKeys(value, REQUEST_KEYS)
    || value.protocolVersion !== PROTOCOL_VERSION
    || typeof value.action !== "string"
    || !ACTIONS.has(value.action)
    || !isSessionDescriptor(value.session)
    || (value.tool !== undefined && !isToolDescriptor(value.tool))
    || (value.args !== undefined && (!isRecord(value.args) || !isJsonValue(value.args)))) {
    return false;
  }

  const request = value as unknown as BridgeRequest;
  if (request.tool !== undefined && request.action !== "pre_tool" && request.action !== "post_tool") return false;
  return hasRequiredRequestFields(request) && encodedSizeAtMost(request, MAX_REQUEST_BYTES);
}

export function validateBridgeRequest(value: unknown): BridgeRequest {
  if (!isBridgeRequest(value)) throw new TypeError("Invalid bridge request");
  return value;
}

function isContext(value: unknown, action: BridgeAction): boolean {
  if (!isRecord(value)
    || !hasOnlyKeys(value, new Set(["scope", "text"]))
    || !isNonemptyString(value.text, MAX_EXPANSION_TEXT_BYTES)) {
    return false;
  }
  return (action === "before_prompt" && value.scope === "nudge")
    || (action === "session_start" && value.scope === "recovery");
}

function responseFieldsFitAction(response: BridgeResponse, action: BridgeAction): boolean {
  if (response.updatedInput !== undefined && action !== "pre_tool") return false;
  if ((response.replacementText !== undefined || response.archiveId !== undefined) && action !== "post_tool") return false;
  if (response.contexts !== undefined && action !== "before_prompt" && action !== "session_start") return false;
  if (response.decision !== undefined && action !== "pre_tool" && action !== "post_tool") return false;
  if (action === "post_tool" && response.decision === "block") return false;
  if (action === "post_tool"
    && response.ok
    && (response.replacementText === undefined) !== (response.archiveId === undefined)) return false;
  if (action === "expand" && response.ok) {
    const text = response.data?.text;
    const nextOffset = response.data?.nextOffset;
    if (!isBoundedString(text, MAX_EXPANSION_TEXT_BYTES)
      || text.split("\n").length > MAX_EXPANSION_LINES
      || (nextOffset !== undefined
        && (!Number.isSafeInteger(nextOffset) || (nextOffset as number) < 0))) return false;
  }
  return true;
}

export function isBridgeResponse(value: unknown, action: BridgeAction): value is BridgeResponse {
  if (!ACTIONS.has(action)
    || !isRecord(value)
    || !hasOnlyKeys(value, RESPONSE_KEYS)
    || value.protocolVersion !== PROTOCOL_VERSION
    || typeof value.ok !== "boolean"
    || (value.decision !== undefined && value.decision !== "allow" && value.decision !== "block")
    || (value.updatedInput !== undefined && (!isRecord(value.updatedInput) || !isJsonValue(value.updatedInput)))
    || (value.replacementText !== undefined && !isNonemptyString(value.replacementText, MAX_RESPONSE_BYTES))
    || (value.archiveId !== undefined && !isId(value.archiveId))
    || (value.data !== undefined && (!isRecord(value.data) || !isJsonValue(value.data)))
    || (value.errorCode !== undefined && (!isNonemptyString(value.errorCode, MAX_ID_LENGTH) || !ERROR_CODE_PATTERN.test(value.errorCode)))) {
    return false;
  }

  if (value.contexts !== undefined) {
    if (!Array.isArray(value.contexts)
      || value.contexts.length > 1
      || !value.contexts.every((context) => isContext(context, action))) {
      return false;
    }
  }

  if ((value.ok && value.errorCode !== undefined) || (!value.ok && value.errorCode === undefined)) return false;
  if (!value.ok && (value.decision !== undefined
    || value.updatedInput !== undefined
    || value.replacementText !== undefined
    || value.archiveId !== undefined
    || value.contexts !== undefined)) {
    return false;
  }

  return responseFieldsFitAction(value as unknown as BridgeResponse, action)
    && encodedSizeAtMost(value, MAX_RESPONSE_BYTES);
}

export function validateBridgeResponse(value: unknown, action: BridgeAction): BridgeResponse {
  if (!isBridgeResponse(value, action)) throw new TypeError("Invalid bridge response");
  return value;
}
