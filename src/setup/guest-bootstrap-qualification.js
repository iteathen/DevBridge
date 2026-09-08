import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createEnvironmentFoundation } from '../app/environment-foundation.js';
import { createEnvironmentBootstrap } from '../app/environment-bootstrap.js';
import { createEnvironmentBridge } from '../app/environment-bridge.js';
import { createLocalEnvironmentAccess } from '../app/environment-construction-preparation.js';
import { createEnvironmentMaterializationPolicy } from '../app/environment-materialization-policy.js';
import { environmentDeclarationDigest } from '../runtime/environment-declaration.js';
import { invokeCommand } from '../runtime/command-invocation.js';
import { loadOrCreateLocalIdentity } from '../runtime/local-identity.js';

const PROTOCOL = 'devbridge/guest-bootstrap-qualification-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const READ_SEED = String.raw`import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const file = process.platform === 'win32' ? 'C:\\ProgramData\\DevBridge\\bootstrap\\network-seed.json' : '/var/lib/devbridge/bootstrap/network-seed.json';
const bytes = await readFile(file);
const seed = JSON.parse(bytes);
process.stdout.write(JSON.stringify({ digest: createHash('sha256').update(bytes).digest('hex'), target: seed.target, family: process.platform === 'win32' ? 'windows' : 'linux' }));`;

function boundedFailure(error) {
  return { message: String(error?.message ?? error).slice(0, 2048), code: error?.code ?? null, effect: error?.effect ?? null,
    native: error?.evidence == null ? null : { ...error.evidence, stdout: String(error.evidence.stdout ?? '').slice(0, 2048), stderr: String(error.evidence.stderr ?? '').slice(0, 2048) } };
}

// This complements the disk-only protected-authority fixture. It materializes a
// distinct owned consumer of an accepted image and uses production first access.
export async function qualifyGuestBootstrap({
  stateDirectory, authorityDirectory, evidenceDirectory, declaration, runtimeIdentity, qualificationId = randomUUID(), platform = process.platform,
  invoke = invokeCommand,
}, {
  foundationFactory = createEnvironmentFoundation, accessFactory = createLocalEnvironmentAccess,
  bootstrapFactory = createEnvironmentBootstrap, bridgeFactory = createEnvironmentBridge,
  identityLoader = loadOrCreateLocalIdentity,
} = {}) {
  if (!UUID.test(qualificationId)) throw new TypeError('guest qualification identity is invalid');
  if (!runtimeIdentity || Object.keys(runtimeIdentity).sort().join(',') !== 'nodeDigest,packageDigest' || Object.values(runtimeIdentity).some((value) => !/^[0-9a-f]{64}$/u.test(value))) throw new TypeError('guest qualification runtime identity is invalid');
  for (const value of [stateDirectory, authorityDirectory, evidenceDirectory]) if (typeof value !== 'string' || !path.isAbsolute(value)) throw new TypeError('guest qualification directories must be absolute');
  if (platform !== 'win32') throw new Error('this native first-access qualification currently covers Hyper-V only');
  const declarationDigest = environmentDeclarationDigest(declaration);
  const family = declaration.guest.family === 'ubuntu' ? 'linux' : declaration.guest.family === 'windows-11' ? 'windows' : null;
  if (family == null) throw new Error('guest qualification family is unsupported');
  const root = path.join(evidenceDirectory, qualificationId);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink()) throw new Error('guest qualification directory must be real');
  const file = path.join(root, 'qualification.json');
  const subject = `bootstrap-qualification-${qualificationId}`;
  let record;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024) throw new Error('guest qualification evidence is invalid');
    record = JSON.parse(await readFile(file, 'utf8'));
    if (record.protocol !== PROTOCOL || record.qualificationId !== qualificationId || record.subject !== subject || record.declarationDigest !== declarationDigest
      || record.runtimeIdentity?.packageDigest !== runtimeIdentity.packageDigest || record.runtimeIdentity?.nodeDigest !== runtimeIdentity.nodeDigest) throw new Error('guest qualification intent changed');
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const save = async () => {
    const temporary = path.join(root, `.qualification-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  };
  let seedDigest = record?.seedDigest ?? null;
  const observedInvoke = async (request) => {
    // Do not record command input, access seeds, credentials, or general output.
    let payload;
    try { payload = JSON.parse(request.input); } catch {}
    const destination = typeof payload?.source === 'string' && typeof payload?.destination === 'string'
      ? family === 'linux' ? path.posix.join(payload.destination, path.basename(payload.source)) : payload.destination : null;
    if (destination === (family === 'linux' ? '/var/lib/devbridge/bootstrap/network-seed.json' : 'C:\\ProgramData\\DevBridge\\bootstrap\\network-seed.json')) {
      const bytes = await readFile(payload.source);
      const seed = JSON.parse(bytes);
      if (seed.target !== record?.target || seed.protocol !== 'devbridge/network-seed-v1') throw new Error('qualification network seed subject changed');
      seedDigest = createHash('sha256').update(bytes).digest('hex');
      record.seedDigest = seedDigest;
      await save();
    }
    return invoke(request);
  };
  const foundation = await foundationFactory({ stateDirectory: authorityDirectory, platform, invoke: observedInvoke });
  if (!record) {
    const existing = (await foundation.listEnvironments()).filter((entry) => entry.record.subject === subject);
    if (existing.length) throw new Error('fresh guest qualification subject already exists');
    record = { protocol: PROTOCOL, qualificationId, subject, declarationDigest, profile: declaration.profile, family,
      runtimeIdentity: { ...runtimeIdentity }, image: { ...declaration.image }, target: null, stage: 'intent', freshSubjectObserved: true, seedDigest: null, passed: false, cleanup: 'pending', failure: null };
    await writeFile(file, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
  }
  if (record.cleanup === 'complete') return Object.freeze(record);
  try {
    const image = await foundation.verifyImage(declaration.image.identity);
    const accepted = await foundation.observeImage(declaration.image.identity);
    if (image?.identity !== declaration.image.identity || image.verified !== true || image.usable !== true
      || accepted?.identity !== declaration.image.identity || accepted.usable !== true || accepted.entry?.generation !== declaration.image.generation) throw new Error('qualification requires the exact verified accepted image');
    record.imageDigest = accepted.entry.digest;
    const access = await accessFactory({ stateDirectory, authorityDirectory, platform, invoke: observedInvoke, guest: declaration.guest });
    const bootstrap = await bootstrapFactory({ stateDirectory, authorityDirectory, platform, invoke: observedInvoke,
      access: (target) => access.connection(target), prepareAccess: access.prepare,
      requirements: declaration.bootstrap.requirements, revision: declaration.bootstrap.generation });
    if (!record.passed) {
      record.stage = 'materialization'; await save();
      const settings = await createEnvironmentMaterializationPolicy().settings.resolve(declaration);
      const current = await foundation.ensureEnvironment({ subject, profile: declaration.profile, sourceIdentity: declaration.image.identity, settings });
      if (current?.record?.subject !== subject || current.record.source?.identity !== declaration.image.identity || (record.target != null && current.record.identity !== record.target)) throw new Error('guest qualification materialization identity changed');
      record.target = current.record.identity; record.stage = 'first-access'; await save();
      const prepared = await bootstrap.ensure(record.target);
      if (prepared?.ready !== true) throw new Error('fresh guest bootstrap did not become ready');
      const foundationIdentity = await identityLoader({ directory: path.join(authorityDirectory, 'environment-foundation') });
      const bridge = await bridgeFactory({ stateDirectory, foundationIdentity, platform, invoke: observedInvoke, access: (target) => bootstrap.connection(target) });
      const health = await bridge.health(record.target);
      if (health.ready !== true) throw new Error('fresh guest bridge is not ready');
      const outcome = await bridge.execute(record.target, { program: family === 'windows' ? 'node.exe' : 'node',
        arguments: ['--input-type=module', '-e', READ_SEED], directory: { class: 'scratch', path: '.' }, environment: {},
        input: null, timeoutMs: 30_000, maxOutputBytes: 4096 }, { pollIntervalMs: 500 });
      const result = outcome?.result;
      if (outcome?.completion !== 'observed' || result?.exitCode !== 0 || result.timedOut || result.aborted || result.outputTruncated || result.stderr) throw new Error(`guest seed readback failed: ${String(result?.stderr ?? '').slice(0, 1024)}`);
      const readback = JSON.parse(result.stdout);
      if (!seedDigest || readback.digest !== seedDigest || readback.target !== record.target || readback.family !== family) throw new Error('fresh guest seed path or contents do not match delivery');
      record.passed = true; record.stage = 'verified'; record.bridgeVersion = health.version; record.failure = null; await save();
    }
    const retained = (await foundation.listEnvironments()).filter((entry) => entry.record.subject === subject);
    if (retained.length > 1 || (retained.length === 0 && record.cleanup !== 'removing')) throw new Error('guest qualification cleanup subject is missing or ambiguous');
    if (retained.length === 1) {
      const current = retained[0];
      if (current.record.identity !== record.target || current.record.profile !== record.profile || current.record.source.identity !== record.image.identity) throw new Error('guest qualification cleanup subject changed');
      record.cleanup = 'removing'; await save();
      if (current.observation.exists) await foundation.stopEnvironment(record.target, { force: false, timeoutMs: 60_000 });
      await foundation.removeEnvironment(record.target);
    }
    await access.discard(record.target);
    await bootstrap.reconcile();
    record.cleanup = 'complete'; await save();
  } catch (error) {
    record.failure = boundedFailure(error); await save();
    // Preserve a failed fixture and its evidence for owned recovery. The caller
    // must keep the old authority quiescent while running this candidate.
    throw Object.assign(new Error(`guest bootstrap qualification failed at ${record.stage}: ${record.failure.message}`, { cause: error }), { qualificationId, evidenceFile: file });
  }
  return Object.freeze(record);
}
