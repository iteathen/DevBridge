import { createHash, randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const WIDTH = 320;
const HEIGHT = 240;
const RAW_BYTES = WIDTH * HEIGHT * 2;

function normalizeBytes(raw) {
  if (raw.length === RAW_BYTES) return raw;
  if (raw.length === RAW_BYTES + 4) {
    const terminal = raw.subarray(RAW_BYTES);
    if (terminal.some((value) => value !== 0)) throw new Error('construction console evidence terminal padding is invalid');
    return raw.subarray(0, RAW_BYTES);
  }
  throw new Error('construction console evidence size is invalid');
}

export class HyperVConsoleEvidence {
  #directory;
  #now;

  constructor({ directory, now }) {
    if (typeof now !== 'function') throw new TypeError('construction clock must be a function');
    this.#directory = path.resolve(directory);
    this.#now = now;
  }

  async publish(identity, result) {
    if (result?.available !== true) {
      const reason = String(result?.reason ?? 'Hyper-V thumbnail evidence is unavailable').slice(0, 512);
      return Object.freeze({ available: false, reason });
    }
    if (result.width !== WIDTH || result.height !== HEIGHT || typeof result.imageData !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(result.imageData)) {
      throw new Error('construction console evidence contract is invalid');
    }
    const raw = Buffer.from(result.imageData, 'base64');
    if (raw.toString('base64') !== result.imageData) throw new Error('construction console evidence encoding is invalid');
    const pixels = normalizeBytes(raw);
    const rowBytes = WIDTH * 3;
    const bmp = Buffer.alloc(54 + rowBytes * HEIGHT);
    bmp.write('BM', 0, 'ascii');
    bmp.writeUInt32LE(bmp.length, 2);
    bmp.writeUInt32LE(54, 10);
    bmp.writeUInt32LE(40, 14);
    bmp.writeInt32LE(WIDTH, 18);
    bmp.writeInt32LE(-HEIGHT, 22);
    bmp.writeUInt16LE(1, 26);
    bmp.writeUInt16LE(24, 28);
    bmp.writeUInt32LE(rowBytes * HEIGHT, 34);
    for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel += 1) {
      const packed = pixels.readUInt16LE(pixel * 2);
      const target = 54 + pixel * 3;
      bmp[target] = Math.round((packed & 0x1f) * 255 / 31);
      bmp[target + 1] = Math.round(((packed >> 5) & 0x3f) * 255 / 63);
      bmp[target + 2] = Math.round(((packed >> 11) & 0x1f) * 255 / 31);
    }
    const sha256 = createHash('sha256').update(bmp).digest('hex');
    const location = path.join(this.#directory, `${identity}-install-console.bmp`);
    const temporary = `${location}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bmp, { mode: 0o600, flag: 'wx' });
      await rename(temporary, location);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
    const captured = this.#now();
    if (!(captured instanceof Date) || !Number.isFinite(captured.getTime())) throw new Error('construction clock returned an invalid time');
    return Object.freeze({ available: true, capturedAt: captured.toISOString(), location, bytes: bmp.length, sha256, width: WIDTH, height: HEIGHT });
  }
}
