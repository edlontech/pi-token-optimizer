import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, cp, link, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
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

async function sourceFiles(
  directory: string,
  accepts: (name: string) => boolean,
): Promise<string[]> {
  const sources: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) sources.push(...await sourceFiles(path, accepts));
    else if (entry.isFile() && accepts(entry.name)) sources.push(path);
  }
  return sources;
}

function typescriptTestNames(source: string, file: string): Set<string> {
  const diagnostics = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.Latest },
  }).diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ?? [];
  assert.equal(
    diagnostics.length,
    0,
    diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")).join("\n"),
  );
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "test"
      && ts.isStringLiteral(node.arguments[0])
    ) names.add(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return names;
}

const pythonEvidenceScript = String.raw`
import ast
import json
import sys

names = set()
for path in sys.argv[1:]:
    with open(path, "r", encoding="utf-8") as handle:
        tree = ast.parse(handle.read(), filename=path)
    unittest_aliases = {
        alias.asname or alias.name
        for node in tree.body
        if isinstance(node, ast.Import)
        for alias in node.names
        if alias.name == "unittest"
    }
    testcase_aliases = {
        alias.asname or alias.name
        for node in tree.body
        if isinstance(node, ast.ImportFrom) and node.module == "unittest"
        for alias in node.names
        if alias.name == "TestCase"
    }
    classes = {
        node.name: node
        for node in tree.body
        if isinstance(node, ast.ClassDef)
    }
    test_cases = {
        name
        for name, node in classes.items()
        if any(
            isinstance(base, ast.Name) and base.id in testcase_aliases
            or isinstance(base, ast.Attribute)
            and base.attr == "TestCase"
            and isinstance(base.value, ast.Name)
            and base.value.id in unittest_aliases
            for base in node.bases
        )
    }
    changed = True
    while changed:
        changed = False
        for name, node in classes.items():
            if name not in test_cases and any(
                isinstance(base, ast.Name) and base.id in test_cases
                for base in node.bases
            ):
                test_cases.add(name)
                changed = True
    for name in test_cases:
        for node in classes[name].body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("test_"):
                names.add(node.name)
print(json.dumps(sorted(names)))
`;

function pythonTestNames(sources: string[]): Set<string> {
  const result = spawnSync(process.env.PYTHON ?? "python3", ["-I", "-c", pythonEvidenceScript, ...sources], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message || "Python AST parser failed");
  const parsed: unknown = JSON.parse(result.stdout);
  assert.ok(Array.isArray(parsed) && parsed.every((name) => typeof name === "string"));
  return new Set(parsed);
}

async function testEvidence(): Promise<{ typescript: Set<string>; python: Set<string> }> {
  const typescript = new Set<string>();
  for (const source of await sourceFiles(resolve(root, "tests"), (name) => name.endsWith(".test.ts"))) {
    for (const name of typescriptTestNames(await readFile(source, "utf8"), source)) typescript.add(name);
  }
  const pythonSources = await sourceFiles(
    resolve(root, "tests/python"),
    (name) => name.startsWith("test_") && name.endsWith(".py"),
  );
  return { typescript, python: pythonTestNames(pythonSources) };
}

function capabilityRows(markdown: string): Array<{ status: string; evidence: string }> {
  const lines = markdown.split("\n");
  const header = lines.indexOf("| Capability | Status | Evidence |");
  assert.notEqual(header, -1, "capability table header is missing");
  assert.equal(lines[header + 1], "| --- | --- | --- |", "capability table separator is malformed");
  const rows: Array<{ status: string; evidence: string }> = [];
  for (const line of lines.slice(header + 2)) {
    if (!line) break;
    const match = /^\| ([^|]+) \| (Supported|Adapted|Deferred|Unavailable) \| ([^|]+) \|$/.exec(line);
    assert.ok(match, `malformed capability row: ${line}`);
    rows.push({ status: match[2], evidence: match[3] });
  }
  assert.ok(rows.length > 0, "capability table has no rows");
  return rows;
}

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

test("capability rows cite exact automated or manual release evidence", async () => {
  const capabilities = await readFile(resolve(root, "docs/capabilities.md"), "utf8");
  const checklist = await readFile(resolve(root, "docs/release-checklist.md"), "utf8");
  const automated = await testEvidence();
  const manual = new Set([...checklist.matchAll(/^- \[ \] \*\*([^*]+)\*\*/gm)].map((match) => match[1]));
  const rows = capabilityRows(capabilities);
  const syntaxFixture = await mkdtemp(join(tmpdir(), "pi-token-evidence-"));

  try {
    const typescriptNames = typescriptTestNames(`
      // test("commented TypeScript evidence", () => {});
      const deadText = 'test("dead TypeScript text", () => {})';
      test("actual TypeScript evidence", () => {});
    `, "evidence.test.ts");
    assert.deepEqual(typescriptNames, new Set(["actual TypeScript evidence"]));
    assert.throws(() => typescriptTestNames("test(\"malformed\",", "malformed.test.ts"));

    const pythonFixture = resolve(syntaxFixture, "test_evidence.py");
    const malformedPython = resolve(syntaxFixture, "test_malformed.py");
    await writeFile(pythonFixture, `
from unittest import TestCase as ImportedCase

class RealEvidence(ImportedCase):
    def test_actual_python_evidence(self):
        pass

class ChildEvidence(RealEvidence):
    async def test_child_python_evidence(self):
        pass

class Unrelated:
    def test_unrelated_python_name(self):
        pass

class TestCase:
    pass

class Pretender(TestCase):
    def test_unimported_testcase_name(self):
        pass

# def test_commented_python_name(self):
#     pass
DEAD_TEXT = "def test_dead_python_text(self): pass"
`);
    await writeFile(malformedPython, "class Broken(\n");
    assert.deepEqual(
      pythonTestNames([pythonFixture]),
      new Set(["test_actual_python_evidence", "test_child_python_evidence"]),
    );
    assert.throws(() => pythonTestNames([malformedPython]));
  } finally {
    await rm(syntaxFixture, { recursive: true, force: true });
  }

  assert.throws(() => capabilityRows("| Capability | Status | Evidence |\n| -- | --- | --- |\n"));
  assert.throws(() => capabilityRows("| Capability | Status | Evidence |\n| --- | --- | --- |\n| malformed |\n"));
  assert.deepEqual(new Set(rows.map(({ status }) => status)), new Set(["Supported", "Adapted", "Deferred", "Unavailable"]));
  assert.doesNotMatch(capabilities, /full parity|complete parity|all upstream capabilities/i);
  for (const { evidence } of rows) {
    const match = /^(Automated test|Python unittest|Manual checklist item): `([^`]+)`$/.exec(evidence);
    assert.ok(match, `invalid capability evidence: ${evidence}`);
    const available = match[1] === "Automated test"
      ? automated.typescript
      : match[1] === "Python unittest"
        ? automated.python
        : manual;
    assert.equal(available.has(match[2]), true, match[2]);
  }
});
