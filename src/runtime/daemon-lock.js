import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { PolicyError } from '../errors.js';

export async function acquireDaemonLock(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  let handle;
  try { handle = await open(filePath, 'wx', 0o600); }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let detail = '';
    try { detail = await readFile(filePath, 'utf8'); } catch {}
    throw new PolicyError(`PATCH-POLLER daemon lock already exists at ${filePath}${detail ? `: ${detail.trim()}` : ''}`);
  }
  const record = { protocol: 'patch-poller/daemon-lock-v1', pid: process.pid, token, createdAt: new Date().toISOString() };
  await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
  await handle.close();
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      const current = JSON.parse(await readFile(filePath, 'utf8'));
      if (current.token !== token) throw new PolicyError('daemon lock ownership changed; refusing to unlink it');
      await unlink(filePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  };
}
