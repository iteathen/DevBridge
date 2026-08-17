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
    let lastActivityMs = this.clock.now().getTime();
    let lastProgressAtMs = Number.NEGATIVE_INFINITY;

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

    const observeActivity = (tail: BoundedTail): void => {
      const nowMs = this.clock.now().getTime();
      lastActivityMs = nowMs;
      if (nowMs - lastProgressAtMs < 5000) return;
      lastProgressAtMs = nowMs;
      request.onProgress({
        kind: "output_activity",
        at: new Date(nowMs).toISOString(),
        message: `local tool ${invocation.tool.id} is producing output`,
        outputTail: redactor.redact(tail.text()).slice(-8192),
      });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.append(chunk);
      observeActivity(stdout);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.append(chunk);
      observeActivity(stderr);
    });

    child.stdin.on("error", () => undefined);
    child.stdin.end(invocation.stdin);

    const livenessIntervalMs = Math.max(15_000, Math.min(60_000, Math.floor(invocation.timeoutMs / 4)));
    const liveness = setInterval(() => {
      const nowMs = this.clock.now().getTime();
      request.onProgress({
        kind: "liveness",
        at: new Date(nowMs).toISOString(),
        message: `local tool ${invocation.tool.id} is still running; last output activity ${Math.max(0, nowMs - lastActivityMs)} ms ago`,
      });
    }, livenessIntervalMs);

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
    if (request.signal?.aborted === true) onAbort();

    const completion = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    }).finally(() => {
      clearTimeout(timeout);
      clearInterval(liveness);
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
