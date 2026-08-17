#!/usr/bin/env node

import path from "node:path";

import { PatchPollerDaemon } from "./application/daemon.js";
import { JobOrchestrator } from "./application/job-orchestrator.js";
import { TrustPolicy } from "./application/trust-policy.js";
import { IssueCommentMailbox } from "./adapters/github/issue-comment-mailbox.js";
import { GitHubRestClient } from "./adapters/github/github-rest-client.js";
import { ReadOnlyWorkspaceGuard } from "./adapters/filesystem/read-only-workspace-guard.js";
import { LocalToolRegistry } from "./adapters/process/local-tool-registry.js";
import { NodeProcessRunner } from "./adapters/process/node-process-runner.js";
import { SqliteStateStore } from "./adapters/state/sqlite-state-store.js";
import { ConsoleLogger } from "./adapters/system/console-logger.js";
import { SystemClock } from "./adapters/system/system-clock.js";
import { loadConfig } from "./config/load-config.js";
import { RateBudgetGovernor } from "./domain/rate-budget.js";

interface Arguments {
  readonly config: string;
  readonly once: boolean;
  readonly checkConfig: boolean;
}

function parseArguments(argv: readonly string[]): Arguments {
  let config = "config/local.config.json";
  let once = false;
  let checkConfig = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    switch (value) {
      case "--config": {
        const next = argv[index + 1];
        if (next === undefined || next.startsWith("--")) throw new Error("--config requires a filename");
        config = next;
        index += 1;
        break;
      }
      case "--once":
        once = true;
        break;
      case "--check-config":
        checkConfig = true;
        break;
      case "--help":
        process.stdout.write(
          "Usage: patch-poller [--config FILE] [--once] [--check-config]\n",
        );
        process.exit(0);
      default:
        throw new Error(`unknown argument: ${value}`);
    }
  }
  return { config, once, checkConfig };
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const configFilename = path.resolve(args.config);
  const config = loadConfig(configFilename);
  if (args.checkConfig) {
    process.stdout.write(`${JSON.stringify({ status: "valid", config: configFilename })}\n`);
    return;
  }

  const token = process.env[config.github.tokenEnv];
  if (token === undefined || token === "") {
    throw new Error(`GitHub token environment variable is unavailable: ${config.github.tokenEnv}`);
  }
  const stateFilename = path.isAbsolute(config.state.databasePath)
    ? config.state.databasePath
    : path.resolve(path.dirname(configFilename), config.state.databasePath);

  const logger = new ConsoleLogger();
  const clock = new SystemClock();
  const state = new SqliteStateStore(stateFilename);
  state.initialize();
  const governor = new RateBudgetGovernor({
    activeIntervalMs: config.github.poll.activeIntervalMs,
    idleIntervalMs: config.github.poll.idleIntervalMs,
    maximumIdleIntervalMs: config.github.poll.maximumIdleIntervalMs,
    conservationRemaining: config.github.poll.conservationRemaining,
    criticalReserveRemaining: config.github.poll.criticalReserveRemaining,
    conservationRatio: config.github.poll.conservationRatio,
  });
  const github = new GitHubRestClient({
    apiBaseUrl: config.github.apiBaseUrl,
    apiVersion: config.github.apiVersion,
    token,
    userAgent: config.github.userAgent,
  }, governor, clock, logger, state);
  const bindings = config.github.mailboxes.map((mailboxConfig) => ({
    config: mailboxConfig,
    mailbox: new IssueCommentMailbox(mailboxConfig, github, state, clock),
  }));
  const registry = new LocalToolRegistry(config.tools);
  const runner = new NodeProcessRunner(registry, clock);
  const workspaceGuard = new ReadOnlyWorkspaceGuard(config.workspaces);
  const orchestrator = new JobOrchestrator(
    state,
    runner,
    workspaceGuard,
    clock,
    logger,
    config.reporting,
    () => governor.mode(clock.now().getTime()),
  );
  const daemon = new PatchPollerDaemon({
    bindings,
    state,
    clock,
    logger,
    governor,
    poll: config.github.poll,
    trust: new TrustPolicy(),
    orchestrator,
  });

  const controller = new AbortController();
  const stop = (): void => controller.abort(new Error("operator requested shutdown"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  logger.info("PATCH-POLLER starting", {
    config: configFilename,
    mailboxes: bindings.length,
    tools: config.tools.map((tool) => tool.id),
    mode: args.once ? "once" : "daemon",
  });
  try {
    if (args.once) await daemon.runOnce(controller.signal);
    else await daemon.run(controller.signal);
  } finally {
    state.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
