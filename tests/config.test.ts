import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CONFIG_SCHEMA_VERSION,
  CONSENT_NOTICE_VERSION,
  createConfigStore,
} from "../src/config.ts";

async function tempAgentDir(t: test.TestContext): Promise<string> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "pi-token-optimizer-config-")));
  const agentDir = join(parent, "agent");
  await mkdir(agentDir);
  t.after(() => rm(parent, { recursive: true, force: true }));
  return agentDir;
}

async function writeRawConfig(agentDir: string, value: unknown): Promise<string> {
  const root = join(agentDir, "token-optimizer");
  await mkdir(root);
  const path = join(root, "config.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}

test("missing configuration returns safe defaults without writing", async (t) => {
  const agentDir = await tempAgentDir(t);
  const config = await createConfigStore(agentDir).load();

  assert.deepEqual(config, {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    enabled: true,
    consent: { granted: false, noticeVersion: CONSENT_NOTICE_VERSION },
  });
  await assert.rejects(stat(join(agentDir, "token-optimizer")), { code: "ENOENT" });
});

test("loads current consent and migrates stale or partial configuration in memory", async (t) => {
  const agentDir = await tempAgentDir(t);
  const configPath = await writeRawConfig(agentDir, {
    schemaVersion: 0,
    enabled: false,
    consent: { granted: true, noticeVersion: 0, grantedAt: "2026-01-01T00:00:00.000Z" },
  });
  const before = await readFile(configPath, "utf8");

  assert.deepEqual(await createConfigStore(agentDir).load(), {
    schemaVersion: 1,
    enabled: false,
    consent: { granted: false, noticeVersion: 1 },
  });
  assert.equal(await readFile(configPath, "utf8"), before);

  await writeFile(configPath, JSON.stringify({
    schemaVersion: 1,
    consent: { granted: true, noticeVersion: 1, grantedAt: "2026-09-03T12:00:00.000Z" },
  }));
  assert.deepEqual(await createConfigStore(agentDir).load(), {
    schemaVersion: 1,
    enabled: true,
    consent: {
      granted: true,
      noticeVersion: 1,
      grantedAt: "2026-09-03T12:00:00.000Z",
    },
  });
});

test("rejects malformed config instead of silently granting activity collection", async (t) => {
  const agentDir = await tempAgentDir(t);
  const configPath = await writeRawConfig(agentDir, "not an object");
  await assert.rejects(createConfigStore(agentDir).load(), /config/i);

  await writeFile(configPath, "{");
  await assert.rejects(createConfigStore(agentDir).load(), /config/i);
});

test("fails closed on unknown future config schemas", async (t) => {
  const agentDir = await tempAgentDir(t);
  await writeRawConfig(agentDir, {
    schemaVersion: CONFIG_SCHEMA_VERSION + 1,
    enabled: true,
    consent: {
      granted: true,
      noticeVersion: CONSENT_NOTICE_VERSION,
      grantedAt: "2026-09-03T12:00:00.000Z",
    },
  });

  await assert.rejects(createConfigStore(agentDir).load(), /schema version/i);
});

test("saves by private atomic replacement and round trips state", async (t) => {
  const agentDir = await tempAgentDir(t);
  const store = createConfigStore(agentDir);
  const first = {
    schemaVersion: 1 as const,
    enabled: true,
    consent: { granted: false, noticeVersion: 1 as const },
  };
  await store.save(first);

  const root = join(agentDir, "token-optimizer");
  const configPath = join(root, "config.json");
  const firstStat = await stat(configPath);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal(firstStat.mode & 0o777, 0o600);

  const second = {
    schemaVersion: 1 as const,
    enabled: false,
    consent: {
      granted: true,
      noticeVersion: 1 as const,
      grantedAt: "2026-09-03T12:00:00.000Z",
    },
  };
  await store.save(second);

  assert.notEqual((await stat(configPath)).ino, firstStat.ino);
  assert.deepEqual(await store.load(), second);
  assert.deepEqual(await readdir(root), ["config.json"]);
});

test("rejects invalid configuration on save", async (t) => {
  const agentDir = await tempAgentDir(t);
  const store = createConfigStore(agentDir);

  await assert.rejects(store.save({
    schemaVersion: 1,
    enabled: true,
    consent: { granted: true, noticeVersion: 1, grantedAt: "not-a-date" },
  }), /config/i);
  await assert.rejects(store.save({
    schemaVersion: 1,
    enabled: true,
    consent: { granted: true, noticeVersion: 2 },
  } as never), /config/i);
  await assert.rejects(stat(join(agentDir, "token-optimizer")), { code: "ENOENT" });
});

test("save refuses a missing Pi agent directory", async (t) => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "pi-token-optimizer-missing-agent-")));
  const agentDir = join(parent, "missing-agent");
  t.after(() => rm(parent, { recursive: true, force: true }));

  await assert.rejects(createConfigStore(agentDir).save({
    schemaVersion: 1,
    enabled: true,
    consent: { granted: false, noticeVersion: 1 },
  }), /agent directory|ENOENT/i);
  await assert.rejects(stat(agentDir), { code: "ENOENT" });
});

test("save does not create a missing child through a symlinked ancestor", async (t) => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "pi-token-optimizer-symlink-ancestor-")));
  const outside = join(parent, "outside");
  const linked = join(parent, "linked");
  const agentDir = join(linked, "missing-agent");
  t.after(() => rm(parent, { recursive: true, force: true }));
  await mkdir(outside);
  await symlink(outside, linked);

  await assert.rejects(createConfigStore(agentDir).save({
    schemaVersion: 1,
    enabled: true,
    consent: { granted: false, noticeVersion: 1 },
  }), /agent directory|ENOENT/i);
  await assert.rejects(stat(join(outside, "missing-agent")), { code: "ENOENT" });
});

test("purge preview reports count and bytes without mutation", async (t) => {
  const agentDir = await tempAgentDir(t);
  const root = join(agentDir, "token-optimizer");
  await mkdir(join(root, "data"), { recursive: true });
  await writeFile(join(root, "config.json"), "12345");
  await writeFile(join(root, "data", "state.db"), "1234567");

  const preview = await createConfigStore(agentDir).previewPurge();

  assert.deepEqual(preview, { root, count: 2, bytes: 12 });
  assert.equal(await readFile(join(root, "data", "state.db"), "utf8"), "1234567");
});

test("purge deletes only the exact optimizer child and leaves Pi sessions untouched", async (t) => {
  const agentDir = await tempAgentDir(t);
  const root = join(agentDir, "token-optimizer");
  const sessions = join(agentDir, "sessions");
  await mkdir(join(root, "data"), { recursive: true });
  await mkdir(sessions);
  await writeFile(join(root, "data", "state.db"), "optimizer");
  await writeFile(join(sessions, "session.jsonl"), "pi session");

  assert.deepEqual(await createConfigStore(agentDir).purgeData(), {
    root,
    count: 1,
    bytes: 9,
    purged: true,
  });
  await assert.rejects(stat(root), { code: "ENOENT" });
  assert.equal(await readFile(join(sessions, "session.jsonl"), "utf8"), "pi session");
});

test("purge is a no-op when the optimizer root does not exist", async (t) => {
  const agentDir = await tempAgentDir(t);
  const root = join(agentDir, "token-optimizer");

  assert.deepEqual(await createConfigStore(agentDir).previewPurge(), { root, count: 0, bytes: 0 });
  assert.deepEqual(await createConfigStore(agentDir).purgeData(), {
    root,
    count: 0,
    bytes: 0,
    purged: false,
  });
});

test("refuses symlinked optimizer and agent roots", async (t) => {
  const agentDir = await tempAgentDir(t);
  const outside = join(agentDir, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "keep"), "safe");
  await symlink(outside, join(agentDir, "token-optimizer"));

  const store = createConfigStore(agentDir);
  await assert.rejects(store.previewPurge(), /symlink/i);
  await assert.rejects(store.purgeData(), /symlink/i);
  assert.equal(await readFile(join(outside, "keep"), "utf8"), "safe");

  const parent = join(agentDir, "parent");
  const realAgent = join(parent, "real-agent");
  const linkedAgent = join(parent, "linked-agent");
  await mkdir(realAgent, { recursive: true });
  await symlink(realAgent, linkedAgent);
  await assert.rejects(createConfigStore(linkedAgent).previewPurge(), /symlink|resolve/i);
});

test("refuses dangerous or invalid deletion roots", () => {
  assert.throws(() => createConfigStore(""), /agent directory/i);
  assert.throws(() => createConfigStore("/"), /agent directory/i);
});

test("does not follow a descendant symlink into Pi sessions", async (t) => {
  const agentDir = await tempAgentDir(t);
  const root = join(agentDir, "token-optimizer");
  const sessions = join(agentDir, "sessions");
  await mkdir(root);
  await mkdir(sessions);
  await writeFile(join(sessions, "session.jsonl"), "pi session");
  await symlink(sessions, join(root, "sessions-link"));

  const preview = await createConfigStore(agentDir).previewPurge();
  assert.equal(preview.count, 1);
  await createConfigStore(agentDir).purgeData();

  assert.equal(await readFile(join(sessions, "session.jsonl"), "utf8"), "pi session");
  assert.equal((await lstat(sessions)).isDirectory(), true);
});
