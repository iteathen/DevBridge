import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

async function sha256File(location) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(location);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

export class HyperVConstructionMedia {
  #sourceRoot;

  constructor({ sourceRoot }) {
    this.#sourceRoot = path.resolve(sourceRoot);
  }

  async admit(location, expected) {
    const lexical = path.resolve(location);
    const [root, actual] = await Promise.all([realpath(this.#sourceRoot), realpath(lexical)]);
    if (!actual.startsWith(`${root}${path.sep}`)) throw new Error('construction media is outside the owned source root');
    const info = await lstat(actual);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('construction media must be a real regular file');
    if (info.size !== expected.bytes) throw new Error('construction media byte count changed');
    if (await sha256File(actual) !== expected.sha256) throw new Error('construction media digest changed');
    return actual;
  }
}
