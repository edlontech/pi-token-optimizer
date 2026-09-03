import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VENDOR_DIRECTORY = resolve(ROOT, "vendor");
const VENDOR_ROOT = resolve(VENDOR_DIRECTORY, "token-optimizer");
const MANIFEST = resolve(VENDOR_DIRECTORY, "manifest.json");
const EXPECTED_UPSTREAM = {
  repository: "https://github.com/alexgreensh/token-optimizer",
  ref: "v5.13.4",
  commit: "eda65d61b4750b530a6f9956193d4e4632aca0cb",
  version: "5.13.4",
};
const EXPECTED_FILE_COUNT = 74;
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

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function assertManifest(manifest) {
  if (!manifest || typeof manifest !== "object") throw new Error("manifest must be an object");
  if (JSON.stringify(manifest.upstream) !== JSON.stringify(EXPECTED_UPSTREAM)) {
    throw new Error("manifest upstream pin does not match Token Optimizer v5.13.4");
  }
  if (!manifest.protocol || manifest.protocol.version !== 1) throw new Error("manifest protocol version must be 1");
  if (!manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) {
    throw new Error("manifest files must be an object");
  }
  for (const [path, file] of Object.entries(manifest.files)) {
    if (!path || path.startsWith("/") || path.split("/").includes("..") || !file || typeof file !== "object" ||
      !/^[a-f0-9]{64}$/.test(file.sha256) || !["100644", "100755"].includes(file.mode)) {
      throw new Error(`invalid manifest file entry: ${path}`);
    }
  }
}

function expectedPermissions(mode) {
  return mode === "100755" ? 0o755 : 0o644;
}

export async function checkVendor() {
  await assertVendorBoundaries();
  const vendorEntries = await readdir(VENDOR_DIRECTORY, { withFileTypes: true });
  const unexpectedVendorEntries = vendorEntries.filter((entry) => entry.name !== "manifest.json" && entry.name !== "token-optimizer");
  if (unexpectedVendorEntries.length > 0) throw new Error(`unexpected vendor entry: ${unexpectedVendorEntries[0].name}`);
  if (!(await lstat(MANIFEST)).isFile()) throw new Error("vendor manifest must be a regular file");
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
  assertManifest(manifest);

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

  for (const path of expected) {
    const destination = resolve(VENDOR_ROOT, path);
    if (!isWithin(VENDOR_ROOT, destination)) throw new Error(`manifest path escapes vendor root: ${path}`);
    const file = manifest.files[path];
    if (await sha256(destination) !== file.sha256) throw new Error(`modified vendored file: ${path}`);
    if (((await stat(destination)).mode & 0o777) !== expectedPermissions(file.mode)) {
      throw new Error(`modified vendored mode: ${path}`);
    }
  }
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
