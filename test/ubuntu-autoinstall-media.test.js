import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UbuntuAutoinstallMediaPreparer } from '../src/runtime/image-builders/ubuntu-autoinstall-media.js';

async function root() { return mkdtemp(path.join(os.tmpdir(), 'db-autoinstall-media-')); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

const recipeRef = 'subject-0123456789abcdef0123456789abcdef';

test('Ubuntu media preparation binds exact admitted source, recipe patches, and transient seed', async () => {
  const parent = await root();
  try {
    const sourceLocation = path.join(parent, 'ubuntu.iso');
    const sourceBytes = 'prefix boot ---         suffix';
    await writeFile(sourceLocation, sourceBytes);
    const sourceSha256 = sha256(sourceBytes);
    let seedRequest = null;
    const preparer = new UbuntuAutoinstallMediaPreparer({
      recipeLookup: async (reference) => {
        assert.equal(reference, recipeRef);
        return {
          protocol: 'devbridge/ubuntu-autoinstall-recipe-v1',
          sourceSha256,
          generation: 'ubuntu-26.04-amd64-v1',
          patches: [{ id: 'boot', before: 'boot ---        ', after: 'boot autoinstall', occurrences: 1 }],
        };
      },
      seedFactory: async ({ recipeGeneration, sourceIdentity }) => {
        assert.equal(recipeGeneration, 'ubuntu-26.04-amd64-v1');
        assert.equal(sourceIdentity.sha256, sourceSha256);
        return {
          userData: '#cloud-config\nautoinstall:\n  version: 1\n  secret: transient-build-value\n',
          metaData: 'instance-id: devbridge-image-build\n',
          evidence: { schema: 1, toolingGeneration: 'tooling-v1' },
        };
      },
      seedWriter: {
        async create(request) {
          seedRequest = request;
          await writeFile(request.destination, 'cidata');
          return { location: request.destination, bytes: 6, sha256: sha256('cidata'), volumeLabel: 'CIDATA' };
        },
      },
    });
    const result = await preparer.prepare({
      source: { location: sourceLocation, identity: { sha256: sourceSha256, release: '26.04' } },
      recipeRef,
      destination: path.join(parent, 'prepared'),
    });
    assert.equal(result.installer.sha256, sha256('prefix boot autoinstall suffix'));
    assert.equal(result.seed.volumeLabel, 'CIDATA');
    assert.equal(result.evidence.recipeGeneration, 'ubuntu-26.04-amd64-v1');
    assert.equal(result.evidence.patches[0].id, 'boot');
    assert.equal(JSON.stringify(result).includes('transient-build-value'), false);
    assert.equal(seedRequest.userData.includes('transient-build-value'), true);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('Ubuntu media preparation refuses recipe/source drift before creating output', async () => {
  const parent = await root();
  try {
    const sourceLocation = path.join(parent, 'ubuntu.iso');
    await writeFile(sourceLocation, 'source');
    let seedCreated = false;
    const preparer = new UbuntuAutoinstallMediaPreparer({
      recipeLookup: async () => ({
        protocol: 'devbridge/ubuntu-autoinstall-recipe-v1',
        sourceSha256: '0'.repeat(64),
        generation: 'recipe-v1',
        patches: [{ id: 'x', before: 'a', after: 'b', occurrences: 1 }],
      }),
      seedFactory: async () => ({ userData: 'x', metaData: 'y' }),
      seedWriter: { async create() { seedCreated = true; } },
    });
    await assert.rejects(() => preparer.prepare({
      source: { location: sourceLocation, identity: { sha256: sha256('source') } },
      recipeRef,
      destination: path.join(parent, 'prepared'),
    }), /does not match/u);
    assert.equal(seedCreated, false);
  } finally { await rm(parent, { recursive: true, force: true }); }
});
