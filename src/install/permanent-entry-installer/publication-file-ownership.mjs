import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';

function fail(message) { throw new Error(message); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function exactObject(raw, allowed, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return raw;
}

function request(raw, expected, protocol) {
  const value = exactObject(
    raw,
    new Set(['protocol', 'kind', 'role', 'target', 'stage', 'bytes', 'sha256', 'beforeDigest']),
    'file ownership request',
  );
  if (value.protocol !== protocol || value.kind !== 'file' || value.role !== expected.role
      || value.target !== expected.target || typeof value.stage !== 'string'
      || path.dirname(path.resolve(value.stage)) !== path.resolve(expected.directory)
      || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || !/^[0-9a-f]{64}$/u.test(value.sha256)
      || (value.beforeDigest != null && !/^[0-9a-f]{64}$/u.test(value.beforeDigest))) {
    fail(`File ownership reservation is invalid for ${expected.role}.`);
  }
  return value;
}

async function manifest(artifacts, identity, directory, target, bytes, sha256) {
  return artifacts.plan({
    identity,
    root: directory,
    files: [{ relative: path.basename(target), bytes, sha256 }],
    directories: [],
    exclusive: false,
    removeRoot: false,
  });
}

async function retain(artifacts, item, role, identity, directory, target, bytes, sha256) {
  if ((await artifacts.observe(item.value.value)).state !== 'present') {
    fail(`Installed ${role} ownership evidence no longer matches the filesystem.`);
  }
  const current = await manifest(artifacts, identity, directory, target, bytes, sha256);
  if (!isDeepStrictEqual(current, item.value.value)) fail(`Installed ${role} ownership evidence names another filesystem subject.`);
}

export function createPublicationFileOwnership({
  protocol,
  state,
  artifacts,
  publication,
  acceptReference,
  identifier = randomUUID,
} = {}) {
  if (typeof protocol !== 'string' || protocol.length < 1 || typeof acceptReference !== 'function' || typeof identifier !== 'function') {
    throw new TypeError('file ownership configuration is invalid');
  }
  if (!state || ['read', 'record', 'reserve', 'complete'].some((method) => typeof state[method] !== 'function')) {
    throw new TypeError('file ownership state contract is incomplete');
  }
  if (!artifacts || ['plan', 'observe'].some((method) => typeof artifacts[method] !== 'function')) {
    throw new TypeError('file ownership artifact contract is incomplete');
  }
  if (!publication || ['open', 'inspect', 'plan', 'apply'].some((method) => typeof publication[method] !== 'function')) {
    throw new TypeError('file ownership publication contract is incomplete');
  }

  async function install({ root, subject, selection, identities }) {
    if (!identities || typeof identities !== 'object' || Array.isArray(identities)
        || ['primary', 'previous', 'command', 'shell'].some((role) => typeof identities[role] !== 'string')) {
      throw new TypeError('file ownership identities are invalid');
    }
    const identity = (role) => identities[role];
    publication.open(root);
    function verifyReferences(value) {
      for (const role of ['primary', 'previous']) {
        const metadata = value.observed[role].metadata;
        if (metadata && !acceptReference(metadata)) fail(`Recognized ${role} file does not reference an accepted subject.`);
      }
    }

    let inspection = publication.inspect({ root, subject, selection });
    verifyReferences(inspection);

    for (const role of ['primary', 'previous', 'command', 'shell']) {
      const selectedIdentity = identity(role);
      const item = await state.read(selectedIdentity);
      if (item?.value.phase !== 'reserved') continue;
      const selected = request(item.value.request, { role, target: inspection.targets[role], directory: inspection.directory }, protocol);
      if (existsSync(selected.stage)) fail(`File stage remains from an incomplete ${role} operation.`);
      if (inspection.observed[role].digest === selected.sha256) {
        const value = await manifest(artifacts, selectedIdentity, inspection.directory, selected.target, selected.bytes, selected.sha256);
        await state.complete({ reservation: item, value });
      }
    }

    inspection = publication.inspect({ root, subject, selection });
    verifyReferences(inspection);
    for (const role of ['primary', 'previous', 'command', 'shell']) {
      const observed = inspection.observed[role];
      const recognized = role === 'previous' ? observed.state === 'generated'
        : role === 'primary' ? ['exact', 'generated'].includes(observed.state)
          : observed.state === 'exact';
      if (!recognized) continue;
      const selectedIdentity = identity(role);
      const item = await state.read(selectedIdentity);
      if (item?.value.phase === 'complete') {
        await retain(
          artifacts,
          item,
          role,
          selectedIdentity,
          inspection.directory,
          inspection.targets[role],
          observed.bytes.length,
          observed.digest,
        );
        continue;
      }
      if (item?.value.phase === 'reserved') continue;
      const value = await manifest(
        artifacts,
        selectedIdentity,
        inspection.directory,
        inspection.targets[role],
        observed.bytes.length,
        observed.digest,
      );
      await state.record({
        identity: selectedIdentity,
        provenance: 'adopted',
        request: { protocol, kind: 'file', role, target: inspection.targets[role], observed: true },
        value,
      });
    }

    const prepared = publication.plan({ root, subject, selection });
    verifyReferences(prepared);
    const reservations = new Map();
    const stages = {};
    for (const change of prepared.changes) {
      const selectedIdentity = identity(change.role);
      const current = await state.read(selectedIdentity);
      const proposed = Object.freeze({
        protocol,
        kind: 'file',
        role: change.role,
        target: change.target,
        stage: path.join(prepared.directory, `.publication-${change.role}-${identifier()}.next`),
        bytes: change.bytes.length,
        sha256: digest(change.bytes),
        beforeDigest: change.beforeDigest,
      });
      let selected = proposed;
      let reservation;
      if (current?.value.phase === 'reserved') {
        selected = request(current.value.request, { role: change.role, target: change.target, directory: prepared.directory }, protocol);
        if (!isDeepStrictEqual(selected, { ...proposed, stage: selected.stage })) {
          fail(`File ownership reservation conflicts with ${change.role} publication.`);
        }
        reservation = current;
      } else {
        reservation = await state.reserve({ identity: selectedIdentity, provenance: 'created', request: selected });
      }
      if (existsSync(selected.stage)) fail(`File stage is already occupied for ${change.role}.`);
      reservations.set(change.role, Object.freeze({ identity: selectedIdentity, reservation, request: selected }));
      stages[change.role] = selected.stage;
    }

    const published = publication.apply({ prepared, stages });
    for (const change of prepared.changes) {
      const selected = reservations.get(change.role);
      if (existsSync(selected.request.stage)) fail(`File stage remains after ${change.role} publication.`);
      const value = await manifest(
        artifacts,
        selected.identity,
        prepared.directory,
        selected.request.target,
        selected.request.bytes,
        selected.request.sha256,
      );
      await state.complete({ reservation: selected.reservation, value });
    }
    return published;
  }

  return Object.freeze({ install });
}
