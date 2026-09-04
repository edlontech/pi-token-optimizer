import assert from "node:assert/strict";
import test from "node:test";

test("package declares the Pi extension entrypoint", async () => {
  const packageJson = await import("../package.json", { with: { type: "json" } });

  assert.equal(packageJson.default.name, "@edlontech/pi-token-optimizer");
  assert.deepEqual(packageJson.default.pi.extensions, ["./extensions/index.ts"]);
  assert.equal(packageJson.default.files.includes("src/*.ts"), true);
});

test("extension import is inert and its factory only registers with Pi", async () => {
  const extension = await import("../extensions/index.ts");
  const commands: string[] = [];
  const tools: string[] = [];
  const events: string[] = [];
  const pi = {
    registerCommand: (name: string) => { commands.push(name); },
    registerTool: (tool: { name: string }) => { tools.push(tool.name); },
    on: (event: string) => { events.push(event); },
    getAllTools: () => [],
    sendMessage: () => {},
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
  } as unknown as Parameters<typeof extension.default>[0];

  assert.equal(typeof extension.default, "function");
  assert.deepEqual({ commands, tools, events }, { commands: [], tools: [], events: [] });
  assert.equal(extension.default(pi), undefined);
  assert.deepEqual(commands, ["token-optimizer"]);
  assert.deepEqual(tools, ["token_optimizer_expand"]);
  assert.equal(events.includes("session_start"), true);
});

test("an incompatible Pi API fails extension loading visibly", async () => {
  const extension = await import("../extensions/index.ts");

  assert.throws(() => extension.default({} as Parameters<typeof extension.default>[0]), TypeError);
});
