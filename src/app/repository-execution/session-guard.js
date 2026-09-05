import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

export async function acquireSessionGuard({ directory, identity, conflictMessage, ownershipMessage }) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const key = createHash('sha256').update(String(identity), 'utf8').digest('hex');
  const file = path.join(directory, `${key}.lock`);
  const token = randomUUID();
  let handle;
  try {
    handle = await open(file, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(conflictMessage);
    throw error;
  }
  try {
    await handle.writeFile(`${token}\n`, 'utf8');
  } finally {
    await handle.close();
  }

  let released = false;
  return async () => {
    if (released) return;
    const observed = (await readFile(file, 'utf8')).trim();
    if (observed !== token) throw new Error(ownershipMessage);
    await rm(file, { force: false });
    released = true;
  };
}
