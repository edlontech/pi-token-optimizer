import assert from "node:assert/strict";
import test from "node:test";

import type {
  BeforeAgentStartEvent,
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

import { PiAdapter } from "../src/adapter.ts";
import type { BridgeClient } from "../src/bridge.ts";
import type { OptimizerConfig } from "../src/config.ts";
import { isBridgeRequest, type BridgeRequest, type BridgeResponse } from "../src/protocol.ts";

const activeConfig = {
  schemaVersion: 1,
  enabled: true,
  consent: { granted: true, noticeVersion: 1, grantedAt: "2026-09-03T00:00:00.000Z" },
} as const;

function context(
  overrides: Partial<ExtensionContext> = {},
  statuses: Array<[string, string | undefined]> = [],
): ExtensionContext {
  return {
    cwd: "/work/project",
    mode: "tui",
    hasUI: true,
    ui: {
      setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
    },
    model: { id: "sonnet", provider: "anthropic" },
    thinkingLevel: "high",
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => "/sessions/session-1.jsonl",
    },
    signal: new AbortController().signal,
    ...overrides,
  } as ExtensionContext;
}

function sourceInfo(source: string) {
  return {
    path: `<${source}>`,
    source,
    scope: "temporary" as const,
    origin: "top-level" as const,
  };
}

function piWithTools(
  tools: Array<{ name: string; source: string }>,
  messages: Array<{ message: unknown; options: unknown }> = [],
) {
  return {
    getAllTools: () => tools.map(({ name, source }) => ({
      name,
      description: "test tool",
      parameters: {},
      sourceInfo: sourceInfo(source),
    })),
    sendMessage: (message: unknown, options: unknown) => messages.push({ message, options }),
  } as Pick<ExtensionAPI, "getAllTools" | "sendMessage">;
}

function bridgeReturning(
  response: BridgeResponse | null,
  requests: BridgeRequest[],
  options: Array<{ timeoutMs: number; signal?: AbortSignal }> = [],
) {
  return {
    run: async (request: BridgeRequest, runOptions: { timeoutMs: number; signal?: AbortSignal }) => {
      requests.push(request);
      options.push(runOptions);
      return response;
    },
    runTracked: () => {},
    drainOrKill: async () => {},
  } as Pick<BridgeClient, "run" | "runTracked" | "drainOrKill">;
}

const healthyStatus: BridgeResponse = {
  protocolVersion: 1,
  ok: true,
  data: { runtime: "pi", protocolVersion: 1, healthy: true, active: true },
};

async function activeAdapter(
  pi: Pick<ExtensionAPI, "getAllTools" | "sendMessage">,
  bridge: Pick<BridgeClient, "run"> & Partial<Pick<BridgeClient, "runTracked" | "drainOrKill">>,
  config: OptimizerConfig = structuredClone(activeConfig),
  status: BridgeResponse | null = healthyStatus,
): Promise<PiAdapter> {
  const lifecycleBridge = {
    runTracked: bridge.runTracked ?? (() => {}),
    drainOrKill: bridge.drainOrKill ?? (async () => {}),
    run: async (request: BridgeRequest, options: { timeoutMs: number; signal?: AbortSignal }) => {
      if (request.action === "status") return status;
      if (request.action === "session_start") return { protocolVersion: 1, ok: true } as const;
      return bridge.run(request, options);
    },
  };
  const adapter = new PiAdapter(pi, lifecycleBridge, { load: async () => structuredClone(config) });
  await adapter.start(context(), "startup");
  return adapter;
}

test("start checks health then injects one hidden recovery without starting a turn", async () => {
  const requests: BridgeRequest[] = [];
  const options: Array<{ timeoutMs: number; signal?: AbortSignal }> = [];
  const messages: Array<{ message: unknown; options: unknown }> = [];
  const statuses: Array<[string, string | undefined]> = [];
  let loads = 0;
  const bridge = {
    run: async (request: BridgeRequest, runOptions: { timeoutMs: number; signal?: AbortSignal }) => {
      requests.push(request);
      options.push(runOptions);
      return request.action === "status"
        ? healthyStatus
        : {
            protocolVersion: 1,
            ok: true,
            contexts: [{ scope: "recovery", text: "resume safely" }],
          } satisfies BridgeResponse;
    },
    runTracked: () => {},
    drainOrKill: async () => {},
  };
  const adapter = new PiAdapter(piWithTools([], messages), bridge, {
    load: async () => {
      loads += 1;
      return structuredClone(activeConfig);
    },
  });
  const ctx = context({}, statuses);

  await adapter.start(ctx, "resume");

  assert.equal(loads, 1);
  assert.deepEqual(requests.map((request) => request.action), ["status", "session_start"]);
  assert.deepEqual(requests[1].args, { reason: "resume" });
  assert.deepEqual(options, [
    { timeoutMs: 2_500, signal: ctx.signal },
    { timeoutMs: 2_500, signal: ctx.signal },
  ]);
  assert.deepEqual(messages, [{
    message: {
      customType: "token-optimizer-recovery",
      content: "resume safely",
      display: false,
    },
    options: { triggerTurn: false },
  }]);
  assert.deepEqual(statuses, [["token-optimizer", "optimizer on"]]);
});

test("start stays inactive without valid local consent and healthy active bridge status", async () => {
  const cases: Array<{
    config: OptimizerConfig | Error;
    status: BridgeResponse | null;
    footer: string;
  }> = [
    { config: { ...activeConfig, enabled: false }, status: healthyStatus, footer: "optimizer off" },
    {
      config: { ...activeConfig, consent: { granted: false, noticeVersion: 1 } },
      status: healthyStatus,
      footer: "optimizer off",
    },
    {
      config: activeConfig,
      status: { ...healthyStatus, data: { ...healthyStatus.data, active: false } },
      footer: "optimizer off",
    },
    { config: activeConfig, status: null, footer: "optimizer unavailable" },
    { config: new Error("bad config"), status: healthyStatus, footer: "optimizer unavailable" },
  ];

  for (const current of cases) {
    const requests: BridgeRequest[] = [];
    const messages: Array<{ message: unknown; options: unknown }> = [];
    const statuses: Array<[string, string | undefined]> = [];
    const bridge = {
      run: async (request: BridgeRequest) => {
        requests.push(request);
        return current.status;
      },
      runTracked: () => { throw new Error("must stay inactive"); },
      drainOrKill: async () => {},
    };
    const adapter = new PiAdapter(piWithTools([], messages), bridge, {
      load: async () => {
        if (current.config instanceof Error) throw current.config;
        return structuredClone(current.config);
      },
    });
    const ctx = context({}, statuses);

    await adapter.start(ctx, "startup");
    adapter.settled(ctx);

    assert.deepEqual(requests.map((request) => request.action), ["status"]);
    assert.deepEqual(messages, []);
    assert.deepEqual(statuses.at(-1), ["token-optimizer", current.footer]);
  }
});

test("start rebuilds cached state for each session", async () => {
  const requests: BridgeRequest[] = [];
  const statuses: Array<[string, string | undefined]> = [];
  let load = 0;
  const adapter = new PiAdapter(piWithTools([]), {
    run: async (request) => {
      requests.push(request);
      return request.action === "status" ? healthyStatus : { protocolVersion: 1, ok: true };
    },
    runTracked: (request) => requests.push(request),
    drainOrKill: async () => {},
  }, {
    load: async () => load++ === 0
      ? structuredClone(activeConfig)
      : { ...structuredClone(activeConfig), enabled: false },
  });
  const ctx = context({}, statuses);

  await adapter.start(ctx, "startup");
  await adapter.start(ctx, "new");
  adapter.settled(ctx);

  assert.deepEqual(requests.map((request) => request.action), [
    "status",
    "session_start",
    "status",
  ]);
  assert.deepEqual(statuses, [
    ["token-optimizer", "optimizer on"],
    ["token-optimizer", "optimizer off"],
  ]);
});

test("beforePrompt returns one hidden nudge and fails open on bridge errors", async () => {
  const event = { type: "before_agent_start", prompt: "continue" } as BeforeAgentStartEvent;
  const requests: BridgeRequest[] = [];
  const signal = new AbortController().signal;
  const adapter = await activeAdapter(piWithTools([]), bridgeReturning({
    protocolVersion: 1,
    ok: true,
    contexts: [{ scope: "nudge", text: "stay focused" }],
  }, requests));

  assert.deepEqual(await adapter.beforePrompt(event, context({ signal })), {
    message: {
      customType: "token-optimizer-nudge",
      content: "stay focused",
      display: false,
    },
  });
  assert.deepEqual(requests, [{
    protocolVersion: 1,
    action: "before_prompt",
    session: {
      id: "session-1",
      file: "/sessions/session-1.jsonl",
      cwd: "/work/project",
      model: "sonnet",
      provider: "anthropic",
      reasoningLevel: "high",
    },
    args: { prompt: "continue" },
  }]);

  const failed = await activeAdapter(piWithTools([]), {
    run: async () => { throw new Error("bridge failed"); },
  });
  assert.equal(await failed.beforePrompt(event, context()), undefined);
});

test("filterContext keeps recovery and unrelated messages but only the newest nudge", () => {
  const recovery = {
    role: "custom",
    customType: "token-optimizer-recovery",
    content: "recover",
    display: false,
    timestamp: 1,
  } as const;
  const oldNudge = {
    role: "custom",
    customType: "token-optimizer-nudge",
    content: "old",
    display: false,
    timestamp: 30,
  } as const;
  const unrelated = {
    role: "custom",
    customType: "another-extension",
    content: "keep",
    display: false,
    timestamp: 2,
  } as const;
  const newNudge = {
    role: "custom",
    customType: "token-optimizer-nudge",
    content: "new",
    display: false,
    timestamp: 3,
  } as const;
  const event = {
    type: "context",
    messages: [recovery, oldNudge, unrelated, recovery, newNudge],
  } as ContextEvent;
  const original = [...event.messages];
  const adapter = new PiAdapter(piWithTools([]), bridgeReturning(null, []), {
    load: async () => structuredClone(activeConfig),
  });

  const result = adapter.filterContext(event);

  assert.deepEqual(result?.messages, [recovery, unrelated, recovery, newNudge]);
  assert.deepEqual(event.messages, original);
  assert.equal(result?.messages[0], recovery);
  assert.equal(result?.messages[1], unrelated);
});

test("normalizes a builtin read and builds the current Pi session descriptor", async () => {
  const requests: BridgeRequest[] = [];
  const bridge = bridgeReturning({ protocolVersion: 1, ok: true, decision: "allow" }, requests);
  const adapter = await activeAdapter(
    piWithTools([{ name: "read", source: "builtin" }]),
    bridge,
  );
  const event: ToolCallEvent = {
    type: "tool_call",
    toolName: "read",
    toolCallId: "tool-1",
    input: { path: "src/main.ts", offset: 4, limit: 20 },
  };

  assert.equal(await adapter.beforeTool(event, context()), undefined);
  assert.deepEqual(requests, [{
    protocolVersion: 1,
    action: "pre_tool",
    session: {
      id: "session-1",
      file: "/sessions/session-1.jsonl",
      cwd: "/work/project",
      model: "sonnet",
      provider: "anthropic",
      reasoningLevel: "high",
    },
    tool: {
      id: "tool-1",
      name: "Read",
      kind: "builtin",
      input: { file_path: "src/main.ts", offset: 4, limit: 20 },
    },
  }]);
  assert.deepEqual(event.input, { path: "src/main.ts", offset: 4, limit: 20 });
});

test("normalizes current Pi tool call ids consistently", async () => {
  const requests: BridgeRequest[] = [];
  const adapter = await activeAdapter(
    piWithTools([{ name: "read", source: "builtin" }]),
    bridgeReturning({ protocolVersion: 1, ok: true, decision: "allow" }, requests),
  );
  const toolCallId =
    "call_o44mkoVZvLN4B2j9T8ZQinpg|fc_0d47f241fc54b03d016a9aad8e996087d297ec0097a3b1d174";
  const expectedId =
    "tool_e153ecf5256ff0fcfdc8bcf54168f07a7d62e5805c8ce47991768ef214853d7c";
  const call: ToolCallEvent = {
    type: "tool_call",
    toolName: "read",
    toolCallId,
    input: { path: "src/main.ts" },
  };
  const result: ToolResultEvent = {
    type: "tool_result",
    toolName: "read",
    toolCallId,
    input: { path: "src/main.ts" },
    content: [{ type: "text", text: "output" }],
    details: undefined,
    isError: false,
  };

  await adapter.beforeTool(call, context());
  await adapter.afterTool(result, context());

  assert.deepEqual(
    requests.map((request) => request.tool?.id),
    [expectedId, expectedId],
  );
  assert.equal(requests.every(isBridgeRequest), true);
});

test("maps only source-proven builtins and leaves unknown or external tools untouched", async () => {
  const requests: BridgeRequest[] = [];
  const tools = [
    { name: "bash", source: "builtin", input: { command: "pwd", timeout: 12 } },
    { name: "grep", source: "builtin", input: { pattern: "needle", path: "src" } },
    { name: "find", source: "builtin", input: { pattern: "*.ts", path: "src" } },
    { name: "ls", source: "builtin", input: { path: "src", limit: 5 } },
    { name: "edit", source: "builtin", input: { path: "a.ts", oldText: "a", newText: "b" } },
    { name: "write", source: "builtin", input: { path: "b.ts", content: "ok" } },
    { name: "future", source: "builtin", input: { value: 1 } },
    { name: "read", source: "extension", input: { path: "external", query: "x" } },
  ];
  const adapter = await activeAdapter(
    piWithTools(tools.map(({ name, source }) => ({ name, source }))),
    bridgeReturning({ protocolVersion: 1, ok: true, decision: "allow" }, requests),
  );

  for (const [index, tool] of tools.entries()) {
    const event: ToolCallEvent = {
      type: "tool_call",
      toolName: tool.name,
      toolCallId: `tool-${index}`,
      input: tool.input,
    };
    await adapter.beforeTool(event, context());
  }

  assert.deepEqual(requests.map((request) => request.tool), [
    { id: "tool-0", name: "Bash", kind: "builtin", input: { command: "pwd", timeout: 12 } },
    { id: "tool-1", name: "Grep", kind: "builtin", input: { pattern: "needle", path: "src" } },
    { id: "tool-2", name: "Glob", kind: "builtin", input: { pattern: "*.ts", path: "src" } },
    { id: "tool-3", name: "Glob", kind: "builtin", input: { path: "src", limit: 5 } },
    { id: "tool-4", name: "Edit", kind: "builtin", input: { file_path: "a.ts", oldText: "a", newText: "b" } },
    { id: "tool-5", name: "Write", kind: "builtin", input: { file_path: "b.ts", content: "ok" } },
    { id: "tool-6", name: "future", kind: "builtin", input: { value: 1 } },
    { id: "tool-7", name: "read", kind: "external", input: { path: "external", query: "x" } },
  ]);
});

test("rewrites only a source-proven builtin Bash command within the tool budget", async () => {
  const requests: BridgeRequest[] = [];
  const options: Array<{ timeoutMs: number; signal?: AbortSignal }> = [];
  const signal = new AbortController().signal;
  const adapter = await activeAdapter(
    piWithTools([
      { name: "bash", source: "builtin" },
      { name: "custom-bash", source: "extension" },
    ]),
    bridgeReturning({
      protocolVersion: 1,
      ok: true,
      decision: "allow",
      updatedInput: { command: "optimized" },
    }, requests, options),
  );
  const builtin: ToolCallEvent = {
    type: "tool_call",
    toolName: "bash",
    toolCallId: "bash-1",
    input: { command: "original", timeout: 30 },
  };
  const external: ToolCallEvent = {
    type: "tool_call",
    toolName: "custom-bash",
    toolCallId: "bash-2",
    input: { command: "external", other: true },
  };

  assert.equal(await adapter.beforeTool(builtin, context({ signal })), undefined);
  assert.equal(await adapter.beforeTool(external, context({ signal })), undefined);
  assert.deepEqual(builtin.input, { command: "optimized", timeout: 30 });
  assert.deepEqual(external.input, { command: "external", other: true });
  assert.deepEqual(options, [
    { timeoutMs: 2_500, signal },
    { timeoutMs: 2_500, signal },
  ]);
});

test("blocks only verified read and external refetch decisions with bridge context", async () => {
  const response = {
    protocolVersion: 1,
    ok: true,
    decision: "block",
    data: { reason: "already read", additionalContext: "use this cached excerpt" },
  } as const;
  const events: ToolCallEvent[] = [
    { type: "tool_call", toolName: "read", toolCallId: "read-1", input: { path: "a.ts" } },
    { type: "tool_call", toolName: "search", toolCallId: "search-1", input: { query: "x" } },
    { type: "tool_call", toolName: "future", toolCallId: "future-1", input: { query: "x" } },
  ];
  const adapter = await activeAdapter(
    piWithTools([
      { name: "read", source: "builtin" },
      { name: "search", source: "extension" },
      { name: "future", source: "builtin" },
    ]),
    bridgeReturning(response, []),
  );

  assert.deepEqual(await adapter.beforeTool(events[0], context()), {
    block: true,
    reason: "already read\n\nuse this cached excerpt",
  });
  assert.deepEqual(await adapter.beforeTool(events[1], context()), {
    block: true,
    reason: "already read\n\nuse this cached excerpt",
  });
  assert.equal(await adapter.beforeTool(events[2], context()), undefined);
});

test("settled uses tracked rollups and disableForSession gates activity immediately", async () => {
  const tracked: BridgeRequest[] = [];
  const requests: BridgeRequest[] = [];
  const statuses: Array<[string, string | undefined]> = [];
  const adapter = await activeAdapter(piWithTools([]), {
    run: async (request) => {
      requests.push(request);
      return { protocolVersion: 1, ok: true };
    },
    runTracked: (request) => {
      tracked.push(request);
      if (tracked.length === 2) throw new Error("tracked failure");
    },
    drainOrKill: async () => {},
  });
  const ctx = context({}, statuses);

  adapter.settled(ctx);
  assert.doesNotThrow(() => adapter.settled(ctx));
  adapter.disableForSession(ctx);
  adapter.settled(ctx);
  assert.equal(await adapter.beforePrompt(
    { type: "before_agent_start", prompt: "ignored" } as BeforeAgentStartEvent,
    ctx,
  ), undefined);
  assert.deepEqual(statuses.at(-1), ["token-optimizer", "optimizer off"]);
  await adapter.shutdown(ctx);

  assert.deepEqual(tracked.map((request) => request.action), ["rollup", "rollup"]);
  assert.deepEqual(tracked[0].session, {
    id: "session-1",
    file: "/sessions/session-1.jsonl",
    cwd: "/work/project",
    model: "sonnet",
    provider: "anthropic",
    reasoningLevel: "high",
  });
  assert.deepEqual(requests, []);
  assert.deepEqual(statuses.at(-1), ["token-optimizer", undefined]);
});

test("purge drain permanently retires hot paths for this adapter instance", async () => {
  const direct: BridgeRequest[] = [];
  const tracked: BridgeRequest[] = [];
  const events: string[] = [];
  const adapter = new PiAdapter(piWithTools([]), {
    run: async (request) => {
      direct.push(request);
      return request.action === "status"
        ? healthyStatus
        : { protocolVersion: 1, ok: true };
    },
    runTracked: (request) => {
      events.push("rollup");
      tracked.push(request);
    },
    drainOrKill: async () => { events.push("drain"); },
  }, {
    load: async () => structuredClone(activeConfig),
  });
  const ctx = context();
  await adapter.start(ctx, "startup");
  adapter.settled(ctx);

  adapter.disableForSession(ctx);
  await adapter.drainBridge();
  assert.equal(await adapter.refresh(ctx), false);
  await adapter.start(ctx, "new");
  adapter.settled(ctx);
  assert.equal(await adapter.beforePrompt(
    { type: "before_agent_start", prompt: "ignored" } as BeforeAgentStartEvent,
    ctx,
  ), undefined);

  assert.deepEqual(events, ["rollup", "drain"]);
  assert.deepEqual(tracked.map(({ action }) => action), ["rollup"]);
  assert.deepEqual(direct.map(({ action }) => action), ["status", "session_start"]);
});

test("disableForSession ignores in-flight bridge decisions", async () => {
  const pending = new Map<string, (response: BridgeResponse) => void>();
  const adapter = await activeAdapter(piWithTools([
    { name: "bash", source: "builtin" },
    { name: "search", source: "extension" },
  ]), {
    run: (request) => new Promise((resolve) => pending.set(request.action, resolve)),
  });
  const ctx = context();
  const call: ToolCallEvent = {
    type: "tool_call",
    toolName: "bash",
    toolCallId: "bash-1",
    input: { command: "original" },
  };
  const result: ToolResultEvent = {
    type: "tool_result",
    toolName: "search",
    toolCallId: "search-1",
    input: { query: "needle" },
    content: [{ type: "text", text: "original output" }],
    details: undefined,
    isError: false,
  };
  const prompt = adapter.beforePrompt(
    { type: "before_agent_start", prompt: "continue" } as BeforeAgentStartEvent,
    ctx,
  );
  const before = adapter.beforeTool(call, ctx);
  const after = adapter.afterTool(result, ctx);
  await Promise.resolve();

  adapter.disableForSession(ctx);
  pending.get("before_prompt")?.({
    protocolVersion: 1,
    ok: true,
    contexts: [{ scope: "nudge", text: "late" }],
  });
  pending.get("pre_tool")?.({
    protocolVersion: 1,
    ok: true,
    decision: "allow",
    updatedInput: { command: "late" },
  });
  pending.get("post_tool")?.({
    protocolVersion: 1,
    ok: true,
    replacementText: "late",
    archiveId: "search-1",
  });

  assert.deepEqual(await Promise.all([prompt, before, after]), [undefined, undefined, undefined]);
  assert.deepEqual(call.input, { command: "original" });
  assert.deepEqual(result.content, [{ type: "text", text: "original output" }]);
});

test("shutdown finalizes beside an active rollup, drains once, and clears status", async () => {
  const direct: BridgeRequest[] = [];
  const tracked: BridgeRequest[] = [];
  const statuses: Array<[string, string | undefined]> = [];
  let activeRollup = false;
  let finalizeOverlapped = false;
  let drains = 0;
  const bridge = {
    run: async (request: BridgeRequest) => {
      direct.push(request);
      if (request.action === "status") return healthyStatus;
      if (request.action === "finalize") finalizeOverlapped = activeRollup;
      return { protocolVersion: 1, ok: true } as const;
    },
    runTracked: (request: BridgeRequest) => {
      tracked.push(request);
      activeRollup = true;
    },
    drainOrKill: async () => {
      drains += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeRollup = false;
    },
  };
  const adapter = new PiAdapter(piWithTools([]), bridge, {
    load: async () => structuredClone(activeConfig),
  });
  const ctx = context({}, statuses);
  await adapter.start(ctx, "startup");
  adapter.settled(ctx);

  const first = adapter.shutdown(ctx);
  const second = adapter.shutdown(ctx);
  await Promise.all([first, second]);

  assert.deepEqual(tracked.map((request) => request.action), ["rollup"]);
  assert.equal(direct.filter((request) => request.action === "finalize").length, 1);
  assert.equal(finalizeOverlapped, true);
  assert.equal(drains, 1);
  assert.deepEqual(statuses.at(-1), ["token-optimizer", undefined]);
});

test("shutdown has a bounded total lifecycle budget and captures context before returning", async () => {
  const never = new Promise<never>(() => {});
  const bridge = {
    run: async (request: BridgeRequest) => request.action === "status"
      ? healthyStatus
      : request.action === "session_start"
        ? { protocolVersion: 1, ok: true } as const
        : never,
    runTracked: () => {},
    drainOrKill: async () => never,
  };
  const adapter = new PiAdapter(piWithTools([]), bridge, {
    load: async () => structuredClone(activeConfig),
  });
  const ctx = context();
  await adapter.start(ctx, "startup");

  const started = Date.now();
  const shutdown = adapter.shutdown(ctx);
  (ctx.sessionManager.getSessionId as unknown) = () => { throw new Error("stale context"); };
  (ctx.sessionManager.getSessionFile as unknown) = () => { throw new Error("stale context"); };
  await shutdown;

  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 2_900, `shutdown returned too early: ${elapsed}ms`);
  assert.ok(elapsed < 3_500, `shutdown exceeded budget: ${elapsed}ms`);
});

test("inactive cached state sends no activity request", async () => {
  const event: ToolCallEvent = {
    type: "tool_call",
    toolName: "bash",
    toolCallId: "bash-1",
    input: { command: "original" },
  };
  const result: ToolResultEvent = {
    type: "tool_result",
    toolName: "bash",
    toolCallId: "bash-1",
    input: { command: "original" },
    content: [{ type: "text", text: "output" }],
    details: undefined,
    isError: false,
  };

  for (const [config, compatible] of [
    [{ ...activeConfig, enabled: false }, true],
    [{ ...activeConfig, consent: { granted: false, noticeVersion: 1 as const } }, true],
    [activeConfig, false],
  ] as const) {
    const requests: BridgeRequest[] = [];
    const adapter = await activeAdapter(
      piWithTools([{ name: "bash", source: "builtin" }]),
      bridgeReturning({ protocolVersion: 1, ok: true, decision: "allow" }, requests),
      config,
      compatible ? healthyStatus : null,
    );

    assert.equal(await adapter.beforeTool(event, context()), undefined);
    assert.equal(await adapter.afterTool(result, context()), undefined);
    assert.deepEqual(requests, []);
  }
});

test("bridge rejection and malformed decisions fail open without input mutation", async () => {
  const cases: Array<Pick<BridgeClient, "run">> = [
    { run: async () => { throw new Error("bridge failure"); } },
    { run: async () => null },
    { run: async () => ({ protocolVersion: 2, ok: true } as never) },
    { run: async () => ({
      protocolVersion: 1,
      ok: true,
      decision: "allow",
      updatedInput: { command: "unsafe", timeout: 1 },
    }) },
    { run: async () => ({
      protocolVersion: 1,
      ok: true,
      updatedInput: { command: "unsafe without allow" },
    }) },
    { run: async () => ({
      protocolVersion: 1,
      ok: true,
      decision: "block",
      data: { additionalContext: "missing reason" },
    }) },
  ];

  for (const bridge of cases) {
    const event: ToolCallEvent = {
      type: "tool_call",
      toolName: "bash",
      toolCallId: "bash-1",
      input: { command: "original", timeout: 30 },
    };
    const adapter = await activeAdapter(
      piWithTools([{ name: "bash", source: "builtin" }]),
      bridge,
    );

    assert.equal(await adapter.beforeTool(event, context()), undefined);
    assert.deepEqual(event.input, { command: "original", timeout: 30 });
  }
});

test("tool metadata failures also leave calls and results untouched", async () => {
  const metadataFailures = [
    () => { throw new Error("metadata unavailable"); },
    () => [{
      name: "bash",
      description: "test tool",
      parameters: {},
      get sourceInfo(): never { throw new Error("source unavailable"); },
    }],
  ];

  for (const getAllTools of metadataFailures) {
    const requests: BridgeRequest[] = [];
    const adapter = await activeAdapter(
      { ...piWithTools([]), getAllTools } as Pick<ExtensionAPI, "getAllTools" | "sendMessage">,
      bridgeReturning({ protocolVersion: 1, ok: true, decision: "allow" }, requests),
    );
    const call: ToolCallEvent = {
      type: "tool_call",
      toolName: "bash",
      toolCallId: "bash-1",
      input: { command: "original" },
    };
    const result: ToolResultEvent = {
      type: "tool_result",
      toolName: "bash",
      toolCallId: "bash-1",
      input: { command: "original" },
      content: [{ type: "text", text: "output" }],
      details: undefined,
      isError: false,
    };

    assert.equal(await adapter.beforeTool(call, context()), undefined);
    assert.equal(await adapter.afterTool(result, context()), undefined);
    assert.deepEqual(call.input, { command: "original" });
    assert.deepEqual(result.content, [{ type: "text", text: "output" }]);
    assert.deepEqual(requests, []);
  }
});

test("post-tool reports joined text and guarded builtin Bash full output without replacing images", async () => {
  const requests: BridgeRequest[] = [];
  const options: Array<{ timeoutMs: number; signal?: AbortSignal }> = [];
  const signal = new AbortController().signal;
  const adapter = await activeAdapter(
    piWithTools([{ name: "bash", source: "builtin" }]),
    bridgeReturning({
      protocolVersion: 1,
      ok: true,
      replacementText: "must not replace image-bearing content",
      archiveId: "bash-1",
    }, requests, options),
  );
  const event: ToolResultEvent = {
    type: "tool_result",
    toolName: "bash",
    toolCallId: "bash-1",
    input: { command: "printf ok" },
    content: [
      { type: "text", text: "first" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      { type: "text", text: "second" },
    ],
    details: { fullOutputPath: "/tmp/pi-output", truncation: { truncated: true } },
    isError: false,
  };

  assert.equal(await adapter.afterTool(event, context({ signal })), undefined);
  assert.deepEqual(requests, [{
    protocolVersion: 1,
    action: "post_tool",
    session: {
      id: "session-1",
      file: "/sessions/session-1.jsonl",
      cwd: "/work/project",
      model: "sonnet",
      provider: "anthropic",
      reasoningLevel: "high",
    },
    tool: {
      id: "bash-1",
      name: "Bash",
      kind: "builtin",
      input: { command: "printf ok" },
    },
    args: {
      text: "first\nsecond",
      isError: false,
      hasImages: true,
      fullOutputPath: "/tmp/pi-output",
    },
  }]);
  assert.deepEqual(options, [{ timeoutMs: 2_500, signal }]);
  assert.equal(isBridgeRequest(requests[0]), true);
  assert.equal(event.content.length, 3);
});

test("post-tool never trusts custom details as a Bash full-output path", async () => {
  const requests: BridgeRequest[] = [];
  const adapter = await activeAdapter(
    piWithTools([{ name: "bash", source: "extension" }]),
    bridgeReturning({ protocolVersion: 1, ok: true, decision: "allow" }, requests),
  );
  const event: ToolResultEvent = {
    type: "tool_result",
    toolName: "bash",
    toolCallId: "custom-1",
    input: { command: "custom" },
    content: [{ type: "text", text: "visible" }],
    details: { fullOutputPath: "/tmp/untrusted" },
    isError: false,
  };

  assert.equal(await adapter.afterTool(event, context()), undefined);
  assert.deepEqual(requests[0].tool, {
    id: "custom-1",
    name: "bash",
    kind: "external",
    input: { command: "custom" },
  });
  assert.deepEqual(requests[0].args, {
    text: "visible",
    isError: false,
    hasImages: false,
  });
});

test("post-tool returns only the bridge text replacement verbatim", async () => {
  const replacement = "short result\n\nUse token_optimizer_expand archive-1 for the complete output.";
  const requests: BridgeRequest[] = [];
  const adapter = await activeAdapter(
    piWithTools([{ name: "search", source: "extension" }]),
    bridgeReturning({
      protocolVersion: 1,
      ok: true,
      replacementText: replacement,
      archiveId: "archive-1",
    }, requests),
  );
  const details = { providerRequestId: "request-1" };
  const usage = {
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    totalTokens: 10,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const event: ToolResultEvent = {
    type: "tool_result",
    toolName: "search",
    toolCallId: "archive-1",
    input: { query: "needle" },
    content: [{ type: "text", text: "long result" }],
    details,
    isError: false,
    usage,
  };

  const patch = await adapter.afterTool(event, context());

  assert.deepEqual(patch, { content: [{ type: "text", text: replacement }] });
  assert.deepEqual(Object.keys(patch ?? {}), ["content"]);
  assert.equal(event.details, details);
  assert.equal(event.usage, usage);
  assert.equal(event.isError, false);
});

test("config and bridge startup failures warn independently once per session", async () => {
  const notifications: Array<[string, string]> = [];
  const ctx = context({
    ui: {
      setStatus: () => {},
      notify: (message: string, level: string) => { notifications.push([message, level]); },
    },
  } as unknown as Partial<ExtensionContext>);
  const adapter = new PiAdapter(piWithTools([]), bridgeReturning(null, []), {
    load: async () => { throw new Error("credential=/private/config"); },
  });

  await adapter.start(ctx, "startup");
  await adapter.start(ctx, "new");

  assert.deepEqual(notifications, [
    ["Token Optimizer config unavailable.", "warning"],
    ["Token Optimizer bridge unavailable.", "warning"],
    ["Token Optimizer config unavailable.", "warning"],
    ["Token Optimizer bridge unavailable.", "warning"],
  ]);
});

test("bridge failures warn once without exposing failure details", async () => {
  const notifications: Array<[string, string]> = [];
  const ctx = context({
    ui: {
      setStatus: () => {},
      notify: (message: string, level: string) => { notifications.push([message, level]); },
    },
  } as unknown as Partial<ExtensionContext>);
  const secret = "secret prompt /private/path bridge stderr";
  const adapter = await activeAdapter(piWithTools([]), {
    run: async () => { throw new Error(secret); },
  });
  const event = { type: "before_agent_start", prompt: secret } as BeforeAgentStartEvent;

  await adapter.beforePrompt(event, ctx);
  await adapter.beforePrompt(event, ctx);

  assert.deepEqual(notifications, [["Token Optimizer bridge unavailable.", "warning"]]);
  assert.equal(JSON.stringify(notifications).includes(secret), false);
});

test("malformed bridge actions warn, while valid no-op actions do not", async () => {
  const notifications: Array<[string, string]> = [];
  const ctx = context({
    ui: {
      setStatus: () => {},
      notify: (message: string, level: string) => { notifications.push([message, level]); },
    },
  } as unknown as Partial<ExtensionContext>);
  let response: BridgeResponse | null = null;
  const adapter = await activeAdapter(piWithTools([]), {
    run: async () => response,
  });
  const event = { type: "before_agent_start", prompt: "continue" } as BeforeAgentStartEvent;

  await adapter.beforePrompt(event, ctx);
  response = { protocolVersion: 1, ok: true };
  await adapter.beforePrompt(event, ctx);

  assert.deepEqual(notifications, [["Token Optimizer bridge unavailable.", "warning"]]);
});

test("metadata and lifecycle warnings are independent and notification errors fail open", async () => {
  const notifications: Array<[string, string]> = [];
  let notifyCalls = 0;
  const ctx = context({
    ui: {
      setStatus: () => {},
      notify: (message: string, level: string) => {
        notifyCalls += 1;
        if (notifyCalls === 1) throw new Error("UI failed");
        notifications.push([message, level]);
      },
    },
  } as unknown as Partial<ExtensionContext>);
  const adapter = await activeAdapter({
    ...piWithTools([]),
    getAllTools: () => { throw new Error("metadata /private/path"); },
  }, bridgeReturning({ protocolVersion: 1, ok: true }, []));
  const call = {
    type: "tool_call",
    toolName: "bash",
    toolCallId: "bash-1",
    input: { command: "secret" },
  } as ToolCallEvent;

  await adapter.beforeTool(call, ctx);
  await adapter.beforeTool(call, ctx);
  adapter.settled(context({
    ...ctx,
    sessionManager: {
      getSessionId: () => { throw new Error("session path"); },
      getSessionFile: () => "/sessions/session-1.jsonl",
    } as unknown as ExtensionContext["sessionManager"],
  }));

  assert.equal(notifyCalls, 2);
  assert.deepEqual(notifications, [["Token Optimizer lifecycle unavailable.", "warning"]]);
  assert.deepEqual(call.input, { command: "secret" });
});

test("headless contexts never receive failure notifications", async () => {
  let notifications = 0;
  const ctx = context({
    hasUI: false,
    mode: "json",
    ui: {
      setStatus: () => {},
      notify: () => { notifications += 1; },
    },
  } as unknown as Partial<ExtensionContext>);
  const adapter = new PiAdapter(piWithTools([]), bridgeReturning(null, []), {
    load: async () => { throw new Error("config failed"); },
  });

  await adapter.start(ctx, "startup");

  assert.equal(notifications, 0);
});

test("successful compaction clears only the active current session and fails open", async () => {
  const requests: BridgeRequest[] = [];
  let response: BridgeResponse | null = { protocolVersion: 1, ok: true };
  const adapter = await activeAdapter(piWithTools([]), {
    run: async (request) => {
      requests.push(request);
      return response;
    },
  });
  const current = context({
    cwd: "/work/current",
    sessionManager: {
      getSessionId: () => "current-session",
      getSessionFile: () => "/sessions/current.jsonl",
    } as ExtensionContext["sessionManager"],
  });

  assert.equal(adapter.isActive(), true);
  await adapter.compacted(current);
  response = null;
  await adapter.compacted(current);

  assert.deepEqual(requests, [
    {
      protocolVersion: 1,
      action: "post_compact",
      session: {
        id: "current-session",
        cwd: "/work/current",
        file: "/sessions/current.jsonl",
        provider: "anthropic",
        model: "sonnet",
        reasoningLevel: "high",
      },
    },
    {
      protocolVersion: 1,
      action: "post_compact",
      session: {
        id: "current-session",
        cwd: "/work/current",
        file: "/sessions/current.jsonl",
        provider: "anthropic",
        model: "sonnet",
        reasoningLevel: "high",
      },
    },
  ]);

  adapter.disableForSession(current);
  assert.equal(adapter.isActive(), false);
  await adapter.compacted(current);
  assert.equal(requests.length, 2);
});

test("post-tool bridge failures and replacements for errors fail open", async () => {
  const event = (): ToolResultEvent => ({
    type: "tool_result",
    toolName: "search",
    toolCallId: "search-1",
    input: { query: "needle" },
    content: [{ type: "text", text: "failure output" }],
    details: { diagnostic: true },
    isError: true,
  });
  const bridges: Array<Pick<BridgeClient, "run">> = [
    { run: async () => { throw new Error("bridge failure"); } },
    { run: async () => null },
    { run: async () => ({ protocolVersion: 2, ok: true } as never) },
    { run: async () => ({
      protocolVersion: 1,
      ok: true,
      replacementText: "invalid without archive",
    } as never) },
    { run: async () => ({
      protocolVersion: 1,
      ok: true,
      replacementText: "do not replace errors",
      archiveId: "search-1",
    }) },
  ];

  for (const bridge of bridges) {
    const current = event();
    const adapter = await activeAdapter(
      piWithTools([{ name: "search", source: "extension" }]),
      bridge,
    );

    assert.equal(await adapter.afterTool(current, context()), undefined);
    assert.deepEqual(current.content, [{ type: "text", text: "failure output" }]);
    assert.equal(current.isError, true);
  }
});
