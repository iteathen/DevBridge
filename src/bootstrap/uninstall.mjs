import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { createEnvironmentFoundation } from '../app/environment-foundation.js';
import { readInstallManifest } from './install-manifest.mjs';

const APP_ROLES = new Set(['runtime', 'runtime-candidates', 'activation-state', 'bootstrap-git-home', 'bootstrap-hooks', 'launcher', 'logs', 'migration-state']);

function value(argv, name) {
  const index = argv.indexOf(name);
  return index < 0 ? null : argv[index + 1] ?? null;
}

function within(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function safePath(entry, home) {
  const target = path.resolve(entry.path);
  const root = path.parse(target).root;
  if (target === root || target === path.resolve(home) || target === path.resolve(home, '..') || target === path.resolve(home, '..', '..')) {
    throw new Error(`Uninstall manifest contains a broad unsafe target: ${target}`);
  }
  if (!within(home, target) && !['config', 'config-backup', 'state', 'workspace'].includes(entry.role)) {
    throw new Error(`Uninstall manifest path is outside the DevBridge home: ${target}`);
  }
  return target;
}

async function confirmation(argv, mode, { input, output }) {
  const supplied = value(argv, '--confirm');
  if (supplied != null) {
    if (supplied !== 'REMOVE') throw new Error('Uninstall confirmation must be exactly REMOVE.');
    return;
  }
  if (input.isTTY !== true || output.isTTY !== true) throw new Error('Uninstall requires --confirm REMOVE in noninteractive mode.');
  const prompt = createInterface({ input, output });
  try {
    const answer = await prompt.question(`Type REMOVE to confirm ${mode === 'purge' ? 'DevBridge, configuration, state, and ownership-proven virtual environments' : 'the DevBridge application while preserving configuration, state, and virtual environments'}: `);
    if (answer !== 'REMOVE') throw new Error('Uninstall cancelled because confirmation did not exactly match REMOVE.');
  } finally {
    prompt.close();
  }
}

async function removeProviderArtifacts(entries, foundationFactory) {
  const byState = new Map();
  for (const entry of entries.filter((item) => item.kind === 'environment' || item.kind === 'image')) {
    const root = path.resolve(entry.stateDirectory);
    if (!byState.has(root)) byState.set(root, []);
    byState.get(root).push(entry);
  }
  const removed = [];
  const preserved = [];
  for (const [stateDirectory, scoped] of byState) {
    const foundation = await foundationFactory({ stateDirectory });
    let environments = await foundation.listEnvironments();
    for (const entry of scoped.filter((item) => item.kind === 'environment')) {
      const observed = environments.find((item) => item.record.identity === entry.identity);
      if (!observed) { preserved.push({ ...entry, reason: 'manifest environment is absent from the provider registry' }); continue; }
      if (observed.record.subject !== entry.subject || observed.observation.owned !== true || observed.observation.compatible !== true) {
        throw new Error(`Provider ownership evidence does not match manifest environment ${entry.identity}.`);
      }
      await foundation.removeEnvironment(entry.identity);
      environments = await foundation.listEnvironments();
      if (environments.some((item) => item.record.identity === entry.identity)) {
        throw new Error(`Provider still reports manifest environment ${entry.identity} after removal.`);
      }
      removed.push(entry);
    }
    environments = await foundation.listEnvironments();
    const protectedSources = new Set(environments.map((item) => item.record.source?.identity).filter(Boolean));
    for (const entry of scoped.filter((item) => item.kind === 'image')) {
      if (entry.ownership !== 'provider-created') {
        preserved.push({ ...entry, reason: 'image is a referenced dependency, not an installer-created artifact' });
        continue;
      }
      if (protectedSources.has(entry.identity)) { preserved.push({ ...entry, reason: 'image remains referenced by a retained environment' }); continue; }
      const observed = await foundation.verifyImage(entry.identity);
      if (!observed.exists || observed.verified !== true || observed.usable !== true) {
        preserved.push({ ...entry, reason: 'image could not be reverified for removal' });
        continue;
      }
      await foundation.retireImage(entry.identity);
      await foundation.collectImages();
      removed.push(entry);
    }
    if (environments.length === 0) {
      await foundation.releaseNetwork();
      await foundation.releaseStorage();
    }
  }
  return { removed, preserved };
}

function schedulePathRemoval(targets, { output, prune = [] }) {
  const unique = [...new Set(targets.map((target) => path.resolve(target)))].sort((left, right) => right.length - left.length);
  const emptyDirectories = [...new Set(prune.map((target) => path.resolve(target)))].sort((left, right) => right.length - left.length);
  const script = "const fs=require('node:fs');const paths=JSON.parse(process.argv[1]);const prune=JSON.parse(process.argv[2]);setTimeout(()=>{for(const p of paths){try{fs.rmSync(p,{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch{}}for(const p of prune){try{fs.rmdirSync(p);}catch{}}},500);";
  const child = spawn(process.execPath, ['-e', script, JSON.stringify(unique), JSON.stringify(emptyDirectories)], {
    detached: true,
    stdio: 'ignore',
    shell: false,
    windowsHide: true,
  });
  child.unref();
  output.write(`${JSON.stringify({ scheduledRemoval: unique, emptyDirectoryPrune: emptyDirectories }, null, 2)}\n`);
}

export async function uninstall(paths, argv, {
  input = process.stdin,
  output = process.stdout,
  foundationFactory = createEnvironmentFoundation,
  scheduleFn = schedulePathRemoval,
} = {}) {
  const appOnly = argv.includes('--app-only');
  const purge = argv.includes('--purge');
  if (appOnly === purge) throw new Error('Choose exactly one uninstall mode: --app-only or --purge.');
  const mode = purge ? 'purge' : 'app-only';
  await confirmation(argv, mode, { input, output });
  const manifest = await readInstallManifest(paths);
  if (!manifest) throw new Error('Install manifest is missing; refusing ownership-unproven removal.');
  const provider = purge ? await removeProviderArtifacts(manifest.entries, foundationFactory) : { removed: [], preserved: [] };
  const pathEntries = manifest.entries.filter((entry) => entry.kind === 'path' && (purge || APP_ROLES.has(entry.role)));
  const targets = [];
  const preservedPaths = [];
  const protectedStateRoots = new Set(provider.preserved.map((entry) => entry.stateDirectory ? path.resolve(entry.stateDirectory) : null).filter(Boolean));
  for (const entry of pathEntries) {
    const target = safePath(entry, paths.home);
    if (entry.role === 'state' && protectedStateRoots.has(target)) {
      preservedPaths.push({ ...entry, reason: 'state root contains retained provider artifacts' });
      continue;
    }
    if ((entry.role === 'state' || entry.role === 'workspace') && !within(paths.home, target)) {
      preservedPaths.push({ ...entry, reason: 'external managed root requires separate operator cleanup' });
      continue;
    }
    if (existsSync(target)) targets.push(target);
  }
  if (purge) targets.push(paths.installManifest ?? path.join(paths.home, 'install-manifest.json'));
  scheduleFn(targets, { output, prune: [path.join(paths.home, 'bin'), paths.home] });
  if (preservedPaths.length > 0) output.write(`${JSON.stringify({ preservedPaths }, null, 2)}\n`);
  return { mode, provider, preservedPaths, scheduledPaths: targets };
}
