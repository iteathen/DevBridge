#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { compileStandaloneArtifact } from '../src/bootstrap/standalone-artifact.mjs';
import { createStandaloneSourceLoader } from '../src/bootstrap/standalone-source-loader.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plans = Object.freeze([
  Object.freeze({ source: 'src/install/permanent-entry-installer.mjs', target: 'install-devbridge.mjs' }),
  Object.freeze({ source: 'src/bootstrap/zero-state-bootstrap.mjs', target: 'bootstrap-devbridge.mjs' }),
]);
const sourceLoader = createStandaloneSourceLoader({ root });

function build(plan) {
  return compileStandaloneArtifact({
    entry: sourceLoader.read(plan.source),
    load: sourceLoader.load,
    provenance: plan.source,
  });
}

const check = process.argv.slice(2).includes('--check');
if (process.argv.slice(2).some((value) => value !== '--check')) {
  throw new Error('standalone artifact builder accepts only --check');
}

let mismatched = false;
for (const plan of plans) {
  const target = path.join(root, plan.target);
  const expected = build(plan);
  if (check) {
    let actual = null;
    try { actual = readFileSync(target); } catch {}
    if (actual == null || !actual.equals(expected)) {
      process.stderr.write(`standalone artifact is stale: ${plan.target}\n`);
      mismatched = true;
    }
  } else {
    writeFileSync(target, expected, { mode: 0o600, flush: true });
  }
}
if (mismatched) process.exitCode = 1;
