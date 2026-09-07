import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ContextEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PiAdapter } from "../src/adapter.ts";
import type { BridgeRequest, BridgeResponse } from "../src/protocol.ts";

function event(): ContextEvent {
  const messages: AgentMessage[] = [{
    role: "toolResult", toolCallId: "old-tool", toolName: "read", isError: false,
    content: [{ type: "text", text: "old output\n".repeat(1_000) }], timestamp: 1,
  }];
  for (let index = 0; index < 4; index += 1) messages.push({
    role: "assistant", content: [{ type: "text", text: "continue" }],
    api: "openai-responses", provider: "test", model: "test", stopReason: "stop", timestamp: index + 2,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  return { type: "context", messages };
}

async function harness(run: (request: BridgeRequest) => Promise<BridgeResponse | null>) {
  const pi = {
    getAllTools: () => [], sendMessage: () => {},
    getActiveTools: () => ["token_optimizer_expand"],
  };
  const controller = new AbortController();
  const ctx = {
    cwd: "/tmp", hasUI: false, signal: controller.signal,
    sessionManager: { getSessionId: () => "session-1", getSessionFile: () => undefined },
    getContextUsage: () => ({ tokens: 60_000, contextWindow: 100_000, percent: 60 }),
  } as unknown as ExtensionContext;
  const adapter = new PiAdapter(pi, {
    run: async (request) => request.action === "status"
      ? { protocolVersion: 1, ok: true, data: { runtime: "pi", protocolVersion: 1, healthy: true, active: true } }
      : request.action === "session_start" ? { protocolVersion: 1, ok: true } : run(request),
    runTracked: () => {}, drainOrKill: async () => {},
  }, { load: async () => ({ schemaVersion: 1, enabled: true, consent: { granted: true, noticeVersion: 1 } }) });
  await adapter.start(ctx, "startup");
  return { adapter, ctx, pi, controller };
}

test("rolling context drops in-flight replacements when archive expansion becomes unavailable", async () => {
  const pending = Promise.withResolvers<BridgeResponse>();
  let request: BridgeRequest | undefined;
  const state = await harness(async (value) => { request = value; return pending.promise; });
  const source = event();
  const work = state.adapter.compressContext(source, state.ctx);
  const items = request?.args?.results as Array<{ id: string }>;
  assert.equal(items.length, 1);
  state.pi.getActiveTools = () => [];
  pending.resolve({ protocolVersion: 1, ok: true, data: { replacements: [{ id: items[0].id, text: "archived preview" }] } });
  assert.equal(await work, undefined);
});

test("rolling context fails open on bridge failure, cancellation and disable during a request", async () => {
  for (const transition of ["failure", "malformed", "abort", "disable"] as const) {
    const pending = Promise.withResolvers<BridgeResponse | null>();
    let request: BridgeRequest | undefined;
    const state = await harness(async (value) => { request = value; return pending.promise; });
    const source = event();
    const original = structuredClone(source);
    const work = state.adapter.compressContext(source, state.ctx);
    const items = request?.args?.results as Array<{ id: string }>;
    assert.equal(items.length, 1);
    if (transition === "abort") state.controller.abort();
    if (transition === "disable") state.adapter.disableForSession(state.ctx);
    if (transition === "failure") pending.reject(new Error("unavailable"));
    else pending.resolve({ protocolVersion: 1, ok: true, data: {
      replacements: [{ id: transition === "malformed" ? "bad" : items[0].id, text: "archived preview" }],
    } });
    assert.equal(await work, undefined, transition);
    assert.deepEqual(source, original, transition);
  }
});

test("rolling batches are bounded and a changed source cannot inherit an old compression decision", async () => {
  const requests: BridgeRequest[] = [];
  const state = await harness(async (request) => {
    requests.push(request);
    const items = request.args?.results as Array<{ id: string }>;
    return { protocolVersion: 1, ok: true, data: { replacements: items.map(({ id }) => ({ id, text: "archived preview" })) } };
  });
  const source = event();
  const old = source.messages[0];
  if (old.role !== "toolResult") throw new Error("invalid fixture");
  source.messages = [
    ...Array.from({ length: 40 }, (_, index) => ({ ...old, toolCallId: `old-${index}` })),
    ...source.messages.slice(1),
  ];
  const first = await state.adapter.compressContext(source, state.ctx);
  assert.ok(first);
  const selected = requests[0].args?.results;
  assert.ok(Array.isArray(selected));
  assert.equal(selected.length, 32);
  assert.deepEqual(first.messages.slice(32), source.messages.slice(32));
  state.ctx.getContextUsage = () => ({ tokens: 10_000, contextWindow: 100_000, percent: 10 });
  assert.deepEqual(await state.adapter.compressContext(source, state.ctx), first);
  const changed = event();
  changed.messages[0] = { ...old, content: [{ type: "text", text: "different source\n".repeat(1_000) }] };
  const count = requests.length;
  assert.equal(await state.adapter.compressContext(changed, state.ctx), undefined);
  assert.equal(requests.length, count, "changed content requires a fresh pressure-triggered decision");
});
