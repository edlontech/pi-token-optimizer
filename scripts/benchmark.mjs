import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { BridgeClient } from "../src/bridge.ts";

const repository = fileURLToPath(new URL("..", import.meta.url));
const preFixture = "tests/fixtures/tool-output/paths.txt";
const postFixture = "tests/fixtures/tool-output/repeated.txt";

function iterations() {
  const option = process.argv.find((argument) => argument.startsWith("--iterations="));
  const optionIndex = process.argv.indexOf("--iterations");
  const raw = option?.slice("--iterations=".length)
    ?? (optionIndex >= 0 ? process.argv[optionIndex + 1] : undefined)
    ?? process.env.PI_TOKEN_OPTIMIZER_BENCH_ITERATIONS
    ?? process.env.BENCHMARK_ITERATIONS
    ?? "20";
  if (!/^[1-9]\d*$/.test(raw) || Number(raw) > 1_000) {
    throw new Error("iterations must be an integer from 1 through 1000");
  }
  return Number(raw);
}

function percentile(samples, value) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * value) - 1];
}

function printResult(action, samples) {
  console.log(`${action}: p50=${percentile(samples, 0.5).toFixed(2)}ms p95=${percentile(samples, 0.95).toFixed(2)}ms`);
}

const count = iterations();
const root = await realpath(await mkdtemp(join(tmpdir(), "pi-token-benchmark-")));
const agentDir = join(root, "pi-agent");
const project = join(root, "project");
const sessionFile = join(root, "session.jsonl");
const source = join(project, "benchmark.ts");
const sessionId = "11111111-1111-4111-8111-111111111111";

try {
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
  await writeFile(sessionFile, await readFile(join(repository, "tests", "fixtures", "pi-session-linear.jsonl")));
  await writeFile(source, await readFile(join(repository, preFixture)));
  const output = await readFile(join(repository, postFixture), "utf8");
  const client = new BridgeClient(agentDir, {
    environment: {
      HOME: root,
      PATH: process.env.PATH,
      LANG: "C.UTF-8",
      TOKEN_OPTIMIZER_NO_PROC_SCAN: "1",
      TOKEN_OPTIMIZER_FIRST_READ_SHADOW: "0",
      TOKEN_OPTIMIZER_CONTEXT_SIZE: "200000",
    },
  });
  const session = { id: sessionId, cwd: project, file: sessionFile };
  const pre = (id) => ({
    protocolVersion: 1,
    action: "pre_tool",
    session,
    tool: { id, name: "Read", kind: "builtin", input: { file_path: source } },
  });
  const post = (id) => ({
    protocolVersion: 1,
    action: "post_tool",
    session,
    tool: { id, name: "Bash", kind: "builtin", input: { command: "pytest tests/" } },
    args: { text: output, isError: false, hasImages: false },
  });
  const invoke = async (request) => {
    const started = performance.now();
    const response = await client.run(request, { timeoutMs: 5_000 });
    assert.equal(response?.ok, true, `${request.action} real bridge request failed`);
    return performance.now() - started;
  };

  await invoke(pre("warm-pre"));
  await invoke(post("warm-post"));
  const preSamples = [];
  const postSamples = [];
  for (let index = 0; index < count; index += 1) {
    preSamples.push(await invoke(pre(`pre-${index}`)));
    postSamples.push(await invoke(post(`post-${index}`)));
  }

  console.log(`fixtures: pre_tool=${preFixture} post_tool=${postFixture}`);
  console.log(`iterations: ${count} per action (warmup: 1 per action)`);
  printResult("pre_tool", preSamples);
  printResult("post_tool", postSamples);
  await client.drainOrKill(0);
} finally {
  await rm(root, { recursive: true, force: true });
}
