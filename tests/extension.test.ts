import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import tokenOptimizer, {
  registerTokenOptimizer,
  supportsPiVersion,
} from "../extensions/index.ts";
import { PiAdapter } from "../src/adapter.ts";
import { BridgeClient } from "../src/bridge.ts";
import { CONSENT_NOTICE } from "../src/config.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

type FakePi = {
  api: ExtensionAPI;
  commands: Array<{ name: string; options: Record<string, unknown> }>;
  tools: Array<Record<string, unknown>>;
  handlers: Map<string, Handler[]>;
};

function fakePi(): FakePi {
  const commands: FakePi["commands"] = [];
  const tools: FakePi["tools"] = [];
  const handlers = new Map<string, Handler[]>();
  const api = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...handlers.get(event) ?? [], handler]);
    },
    registerCommand(name: string, options: Record<string, unknown>) {
      commands.push({ name, options });
    },
    registerTool(tool: Record<string, unknown>) {
      tools.push(tool);
    },
    getAllTools: () => [],
    sendMessage: () => {},
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
  } as unknown as ExtensionAPI;
  return { api, commands, tools, handlers };
}

function context(
  mode: ExtensionContext["mode"],
  confirm: (title: string, message: string) => Promise<boolean> = async () => false,
): ExtensionContext {
  return {
    cwd: "/work/current",
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    ui: { confirm, notify: () => {}, setStatus: () => {} },
    sessionManager: {
      getSessionId: () => "current-session",
      getSessionFile: () => "/sessions/current.jsonl",
    },
    signal: new AbortController().signal,
  } as unknown as ExtensionContext;
}

function handler(pi: FakePi, event: string): Handler {
  const registered = pi.handlers.get(event);
  assert.equal(registered?.length, 1);
  return registered[0];
}

const automaticEvents = [
  "session_start",
  "session_shutdown",
  "before_agent_start",
  "context",
  "tool_call",
  "tool_result",
  "agent_settled",
  "session_before_compact",
  "session_compact",
  "session_compact_failed",
].sort();

test("version gate registers the full surface once only for Pi 0.84.4 or newer", async () => {
  assert.equal(supportsPiVersion("0.84.3"), false);
  assert.equal(supportsPiVersion("0.84.4-rc.1"), false);
  assert.equal(supportsPiVersion("0.84.4"), true);
  assert.equal(supportsPiVersion("0.84.4+packaged"), true);
  assert.equal(supportsPiVersion("0.85.0-beta.1"), true);
  assert.equal(supportsPiVersion("0.85.0-0"), true);
  assert.equal(supportsPiVersion("0.85.0-01"), false);
  assert.equal(supportsPiVersion("0.85.0-beta.01"), false);
  assert.equal(supportsPiVersion("1.0.0"), true);
  assert.equal(supportsPiVersion("garbage"), false);

  const agentDir = await mkdtemp(join(tmpdir(), "pi-token-extension-"));
  try {
    const supported = fakePi();
    registerTokenOptimizer(supported.api, { version: "0.84.4", agentDir });

    assert.deepEqual(supported.commands.map(({ name }) => name), ["token-optimizer"]);
    assert.deepEqual(supported.tools.map((tool) => tool.name), ["token_optimizer_expand"]);
    assert.deepEqual([...supported.handlers.keys()].sort(), automaticEvents);
    for (const registered of supported.handlers.values()) assert.equal(registered.length, 1);

    const old = fakePi();
    registerTokenOptimizer(old.api, { version: "0.84.3", agentDir });

    assert.deepEqual(old.commands.map(({ name }) => name), ["token-optimizer"]);
    assert.deepEqual(old.tools, []);
    assert.deepEqual([...old.handlers.keys()], []);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("old Pi command mode stays local and reports Python-backed controls unavailable", async () => {
  const agentDir = await realpath(await mkdtemp(join(tmpdir(), "pi-token-extension-")));
  const originalRun = BridgeClient.prototype.run;
  let bridgeRuns = 0;
  BridgeClient.prototype.run = async () => {
    bridgeRuns += 1;
    return null;
  };
  try {
    const pi = fakePi();
    const notices: Array<[string, string]> = [];
    registerTokenOptimizer(pi.api, { version: "0.84.3", agentDir });
    const command = pi.commands[0].options.handler as (
      args: string,
      ctx: ExtensionContext,
    ) => Promise<void>;
    const ctx = {
      ...context("tui"),
      ui: {
        confirm: async () => false,
        setStatus: () => {},
        notify: (message: string, level: string) => notices.push([message, level]),
      },
    } as unknown as ExtensionContext;

    await command("status", ctx);
    await command("doctor", ctx);

    assert.equal(bridgeRuns, 0);
    assert.match(notices[0][0], /Pi integration: unsupported \(requires Pi 0\.84\.4\+\)/);
    assert.equal(notices[1][0], "Doctor unavailable: Pi 0.84.4 or newer is required.");
  } finally {
    BridgeClient.prototype.run = originalRun;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("TUI session startup grants current consent only after confirmation", async () => {
  const originalStart = PiAdapter.prototype.start;
  const starts: Array<{ adapter: PiAdapter; ctx: ExtensionContext; reason: string }> = [];
  PiAdapter.prototype.start = async function (ctx, reason) {
    starts.push({ adapter: this, ctx, reason });
  };
  const agentDir = await realpath(await mkdtemp(join(tmpdir(), "pi-token-extension-")));
  const confirmations: Array<[string, string]> = [];

  try {
    const pi = fakePi();
    registerTokenOptimizer(pi.api, { version: "0.84.4", agentDir });
    const ctx = context("tui", async (title, message) => {
      confirmations.push([title, message]);
      return true;
    });

    await handler(pi, "session_start")({ type: "session_start", reason: "startup" }, ctx);

    assert.equal(confirmations.length, 1);
    assert.match(confirmations[0][0], /Token Optimizer/);
    assert.equal(confirmations[0][1], CONSENT_NOTICE);
    const saved = JSON.parse(await readFile(join(agentDir, "token-optimizer", "config.json"), "utf8"));
    assert.equal(saved.enabled, true);
    assert.equal(saved.consent.granted, true);
    assert.equal(saved.consent.noticeVersion, 1);
    assert.match(saved.consent.grantedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(starts.at(-1)?.ctx, ctx);
    assert.equal(starts.at(-1)?.reason, "startup");

    await handler(pi, "session_start")({ type: "session_start", reason: "reload" }, ctx);
    assert.equal(confirmations.length, 1);
    assert.equal(starts.at(-1)?.reason, "reload");
  } finally {
    PiAdapter.prototype.start = originalStart;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("RPC startup returns before its reader handles deferred consent", async () => {
  const originalStart = PiAdapter.prototype.start;
  const originalBeforePrompt = PiAdapter.prototype.beforePrompt;
  const calls: Array<{ method: string; ctx: ExtensionContext; reason?: string }> = [];
  PiAdapter.prototype.start = async function (ctx, reason) {
    calls.push({ method: "start", ctx, reason });
  };
  PiAdapter.prototype.beforePrompt = async function (_event, ctx) {
    calls.push({ method: "beforePrompt", ctx });
  };

  const agentDir = await realpath(await mkdtemp(join(tmpdir(), "pi-token-extension-")));
  let readerLive = false;
  let releaseEarlyConfirmation: ((confirmed: boolean) => void) | undefined;
  let observeConfirmation!: () => void;
  const confirmationObserved = new Promise<void>((resolve) => { observeConfirmation = resolve; });
  let confirmations = 0;
  const startupCtx = context("rpc", async () => {
    confirmations += 1;
    observeConfirmation();
    if (readerLive) return true;
    return new Promise<boolean>((resolve) => { releaseEarlyConfirmation = resolve; });
  });
  const promptCtx = { ...startupCtx, cwd: "/work/prompt" } as ExtensionContext;

  try {
    const pi = fakePi();
    registerTokenOptimizer(pi.api, { version: "0.84.4", agentDir });
    const startup = Promise.resolve(handler(pi, "session_start")(
      { type: "session_start", reason: "startup" },
      startupCtx,
    ));
    const phase = await Promise.race([
      startup.then(() => "startup-complete" as const),
      confirmationObserved.then(() => "confirmation-before-reader" as const),
    ]);

    readerLive = true;
    releaseEarlyConfirmation?.(false);
    await startup;
    assert.equal(phase, "startup-complete");
    assert.equal(confirmations, 0);
    assert.deepEqual(calls, [{ method: "start", ctx: startupCtx, reason: "startup" }]);

    await handler(pi, "before_agent_start")(
      { type: "before_agent_start", prompt: "continue" },
      promptCtx,
    );
    await confirmationObserved;

    assert.equal(confirmations, 1);
    assert.deepEqual(calls, [
      { method: "start", ctx: startupCtx, reason: "startup" },
      { method: "start", ctx: promptCtx, reason: "startup" },
      { method: "beforePrompt", ctx: promptCtx },
    ]);
    const saved = JSON.parse(await readFile(join(agentDir, "token-optimizer", "config.json"), "utf8"));
    assert.equal(saved.consent.granted, true);
  } finally {
    PiAdapter.prototype.start = originalStart;
    PiAdapter.prototype.beforePrompt = originalBeforePrompt;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("concurrent RPC prompts ask once per session attempt and decline proceeds inactive", async () => {
  const originalStart = PiAdapter.prototype.start;
  const originalBeforePrompt = PiAdapter.prototype.beforePrompt;
  let starts = 0;
  let prompts = 0;
  PiAdapter.prototype.start = async () => { starts += 1; };
  PiAdapter.prototype.beforePrompt = async () => { prompts += 1; };

  const agentDir = await realpath(await mkdtemp(join(tmpdir(), "pi-token-extension-")));
  let confirmations = 0;
  let observeConfirmation!: () => void;
  const confirmationObserved = new Promise<void>((resolve) => { observeConfirmation = resolve; });
  let resolveConfirmation!: (confirmed: boolean) => void;
  const ctx = context("rpc", async () => {
    confirmations += 1;
    observeConfirmation();
    return new Promise<boolean>((resolve) => { resolveConfirmation = resolve; });
  });

  try {
    const pi = fakePi();
    registerTokenOptimizer(pi.api, { version: "0.84.4", agentDir });
    await handler(pi, "session_start")({ type: "session_start", reason: "startup" }, ctx);

    const first = Promise.resolve(handler(pi, "before_agent_start")(
      { type: "before_agent_start", prompt: "first" },
      ctx,
    ));
    const second = Promise.resolve(handler(pi, "before_agent_start")(
      { type: "before_agent_start", prompt: "second" },
      ctx,
    ));
    await confirmationObserved;
    assert.equal(confirmations, 1);
    resolveConfirmation(false);
    await Promise.all([first, second]);
    await handler(pi, "before_agent_start")(
      { type: "before_agent_start", prompt: "third" },
      ctx,
    );

    assert.equal(confirmations, 1);
    assert.equal(starts, 1);
    assert.equal(prompts, 3);

    ctx.ui.confirm = async () => {
      confirmations += 1;
      return false;
    };
    await handler(pi, "session_start")({ type: "session_start", reason: "reload" }, ctx);
    await handler(pi, "before_agent_start")(
      { type: "before_agent_start", prompt: "new attempt" },
      ctx,
    );
    assert.equal(confirmations, 2);
    assert.equal(starts, 2);
    assert.equal(prompts, 4);
    await assert.rejects(import("node:fs/promises").then(({ lstat }) => lstat(join(agentDir, "token-optimizer"))), {
      code: "ENOENT",
    });
  } finally {
    PiAdapter.prototype.start = originalStart;
    PiAdapter.prototype.beforePrompt = originalBeforePrompt;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("automatic handlers forward exact events and the current context to the adapter", async () => {
  const originals = {
    start: PiAdapter.prototype.start,
    shutdown: PiAdapter.prototype.shutdown,
    beforePrompt: PiAdapter.prototype.beforePrompt,
    filterContext: PiAdapter.prototype.filterContext,
    beforeTool: PiAdapter.prototype.beforeTool,
    afterTool: PiAdapter.prototype.afterTool,
    settled: PiAdapter.prototype.settled,
  };
  const calls: Array<{ method: string; adapter: PiAdapter; event?: unknown; ctx?: ExtensionContext }> = [];
  PiAdapter.prototype.start = async function (ctx) {
    calls.push({ method: "start", adapter: this, ctx });
  };
  PiAdapter.prototype.shutdown = async function (ctx) {
    calls.push({ method: "shutdown", adapter: this, ctx });
  };
  PiAdapter.prototype.beforePrompt = async function (event, ctx) {
    calls.push({ method: "beforePrompt", adapter: this, event, ctx });
  };
  PiAdapter.prototype.filterContext = function (event) {
    calls.push({ method: "filterContext", adapter: this, event });
  };
  PiAdapter.prototype.beforeTool = async function (event, ctx) {
    calls.push({ method: "beforeTool", adapter: this, event, ctx });
  };
  PiAdapter.prototype.afterTool = async function (event, ctx) {
    calls.push({ method: "afterTool", adapter: this, event, ctx });
  };
  PiAdapter.prototype.settled = function (ctx) {
    calls.push({ method: "settled", adapter: this, ctx });
  };

  const agentDir = await realpath(await mkdtemp(join(tmpdir(), "pi-token-extension-")));
  try {
    const pi = fakePi();
    registerTokenOptimizer(pi.api, { version: "0.84.4", agentDir });
    const events = {
      start: { type: "session_start", reason: "resume" },
      shutdown: { type: "session_shutdown", reason: "resume" },
      prompt: { type: "before_agent_start", prompt: "continue" },
      context: { type: "context", messages: [] },
      call: { type: "tool_call", toolName: "search", toolCallId: "call-1", input: {} },
      result: {
        type: "tool_result",
        toolName: "search",
        toolCallId: "call-1",
        input: {},
        content: [],
        isError: false,
      },
      settled: { type: "agent_settled" },
    };
    const contexts = Array.from({ length: 7 }, (_, index) => ({
      ...context("json"),
      cwd: `/work/${index}`,
    })) as ExtensionContext[];

    await handler(pi, "session_start")(events.start, contexts[0]);
    await handler(pi, "session_shutdown")(events.shutdown, contexts[1]);
    await handler(pi, "before_agent_start")(events.prompt, contexts[2]);
    await handler(pi, "context")(events.context, contexts[3]);
    await handler(pi, "tool_call")(events.call, contexts[4]);
    await handler(pi, "tool_result")(events.result, contexts[5]);
    await handler(pi, "agent_settled")(events.settled, contexts[6]);

    assert.deepEqual(calls.map(({ method }) => method), [
      "start",
      "shutdown",
      "beforePrompt",
      "filterContext",
      "beforeTool",
      "afterTool",
      "settled",
    ]);
    assert.equal(new Set(calls.map(({ adapter }) => adapter)).size, 1);
    assert.deepEqual(calls.map(({ event }) => event), [
      undefined,
      undefined,
      events.prompt,
      events.context,
      events.call,
      events.result,
      undefined,
    ]);
    assert.deepEqual(calls.map(({ ctx }) => ctx), [
      contexts[0],
      contexts[1],
      contexts[2],
      undefined,
      contexts[4],
      contexts[5],
      contexts[6],
    ]);
  } finally {
    Object.assign(PiAdapter.prototype, originals);
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("compaction prepares only while active and clears only on the success event", async () => {
  const originalActive = PiAdapter.prototype.isActive;
  const originalCompacted = PiAdapter.prototype.compacted;
  const originalRun = BridgeClient.prototype.run;
  let active = true;
  const requests: unknown[] = [];
  const cleared: ExtensionContext[] = [];
  PiAdapter.prototype.isActive = () => active;
  PiAdapter.prototype.compacted = async (_ctx) => { cleared.push(_ctx); };
  BridgeClient.prototype.run = async (request) => {
    requests.push(request);
    return {
      protocolVersion: 1,
      ok: true,
      data: { available: true, guidance: "Keep exact continuation state." },
    };
  };

  const agentDir = await realpath(await mkdtemp(join(tmpdir(), "pi-token-extension-")));
  try {
    const pi = fakePi();
    registerTokenOptimizer(pi.api, { version: "0.84.4", agentDir });
    const usage = {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const ctx = {
      ...context("json"),
      model: { provider: "test", id: "model", maxTokens: 4096 },
      modelRegistry: {
        complete: async () => ({
          role: "assistant",
          content: [{ type: "text", text: "summary" }],
          api: "test",
          provider: "test",
          model: "model",
          usage,
          stopReason: "stop",
          timestamp: Date.now(),
        }),
      },
    } as unknown as ExtensionContext;
    const compact = {
      type: "session_before_compact",
      preparation: {
        messagesToSummarize: [],
        turnPrefixMessages: [],
        firstKeptEntryId: "keep-1",
        tokensBefore: 100,
        previousSummary: undefined,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      },
      branchEntries: [],
      reason: "manual",
      willRetry: false,
      signal: ctx.signal,
    };

    const result = await handler(pi, "session_before_compact")(compact, ctx) as {
      compaction?: { summary?: string };
    };
    assert.equal(result.compaction?.summary, "summary");
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0], {
      protocolVersion: 1,
      action: "pre_compact",
      session: {
        id: "current-session",
        cwd: "/work/current",
        file: "/sessions/current.jsonl",
        provider: "test",
        model: "model",
      },
    });

    active = false;
    assert.equal(await handler(pi, "session_before_compact")(compact, ctx), undefined);
    assert.equal(requests.length, 1);

    await handler(pi, "session_compact_failed")({ type: "session_compact_failed" }, ctx);
    assert.deepEqual(cleared, []);
    await handler(pi, "session_compact")({ type: "session_compact" }, ctx);
    assert.deepEqual(cleared, [ctx]);
  } finally {
    PiAdapter.prototype.isActive = originalActive;
    PiAdapter.prototype.compacted = originalCompacted;
    BridgeClient.prototype.run = originalRun;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("automatic handler failures preserve Pi default behavior", async () => {
  const originals = {
    start: PiAdapter.prototype.start,
    shutdown: PiAdapter.prototype.shutdown,
    beforePrompt: PiAdapter.prototype.beforePrompt,
    filterContext: PiAdapter.prototype.filterContext,
    beforeTool: PiAdapter.prototype.beforeTool,
    afterTool: PiAdapter.prototype.afterTool,
    settled: PiAdapter.prototype.settled,
    isActive: PiAdapter.prototype.isActive,
    compacted: PiAdapter.prototype.compacted,
  };
  const fail = () => { throw new Error("adapter failure"); };
  PiAdapter.prototype.start = fail;
  PiAdapter.prototype.shutdown = fail;
  PiAdapter.prototype.beforePrompt = fail;
  PiAdapter.prototype.filterContext = fail;
  PiAdapter.prototype.beforeTool = fail;
  PiAdapter.prototype.afterTool = fail;
  PiAdapter.prototype.settled = fail;
  PiAdapter.prototype.isActive = fail;
  PiAdapter.prototype.compacted = fail;

  const agentDir = await realpath(await mkdtemp(join(tmpdir(), "pi-token-extension-")));
  try {
    const pi = fakePi();
    registerTokenOptimizer(pi.api, { version: "0.84.4", agentDir });
    const ctx = context("json");
    for (const [name, event] of [
      ["session_start", { type: "session_start", reason: "startup" }],
      ["session_shutdown", { type: "session_shutdown", reason: "quit" }],
      ["before_agent_start", { type: "before_agent_start", prompt: "continue" }],
      ["context", { type: "context", messages: [] }],
      ["tool_call", { type: "tool_call", toolName: "search", toolCallId: "1", input: {} }],
      ["tool_result", { type: "tool_result", toolName: "search", toolCallId: "1", input: {}, content: [], isError: false }],
      ["agent_settled", { type: "agent_settled" }],
      ["session_before_compact", { type: "session_before_compact" }],
      ["session_compact", { type: "session_compact" }],
      ["session_compact_failed", { type: "session_compact_failed" }],
    ] as const) {
      assert.equal(await handler(pi, name)(event, ctx), undefined);
    }
  } finally {
    Object.assign(PiAdapter.prototype, originals);
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("session replacement uses a fresh instance and old cleanup stays idempotent", async () => {
  const originalRun = BridgeClient.prototype.run;
  const originalDrain = BridgeClient.prototype.drainOrKill;
  const requests: Array<{ client: BridgeClient; request: { action: string; session: { id: string; cwd: string } } }> = [];
  const drains = new Map<BridgeClient, number>();
  BridgeClient.prototype.run = async function (request) {
    requests.push({ client: this, request });
    return request.action === "status"
      ? {
          protocolVersion: 1,
          ok: true,
          data: { runtime: "pi", protocolVersion: 1, healthy: true, active: true },
        }
      : { protocolVersion: 1, ok: true };
  };
  BridgeClient.prototype.drainOrKill = async function () {
    drains.set(this, (drains.get(this) ?? 0) + 1);
  };

  const agentDir = await realpath(await mkdtemp(join(tmpdir(), "pi-token-extension-")));
  const root = join(agentDir, "token-optimizer");
  await mkdir(root, { mode: 0o700 });
  await writeFile(join(root, "config.json"), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    consent: {
      granted: true,
      noticeVersion: 1,
      grantedAt: "2026-09-03T00:00:00.000Z",
    },
  }));

  try {
    const oldPi = fakePi();
    registerTokenOptimizer(oldPi.api, { version: "0.84.4", agentDir });
    const oldCtx = {
      ...context("json"),
      cwd: "/work/old",
      sessionManager: {
        getSessionId: () => "old-session",
        getSessionFile: () => "/sessions/old.jsonl",
      },
    } as unknown as ExtensionContext;
    await handler(oldPi, "session_start")({ type: "session_start", reason: "startup" }, oldCtx);
    await handler(oldPi, "session_shutdown")({ type: "session_shutdown", reason: "resume" }, oldCtx);
    await handler(oldPi, "session_shutdown")({ type: "session_shutdown", reason: "resume" }, oldCtx);

    const newPi = fakePi();
    registerTokenOptimizer(newPi.api, { version: "0.84.4", agentDir });
    const newCtx = {
      ...context("json"),
      cwd: "/work/new",
      sessionManager: {
        getSessionId: () => "new-session",
        getSessionFile: () => "/sessions/new.jsonl",
      },
    } as unknown as ExtensionContext;
    await handler(newPi, "session_start")({ type: "session_start", reason: "resume" }, newCtx);

    const clients = [...new Set(requests.map(({ client }) => client))];
    assert.equal(clients.length, 2);
    assert.equal(drains.get(clients[0]), 1);
    assert.equal(drains.get(clients[1]), undefined);
    assert.deepEqual(requests.map(({ request }) => [request.action, request.session.id, request.session.cwd]), [
      ["status", "old-session", "/work/old"],
      ["session_start", "old-session", "/work/old"],
      ["finalize", "old-session", "/work/old"],
      ["status", "new-session", "/work/new"],
      ["session_start", "new-session", "/work/new"],
    ]);
  } finally {
    BridgeClient.prototype.run = originalRun;
    BridgeClient.prototype.drainOrKill = originalDrain;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("JSON and print sessions neither prompt nor auto-grant", async () => {
  const originalStart = PiAdapter.prototype.start;
  let starts = 0;
  PiAdapter.prototype.start = async () => { starts += 1; };

  try {
    for (const mode of ["json", "print"] as const) {
      const agentDir = await realpath(await mkdtemp(join(tmpdir(), "pi-token-extension-")));
      let confirmations = 0;
      try {
        const pi = fakePi();
        registerTokenOptimizer(pi.api, { version: "0.84.4", agentDir });
        const ctx = context(mode, async () => {
          confirmations += 1;
          return true;
        });
        await handler(pi, "session_start")(
          { type: "session_start", reason: "startup" },
          ctx,
        );
        await handler(pi, "before_agent_start")(
          { type: "before_agent_start", prompt: "continue" },
          ctx,
        );

        assert.equal(confirmations, 0);
        await assert.rejects(import("node:fs/promises").then(({ lstat }) => lstat(join(agentDir, "token-optimizer"))), {
          code: "ENOENT",
        });
      } finally {
        await rm(agentDir, { recursive: true, force: true });
      }
    }
    assert.equal(starts, 2);
  } finally {
    PiAdapter.prototype.start = originalStart;
  }
});

test("declining an eligible consent prompt leaves local state absent and starts inactive", async () => {
  const agentDir = await realpath(await mkdtemp(join(tmpdir(), "pi-token-extension-")));
  const originalStart = PiAdapter.prototype.start;
  let starts = 0;
  PiAdapter.prototype.start = async () => { starts += 1; };
  try {
    const pi = fakePi();
    let confirmations = 0;
    registerTokenOptimizer(pi.api, { version: "0.84.4", agentDir });

    await handler(pi, "session_start")(
      { type: "session_start", reason: "startup" },
      context("tui", async () => {
        confirmations += 1;
        return false;
      }),
    );

    assert.equal(confirmations, 1);
    assert.equal(starts, 1);
    await assert.rejects(import("node:fs/promises").then(({ lstat }) => lstat(join(agentDir, "token-optimizer"))), {
      code: "ENOENT",
    });
  } finally {
    PiAdapter.prototype.start = originalStart;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("stale consent requires the current notice before replacing the grant", async () => {
  const agentDir = await realpath(await mkdtemp(join(tmpdir(), "pi-token-extension-")));
  const root = join(agentDir, "token-optimizer");
  await mkdir(root, { mode: 0o700 });
  await writeFile(join(root, "config.json"), JSON.stringify({
    schemaVersion: 1,
    enabled: false,
    consent: {
      granted: true,
      noticeVersion: 0,
      grantedAt: "2026-09-03T00:00:00.000Z",
    },
  }));
  const originalStart = PiAdapter.prototype.start;
  PiAdapter.prototype.start = async () => {};
  try {
    const pi = fakePi();
    let confirmations = 0;
    registerTokenOptimizer(pi.api, { version: "0.84.4", agentDir });
    const ctx = context("rpc", async () => {
      confirmations += 1;
      return true;
    });
    await handler(pi, "session_start")(
      { type: "session_start", reason: "resume" },
      ctx,
    );
    await handler(pi, "before_agent_start")(
      { type: "before_agent_start", prompt: "continue" },
      ctx,
    );

    const saved = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
    assert.equal(confirmations, 1);
    assert.equal(saved.enabled, false);
    assert.equal(saved.consent.granted, true);
    assert.equal(saved.consent.noticeVersion, 1);
  } finally {
    PiAdapter.prototype.start = originalStart;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("malformed config remains fail-closed and is never overwritten by startup", async () => {
  const agentDir = await realpath(await mkdtemp(join(tmpdir(), "pi-token-extension-")));
  const root = join(agentDir, "token-optimizer");
  const malformed = "{not-json\n";
  await mkdir(root, { mode: 0o700 });
  await writeFile(join(root, "config.json"), malformed);
  const originalStart = PiAdapter.prototype.start;
  let starts = 0;
  PiAdapter.prototype.start = async () => { starts += 1; };
  try {
    const pi = fakePi();
    let confirmations = 0;
    registerTokenOptimizer(pi.api, { version: "0.84.4", agentDir });
    await handler(pi, "session_start")(
      { type: "session_start", reason: "startup" },
      context("tui", async () => {
        confirmations += 1;
        return true;
      }),
    );

    assert.equal(confirmations, 0);
    assert.equal(starts, 1);
    assert.equal(await readFile(join(root, "config.json"), "utf8"), malformed);
  } finally {
    PiAdapter.prototype.start = originalStart;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("import and factory registration start no bridge work or local data", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-token-extension-"));
  const originalRun = BridgeClient.prototype.run;
  let bridgeRuns = 0;
  BridgeClient.prototype.run = async () => {
    bridgeRuns += 1;
    return null;
  };
  try {
    const pi = fakePi();
    registerTokenOptimizer(pi.api, { version: "0.84.4", agentDir });

    assert.equal(bridgeRuns, 0);
    await assert.rejects(import("node:fs/promises").then(({ lstat }) => lstat(join(agentDir, "token-optimizer"))), {
      code: "ENOENT",
    });

    const defaultPi = fakePi();
    tokenOptimizer(defaultPi.api);
    assert.equal(bridgeRuns, 0);
    assert.deepEqual(defaultPi.commands.map(({ name }) => name), ["token-optimizer"]);
    assert.deepEqual(defaultPi.tools.map((tool) => tool.name), ["token_optimizer_expand"]);
  } finally {
    BridgeClient.prototype.run = originalRun;
    await rm(agentDir, { recursive: true, force: true });
  }
});
