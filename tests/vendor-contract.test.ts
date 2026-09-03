import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const changedFiles = [
  "skills/token-optimizer/scripts/archive_result.py",
  "skills/token-optimizer/scripts/bash_hook.py",
  "skills/token-optimizer/scripts/measure.py",
  "skills/token-optimizer/scripts/runtime_env.py",
];

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function runCheck(directory: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [resolve(directory, "scripts/check-vendor.mjs")], {
    cwd: directory,
    encoding: "utf8",
  });
}

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-token-optimizer-contract-"));
  await Promise.all([
    cp(resolve(root, "scripts"), resolve(directory, "scripts"), { recursive: true }),
    cp(resolve(root, "vendor"), resolve(directory, "vendor"), { recursive: true }),
    cp(resolve(root, "patches"), resolve(directory, "patches"), { recursive: true }),
  ]);
  return directory;
}

async function vendorHashes(directory: string): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(changedFiles.map(async (path) => [
    path,
    sha256(await readFile(resolve(directory, "vendor/token-optimizer", path))),
  ])));
}

test("manifest records reproducible provenance for exactly the Pi compatibility patch", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "vendor/manifest.json"), "utf8"));
  const patch = await readFile(resolve(root, manifest.patch.path));

  assert.equal(manifest.patch.sha256, sha256(patch));
  assert.deepEqual(manifest.patch.changedFiles, changedFiles);
  assert.deepEqual(
    Object.entries(manifest.files as Record<string, Record<string, string>>)
      .filter(([, file]) => file.upstreamSha256 !== file.patchedSha256)
      .map(([path]) => path),
    changedFiles,
  );
  for (const file of Object.values(manifest.files) as Array<Record<string, string>>) {
    assert.match(file.upstreamSha256, /^[a-f0-9]{64}$/);
    assert.match(file.patchedSha256, /^[a-f0-9]{64}$/);
    assert.match(file.mode, /^100(644|755)$/);
  }
  assert.deepEqual(Object.keys(manifest.patch.requiredSymbols), changedFiles);
});

test("vendor checker rejects a stale patch without mutating vendored bytes", async () => {
  const directory = await fixture();
  const manifestPath = resolve(directory, "vendor/manifest.json");
  const patchPath = resolve(directory, "patches/pi-runtime.patch");

  try {
    const before = await vendorHashes(directory);
    const patch = await readFile(patchPath, "utf8");
    assert.match(patch, /_RUNTIME_PI/);
    const stalePatch = patch.replace("_RUNTIME_PI", "_RUNTIME_PX");
    await writeFile(patchPath, stalePatch);

    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.patch.sha256 = sha256(Buffer.from(stalePatch));
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = runCheck(directory);
    assert.notEqual(result.status, 0, String(result.stdout) + String(result.stderr));
    assert.deepEqual(await vendorHashes(directory), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("vendor checker rejects patch and compatibility-contract tampering", async () => {
  for (const mutate of [
    async (directory: string) => {
      const patchPath = resolve(directory, "patches/pi-runtime.patch");
      await writeFile(patchPath, Buffer.concat([await readFile(patchPath), Buffer.from("\n")]));
    },
    async (directory: string) => {
      const manifestPath = resolve(directory, "vendor/manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.patch.changedFiles.pop();
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    },
    async (directory: string) => {
      const manifestPath = resolve(directory, "vendor/manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.patch.requiredSymbols[changedFiles[0]].pop();
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    },
    async (directory: string) => {
      const manifestPath = resolve(directory, "vendor/manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.files[changedFiles[0]].upstreamSha256 = "0".repeat(64);
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    },
  ]) {
    const directory = await fixture();
    try {
      await mutate(directory);
      const result = runCheck(directory);
      assert.notEqual(result.status, 0, String(result.stdout) + String(result.stderr));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
