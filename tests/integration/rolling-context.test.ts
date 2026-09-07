import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerTokenOptimizer } from "../../extensions/index.ts";
import { BridgeClient } from "../../src/bridge.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function history(): AgentMessage[] {
  const messages: AgentMessage[] = [{ role: "user", content: "Inspect these files", timestamp: 1 }];
  for (let index = 0; index < 5; index += 1) {
    messages.push({
      role: "assistant",
      content: [{ type: "toolCall", id: `read-${index}`, name: "read", arguments: { path: `file-${index}.ts` } }],
      api: "openai-responses", provider: "test", model: "test", stopReason: "toolUse", timestamp: index + 2,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    }, {
      role: "toolResult", toolCallId: `read-${index}`, toolName: "read", isError: false,
      content: [{ type: "text", text: `FILE-${index}\n${"export const value = 42;\n".repeat(500)}END-${index}` }],
      timestamp: index + 2,
    });
  }
  return messages;
}

async function harness(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-rolling-context-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const agentDir = join(directory, "agent");
  await mkdir(join(agentDir, "token-optimizer"), { recursive: true });
  await writeFile(join(agentDir, "token-optimizer", "config.json"), JSON.stringify({
    schemaVersion: 1, enabled: true, consent: { granted: true, noticeVersion: 1 },
  }));
  const handlers = new Map<string, Handler>();
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerTool: () => {}, registerCommand: () => {},
    getAllTools: () => [{ name: "read", sourceInfo: { source: "builtin" } }],
    getActiveTools: () => ["read", "token_optimizer_expand"],
    sendMessage: () => {},
  } as unknown as ExtensionAPI;
  registerTokenOptimizer(pi, { agentDir, version: "0.84.4" });
  const ctx = {
    cwd: directory, mode: "json", hasUI: false,
    sessionManager: { getSessionId: () => "rolling-session", getSessionFile: () => undefined },
    getContextUsage: () => ({ tokens: 120_000, contextWindow: 200_000, percent: 60 }),
  } as unknown as ExtensionContext;
  await handlers.get("session_start")!({ reason: "startup" }, ctx);
  const client = new BridgeClient(agentDir);
  return { directory, agentDir, ctx, handlers, client, pi };
}

test("rolling context compresses old tool results through the real extension and archives the original", async (t) => {
  const state = await harness(t);
  const event: ContextEvent = { type: "context", messages: history() };
  const original = structuredClone(event);
  const result = await state.handlers.get("context")!(event, state.ctx) as { messages: AgentMessage[] } | undefined;

  assert.ok(result, "expected rolling context replacement");
  assert.deepEqual(event, original, "must not mutate the source conversation");
  assert.deepEqual(result.messages.slice(3), original.messages.slice(3), "last four model/tool turns stay intact");
  assert.deepEqual(result.messages.slice(0, 2), original.messages.slice(0, 2), "user and assistant content stays intact");
  const shortened = result.messages[2];
  assert.equal(shortened.role, "toolResult");
  if (shortened.role !== "toolResult") throw new Error("missing tool result");
  const text = shortened.content.map((block) => block.type === "text" ? block.text : "").join("\n");
  assert.ok(text.length < 2_000);
  assert.match(text, /FILE-0/);
  const archiveId = /"archiveId":\s*"([A-Za-z0-9_-]+)"/.exec(text)?.[1];
  assert.ok(archiveId, "replacement must provide a usable archive reference");
  const expanded = await state.client.run({
    protocolVersion: 1, action: "expand", session: { id: "rolling-session", cwd: state.directory },
    args: { archiveId },
  }, { timeoutMs: 2_500 });
  const source = original.messages[2];
  assert.equal(source.role, "toolResult");
  if (source.role !== "toolResult" || source.content[0].type !== "text") throw new Error("invalid fixture");
  assert.equal(expanded?.data?.text, source.content[0].text);
  const entry = JSON.parse(await readFile(join(state.agentDir, "token-optimizer", "data", "tool-archive", "rolling-session", `${archiveId}.json`), "utf8"));
  assert.equal(entry.response, source.content[0].text);
});

test("rolling context reuses stable references below the pressure threshold and never overwrites source history", async (t) => {
  const state = await harness(t);
  const event: ContextEvent = { type: "context", messages: history() };
  const run = () => state.handlers.get("context")!(event, state.ctx) as Promise<{ messages: AgentMessage[] } | undefined>;
  state.ctx.getContextUsage = () => ({ tokens: 119_999, contextWindow: 200_000, percent: 59.9995 });
  assert.equal(await run(), undefined);
  state.ctx.getContextUsage = () => ({ tokens: 120_000, contextWindow: 200_000, percent: 60 });
  const first = await run();
  assert.ok(first);
  const manifest = join(state.agentDir, "token-optimizer", "data", "tool-archive", "rolling-session", "manifest.jsonl");
  const before = await readFile(manifest, "utf8");
  state.ctx.getContextUsage = () => ({ tokens: 40_000, contextWindow: 200_000, percent: 20 });
  assert.deepEqual(await run(), first, "dropping below the threshold must not re-inflate context");
  assert.equal(await readFile(manifest, "utf8"), before, "unchanged results are not re-archived");
  state.pi.getActiveTools = () => ["read"];
  assert.equal(await run(), undefined, "must not emit references if expansion is unavailable");
  state.pi.getActiveTools = () => ["read", "token_optimizer_expand"];
  assert.deepEqual(await run(), first);
  await state.handlers.get("session_start")!({ reason: "resume" }, state.ctx);
  assert.equal(await run(), undefined, "a new session lifecycle clears rolling decisions");
});

test("rolling context preserves failed, image-bearing, small, expanded and already archived results", async (t) => {
  const state = await harness(t);
  const original = history();
  const result = original[2];
  assert.equal(result.role, "toolResult");
  if (result.role !== "toolResult") throw new Error("invalid fixture");
  const excluded: AgentMessage[] = [
    { ...result, isError: true },
    { ...result, content: [...result.content, { type: "image", data: "AA==", mimeType: "image/png" }] },
    { ...result, content: [{ type: "text", text: "x".repeat(8 * 1024) }] },
    { ...result, toolName: "token_optimizer_expand" },
    { ...result, toolName: "Agent" },
    { ...result, toolName: "mcp__context7__query-docs" },
    { ...result, content: [{ type: "text", text: `${"x".repeat(9_000)} token_optimizer_expand {"archiveId": "prior"}` }] },
  ];
  for (const message of excluded) {
    const event: ContextEvent = { type: "context", messages: [...original.slice(0, 2), message, ...original.slice(3)] };
    assert.equal(await state.handlers.get("context")!(event, state.ctx), undefined);
  }
  const event: ContextEvent = { type: "context", messages: original };
  state.ctx.getContextUsage = () => ({ tokens: null, contextWindow: 200_000, percent: null });
  assert.equal(await state.handlers.get("context")!(event, state.ctx), undefined, "unknown usage cannot trigger a new batch");
});

test("rolling context keeps full results when archives are unsafe or consent is revoked", async (t) => {
  const state = await harness(t);
  const event: ContextEvent = { type: "context", messages: history() };
  const original = structuredClone(event);
  const archiveRoot = join(state.agentDir, "token-optimizer", "data", "tool-archive");
  await mkdir(join(state.agentDir, "token-optimizer", "data"), { recursive: true });
  await writeFile(archiveRoot, "not a directory");
  assert.equal(await state.handlers.get("context")!(event, state.ctx), undefined);
  await rm(archiveRoot);
  await writeFile(join(state.agentDir, "token-optimizer", "config.json"), JSON.stringify({
    schemaVersion: 1, enabled: true, consent: { granted: false, noticeVersion: 1 },
  }));
  assert.equal(await state.handlers.get("context")!(event, state.ctx), undefined);
  assert.deepEqual(event, original);
});
