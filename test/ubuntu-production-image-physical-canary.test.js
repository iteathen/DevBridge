import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGuestImagePayload } from '../src/guest/image-payload.js';
import {
  createUbuntuProductionImagePhysicalCanary,
  UBUNTU_PRODUCTION_IMAGE_PHYSICAL_CANARY_CONFIG_PROTOCOL,
} from '../src/app/ubuntu-production-image-physical-canary.js';

const PACKAGE_SNAPSHOT = '20260823T100000Z';

async function fixture(root) {
  const payload = await createGuestImagePayload();
  const sourceSha256 = 'a'.repeat(64);
  return {
    payload,
    config: {
      protocol: UBUNTU_PRODUCTION_IMAGE_PHYSICAL_CANARY_CONFIG_PROTOCOL,
      stateDirectory: path.join(root, 'state'),
      keyring: path.join(root, 'archive-keyring.gpg'),
      authority: {
        protocol: 'devbridge/ubuntu-construction-authority-v1',
        source: {
          protocol: 'devbridge/ubuntu-release-media-v1',
          release: '26.04',
          architecture: 'amd64',
          media: {
            url: 'https://releases.ubuntu.com/26.04/ubuntu-26.04-live-server-amd64.iso',
            name: 'ubuntu-26.04-live-server-amd64.iso',
            sha256: sourceSha256,
            bytes: 3_145_728_000,
          },
          checksums: {
            manifestUrl: 'https://releases.ubuntu.com/26.04/SHA256SUMS',
            signatureUrl: 'https://releases.ubuntu.com/26.04/SHA256SUMS.gpg',
            signerFingerprint: 'A'.repeat(40),
          },
        },
        recipe: {
          protocol: 'devbridge/ubuntu-autoinstall-recipe-v1',
          sourceSha256,
          generation: 'ubuntu-2604-autoinstall-v1',
          patches: [{ id: 'boot-trigger', occurrences: 2, before: 'install ---', after: 'auto    ---' }],
        },
        packages: {
          generation: 'ubuntu-2604-tools-v1',
          snapshot: PACKAGE_SNAPSHOT,
          packages: [
            { name: 'build-essential', version: '12.12ubuntu1' },
            { name: 'cmake', version: '3.31.6-1' },
            { name: 'git', version: '1:2.48.1-0ubuntu1' },
            { name: 'nodejs', version: '22.16.0+dfsg-1' },
            { name: 'npm', version: '10.9.2+ds-1' },
          ],
        },
        payload: { generation: payload.generation },
        qualification: { commands: ['make'], services: ['hv-fcopy-daemon.service'] },
        output: { profile: 'linux-development', generation: 'ubuntu-2604-production-v1', bootstrap: 'guest-image-v1' },
      },
      resources: { memoryBytes: 2 * 1024 * 1024 * 1024, processorCount: 2, diskBytes: 32 * 1024 * 1024 * 1024 },
    },
  };
}

const readyPreflight = Object.freeze({
  async inspect() {
    return Object.freeze({ protocol: 'test/preflight-v1', ready: true, reason: null, capabilities: Object.freeze({ provider: true, keyring: true, memory: true, storage: true }), resources: Object.freeze({}) });
  },
});

function status(phase, { complete = false, blocked = false, reason = null, image = null } = {}) {
  return Object.freeze({ protocol: 'devbridge/canonical-image-canary-v1', identity: `subject-${'1'.repeat(32)}`, phase, revision: 1, complete, blocked, reason, image });
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function canonicalRequest(data, subject) {
  return {
    identity: subject,
    work: stable({ subject }),
    check: stable({
      payloadGeneration: data.payload.generation,
      files: data.payload.files.map((file) => ({ path: file.path, sha256: file.sha256 })),
      packageGeneration: data.config.authority.packages.generation,
      packageSnapshot: data.config.authority.packages.snapshot,
      packages: data.config.authority.packages.packages.map((entry) => ({ ...entry })),
      commands: [...data.config.authority.qualification.commands],
      services: [...data.config.authority.qualification.services],
    }),
    output: {
      profile: data.config.authority.output.profile,
      generation: data.config.authority.output.generation,
      provenance: Object.fromEntries(Object.entries({
        origin: 'ubuntu-production-image-canary',
        authority: subject,
        source: data.config.authority.source.media.sha256,
        bootstrap: data.config.authority.output.bootstrap,
      }).sort(([left], [right]) => left.localeCompare(right))),
    },
  };
}

async function writeCanaryRecord(data, subject, phase, image = null) {
  const requestDigest = createHash('sha256').update(JSON.stringify(canonicalRequest(data, subject)), 'utf8').digest('hex');
  const file = path.join(data.config.stateDirectory, 'production-image-canary', 'journal.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({
    [`canonical-image-canary:${subject}`]: {
      protocol: 'devbridge/canonical-image-canary-v1',
      identity: subject,
      requestDigest,
      revision: 3,
      phase,
      probe: null,
      finalization: null,
      image,
    },
  }, null, 2)}\n`);
}

async function absent(value) {
  try { await lstat(value); return false; }
  catch (error) { if (error?.code === 'ENOENT') return true; throw error; }
}

test('physical canary status is genuinely non-mutating before host admission', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-physical-canary-status-'));
  try {
    const data = await fixture(root);
    let runtimeCalls = 0;
    const canary = createUbuntuProductionImagePhysicalCanary(data.config, {
      platform: 'win32',
      preflight: readyPreflight,
      payloadFactory: async () => data.payload,
      runtimeFactory: async () => { runtimeCalls += 1; throw new Error('runtime must not be created by status'); },
    });
    const result = await canary.status();
    assert.equal(result.state, 'absent');
    assert.equal(result.blocked, false);
    assert.equal(result.authorityRegistered, false);
    assert.equal(runtimeCalls, 0);
    assert.equal(await absent(data.config.stateDirectory), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resource preflight does not strand a canary after physical allocation has started', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-physical-canary-continuation-'));
  try {
    const data = await fixture(root);
    const canary = createUbuntuProductionImagePhysicalCanary(data.config, {
      platform: 'win32',
      preflight: { async inspect() { return { protocol: 'test/preflight-v1', ready: false, reason: 'free resources fell below initial admission threshold' }; } },
      payloadFactory: async () => data.payload,
    });
    await writeCanaryRecord(data, canary.subject, 'running');
    const result = await canary.status();
    assert.equal(result.state, 'running');
    assert.equal(result.blocked, false);
    assert.equal(result.reason, null);
    assert.equal(result.preflight.ready, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('invalid installer patch fails before provider network or access allocation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-physical-canary-media-first-'));
  try {
    const data = await fixture(root);
    const media = Buffer.from('exact-test-image-without-the-required-trigger', 'utf8');
    const mediaSha256 = createHash('sha256').update(media).digest('hex');
    data.config.authority.source.media.bytes = media.length;
    data.config.authority.source.media.sha256 = mediaSha256;
    data.config.authority.recipe.sourceSha256 = mediaSha256;
    data.config.authority.recipe.patches = [{ id: 'missing-trigger', occurrences: 1, before: 'MISSING', after: 'CHANGED' }];
    await mkdir(path.dirname(data.config.keyring), { recursive: true });
    await writeFile(data.config.keyring, 'test-keyring');

    const fingerprint = data.config.authority.source.checksums.signerFingerprint;
    const manifest = Buffer.from(`${mediaSha256}  ${data.config.authority.source.media.name}\n`, 'utf8');
    const signature = Buffer.from('test-signature', 'utf8');
    const fetchImpl = async (url) => {
      const text = String(url);
      const body = text.endsWith('/SHA256SUMS') ? manifest : text.endsWith('/SHA256SUMS.gpg') ? signature : media;
      return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
    };
    const invocations = [];
    const invoke = async (request) => {
      invocations.push(request.executable);
      if (String(request.executable).toLowerCase().includes('gpgv')) {
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          aborted: false,
          outputTruncated: false,
          stdout: `[GNUPG:] VALIDSIG ${fingerprint} a b c d e f g h ${fingerprint}\n`,
          stderr: '',
        };
      }
      throw new Error(`provider/access allocation occurred before patch validation: ${request.executable}`);
    };

    const canary = createUbuntuProductionImagePhysicalCanary(data.config, {
      platform: 'win32',
      preflight: readyPreflight,
      payloadFactory: async () => data.payload,
      fetchImpl,
      invoke,
    });
    await assert.rejects(() => canary.run(), /expected 1 occurrence\(s\) but found 0/u);
    assert.equal(invocations.length, 1);
    assert.match(invocations[0], /gpgv/iu);
    assert.equal(await absent(path.join(data.config.stateDirectory, 'environment-foundation', 'bootstrap', 'attachment')), true);
    assert.equal(await absent(path.join(data.config.stateDirectory, 'production-image-canary', 'access')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('physical canary run returns a bounded next observation while installation owns the frontier', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-physical-canary-install-'));
  try {
    const data = await fixture(root);
    let advances = 0;
    const runtimeFactory = async ({ subject }) => ({
      canary: {
        async inspect() { return { ...status('running'), identity: subject }; },
        async advance() { advances += 1; throw new Error('installer frontier must not advance'); },
      },
      construction: { async observeInstall() { return { identity: subject, phase: 'installing', state: 'running', mediaCount: 2, liveness: { classification: 'observing', nextObservationAt: '2026-08-26T18:02:00.000Z' } }; } },
      accessProbe: { async inspect() { return { ready: true }; } },
      async access() { throw new Error('access must not be probed during installation'); },
      addressOwner: { async releaseAddress() {} },
    });
    const canary = createUbuntuProductionImagePhysicalCanary(data.config, { platform: 'win32', preflight: readyPreflight, payloadFactory: async () => data.payload, runtimeFactory });
    const result = await canary.run();
    assert.equal(result.state, 'waiting');
    assert.match(result.reason, /powered on/u);
    assert.equal(result.liveness.classification, 'observing');
    assert.equal(advances, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('physical canary blocks a stalled installer without repairing or advancing the VM', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-physical-canary-stalled-'));
  try {
    const data = await fixture(root);
    let advances = 0;
    const runtimeFactory = async ({ subject }) => ({
      canary: {
        async inspect() { return { ...status('running'), identity: subject }; },
        async advance() { advances += 1; throw new Error('stalled frontier must not advance'); },
      },
      construction: {
        async observeInstall() { return { identity: subject, phase: 'installing', state: 'running', mediaCount: 2, liveness: { classification: 'stalled', nextObservationAt: null } }; },
        async captureInstallConsole() { return { available: true, location: 'owned-console.bmp', sha256: 'a'.repeat(64), capturedAt: '2026-08-26T21:10:00.000Z' }; },
      },
      accessProbe: { async inspect() { throw new Error('access must not be probed during installation'); } },
      async access() { throw new Error('access must not be resolved during installation'); },
    });
    const canary = createUbuntuProductionImagePhysicalCanary(data.config, { platform: 'win32', preflight: readyPreflight, payloadFactory: async () => data.payload, runtimeFactory });
    const result = await canary.run();
    assert.equal(result.state, 'blocked');
    assert.match(result.reason, /stalled.*no automatic VM repair/u);
    assert.equal(result.liveness.classification, 'stalled');
    assert.equal(result.diagnostics.location, 'owned-console.bmp');
    assert.equal(advances, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('physical canary run waits for exact SSH access before qualification', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-physical-canary-access-'));
  try {
    const data = await fixture(root);
    let advances = 0;
    const runtimeFactory = async ({ subject }) => ({
      canary: {
        async inspect() { return { ...status('active'), identity: subject }; },
        async advance() { advances += 1; throw new Error('qualification must not start without access'); },
      },
      construction: { async status() { return { identity: subject, phase: 'qualifying', state: 'running', mediaCount: 0, uptimeMilliseconds: 60_000 }; } },
      accessProbe: { async inspect() { return { ready: false, reason: 'host key not ready' }; } },
      async access() { return { family: 'linux', user: 'devbridge', address: '192.168.90.20', identityFile: 'id', knownHostsFile: 'known' }; },
      addressOwner: { async releaseAddress() {} },
    });
    const canary = createUbuntuProductionImagePhysicalCanary(data.config, { platform: 'win32', preflight: readyPreflight, payloadFactory: async () => data.payload, runtimeFactory, now: () => new Date('2026-08-27T22:01:00.000Z') });
    const result = await canary.run();
    assert.equal(result.state, 'waiting');
    assert.match(result.reason, /host key not ready/u);
    assert.equal(result.readiness.classification, 'observing');
    assert.equal(result.readiness.nextObservationAt, '2026-08-27T22:01:30.000Z');
    assert.equal(advances, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('physical canary run treats delayed provider-reported guest addressing as a resumable frontier', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-physical-canary-address-'));
  try {
    const data = await fixture(root);
    let advances = 0;
    const runtimeFactory = async ({ subject }) => ({
      canary: {
        async inspect() { return { ...status('active'), identity: subject }; },
        async advance() { advances += 1; throw new Error('qualification must not start without an exact endpoint'); },
      },
      construction: { async status() { return { identity: subject, phase: 'qualifying', state: 'running', mediaCount: 0, uptimeMilliseconds: 60_000 }; } },
      accessProbe: { async inspect() { throw new Error('SSH must not run without an endpoint'); } },
      async access() { throw new Error('construction guest has not reported a private IPv4 address'); },
    });
    const canary = createUbuntuProductionImagePhysicalCanary(data.config, { platform: 'win32', preflight: readyPreflight, payloadFactory: async () => data.payload, runtimeFactory, now: () => new Date('2026-08-27T22:01:00.000Z') });
    const result = await canary.run();
    assert.equal(result.state, 'waiting');
    assert.match(result.reason, /access endpoint is not ready.*has not reported a private IPv4/u);
    assert.equal(advances, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('physical canary blocks expired access readiness without repairing or advancing the VM', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-physical-canary-access-expired-'));
  try {
    const data = await fixture(root);
    let advances = 0;
    const runtimeFactory = async ({ subject }) => ({
      canary: {
        async inspect() { return { ...status('active'), identity: subject }; },
        async advance() { advances += 1; throw new Error('expired access must not advance'); },
      },
      construction: { async status() { return { identity: subject, phase: 'qualifying', state: 'running', mediaCount: 0, uptimeMilliseconds: 10 * 60_000 }; } },
      accessProbe: { async inspect() { return { ready: false, reason: 'connection refused' }; } },
      async access() { return { family: 'linux', user: 'devbridge', address: '192.168.90.20', identityFile: 'id', knownHostsFile: 'known' }; },
    });
    const canary = createUbuntuProductionImagePhysicalCanary(data.config, { platform: 'win32', preflight: readyPreflight, payloadFactory: async () => data.payload, runtimeFactory, now: () => new Date('2026-08-27T22:10:00.000Z') });
    const result = await canary.run();
    assert.equal(result.state, 'blocked');
    assert.match(result.reason, /readiness deadline expired.*connection refused.*no automatic repair/u);
    assert.equal(result.readiness.classification, 'expired');
    assert.equal(result.readiness.nextObservationAt, null);
    assert.equal(advances, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('physical canary run waits for sanitizer shutdown before qualified acceptance', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-physical-canary-shutdown-'));
  try {
    const data = await fixture(root);
    let advances = 0;
    const runtimeFactory = async ({ subject }) => ({
      canary: {
        async inspect() { return { ...status('finalized'), identity: subject }; },
        async advance() { advances += 1; throw new Error('acceptance must not race shutdown'); },
      },
      construction: { async status() { return { identity: subject, phase: 'qualifying', state: 'running', mediaCount: 0 }; } },
      accessProbe: { async inspect() { return { ready: true }; } },
      async access() { return {}; },
      addressOwner: { async releaseAddress() {} },
    });
    const canary = createUbuntuProductionImagePhysicalCanary(data.config, { platform: 'win32', preflight: readyPreflight, payloadFactory: async () => data.payload, runtimeFactory });
    const result = await canary.run();
    assert.equal(result.state, 'waiting');
    assert.match(result.reason, /powering off/u);
    assert.equal(advances, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('physical canary completed state releases its reserved address and host access material', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-physical-canary-complete-'));
  try {
    const data = await fixture(root);
    let releases = 0;
    let discards = 0;
    const runtimeFactory = async ({ subject }) => ({
      canary: {
        async inspect() { return { ...status('completed', { complete: true, image: { identity: `img-${'2'.repeat(32)}` } }), identity: subject }; },
        async advance() { throw new Error('completed canary must not advance'); },
      },
      construction: { async status() { throw new Error('completed canary must not inspect construction'); } },
      accessProbe: { async inspect() { throw new Error('completed canary must not probe access'); } },
      async access() { throw new Error('completed canary must not resolve access'); },
      addressOwner: { async releaseAddress(value) { assert.equal(value, subject); releases += 1; } },
      accessMaterial: { async discard(value) { assert.equal(value, subject); discards += 1; } },
    });
    const canary = createUbuntuProductionImagePhysicalCanary(data.config, { platform: 'win32', preflight: readyPreflight, payloadFactory: async () => data.payload, runtimeFactory });
    const result = await canary.run();
    assert.equal(result.state, 'completed');
    assert.equal(releases, 1);
    assert.equal(discards, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a completed journal can recover exact cleanup without replaying the physical runtime', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-physical-canary-complete-recovery-'));
  try {
    const data = await fixture(root);
    let runtimeCalls = 0;
    const canary = createUbuntuProductionImagePhysicalCanary(data.config, {
      platform: 'win32',
      preflight: readyPreflight,
      payloadFactory: async () => data.payload,
      invoke: async () => { throw new Error('completed cleanup must not invoke host commands'); },
      runtimeFactory: async () => { runtimeCalls += 1; throw new Error('completed cleanup must not recreate runtime'); },
    });
    const image = {
      identity: `img-${'2'.repeat(32)}`,
      profile: data.config.authority.output.profile,
      generation: data.config.authority.output.generation,
      digest: '3'.repeat(64),
      size: 4096,
    };
    await writeCanaryRecord(data, canary.subject, 'completed', image);

    const accessRoot = path.join(data.config.stateDirectory, 'production-image-canary', 'access', createHash('sha256').update(canary.subject, 'utf8').digest('hex').slice(0, 32));
    await mkdir(accessRoot, { recursive: true });
    await writeFile(path.join(accessRoot, 'client_ed25519'), 'temporary-build-credential');
    const attachmentRoot = path.join(data.config.stateDirectory, 'environment-foundation', 'bootstrap', 'attachment');
    await mkdir(attachmentRoot, { recursive: true });
    await writeFile(path.join(attachmentRoot, 'state.json'), `${JSON.stringify({
      protocol: 'devbridge/hyperv-environment-bootstrap-state-v1',
      allocations: { [canary.subject]: { address: '192.168.90.20', prefix: '192.168.90.0/24', scope: 'reserved', allocatedAt: new Date().toISOString() } },
    })}\n`);

    const result = await canary.run();
    assert.equal(result.state, 'completed');
    assert.equal(runtimeCalls, 0);
    assert.equal(await absent(accessRoot), true);
    const attachment = JSON.parse(await readFile(path.join(attachmentRoot, 'state.json'), 'utf8'));
    assert.equal(attachment.allocations[canary.subject], undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('physical canary blocks code-payload drift before host mutation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-physical-canary-drift-'));
  try {
    const data = await fixture(root);
    let runtimeCalls = 0;
    const changed = { ...data.payload, generation: 'guest-image-ffffffffffffffffffffffff' };
    const canary = createUbuntuProductionImagePhysicalCanary(data.config, {
      platform: 'win32',
      preflight: readyPreflight,
      payloadFactory: async () => changed,
      runtimeFactory: async () => { runtimeCalls += 1; throw new Error('drifted runtime must not start'); },
    });
    const result = await canary.run();
    assert.equal(result.state, 'blocked');
    assert.match(result.reason, /payload generation/u);
    assert.equal(runtimeCalls, 0);
    assert.equal(await absent(data.config.stateDirectory), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
