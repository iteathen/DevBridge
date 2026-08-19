import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1'));
const ignored = new Set(['docs/testing/PP-DURABILITY-AUDIT-0818.md']);
const violations = [];
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (relative === 'docs/handoffs') continue;
      walk(absolute);
      continue;
    }
    if (!entry.isFile() || ignored.has(relative)) continue;
    if (!/\.(?:js|mjs|md|json|ya?ml)$/u.test(relative) && path.basename(relative) !== '.gitignore') continue;
    const text = readFileSync(absolute, 'utf8');
    const patterns = [
      /patch[-_ ]?poller/iu,
      /patchpoller/iu,
      /\bPP-(?:00[1-9]|01[0-8])\b/u,
      /PATCH_POLLER_/u,
    ];
    for (const pattern of patterns) if (pattern.test(text)) violations.push(`${relative}: ${pattern}`);
  }
}

test('live repository identity is DevBridge-only', () => {
  walk(root);
  for (const forbidden of ['patch-poller.mjs', 'config/patch-poller.example.json', 'docs/naming-and-compatibility.md', 'src/bootstrap/legacy-bootstrap.mjs', 'test/legacy-takeover.test.js']) {
    if (existsSync(path.join(root, forbidden))) violations.push(`forbidden live path: ${forbidden}`);
  }
  const specNames = readdirSync(path.join(root, 'specs')).filter((name) => name.endsWith('.md'));
  assert.equal(specNames.length, 18);
  assert.ok(specNames.every((name) => /^DB-(?:00[1-9]|01[0-8])-/u.test(name)), specNames.join(', '));
  assert.deepEqual(violations, []);
});
