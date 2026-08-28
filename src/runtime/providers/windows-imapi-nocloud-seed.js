import { WindowsImapiDataMediaWriter } from './windows-imapi-data-media.js';

const MAX_SEED_BYTES = 1024 * 1024;

function checkedSeed(value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes === 0 || bytes > MAX_SEED_BYTES || value.includes('\0')) throw new Error(`${label} is outside the allowed seed bounds`);
  return value.endsWith('\n') ? value : `${value}\n`;
}

export class WindowsImapiNoCloudSeedWriter {
  #media;

  constructor(options = {}) {
    this.#media = new WindowsImapiDataMediaWriter(options);
  }

  async create({ root, destination, userData, metaData }) {
    const result = await this.#media.create({
      root,
      destination,
      volumeLabel: 'CIDATA',
      files: [
        { path: 'user-data', content: checkedSeed(userData, 'user-data') },
        { path: 'meta-data', content: checkedSeed(metaData, 'meta-data') },
      ],
    });
    return { location: result.location, bytes: result.bytes, sha256: result.sha256, volumeLabel: result.volumeLabel };
  }
}

export function createWindowsImapiNoCloudSeedWriter(options) {
  return new WindowsImapiNoCloudSeedWriter(options);
}
