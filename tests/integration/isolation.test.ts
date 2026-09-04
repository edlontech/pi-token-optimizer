import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";

import { PiAdapter } from "../../src/adapter.ts";
import { BridgeClient } from "../../src/bridge.ts";
import { BRIDGE_ACTIONS, type BridgeRequest } from "../../src/protocol.ts";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const python = process.env.PYTHON ?? "python3";
const sessionId = "11111111-1111-4111-8111-111111111111";
const sentinelRoots = [".claude", ".codex", ".config/opencode", ".hermes", ".copilot", ".cursor"];
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type State = {
  root: string;
  home: string;
  agentDir: string;
  project: string;
  sessionFile: string;
  symlinkTarget: string;
  client: BridgeClient;
};

async function setup(): Promise<State> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-token-isolation-")));
  const home = join(root, "home");
  const agentDir = join(root, "pi-agent");
  const project = join(root, "project");
  await Promise.all([mkdir(home), mkdir(project), mkdir(join(agentDir, "token-optimizer", "data"), { recursive: true })]);
  const symlinkTarget = join(root, "foreign-link-target.bin");
  await writeFile(symlinkTarget, Buffer.from([255, 128, 127, 13, 10, 2, 1, 0]), { mode: 0o600 });
  for (const path of sentinelRoots) {
    const directory = join(home, path);
    await mkdir(directory, { recursive: true, mode: 0o750 });
    await writeFile(join(directory, "sentinel.bin"), Buffer.from([0, 1, 2, 10, 13, 127, 128, 255]), { mode: 0o640 });
    await symlink(relative(directory, symlinkTarget), join(directory, "sentinel.link"));
  }
  await writeFile(join(agentDir, "token-optimizer", "config.json"), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    consent: { granted: true, noticeVersion: 1, grantedAt: "2026-09-03T12:00:00.000Z" },
  }));
  const sessionFile = join(root, "session.jsonl");
  await writeFile(sessionFile, await readFile(join(repository, "tests", "fixtures", "pi-session-linear.jsonl")));
  return {
    root,
    home,
    agentDir,
    project,
    sessionFile,
    symlinkTarget,
    client: new BridgeClient(agentDir, {
      environment: {
        HOME: home,
        PATH: process.env.PATH,
        LANG: "C.UTF-8",
        TOKEN_OPTIMIZER_NO_PROC_SCAN: "1",
        TOKEN_OPTIMIZER_FIRST_READ_SHADOW: "0",
        TOKEN_OPTIMIZER_CONTEXT_SIZE: "200000",
      },
    }),
  };
}

function session(state: State) {
  return { id: sessionId, cwd: state.project, file: state.sessionFile };
}

async function fingerprint(state: State): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  const visit = async (path: string, key = relative(state.home, path)): Promise<void> => {
    try {
      const info = await lstat(path, { bigint: true });
      const kind = info.isDirectory()
        ? "directory"
        : info.isFile() ? "file" : info.isSymbolicLink() ? "symlink" : "other";
      result[key] = {
        kind,
        mode: info.mode.toString(),
        uid: info.uid.toString(),
        gid: info.gid.toString(),
        inode: info.ino.toString(),
        links: info.nlink.toString(),
        size: info.size.toString(),
        mtimeNs: info.mtimeNs.toString(),
        ctimeNs: info.ctimeNs.toString(),
        birthtimeNs: info.birthtimeNs.toString(),
        bytes: info.isFile() ? (await readFile(path)).toString("base64") : undefined,
        link: info.isSymbolicLink() ? await readlink(path) : undefined,
      };
      if (info.isDirectory()) {
        for (const child of (await readdir(path)).sort()) await visit(join(path, child));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      result[key] = { kind: "missing" };
    }
  };
  for (const path of sentinelRoots) await visit(join(state.home, path));
  await visit(state.symlinkTarget, "@symlink-target");
  return result;
}

function requestFor(action: typeof BRIDGE_ACTIONS[number], state: State, source: string): BridgeRequest {
  const base = { protocolVersion: 1 as const, action, session: session(state) };
  if (action === "pre_tool") {
    return { ...base, tool: { id: "read-all-actions", name: "Read", kind: "builtin", input: { file_path: source } } };
  }
  if (action === "post_tool") {
    return {
      ...base,
      tool: { id: "external-all-actions", name: "acme.search", kind: "external", input: { query: "safe" } },
      args: { text: "short result", isError: false, hasImages: false },
    };
  }
  if (action === "before_prompt") return { ...base, args: { prompt: "continue" } };
  if (action === "session_start") return { ...base, args: { reason: "startup" } };
  if (action === "expand") return { ...base, args: { archiveId: "missing-archive", offset: 0, limit: 10 } };
  return base;
}

test("every supported real bridge action leaves all foreign-agent sentinel bytes and metadata unchanged", async (t) => {
  const state = await setup();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  const source = join(state.project, "source.ts");
  await writeFile(source, "export const value = 1;\n");
  assert.equal(BRIDGE_ACTIONS.length, 12);

  for (const action of BRIDGE_ACTIONS) {
    const before = await fingerprint(state);
    const response = await state.client.run(requestFor(action, state, source), { timeoutMs: 15_000 });
    assert.ok(response, action);
    const after = await fingerprint(state);
    assert.deepEqual(after, before, `${action} changed a foreign-agent sentinel tree`);
  }
});

function context(state: State): ExtensionContext {
  return {
    cwd: state.project,
    mode: "tui",
    hasUI: false,
    model: { provider: "test", id: "fake" },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => state.sessionFile,
    },
    signal: new AbortController().signal,
  } as ExtensionContext;
}

async function activeAdapter(state: State, client = state.client): Promise<PiAdapter> {
  const pi = {
    getAllTools: () => ["bash", "read", "edit"].map((name) => ({
      name,
      description: name,
      parameters: {},
      sourceInfo: { path: `<${name}>`, source: "builtin", scope: "temporary", origin: "top-level" },
    })),
    sendMessage: () => {},
  } as unknown as Pick<ExtensionAPI, "getAllTools" | "sendMessage">;
  const adapter = new PiAdapter(pi, client, {
    load: async () => ({
      schemaVersion: 1,
      enabled: true,
      consent: { granted: true, noticeVersion: 1, grantedAt: "2026-09-03T12:00:00.000Z" },
    }),
  });
  await adapter.start(context(state), "startup");
  assert.equal(adapter.isActive(), true);
  return adapter;
}

function setClientPath(client: BridgeClient, key: "bridgePath" | "launcherPath", value: string): string {
  const mutable = client as unknown as Record<string, string>;
  const prior = mutable[key];
  mutable[key] = value;
  return prior;
}

async function waitForPids(path: string): Promise<number[]> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const values = (await readFile(path, "utf8")).trim().split(/\s+/);
      if (values.length === 2 && values.every((value) => /^[1-9]\d*$/.test(value))) return values.map(Number);
    } catch {}
    await pause(10);
  }
  throw new Error("hung bridge did not report exact process ids");
}

async function assertGone(pids: number[]): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (pids.every((pid) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    })) return;
    await pause(10);
  }
  assert.fail(`descendants remain: ${pids.join(",")}`);
}

async function waitForLine(child: ChildProcessWithoutNullStreams, expected: string): Promise<void> {
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("lock helper did not become ready")), 2_000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      if (output.includes(expected)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`lock helper exited ${code}`)));
  });
}

test("crash, malformed output, and missing Python execute and fail open with exact Pi pass-through", async (t) => {
  const state = await setup();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  const adapter = await activeAdapter(state);
  const ctx = context(state);
  const crash = join(state.root, "crash.py");
  const malformed = join(state.root, "malformed.py");
  await writeFile(crash, [
    "import json, pathlib, sys",
    "request = json.loads(sys.stdin.read())",
    "pathlib.Path(request['session']['cwd'], 'crash-ran').write_text(request['action'])",
    "raise SystemExit(9)",
    "",
  ].join("\n"));
  await writeFile(malformed, [
    "import json, pathlib, sys",
    "request = json.loads(sys.stdin.read())",
    "pathlib.Path(request['session']['cwd'], 'malformed-ran').write_text(request['action'])",
    "print('not-json')",
    "",
  ].join("\n"));
  const originalBridge = setClientPath(state.client, "bridgePath", crash);

  const call: ToolCallEvent = {
    type: "tool_call",
    toolName: "bash",
    toolCallId: "bash-crash",
    input: { command: "printf original", timeout: 30 },
  };
  assert.equal(await adapter.beforeTool(call, ctx), undefined);
  assert.equal(await readFile(join(state.project, "crash-ran"), "utf8"), "pre_tool");
  assert.deepEqual(call.input, { command: "printf original", timeout: 30 });

  setClientPath(state.client, "bridgePath", malformed);
  const result: ToolResultEvent = {
    type: "tool_result",
    toolName: "bash",
    toolCallId: "bash-malformed",
    input: { command: "printf original" },
    content: [{ type: "text", text: "original Pi output" }],
    details: undefined,
    isError: false,
  };
  assert.equal(await adapter.afterTool(result, ctx), undefined);
  assert.equal(await readFile(join(state.project, "malformed-ran"), "utf8"), "post_tool");
  assert.deepEqual(result.content, [{ type: "text", text: "original Pi output" }]);

  setClientPath(state.client, "bridgePath", originalBridge);
  const missingLauncher = join(state.root, "missing-python.sh");
  await writeFile(missingLauncher, "#!/bin/sh\nprintf pre_tool > \"$PWD/missing-python-ran\"\nexec \"$PWD/python-does-not-exist\" \"$@\"\n");
  await chmod(missingLauncher, 0o700);
  const originalLauncher = setClientPath(state.client, "launcherPath", missingLauncher);
  const missingCall: ToolCallEvent = {
    type: "tool_call",
    toolName: "bash",
    toolCallId: "bash-missing-python",
    input: { command: "printf original", timeout: 30 },
  };
  assert.equal(await adapter.beforeTool(missingCall, ctx), undefined);
  assert.equal(await readFile(join(state.project, "missing-python-ran"), "utf8"), "pre_tool");
  assert.deepEqual(missingCall.input, { command: "printf original", timeout: 30 });
  setClientPath(state.client, "launcherPath", originalLauncher);

  const unsafeTarget = join(state.root, "outside-output.txt");
  const unsafeLink = join(state.project, "unsafe-output.txt");
  await writeFile(unsafeTarget, (await readFile(join(repository, "tests", "fixtures", "tool-output", "oversized.txt"))));
  await symlink(unsafeTarget, unsafeLink);
  const unsafeResult: ToolResultEvent = {
    ...result,
    toolCallId: "bash-unsafe-path",
    content: [{ type: "text", text: "original truncated output" }],
    details: { fullOutputPath: unsafeLink, truncation: { truncated: true } },
  };
  assert.equal(await adapter.afterTool(unsafeResult, ctx), undefined);
  assert.deepEqual(unsafeResult.content, [{ type: "text", text: "original truncated output" }]);
});

test("the real session database lock forces fail-open where the unlocked read is blocked", async (t) => {
  const state = await setup();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  const adapter = await activeAdapter(state);
  const ctx = context(state);
  const source = join(state.project, "locked.py");
  await writeFile(source, Array.from({ length: 160 }, (_, index) =>
    `def locked_${index}(value):\n    return value + ${index}`).join("\n\n"));
  const readRequest: BridgeRequest = {
    protocolVersion: 1,
    action: "pre_tool",
    session: session(state),
    tool: { id: "lock-first", name: "Read", kind: "builtin", input: { file_path: source } },
  };
  assert.equal((await state.client.run(readRequest, { timeoutMs: 2_500 }))?.decision, "allow");
  const database = join(state.agentDir, "token-optimizer", "data", "session-store", `${sessionId}.db`);
  assert.equal(await realpath(database), database);
  const row = await new Promise<string>((resolve, reject) => execFile(
    python,
    ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute('SELECT file_path FROM file_reads').fetchone()[0]); c.close()", database],
    (error, stdout) => error ? reject(error) : resolve(stdout.trim()),
  ));
  assert.equal(row, source);

  const controlCall: ToolCallEvent = {
    type: "tool_call",
    toolName: "read",
    toolCallId: "lock-control",
    input: { path: source },
  };
  const control = await adapter.beforeTool(controlCall, ctx);
  assert.equal(control?.block, true);
  assert.match(control?.reason ?? "", /unchanged|already in context/i);
  assert.deepEqual(controlCall.input, { path: source });

  const marker = `locked:${database}\n`;
  const lockCode = "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('BEGIN IMMEDIATE'); changed=c.execute('UPDATE file_reads SET read_count=read_count WHERE file_path=?',(sys.argv[2],)).rowcount; assert changed == 1; print('locked:'+sys.argv[1],flush=True); sys.stdin.readline(); c.rollback(); c.close()";
  const locker = spawn(python, ["-c", lockCode, database, source], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => {
    locker.stdin.on("error", () => {});
    if (!locker.stdin.destroyed && !locker.stdin.writableEnded) locker.stdin.end();
    if (locker.exitCode === null && locker.signalCode === null && locker.pid) {
      try { process.kill(locker.pid, "SIGKILL"); } catch {}
    }
  });
  await waitForLine(locker, marker);
  const lockedCall: ToolCallEvent = {
    type: "tool_call",
    toolName: "read",
    toolCallId: "lock-contended",
    input: { path: source },
  };
  assert.equal(await adapter.beforeTool(lockedCall, ctx), undefined);
  assert.deepEqual(lockedCall.input, { path: source });
  locker.stdin.end();
  await new Promise<void>((resolve, reject) => {
    locker.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`lock helper exited ${code}`)));
  });
});

test("a real tool result remains exact when the hung bridge and its exact descendant are killed at the 2.5 second deadline", async (t) => {
  const state = await setup();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  const pidPath = join(state.root, "hung.pids");
  const client = new BridgeClient(state.agentDir, {
    environment: {
      HOME: state.home,
      PATH: process.env.PATH,
      LANG: "C.UTF-8",
      TOKEN_OPTIMIZER_NO_PROC_SCAN: "1",
      TOKEN_OPTIMIZER_FIRST_READ_SHADOW: "0",
      TOKEN_OPTIMIZER_CONTEXT_SIZE: "200000",
      TOKEN_OPTIMIZER_TEST_PID_FILE: pidPath,
    },
  });
  const adapter = await activeAdapter(state, client);
  setClientPath(client, "bridgePath", join(repository, "tests", "fixtures", "bridge", "hang.py"));
  const event: ToolResultEvent = {
    type: "tool_result",
    toolName: "bash",
    toolCallId: "hung-tool",
    input: { command: "printf original" },
    content: [{ type: "text", text: "original Pi output" }],
    details: undefined,
    isError: false,
  };
  const originalContent = structuredClone(event.content);
  const started = performance.now();
  const pending = adapter.afterTool(event, context(state));
  const pids = await waitForPids(pidPath);

  const mutation = await pending;
  const elapsed = performance.now() - started;
  const appliedContent = mutation?.content ?? event.content;
  assert.equal(mutation, undefined);
  assert.deepEqual(event.content, originalContent);
  assert.deepEqual(appliedContent, originalContent);
  assert.ok(elapsed < 2_550, `hung bridge took ${elapsed}ms`);
  await assertGone(pids);
});
