import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { BridgeClient } from "../src/bridge.ts";

const fixture = (name: string) => fileURLToPath(new URL(`fixtures/bridge/${name}`, import.meta.url));
const python = process.env.PYTHON ?? "python3";
const testPath = process.env.PATH;
if (testPath === undefined) throw new Error("Bridge tests require PATH");
const session = { id: "session-1", cwd: process.cwd(), file: fixture("session.jsonl") };
const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForPids(path: string): Promise<number[]> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const values = (await readFile(path, "utf8")).trim().split(/\s+/);
      if (values.length === 2 && values.every((value) => /^[1-9]\d*$/.test(value))) {
        const pids = values.map(Number);
        if (pids.every(Number.isSafeInteger)) return pids;
      }
    } catch {}
    await pause(10);
  }
  throw new Error("Timed out waiting for bridge process ids");
}

test("waitForPids retries incomplete and invalid PID data", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-bridge-pids-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pidPath = join(directory, "bridge.pids");
  await writeFile(pidPath, "\n");
  const waiting = waitForPids(pidPath);

  await pause(20);
  await writeFile(pidPath, "123\n");
  await pause(20);
  await writeFile(pidPath, "0 456\n");
  await pause(20);
  await writeFile(pidPath, "123 456\n");

  assert.deepEqual(await waiting, [123, 456]);
});

async function assertProcessesExit(pids: number[]): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const alive = pids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (alive.length === 0) return;
    await pause(10);
  }
  assert.fail(`Bridge processes still alive: ${pids.join(", ")}`);
}

async function waitForRequestCount(path: string, count: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      if ((await readFile(path, "utf8")).trim().split("\n").length >= count) return;
    } catch {}
    await pause(10);
  }
  throw new Error(`Timed out waiting for ${count} bridge requests`);
}

test("runs one request through the injected bridge and validates its response", async () => {
  const client = new BridgeClient(fixture("agent"), {
    launcherPath: python,
    bridgePath: fixture("echo.py"),
  });
  const request = { protocolVersion: 1, action: "status", session } as const;

  const response = await client.run(request, { timeoutMs: 2_500 });

  assert.equal(response?.ok, true);
  assert.deepEqual(response?.data?.request, request);
});

test("passes only sanitized feature flags and request-owned Pi identity", async () => {
  const agentDir = fixture("agent home");
  const environment = {
    PATH: testPath,
    HOME: "/tmp/user-home",
    LANG: "C.UTF-8",
    LC_ALL: "C",
    TMPDIR: "/tmp",
    TOKEN_OPTIMIZER_NO_PROC_SCAN: "1",
    TOKEN_OPTIMIZER_RUNTIME: "claude",
    TOKEN_OPTIMIZER_PI_HOME: "/wrong/pi",
    TOKEN_OPTIMIZER_SNAPSHOT_DIR: "/wrong/snapshot",
    TOKEN_OPTIMIZER_API_KEY: "optimizer-secret",
    TOKEN_OPTIMIZER_CLAUDE_MODE: "1",
    PI_SESSION_ID: "wrong-session",
    PI_SESSION_FILE: "/wrong/session",
    PI_PROVIDER: "wrong-provider",
    PI_MODEL: "wrong-model",
    PI_REASONING_LEVEL: "wrong-reasoning",
    CLAUDE_CONFIG_DIR: "/foreign/claude",
    CODEX_HOME: "/foreign/codex",
    OPENCODE_HOME: "/foreign/opencode",
    HERMES_HOME: "/foreign/hermes",
    COPILOT_HOME: "/foreign/copilot",
    CURSOR_HOME: "/foreign/cursor",
    OPENAI_API_KEY: "provider-secret",
  };
  const client = new BridgeClient(agentDir, {
    launcherPath: python,
    bridgePath: fixture("echo.py"),
    environment,
  });
  const request = {
    protocolVersion: 1,
    action: "status",
    session: {
      ...session,
      provider: "pi-provider",
      model: "pi-model",
      reasoningLevel: "high",
    },
  } as const;

  const response = await client.run(request, { timeoutMs: 2_500 });
  const childEnv = response?.data?.environment as Record<string, string>;

  assert.deepEqual(
    {
      HOME: childEnv.HOME,
      LANG: childEnv.LANG,
      LC_ALL: childEnv.LC_ALL,
      PATH: childEnv.PATH,
      PI_MODEL: childEnv.PI_MODEL,
      PI_PROVIDER: childEnv.PI_PROVIDER,
      PI_REASONING_LEVEL: childEnv.PI_REASONING_LEVEL,
      PI_SESSION_FILE: childEnv.PI_SESSION_FILE,
      PI_SESSION_ID: childEnv.PI_SESSION_ID,
      PWD: childEnv.PWD,
      PYTHONIOENCODING: childEnv.PYTHONIOENCODING,
      PYTHONUTF8: childEnv.PYTHONUTF8,
      TMPDIR: childEnv.TMPDIR,
      TOKEN_OPTIMIZER_NO_PROC_SCAN: childEnv.TOKEN_OPTIMIZER_NO_PROC_SCAN,
      TOKEN_OPTIMIZER_PI_HOME: childEnv.TOKEN_OPTIMIZER_PI_HOME,
      TOKEN_OPTIMIZER_RUNTIME: childEnv.TOKEN_OPTIMIZER_RUNTIME,
      TOKEN_OPTIMIZER_SNAPSHOT_DIR: childEnv.TOKEN_OPTIMIZER_SNAPSHOT_DIR,
    },
    {
      HOME: environment.HOME,
      LANG: environment.LANG,
      LC_ALL: environment.LC_ALL,
      PATH: environment.PATH,
      PI_MODEL: "pi-model",
      PI_PROVIDER: "pi-provider",
      PI_REASONING_LEVEL: "high",
      PI_SESSION_FILE: session.file,
      PI_SESSION_ID: session.id,
      PWD: session.cwd,
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
      TMPDIR: environment.TMPDIR,
      TOKEN_OPTIMIZER_NO_PROC_SCAN: "1",
      TOKEN_OPTIMIZER_PI_HOME: agentDir,
      TOKEN_OPTIMIZER_RUNTIME: "pi",
      TOKEN_OPTIMIZER_SNAPSHOT_DIR: join(agentDir, "token-optimizer", "data"),
    },
  );
  for (const forbidden of [
    "TOKEN_OPTIMIZER_API_KEY",
    "TOKEN_OPTIMIZER_CLAUDE_MODE",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "OPENCODE_HOME",
    "HERMES_HOME",
    "COPILOT_HOME",
    "CURSOR_HOME",
    "OPENAI_API_KEY",
  ]) {
    assert.equal(childEnv[forbidden], undefined, forbidden);
  }
});

test("fails open at the requested hard deadline", async () => {
  const client = new BridgeClient(fixture("agent"), {
    launcherPath: python,
    bridgePath: fixture("echo.py"),
  });
  const request = {
    protocolVersion: 1,
    action: "status",
    session,
    args: { delayMs: 300 },
  } as const;
  const started = Date.now();

  assert.equal(await client.run(request, { timeoutMs: 50 }), null);
  assert.ok(Date.now() - started < 250);
});

test("rejects malformed, extra, oversized, and nonzero child output", async () => {
  const client = new BridgeClient(fixture("agent"), {
    launcherPath: python,
    bridgePath: fixture("invalid.py"),
  });
  for (const mode of ["invalid", "extra", "oversized", "nonzero"]) {
    const request = { protocolVersion: 1, action: "status", session, args: { mode } } as const;
    assert.equal(await client.run(request, { timeoutMs: 1_000 }), null, mode);
  }

  const expansion = {
    protocolVersion: 1,
    action: "expand",
    session,
    args: { archiveId: "archive_1", mode: "expansion" },
  } as const;
  assert.equal(await client.run(expansion, { timeoutMs: 1_000 }), null);
});

test("drains large stderr without accepting it as protocol output", async () => {
  const client = new BridgeClient(fixture("agent"), {
    launcherPath: python,
    bridgePath: fixture("invalid.py"),
  });
  const request = {
    protocolVersion: 1,
    action: "status",
    session,
    args: { mode: "stderr" },
  } as const;

  assert.deepEqual(await client.run(request, { timeoutMs: 1_000 }), {
    protocolVersion: 1,
    ok: true,
  });
});

test("fails open without uncaught exceptions from repeated child stream errors", async () => {
  const client = new BridgeClient(fixture("agent"), {
    launcherPath: python,
    bridgePath: fixture("echo.py"),
  });
  const originalOn = Socket.prototype.on;
  const errorStreams = new Set<Socket>();
  const uncaught: Error[] = [];
  const recordUncaught = (error: Error) => uncaught.push(error);
  Socket.prototype.on = function(
    this: Socket,
    event: string | symbol,
    listener: (...args: unknown[]) => void,
  ) {
    const result = originalOn.call(this, event, listener);
    if (event === "error" && !errorStreams.has(this)) {
      errorStreams.add(this);
      queueMicrotask(() => {
        this.emit("error", new Error("first simulated child stream error"));
        this.emit("error", new Error("second simulated child stream error"));
      });
    }
    return result;
  } as typeof Socket.prototype.on;
  process.on("uncaughtException", recordUncaught);

  try {
    assert.equal(
      await client.run({ protocolVersion: 1, action: "status", session }, { timeoutMs: 1_000 }),
      null,
    );
    await pause(150);
    assert.equal(errorStreams.size, 3);
    assert.deepEqual(uncaught, []);
  } finally {
    Socket.prototype.on = originalOn;
    process.removeListener("uncaughtException", recordUncaught);
  }
});

test("rejects oversized input before spawning and resolves spawn errors to null", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-bridge-input-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const logPath = join(directory, "requests.jsonl");
  const client = new BridgeClient(directory, {
    launcherPath: python,
    bridgePath: fixture("echo.py"),
    environment: {
      PATH: testPath,
      HOME: directory,
      TOKEN_OPTIMIZER_TEST_LOG: logPath,
    },
  });
  const large = "x".repeat(3 * 1024 * 1024);
  const oversized = {
    protocolVersion: 1,
    action: "status",
    session,
    args: { first: large, second: large },
  } as const;

  assert.equal(await client.run(oversized, { timeoutMs: 1_000 }), null);
  await assert.rejects(access(logPath), { code: "ENOENT" });

  const missing = new BridgeClient(directory, {
    launcherPath: join(directory, "missing-launcher"),
    bridgePath: fixture("echo.py"),
  });
  assert.equal(await missing.run({ protocolVersion: 1, action: "status", session }, {
    timeoutMs: 1_000,
  }), null);
});

test("timeout and caller abort terminate the child process group", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-bridge-kill-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  for (const cause of ["timeout", "abort"] as const) {
    const pidPath = join(directory, `${cause}.pids`);
    const client: BridgeClient = new BridgeClient(directory, {
      launcherPath: python,
      bridgePath: fixture("hang.py"),
      environment: {
        PATH: testPath,
        HOME: directory,
        TOKEN_OPTIMIZER_TEST_PID_FILE: pidPath,
      },
    });
    const controller = new AbortController();
    const started = Date.now();
    const result: ReturnType<BridgeClient["run"]> = client.run(
      { protocolVersion: 1, action: "status", session },
      { timeoutMs: 2_500, signal: controller.signal },
    );
    const pids = await waitForPids(pidPath);
    if (cause === "abort") controller.abort();

    assert.equal(await result, null);
    assert.ok(Date.now() - started < 3_000);
    await assertProcessesExit(pids);
  }
});

test("forces settlement when process-group signals fail", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-bridge-signal-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pidPath = join(directory, "signal-failure.pids");
  const client = new BridgeClient(directory, {
    launcherPath: python,
    bridgePath: fixture("hang.py"),
    environment: {
      PATH: testPath,
      HOME: directory,
      TOKEN_OPTIMIZER_TEST_PID_FILE: pidPath,
    },
  });
  const controller = new AbortController();
  const result = client.run(
    { protocolVersion: 1, action: "status", session },
    { timeoutMs: 2_500, signal: controller.signal },
  );
  const pids = await waitForPids(pidPath);
  const originalKill = process.kill;
  t.after(() => {
    process.kill = originalKill;
    for (const pid of pids) {
      try {
        originalKill(pid, "SIGKILL");
      } catch {}
    }
  });
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid === -pids[0]) throw new Error("simulated process-group signal failure");
    return originalKill(pid, signal);
  }) as typeof process.kill;
  const aborted = Date.now();
  controller.abort();

  assert.equal(await Promise.race([
    result,
    pause(500).then(() => { throw new Error("run did not settle after failed signals"); }),
  ]), null);
  assert.ok(Date.now() - aborted < 400);

  process.kill = originalKill;
  originalKill(-pids[0], "SIGKILL");
  await assertProcessesExit(pids);
});

test("forces settlement when an escaped descendant keeps stdio open", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-bridge-escaped-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pidPath = join(directory, "escaped.pids");
  let pids: number[] = [];
  t.after(() => {
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  });
  const client = new BridgeClient(directory, {
    launcherPath: python,
    bridgePath: fixture("hang.py"),
    environment: {
      PATH: testPath,
      HOME: directory,
      TOKEN_OPTIMIZER_TEST_PID_FILE: pidPath,
    },
  });
  const request = {
    protocolVersion: 1,
    action: "status",
    session,
    args: { mode: "escaped" },
  } as const;
  const controller = new AbortController();
  const result = client.run(request, { timeoutMs: 2_500, signal: controller.signal });
  pids = await waitForPids(pidPath);
  const aborted = Date.now();
  controller.abort();

  assert.equal(await Promise.race([
    result,
    pause(500).then(() => { throw new Error("run waited for inherited stdio to close"); }),
  ]), null);
  assert.ok(Date.now() - aborted < 400);
  await assertProcessesExit(pids);
});

test("constructing a client does not start a process", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-bridge-lazy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const logPath = join(directory, "requests.jsonl");

  new BridgeClient(directory, {
    launcherPath: python,
    bridgePath: fixture("echo.py"),
    environment: {
      PATH: testPath,
      HOME: directory,
      TOKEN_OPTIMIZER_TEST_LOG: logPath,
    },
  });
  await pause(30);

  await assert.rejects(access(logPath), { code: "ENOENT" });
});

test("coalesces tracked rollups to the newest pending request", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-bridge-tracked-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const logPath = join(directory, "requests.jsonl");
  const client = new BridgeClient(directory, {
    launcherPath: python,
    bridgePath: fixture("echo.py"),
    environment: {
      PATH: testPath,
      HOME: directory,
      TOKEN_OPTIMIZER_TEST_LOG: logPath,
    },
    trackedTimeoutMs: 1_000,
  });
  const trackedRequest = (sequence: number, delayMs: number) => ({
    protocolVersion: 1,
    action: "rollup",
    session: { ...session, file: fixture("session.jsonl") },
    args: { sequence, delayMs },
  } as const);

  client.runTracked(trackedRequest(1, 150));
  await pause(30);
  client.runTracked(trackedRequest(2, 0));
  client.runTracked(trackedRequest(3, 0));
  await waitForRequestCount(logPath, 2);
  await client.drainOrKill(1_000);

  const requests = (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(requests.map((request) => request.args.sequence), [1, 3]);
});

test("drainOrKill bounds cleanup when tracked work never settles", async () => {
  const client = new BridgeClient(fixture("agent"));
  const calls: number[] = [];
  client.run = async (request) => {
    calls.push(request.args?.sequence as number);
    return new Promise(() => {});
  };
  const request = (sequence: number) => ({
    protocolVersion: 1,
    action: "rollup",
    session,
    args: { sequence },
  } as const);

  client.runTracked(request(1));
  client.runTracked(request(2));
  const started = Date.now();
  await Promise.race([
    client.drainOrKill(20),
    pause(500).then(() => { throw new Error("drainOrKill exceeded its termination grace"); }),
  ]);

  assert.ok(Date.now() - started < 400);
  client.runTracked(request(3));
  await pause(50);
  assert.deepEqual(calls, [1]);
});

test("drainOrKill kills tracked work within budget and closes the client", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-bridge-drain-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pidPath = join(directory, "tracked.pids");
  const client = new BridgeClient(directory, {
    launcherPath: python,
    bridgePath: fixture("hang.py"),
    environment: {
      PATH: testPath,
      HOME: directory,
      TOKEN_OPTIMIZER_TEST_PID_FILE: pidPath,
    },
    trackedTimeoutMs: 10_000,
  });
  const request = {
    protocolVersion: 1,
    action: "finalize",
    session: { ...session, file: fixture("session.jsonl") },
  } as const;

  client.runTracked(request);
  const pids = await waitForPids(pidPath);
  const started = Date.now();
  await client.drainOrKill(50);

  assert.ok(Date.now() - started < 2_500);
  await assertProcessesExit(pids);
  client.runTracked(request);
  await pause(50);
  await assertProcessesExit(pids);
});
