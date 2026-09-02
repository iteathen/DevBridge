import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { ubuntuPackageCapsuleRelease } from './ubuntu-package-capsule-fixture.js';

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function checksum(bytes, filename) {
  return `${sha256(bytes)} ${bytes.length} ${filename}`;
}

function clearSigned(fields) {
  return Buffer.from(`-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\n${fields}\n-----BEGIN PGP SIGNATURE-----\n\nZmFrZS1zaWduYXR1cmU=\n-----END PGP SIGNATURE-----\n`, 'utf8');
}

async function artifact(root, name, bytes, group, artifacts) {
  const location = path.join(root, `${name}.input`);
  await writeFile(location, bytes, { flag: 'wx' });
  artifacts[group].push({ name, location });
}

export async function createUbuntuPackageCaptureFixture(root) {
  await mkdir(root, { recursive: false });
  const release = structuredClone(ubuntuPackageCapsuleRelease());
  for (const pocket of release.metadata.pockets) {
    for (const component of pocket.components) {
      component.binaryIndex.path = component.binaryIndex.path.replace(/\.xz$/u, '.gz');
      component.sourceIndex.path = component.sourceIndex.path.replace(/\.xz$/u, '.gz');
    }
  }
  const artifacts = { metadata: [], binary: [], source: [] };
  const binaryByName = new Map();
  for (const [index, binary] of release.binaries.packages.entries()) {
    const identity = Buffer.from(`deb:${binary.package}:${binary.version}:${binary.architecture}\n`, 'utf8');
    const bytes = index === 0 ? Buffer.concat([identity, Buffer.alloc(1536, 0x78)]) : identity;
    binaryByName.set(binary.object, bytes);
    await artifact(root, binary.object, bytes, 'binary', artifacts);
  }
  const sourceByName = new Map();
  for (const source of release.sources.packages) {
    const fileLines = [];
    for (const file of source.files) {
      const bytes = Buffer.from(`source:${source.package}:${source.version}:${file.filename}\n`, 'utf8');
      sourceByName.set(file.object, bytes);
      fileLines.push(` ${checksum(bytes, file.filename)}`);
      await artifact(root, file.object, bytes, 'source', artifacts);
    }
    const dscBytes = Buffer.from([
      `Source: ${source.package}`,
      `Version: ${source.version}`,
      'Checksums-Sha256:',
      ...fileLines,
      '',
    ].join('\n'), 'utf8');
    sourceByName.set(source.dsc.object, dscBytes);
    await artifact(root, source.dsc.object, dscBytes, 'source', artifacts);
  }

  const packagesText = `${release.binaries.packages.map((binary) => {
    const bytes = binaryByName.get(binary.object);
    const sourceField = binary.source === binary.package && binary.sourceVersion === binary.version
      ? binary.source
      : `${binary.source} (${binary.sourceVersion})`;
    return [
      `Package: ${binary.package}`,
      `Version: ${binary.version}`,
      `Architecture: ${binary.architecture}`,
      `Source: ${sourceField}`,
      `Filename: ${binary.filename}`,
      `Size: ${bytes.length}`,
      `SHA256: ${sha256(bytes)}`,
    ].join('\n');
  }).join('\n\n')}\n`;
  const sourcesText = `${release.sources.packages.map((source) => {
    const inventory = [source.dsc, ...source.files];
    return [
      `Package: ${source.package}`,
      `Version: ${source.version}`,
      `Directory: ${source.directory}`,
      'Checksums-Sha256:',
      ...inventory.map((file) => ` ${checksum(sourceByName.get(file.object), file.filename)}`),
    ].join('\n');
  }).join('\n\n')}\n`;

  for (const pocket of release.metadata.pockets) {
    const indexChecksums = [];
    for (const component of pocket.components) {
      const binaryBytes = gzipSync(Buffer.from(packagesText, 'utf8'), { level: 9, mtime: 0 });
      const sourceBytes = gzipSync(Buffer.from(sourcesText, 'utf8'), { level: 9, mtime: 0 });
      await artifact(root, component.binaryIndex.object, binaryBytes, 'metadata', artifacts);
      await artifact(root, component.sourceIndex.object, sourceBytes, 'metadata', artifacts);
      indexChecksums.push(` ${checksum(binaryBytes, component.binaryIndex.path)}`);
      indexChecksums.push(` ${checksum(sourceBytes, component.sourceIndex.path)}`);
    }
    const inReleaseBytes = clearSigned([
      'Origin: Ubuntu',
      `Suite: ${pocket.pocket}`,
      `Codename: ${release.codename}`,
      `Architectures: ${release.architecture}`,
      'Components: main universe',
      'SHA256:',
      ...indexChecksums,
    ].join('\n'));
    await artifact(root, pocket.inRelease.object, inReleaseBytes, 'metadata', artifacts);
  }

  const capture = {
    distribution: release.distribution,
    release: release.release,
    codename: release.codename,
    architecture: release.architecture,
    snapshot: release.snapshot,
    baseMediaSha256: release.baseMediaSha256,
    releaseId: release.releaseId,
    sequence: release.sequence,
    upstreamKeyFingerprint: release.upstreamKeyFingerprint,
    transaction: release.transaction,
    metadata: { pockets: release.metadata.pockets },
    binaries: { packages: release.binaries.packages },
    sources: { packages: release.sources.packages },
  };
  return Object.freeze({ capture, artifacts });
}
