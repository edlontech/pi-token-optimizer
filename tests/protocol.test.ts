import assert from "node:assert/strict";
import test from "node:test";

import {
  BRIDGE_ACTIONS,
  MAX_DESCRIPTOR_STRING_BYTES,
  MAX_ID_LENGTH,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  PROTOCOL_VERSION,
  isBridgeRequest,
  isBridgeResponse,
  validateBridgeRequest,
  validateBridgeResponse,
} from "../src/protocol.ts";

const session = { id: "session-1", cwd: "/tmp/project", file: "/tmp/session.jsonl" };
const tool = {
  id: "tool-1",
  name: "bash",
  kind: "builtin" as const,
  input: { command: "printf ok" },
};

const validRequestByAction = {
  status: { protocolVersion: 1, action: "status", session },
  doctor: { protocolVersion: 1, action: "doctor", session },
  pre_tool: { protocolVersion: 1, action: "pre_tool", session, tool },
  post_tool: {
    protocolVersion: 1,
    action: "post_tool",
    session,
    tool,
    args: { text: "ok", isError: false, hasImages: false },
  },
  before_prompt: {
    protocolVersion: 1,
    action: "before_prompt",
    session,
    args: { prompt: "continue" },
  },
  session_start: { protocolVersion: 1, action: "session_start", session },
  pre_compact: { protocolVersion: 1, action: "pre_compact", session },
  post_compact: { protocolVersion: 1, action: "post_compact", session },
  rollup: { protocolVersion: 1, action: "rollup", session },
  finalize: { protocolVersion: 1, action: "finalize", session },
  dashboard: { protocolVersion: 1, action: "dashboard", session },
  expand: {
    protocolVersion: 1,
    action: "expand",
    session,
    args: { archiveId: "archive_1", offset: 0, limit: 100 },
  },
} as const;

test("accepts every version 1 action-specific request", () => {
  assert.deepEqual(BRIDGE_ACTIONS, [
    "status", "doctor", "pre_tool", "post_tool", "before_prompt", "session_start",
    "pre_compact", "post_compact", "rollup", "finalize", "dashboard", "expand",
  ]);

  for (const request of Object.values(validRequestByAction)) {
    assert.equal(isBridgeRequest(request), true, request.action);
    assert.equal(validateBridgeRequest(request), request);
  }
});

test("rejects unknown versions, actions, and descriptor fields", () => {
  assert.equal(isBridgeRequest({ ...validRequestByAction.status, protocolVersion: 2 }), false);
  assert.equal(isBridgeRequest({ ...validRequestByAction.status, action: "install" }), false);
  assert.equal(isBridgeRequest({ ...validRequestByAction.status, unexpected: true }), false);
  assert.equal(isBridgeRequest({ ...validRequestByAction.status, session: { ...session, extra: true } }), false);
  assert.equal(isBridgeRequest({ ...validRequestByAction.pre_tool, tool: { ...tool, extra: true } }), false);
  assert.throws(() => validateBridgeRequest(null), /bridge request/i);
});

test("rejects invalid ids and oversized descriptor strings", () => {
  for (const id of ["", "../session", "session/name", "session name", "x".repeat(MAX_ID_LENGTH + 1)]) {
    assert.equal(isBridgeRequest({ ...validRequestByAction.status, session: { ...session, id } }), false, id);
  }

  assert.equal(isBridgeRequest({
    ...validRequestByAction.status,
    session: { ...session, cwd: "x".repeat(MAX_DESCRIPTOR_STRING_BYTES + 1) },
  }), false);
  assert.equal(isBridgeRequest({
    ...validRequestByAction.status,
    session: { ...session, file: "x".repeat(MAX_DESCRIPTOR_STRING_BYTES + 1) },
  }), false);
  assert.equal(isBridgeRequest({
    ...validRequestByAction.pre_tool,
    tool: { ...tool, name: "x".repeat(MAX_DESCRIPTOR_STRING_BYTES + 1) },
  }), false);
});

test("requires a bounded session working directory", () => {
  const { cwd: _cwd, ...withoutCwd } = session;

  assert.equal(isBridgeRequest({ ...validRequestByAction.status, session: withoutCwd }), false);
  assert.equal(isBridgeRequest({ ...validRequestByAction.status, session: { ...session, cwd: "" } }), false);
});

test("rejects malformed and oversized JSON payload fields", () => {
  assert.equal(isBridgeRequest({ ...validRequestByAction.status, args: { value: undefined } }), false);
  assert.equal(isBridgeRequest({ ...validRequestByAction.status, args: { value: Number.NaN } }), false);
  assert.equal(isBridgeRequest({ ...validRequestByAction.status, args: new Date() }), false);
  assert.equal(isBridgeRequest({
    ...validRequestByAction.status,
    args: { text: "x".repeat(MAX_REQUEST_BYTES) },
  }), false);
});

test("rejects JSON at depth 20", () => {
  let nested: unknown = "leaf";
  for (let depth = 0; depth < 20; depth += 1) nested = { nested };

  assert.equal(isBridgeRequest({ ...validRequestByAction.status, args: nested }), false);
});

test("rejects requests over the aggregate 5.5 MiB cap", () => {
  const underPerStringLimit = "x".repeat(3 * 1024 * 1024);
  const request = {
    ...validRequestByAction.status,
    args: { first: underPerStringLimit, second: underPerStringLimit },
  };

  assert.equal(Buffer.byteLength(JSON.stringify(request), "utf8") > MAX_REQUEST_BYTES, true);
  assert.equal(isBridgeRequest(request), false);
});

test("rejects requests missing action requirements", () => {
  assert.equal(isBridgeRequest({ protocolVersion: 1, action: "pre_tool", session }), false);
  assert.equal(isBridgeRequest({ protocolVersion: 1, action: "post_tool", session, tool }), false);
  assert.equal(isBridgeRequest({
    protocolVersion: 1,
    action: "before_prompt",
    session,
    args: {},
  }), false);
  assert.equal(isBridgeRequest({
    protocolVersion: 1,
    action: "rollup",
    session: { id: "session-1", cwd: "/tmp/project" },
  }), false);
  assert.equal(isBridgeRequest({
    protocolVersion: 1,
    action: "expand",
    session,
    args: { archiveId: "../archive" },
  }), false);
});

test("requires complete post-tool result metadata", () => {
  const base = { protocolVersion: 1, action: "post_tool", session, tool } as const;

  assert.equal(isBridgeRequest({ ...base, args: { text: "ok", hasImages: false } }), false);
  assert.equal(isBridgeRequest({ ...base, args: { text: "ok", isError: false } }), false);
  assert.equal(isBridgeRequest({
    ...base,
    args: { text: "ok", isError: false, hasImages: false, fullOutputPath: "/tmp/output" },
  }), true);
  assert.equal(isBridgeRequest({
    ...base,
    tool: { ...tool, name: "read" },
    args: { text: "ok", isError: false, hasImages: false, fullOutputPath: "/tmp/output" },
  }), false);
  assert.equal(isBridgeRequest({
    ...base,
    tool: { ...tool, kind: "external" },
    args: { text: "ok", isError: false, hasImages: false, fullOutputPath: "/tmp/output" },
  }), false);
});

test("accepts valid action-specific success and error responses", () => {
  const responses = [
    ["status", { protocolVersion: 1, ok: true, data: { enabled: true } }],
    ["pre_tool", { protocolVersion: 1, ok: true, decision: "allow", updatedInput: { command: "echo ok" } }],
    ["post_tool", { protocolVersion: 1, ok: true, replacementText: "short", archiveId: "archive_1" }],
    ["before_prompt", { protocolVersion: 1, ok: true, contexts: [{ scope: "nudge", text: "focus" }] }],
    ["session_start", { protocolVersion: 1, ok: true, contexts: [{ scope: "recovery", text: "resume" }] }],
    ["expand", { protocolVersion: 1, ok: true, data: { text: "slice", nextOffset: 5 } }],
    ["doctor", { protocolVersion: 1, ok: false, errorCode: "python_unavailable" }],
  ] as const;

  for (const [action, response] of responses) {
    assert.equal(isBridgeResponse(response, action), true, action);
    assert.equal(validateBridgeResponse(response, action), response);
  }
});

test("requires post-tool replacement text and archive id together", () => {
  assert.equal(isBridgeResponse({ protocolVersion: 1, ok: true }, "post_tool"), true);
  assert.equal(isBridgeResponse({
    protocolVersion: 1,
    ok: true,
    replacementText: "short",
  }, "post_tool"), false);
  assert.equal(isBridgeResponse({
    protocolVersion: 1,
    ok: true,
    archiveId: "archive_1",
  }, "post_tool"), false);
});

test("validates successful expansion offsets", () => {
  const response = { protocolVersion: 1, ok: true, data: { text: "slice" } } as const;

  assert.equal(isBridgeResponse(response, "expand"), true);
  for (const nextOffset of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(isBridgeResponse({
      ...response,
      data: { ...response.data, nextOffset },
    }, "expand"), false, String(nextOffset));
  }
});

test("allows post-tool replacements above the expansion slice limit", () => {
  assert.equal(isBridgeResponse({
    protocolVersion: 1,
    ok: true,
    replacementText: "x".repeat(51 * 1024),
    archiveId: "archive_1",
  }, "post_tool"), true);
});

test("rejects responses over the aggregate 64 KiB cap", () => {
  const response = {
    protocolVersion: 1,
    ok: true,
    data: { first: "x".repeat(40 * 1024), second: "x".repeat(40 * 1024) },
  };

  assert.equal(Buffer.byteLength(JSON.stringify(response), "utf8") > MAX_RESPONSE_BYTES, true);
  assert.equal(isBridgeResponse(response, "status"), false);
});

test("rejects malformed and action-inappropriate responses", () => {
  assert.equal(isBridgeResponse({ protocolVersion: 2, ok: true }, "status"), false);
  assert.equal(isBridgeResponse({ protocolVersion: 1, ok: true, surprise: true }, "status"), false);
  assert.equal(isBridgeResponse({ protocolVersion: 1, ok: false }, "status"), false);
  assert.equal(isBridgeResponse({ protocolVersion: 1, ok: true, errorCode: "bad" }, "status"), false);
  assert.equal(isBridgeResponse({ protocolVersion: 1, ok: true, updatedInput: {} }, "status"), false);
  assert.equal(isBridgeResponse({
    protocolVersion: 1,
    ok: true,
    contexts: [{ scope: "recovery", text: "wrong scope" }],
  }, "before_prompt"), false);
  assert.throws(() => validateBridgeResponse({}, "status"), /bridge response/i);
});
