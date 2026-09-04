import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { BridgeClient } from "../../src/bridge.ts";
import type { BridgeRequest, BridgeResponse } from "../../src/protocol.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const outputs = fileURLToPath(new URL("../fixtures/tool-output", import.meta.url));
const bridgeFixture = (name: string) => join(root, "tests", "fixtures", "bridge", name);
const python = process.env.PYTHON ?? "python3";
const sessionId = "11111111-1111-4111-8111-111111111111";

type Harness = {
  directory: string;
  agentDir: string;
  project: string;
  sessionFile: string;
  client: BridgeClient;
};

async function harness(): Promise<Harness> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-token-integration-")));
  const agentDir = join(directory, "pi-agent");
  const project = join(directory, "project");
  await mkdir(join(agentDir, "token-optimizer", "data"), { recursive: true });
  await mkdir(project);
  await writeFile(join(agentDir, "token-optimizer", "config.json"), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    consent: {
      granted: true,
      noticeVersion: 1,
      grantedAt: "2026-09-03T12:00:00.000Z",
    },
  }));
  const fixture = await readFile(join(root, "tests", "fixtures", "pi-session-linear.jsonl"), "utf8");
  const sessionFile = join(directory, "session.jsonl");
  await writeFile(sessionFile, fixture);
  const client = new BridgeClient(agentDir, {
    environment: {
      HOME: directory,
      PATH: process.env.PATH,
      LANG: "C.UTF-8",
      TOKEN_OPTIMIZER_NO_PROC_SCAN: "1",
      TOKEN_OPTIMIZER_FIRST_READ_SHADOW: "0",
      TOKEN_OPTIMIZER_CONTEXT_SIZE: "200000",
    },
  });
  return { directory, agentDir, project, sessionFile, client };
}

function session(state: Harness) {
  return { id: sessionId, cwd: state.project, file: state.sessionFile };
}

async function run(state: Harness, request: BridgeRequest, timeoutMs = 5_000): Promise<BridgeResponse> {
  const response = await state.client.run(request, { timeoutMs });
  assert.ok(response, `${request.action} bridge request failed`);
  return response;
}

async function expandAll(state: Harness, archiveId: string, original: string): Promise<{ text: string; pages: number }> {
  const normalized = original.replace(/\r\n/g, "\n").replace(/\n$/, "");
  const limit = Math.min(2_000, Math.ceil(normalized.split("\n").length / 2));
  let offset = 0;
  let text = "";
  let pages = 0;
  while (true) {
    const response = await run(state, {
      protocolVersion: 1,
      action: "expand",
      session: session(state),
      args: { archiveId, offset, limit },
    });
    assert.equal(response.ok, true);
    assert.equal(response.data?.archiveId, archiveId);
    assert.equal(response.data?.offset, offset);
    const slice = response.data?.text;
    assert.equal(typeof slice, "string");
    assert.ok(Buffer.byteLength(slice as string) <= 50 * 1024);
    assert.ok((slice as string).split("\n").length <= limit);
    if (pages > 0) text += "\n";
    text += slice;
    pages += 1;
    const next = response.data?.nextOffset;
    if (next === undefined) break;
    assert.ok(Number.isSafeInteger(next) && (next as number) > offset);
    offset = next as number;
  }
  return { text, pages };
}

test("real bundled engine compresses representative outputs and every advertised archive reconstructs", async (t) => {
  const state = await harness();
  t.after(() => rm(state.directory, { recursive: true, force: true }));
  const fixtures = [
    ["bash.txt", "builtin", "Bash", "pytest tests/"],
    ["repeated.txt", "builtin", "Bash", "pytest tests/"],
    ["table.txt", "builtin", "Bash", "npm ls"],
    ["paths.txt", "builtin", "Bash", "rg exported"],
    ["oversized.txt", "builtin", "Bash", "pytest tests/"],
    ["external.json", "external", "acme.search", ""],
  ] as const;
  const advertised: Array<{ id: string; original: string }> = [];

  for (const [fixture, kind, name, command] of fixtures) {
    const original = await readFile(join(outputs, fixture), "utf8");
    const id = `tool-${basename(fixture, ".txt").replace(".", "-")}`;
    const response = await run(state, {
      protocolVersion: 1,
      action: "post_tool",
      session: session(state),
      tool: {
        id,
        name,
        kind,
        input: kind === "builtin" ? { command } : { query: fixture },
      },
      args: { text: original, isError: false, hasImages: false },
    });

    assert.equal(response.ok, true, fixture);
    assert.equal(typeof response.replacementText, "string", fixture);
    assert.equal(typeof response.archiveId, "string", fixture);
    assert.ok(
      Buffer.byteLength(response.replacementText as string) <= Buffer.byteLength(original) * 0.9,
      `${fixture} did not compress by at least 10%`,
    );
    if (original.includes("FAILURE-SENTINEL")) {
      assert.match(response.replacementText as string, /FAILURE-SENTINEL/, fixture);
    }
    if (original.includes("SECURITY-SENTINEL")) {
      assert.match(response.replacementText as string, /SECURITY-SENTINEL/, fixture);
    }
    advertised.push({ id: response.archiveId as string, original });
  }

  for (const archive of advertised) {
    const expanded = await expandAll(state, archive.id, archive.original);
    assert.ok(expanded.pages > 1, `${archive.id} was not paginated`);
    assert.equal(expanded.text, archive.original.replace(/\r\n/g, "\n").replace(/\n$/, ""), archive.id);
  }

  const failure = await readFile(join(outputs, "error.txt"), "utf8");
  const response = await run(state, {
    protocolVersion: 1,
    action: "post_tool",
    session: session(state),
    tool: { id: "failed-tool", name: "Bash", kind: "builtin", input: { command: "pytest" } },
    args: { text: failure, isError: true, hasImages: false },
  });
  assert.deepEqual(response, { protocolVersion: 1, ok: true, decision: "allow" });
  assert.match(failure, /FAILURE-SENTINEL/);
});

test("bridge timeout is a hard total deadline without rejecting valid work before its grace window", async (t) => {
  const state = await harness();
  t.after(() => rm(state.directory, { recursive: true, force: true }));
  const options = {
    launcherPath: python,
    environment: { HOME: state.directory, PATH: process.env.PATH, LANG: "C.UTF-8" },
  };
  const request = {
    protocolVersion: 1,
    action: "status",
    session: session(state),
  } as const;
  const hung = new BridgeClient(state.agentDir, { ...options, bridgePath: bridgeFixture("hang.py") });
  const hungStarted = Date.now();

  assert.equal(await hung.run(request, { timeoutMs: 50 }), null);
  const hungElapsed = Date.now() - hungStarted;
  assert.ok(hungElapsed < 175, `50ms hung bridge took ${hungElapsed}ms`);

  const delayed = new BridgeClient(state.agentDir, { ...options, bridgePath: bridgeFixture("echo.py") });
  const delayedStarted = Date.now();
  const response = await delayed.run({ ...request, args: { delayMs: 850 } }, { timeoutMs: 1_000 });
  const delayedElapsed = Date.now() - delayedStarted;

  assert.equal(response?.ok, true, `850ms bridge failed after ${delayedElapsed}ms`);
});

test("large Bash replacement is withheld when its archive destination cannot be verified", async (t) => {
  const state = await harness();
  t.after(() => rm(state.directory, { recursive: true, force: true }));
  const original = await readFile(join(outputs, "oversized.txt"), "utf8");
  const archiveRoot = join(state.agentDir, "token-optimizer", "data", "tool-archive");
  await writeFile(archiveRoot, "not a directory");

  const response = await run(state, {
    protocolVersion: 1,
    action: "post_tool",
    session: session(state),
    tool: { id: "unverified", name: "Bash", kind: "builtin", input: { command: "pytest" } },
    args: { text: original, isError: false, hasImages: false },
  });

  assert.deepEqual(response, { protocolVersion: 1, ok: true, decision: "allow" });
});

test("real read cache substitutes rereads, observes edit invalidation, and clears only after success", async (t) => {
  const state = await harness();
  t.after(() => rm(state.directory, { recursive: true, force: true }));
  const source = join(state.project, "sample.py");
  const original = Array.from({ length: 160 }, (_, index) =>
    `def old_marker_${index}(value):\n    return value + ${index}`).join("\n\n");
  await writeFile(source, original);
  const pre = (id: string): BridgeRequest => ({
    protocolVersion: 1,
    action: "pre_tool",
    session: session(state),
    tool: { id, name: "Read", kind: "builtin", input: { file_path: source } },
  });

  assert.equal((await run(state, pre("read-1"))).decision, "allow");
  const reread = await run(state, pre("read-2"));
  assert.equal(reread.decision, "block");
  assert.match(String(reread.data?.reason), /signatures view/);

  await writeFile(source, original.replace("old_marker_0", "new_marker_0"));
  await run(state, {
    protocolVersion: 1,
    action: "post_tool",
    session: session(state),
    tool: { id: "edit-1", name: "Edit", kind: "builtin", input: { file_path: source } },
    args: { text: "updated", isError: false, hasImages: false },
  });
  const afterEdit = await run(state, pre("read-3"));
  assert.equal(afterEdit.decision, "block");
  assert.match(String(afterEdit.data?.additionalContext), /new_marker_0/);
  assert.doesNotMatch(String(afterEdit.data?.additionalContext), /old_marker_0\(value\)/);

  const afterFailedCompaction = await run(state, pre("read-4"));
  assert.equal(afterFailedCompaction.decision, "block");
  await run(state, { protocolVersion: 1, action: "post_compact", session: session(state) });
  assert.equal((await run(state, pre("read-5"))).decision, "allow");
});

test("real lifecycle recovers once, returns filterable nudges, and rollup is idempotent", async (t) => {
  const state = await harness();
  t.after(() => rm(state.directory, { recursive: true, force: true }));
  const checkpointRoot = join(state.agentDir, "token-optimizer", "checkpoints");
  await mkdir(checkpointRoot, { recursive: true });
  const prior = "22222222-2222-4222-8222-222222222222-20260903-120000-stop";
  await writeFile(join(checkpointRoot, `${prior}.md`), "# Session State Checkpoint\n\n## Active Task\nSECURITY-SENTINEL prior task\n");
  await writeFile(join(checkpointRoot, `${prior}.json`), JSON.stringify({
    session_id: "22222222-2222-4222-8222-222222222222",
    active_task: "SECURITY-SENTINEL prior task",
    modified_files: [{ path: join(state.project, "sample.py") }],
    recent_reads: [],
    decisions: [],
    git: {},
  }));

  const start: BridgeRequest = {
    protocolVersion: 1,
    action: "session_start",
    session: session(state),
    args: { reason: "resume" },
  };
  const first = await run(state, start);
  const second = await run(state, start);
  assert.equal(first.contexts?.[0]?.scope, "recovery");
  assert.match(first.contexts?.[0]?.text ?? "", /Cross-session checkpoint/);
  assert.equal(second.contexts, undefined);

  const nudge = await run(state, {
    protocolVersion: 1,
    action: "before_prompt",
    session: session(state),
    args: { prompt: "Continue the prior task" },
  });
  assert.equal(nudge.contexts?.[0]?.scope, "nudge");
  assert.match(nudge.contexts?.[0]?.text ?? "", /Prior task|checkpoint/i);

  const rollup: BridgeRequest = { protocolVersion: 1, action: "rollup", session: session(state) };
  assert.equal((await run(state, rollup)).data?.status, "incomplete");
  assert.equal((await run(state, rollup)).data?.status, "incomplete");
  const query = "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute(\"select count(*) from session_log where jsonl_path=?\",(sys.argv[2],)).fetchone()[0])";
  const { execFile } = await import("node:child_process");
  const count = await new Promise<string>((resolve, reject) => execFile(
    process.env.PYTHON ?? "python3",
    ["-c", query, join(state.agentDir, "token-optimizer", "data", "trends.db"), `pi:${sessionId}`],
    (error, stdout) => error ? reject(error) : resolve(stdout.trim()),
  ));
  assert.equal(count, "1");
});
