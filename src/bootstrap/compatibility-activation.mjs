import { rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  acquireInstallationOwner,
} from './local-supervisor-adapter.mjs';
import {
  parseBootstrapArgs,
  superviseDaemon,
} from './secure-bootstrap.mjs';
import * as transactional from './transactional-bootstrap.mjs';

const MIGRATION_PROTOCOL = 'devbridge/stage0-migration-v1';
const EXACT_HEAD = /^[0-9a-f]{40}$/u;

function fail(message) { throw new Error(message); }
function exactHead(value, name) {
  const text = String(value ?? '').toLowerCase();
  if (!EXACT_HEAD.test(text)) fail(`${name} must be an exact 40-hex Git head`);
  return text;
}

function runtimeWithinHome(home, runtimeDir) {
  const relative = path.relative(path.resolve(home), path.resolve(runtimeDir));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function observeRuntime(paths, runtimeDir, expectedHead, runner, ref) {
  if (!runtimeWithinHome(paths.home, runtimeDir)) fail('compatibility activation runtime escapes the installation home');
  const observed = transactional.ensureRuntime(
    { channel: 'testing', update: false },
    { ...paths, runtime: path.resolve(runtimeDir) },
    runner,
  );
  if (observed.head.toLowerCase() !== expectedHead) fail('compatibility activation runtime head does not match the exact transition subject');
  return { ...observed, ref, runtimeDir: path.resolve(runtimeDir) };
}

function migrationStatePath(paths) {
  return path.join(paths.home, 'stage0-migration.json');
}

export async function activateMigratedRuntime({
  argv,
  previous,
  candidate,
  runner,
  stage0Protocol,
} = {}) {
  if (!Array.isArray(argv)) throw new TypeError('compatibility activation argv must be an array');
  if (!previous || !candidate) throw new TypeError('compatibility activation requires previous and candidate runtime subjects');
  if (!Number.isSafeInteger(stage0Protocol) || stage0Protocol < 1) fail('compatibility activation requires an active Stage 0 protocol');

  const args = parseBootstrapArgs(argv);
  if (args.releaseMode !== 'development') fail('compatibility activation is limited to development/testing legacy migration');
  if (args.command !== 'daemon') fail('compatibility activation may only enter the supervised daemon path');
  if (args.update !== false) fail('compatibility activation must enter with ordinary runtime updates disabled');

  const paths = transactional.resolveBootstrapPaths(args);
  const previousHead = exactHead(previous.head, 'previous.head');
  const candidateHead = exactHead(candidate.head, 'candidate.head');
  const previousRuntime = observeRuntime(paths, previous.runtimeDir, previousHead, runner, 'main');
  const candidateRuntime = observeRuntime(paths, candidate.runtimeDir, candidateHead, runner, 'main');
  if (path.resolve(candidateRuntime.runtimeDir) !== path.resolve(paths.runtime)) {
    fail('compatibility activation candidate is not the canonical migrated runtime');
  }

  const owner = await acquireInstallationOwner(paths.home);
  const controller = new AbortController();
  const requestStop = () => controller.abort();
  const ownerStop = () => controller.abort();
  owner.signal.addEventListener('abort', ownerStop, { once: true });
  process.once('SIGINT', requestStop);
  process.once('SIGTERM', requestStop);

  let healthyRecorded = false;
  const recordActivationFn = async (localPaths, record) => {
    const written = transactional.writeRuntimeActivationState(localPaths, record);
    if (
      !healthyRecorded &&
      record?.protocol === 'devbridge/runtime-activation-v1' &&
      record.state === 'healthy' &&
      String(record.current?.head ?? '').toLowerCase() === candidateHead
    ) {
      healthyRecorded = true;
      rmSync(migrationStatePath(localPaths), { force: true });
      const tag = /^DB-[0-9A-F]{12}$/u.test(process.env.DEVBRIDGE_INSTALLATION_TAG ?? '')
        ? ` ${process.env.DEVBRIDGE_INSTALLATION_TAG}`
        : '';
      process.stdout.write(`[devbridge-compat${tag}] migrated-runtime-healthy previous=${previousHead} current=${candidateHead} protocol=${stage0Protocol}\n`);
    }
    return written;
  };

  try {
    return await superviseDaemon(
      { ...args, command: 'daemon' },
      paths,
      candidateRuntime,
      {
        runner,
        stopExisting: false,
        signal: controller.signal,
        initialActivation: { previous: previousRuntime, candidate: candidateRuntime },
        recordActivationFn,
      },
    );
  } finally {
    owner.signal.removeEventListener('abort', ownerStop);
    process.removeListener('SIGINT', requestStop);
    process.removeListener('SIGTERM', requestStop);
    await owner.release();
  }
}
