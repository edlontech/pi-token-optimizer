import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VENDOR_DIRECTORY = resolve(ROOT, "vendor");
const VENDOR_ROOT = resolve(VENDOR_DIRECTORY, "token-optimizer");
const MANIFEST = resolve(VENDOR_DIRECTORY, "manifest.json");
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

export async function syncUpstream(source) {
  const checkout = await verifySource(source);
  const files = parseTree(checkout);
  await assertVendorBoundaries();
  await rm(VENDOR_ROOT, { recursive: true, force: true });

  const manifestFiles = {};
  for (const file of files) {
    const destination = resolve(VENDOR_ROOT, file.path);
    if (!isWithin(VENDOR_ROOT, destination)) throw new Error(`upstream path escapes vendor root: ${file.path}`);
    await assertVendorBoundaries();
    await mkdir(dirname(destination), { recursive: true });
    await assertVendorBoundaries();
    await assertWritePath(destination, `vendored file ${file.path}`);
    const bytes = gitBlob(checkout, `${SNAPSHOT.commit}:${file.path}`);
    await writeFile(destination, bytes);
    await chmod(destination, file.mode === "100755" ? 0o755 : 0o644);
    manifestFiles[file.path] = { sha256: hash(bytes), mode: file.mode };
  }

  await assertVendorBoundaries();
  await assertWritePath(MANIFEST, "vendor manifest");
  await replaceManifest(MANIFEST, Buffer.from(`${JSON.stringify({
    upstream: {
      repository: SNAPSHOT.repository,
      ref: SNAPSHOT.ref,
      commit: SNAPSHOT.commit,
      version: SNAPSHOT.version,
    },
    protocol: { version: 1 },
    files: manifestFiles,
  }, null, 2)}\n`));
  return { files: files.length };
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
      .then(({ files }) => console.log(`Synced ${files} vendored files.`))
      .catch((error) => {
        console.error(`Upstream sync failed: ${error.message}`);
        process.exitCode = 1;
      });
  }
}
