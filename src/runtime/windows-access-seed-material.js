import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const WINDOWS_ACCESS_SEED_MATERIAL_PROTOCOL = 'devbridge/windows-access-seed-v1';

const TARGET = /^env-[a-f0-9]{32}$/u;
const USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u;
const MAX_BYTES = 128 * 1024;

function targetId(value) {
  if (typeof value !== 'string' || !TARGET.test(value)) throw new TypeError('access seed target is invalid');
  return value;
}

function localUser(value) {
  if (typeof value !== 'string' || !USER.test(value)) throw new TypeError('access seed user is invalid');
  return value;
}

function secretValue(value) {
  if (typeof value !== 'string' || value.length < 20 || value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value)
    || !/[A-Z]/u.test(value) || !/[a-z]/u.test(value) || !/[0-9]/u.test(value) || !/[^A-Za-z0-9]/u.test(value)) {
    throw new TypeError('access seed secret is invalid');
  }
  return value;
}

function digest(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }

export class WindowsAccessSeedMaterial {
  #directory;
  #user;

  constructor({ directory, user } = {}) {
    if (typeof directory !== 'string' || directory.length === 0 || directory.includes('\0') || !path.isAbsolute(directory)) {
      throw new TypeError('access seed directory is invalid');
    }
    this.#directory = path.resolve(directory);
    this.#user = localUser(user);
  }

  async #ensureRoot() {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.#directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('access seed root is not a real directory');
  }

  async create({ target, user, secret } = {}) {
    const selectedTarget = targetId(target);
    if (localUser(user) !== this.#user) throw new Error('access seed user changed');
    const selectedSecret = secretValue(secret);
    await this.#ensureRoot();
    const file = path.join(this.#directory, `.seed-${randomUUID()}.json`);
    const content = `${JSON.stringify({
      protocol: WINDOWS_ACCESS_SEED_MATERIAL_PROTOCOL,
      target: selectedTarget,
      user: this.#user,
      secret: selectedSecret,
      revision: 1,
    })}\n`;
    if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) throw new Error('access seed content is too large');
    await writeFile(file, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const expectedDigest = digest(content);
    const expectedSize = Buffer.byteLength(content, 'utf8');
    let removed = false;
    return Object.freeze({
      file,
      async cleanup() {
        if (removed) return Object.freeze({ removed: false });
        let info;
        try { info = await lstat(file); }
        catch (error) {
          if (error?.code === 'ENOENT') { removed = true; return Object.freeze({ removed: false }); }
          throw error;
        }
        if (!info.isFile() || info.isSymbolicLink() || info.size !== expectedSize || info.size > MAX_BYTES) {
          throw new Error('access seed file identity changed');
        }
        const observed = await readFile(file, 'utf8');
        if (digest(observed) !== expectedDigest) throw new Error('access seed file identity changed');
        await rm(file, { force: false });
        removed = true;
        return Object.freeze({ removed: true });
      },
    });
  }
}

export function createWindowsAccessSeedMaterial(options) {
  return new WindowsAccessSeedMaterial(options);
}
