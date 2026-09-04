import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context, Model, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent, ToolCallEvent } from "@earendil-works/pi-coding-agent";

import { registerTokenOptimizer } from "../../extensions/index.ts";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const sessionId = "11111111-1111-4111-8111-111111111111";
type Handler = (event: unknown, context: ExtensionContext) => unknown;

const usage: Usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const model = {
  provider: "test",
  id: "fake-compaction",
  api: "test",
  maxTokens: 4096,
} as Model<any>;

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function user(text: string, timestamp: number): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

function sqliteCount(database: string): Promise<number> {
  return new Promise((resolve, reject) => execFile(
    process.env.PYTHON ?? "python3",
    ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute('select count(*) from file_reads').fetchone()[0]); c.close()", database],
    (error, stdout) => error ? reject(error) : resolve(Number(stdout.trim())),
  ));
}

function compactEvent(split: boolean): SessionBeforeCompactEvent {
  const staleNudge = {
    role: "custom",
    customType: "token-optimizer-nudge",
    content: "STALE-NUDGE-MUST-NOT-REACH-MODEL",
    display: false,
    timestamp: 2,
  } as AgentMessage;
  return {
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId: "00000007",
      messagesToSummarize: [user(split ? "completed split history" : "normal history", 1), staleNudge],
      turnPrefixMessages: split ? [staleNudge, user("unfinished split prefix", 3)] : [],
      isSplitTurn: split,
      tokensBefore: 42_000,
      previousSummary: split ? "previous checkpoint" : undefined,
      fileOps: {
        read: new Set(["src/read.ts", "src/changed.ts"]),
        written: new Set(["src/changed.ts"]),
        edited: new Set(["src/edited.ts"]),
      },
      settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    },
    branchEntries: [],
    customInstructions: split ? "preserve split-turn state" : "preserve normal state",
    reason: "manual",
    willRetry: false,
    signal: new AbortController().signal,
  };
}

test("real extension flow retains read state on failed compaction, clears on success, and handles normal and split-turn fake model calls", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-token-compaction-")));
  const previousFlags = {
    noProc: process.env.TOKEN_OPTIMIZER_NO_PROC_SCAN,
    firstRead: process.env.TOKEN_OPTIMIZER_FIRST_READ_SHADOW,
    contextSize: process.env.TOKEN_OPTIMIZER_CONTEXT_SIZE,
  };
  process.env.TOKEN_OPTIMIZER_NO_PROC_SCAN = "1";
  process.env.TOKEN_OPTIMIZER_FIRST_READ_SHADOW = "0";
  process.env.TOKEN_OPTIMIZER_CONTEXT_SIZE = "200000";
  t.after(async () => {
    for (const [key, value] of [
      ["TOKEN_OPTIMIZER_NO_PROC_SCAN", previousFlags.noProc],
      ["TOKEN_OPTIMIZER_FIRST_READ_SHADOW", previousFlags.firstRead],
      ["TOKEN_OPTIMIZER_CONTEXT_SIZE", previousFlags.contextSize],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  const agentDir = join(root, "pi-agent");
  const project = join(root, "project");
  await mkdir(join(agentDir, "token-optimizer", "data"), { recursive: true });
  await mkdir(project);
  await writeFile(join(agentDir, "token-optimizer", "config.json"), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    consent: { granted: true, noticeVersion: 1, grantedAt: "2026-09-03T12:00:00.000Z" },
  }));
  const sessionFile = join(root, "session.jsonl");
  await writeFile(sessionFile, await readFile(join(repository, "tests", "fixtures", "pi-session-linear.jsonl")));
  const source = join(project, "large.py");
  await writeFile(source, Array.from({ length: 160 }, (_, index) =>
    `def old_marker_${index}(value):\n    return value + ${index}`).join("\n\n"));

  const handlers = new Map<string, Handler>();
  const prompts: Context[] = [];
  let completion = 0;
  const api = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand: () => {},
    registerTool: () => {},
    getAllTools: () => [{
      name: "read",
      description: "read",
      parameters: {},
      sourceInfo: { path: "<read>", source: "builtin", scope: "temporary", origin: "top-level" },
    }],
    sendMessage: () => {},
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
  } as unknown as ExtensionAPI;
  registerTokenOptimizer(api, { version: "0.84.4", agentDir });
  const ctx = {
    cwd: project,
    mode: "json",
    hasUI: false,
    model,
    thinkingLevel: "high",
    modelRegistry: {
      complete: async (_model: Model<any>, prompt: Context) => {
        prompts.push(prompt);
        completion += 1;
        return assistant(`summary ${completion}`);
      },
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => sessionFile,
    },
    signal: new AbortController().signal,
  } as unknown as ExtensionContext;
  const invoke = async (name: string, event: unknown) => {
    const handler = handlers.get(name);
    assert.ok(handler, `${name} handler missing`);
    return await handler(event, ctx);
  };
  const read = (id: string): ToolCallEvent => ({
    type: "tool_call",
    toolName: "read",
    toolCallId: id,
    input: { path: source },
  });

  const database = join(agentDir, "token-optimizer", "data", "session-store", `${sessionId}.db`);
  await invoke("session_start", { type: "session_start", reason: "startup" });
  assert.equal(await invoke("tool_call", read("read-1")), undefined);
  assert.equal(await sqliteCount(database), 1);

  await invoke("session_compact_failed", { type: "session_compact_failed", error: "provider failed", willRetry: false });
  assert.equal(await sqliteCount(database), 1);

  const normal = await invoke("session_before_compact", compactEvent(false)) as { compaction: { summary: string; details: unknown } };
  assert.equal(normal.compaction.summary, "summary 1");
  assert.deepEqual(normal.compaction.details, {
    readFiles: ["src/read.ts"],
    modifiedFiles: ["src/changed.ts", "src/edited.ts"],
  });
  await invoke("session_compact", { type: "session_compact" });
  assert.equal(await sqliteCount(database), 0);
  assert.equal(await invoke("tool_call", read("read-4")), undefined);
  assert.equal(await sqliteCount(database), 1);

  const split = await invoke("session_before_compact", compactEvent(true)) as { compaction: { summary: string } };
  assert.equal(split.compaction.summary, "summary 2");
  assert.equal(prompts.length, 2);
  const promptText = prompts.map((prompt) => String((prompt.messages[0].content as Array<{ text: string }>)[0].text));
  assert.match(promptText[0], /normal history/);
  assert.match(promptText[1], /completed split history/);
  assert.match(promptText[1], /unfinished split prefix/);
  assert.match(promptText[1], /previous checkpoint/);
  assert.doesNotMatch(promptText.join("\n"), /STALE-NUDGE-MUST-NOT-REACH-MODEL/);
  assert.equal(prompts.some((prompt) => prompt.messages.some((message) => message.role === "assistant")), false);

  await invoke("session_shutdown", { type: "session_shutdown", reason: "quit" });
});
