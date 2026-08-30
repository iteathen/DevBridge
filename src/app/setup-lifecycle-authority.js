import { reconcileLinuxSetupLifecycleAuthority } from '../setup/linux-setup-lifecycle-authority.js';
import { reconcileWindowsLifecycleAuthorityReadiness } from '../setup/windows-lifecycle-authority-readiness.js';

const PROTOCOL = 'devbridge/setup-lifecycle-authority-v1';

const ADAPTERS = Object.freeze({
  linux: Object.freeze({
    project(value) {
      return Object.freeze({ stateIdentity: value.stateDirectory, configuration: value.configuration });
    },
    reconcile: reconcileLinuxSetupLifecycleAuthority,
  }),
  win32: Object.freeze({
    project(value) { return value; },
    reconcile: reconcileWindowsLifecycleAuthorityReadiness,
  }),
});

function exactObject(value, keys, name, { complete = true } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${name} is invalid`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string')) throw new TypeError(`${name} is invalid`);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!keys.has(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${name} contains an unknown field`);
    }
  }
  if (complete && Object.keys(descriptors).length !== keys.size) throw new TypeError(`${name} is incomplete`);
  return value;
}

function select(platform) {
  return Object.hasOwn(ADAPTERS, platform) ? ADAPTERS[platform] : null;
}

function unavailable() {
  return Object.freeze({
    protocol: PROTOCOL,
    ready: false,
    blocker: 'Protected lifecycle authority is unavailable on this host platform.',
    changed: false,
    service: 'unavailable',
    protectedState: 'unknown',
  });
}

export async function reconcileSetupLifecycleAuthority(value = {}, providedPorts = {}) {
  exactObject(value, new Set([
    'stateDirectory',
    'platform',
    'invoke',
    'environment',
    'configuration',
    'requestElevation',
  ]), 'setup lifecycle authority composition request');
  exactObject(providedPorts, new Set(['select']), 'setup lifecycle authority composition ports', { complete: false });
  if (typeof value.platform !== 'string' || value.platform.length === 0) {
    throw new TypeError('setup lifecycle authority platform is invalid');
  }
  const selector = providedPorts.select ?? select;
  if (typeof selector !== 'function') throw new TypeError('setup lifecycle authority selection port is invalid');
  const adapter = await selector(value.platform);
  if (adapter == null) return unavailable();
  exactObject(adapter, new Set(['project', 'reconcile']), 'setup lifecycle authority adapter');
  if (typeof adapter.project !== 'function' || typeof adapter.reconcile !== 'function') {
    throw new TypeError('setup lifecycle authority adapter is invalid');
  }
  return adapter.reconcile(adapter.project(value));
}
