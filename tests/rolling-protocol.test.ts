import assert from "node:assert/strict";
import test from "node:test";
import { isBridgeRequest, isBridgeResponse } from "../src/protocol.ts";

const id = `rolling_${"a".repeat(64)}`;
const result = { id, name: "read", text: "x".repeat(9_000) };
const request = {
  protocolVersion: 1, action: "compress_context", session: { id: "session-1", cwd: "/tmp" },
  args: { results: [result] },
};

test("rolling protocol rejects unsafe archive ids and oversized or ambiguous batches", () => {
  assert.equal(isBridgeRequest(request), true);
  for (const badId of [`${id}\n`, "../escape", "existing-tool", "rolling_" ]) {
    assert.equal(isBridgeRequest({ ...request, args: { results: [{ ...result, id: badId }] } }), false, JSON.stringify(badId));
  }
  for (const results of [
    [], [result, result], [{ ...result, text: "small" }],
    [{ ...result, text: "x".repeat(2 * 1024 * 1024 + 1) }],
    [{ ...result, text: `\0${result.text}` }], [{ ...result, extra: true }],
    Array.from({ length: 33 }, (_, index) => ({ ...result, id: `rolling_${index.toString(16).padStart(64, "0")}` })),
  ]) {
    assert.equal(isBridgeRequest({ ...request, args: { results } }), false);
  }
  assert.equal(isBridgeResponse({ protocolVersion: 1, ok: true, data: { replacements: [{ id, text: "preview" }] } }, "compress_context"), true);
  for (const replacements of [undefined, [{ id: "bad", text: "preview" }], [{ id, text: "" }], [{ id, text: "x".repeat(2_001) }], [{ id, text: "one" }, { id, text: "two" }]]) {
    assert.equal(isBridgeResponse({ protocolVersion: 1, ok: true, data: { replacements } }, "compress_context"), false);
  }
});
