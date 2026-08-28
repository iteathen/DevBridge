import { lstat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

export const WINDOWS_UNATTENDED_MEDIA_PROTOCOL = 'devbridge/windows-unattended-media-v1';

const SUBJECT = /^subject-[a-f0-9]{32}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function onlyKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return value;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function exact(left, right) { return JSON.stringify(stable(left)) === JSON.stringify(stable(right)); }

function normalizeAdmission(raw) {
  const value = onlyKeys(raw, new Set(['protocol', 'media', 'approval', 'image']), 'unattended media admission');
  if (value.protocol !== 'devbridge/windows-install-media-authority-v1') throw new TypeError('unattended media admission protocol is unsupported');
  const media = onlyKeys(value.media, new Set(['name', 'bytes', 'sha256']), 'unattended media admission media');
  if (typeof media.name !== 'string' || media.name.length === 0 || media.name.includes('\0')) throw new TypeError('unattended media admission name is invalid');
  if (!Number.isSafeInteger(media.bytes) || media.bytes < 1) throw new TypeError('unattended media admission bytes is invalid');
  if (typeof media.sha256 !== 'string' || !SHA256.test(media.sha256)) throw new TypeError('unattended media admission sha256 is invalid');
  const image = onlyKeys(value.image, new Set(['container', 'index', 'name', 'edition', 'architecture', 'version', 'build', 'installationType', 'languages', 'defaultLanguage']), 'unattended media admission image');
  if (!Number.isSafeInteger(image.index) || image.index < 1 || image.index > 512) throw new TypeError('unattended media admission image index is invalid');
  if (typeof image.architecture !== 'string' || typeof image.defaultLanguage !== 'string') throw new TypeError('unattended media admission image is invalid');
  return structuredClone({ protocol: value.protocol, media, approval: value.approval, image });
}

function normalizeObservation(raw) {
  const value = onlyKeys(raw, new Set(['protocol', 'media', 'image']), 'unattended media observation');
  if (value.protocol !== 'devbridge/windows-install-media-observation-v1') throw new TypeError('unattended media observation protocol is unsupported');
  return structuredClone({ media: value.media, image: value.image });
}

function normalizeSeed(raw) {
  const value = onlyKeys(raw, new Set(['protocol', 'files', 'evidence']), 'unattended media seed');
  if (value.protocol !== 'devbridge/windows-unattended-seed-v1' || !Array.isArray(value.files) || value.files.length === 0 || !value.evidence || typeof value.evidence !== 'object') {
    throw new TypeError('unattended media seed is invalid');
  }
  return { files: structuredClone(value.files), evidence: structuredClone(value.evidence) };
}

export class WindowsUnattendedMediaPreparer {
  #admission;
  #observer;
  #seedFactory;
  #mediaWriter;

  constructor({ admission, observer, seedFactory, mediaWriter } = {}) {
    if (!admission || typeof admission.lookup !== 'function') throw new TypeError('admission must expose lookup');
    if (!observer || typeof observer.inspect !== 'function') throw new TypeError('observer must expose inspect');
    if (typeof seedFactory !== 'function') throw new TypeError('seedFactory must be a function');
    if (!mediaWriter || typeof mediaWriter.create !== 'function') throw new TypeError('mediaWriter must expose create');
    this.#admission = admission;
    this.#observer = observer;
    this.#seedFactory = seedFactory;
    this.#mediaWriter = mediaWriter;
  }

  async prepare({ subject, source, destination, access } = {}) {
    if (typeof subject !== 'string' || !SUBJECT.test(subject)) throw new TypeError('unattended media subject is invalid');
    if (typeof source !== 'string' || source.length === 0 || source.includes('\0')) throw new TypeError('unattended media source is invalid');
    if (typeof destination !== 'string' || destination.length === 0 || destination.includes('\0')) throw new TypeError('unattended media destination is invalid');
    const admission = normalizeAdmission(await this.#admission.lookup(subject));
    const sourcePath = path.resolve(source);
    const observation = normalizeObservation(await this.#observer.inspect({ location: sourcePath, expectedSha256: admission.media.sha256, index: admission.image.index }));
    if (!exact(observation.media, admission.media) || !exact(observation.image, admission.image)) throw new Error('observed install media does not match admitted authority');

    const outputRoot = path.resolve(destination);
    await mkdir(outputRoot, { recursive: false, mode: 0o700 });
    let completed = false;
    try {
      const info = await lstat(outputRoot);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unattended media output must be a real directory');
      const seed = normalizeSeed(await this.#seedFactory({ identity: subject, image: { index: admission.image.index, architecture: admission.image.architecture, defaultLanguage: admission.image.defaultLanguage }, access }));
      const created = await this.#mediaWriter.create({
        root: outputRoot,
        destination: path.join(outputRoot, 'answer.iso'),
        volumeLabel: 'DB_SETUP',
        files: seed.files,
      });
      const result = {
        installer: { location: sourcePath, bytes: admission.media.bytes, sha256: admission.media.sha256 },
        seed: { location: created.location, bytes: created.bytes, sha256: created.sha256, volumeLabel: created.volumeLabel },
        evidence: {
          protocol: WINDOWS_UNATTENDED_MEDIA_PROTOCOL,
          admissionReference: subject,
          media: structuredClone(admission.media),
          approval: structuredClone(admission.approval),
          image: structuredClone(admission.image),
          seed: seed.evidence,
        },
      };
      completed = true;
      return result;
    } finally {
      if (!completed) await rm(outputRoot, { recursive: true, force: true });
    }
  }
}

export function createWindowsUnattendedMediaPreparer(options) {
  return new WindowsUnattendedMediaPreparer(options);
}
