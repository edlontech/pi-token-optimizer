import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VENDOR_DIRECTORY = resolve(ROOT, "vendor");
const VENDOR_ROOT = resolve(VENDOR_DIRECTORY, "token-optimizer");
const MANIFEST = resolve(VENDOR_DIRECTORY, "manifest.json");
const PATCH_PATH = "patches/pi-runtime.patch";
const PATCH = resolve(ROOT, PATCH_PATH);
const SNAPSHOT = {
  repository: "https://github.com/alexgreensh/token-optimizer",
  identity: "github.com/alexgreensh/token-optimizer",
  ref: "v5.13.4",
  commit: "eda65d61b4750b530a6f9956193d4e4632aca0cb",
  version: "5.13.4",
};
const FIXED_PATHS = [
  "LICENSE",
  "PRIVACY.md",
  "hooks/python-launcher.sh",
  "skills/token-optimizer/assets/dashboard.html",
];
const SCRIPTS_ROOT = "skills/token-optimizer/scripts/";
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
const MANIFEST_MODE = 0o644;

function git(source, args) {
  const result = spawnSync("git", ["-C", source, ...args], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function gitBlob(source, object) {
  const result = spawnSync("git", ["-C", source, "cat-file", "blob", object], { maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git cat-file blob ${object} failed: ${result.stderr.toString().trim()}`);
  return result.stdout;
}

function applyPatch(directory, reverse = false) {
  const directoryFromRoot = relative(ROOT, directory);
  if (!directoryFromRoot || !isWithin(ROOT, directory)) throw new Error("patch staging directory escapes the package root");
  const direction = reverse ? ["--reverse"] : [];
  for (const check of [true, false]) {
    const args = [
      "apply",
      ...(check ? ["--check"] : []),
      "--whitespace=error-all",
      `--directory=${directoryFromRoot}`,
      ...direction,
      PATCH,
    ];
    const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
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

export function tagCommitRef(tag) {
  return `refs/tags/${tag}^{commit}`;
}

export async function replaceManifest(manifest, bytes) {
  const temporary = resolve(dirname(manifest), `.manifest-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: MANIFEST_MODE });
    await chmod(temporary, MANIFEST_MODE);
    await rename(temporary, manifest);
  } finally {
    await rm(temporary, { force: true });
  }
}

function repositoryIdentity(url) {
  return url
    .trim()
    .replace(/^[a-z]+:\/\/(?:[^@/]+@)?/i, "")
    .replace(/^[^@/:]+@/, "")
    .replace(":", "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/, "")
    .toLowerCase();
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isWithin(root, path) {
  const pathRelative = relative(root, path);
  return pathRelative === "" || (!pathRelative.startsWith("..") && !isAbsolute(pathRelative));
}

async function assertPhysicalPath(path, label, allowMissing = false) {
  const physicalRoot = await realpath(ROOT);
  if (!isWithin(ROOT, path)) throw new Error(`${label} escapes the package root`);

  const components = relative(ROOT, path).split("/").filter(Boolean);
  let current = ROOT;
  for (let index = 0; index <= components.length; index += 1) {
    if (index > 0) current = resolve(current, components[index - 1]);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) throw new Error(`${label} must not traverse a symlink`);
      if (index < components.length && !entry.isDirectory()) throw new Error(`${label} has a non-directory parent`);
      if (!isWithin(physicalRoot, await realpath(current))) throw new Error(`${label} escapes the package root`);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT" && allowMissing) return;
      throw error;
    }
  }
}

async function assertVendorBoundaries() {
  await assertPhysicalPath(VENDOR_DIRECTORY, "vendor");
  await assertPhysicalPath(VENDOR_ROOT, "vendor/token-optimizer", true);
}

async function assertWritePath(path, label) {
  await assertPhysicalPath(path, label, true);
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
  }
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseTree(source) {
  const entries = git(source, ["ls-tree", "-r", "-z", SNAPSHOT.commit, "--", ...FIXED_PATHS, "skills/token-optimizer/scripts"])
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const match = /^(100644|100755) blob ([0-9a-f]{40,64})\t(.+)$/.exec(entry);
      if (!match) throw new Error(`unexpected upstream tree entry: ${entry}`);
      const [, mode, blob, path] = match;
      if (!FIXED_PATHS.includes(path) && !path.startsWith(SCRIPTS_ROOT)) {
        throw new Error(`upstream tree entry is outside the approved closure: ${path}`);
      }
      return { blob, mode, path };
    });
  if (!entries.some((entry) => entry.path.startsWith(SCRIPTS_ROOT))) {
    throw new Error("pinned snapshot has no token optimizer runtime scripts");
  }
  for (const path of FIXED_PATHS) {
    if (!entries.some((entry) => entry.path === path)) throw new Error(`pinned snapshot is missing ${path}`);
  }
  return entries.sort((left, right) => comparePaths(left.path, right.path));
}

async function verifySource(source) {
  const checkout = await realpath(source);
  const gitRoot = await realpath(git(checkout, ["rev-parse", "--show-toplevel"]));
  if (checkout !== gitRoot) throw new Error("source must be the root of a Git checkout");
  if (repositoryIdentity(git(checkout, ["remote", "get-url", "origin"])) !== SNAPSHOT.identity) {
    throw new Error(`source origin must identify ${SNAPSHOT.repository}`);
  }
  if (git(checkout, ["rev-parse", tagCommitRef(SNAPSHOT.ref)]) !== SNAPSHOT.commit) {
    throw new Error(`${SNAPSHOT.ref} tag must resolve to ${SNAPSHOT.commit}`);
  }
  if (git(checkout, ["rev-parse", `${SNAPSHOT.commit}^{commit}`]) !== SNAPSHOT.commit) {
    throw new Error(`pinned commit must resolve to ${SNAPSHOT.commit}`);
  }
  const plugin = JSON.parse(git(checkout, ["show", `${SNAPSHOT.commit}:.claude-plugin/plugin.json`]));
  if (plugin.version !== SNAPSHOT.version) throw new Error(`source plugin version must be ${SNAPSHOT.version}`);
  return checkout;
}

function assertExpectedPatchFiles() {
  const actual = patchFiles();
  if (JSON.stringify(actual) !== JSON.stringify(CHANGED_FILES)) {
    throw new Error(`patch must change exactly: ${CHANGED_FILES.join(", ")}`);
  }
}

async function assertRequiredSymbols(root) {
  for (const [path, symbols] of Object.entries(REQUIRED_SYMBOLS)) {
    const source = await readFile(resolve(root, path), "utf8");
    for (const symbol of symbols) {
      if (!source.includes(symbol)) throw new Error(`patched file is missing required Pi symbol: ${path}: ${symbol}`);
    }
  }
}

export async function syncUpstream(source) {
  const checkout = await verifySource(source);
  const files = parseTree(checkout);
  await assertPhysicalPath(PATCH, "Pi runtime patch");
  assertExpectedPatchFiles();
  await assertVendorBoundaries();

  const staging = resolve(VENDOR_DIRECTORY, `.token-optimizer-${randomUUID()}.tmp`);
  await assertWritePath(staging, "vendor staging directory");
  await mkdir(staging, { mode: 0o755 });

  try {
    const manifestFiles = {};
    for (const file of files) {
      const destination = resolve(staging, file.path);
      if (!isWithin(staging, destination)) throw new Error(`upstream path escapes vendor root: ${file.path}`);
      await mkdir(dirname(destination), { recursive: true });
      const bytes = gitBlob(checkout, `${SNAPSHOT.commit}:${file.path}`);
      await writeFile(destination, bytes);
      await chmod(destination, file.mode === "100755" ? 0o755 : 0o644);
      manifestFiles[file.path] = { upstreamSha256: hash(bytes), patchedSha256: "", mode: file.mode };
    }

    applyPatch(staging);
    await assertRequiredSymbols(staging);

    const changed = [];
    for (const file of files) {
      const destination = resolve(staging, file.path);
      const patchedSha256 = hash(await readFile(destination));
      manifestFiles[file.path].patchedSha256 = patchedSha256;
      if (manifestFiles[file.path].upstreamSha256 !== patchedSha256) changed.push(file.path);
      const mode = (await stat(destination)).mode & 0o777;
      const expectedMode = file.mode === "100755" ? 0o755 : 0o644;
      if (mode !== expectedMode) throw new Error(`patch changed vendored mode: ${file.path}`);
    }
    if (JSON.stringify(changed) !== JSON.stringify(CHANGED_FILES)) {
      throw new Error(`patched hashes must differ for exactly: ${CHANGED_FILES.join(", ")}`);
    }

    const patchSha256 = hash(await readFile(PATCH));
    const manifestBytes = Buffer.from(`${JSON.stringify({
      upstream: {
        repository: SNAPSHOT.repository,
        ref: SNAPSHOT.ref,
        commit: SNAPSHOT.commit,
        version: SNAPSHOT.version,
      },
      patch: {
        path: PATCH_PATH,
        sha256: patchSha256,
        changedFiles: CHANGED_FILES,
        requiredSymbols: REQUIRED_SYMBOLS,
      },
      protocol: { version: 1 },
      files: manifestFiles,
    }, null, 2)}\n`);

    await assertVendorBoundaries();
    await assertWritePath(MANIFEST, "vendor manifest");
    const backup = resolve(VENDOR_DIRECTORY, `.token-optimizer-${randomUUID()}.backup`);
    await assertWritePath(backup, "vendor backup directory");
    let hadVendor = true;
    try {
      await rename(VENDOR_ROOT, backup);
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
      hadVendor = false;
    }
    let installed = false;
    try {
      await rename(staging, VENDOR_ROOT);
      installed = true;
      await assertVendorBoundaries();
      await replaceManifest(MANIFEST, manifestBytes);
    } catch (error) {
      try {
        if (installed) await rm(VENDOR_ROOT, { recursive: true, force: true });
        if (hadVendor) await rename(backup, VENDOR_ROOT);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "vendor replacement and rollback failed");
      }
      throw error;
    }
    if (hadVendor) await rm(backup, { recursive: true });
    return { files: files.length, changedFiles: changed.length };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function isMainModule() {
  if (!process.argv[1]) return false;
  return (await realpath(resolve(process.argv[1]))) === await realpath(fileURLToPath(import.meta.url));
}

if (await isMainModule()) {
  const source = process.argv[2];
  if (!source || process.argv.length !== 3) {
    console.error("Usage: node scripts/sync-upstream.mjs <source-checkout>");
    process.exitCode = 1;
  } else {
    syncUpstream(resolve(process.cwd(), source))
      .then(({ files, changedFiles }) => console.log(`Synced ${files} vendored files (${changedFiles} patched).`))
      .catch((error) => {
        console.error(`Upstream sync failed: ${error.message}`);
        process.exitCode = 1;
      });
  }
}
