import { lstat, readFile, rename } from 'node:fs/promises';

async function readGuard(file) {
  let info;
  try { info = await lstat(file); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 128) throw new Error('legacy mutation guard is not an owned token file');
  const token = await readFile(file, 'utf8');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\n$/u.test(token)) throw new Error('legacy mutation guard token is invalid');
  return { info, token };
}

// The installation owner supplies quiescence; neither token age nor process IDs
// are evidence that the previous authority has stopped.
export async function migrateLegacyFileGuard({ guardFile, lease, assertQuiescent }) {
  if (typeof guardFile !== 'string' || !lease?.acquire || typeof assertQuiescent !== 'function') throw new TypeError('legacy guard migration contract is incomplete');
  if (await readGuard(guardFile) == null) return Object.freeze({ changed: false });
  await assertQuiescent();
  const held = await lease.acquire({ mode: 'exclusive' });
  if (!held) throw new Error('legacy guard migration requires exclusive ownership');
  try {
    held.assertHeld();
    await assertQuiescent();
    const previous = await readGuard(guardFile);
    if (previous == null) return Object.freeze({ changed: false });
    const retained = `${guardFile}.retired-${previous.token.trim()}`;
    const existing = await readGuard(retained);
    if (existing != null) throw new Error('legacy guard retirement already exists while its original is still present');
    await assertQuiescent();
    const current = await readGuard(guardFile);
    if (current == null || current.token !== previous.token || current.info.ino !== previous.info.ino || current.info.dev !== previous.info.dev) throw new Error('legacy mutation guard changed during migration');
    held.assertHeld();
    await rename(guardFile, retained);
    return Object.freeze({ changed: true });
  } finally { await held.release(); }
}
