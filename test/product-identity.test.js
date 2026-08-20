import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const self = 'test/product-identity.test.js';
const historicalFiles = new Set(['docs/testing/PP-DURABILITY-AUDIT-0818.md']);

function normalizedRelative(absolute) {
  return path.relative(root, absolute).split(path.sep).join('/');
}

function liveTextFiles(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const absolute = path.join(directory, entry.name);
    const relative = normalizedRelative(absolute);
    if (entry.isDirectory()) {
      if (relative === 'docs/handoffs') continue;
      liveTextFiles(absolute, files);
      continue;
    }
    if (!entry.isFile() || relative === self || historicalFiles.has(relative)) continue;
    if (/\.(?:js|mjs|md|json|ya?ml)$/u.test(relative) || path.basename(relative) === '.gitignore') files.push({ absolute, relative });
  }
  return files;
}

test('live repository identity is DevBridge-only', () => {
  const violations = [];
  const forbiddenPatterns = [
    /patch[-_ ]?poller/iu,
    /\bPP-(?:00[1-9]|01[0-8])\b/u,
    /PATCH_POLLER_/u,
    /sol\/foundation-bootstrap/u,
  ];
  for (const { absolute, relative } of liveTextFiles(root)) {
    const text = readFileSync(absolute, 'utf8');
    for (const pattern of forbiddenPatterns) {
      if (pattern.test(text)) violations.push(`${relative}: ${pattern}`);
    }
  }

  const forbiddenPaths = [
    ['patch', '-', 'poller.mjs'].join(''),
    ['config/patch', '-', 'poller.example.json'].join(''),
    'docs/naming-and-compatibility.md',
    'src/bootstrap/legacy-bootstrap.mjs',
    'test/legacy-takeover.test.js',
  ];
  for (const forbidden of forbiddenPaths) {
    if (existsSync(path.join(root, forbidden))) violations.push(`forbidden live path: ${forbidden}`);
  }

  const specNames = readdirSync(path.join(root, 'specs')).filter((name) => name.endsWith('.md'));
  assert.equal(specNames.length, 20);
  assert.ok(specNames.every((name) => /^DB-(?:00[1-9]|01[0-9]|020)-/u.test(name)), specNames.join(', '));
  assert.deepEqual(violations, []);
});
