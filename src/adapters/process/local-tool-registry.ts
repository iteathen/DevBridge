import path from "node:path";

import type { ToolConfig } from "../../config/model.js";
import { buildPromptContext } from "../../domain/context.js";
import type { Capability, ContextBundle, ToolStep } from "../../domain/model.js";
import type { RegisteredTool } from "../../ports/tool-runner.js";

export interface PreparedInvocation {
  readonly tool: RegisteredTool;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdin: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly secretValues: readonly string[];
  readonly timeoutMs: number;
  readonly maximumOutputBytes: number;
}

function matchesRule(argument: string, rule: RegisteredTool["argumentRules"][number]): boolean {
  switch (rule.kind) {
    case "literal":
      return argument === rule.value;
    case "prefix":
      return argument.startsWith(rule.value);
    case "regex":
      return new RegExp(rule.value, "u").test(argument);
  }
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export class LocalToolRegistry {
  readonly #tools: ReadonlyMap<string, RegisteredTool>;

  constructor(configs: readonly ToolConfig[]) {
    const tools = new Map<string, RegisteredTool>();
    for (const config of configs) {
      if (tools.has(config.id)) throw new Error(`duplicate tool ID: ${config.id}`);
      tools.set(config.id, {
        id: config.id,
        class: config.class,
        executable: config.executable,
        fixedArgs: config.fixedArgs,
        argumentRules: config.argumentRules,
        capabilities: config.capabilities,
        stdinModes: config.stdinModes,
        workspaceIds: config.workspaceIds,
        maximumTimeoutMs: config.maximumTimeoutMs,
        maximumOutputBytes: config.maximumOutputBytes,
        inheritEnv: config.inheritEnv,
        secretEnvMap: config.secretEnvMap,
      });
    }
    this.#tools = tools;
  }

  get(toolId: string): RegisteredTool {
    const tool = this.#tools.get(toolId);
    if (tool === undefined) throw new Error(`unknown local tool: ${toolId}`);
    return tool;
  }

  validateStep(step: ToolStep, workspaceId: string, requestedCapabilities: readonly Capability[]): void {
    const tool = this.get(step.tool_id);
    if (!tool.workspaceIds.includes(workspaceId)) throw new Error(`tool ${tool.id} is not allowed in workspace ${workspaceId}`);
    for (const capability of tool.capabilities) {
      if (!requestedCapabilities.includes(capability)) {
        throw new Error(`dispatch did not request capability ${capability} required by tool ${tool.id}`);
      }
    }
    if (!tool.stdinModes.includes(step.stdin.mode)) {
      throw new Error(`tool ${tool.id} does not allow stdin mode ${step.stdin.mode}`);
    }
    for (let index = 0; index < step.args.length; index += 1) {
      const direct = tool.argumentRules[index];
      const last = tool.argumentRules.at(-1);
      const rule = direct ?? (last?.repeat === true ? last : undefined);
      if (rule === undefined || !matchesRule(step.args[index] ?? "", rule)) {
        throw new Error(`argument ${index + 1} is not allowed for tool ${tool.id}`);
      }
    }
    if (step.args.length < tool.argumentRules.filter((rule) => !rule.repeat).length) {
      throw new Error(`tool ${tool.id} is missing required dynamic arguments`);
    }
  }

  prepare(
    step: ToolStep,
    workspaceId: string,
    checkoutPath: string,
    context: ContextBundle,
    requestedCapabilities: readonly Capability[],
  ): PreparedInvocation {
    this.validateStep(step, workspaceId, requestedCapabilities);
    const tool = this.get(step.tool_id);
    const cwd = step.cwd === "." ? checkoutPath : path.resolve(checkoutPath, step.cwd);
    if (!isContained(checkoutPath, cwd)) throw new Error("tool working directory escapes guarded checkout");
    const environment: NodeJS.ProcessEnv = {};
    for (const name of tool.inheritEnv) {
      const value = process.env[name];
      if (value !== undefined) environment[name] = value;
    }
    const secretValues: string[] = [];
    for (const [targetName, sourceName] of Object.entries(tool.secretEnvMap)) {
      const value = process.env[sourceName];
      if (value === undefined || value === "") throw new Error(`required secret environment variable is unavailable: ${sourceName}`);
      environment[targetName] = value;
      secretValues.push(value);
    }
    const stdin = step.stdin.mode === "none"
      ? ""
      : step.stdin.mode === "literal"
        ? step.stdin.text
        : buildPromptContext(context);
    return {
      tool,
      executable: tool.executable,
      args: [...tool.fixedArgs, ...step.args],
      cwd,
      stdin,
      environment,
      secretValues,
      timeoutMs: Math.min(step.timeout_ms ?? tool.maximumTimeoutMs, tool.maximumTimeoutMs),
      maximumOutputBytes: tool.maximumOutputBytes,
    };
  }
}
