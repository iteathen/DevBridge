import path from 'node:path';
import { createWindowsAccessPreparation } from './windows-access-preparation.js';
import { loadOrCreateLocalIdentity } from '../runtime/local-identity.js';
import { HyperVGuestFileDelivery } from '../runtime/providers/hyperv-guest-file-delivery.js';
import { HyperVWindowsAccessProbe } from '../runtime/providers/hyperv-windows-access-probe.js';
import { WindowsProtectedAccessMaterial } from '../runtime/providers/windows-protected-access-material.js';
import { WindowsAccessSeedMaterial } from '../runtime/windows-access-seed-material.js';

const USER = 'devbridge';

export async function createWindowsEnvironmentAccess({
  authorityDirectory,
  platform = process.platform,
  invoke,
  identityLoader = loadOrCreateLocalIdentity,
  materialFactory = (options) => new WindowsProtectedAccessMaterial(options),
  seedFactory = (options) => new WindowsAccessSeedMaterial(options),
  deliveryFactory = (options) => new HyperVGuestFileDelivery(options),
  probeFactory = (options) => new HyperVWindowsAccessProbe(options),
  preparationFactory = createWindowsAccessPreparation,
} = {}) {
  if (platform !== 'win32') throw new Error('environment access is unavailable on this host');
  if (typeof authorityDirectory !== 'string' || authorityDirectory.length === 0) throw new TypeError('environment access authorityDirectory is required');
  if (typeof invoke !== 'function') throw new TypeError('environment access invocation contract is invalid');
  const factories = [identityLoader, materialFactory, seedFactory, deliveryFactory, probeFactory, preparationFactory];
  if (factories.some((factory) => typeof factory !== 'function')) throw new TypeError('environment access composition contract is incomplete');

  const foundationRoot = path.join(path.resolve(authorityDirectory), 'environment-foundation');
  const root = path.join(foundationRoot, 'access', 'windows');
  const identity = await identityLoader({ directory: foundationRoot });
  const material = materialFactory({ directory: path.join(root, 'material'), invoke, user: USER, platform });
  const seed = seedFactory({ directory: path.join(root, 'transient'), user: USER });
  const delivery = deliveryFactory({ identity, invoke });
  const probe = probeFactory({ identity, invoke });
  const preparation = preparationFactory({ material, seed, delivery, probe });
  if (!preparation || typeof preparation.connection !== 'function' || typeof preparation.ensure !== 'function') {
    throw new TypeError('environment access preparation contract is incomplete');
  }
  return Object.freeze({
    connection: (target) => preparation.connection(target),
    prepare: (request) => preparation.ensure(request),
  });
}
