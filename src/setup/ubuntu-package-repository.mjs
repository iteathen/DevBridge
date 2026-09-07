import { UbuntuPackageCapsuleAvailability } from './ubuntu-package-capsule-availability.mjs';
import { normalizeUbuntuInstallationSource, verifyUbuntuPackageCapsuleReleaseInput } from './ubuntu-package-capsule-release-input.mjs';

function exactObject(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new TypeError(`${name}.${key} is unsupported`);
  return value;
}

function repositoryLayout(release) {
  const entries = [];
  const files = new Set();
  const directories = new Set();
  function add(path, group, object) {
    if (files.has(path) || directories.has(path)) throw new Error('Ubuntu repository file path collision');
    const segments = path.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      const directory = segments.slice(0, index).join('/');
      if (files.has(directory)) throw new Error('Ubuntu repository directory path collision');
      directories.add(directory);
    }
    files.add(path);
    entries.push(Object.freeze({ path, group, object }));
  }
  // The signed capsule verifier owns path syntax and descriptor coverage.
  // This consumer owns only their original repository placement.
  for (const pocket of release.metadata.pockets) {
    add(pocket.inRelease.path, 'metadata', pocket.inRelease.object);
    for (const component of pocket.components) {
      for (const index of [component.binaryIndex, component.sourceIndex]) {
        add(`dists/${pocket.pocket}/${index.path}`, 'metadata', index.object);
      }
    }
  }
  for (const binary of release.binaries.packages) add(binary.filename, 'binaries', binary.object);
  for (const source of release.sources.packages) {
    for (const file of [source.dsc, ...source.files]) add(`${source.directory}/${file.filename}`, 'sources', file.object);
  }
  return Object.freeze(entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export class UbuntuPackageRepository {
  #availability;
  #layout;

  constructor(raw = {}) {
    const options = exactObject(raw, ['authority', 'acquisition', 'installSource'], 'Ubuntu repository options');
    // Fail contradictory layout admission before the acquisition owner can mutate cache state.
    const release = verifyUbuntuPackageCapsuleReleaseInput(options.authority);
    if (release.installSource !== normalizeUbuntuInstallationSource(options.installSource)) {
      throw new Error('Ubuntu repository installation source does not match consumer');
    }
    this.#layout = repositoryLayout(release);
    this.#availability = new UbuntuPackageCapsuleAvailability({ authority: options.authority, acquisition: options.acquisition });
  }

  async prepare(raw = {}) {
    const request = exactObject(raw, ['signal'], 'Ubuntu repository preparation');
    const available = await this.#availability.prepare(request);
    const groups = Object.fromEntries(Object.entries(available.objects)
      .map(([group, objects]) => [group, new Map(objects.map((object) => [object.name, object]))]));
    const files = this.#layout.map((entry) => {
      const object = groups[entry.group].get(entry.object);
      if (!object) throw new Error('Ubuntu repository acquired object coverage changed');
      return Object.freeze({
        path: entry.path,
        source: Object.freeze({ location: object.location, size: object.size, sha256: object.sha256 }),
      });
    });
    return Object.freeze({ release: available.release, files: Object.freeze(files) });
  }
}
