import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { link, lstat, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';
import { sameObservedFilesystemIdentity } from '../runtime/local-filesystem-identity.js';

const EXACT_HEAD = /^[0-9a-f]{40}$/u;
const EXACT_DIGEST = /^[0-9a-f]{64}$/u;
const MAX_RUNNER_BYTES = 512 * 1024;

function fail(message) { throw new Error(message); }

function requirePort(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== 'function')) {
    throw new TypeError(`${name} contract is incomplete`);
  }
  return value;
}

function normalizedSubject(input, normalize) {
  const selected = normalize(input);
  if (!selected || typeof selected !== 'object' || Array.isArray(selected)) fail('runner provider subject is invalid');
  const head = String(selected.head ?? '').toLowerCase();
  const sha256 = String(selected.sha256 ?? '').toLowerCase();
  if (!EXACT_HEAD.test(head) || !EXACT_DIGEST.test(sha256)) fail('runner provider subject identity is invalid');
  return Object.freeze({ ...selected, head, sha256 });
}

function bytesDigest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function boundedBytes(value) {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > MAX_RUNNER_BYTES) {
    fail('runner provider artifact bytes are invalid');
  }
  return Buffer.from(value);
}

async function objectObservation(file, digest, { singleLink = true } = {}) {
  let info;
  try { info = await lstat(file, { bigint: true }); }
  catch (error) { if (error?.code === 'ENOENT') return Object.freeze({ state: 'absent' }); throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1n || info.size > BigInt(MAX_RUNNER_BYTES)
      || (singleLink && info.nlink !== 1n) || (!singleLink && info.nlink < 1n)) {
    return Object.freeze({ state: 'invalid' });
  }
  const bytes = await readFile(file);
  return bytesDigest(bytes) === digest
    ? Object.freeze({ state: 'valid', bytes, info })
    : Object.freeze({ state: 'invalid' });
}

function defaultLaunch(file, argv) {
  const result = spawnSync(process.execPath, [file, ...argv], {
    stdio: 'inherit',
    shell: false,
    windowsHide: false,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function objectRequest(file, subject) {
  return Object.freeze({ kind: 'file', location: path.resolve(file), sha256: subject.sha256 });
}

function temporaryObject(objects, subject, reservation) {
  return path.join(objects, `.${subject.sha256}.${reservation.value.operation}.tmp`);
}

export class ContentAddressedRunnerProvider {
  #source;
  #root;
  #launch;
  #ownership;
  #artifacts;
  #normalize;

  constructor({ source, cacheRoot, ownership, artifacts, normalizeSubject, launch = defaultLaunch } = {}) {
    if (!source || typeof source.read !== 'function') throw new TypeError('runner provider source.read must be a function');
    if (typeof cacheRoot !== 'string' || !path.isAbsolute(cacheRoot)) throw new TypeError('runner provider cacheRoot must be an absolute local path');
    if (typeof launch !== 'function') throw new TypeError('runner provider launch must be a function');
    if (typeof normalizeSubject !== 'function') throw new TypeError('runner provider subject contract is incomplete');
    this.#source = source;
    this.#root = path.resolve(cacheRoot);
    this.#launch = launch;
    this.#ownership = requirePort(ownership, ['withActivity', 'observe'], 'runner provider ownership');
    this.#artifacts = requirePort(artifacts, ['plan', 'observe'], 'runner provider artifact action');
    this.#normalize = normalizeSubject;
  }

  async #descriptor(identity, root, file, subject) {
    return this.#artifacts.plan({
      identity,
      root,
      files: [{ relative: path.basename(file), bytes: null, sha256: subject.sha256 }],
      directories: [],
      exclusive: false,
      removeRoot: false,
    });
  }

  async #completeExisting(session, current, request, identity, objects, file, subject) {
    if (!isDeepStrictEqual(current.value.request, request)) fail('runner provider receipt conflicts with its exact local request');
    const observed = await objectObservation(file, subject.sha256);
    if (observed.state !== 'valid') fail('runner provider receipt does not match the exact cached object');
    if (current.value.phase === 'complete') {
      const action = await this.#artifacts.observe(structuredClone(current.value.value));
      if (action.state !== 'present') fail('runner provider receipt descriptor does not match local state');
      return observed.bytes;
    }
    const value = await this.#descriptor(identity, objects, file, subject);
    await session.complete({ reservation: current, value });
    return observed.bytes;
  }

  async #prepareWithin(session, subject) {
    await session.directory({ identity: 'cache.directory.root', location: this.#root });
    const objects = path.join(this.#root, 'objects');
    await session.directory({ identity: 'cache.directory.objects', location: objects });
    const file = path.join(objects, `${subject.sha256}.mjs`);
    const identity = `cache.object.${subject.sha256}`;
    const request = objectRequest(file, subject);
    let current = await session.read(identity);

    if (current?.value.phase === 'complete') {
      await this.#completeExisting(session, current, request, identity, objects, file, subject);
      return file;
    }

    const finalBefore = await objectObservation(file, subject.sha256);
    if (!current && finalBefore.state === 'invalid') {
      fail('runner provider found an unowned cache object that is not the exact subject');
    }
    if (!current && finalBefore.state === 'valid') {
      current = await session.reserve({ identity, provenance: 'adopted', request });
      await this.#completeExisting(session, current, request, identity, objects, file, subject);
      return file;
    }
    if (!current) current = await session.reserve({ identity, provenance: 'created', request });
    if (!isDeepStrictEqual(current.value.request, request)) fail('runner provider has another pending exact local request');

    const temporary = temporaryObject(objects, subject, current);
    let tempObservation = await objectObservation(temporary, subject.sha256, { singleLink: false });
    let finalObservation = await objectObservation(file, subject.sha256, { singleLink: false });
    if (finalObservation.state === 'invalid' || tempObservation.state === 'invalid') {
      fail('runner provider preserved ambiguous pending cache material');
    }

    if (finalObservation.state === 'valid' && tempObservation.state === 'valid') {
      if (!sameObservedFilesystemIdentity(finalObservation.info, tempObservation.info, { platform: process.platform })) {
        fail('runner provider preserved conflicting pending cache material');
      }
      await unlink(temporary);
      tempObservation = Object.freeze({ state: 'absent' });
      finalObservation = await objectObservation(file, subject.sha256);
    }

    if (finalObservation.state === 'absent') {
      if (tempObservation.state === 'absent') {
        let fetched;
        try {
          fetched = boundedBytes(await this.#source.read(subject.head));
          if (bytesDigest(fetched) !== subject.sha256) fail('runner provider fetched bytes do not match the exact subject');
        } catch (error) {
          await session.clear({ item: current });
          throw error;
        }
        try {
          await writeFile(temporary, fetched, { flag: 'wx', mode: 0o700 });
        } catch (error) {
          // Creation can be ambiguous after a write failure; retain the reservation.
          throw error;
        }
        tempObservation = await objectObservation(temporary, subject.sha256);
        if (tempObservation.state !== 'valid') fail('runner provider could not verify its pending cache object');
      }
      try {
        await link(temporary, file);
      } catch (error) {
        if (error?.code === 'EEXIST') fail('runner provider preserved a conflicting cache publication');
        throw error;
      }
      const linkedTemporary = await objectObservation(temporary, subject.sha256, { singleLink: false });
      const linkedFinal = await objectObservation(file, subject.sha256, { singleLink: false });
      if (linkedTemporary.state !== 'valid' || linkedFinal.state !== 'valid'
          || !sameObservedFilesystemIdentity(linkedTemporary.info, linkedFinal.info, { platform: process.platform })) {
        fail('runner provider cache publication identity is ambiguous');
      }
      await unlink(temporary);
    }

    const final = await objectObservation(file, subject.sha256);
    if (final.state !== 'valid') fail('runner provider could not commit a verified content-addressed object');
    const value = await this.#descriptor(identity, objects, file, subject);
    await session.complete({ reservation: current, value });
    return file;
  }

  async prepare(input) {
    const subject = normalizedSubject(input, this.#normalize);
    const file = await this.#ownership.withActivity((session) => this.#prepareWithin(session, subject));
    const provider = this;
    return Object.freeze({
      subject: Object.freeze({ ...subject }),
      async launch(argv) {
        if (!Array.isArray(argv) || argv.some((entry) => typeof entry !== 'string')) fail('runner launch argv must be an array of strings');
        const current = await objectObservation(file, subject.sha256);
        if (current.state !== 'valid') fail('runner provider cached object changed before launch');
        return provider.#launch(file, [...argv]);
      },
    });
  }
}
