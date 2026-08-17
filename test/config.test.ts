import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { parseConfig } from "../src/config/load-config.js";

function config(): Record<string, unknown> {
  const root = path.resolve("tmp-projects");
  return {
    version: 1,
    state: { database_path: ".patch-poller/test.sqlite" },
    github: {
      api_base_url: "https://api.github.com",
      api_version: "2026-03-10",
      token_env: "PATCH_POLLER_GITHUB_TOKEN",
      user_agent: "patch-poller/test",
      poll: {
        active_interval_ms: 30000,
        idle_interval_ms: 120000,
        maximum_idle_interval_ms: 900000,
        jitter_ratio: 0.1,
        conservation_remaining: 750,
        critical_reserve_remaining: 200,
        conservation_ratio: 0.2,
      },
      mailboxes: [{
        id: "control",
        repository: "iteathen/PATCH-POLLER",
        issue_number: 1,
        trusted_authors: ["iteathen"],
        trusted_app_ids: [],
        allowed_author_associations: ["OWNER"],
        bootstrap: "ignore_existing",
      }],
    },
    workspaces: [{
      id: "projects",
      root,
      worktree_root: path.join(root, "worktrees"),
      git_executable: "git",
      checkouts: [{ repository: "iteathen/PATCH-POLLER", relative_path: "PATCH-POLLER" }],
    }],
    tools: [{
      id: "node-version",
      class: "deterministic",
      executable: "node",
      fixed_args: ["--version"],
      argument_rules: [],
      capabilities: ["workspace.read", "process.execute"],
      stdin_modes: ["none"],
      workspace_ids: ["projects"],
      maximum_timeout_ms: 30000,
      maximum_output_bytes: 65536,
      inherit_env: ["PATH"],
      secret_env_map: {},
    }],
    reporting: {
      minimum_update_interval_ms: 60000,
      maximum_silence_ms: 600000,
      maximum_comment_bytes: 60000,
      redact_absolute_paths: true,
    },
  };
}

test("parses strict local configuration", () => {
  const parsed = parseConfig(config());
  assert.equal(parsed.github.apiVersion, "2026-03-10");
  assert.equal(parsed.tools[0]?.id, "node-version");
});

test("rejects insecure GitHub base URL", () => {
  const value = config();
  (value.github as Record<string, unknown>).api_base_url = "http://api.github.com";
  assert.throws(() => parseConfig(value), /must use HTTPS/u);
});

test("agent tools must declare write authority", () => {
  const value = config();
  const tools = value.tools as Record<string, unknown>[];
  tools[0] = { ...tools[0], class: "agent" };
  assert.throws(() => parseConfig(value), /must declare workspace.write/u);
});
