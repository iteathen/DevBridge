import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("public entry points state the alpha and private-reporting boundaries", async () => {
  const [readme, security, issueConfig, dependabot] = await Promise.all([
    read("README.md"),
    read("SECURITY.md"),
    read(".github/ISSUE_TEMPLATE/config.yml"),
    read(".github/dependabot.yml"),
  ]);

  assert.match(readme, /active public alpha development/i);
  assert.match(readme, /no published package or signed production release/i);
  assert.match(security, /DevBridge\/security\/advisories\/new/);
  assert.match(issueConfig, /DevBridge\/security\/advisories\/new/);
  assert.match(dependabot, /package-ecosystem: github-actions/);
});

test("GitHub Actions dependencies use immutable commit identities", async () => {
  const workflow = await read(".github/workflows/ci.yml");
  const actions = [...workflow.matchAll(/^\s*- uses:\s*([^\s#]+)/gm)].map((match) => match[1]);

  assert.ok(actions.length > 0);
  for (const action of actions) {
    assert.match(action, /@[0-9a-f]{40}$/);
  }
});
