import { lstat, rm } from 'node:fs/promises';
import process from 'node:process';

async function exists(candidate) {
  try { await lstat(candidate); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function removeDirectory(target) {
  if (!(await exists(target))) return { state: 'verified-absent', removed: false };
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('owned resource is not a real directory');
  await rm(target, { recursive: true, force: false });
  if (await exists(target)) throw new Error('owned resource remains after cleanup');
  return { state: 'verified-absent', removed: true };
}

async function selectDirectory(legacy, compact) {
  const present = [];
  for (const target of [legacy, compact]) {
    if (!(await exists(target))) { present.push(false); continue; }
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('owned resource is not a real directory');
    present.push(true);
  }
  if (present.every(Boolean)) throw new Error('both resource layouts are present');
  return { selected: present[0] ? 'legacy' : 'compact' };
}

const [, , action, target, ...rest] = process.argv;
const valid = typeof target === 'string' && target.length > 0 && (
  (action === 'remove-directory' && rest.length === 0)
  || (action === 'select-directory' && rest.length === 1 && typeof rest[0] === 'string' && rest[0].length > 0));
if (!valid) {
  process.stderr.write('resource-agent received an invalid request\n');
  process.exitCode = 2;
} else {
  try {
    process.stdout.write(`${JSON.stringify(action === 'select-directory' ? await selectDirectory(target, rest[0]) : await removeDirectory(target))}\n`);
  } catch (error) {
    process.stderr.write(`${error?.name ?? 'Error'}: ${String(error?.message ?? error).replace(/[\r\n]+/gu, ' ').slice(0, 1024)}\n`);
    process.exitCode = 1;
  }
}
