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

const releaseFiles = [
  "LICENSE",
  "NOTICE",
  "PRIVACY.md",
  "README.md",
  "docs/capabilities.md",
  "docs/release-checklist.md",
  "extensions/index.ts",
  "package.json",
  "patches/pi-runtime.patch",
  "python/__init__.py",
  "python/pi_bridge.py",
  "python/pi_session.py",
  "src/adapter.ts",
  "src/bridge.ts",
  "src/commands.ts",
  "src/compaction.ts",
  "src/config.ts",
  "src/protocol.ts",
  "vendor/manifest.json",
  "vendor/token-optimizer/LICENSE",
  "vendor/token-optimizer/PRIVACY.md",
  "vendor/token-optimizer/hooks/python-launcher.sh",
  "vendor/token-optimizer/skills/token-optimizer/assets/dashboard.html",
  "vendor/token-optimizer/skills/token-optimizer/scripts/activity_tracker.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/archive_result.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/bash_compress.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/bash_compress_hook.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/bash_hook.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/benchmark.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/codex_compact_prompt.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/codex_doctor.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/codex_hook_bridge.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/codex_install.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/codex_io.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/codex_session.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/codex_state.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/codex_statusline.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/command_filters.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/compression_backfill.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/compression_log.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/context_intel.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/context_pressure.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/copilot_doctor.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/copilot_hook_bridge.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/copilot_install.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/copilot_session.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/copilot_state.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/copilot_vscode.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/cowork_doctor.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/cowork_install.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/credential_patterns.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/delta_diff.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/detectors/__init__.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/detectors/bad_decomposition.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/detectors/cache_instability.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/detectors/looping.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/detectors/output_waste.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/detectors/overpowered.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/detectors/pdf_ingestion.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/detectors/registry.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/detectors/respond_to_bash.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/detectors/retry_churn.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/detectors/tool_cascade.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/detectors/wasteful_thinking.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/detectors/weak_model.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/detectors/websearch_routing.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/hermes_doctor.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/hermes_hook_bridge.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/hermes_install.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/hermes_session.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/hermes_state.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/hook_io.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/hook_runtime.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/injection.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/install_reconcile.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/measure.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/outline.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/pipeline_analyzer.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/plugin_env.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/quality_cache_gate.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/read_cache.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/refetch_fingerprint.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/refetch_guard.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/routing_advisor.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/runtime_env.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/session_store.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/spawn_utils.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/statusline.js",
  "vendor/token-optimizer/skills/token-optimizer/scripts/structure_map.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/structure_map_ts.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/structure_replay.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/token_estimate.py",
  "vendor/token-optimizer/skills/token-optimizer/scripts/utf8_io.py",
].sort();

test("package tarball matches the exact release allowlist and metadata contract", async () => {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);

  const packed = JSON.parse(result.stdout)[0].files as Array<{ mode: number; path: string }>;
  const paths = packed.map((file) => file.path).sort();
  assert.deepEqual(paths, releaseFiles);
  assert.equal(packed.find((file) => file.path === `vendor/token-optimizer/${launcher}`)?.mode, 0o755);
  for (const required of ["LICENSE", "NOTICE", "PRIVACY.md", "README.md", "docs/capabilities.md", "docs/release-checklist.md"]) {
    assert.ok(paths.includes(required), required);
  }
  assert.equal(paths.some((path) => /(^|\/)(__pycache__|\.cache|data)(\/|$)|\.pyc$/.test(path)), false);
  assert.equal(paths.some((path) => /^(tests|scripts|skills|benchmarks?|fixtures|\.github)\//.test(path)), false);
  assert.equal(paths.some((path) => /^vendor\/token-optimizer\/(demos?|tests?|benchmarks?|\.claude-plugin)\//.test(path)), false);

  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  assert.equal(packageJson.name, "@edlontech/pi-token-optimizer");
  assert.equal(packageJson.version, "0.1.0");
  assert.equal(packageJson.license, "PolyForm-Noncommercial-1.0.0");
  assert.deepEqual(packageJson.engines, { node: ">=22.19.0" });
  assert.deepEqual(packageJson.publishConfig, { access: "public" });
  assert.equal(packageJson.devDependencies["@earendil-works/pi-coding-agent"], "0.84.4");
  assert.equal(packageJson.dependencies, undefined);
  assert.deepEqual(packageJson.peerDependencies, {
    "@earendil-works/pi-agent-core": "*",
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    typebox: "*",
  });
});
