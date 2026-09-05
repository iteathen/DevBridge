const PROTOCOL = 'devbridge/image-library-adoption-v1';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/u;
const IMAGE_ID = /^img-[a-f0-9]{32}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const MAX_IMAGES = 256;

function contract(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== 'function')) {
    throw new TypeError(`${name} contract is incomplete`);
  }
  return value;
}

function safeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function media(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('image adoption media is invalid');
  const format = safeId(raw.format, 'image adoption media format').toLowerCase();
  const virtualSize = Number(raw.virtualSize);
  if (!Number.isSafeInteger(virtualSize) || virtualSize < 1) throw new TypeError('image adoption media virtualSize is invalid');
  if (raw.parentIdentity != null) throw new Error('image adoption accepts only parent-free media');
  let contentIdentity = null;
  if (raw.contentIdentity != null) {
    if (typeof raw.contentIdentity !== 'string' || raw.contentIdentity.length > 256 || /[\u0000-\u001f\u007f]/u.test(raw.contentIdentity)) {
      throw new TypeError('image adoption media contentIdentity is invalid');
    }
    contentIdentity = raw.contentIdentity;
  }
  return Object.freeze({ format, contentIdentity, parentIdentity: null, virtualSize });
}

function provenance(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('image adoption provenance is invalid');
  const entries = Object.entries(raw);
  if (entries.length > 32) throw new TypeError('image adoption provenance is too large');
  const value = {};
  for (const [key, item] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    safeId(key, 'image adoption provenance key');
    if (typeof item !== 'string' || item.includes('\0') || Buffer.byteLength(item, 'utf8') > 4096) {
      throw new TypeError('image adoption provenance value is invalid');
    }
    value[key] = item;
  }
  if (typeof value.origin !== 'string' || value.origin.length === 0) throw new TypeError('image adoption provenance origin is required');
  return Object.freeze(value);
}

function entry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('image adoption entry is invalid');
  if (typeof raw.identity !== 'string' || !IMAGE_ID.test(raw.identity)) throw new TypeError('image adoption identity is invalid');
  if (typeof raw.digest !== 'string' || !DIGEST.test(raw.digest)) throw new TypeError('image adoption digest is invalid');
  const size = Number(raw.size);
  if (!Number.isSafeInteger(size) || size < 1) throw new TypeError('image adoption size is invalid');
  if (raw.retiredAt != null && (typeof raw.retiredAt !== 'string' || raw.retiredAt.length === 0 || raw.retiredAt.length > 64)) {
    throw new TypeError('image adoption retirement state is invalid');
  }
  return Object.freeze({
    identity: raw.identity,
    profile: safeId(raw.profile, 'image adoption profile'),
    generation: safeId(raw.generation, 'image adoption generation'),
    digest: raw.digest,
    size,
    media: media(raw.media),
    provenance: provenance(raw.provenance),
    retiredAt: raw.retiredAt ?? null,
  });
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactMatch(expected, observed) {
  return expected.identity === observed.identity
    && expected.profile === observed.profile
    && expected.generation === observed.generation
    && expected.digest === observed.digest
    && expected.size === observed.size
    && same(expected.media, observed.media)
    && same(expected.provenance, observed.provenance)
    && observed.retiredAt == null;
}

function uniqueGenerations(entries, name) {
  const selected = new Map();
  for (const candidate of entries) {
    const key = `${candidate.profile}\0${candidate.generation}`;
    if (selected.has(key)) throw new Error(`${name} contains an ambiguous image generation`);
    selected.set(key, candidate);
  }
  return selected;
}

function verifiedObservation(value, expected, name) {
  if (!value || value.usable !== true || value.verified !== true) throw new Error(`${name} is not verified and usable`);
  if (value.identity !== expected.identity) throw new Error(`${name} identity changed during verification`);
  if (value.media != null && !same(media(value.media), expected.media)) throw new Error(`${name} media identity changed during verification`);
  return value;
}

export function createImageLibraryAdoption({ source, destination } = {}) {
  const input = contract(source, ['reconcile', 'list', 'observe', 'verify'], 'image adoption source');
  const output = contract(destination, ['reconcile', 'list', 'verify', 'publish'], 'image adoption destination');

  return Object.freeze({
    async reconcile() {
      await input.reconcile();
      await output.reconcile();

      const sourceRaw = await input.list();
      const destinationRaw = await output.list();
      if (!Array.isArray(sourceRaw) || sourceRaw.length > MAX_IMAGES || !Array.isArray(destinationRaw) || destinationRaw.length > MAX_IMAGES) {
        throw new Error('image adoption inventory exceeds its bound');
      }
      const sourceEntries = sourceRaw.map(entry).filter((candidate) => candidate.retiredAt == null);
      const destinationEntries = destinationRaw.map(entry).filter((candidate) => candidate.retiredAt == null);
      uniqueGenerations(sourceEntries, 'image adoption source');
      const destinations = uniqueGenerations(destinationEntries, 'image adoption destination');
      const adopted = [];
      let changed = false;

      for (const expected of sourceEntries) {
        const observed = await input.observe(expected.identity);
        if (!observed || observed.identity !== expected.identity || observed.exists !== true || observed.usable !== true || typeof observed.location !== 'string' || observed.location.length === 0) {
          throw new Error('image adoption source is not an exact usable object');
        }
        const sourceVerification = await input.verify(expected.identity);
        if (!sourceVerification || sourceVerification.identity !== expected.identity || sourceVerification.usable !== true || sourceVerification.verified !== true) {
          throw new Error('image adoption source verification failed');
        }

        const key = `${expected.profile}\0${expected.generation}`;
        let accepted = destinations.get(key) ?? null;
        if (accepted && !exactMatch(expected, accepted)) {
          throw new Error('image adoption destination contains a conflicting immutable generation');
        }
        if (!accepted) {
          accepted = entry(await output.publish({
            profile: expected.profile,
            generation: expected.generation,
            source: observed.location,
            provenance: expected.provenance,
            expectedDigest: expected.digest,
          }));
          if (!exactMatch(expected, accepted)) throw new Error('image adoption publication identity changed');
          destinations.set(key, accepted);
          changed = true;
        }
        verifiedObservation(await output.verify(expected.identity), expected, 'image adoption destination');
        adopted.push(expected.identity);
      }

      return Object.freeze({ protocol: PROTOCOL, ready: true, changed, adopted: Object.freeze(adopted.sort()) });
    },
  });
}

export { PROTOCOL as IMAGE_LIBRARY_ADOPTION_PROTOCOL };
