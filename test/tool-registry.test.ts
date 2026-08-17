import assert from "node:assert/strict";
import test from "node:test";

import type { ToolConfig } from "../src/config/model.js";
import { LocalToolRegistry } from "../src/adapters/process/local-tool-registry.js";
import type { ToolStep } from "../src/domain/model.js";

const tool: ToolConfig = {
  id: "safe",
  class: "deterministic",
  executable: "node",
  fixedArgs: ["--version"],
  argumentRules: [{ kind: "prefix", value: "--label=", repeat: false }],
  capabilities: ["workspace.read", "process.execute"],
  stdinModes: ["none"],
  workspaceIds: ["projects"],
  maximumTimeoutMs: 30_000,
  maximumOutputBytes: 65_536,
  inheritEnv: ["PATH"],
  secretEnvMap: {},
};

function step(argument = "--label=test"): ToolStep {
  return { id: "step", tool_id: "safe", args: [argument], cwd: ".", stdin: { mode: "none" } };
}

test("registered tools narrow remote arguments and capabilities", () => {
  const registry = new LocalToolRegistry([tool]);
  registry.validateStep(step(), "projects", ["workspace.read", "process.execute"]);
  assert.throws(
    () => registry.validateStep(step("--other=test"), "projects", ["workspace.read", "process.execute"]),
    /not allowed/u,
  );
  assert.throws(
    () => registry.validateStep(step(), "projects", ["workspace.read"]),
    /did not request capability/u,
  );
});
