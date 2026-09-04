import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";

import { PiAdapter } from "../src/adapter.ts";
import {
  CONSENT_NOTICE,
  type ConfigStore,
  type OptimizerConfig,
  type PurgePreview,
  type PurgeResult,
} from "../src/config.ts";
import type { BridgeAction, BridgeResponse } from "../src/protocol.ts";
import {
  registerExpandTool,
  registerTokenOptimizerCommand,
} from "../src/commands.ts";

type RegisteredCommand = {
  description?: string;
  getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
};

type RegisteredTool = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    id: string,
    params: { archiveId: string; offset?: number; limit?: number },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
};

function harness(
  run: (command: string, args: string[]) => Promise<{
    stdout: string;
    stderr: string;
    code: number;
    killed: boolean;
  }> = async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
) {
  const commands = new Map<string, RegisteredCommand>();
  const tools: RegisteredTool[] = [];
  const execs: Array<{ command: string; args: string[] }> = [];
  const pi = {
    registerCommand: (name: string, command: RegisteredCommand) => commands.set(name, command),
    registerTool: (tool: RegisteredTool) => tools.push(tool),
    exec: async (command: string, args: string[]) => {
      execs.push({ command, args });
      return run(command, args);
    },
  } as unknown as ExtensionAPI;
  return { pi, commands, tools, execs };
}

function context(
  mode: ExtensionContext["mode"] = "tui",
  options: {
    confirm?: () => Promise<boolean>;
    notify?: (message: string, level?: string) => void;
  } = {},
) {
  const notices: Array<{ message: string; level: string | undefined }> = [];
  const ctx = {
    cwd: "/work/project",
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    ui: {
      notify: (message: string, level?: string) => {
        notices.push({ message, level });
        options.notify?.(message, level);
      },
      confirm: options.confirm ?? (async () => false),
      setStatus: () => {},
    },
    model: { id: "sonnet", provider: "anthropic" },
    thinkingLevel: "high",
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => "/sessions/session-1.jsonl",
    },
    signal: undefined,
  } as unknown as ExtensionCommandContext;
  return { ctx, notices };
}

const grantedConfig: OptimizerConfig = {
  schemaVersion: 1,
  enabled: true,
  consent: {
    granted: true,
    noticeVersion: 1,
    grantedAt: "2026-09-03T00:00:00.000Z",
  },
};

function configStore(initial: OptimizerConfig = grantedConfig) {
  let current = structuredClone(initial);
  const saves: OptimizerConfig[] = [];
  const events: string[] = [];
  let preview: PurgePreview = {
    root: "/agent/token-optimizer",
    count: 2,
    bytes: 12,
  };
  const store = {
    load: async () => structuredClone(current),
    save: async (config: OptimizerConfig) => {
      events.push("save");
      current = structuredClone(config);
      saves.push(structuredClone(config));
    },
    previewPurge: async () => {
      events.push("preview");
      return { ...preview };
    },
    purgeData: async (): Promise<PurgeResult> => {
      events.push("purge");
      return { ...preview, purged: true };
    },
  } satisfies ConfigStore;
  return {
    store,
    saves,
    events,
    current: () => structuredClone(current),
    setPreview: (value: PurgePreview) => { preview = value; },
  };
}

function adapter(
  responses: Partial<Record<BridgeAction, BridgeResponse | null>> = {},
) {
  const actions: Array<{ action: BridgeAction; args?: Record<string, unknown> }> = [];
  const signals: Array<AbortSignal | undefined> = [];
  const events: string[] = [];
  let refreshResult = true;
  const value = {
    runControl: async (
      action: "status" | "doctor" | "dashboard" | "expand",
      _ctx: ExtensionContext,
      args: Record<string, unknown> | undefined,
      signal: AbortSignal | undefined,
    ) => {
      actions.push({ action, args });
      signals.push(signal);
      return responses[action] ?? null;
    },
    refresh: async () => {
      events.push("refresh");
      return refreshResult;
    },
    disableForSession: () => { events.push("disable"); },
    drainBridge: async () => { events.push("drain"); },
  } as unknown as PiAdapter;
  return {
    value,
    actions,
    signals,
    events,
    setRefreshResult: (result: boolean) => { refreshResult = result; },
  };
}

async function invoke(command: RegisteredCommand, args: string, mode: ExtensionContext["mode"] = "tui") {
  const state = context(mode);
  await command.handler(args, state.ctx);
  return state.notices;
}

test("registers one bounded command family with nested completions and concise usage errors", async () => {
  const h = harness();
  const config = configStore();
  const state = adapter();

  registerTokenOptimizerCommand(h.pi, state.value, config.store);

  assert.deepEqual([...h.commands.keys()], ["token-optimizer"]);
  const command = h.commands.get("token-optimizer")!;
  assert.deepEqual(command.getArgumentCompletions?.(""), [
    "status",
    "doctor",
    "dashboard",
    "enable",
    "disable",
    "consent",
    "expand",
    "purge",
  ].map((value) => ({ value, label: value })));
  assert.deepEqual(command.getArgumentCompletions?.("consent "), [
    "consent show",
    "consent grant",
    "consent reset",
  ].map((value) => ({ value, label: value })));
  assert.deepEqual(command.getArgumentCompletions?.("consent g"), [
    { value: "consent grant", label: "consent grant" },
  ]);
  assert.equal(command.getArgumentCompletions?.("expand "), null);
  assert.equal((command.getArgumentCompletions?.("x") ?? []).length <= 8, true);

  for (const args of ["", "unknown", "status extra", "consent", "consent nope", "expand", "expand id extra"]) {
    const notices = await invoke(command, args);
    assert.match(notices.at(-1)?.message ?? "", /^Usage: \/token-optimizer /);
    assert.equal(notices.at(-1)?.level, "warning");
  }
  assert.deepEqual(state.actions, []);
});

test("status remains local and honest without Python or supported Pi", async () => {
  const cases = [
    { supported: true, response: null, expected: /Python bridge: unavailable/ },
    { supported: false, response: null, expected: /Pi integration: unsupported/ },
  ];

  for (const current of cases) {
    const h = harness();
    const config = configStore({
      ...grantedConfig,
      enabled: false,
    });
    const state = adapter({ status: current.response });
    registerTokenOptimizerCommand(h.pi, state.value, config.store, {
      supported: current.supported,
    });

    const notices = await invoke(h.commands.get("token-optimizer")!, "status", "json");
    const output = notices.map(({ message }) => message).join("\n");
    assert.match(output, /Enabled: no/);
    assert.match(output, /Consent: granted/);
    assert.match(output, current.expected);
    assert.equal(state.actions.length, current.supported ? 1 : 0);
  }
});

test("consent and disable transitions save locally and gate activity immediately", async () => {
  const h = harness();
  const initial: OptimizerConfig = {
    schemaVersion: 1,
    enabled: true,
    consent: { granted: false, noticeVersion: 1 },
  };
  const config = configStore(initial);
  const state = adapter({
    status: {
      protocolVersion: 1,
      ok: true,
      data: { runtime: "pi", protocolVersion: 1, healthy: true, active: true },
    },
  });
  registerTokenOptimizerCommand(h.pi, state.value, config.store, {
    now: () => new Date("2026-09-04T12:34:56.000Z"),
  });
  const command = h.commands.get("token-optimizer")!;

  let notices = await invoke(command, "consent show", "print");
  const shownNotice = notices.at(-1)?.message ?? "";
  assert.equal(shownNotice.startsWith(`${CONSENT_NOTICE}\n\n`), true);
  assert.match(shownNotice, /read-cache source excerpts/i);
  assert.match(shownNotice, /tool archives/i);
  assert.match(shownNotice, /metrics/i);
  assert.match(shownNotice, /continuity checkpoints.*brief conversation snippets/i);
  assert.match(shownNotice, /retention/i);
  assert.match(shownNotice, /purge/i);
  assert.match(shownNotice, /no external telemetry/i);
  assert.match(shownNotice, /custom compaction.*current session context.*optimizer guidance/i);
  assert.match(shownNotice, /selected Pi provider.*normal model call/i);
  assert.match(shownNotice, /not granted/i);

  notices = await invoke(command, "consent grant");
  assert.deepEqual(config.current().consent, {
    granted: true,
    noticeVersion: 1,
    grantedAt: "2026-09-04T12:34:56.000Z",
  });
  assert.deepEqual(state.events, ["refresh"]);
  assert.match(notices.at(-1)?.message ?? "", /granted/i);

  state.events.length = 0;
  notices = await invoke(command, "disable");
  assert.equal(config.current().enabled, false);
  assert.deepEqual(state.events, ["disable"]);
  assert.match(notices.at(-1)?.message ?? "", /disabled/i);

  state.events.length = 0;
  notices = await invoke(command, "consent reset");
  assert.deepEqual(config.current().consent, { granted: false, noticeVersion: 1 });
  assert.deepEqual(state.events, ["disable"]);
  assert.match(notices.at(-1)?.message ?? "", /reset/i);
});

test("enable persists current consent before attempting supported activation", async () => {
  const cases: Array<{
    name: string;
    config: OptimizerConfig;
    supported?: boolean;
    refresh: boolean;
    saves: number;
    refreshes: number;
    enabled: boolean;
  }> = [
    {
      name: "consent missing",
      config: { ...grantedConfig, enabled: false, consent: { granted: false, noticeVersion: 1 } },
      refresh: true,
      saves: 0,
      refreshes: 0,
      enabled: false,
    },
    {
      name: "old Pi",
      config: { ...grantedConfig, enabled: false },
      supported: false,
      refresh: true,
      saves: 1,
      refreshes: 0,
      enabled: true,
    },
    {
      name: "missing Python",
      config: { ...grantedConfig, enabled: false },
      refresh: false,
      saves: 1,
      refreshes: 1,
      enabled: true,
    },
    {
      name: "healthy",
      config: { ...grantedConfig, enabled: false },
      refresh: true,
      saves: 1,
      refreshes: 1,
      enabled: true,
    },
  ];

  for (const current of cases) {
    const h = harness();
    const config = configStore(current.config);
    const state = adapter();
    state.setRefreshResult(current.refresh);
    registerTokenOptimizerCommand(h.pi, state.value, config.store, {
      supported: current.supported,
    });

    const notices = await invoke(h.commands.get("token-optimizer")!, "enable");

    assert.equal(config.saves.length, current.saves, current.name);
    assert.equal(state.events.filter((event) => event === "refresh").length, current.refreshes, current.name);
    assert.equal(config.current().enabled, current.enabled, current.name);
    assert.equal(state.actions.length, 0, current.name);
    if (current.name === "healthy") {
      assert.match(notices.at(-1)?.message ?? "", /enabled/i);
    } else if (current.name !== "consent missing") {
      assert.match(notices.at(-1)?.message ?? "", /awaits.*runtime|reload/i);
    }
  }
});

test("failed enable refresh remains locally enabled for a later compatible runtime", async () => {
  const h = harness();
  const config = configStore({ ...grantedConfig, enabled: false });
  const state = adapter({
    status: {
      protocolVersion: 1,
      ok: true,
      data: { runtime: "pi", protocolVersion: 1, healthy: true, active: false },
    },
  });
  state.setRefreshResult(false);
  registerTokenOptimizerCommand(h.pi, state.value, config.store);

  const notices = await invoke(h.commands.get("token-optimizer")!, "enable");

  assert.deepEqual(config.saves.map(({ enabled }) => enabled), [true]);
  assert.equal(config.current().enabled, true);
  assert.deepEqual(state.events, ["refresh"]);
  assert.match(notices.at(-1)?.message ?? "", /awaits.*runtime|reload/i);
});

test("doctor reports validated bridge health and unavailable states honestly", async () => {
  const responses: Array<{
    supported: boolean;
    response: BridgeResponse | null;
    expected: RegExp;
    calls: number;
  }> = [
    {
      supported: true,
      response: {
        protocolVersion: 1,
        ok: true,
        data: {
          runtime: "pi",
          protocolVersion: 1,
          healthy: true,
          pythonVersion: "3.14.7",
          upstreamVersion: "5.13.4",
          checks: { bridge: true, parser: true },
        },
      },
      expected: /Doctor: healthy[\s\S]*Python: 3\.14\.7[\s\S]*Upstream: 5\.13\.4/,
      calls: 1,
    },
    { supported: true, response: null, expected: /Doctor unavailable/, calls: 1 },
    { supported: false, response: null, expected: /Doctor unavailable.*Pi 0\.84\.4/s, calls: 0 },
  ];

  for (const current of responses) {
    const h = harness();
    const state = adapter({ doctor: current.response });
    registerTokenOptimizerCommand(h.pi, state.value, configStore().store, {
      supported: current.supported,
    });

    const notices = await invoke(h.commands.get("token-optimizer")!, "doctor");
    assert.match(notices.at(-1)?.message ?? "", current.expected);
    assert.equal(state.actions.length, current.calls);
  }
});

test("dashboard validates the static destination and uses only the platform opener", async (t) => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "pi-token-optimizer-command-")));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "token-optimizer");
  await mkdir(root);
  const path = join(root, "dashboard.html");
  await writeFile(path, "<html>ready</html>");

  for (const [platform, opener] of [["darwin", "open"], ["linux", "xdg-open"]] as const) {
    const h = harness();
    const config = configStore();
    config.setPreview({ root, count: 1, bytes: 18 });
    const state = adapter({
      dashboard: {
        protocolVersion: 1,
        ok: true,
        data: { available: true, status: "ready", path },
      },
    });
    registerTokenOptimizerCommand(h.pi, state.value, config.store, { platform });

    const notices = await invoke(h.commands.get("token-optimizer")!, "dashboard");

    assert.deepEqual(h.execs, [{ command: opener, args: [path] }]);
    assert.match(notices.at(-1)?.message ?? "", /Dashboard opened/);
    assert.match(notices.at(-1)?.message ?? "", new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("dashboard reports its path when opener is unavailable and rejects unexpected paths", async (t) => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "pi-token-optimizer-command-")));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "token-optimizer");
  await mkdir(root);
  const path = join(root, "dashboard.html");
  await writeFile(path, "ready");
  const config = configStore();
  config.setPreview({ root, count: 1, bytes: 5 });

  const unavailable = harness(async () => ({
    stdout: "",
    stderr: "not found",
    code: 127,
    killed: false,
  }));
  const ready = adapter({
    dashboard: {
      protocolVersion: 1,
      ok: true,
      data: { available: true, status: "ready", path },
    },
  });
  registerTokenOptimizerCommand(unavailable.pi, ready.value, config.store, { platform: "linux" });
  let notices = await invoke(unavailable.commands.get("token-optimizer")!, "dashboard");
  assert.match(notices.at(-1)?.message ?? "", /opener unavailable/i);
  assert.match(notices.at(-1)?.message ?? "", new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const invalid = harness();
  const unsafe = adapter({
    dashboard: {
      protocolVersion: 1,
      ok: true,
      data: { available: true, status: "ready", path: join(parent, "outside.html") },
    },
  });
  registerTokenOptimizerCommand(invalid.pi, unsafe.value, config.store, { platform: "darwin" });
  notices = await invoke(invalid.commands.get("token-optimizer")!, "dashboard");
  assert.deepEqual(invalid.execs, []);
  assert.match(notices.at(-1)?.message ?? "", /Dashboard unavailable/);

  const oldPi = harness();
  const oldState = adapter();
  registerTokenOptimizerCommand(oldPi.pi, oldState.value, config.store, { supported: false });
  notices = await invoke(oldPi.commands.get("token-optimizer")!, "dashboard");
  assert.deepEqual(oldState.actions, []);
  assert.match(notices.at(-1)?.message ?? "", /Dashboard unavailable.*Pi 0\.84\.4/s);
});

test("dashboard rejects symlinked roots, files, and swaps before opening", async (t) => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "pi-token-optimizer-dashboard-")));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const actualRoot = join(parent, "actual");
  const linkedRoot = join(parent, "linked");
  await mkdir(actualRoot);
  await writeFile(join(actualRoot, "dashboard.html"), "ready");
  await symlink(actualRoot, linkedRoot, "dir");

  const linkedHarness = harness();
  const linkedConfig = configStore();
  linkedConfig.setPreview({ root: linkedRoot, count: 1, bytes: 5 });
  registerTokenOptimizerCommand(linkedHarness.pi, adapter({
    dashboard: {
      protocolVersion: 1,
      ok: true,
      data: { available: true, status: "ready", path: join(linkedRoot, "dashboard.html") },
    },
  }).value, linkedConfig.store, { platform: "darwin" });
  await invoke(linkedHarness.commands.get("token-optimizer")!, "dashboard");
  assert.deepEqual(linkedHarness.execs, []);

  const fileRoot = join(parent, "file-root");
  const outside = join(parent, "outside.html");
  await mkdir(fileRoot);
  await writeFile(outside, "outside");
  await symlink(outside, join(fileRoot, "dashboard.html"));
  const fileHarness = harness();
  const fileConfig = configStore();
  fileConfig.setPreview({ root: fileRoot, count: 1, bytes: 5 });
  registerTokenOptimizerCommand(fileHarness.pi, adapter({
    dashboard: {
      protocolVersion: 1,
      ok: true,
      data: { available: true, status: "ready", path: join(fileRoot, "dashboard.html") },
    },
  }).value, fileConfig.store, { platform: "darwin" });
  await invoke(fileHarness.commands.get("token-optimizer")!, "dashboard");
  assert.deepEqual(fileHarness.execs, []);

  const swapRoot = join(parent, "swap-root");
  const swapPath = join(swapRoot, "dashboard.html");
  await mkdir(swapRoot);
  await writeFile(swapPath, "ready");
  const swapHarness = harness();
  const swapConfig = configStore();
  swapConfig.setPreview({ root: swapRoot, count: 1, bytes: 5 });
  const swappingAdapter = {
    ...adapter().value,
    runControl: async () => {
      await rm(swapPath);
      await symlink(outside, swapPath);
      return {
        protocolVersion: 1,
        ok: true,
        data: { available: true, status: "ready", path: swapPath },
      } as BridgeResponse;
    },
  } as unknown as PiAdapter;
  registerTokenOptimizerCommand(swapHarness.pi, swappingAdapter, swapConfig.store, {
    platform: "darwin",
  });
  await invoke(swapHarness.commands.get("token-optimizer")!, "dashboard");
  assert.deepEqual(swapHarness.execs, []);
});

test("purge previews exact data and refuses deletion in JSON and print modes", async () => {
  for (const mode of ["json", "print"] as const) {
    const h = harness();
    const config = configStore();
    const state = adapter();
    let confirms = 0;
    registerTokenOptimizerCommand(h.pi, state.value, config.store);
    const ctxState = context(mode, {
      confirm: async () => {
        confirms += 1;
        return true;
      },
    });

    await h.commands.get("token-optimizer")!.handler("purge", ctxState.ctx);

    const output = ctxState.notices.map(({ message }) => message).join("\n");
    assert.match(output, /root=\/agent\/token-optimizer/);
    assert.match(output, /files=2/);
    assert.match(output, /bytes=12/);
    assert.match(output, /refused/i);
    assert.equal(confirms, 0);
    assert.deepEqual(config.events, ["preview"]);
    assert.deepEqual(state.events, []);
  }
});

test("confirmed purge disables, drains, then deletes while cancellation changes nothing", async () => {
  for (const mode of ["tui", "rpc"] as const) {
    const order: string[] = [];
    const h = harness();
    const base = configStore();
    const store = {
      ...base.store,
      previewPurge: async () => {
        order.push("preview");
        return { root: "/agent/token-optimizer", count: 2, bytes: 12 };
      },
      purgeData: async () => {
        order.push("purge");
        return { root: "/agent/token-optimizer", count: 2, bytes: 12, purged: true };
      },
    };
    const value = {
      ...adapter().value,
      disableForSession: () => { order.push("disable"); },
      drainBridge: async () => { order.push("drain"); },
    } as unknown as PiAdapter;
    registerTokenOptimizerCommand(h.pi, value, store);
    const ctxState = context(mode, {
      confirm: async () => {
        order.push("confirm");
        return true;
      },
    });

    await h.commands.get("token-optimizer")!.handler("purge", ctxState.ctx);

    assert.deepEqual(order, ["preview", "confirm", "disable", "drain", "purge"]);
    assert.match(ctxState.notices.at(-1)?.message ?? "", /Purged 2 files \(12 bytes\)/);
  }

  const h = harness();
  const config = configStore();
  const state = adapter();
  registerTokenOptimizerCommand(h.pi, state.value, config.store);
  const cancelled = context("tui", { confirm: async () => false });
  await h.commands.get("token-optimizer")!.handler("purge", cancelled.ctx);
  assert.deepEqual(config.events, ["preview"]);
  assert.deepEqual(state.events, []);
  assert.match(cancelled.notices.at(-1)?.message ?? "", /cancelled/i);
});

test("purge then enable stays locally enabled without reactivating retired hot paths", async () => {
  const h = harness();
  const config = configStore();
  const bridgeEvents: string[] = [];
  const direct: BridgeAction[] = [];
  const tracked: BridgeAction[] = [];
  const real = new PiAdapter(h.pi, {
    run: async (request) => {
      direct.push(request.action);
      return request.action === "status"
        ? {
            protocolVersion: 1,
            ok: true,
            data: { runtime: "pi", protocolVersion: 1, healthy: true, active: true },
          }
        : { protocolVersion: 1, ok: true };
    },
    runTracked: (request) => {
      bridgeEvents.push("rollup");
      tracked.push(request.action);
    },
    drainOrKill: async () => { bridgeEvents.push("drain"); },
  }, config.store);
  const state = context("tui", { confirm: async () => true });
  await real.start(state.ctx, "startup");
  real.settled(state.ctx);
  registerTokenOptimizerCommand(h.pi, real, config.store);
  const command = h.commands.get("token-optimizer")!;

  await command.handler("purge", state.ctx);
  await command.handler("enable", state.ctx);
  real.settled(state.ctx);
  assert.equal(await real.beforeTool({
    type: "tool_call",
    toolName: "read",
    toolCallId: "read-1",
    input: { path: "README.md" },
  } as ToolCallEvent, state.ctx), undefined);

  assert.equal(config.current().enabled, true);
  assert.deepEqual(config.saves.map(({ enabled }) => enabled), [true]);
  assert.deepEqual(bridgeEvents, ["rollup", "drain"]);
  assert.deepEqual(tracked, ["rollup"]);
  assert.deepEqual(direct, ["status", "session_start"]);
  assert.match(state.notices.at(-1)?.message ?? "", /awaits.*runtime|reload/i);
});

test("purge never deletes after UI or bridge-drain failure", async () => {
  for (const failure of ["ui", "drain"] as const) {
    const h = harness();
    const config = configStore();
    const state = adapter();
    const value = failure === "drain"
      ? {
          ...state.value,
          drainBridge: async () => { throw new Error("drain failed"); },
        } as unknown as PiAdapter
      : state.value;
    registerTokenOptimizerCommand(h.pi, value, config.store);
    const ctxState = context("tui", {
      confirm: failure === "ui"
        ? async () => { throw new Error("UI failed"); }
        : async () => true,
    });

    await h.commands.get("token-optimizer")!.handler("purge", ctxState.ctx);

    assert.equal(config.events.includes("purge"), false);
    if (failure === "drain") assert.deepEqual(state.events, ["disable"]);
    assert.match(ctxState.notices.at(-1)?.message ?? "", /failed/i);
  }
});

test("slash expansion shows one validated bounded slice without model-context injection", async () => {
  const h = harness();
  const response: BridgeResponse = {
    protocolVersion: 1,
    ok: true,
    data: {
      archiveId: "archive-1",
      sessionId: "session-1",
      offset: 0,
      text: "line one\nline two",
      nextOffset: 2,
    },
  };
  const state = adapter({ expand: response });
  registerTokenOptimizerCommand(h.pi, state.value, configStore().store);

  const commandContext = context();
  const controller = new AbortController();
  commandContext.ctx.signal = controller.signal;
  await h.commands.get("token-optimizer")!.handler("expand archive-1", commandContext.ctx);
  const notices = commandContext.notices;

  assert.deepEqual(state.actions, [{ action: "expand", args: { archiveId: "archive-1" } }]);
  assert.deepEqual(state.signals, [controller.signal]);
  assert.equal(notices[0].message, "line one\nline two");
  assert.match(notices[1].message, /next offset: 2/i);
  assert.equal(Buffer.byteLength(notices[0].message), 17);
});

test("slash expansion rejects invalid ids, unsupported Pi, and malformed bridge pages", async () => {
  const cases: Array<{
    args: string;
    supported?: boolean;
    response: BridgeResponse | null;
    calls: number;
  }> = [
    { args: "expand ../escape", response: null, calls: 0 },
    { args: `expand ${"a".repeat(129)}`, response: null, calls: 0 },
    { args: "expand archive-1", supported: false, response: null, calls: 0 },
    { args: "expand archive-1", response: null, calls: 1 },
    {
      args: "expand archive-1",
      response: {
        protocolVersion: 1,
        ok: true,
        data: { archiveId: "other", offset: 0, text: "wrong archive" },
      },
      calls: 1,
    },
    {
      args: "expand archive-1",
      response: {
        protocolVersion: 1,
        ok: false,
        errorCode: "archive_unavailable",
      },
      calls: 1,
    },
  ];

  for (const current of cases) {
    const h = harness();
    const state = adapter({ expand: current.response });
    registerTokenOptimizerCommand(h.pi, state.value, configStore().store, {
      supported: current.supported,
    });
    const notices = await invoke(h.commands.get("token-optimizer")!, current.args);
    assert.equal(state.actions.length, current.calls);
    assert.match(notices.at(-1)?.message ?? "", /Expansion unavailable|Invalid archive id/);
  }
});

test("registers only the bounded archive expansion tool with pagination details", async () => {
  const h = harness();
  const state = adapter({
    expand: {
      protocolVersion: 1,
      ok: true,
      data: {
        archiveId: "archive-1",
        sessionId: "session-1",
        offset: 10,
        text: "bounded page",
        nextOffset: 20,
      },
    },
  });

  registerExpandTool(h.pi, state.value);

  assert.deepEqual(h.tools.map(({ name }) => name), ["token_optimizer_expand"]);
  const controller = new AbortController();
  const result = await h.tools[0].execute(
    "call-1",
    { archiveId: "archive-1", offset: 10, limit: 10 },
    controller.signal,
    undefined,
    context().ctx,
  );
  assert.deepEqual(state.actions, [{
    action: "expand",
    args: { archiveId: "archive-1", offset: 10, limit: 10 },
  }]);
  assert.deepEqual(state.signals, [controller.signal]);
  assert.deepEqual(result, {
    content: [
      { type: "text", text: "bounded page" },
      {
        type: "text",
        text: "Continue with token_optimizer_expand using archiveId archive-1 and offset 20.",
      },
    ],
    details: { archiveId: "archive-1", offset: 10, nextOffset: 20 },
  });
  assert.match(h.tools[0].description, /50 KiB|2000 lines/i);
});

test("expansion tool defaults offset, validates direct calls, and throws on bridge errors", async () => {
  const valid = adapter({
    expand: {
      protocolVersion: 1,
      ok: true,
      data: { archiveId: "archive-1", sessionId: "session-1", offset: 0, text: "all" },
    },
  });
  const h = harness();
  registerExpandTool(h.pi, valid.value);
  const result = await h.tools[0].execute(
    "call-1",
    { archiveId: "archive-1" },
    undefined,
    undefined,
    context().ctx,
  );
  assert.deepEqual(result.details, {
    archiveId: "archive-1",
    offset: 0,
    nextOffset: undefined,
  });

  const parameters = h.tools[0].parameters as {
    properties: {
      offset: { minimum: number; maximum: number };
      limit: { minimum: number; maximum: number };
    };
  };
  assert.deepEqual(parameters.properties.offset, {
    type: "integer",
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
  });
  assert.deepEqual(parameters.properties.limit, {
    type: "integer",
    minimum: 1,
    maximum: 2_000,
  });

  const boundary = harness();
  const boundaryAdapter = adapter({
    expand: {
      protocolVersion: 1,
      ok: true,
      data: {
        archiveId: "archive-1",
        sessionId: "session-1",
        offset: Number.MAX_SAFE_INTEGER,
        text: "last page",
      },
    },
  });
  registerExpandTool(boundary.pi, boundaryAdapter.value);
  await boundary.tools[0].execute(
    "call-boundary",
    { archiveId: "archive-1", offset: Number.MAX_SAFE_INTEGER, limit: 2_000 },
    undefined,
    undefined,
    context().ctx,
  );
  assert.deepEqual(boundaryAdapter.actions, [{
    action: "expand",
    args: { archiveId: "archive-1", offset: Number.MAX_SAFE_INTEGER, limit: 2_000 },
  }]);

  for (const params of [
    { archiveId: "../escape" },
    { archiveId: 42 },
    { archiveId: "archive-1", offset: -1 },
    { archiveId: "archive-1", offset: 1.5 },
    { archiveId: "archive-1", offset: "0" },
    { archiveId: "archive-1", offset: Number.MAX_SAFE_INTEGER + 1 },
    { archiveId: "archive-1", limit: 0 },
    { archiveId: "archive-1", limit: 2001 },
    { archiveId: "archive-1", limit: "10" },
    { archiveId: "archive-1", unexpected: true },
  ]) {
    const callCount = valid.actions.length;
    const directParams = params as never;
    await assert.rejects(h.tools[0].execute(
      "call-2",
      directParams,
      undefined,
      undefined,
      context().ctx,
    ), /Invalid archive expansion arguments/);
    assert.equal(valid.actions.length, callCount);
  }

  for (const response of [
    null,
    { protocolVersion: 1, ok: false, errorCode: "archive_unavailable" } as BridgeResponse,
    {
      protocolVersion: 1,
      ok: true,
      data: { archiveId: "archive-1", offset: 1, text: "wrong page" },
    } as BridgeResponse,
  ]) {
    const failedHarness = harness();
    registerExpandTool(failedHarness.pi, adapter({ expand: response }).value);
    await assert.rejects(failedHarness.tools[0].execute(
      "call-3",
      { archiveId: "archive-1" },
      undefined,
      undefined,
      context().ctx,
    ), /archive expansion unavailable/i);
  }

  const unsupported = harness();
  registerExpandTool(unsupported.pi, adapter().value, { supported: false });
  await assert.rejects(unsupported.tools[0].execute(
    "call-4",
    { archiveId: "archive-1" },
    undefined,
    undefined,
    context().ctx,
  ), /Pi 0\.84\.4/);
});

test("adapter exposes only bounded control requests and tracked-child draining to controls", async () => {
  const requests: Array<{ action: BridgeAction; options: { timeoutMs: number; signal?: AbortSignal } }> = [];
  let drains = 0;
  const bridge = {
    run: async (request: { action: BridgeAction }, options: { timeoutMs: number; signal?: AbortSignal }) => {
      requests.push({ action: request.action, options });
      return { protocolVersion: 1, ok: true } as BridgeResponse;
    },
    runTracked: () => {},
    drainOrKill: async (timeoutMs: number) => {
      assert.equal(timeoutMs, 2_500);
      drains += 1;
    },
  };
  const real = new PiAdapter({
    getAllTools: () => [],
    sendMessage: () => {},
  } as unknown as Pick<ExtensionAPI, "getAllTools" | "sendMessage">, bridge, {
    load: async () => structuredClone(grantedConfig),
  });
  const ctx = context().ctx;
  const controller = new AbortController();

  await real.runControl("doctor", ctx, undefined, controller.signal);
  await real.drainBridge();

  assert.deepEqual(requests, [{
    action: "doctor",
    options: { timeoutMs: 2_500, signal: controller.signal },
  }]);
  assert.equal(drains, 1);
});

test("registration starts no bridge or process and exposes no extra command or tool", () => {
  const h = harness();
  const state = adapter();

  registerTokenOptimizerCommand(h.pi, state.value, configStore().store);
  registerExpandTool(h.pi, state.value);

  assert.deepEqual([...h.commands.keys()], ["token-optimizer"]);
  assert.deepEqual(h.tools.map(({ name }) => name), ["token_optimizer_expand"]);
  assert.deepEqual(state.actions, []);
  assert.deepEqual(state.events, []);
  assert.deepEqual(h.execs, []);
  assert.equal(JSON.stringify([...h.commands.keys(), ...h.tools.map(({ name }) => name)]).match(/coach|fleet|daemon|server|install|measure/), null);
});
