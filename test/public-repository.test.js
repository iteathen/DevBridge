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

function workflowStep(source, name) {
  const workflow = source.replaceAll("\r\n", "\n");
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.ok(start >= 0, `workflow step ${name} must exist`);
  const next = workflow.indexOf("\n      - name:", start + marker.length);
  return workflow.slice(start, next < 0 ? undefined : next);
}

test("Windows full CI coverage serializes test files while other platforms retain default concurrency", async () => {
  const workflow = await read(".github/workflows/ci.yml");
  const ordinary = workflowStep(workflow, "Tests (non-Windows default)");
  const windows = workflowStep(workflow, "Tests (Windows serialized)");

  assert.match(ordinary, /^        if: runner\.os != 'Windows'$/mu);
  assert.match(ordinary, /^        timeout-minutes: 6$/mu);
  assert.match(ordinary, /^        run: npm test$/mu);
  assert.doesNotMatch(ordinary, /test-concurrency/u);

  assert.match(windows, /^        if: runner\.os == 'Windows'$/mu);
  assert.match(windows, /^        timeout-minutes: 6$/mu);
  assert.match(windows, /^        run: npm test -- --test-concurrency=1$/mu);
});

test("Windows smoke preflight selects a closed concurrency bound while other platforms retain default scheduling", async () => {
  const workflow = await read(".github/workflows/ci.yml");
  const ordinary = workflowStep(workflow, "Cheap preflight (non-Windows default)");
  const windows = workflowStep(workflow, "Cheap preflight (Windows bounded)");

  assert.match(ordinary, /^        if: runner\.os != 'Windows'$/mu);
  assert.match(ordinary, /^        timeout-minutes: 2$/mu);
  assert.match(ordinary, /^        run: npm run preflight$/mu);
  assert.doesNotMatch(ordinary, /bound-targeted-test-concurrency/u);

  assert.match(windows, /^        if: runner\.os == 'Windows'$/mu);
  assert.match(windows, /^        timeout-minutes: 2$/mu);
  assert.match(windows, /^        run: npm run preflight -- --bound-targeted-test-concurrency$/mu);
});
