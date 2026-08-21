import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertCandidateStage0Compatibility } from '../src/bootstrap/repository-preflight.mjs';

test('candidate preflight rejects protocol1 under a pre-protocol validation environment', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'db-preflight-stage0-'));
  writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({
    name: 'devbridge',
    version: '0.1.0',
    devbridge: { bootstrap: { minimumStage0Protocol: 1 } },
  })}\n`);

  assert.throws(
    () => assertCandidateStage0Compatibility(root, { CI: '1', DEVBRIDGE_NONINTERACTIVE: '1' }),
    /requires Stage 0 protocol 1.*provides 0/u,
  );
  assert.deepEqual(
    assertCandidateStage0Compatibility(root, {
      CI: '1',
      DEVBRIDGE_NONINTERACTIVE: '1',
      DEVBRIDGE_STAGE0_PROTOCOL: '1',
    }),
    { checked: true, activeStage0Protocol: 1, requiredStage0Protocol: 1 },
  );
  assert.deepEqual(
    assertCandidateStage0Compatibility(root, { CI: 'true' }),
    { checked: false, activeStage0Protocol: null, requiredStage0Protocol: null },
  );
});
