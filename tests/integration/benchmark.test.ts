import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const benchmark = fileURLToPath(new URL("../../scripts/benchmark.mjs", import.meta.url));

function execute(iterations: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => execFile(
    process.execPath,
    ["--import", "tsx", benchmark],
    {
      cwd: repository,
      env: {
        ...process.env,
        PI_TOKEN_OPTIMIZER_BENCH_ITERATIONS: iterations,
        BENCHMARK_ITERATIONS: "3",
      },
      maxBuffer: 1024 * 1024,
    },
    (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }),
  ));
}

test("benchmark honors PI_TOKEN_OPTIMIZER_BENCH_ITERATIONS", async () => {
  const { stdout, stderr } = await execute("2");

  assert.match(stdout, /^iterations: 2 per action \(warmup: 1 per action\)$/m);
  assert.match(stdout, /^pre_tool: p50=\d+\.\d{2}ms p95=\d+\.\d{2}ms$/m);
  assert.match(stdout, /^post_tool: p50=\d+\.\d{2}ms p95=\d+\.\d{2}ms$/m);
  assert.equal(stderr, "");
});

test("benchmark rejects unbounded or non-integer iteration values", async () => {
  for (const iterations of ["0", "1001", "2.5", " 2"]) {
    await assert.rejects(execute(iterations), (error: Error & { stderr?: string }) => {
      assert.match(error.stderr ?? "", /iterations must be an integer from 1 through 1000/);
      return true;
    });
  }
});
