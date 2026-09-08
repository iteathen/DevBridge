import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { qualifyGuestBootstrap } from '../src/setup/guest-bootstrap-qualification.js';
import { copyHyperVGuestFile } from '../src/runtime/providers/hyperv-file-copy.js';

const IDENTITY = { packageDigest: 'a'.repeat(64), nodeDigest: 'b'.repeat(64) };
const TARGET = `env-${'a'.repeat(32)}`;
const success = (stdout) => ({ exitCode: 0, stdout, stderr: '', timedOut: false, aborted: false, outputTruncated: false });
function declaration(family) {
  return { protocol: 'devbridge/environment-declaration-v1', profile: `${family}-development`, schemaGeneration: 'profile-v1',
    guest: { family: family === 'linux' ? 'ubuntu' : 'windows-11', generation: 'guest-v1' }, image: { identity: 'image-v1', generation: 'final-v1' },
    resources: { memoryBytes: 4 * 1024 ** 3, processorCount: 2 }, boot: { requirement: 'efi-v1' },
    network: { requirement: 'managed-egress-v1' }, bootstrap: { generation: 'tooling-v1', requirements: ['runtime-js'] },
    enrollment: { requirement: 'unique-guest-trust-v1' }, workspaces: [], protectedStateClasses: [] };
}

async function fixture(t, family, incorrect = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-guest-qualification-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new Map();
  let entry = null;
  let bootstrapCalls = 0;
  let removals = 0;
  const expectedFile = family === 'linux' ? '/var/lib/devbridge/bootstrap/network-seed.json' : 'C:\\ProgramData\\DevBridge\\bootstrap\\network-seed.json';
  const ports = {
    foundationFactory: async () => ({
      listEnvironments: async () => entry ? [entry] : [],
      verifyImage: async () => ({ verified: true, usable: true, entry: { generation: 'final-v1', digest: 'c'.repeat(64) } }),
      ensureEnvironment: async (request) => entry ??= { record: { identity: TARGET, subject: request.subject, profile: request.profile, source: { identity: request.sourceIdentity } }, observation: { exists: true } },
      stopEnvironment: async (target) => assert.equal(target, TARGET),
      removeEnvironment: async (target) => { assert.equal(target, TARGET); removals++; entry = null; },
    }),
    accessFactory: async () => ({ connection: async () => ({ family }), prepare: async () => {}, discard: async (target) => assert.equal(target, TARGET) }),
    bootstrapFactory: async ({ invoke }) => ({
      ensure: async (target) => {
        bootstrapCalls++;
        const source = path.join(root, `seed-${randomUUID()}.json`);
        await writeFile(source, JSON.stringify({ protocol: 'devbridge/network-seed-v1', target }));
        await copyHyperVGuestFile({ invoke, location: { reference: 'fixture-vm', proof: 'fixture-owned' }, family, source, destination: expectedFile });
        return { ready: true };
      },
      connection: async () => ({ family }), reconcile: async () => {},
    }),
    bridgeFactory: async () => ({
      health: async () => ({ ready: true, version: '1.0.0' }),
      execute: async () => {
        const bytes = files.get(expectedFile);
        if (!bytes) return { completion: 'observed', result: { ...success(''), exitCode: 1, stderr: 'requested seed file missing' } };
        return { completion: 'observed', result: success(JSON.stringify({ target: JSON.parse(bytes).target, family, digest: createHash('sha256').update(bytes).digest('hex') })) };
      },
    }),
    identityLoader: async () => 'a'.repeat(32),
  };
  const request = { stateDirectory: root, authorityDirectory: root, evidenceDirectory: root, declaration: declaration(family), runtimeIdentity: IDENTITY,
    qualificationId: randomUUID(), platform: 'win32', invoke: async (request) => {
      const payload = JSON.parse(request.input);
      // Model each native provider's destination contract, including a wrong-path
      // regression that a command-accepting fake would silently accept.
      const destination = family === 'linux' ? path.posix.join(payload.destination, incorrect ? 'wrong-seed.json' : path.basename(payload.source)) : payload.destination;
      files.set(destination, await readFile(payload.source));
      return success(JSON.stringify({ delivered: true }));
    } };
  return { request, ports, counts: () => ({ bootstrapCalls, removals }) };
}

for (const family of ['linux', 'windows']) test(`fresh ${family} consumer proves exact seed bytes and cleans only its owned fixture`, async (t) => {
  const f = await fixture(t, family);
  const result = await qualifyGuestBootstrap(f.request, f.ports);
  assert.equal(result.passed, true);
  assert.equal(result.cleanup, 'complete');
  assert.equal(result.freshSubjectObserved, true);
  assert.deepEqual(f.counts(), { bootstrapCalls: 1, removals: 1 });
  assert.deepEqual(await qualifyGuestBootstrap(f.request, f.ports), result);
  assert.deepEqual(f.counts(), { bootstrapCalls: 1, removals: 1 });
  await assert.rejects(qualifyGuestBootstrap({ ...f.request, runtimeIdentity: { ...IDENTITY, packageDigest: 'd'.repeat(64) } }, f.ports), /intent changed/u);
});

test('qualification rejects a copy reported successful at the wrong path and retains failure evidence', async (t) => {
  const f = await fixture(t, 'linux', true);
  await assert.rejects(qualifyGuestBootstrap(f.request, f.ports), /seed file missing/u);
  const result = JSON.parse(await readFile(path.join(f.request.evidenceDirectory, f.request.qualificationId, 'qualification.json'), 'utf8'));
  assert.equal(result.passed, false);
  assert.equal(result.stage, 'first-access');
  assert.match(result.failure.message, /seed file missing/u);
  assert.deepEqual(f.counts(), { bootstrapCalls: 1, removals: 0 });
});
