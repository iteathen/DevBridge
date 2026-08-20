import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

export const INSTALL_MANIFEST_PROTOCOL = 'devbridge/install-manifest-v1';

function key(entry) {
  return `${entry.kind}:${entry.role}:${entry.stateDirectory ?? ''}:${entry.path ?? entry.identity ?? ''}`;
}

function within(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function normalize(raw, home) {
  if (!raw || raw.protocol !== INSTALL_MANIFEST_PROTOCOL || path.resolve(raw.home ?? '') !== path.resolve(home) || !Array.isArray(raw.entries)) {
    throw new Error('Install manifest does not match this DevBridge home.');
  }
  return raw;
}

export async function readInstallManifest(paths) {
  const file = paths.installManifest ?? path.join(paths.home, 'install-manifest.json');
  if (!existsSync(file)) return null;
  return normalize(JSON.parse(await readFile(file, 'utf8')), paths.home);
}

export async function recordInstallEntries(paths, additions) {
  const file = paths.installManifest ?? path.join(paths.home, 'install-manifest.json');
  const current = await readInstallManifest(paths) ?? {
    protocol: INSTALL_MANIFEST_PROTOCOL,
    home: path.resolve(paths.home),
    entries: [],
  };
  const entries = new Map(current.entries.map((entry) => [key(entry), entry]));
  for (const raw of additions) {
    const entry = structuredClone(raw);
    if (entry.kind === 'path') {
      entry.path = path.resolve(entry.path);
      if (!within(paths.home, entry.path) && !['config', 'config-backup', 'state', 'workspace'].includes(entry.role)) {
        throw new Error(`Install manifest path escapes the DevBridge home: ${entry.path}`);
      }
    } else if (entry.kind === 'environment' || entry.kind === 'image') {
      if (typeof entry.identity !== 'string' || typeof entry.stateDirectory !== 'string') throw new Error('Install manifest provider entry is incomplete.');
      entry.stateDirectory = path.resolve(entry.stateDirectory);
    } else {
      throw new Error(`Install manifest entry kind is unsupported: ${entry.kind}`);
    }
    entries.set(key(entry), entry);
  }
  const next = { ...current, entries: [...entries.values()], updatedAt: new Date().toISOString() };
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, file);
  return next;
}
