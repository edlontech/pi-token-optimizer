import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VENDOR_DIRECTORY = resolve(ROOT, "vendor");
const VENDOR_ROOT = resolve(VENDOR_DIRECTORY, "token-optimizer");
const MANIFEST = resolve(VENDOR_DIRECTORY, "manifest.json");
const PATCH_PATH = "patches/pi-runtime.patch";
const PATCH = resolve(ROOT, PATCH_PATH);
const EXPECTED_UPSTREAM = {
  repository: "https://github.com/alexgreensh/token-optimizer",
  ref: "v5.13.4",
  commit: "eda65d61b4750b530a6f9956193d4e4632aca0cb",
  version: "5.13.4",
};
const EXPECTED_FILE_COUNT = 74;
const CHANGED_FILES = [
  "skills/token-optimizer/scripts/archive_result.py",
  "skills/token-optimizer/scripts/bash_hook.py",
  "skills/token-optimizer/scripts/measure.py",
  "skills/token-optimizer/scripts/runtime_env.py",
];
const REQUIRED_SYMBOLS = {
  "skills/token-optimizer/scripts/archive_result.py": [
    "def archive_result(quiet: bool = False, hook_input: dict | None = None) -> dict | None:",
    "tool_kind = hook_input.get(\"tool_kind\", \"\")",
    "replaceable = \"__\" in tool_name or (injected and tool_kind == \"external\")",
    "\"archive_id\": tool_use_id",
    "\"replacement_text\": replacement",
  ],
  "skills/token-optimizer/scripts/bash_hook.py": [
    "if os.environ.get(\"TOKEN_OPTIMIZER_RUNTIME\", \"\").strip().lower() == \"pi\":",
    "Path(os.environ[\"TOKEN_OPTIMIZER_PI_HOME\"])",
    "Path(os.environ[\"TOKEN_OPTIMIZER_SNAPSHOT_DIR\"])",
    "package_python = script_dir.parents[4] / \"python\"",
    "\"PYTHONPATH\": pythonpath",
  ],
  "skills/token-optimizer/scripts/measure.py": [
    "import pi_session",
    "_FOREIGN_RUNTIMES = frozenset({\"opencode\", \"copilot\", \"hermes\", \"pi\"})",
    "def _use_pi_session_adapter(filepath=None):",
    "def _measure_pi_components():",
    "def _insert_normalized_session(",
    "result = pi_session.parse_session_jsonl(filepath)",
    "_parse_session_jsonl_cache[cache_key] = result",
    "return pi_session.parse_session_turns(filepath)",
    "return pi_session.parse_jsonl_for_quality(filepath)",
    "return pi_session.extract_session_state(",
    "return pi_session.iter_tool_outputs(",
    "DASHBOARD_PATH = RUNTIME_DIR / \"token-optimizer\" / \"dashboard.html\"",
    "mirror_paths.add(RUNTIME_DIR / \"_backups\" / \"token-optimizer\" / \"dashboard.html\")",
    "write_paths.add(RUNTIME_DIR / \"_backups\" / \"token-optimizer\" / \"dashboard.html\")",
    "AND jsonl_path NOT LIKE 'pi:%'",
    "WHERE session_log.incomplete=1\"\"\"",
    "exact_pi_cost = sr[\"platform\"] == \"pi\" and sr[\"cost_source\"] == \"pi_usage\"",
    "if detect_runtime() == \"pi\":\n            return _query_trends_db(conn, days)",
    "result = _collect_trends_from_db(days)",
  ],
  "skills/token-optimizer/scripts/runtime_env.py": [
    "_RUNTIME_PI = \"pi\"",
    "_PI_HOME_ENV = \"TOKEN_OPTIMIZER_PI_HOME\"",
    "def pi_home() -> Path:",
    "raise RuntimeError(f\"{_PI_HOME_ENV} is required for the Pi runtime\")",
    "if runtime == _RUNTIME_PI:",
    "return \"Pi\"",
  ],
};
const REQUIRED_PATHS = [
  "LICENSE",
  "PRIVACY.md",
  "hooks/python-launcher.sh",
  "skills/token-optimizer/assets/dashboard.html",
  "skills/token-optimizer/scripts/archive_result.py",
  "skills/token-optimizer/scripts/bash_compress_hook.py",
  "skills/token-optimizer/scripts/bash_hook.py",
  "skills/token-optimizer/scripts/measure.py",
  "skills/token-optimizer/scripts/read_cache.py",
  "skills/token-optimizer/scripts/runtime_env.py",
  "skills/token-optimizer/scripts/session_store.py",
];

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isWithin(root, path) {
  const pathRelative = relative(root, path);
  return pathRelative === "" || (!pathRelative.startsWith("..") && !isAbsolute(pathRelative));
}

async function assertPhysicalPath(path, label) {
  const physicalRoot = await realpath(ROOT);
  if (!isWithin(ROOT, path)) throw new Error(`${label} escapes the package root`);

  const components = relative(ROOT, path).split("/").filter(Boolean);
  let current = ROOT;
  for (let index = 0; index <= components.length; index += 1) {
    if (index > 0) current = resolve(current, components[index - 1]);
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) throw new Error(`${label} must not traverse a symlink`);
    if (index < components.length && !entry.isDirectory()) throw new Error(`${label} has a non-directory parent`);
    if (!isWithin(physicalRoot, await realpath(current))) throw new Error(`${label} escapes the package root`);
  }
}

async function assertVendorBoundaries() {
  await assertPhysicalPath(VENDOR_DIRECTORY, "vendor");
  await assertPhysicalPath(VENDOR_ROOT, "vendor/token-optimizer");
}

async function filesIn(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`vendored entry must not be a symlink: ${relative(VENDOR_ROOT, path)}`);
    if (entry.isDirectory()) {
      files.push(...await filesIn(path));
    } else if (entry.isFile()) {
      files.push(path);
    } else {
      throw new Error(`vendored entry must be a regular file: ${relative(VENDOR_ROOT, path)}`);
    }
  }
  return files;
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256(path) {
  return hash(await readFile(path));
}

function hasExactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort(comparePaths)) === JSON.stringify([...keys].sort(comparePaths));
}

function assertManifest(manifest) {
  if (!hasExactKeys(manifest, ["upstream", "patch", "protocol", "files"])) {
    throw new Error("manifest must contain exactly upstream, patch, protocol, and files");
  }
  if (JSON.stringify(manifest.upstream) !== JSON.stringify(EXPECTED_UPSTREAM)) {
    throw new Error("manifest upstream pin does not match Token Optimizer v5.13.4");
  }
  if (!hasExactKeys(manifest.protocol, ["version"]) || manifest.protocol.version !== 1) {
    throw new Error("manifest protocol version must be 1");
  }
  if (!hasExactKeys(manifest.patch, ["path", "sha256", "changedFiles", "requiredSymbols"]) ||
    manifest.patch.path !== PATCH_PATH || !/^[a-f0-9]{64}$/.test(manifest.patch.sha256)) {
    throw new Error("invalid manifest patch entry");
  }
  if (JSON.stringify(manifest.patch.changedFiles) !== JSON.stringify(CHANGED_FILES)) {
    throw new Error(`manifest patch must change exactly: ${CHANGED_FILES.join(", ")}`);
  }
  if (JSON.stringify(manifest.patch.requiredSymbols) !== JSON.stringify(REQUIRED_SYMBOLS)) {
    throw new Error("manifest required Pi symbols do not match the compatibility contract");
  }
  if (!manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) {
    throw new Error("manifest files must be an object");
  }
  for (const [path, file] of Object.entries(manifest.files)) {
    if (!path || path.startsWith("/") || path.split("/").includes("..") ||
      !hasExactKeys(file, ["upstreamSha256", "patchedSha256", "mode"]) ||
      !/^[a-f0-9]{64}$/.test(file.upstreamSha256) ||
      !/^[a-f0-9]{64}$/.test(file.patchedSha256) ||
      !["100644", "100755"].includes(file.mode)) {
      throw new Error(`invalid manifest file entry: ${path}`);
    }
  }
}

function patchFiles() {
  const result = spawnSync("git", ["apply", "--numstat", "-z", PATCH], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`cannot inspect ${PATCH_PATH}: ${result.stderr.trim()}`);
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const match = /^(?:\d+|-)\t(?:\d+|-)\t(.+)$/.exec(entry);
      if (!match) throw new Error(`unexpected patch entry: ${entry}`);
      return match[1];
    })
    .sort(comparePaths);
}

function applyReversePatch(directory, check) {
  const args = ["apply", "--reverse", ...(check ? ["--check"] : []), "--whitespace=error-all", PATCH];
  const result = spawnSync("git", args, { cwd: directory, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`reverse patch proof failed: ${result.stderr.trim()}`);
}

async function assertRequiredSymbols(root) {
  for (const [path, symbols] of Object.entries(REQUIRED_SYMBOLS)) {
    const source = await readFile(resolve(root, path), "utf8");
    for (const symbol of symbols) {
      if (!source.includes(symbol)) throw new Error(`patched file is missing required Pi symbol: ${path}: ${symbol}`);
    }
  }
}

function expectedPermissions(mode) {
  return mode === "100755" ? 0o755 : 0o644;
}

async function proveUpstream(manifest, paths) {
  const staging = await mkdtemp(join(tmpdir(), "pi-token-optimizer-proof-"));
  try {
    for (const path of paths) {
      const destination = resolve(staging, path);
      if (!isWithin(staging, destination)) throw new Error(`manifest path escapes proof root: ${path}`);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, await readFile(resolve(VENDOR_ROOT, path)));
      await chmod(destination, expectedPermissions(manifest.files[path].mode));
    }
    applyReversePatch(staging, true);
    applyReversePatch(staging, false);
    for (const path of paths) {
      if (await sha256(resolve(staging, path)) !== manifest.files[path].upstreamSha256) {
        throw new Error(`reverse patch does not reproduce upstream file: ${path}`);
      }
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function checkVendor() {
  await assertVendorBoundaries();
  await assertPhysicalPath(PATCH, "Pi runtime patch");
  const vendorEntries = await readdir(VENDOR_DIRECTORY, { withFileTypes: true });
  const unexpectedVendorEntries = vendorEntries.filter((entry) => entry.name !== "manifest.json" && entry.name !== "token-optimizer");
  if (unexpectedVendorEntries.length > 0) throw new Error(`unexpected vendor entry: ${unexpectedVendorEntries[0].name}`);
  if (!(await lstat(MANIFEST)).isFile()) throw new Error("vendor manifest must be a regular file");
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
  assertManifest(manifest);

  if (await sha256(PATCH) !== manifest.patch.sha256) throw new Error("Pi runtime patch hash does not match manifest");
  if (JSON.stringify(patchFiles()) !== JSON.stringify(CHANGED_FILES)) {
    throw new Error(`patch must change exactly: ${CHANGED_FILES.join(", ")}`);
  }

  const expected = Object.keys(manifest.files).sort(comparePaths);
  const actual = (await filesIn(VENDOR_ROOT)).map((path) => relative(VENDOR_ROOT, path)).sort(comparePaths);
  if (actual.length !== EXPECTED_FILE_COUNT) {
    throw new Error(`vendored file count must be ${EXPECTED_FILE_COUNT}, received ${actual.length}`);
  }
  for (const path of REQUIRED_PATHS) {
    if (!actual.includes(path)) throw new Error(`required vendored file is missing: ${path}`);
  }
  const missing = expected.filter((path) => !actual.includes(path));
  const unexpected = actual.filter((path) => !expected.includes(path));
  if (missing.length > 0) throw new Error(`missing vendored file: ${missing[0]}`);
  if (unexpected.length > 0) throw new Error(`unexpected vendored file: ${unexpected[0]}`);

  const differing = [];
  for (const path of expected) {
    const destination = resolve(VENDOR_ROOT, path);
    if (!isWithin(VENDOR_ROOT, destination)) throw new Error(`manifest path escapes vendor root: ${path}`);
    const file = manifest.files[path];
    if (await sha256(destination) !== file.patchedSha256) throw new Error(`modified vendored file: ${path}`);
    if (((await stat(destination)).mode & 0o777) !== expectedPermissions(file.mode)) {
      throw new Error(`modified vendored mode: ${path}`);
    }
    if (file.upstreamSha256 !== file.patchedSha256) differing.push(path);
  }
  if (JSON.stringify(differing) !== JSON.stringify(CHANGED_FILES)) {
    throw new Error(`patched hashes must differ for exactly: ${CHANGED_FILES.join(", ")}`);
  }

  await assertRequiredSymbols(VENDOR_ROOT);
  await proveUpstream(manifest, expected);
}

async function isMainModule() {
  if (!process.argv[1]) return false;
  return (await realpath(resolve(process.argv[1]))) === await realpath(fileURLToPath(import.meta.url));
}

if (await isMainModule()) {
  checkVendor()
    .then(() => console.log("Vendored Token Optimizer snapshot is valid."))
    .catch((error) => {
      console.error(`Vendor check failed: ${error.message}`);
      process.exitCode = 1;
    });
}
