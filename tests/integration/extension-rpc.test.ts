import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const piPackageRoot = join(repository, "node_modules", "@earendil-works", "pi-coding-agent");
const piPackagePath = join(piPackageRoot, "package.json");
const cli = join(piPackageRoot, "dist", "bundle", "cli.js");

type JsonRecord = Record<string, unknown>;

function execute(file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => execFile(file, args, {
    ...options,
    maxBuffer: 10 * 1024 * 1024,
  }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr })));
}

class RpcProcess {
  readonly records: JsonRecord[] = [];
  private buffer = "";
  private parseError?: Error;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      while (true) {
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        try {
          const value: unknown = JSON.parse(line.endsWith("\r") ? line.slice(0, -1) : line);
          assert.equal(typeof value, "object");
          assert.notEqual(value, null);
          assert.equal(Array.isArray(value), false);
          this.records.push(value as JsonRecord);
        } catch (error) {
          this.parseError = error as Error;
        }
        for (const wake of this.waiters.splice(0)) wake();
      }
    });
  }

  async command(command: JsonRecord): Promise<JsonRecord> {
    const id = String(command.id);
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (this.parseError) throw this.parseError;
      const response = this.records.find((record) => record.type === "response" && record.id === id);
      if (response) return response;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 25);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    throw new Error(`RPC response timed out for ${id}`);
  }

  assertStrictJsonl(): void {
    if (this.parseError) throw this.parseError;
    assert.equal(this.buffer, "", `RPC stdout ended with a non-JSONL fragment: ${this.buffer}`);
    assert.ok(this.records.length > 0);
  }
}

const stopping = new WeakMap<ChildProcessWithoutNullStreams, Promise<void>>();

function waitForClose(closed: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    closed.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function stop(child: ChildProcessWithoutNullStreams, closed: Promise<void>): Promise<void> {
  const existing = stopping.get(child);
  if (existing) return existing;

  const pending = (async () => {
    child.stdin.on("error", () => {});
    if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      try { process.kill(child.pid, "SIGTERM"); } catch {}
    }
    if (await waitForClose(closed, 500)) return;

    if (child.exitCode === null && child.signalCode === null && child.pid) {
      try { process.kill(child.pid, "SIGKILL"); } catch {}
    }
    if (await waitForClose(closed, 500)) return;

    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
    throw new Error("RPC child did not close after SIGKILL");
  })();
  stopping.set(child, pending);
  return pending;
}

test("RPC JSONL framing accepts a final newline but rejects an empty record", async () => {
  const parse = async (output: string): Promise<RpcProcess> => {
    const child = spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(output)})`], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.stdin.end();
    child.stderr.resume();
    const rpc = new RpcProcess(child);
    await closed;
    return rpc;
  };

  const valid = await parse('{"type":"response","id":"valid"}\n');
  valid.assertStrictJsonl();
  assert.equal(valid.records.length, 1);

  const invalid = await parse('{"type":"response","id":"invalid"}\n\n');
  assert.throws(() => invalid.assertStrictJsonl());
});

test("Pi 0.84.4 loads the npm-packed extension in isolated RPC and runs status, consent, and doctor without a model call", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-token-rpc-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const agentDir = join(root, "pi-agent");
  const project = join(root, "project");
  const packDir = join(root, "pack");
  const installDir = join(root, "npm-install");
  const npmCache = join(root, "npm-cache");
  await Promise.all([mkdir(home), mkdir(agentDir), mkdir(project), mkdir(packDir), mkdir(installDir), mkdir(npmCache)]);
  const piPackage = JSON.parse(await readFile(piPackagePath, "utf8")) as {
    version: string;
    bin: { pi: string };
  };
  assert.equal(piPackage.version, "0.84.4");
  assert.equal(resolve(piPackageRoot, piPackage.bin.pi), cli);

  const env = {
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    PATH: process.env.PATH,
    LANG: "C.UTF-8",
    PI_OFFLINE: "1",
    NO_COLOR: "1",
    NPM_CONFIG_CACHE: npmCache,
    TOKEN_OPTIMIZER_NO_PROC_SCAN: "1",
  };

  const runtimeVersion = await execute(process.execPath, [cli, "--version"], { cwd: project, env });
  assert.equal(runtimeVersion.stdout.trim(), "0.84.4");
  assert.equal(runtimeVersion.stderr, "");

  const packed = await execute("npm", ["pack", "--json", "--pack-destination", packDir], { cwd: repository, env });
  const packResult = JSON.parse(packed.stdout) as Array<{ filename: string; files: Array<{ path: string }> }>;
  assert.equal(packResult.length, 1);
  assert.equal(packResult[0].files.some(({ path }) => path.startsWith("tests/")), false);
  const tarball = join(packDir, packResult[0].filename);
  await execute("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-package-lock",
    "--legacy-peer-deps",
    "--prefix",
    installDir,
    tarball,
  ], { cwd: project, env });
  const installed = join(installDir, "node_modules", "pi-token-optimizer");
  const installedPackage = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  assert.deepEqual(installedPackage.pi.extensions, ["./extensions/index.ts"]);

  await execute(process.execPath, [cli, "install", installed], { cwd: project, env });
  const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as { packages: string[] };
  assert.equal(settings.packages.length, 1);
  assert.equal(resolve(agentDir, settings.packages[0]), installed);

  const child = spawn(process.execPath, [
    cli,
    "--mode", "rpc",
    "--offline",
    "--no-session",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-builtin-tools",
  ], { cwd: project, env, stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  t.after(() => stop(child, closed));
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const rpc = new RpcProcess(child);

  const commands = await rpc.command({ id: "commands", type: "get_commands" });
  assert.equal(commands.success, true);
  const available = ((commands.data as JsonRecord).commands as JsonRecord[]).map(({ name }) => name);
  assert.ok(available.includes("token-optimizer"));

  assert.equal((await rpc.command({ id: "status", type: "prompt", message: "/token-optimizer status" })).success, true);
  assert.equal((await rpc.command({ id: "consent", type: "prompt", message: "/token-optimizer consent grant" })).success, true);
  assert.equal((await rpc.command({ id: "doctor", type: "prompt", message: "/token-optimizer doctor" })).success, true);
  assert.equal((await rpc.command({ id: "unicode", type: "set_session_name", name: "strict jsonl name" })).success, true);
  const state = await rpc.command({ id: "state", type: "get_state" });
  assert.equal((state.data as JsonRecord).sessionName, "strict jsonl name");

  const notices = rpc.records
    .filter((record) => record.type === "extension_ui_request" && record.method === "notify")
    .map((record) => String(record.message));
  assert.ok(notices.some((message) => /Token Optimizer status/.test(message)));
  assert.ok(notices.some((message) => /Consent granted/.test(message)));
  assert.ok(notices.some((message) => /Doctor: healthy/.test(message)));
  assert.equal(rpc.records.some((record) => record.type === "message_start" || record.type === "message_update"), false);

  await stop(child, closed);
  rpc.assertStrictJsonl();
  assert.doesNotMatch(stderr, /extension_error|SyntaxError|Traceback/);
});
