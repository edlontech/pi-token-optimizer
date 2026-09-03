import assert from "node:assert/strict";
import test from "node:test";

test("package declares the Pi extension entrypoint", async () => {
  const packageJson = await import("../package.json", { with: { type: "json" } });

  assert.equal(packageJson.default.name, "pi-token-optimizer");
  assert.deepEqual(packageJson.default.pi.extensions, ["./extensions/index.ts"]);
});

test("extension entrypoint imports without using Pi", async () => {
  const extension = await import("../extensions/index.ts");
  const pi = new Proxy({}, {
    get() {
      throw new Error("extension factory must not access Pi yet");
    },
  });

  assert.equal(typeof extension.default, "function");
  assert.equal(extension.default(pi as Parameters<typeof extension.default>[0]), undefined);
});
