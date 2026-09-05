import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  IMMUTABLE_OBJECT_SET_PROTOCOL,
  immutableObjectSetDigest,
  normalizeImmutableObjectSet,
  serializeImmutableObjectSet,
} from '../src/runtime/immutable-object-set.js';

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function descriptor() {
  const first = Buffer.from('abcd');
  const second = Buffer.from('ef');
  const whole = Buffer.concat([first, second]);
  return {
    protocol: IMMUTABLE_OBJECT_SET_PROTOCOL,
    subject: 'fixture-input-v1',
    objects: [{
      name: 'toolchain.tar.zst',
      size: whole.length,
      sha256: sha256(whole),
      chunks: [
        { ordinal: 0, name: 'toolchain.part-000000', offset: 0, size: first.length, sha256: sha256(first) },
        { ordinal: 1, name: 'toolchain.part-000001', offset: first.length, size: second.length, sha256: sha256(second) },
      ],
    }],
  };
}

test('immutable object set normalization and digest are deterministic', () => {
  const value = descriptor();
  const alphaBytes = Buffer.from('alpha');
  const alpha = {
    name: 'alpha.bin', size: alphaBytes.length, sha256: sha256(alphaBytes),
    chunks: [{ ordinal: 0, name: 'alpha.part-000000', offset: 0, size: alphaBytes.length, sha256: sha256(alphaBytes) }],
  };
  const first = serializeImmutableObjectSet({ ...value, objects: [...value.objects, alpha] });
  const second = serializeImmutableObjectSet({ ...value, objects: [alpha, ...value.objects] });
  assert.equal(first, second);
  assert.equal(immutableObjectSetDigest({ ...value, objects: [...value.objects, alpha] }), sha256(first));
  assert.equal(normalizeImmutableObjectSet(value).objects[0].name, 'toolchain.tar.zst');
});

test('immutable object set rejects gaps, overlap, reordering, and incomplete coverage', () => {
  const value = descriptor();
  const [first, second] = value.objects[0].chunks;
  const changed = (chunks) => ({ ...value, objects: [{ ...value.objects[0], chunks }] });
  assert.throws(() => normalizeImmutableObjectSet(changed([second, first])), /ordinal/u);
  assert.throws(() => normalizeImmutableObjectSet(changed([first, { ...second, offset: second.offset + 1 }])), /contiguous/u);
  assert.throws(() => normalizeImmutableObjectSet(changed([first, { ...second, offset: second.offset - 1 }])), /contiguous/u);
  assert.throws(() => normalizeImmutableObjectSet(changed([first])), /exactly cover/u);
});

test('immutable object set rejects duplicate logical and transport names', () => {
  const value = descriptor();
  assert.throws(() => normalizeImmutableObjectSet({ ...value, objects: [...value.objects, { ...value.objects[0] }] }), /object names must be unique/u);
  const [first, second] = value.objects[0].chunks;
  assert.throws(() => normalizeImmutableObjectSet({
    ...value,
    objects: [{ ...value.objects[0], chunks: [first, { ...second, name: first.name }] }],
  }), /chunk names must be unique/u);
});

test('immutable object set rejects path-shaped names and unknown authority fields', () => {
  const value = descriptor();
  assert.throws(() => normalizeImmutableObjectSet({ ...value, objects: [{ ...value.objects[0], name: '../escape' }] }), /name is invalid/u);
  assert.throws(() => normalizeImmutableObjectSet({ ...value, origin: 'https://example.invalid' }), /origin is not allowed/u);
  assert.throws(() => normalizeImmutableObjectSet({ ...value, objects: [{ ...value.objects[0], executable: 'node' }] }), /executable is not allowed/u);
});
