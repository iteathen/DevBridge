import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

const PROTOCOL = 'devbridge/base-image-library-v1';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/u;
const SAFE_IMAGE_ID = /^img-[a-f0-9]{32}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const MAX_PROVENANCE_FIELDS = 32;
const MAX_PROVENANCE_VALUE_BYTES = 4_096;

function requireId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function requireImageId(value) {
  if (typeof value !== 'string' || !SAFE_IMAGE_ID.test(value)) throw new TypeError('image identity is invalid');
  return value;
}

function normalizeProvenance(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('image provenance must be an object');
  const entries = Object.entries(value);
  if (entries.length > MAX_PROVENANCE_FIELDS) throw new TypeError('image provenance is too large');
  const normalized = {};
  for (const [key, raw] of entries) {
    requireId(key, 'image provenance key');
    if (typeof raw !== 'string' || raw.includes('\0') || Buffer.byteLength(raw, 'utf8') > MAX_PROVENANCE_VALUE_BYTES) {
      throw new TypeError(`image provenance.${key} must be bounded text`);
    }
    normalized[key] = raw;
  }
  if (typeof normalized.origin !== 'string' || normalized.origin.length === 0) throw new TypeError('image provenance.origin is required');
  return normalized;
}

function normalizeMedia(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('image validation result must be an object');
  if (raw.usable !== true) throw new Error(raw.reason ? `image media is unusable: ${String(raw.reason)}` : 'image media is unusable');
  const format = requireId(raw.format, 'image media format').toLowerCase();
  if (raw.parentIdentity != null) throw new Error('base image media must not have a parent');
  const virtualSize = Number(raw.virtualSize);
  if (!Number.isSafeInteger(virtualSize) || virtualSize < 1) throw new TypeError('image media virtualSize is invalid');
  let contentIdentity = null;
  if (raw.contentIdentity != null) {
    if (typeof raw.contentIdentity !== 'string' || raw.contentIdentity.length > 256 || /[\u0000-\u001f\u007f]/u.test(raw.contentIdentity)) {
      throw new TypeError('image media contentIdentity is invalid');
    }
    contentIdentity = raw.contentIdentity;
  }
  return { format, contentIdentity, parentIdentity: null, virtualSize };
}

async function sha256(file) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { digest: hash.digest('hex'), size };
}

function fileIdentity(info) {
  return {
    device: info.dev.toString(),
    inode: info.ino.toString(),
    size: info.size.toString(),
    modifiedNs: info.mtimeNs.toString(),
  };
}

function sameFileIdentity(left, right) {
  return left && right && left.device === right.device && left.inode === right.inode && left.size === right.size && left.modifiedNs === right.modifiedNs;
}


function publicEntry(entry) {
  const copy = structuredClone(entry);
  delete copy.fileName;
  delete copy.fileIdentity;
  return copy;
}

function emptyCatalog() {
  return { protocol: PROTOCOL, revision: 0, images: {}, operations: {} };
}

function imageIdentity(profile, generation, digest) {
  const value = createHash('sha256').update(`${profile}\0${generation}\0${digest}`, 'utf8').digest('hex').slice(0, 32);
  return `img-${value}`;
}

function sourceSuffix(file) {
  const suffix = path.extname(file).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/u.test(suffix) ? suffix : '.img';
}

export class BaseImageLibrary {
  #root;
  #objects;
  #staging;
  #catalogFile;
  #guardFile;
  #tail = Promise.resolve();

  constructor({ directory }) {
    this.#root = path.resolve(directory);
    this.#objects = path.join(this.#root, 'objects');
    this.#staging = path.join(this.#root, 'staging');
    this.#catalogFile = path.join(this.#root, 'catalog.json');
    this.#guardFile = path.join(this.#root, 'mutation.lock');
  }

  async #ensure() {
    await mkdir(this.#objects, { recursive: true, mode: 0o700 });
    await mkdir(this.#staging, { recursive: true, mode: 0o700 });
    for (const directory of [this.#root, this.#objects, this.#staging]) {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('image library directories must be real directories');
    }
  }

  async #load() {
    await this.#ensure();
    try {
      const info = await lstat(this.#catalogFile);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('image library catalog must be a real file');
      const value = JSON.parse(await readFile(this.#catalogFile, 'utf8'));
      if (!value || typeof value !== 'object' || value.protocol !== PROTOCOL || !value.images || !value.operations) {
        throw new Error('image library catalog is invalid');
      }
      return value;
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyCatalog();
      throw error;
    }
  }

  async #save(catalog) {
    catalog.revision = Number(catalog.revision ?? 0) + 1;
    const temporary = path.join(this.#root, `.catalog-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(catalog)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, this.#catalogFile);
  }

  async #acquire() {
    await this.#ensure();
    const token = randomUUID();
    let handle;
    try {
      handle = await open(this.#guardFile, 'wx', 0o600);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new Error('image library mutation is already active; remove mutation.lock only after confirming no operation is running');
      }
      throw error;
    }
    try {
      await handle.writeFile(`${token}\n`, 'utf8');
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      await rm(this.#guardFile, { force: true }).catch(() => {});
      throw error;
    }
    await handle.close();
    return async () => {
      const observed = (await readFile(this.#guardFile, 'utf8')).trim();
      if (observed !== token) throw new Error('image library mutation guard ownership changed');
      await rm(this.#guardFile);
    };
  }

  #serial(work) {
    const guarded = async () => {
      const release = await this.#acquire();
      try { return await work(); }
      finally { await release(); }
    };
    const next = this.#tail.then(guarded, guarded);
    this.#tail = next.catch(() => {});
    return next;
  }

  async publish({ profile, generation, source, provenance = {}, expectedDigest = null }, { validate = null } = {}) {
    return this.#serial(async () => {
      const normalizedProfile = requireId(profile, 'image profile');
      const normalizedGeneration = requireId(generation, 'image generation');
      if (typeof source !== 'string' || source.length === 0 || source.includes('\0')) throw new TypeError('image source is invalid');
      if (expectedDigest != null && (typeof expectedDigest !== 'string' || !DIGEST.test(expectedDigest.toLowerCase()))) {
        throw new TypeError('image expectedDigest must be a sha256 digest');
      }
      if (validate != null && typeof validate !== 'function') throw new TypeError('image validate must be a function');
      const normalizedProvenance = normalizeProvenance(provenance);
      await this.#ensure();

      const input = path.resolve(source);
      const inputInfo = await lstat(input);
      if (!inputInfo.isFile() || inputInfo.isSymbolicLink()) throw new Error('image source must be a real regular file');
      const [canonicalInput, canonicalRoot] = await Promise.all([realpath(input), realpath(this.#root)]);
      const relative = path.relative(canonicalRoot, canonicalInput);
      if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
        throw new Error('image source must be outside the image library');
      }

      const staged = path.join(this.#staging, `${randomUUID()}.staging${sourceSuffix(input)}`);
      await copyFile(canonicalInput, staged, 1);
      const stagedInfo = await lstat(staged);
      if (!stagedInfo.isFile() || stagedInfo.isSymbolicLink()) throw new Error('staged image is invalid');
      const measured = await sha256(staged);
      const expected = expectedDigest?.toLowerCase() ?? null;
      if (expected && measured.digest !== expected) {
        await rm(staged, { force: true });
        throw new Error('image digest does not match expectedDigest');
      }

      let media = { format: 'image', contentIdentity: null, parentIdentity: null, virtualSize: measured.size };
      if (validate) media = normalizeMedia(await validate({ location: staged, digest: measured.digest, size: measured.size }));
      const identity = imageIdentity(normalizedProfile, normalizedGeneration, measured.digest);
      const extension = /^\.[a-z0-9]{1,10}$/u.test(`.${media.format}`) ? `.${media.format}` : '.img';
      const finalName = `${identity}${extension}`;
      const final = path.join(this.#objects, finalName);
      const catalog = await this.#load();
      const existing = Object.values(catalog.images).find((entry) => entry.profile === normalizedProfile && entry.generation === normalizedGeneration);
      if (existing) {
        await rm(staged, { force: true });
        if (existing.digest !== measured.digest) throw new Error('image generation is immutable and already contains different bytes');
        return publicEntry(existing);
      }

      const operationId = `op-${randomUUID()}`;
      catalog.operations[operationId] = {
        id: operationId,
        state: 'planned',
        identity,
        profile: normalizedProfile,
        generation: normalizedGeneration,
        digest: measured.digest,
        size: measured.size,
        stagingName: path.basename(staged),
        finalName,
        media,
        provenance: normalizedProvenance,
        plannedAt: new Date().toISOString(),
      };
      await this.#save(catalog);

      await rename(staged, final);
      await chmod(final, 0o444);
      const publishedInfo = await stat(final, { bigint: true });
      const afterRename = await this.#load();
      const operation = afterRename.operations[operationId];
      operation.state = 'attempted';
      operation.attemptedAt = new Date().toISOString();
      await this.#save(afterRename);

      const observed = await sha256(final);
      if (observed.digest !== measured.digest || observed.size !== measured.size) {
        throw new Error('published image bytes changed during publication');
      }
      const reconciled = await this.#load();
      reconciled.images[identity] = {
        identity,
        profile: normalizedProfile,
        generation: normalizedGeneration,
        digest: measured.digest,
        size: measured.size,
        fileName: finalName,
        fileIdentity: fileIdentity(publishedInfo),
        media,
        provenance: normalizedProvenance,
        publishedAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
        retiredAt: null,
      };
      reconciled.operations[operationId].state = 'reconciled';
      reconciled.operations[operationId].reconciledAt = new Date().toISOString();
      await this.#save(reconciled);
      return publicEntry(reconciled.images[identity]);
    });
  }

  async list() {
    const catalog = await this.#load();
    return Object.values(catalog.images).map(publicEntry);
  }

  async observe(identity) {
    const id = requireImageId(identity);
    const catalog = await this.#load();
    const entry = catalog.images[id];
    if (!entry) return { exists: false, identity: id, usable: false, reason: 'image is not published', location: null, entry: null };
    const location = path.join(this.#objects, entry.fileName);
    try {
      const info = await lstat(location, { bigint: true });
      if (!info.isFile() || info.isSymbolicLink()) return { exists: true, identity: id, usable: false, reason: 'image file shape changed', location, entry: structuredClone(entry) };
      if (!sameFileIdentity(entry.fileIdentity, fileIdentity(info))) {
        return { exists: true, identity: id, usable: false, reason: 'image file identity changed', location, entry: structuredClone(entry) };
      }
      return { exists: true, identity: id, usable: entry.retiredAt == null, reason: entry.retiredAt == null ? null : 'image is retired', location, entry: structuredClone(entry) };
    } catch (error) {
      if (error?.code === 'ENOENT') return { exists: false, identity: id, usable: false, reason: 'image file is missing', location, entry: structuredClone(entry) };
      throw error;
    }
  }

  async verify(identity) {
    return this.#serial(async () => {
      const observed = await this.observe(identity);
      if (!observed.exists || !observed.usable) return observed;
      const measured = await sha256(observed.location);
      if (measured.digest !== observed.entry.digest || measured.size !== observed.entry.size) {
        return { ...observed, usable: false, reason: 'image digest changed' };
      }
      const info = await stat(observed.location, { bigint: true });
      const catalog = await this.#load();
      catalog.images[observed.identity].fileIdentity = fileIdentity(info);
      catalog.images[observed.identity].lastVerifiedAt = new Date().toISOString();
      await this.#save(catalog);
      return { ...observed, entry: structuredClone(catalog.images[observed.identity]), verified: true };
    });
  }

  async inspect() {
    const catalog = await this.#load();
    const active = Object.values(catalog.images).filter((entry) => entry.retiredAt == null);
    if (active.length === 0) return { state: 'unavailable', ready: false, reason: 'no base images are published', count: 0 };
    for (const entry of active) {
      const observed = await this.observe(entry.identity);
      if (!observed.usable) return { state: 'degraded', ready: false, reason: observed.reason, count: active.length };
    }
    return { state: 'ready', ready: true, reason: null, count: active.length };
  }

  async retire(identity) {
    return this.#serial(async () => {
      const id = requireImageId(identity);
      const catalog = await this.#load();
      if (!catalog.images[id]) throw new Error('image is not published');
      if (catalog.images[id].retiredAt == null) {
        catalog.images[id].retiredAt = new Date().toISOString();
        await this.#save(catalog);
      }
      return publicEntry(catalog.images[id]);
    });
  }

  async collect({ protectedIdentities = [] } = {}) {
    return this.#serial(async () => {
      const protectedSet = new Set(protectedIdentities.map(requireImageId));
      const catalog = await this.#load();
      const removed = [];
      for (const [identity, entry] of Object.entries(catalog.images)) {
        if (entry.retiredAt == null || protectedSet.has(identity)) continue;
        await rm(path.join(this.#objects, entry.fileName), { force: true });
        delete catalog.images[identity];
        removed.push(identity);
      }
      if (removed.length > 0) await this.#save(catalog);
      return { removed };
    });
  }

  async reconcile() {
    return this.#serial(async () => {
      const catalog = await this.#load();
      let changed = false;
      for (const operation of Object.values(catalog.operations)) {
        if (operation.state === 'reconciled' || operation.state === 'failed') continue;
        const final = path.join(this.#objects, operation.finalName);
        const staged = path.join(this.#staging, operation.stagingName);
        let location = null;
        try {
          const info = await lstat(final);
          if (info.isFile() && !info.isSymbolicLink()) location = final;
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        if (!location) {
          try {
            const info = await lstat(staged);
            if (info.isFile() && !info.isSymbolicLink()) {
              const measured = await sha256(staged);
              if (measured.digest === operation.digest && measured.size === operation.size) {
                await rename(staged, final);
                await chmod(final, 0o444);
                location = final;
              }
            }
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
          }
        }
        if (!location) {
          operation.state = 'failed';
          operation.failedAt = new Date().toISOString();
          changed = true;
          continue;
        }
        const measured = await sha256(location);
        if (measured.digest !== operation.digest || measured.size !== operation.size) {
          operation.state = 'failed';
          operation.failedAt = new Date().toISOString();
          changed = true;
          continue;
        }
        const info = await stat(location, { bigint: true });
        catalog.images[operation.identity] ??= {
          identity: operation.identity,
          profile: operation.profile,
          generation: operation.generation,
          digest: operation.digest,
          size: operation.size,
          fileName: operation.finalName,
          fileIdentity: fileIdentity(info),
          media: operation.media,
          provenance: operation.provenance,
          publishedAt: operation.plannedAt,
          lastVerifiedAt: new Date().toISOString(),
          retiredAt: null,
        };
        operation.state = 'reconciled';
        operation.reconciledAt = new Date().toISOString();
        changed = true;
      }

      for (const name of await readdir(this.#root)) {
        if (/^\.catalog-[a-f0-9-]+\.tmp$/u.test(name)) await rm(path.join(this.#root, name), { force: true });
      }
      const trackedStaging = new Set(Object.values(catalog.operations).filter((entry) => !['reconciled', 'failed'].includes(entry.state)).map((entry) => entry.stagingName));
      for (const name of await readdir(this.#staging)) {
        if (trackedStaging.has(name)) continue;
        if (/^[a-f0-9-]+\.staging\.[a-z0-9]{1,10}$/u.test(name)) await rm(path.join(this.#staging, name), { force: true });
      }
      const trackedObjects = new Set(Object.values(catalog.images).map((entry) => entry.fileName));
      const plannedObjects = new Set(Object.values(catalog.operations).filter((entry) => !['reconciled', 'failed'].includes(entry.state)).map((entry) => entry.finalName));
      for (const name of await readdir(this.#objects)) {
        if (trackedObjects.has(name) || plannedObjects.has(name)) continue;
        if (/^img-[a-f0-9]{32}\.[a-z0-9]{1,10}$/u.test(name)) await rm(path.join(this.#objects, name), { force: true });
      }
      if (changed) await this.#save(catalog);
      return this.inspect();
    });
  }
}
