import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';

const PROTOCOL = 'devbridge/local-foundation-identity-v1';
const TOKEN = /^[a-f0-9]{32}$/u;

function parseIdentity(text) {
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('local identity record is invalid');
  if (value.protocol !== PROTOCOL || typeof value.token !== 'string' || !TOKEN.test(value.token)) {
    throw new Error('local identity record is invalid');
  }
  return value.token;
}

export async function loadOrCreateLocalIdentity({ directory }) {
  const root = path.resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('local identity directory must be a real directory');
  const file = path.join(root, 'identity.json');
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('local identity record must be a real file');
    return parseIdentity(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const token = randomBytes(16).toString('hex');
  const payload = `${JSON.stringify({ protocol: PROTOCOL, token })}\n`;
  try {
    const handle = await open(file, 'wx', 0o600);
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return token;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('local identity record must be a real file');
    return parseIdentity(await readFile(file, 'utf8'));
  }
}
