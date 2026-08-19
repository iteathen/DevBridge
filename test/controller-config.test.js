import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateConfig } from '../src/config.js';

function base() {
  return {
    version: 1,
    github: { queueRepository: 'iteathen/DevBridge', trustedActorIds: ['1775584'], rateLimit: {} },
    workspace: { root: path.resolve('/tmp/pp-controller-config'), allowedOwners: ['iteathen'] },
    state: { directory: path.resolve('/tmp/pp-controller-state') },
    execution: {},
    status: {},
    tools: {}
  };
}

test('deterministic controller plans are enabled and coding-model adapters are disabled by default', () => {
  const config = validateConfig(base());
  assert.equal(config.execution.controllerPlansEnabled, true);
  assert.equal(config.execution.modelAdaptersEnabled, false);
  assert.deepEqual(config.workspace.baselineChannels, {});
  assert.equal(config.workspace.defaultBaselineChannel, null);
  assert.equal(config.publication.forceNoOpPublication, false);
});

test('accepts local semantic baseline channel mapping including slash branches', () => {
  const raw = base();
  raw.workspace.baselineChannels = { production: 'main', testing: 'sol/foundation-bootstrap' };
  raw.workspace.defaultBaselineChannel = 'testing';
  const config = validateConfig(raw);
  assert.deepEqual(config.workspace.baselineChannels, { production: 'main', testing: 'sol/foundation-bootstrap' });
  assert.equal(config.workspace.defaultBaselineChannel, 'testing');
});

test('baseline channels reject unsafe refs and unknown defaults', () => {
  const raw = base();
  raw.workspace.baselineChannels = { testing: '../evil' };
  assert.throws(() => validateConfig(raw), /safe branch/u);
  const other = base();
  other.workspace.baselineChannels = { production: 'main' };
  other.workspace.defaultBaselineChannel = 'testing';
  assert.throws(() => validateConfig(other), /configured local baseline channel/u);
});
