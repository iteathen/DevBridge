import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';

function fail(message) { throw new Error(message); }

function exactObject(raw, allowed, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return raw;
}

function request(raw, expected, protocol) {
  const value = exactObject(
    raw,
    new Set(['protocol', 'kind', 'subject', 'target', 'work', 'preservation', 'endpoint']),
    'tree ownership request',
  );
  if (value.protocol !== protocol || value.kind !== 'tree' || value.subject !== expected.subject
      || value.target !== expected.target || value.endpoint !== expected.endpoint) {
    fail('Tree ownership reservation conflicts with this publication.');
  }
  for (const [selected, root, name] of [
    [value.work, expected.stagingRoot, 'work'],
    [value.preservation, expected.preservationRoot, 'preservation'],
  ]) {
    if (typeof selected !== 'string' || path.dirname(path.resolve(selected)) !== path.resolve(root)) {
      fail(`Tree ownership ${name} path is invalid.`);
    }
  }
  return value;
}

async function retain(artifacts, item, identity, target) {
  if ((await artifacts.observe(item.value.value)).state !== 'present') {
    fail('Tree ownership evidence no longer matches the filesystem.');
  }
  const current = await artifacts.discover({ identity, root: target });
  if (!isDeepStrictEqual(current, item.value.value)) fail('Tree ownership evidence names another filesystem subject.');
}

export function createPublicationTreeOwnership({ protocol, state, artifacts, publication, identifier = randomUUID } = {}) {
  if (typeof protocol !== 'string' || protocol.length < 1 || typeof identifier !== 'function') {
    throw new TypeError('tree ownership configuration is invalid');
  }
  if (!state || ['read', 'record', 'reserve', 'complete'].some((method) => typeof state[method] !== 'function')) {
    throw new TypeError('tree ownership state contract is incomplete');
  }
  if (!artifacts || ['discover', 'observe'].some((method) => typeof artifacts[method] !== 'function')) {
    throw new TypeError('tree ownership artifact contract is incomplete');
  }
  if (!publication || ['verify', 'publish'].some((method) => typeof publication[method] !== 'function')) {
    throw new TypeError('tree ownership publication contract is incomplete');
  }

  async function install({ identity, target, subject, endpoint, stagingRoot, preservationRoot, obtainSource }) {
    let current = await state.read(identity);
    if (publication.verify(target, subject, endpoint)) {
      if (current?.value.phase === 'complete') {
        await retain(artifacts, current, identity, target);
        return target;
      }
      if (current?.value.phase === 'reserved') {
        const selected = request(current.value.request, { subject, target, endpoint, stagingRoot, preservationRoot }, protocol);
        if (existsSync(selected.work)) fail('Tree work path remains from an incomplete operation.');
        const manifest = await artifacts.discover({ identity, root: target });
        await state.complete({ reservation: current, value: manifest });
        return target;
      }
      const manifest = await artifacts.discover({ identity, root: target });
      await state.record({
        identity,
        provenance: 'adopted',
        request: { protocol, kind: 'tree', subject, target, observed: true },
        value: manifest,
      });
      return target;
    }

    let reservation = current?.value.phase === 'reserved' ? current : null;
    let selected;
    if (reservation) {
      selected = request(reservation.value.request, { subject, target, endpoint, stagingRoot, preservationRoot }, protocol);
    } else {
      selected = Object.freeze({
        protocol,
        kind: 'tree',
        subject,
        target,
        work: path.join(stagingRoot, `${subject.slice(0, 12)}-${identifier()}`),
        preservation: path.join(preservationRoot, `${subject.slice(0, 12)}-${identifier()}`),
        endpoint,
      });
      reservation = await state.reserve({ identity, provenance: 'created', request: selected });
    }
    publication.publish({
      target,
      work: selected.work,
      stagingRoot,
      preservation: selected.preservation,
      preservationRoot,
      subject,
      endpoint,
      obtainSource,
    });
    if (existsSync(selected.work)) fail('Tree work path remains after publication.');
    const manifest = await artifacts.discover({ identity, root: target });
    await state.complete({ reservation, value: manifest });
    return target;
  }

  return Object.freeze({ install });
}
