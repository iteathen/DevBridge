import { spawn } from "node:child_process";

import { Redactor } from "../../domain/redaction.js";
import type { Capability, ToolStep } from "../../domain/model.js";
import type { Clock } from "../../ports/clock.js";
import type {
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolRunner,
} from "../../ports/tool-runner.js";
import { LocalToolRegistry } from "./local-tool-registry.js";

class BoundedTail {
  #buffer = Buffer.alloc(0);
  #total = 0;

  constructor(readonly maximumBytes: number) {}

  append(chunk: Buffer): void {
    this.#total += chunk.length;
    const combined = Buffer.concat([this.#buffer, chunk]);
    this.#buffer = combined.length <= this.maximumBytes
      ? combined
      : combined.subarray(combined.length - this.maximumBytes);
  }

  text(): string {
    return this.#buffer.toString("utf8");
  }

  truncated(): boolean {
    return this.#total > this.maximumBytes;
  }
}

async function terminateProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("close", () => resolve());
      killer.once("error", () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The process may have exited after SIGTERM.
  }
}

export class NodeProcessRunner implements ToolRunner {
  constructor(readonly registry: LocalToolRegistry, readonly clock: Clock) {}

  validateStep(step: ToolStep, workspaceId: string, requestedCapabilities: readonly Capability[]): void {
    this.registry.validateStep(step, workspaceId, requestedCapabilities);
  }

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    const invocation = this.registry.prepare(
      request.step,
      request.workspaceId,
      request.checkoutPath,
      request.context,
      request.requestedCapabilities,
    );
    const redactor = new Redactor(invocation.secretValues);
    const stdout = new BoundedTail(invocation.maximumOutputBytes);
    const stderr = new BoundedTail(invocation.maximumOutputBytes);
    const startedAt = this.clock.now().toISOString();
    let timedOut = false;
    let lastActivityMs = 0;

    request.onProgress({
      kind: "process_started",
      at: startedAt,
      message: `started local tool ${invocation.tool.id}`,
    });

    const child = spawn(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.environment,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const emitActivity = (tail: BoundedTail): void => {
      const nowMs = this.clock.now().getTime();
      if (nowMs - lastActivityMs < 5000) return;
      lastActivityMs = nowMs;
      request.onProgress({
        kind: "output_activity",
        at: new Date(nowMs).toISOString(),
        message: `local tool ${invocation.tool.id} is producing output`,
        outputTail: redactor.redact(tail.text()).slice(-8192),
      });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.append(chunk);
      emitActivity(stdout);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.append(chunk);
      emitActivity(stderr);
    });

    child.stdin.on("error", () => undefined);
    child.stdin.end(invocation.stdin);

    const timeout = setTimeout(() => {
      timedOut = true;
      request.onProgress({
        kind: "timeout",
        at: this.clock.now().toISOString(),
        message: `local tool ${invocation.tool.id} exceeded timeout`,
      });
      if (child.pid !== undefined) void terminateProcessTree(child.pid);
    }, invocation.timeoutMs);

    const onAbort = (): void => {
      request.onProgress({
        kind: "signal",
        at: this.clock.now().toISOString(),
        message: `local tool ${invocation.tool.id} was cancelled`,
      });
      if (child.pid !== undefined) void terminateProcessTree(child.pid);
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });

    const completion = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    }).finally(() => {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
    });

    const completedAt = this.clock.now().toISOString();
    request.onProgress({
      kind: "process_exited",
      at: completedAt,
      message: `local tool ${invocation.tool.id} exited with ${completion.code ?? completion.signal ?? "unknown"}`,
      outputTail: redactor.redact(`${stdout.text()}\n${stderr.text()}`).slice(-8192),
    });
    return {
      exitCode: completion.code,
      signal: completion.signal,
      timedOut,
      stdoutTail: redactor.redact(stdout.text()),
      stderrTail: redactor.redact(stderr.text()),
      outputTruncated: stdout.truncated() || stderr.truncated(),
      startedAt,
      completedAt,
    };
  }
}
