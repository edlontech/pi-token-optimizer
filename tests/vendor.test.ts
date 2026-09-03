import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, cp, link, mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { replaceManifest, tagCommitRef } from "../scripts/sync-upstream.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const launcher = "hooks/python-launcher.sh";

function run(root: string, script: string): number | null {
  return spawnSync(process.execPath, [resolve(root, "scripts", script)], {
    cwd: root,
    encoding: "utf8",
  }).status;
}

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-token-optimizer-vendor-"));
  await Promise.all([
    cp(resolve(root, "scripts"), resolve(directory, "scripts"), { recursive: true }),
    cp(resolve(root, "vendor"), resolve(directory, "vendor"), { recursive: true }),
    cp(resolve(root, "patches"), resolve(directory, "patches"), { recursive: true }),
  ]);
  return directory;
}

async function expectRejected(root: string, script: string): Promise<void> {
  assert.notEqual(run(root, script), 0, `${script} unexpectedly succeeded`);
}

test("vendor checker validates the pinned tag snapshot and rejects fixture changes", async () => {
  const directory = await fixture();
  const manifestPath = resolve(directory, "vendor/manifest.json");
  const launcherPath = resolve(directory, "vendor/token-optimizer", launcher);
  const extraPath = resolve(directory, "vendor/token-optimizer/unexpected.txt");

  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.deepEqual(manifest.upstream, {
      repository: "https://github.com/alexgreensh/token-optimizer",
      ref: "v5.13.4",
      commit: "eda65d61b4750b530a6f9956193d4e4632aca0cb",
      version: "5.13.4",
    });
    assert.equal(manifest.patch.path, "patches/pi-runtime.patch");
    assert.match(manifest.patch.sha256, /^[a-f0-9]{64}$/);
    assert.equal(manifest.files[launcher].mode, "100755");
    assert.equal(manifest.files[launcher].upstreamSha256, manifest.files[launcher].patchedSha256);
    assert.equal(run(directory, "check-vendor.mjs"), 0);

    const bytes = await readFile(launcherPath);
    await writeFile(launcherPath, Buffer.concat([bytes, Buffer.from("\n")]));
    await expectRejected(directory, "check-vendor.mjs");
    await writeFile(launcherPath, bytes);

    await rm(launcherPath);
    await expectRejected(directory, "check-vendor.mjs");
    await writeFile(launcherPath, bytes, { mode: 0o755 });

    await chmod(launcherPath, 0o644);
    await expectRejected(directory, "check-vendor.mjs");
    await chmod(launcherPath, 0o755);

    await writeFile(extraPath, "unexpected\n");
    await expectRejected(directory, "check-vendor.mjs");
    await rm(extraPath);
    assert.equal(run(directory, "check-vendor.mjs"), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("tag verification is anchored to the tag namespace", () => {
  assert.equal(tagCommitRef("v5.13.4"), "refs/tags/v5.13.4^{commit}");
});

test("manifest replacement leaves an external hard-link target unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-token-optimizer-manifest-"));
  const external = resolve(directory, "external.json");
  const manifest = resolve(directory, "manifest.json");

  try {
    await writeFile(external, "old manifest\n");
    await link(external, manifest);

    await replaceManifest(manifest, Buffer.from("new manifest\n"));

    assert.equal(await readFile(external, "utf8"), "old manifest\n");
    assert.equal(await readFile(manifest, "utf8"), "new manifest\n");
    assert.equal((await stat(manifest)).mode & 0o777, 0o644);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("check rejects symlinked vendor boundaries in disposable fixtures", async () => {
  for (const boundary of ["vendor", "vendor/token-optimizer"]) {
    const directory = await fixture();
    const boundaryPath = resolve(directory, boundary);
    const outside = resolve(directory, "outside", boundary.replaceAll("/", "-"));

    try {
      await mkdir(dirname(outside), { recursive: true });
      await rename(boundaryPath, outside);
      await symlink(outside, boundaryPath, "dir");
      await expectRejected(directory, "check-vendor.mjs");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("package preserves runtime sources without test or cache leakage", async () => {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);

  const packed = JSON.parse(result.stdout)[0].files as Array<{ mode: number; path: string }>;
  const manifest = JSON.parse(await readFile(resolve(root, "vendor/manifest.json"), "utf8"));
  const expected = [
    "vendor/manifest.json",
    ...Object.keys(manifest.files).map((path) => `vendor/token-optimizer/${path}`),
  ].sort();
  const vendored = packed.filter((file) => file.path.startsWith("vendor/")).map((file) => file.path).sort();

  const paths = packed.map((file) => file.path);
  assert.deepEqual(vendored, expected);
  assert.equal(packed.find((file) => file.path === `vendor/token-optimizer/${launcher}`)?.mode, 0o755);
  assert.ok(paths.includes("python/pi_session.py"));
  assert.ok(paths.includes("patches/pi-runtime.patch"));
  assert.equal(paths.some((path) => path.startsWith("tests/")), false);
  assert.equal(paths.some((path) => path.includes("__pycache__") || path.endsWith(".pyc")), false);
});
