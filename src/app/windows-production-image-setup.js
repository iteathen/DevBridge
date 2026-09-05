import path from 'node:path';
import { createWindowsGuestImagePayload } from '../guest/windows-image-payload.js';
import { normalizeWindowsProductionImageAuthority } from '../runtime/image-builders/windows-production-image-authority.js';
import {
  createWindowsProductionImagePhysicalCanary,
  WINDOWS_PRODUCTION_IMAGE_PHYSICAL_CANARY_CONFIG_PROTOCOL,
} from './windows-production-image-physical-canary.js';
import { createDefaultWindowsToolchainAuthority } from '../setup/windows-toolchain-authority.js';
import { WINDOWS_PRODUCTION_OUTPUT } from '../setup/windows-production-output.js';
import { resolveWindowsInstallMediaSetup } from './windows-install-media-setup.js';

export const WINDOWS_PRODUCTION_IMAGE_SETUP_STATUS_PROTOCOL = 'devbridge/windows-production-image-setup-status-v1';

const RESOURCES = Object.freeze({
  memoryBytes: 4 * 1024 * 1024 * 1024,
  processorCount: 2,
  diskBytes: 64 * 1024 * 1024 * 1024,
  allocationBytes: 40 * 1024 * 1024 * 1024,
});

function absolute(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !path.isAbsolute(value)) throw new TypeError(`${name} must be an absolute local path`);
  return path.resolve(value);
}

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  return value;
}

function publicStatus(state, physical = null, reason = null) {
  return Object.freeze({
    protocol: WINDOWS_PRODUCTION_IMAGE_SETUP_STATUS_PROTOCOL,
    state,
    reason,
    physical,
  });
}

function productionAuthority({ media, tools, payload }) {
  return normalizeWindowsProductionImageAuthority({
    protocol: 'devbridge/windows-production-image-authority-v1',
    media,
    tools,
    payload: { generation: payload.generation },
    recipe: { generation: 'audit-handoff-v1' },
    output: {
      profile: WINDOWS_PRODUCTION_OUTPUT.profile,
      generation: WINDOWS_PRODUCTION_OUTPUT.generation,
      bootstrap: payload.generation,
    },
  });
}

export async function reconcileWindowsProductionImageSetup({
  home,
  stateDirectory,
  platform = process.platform,
  invoke,
  action = 'observe',
} = {}, {
  mediaResolver = resolveWindowsInstallMediaSetup,
  payloadFactory = createWindowsGuestImagePayload,
  toolAuthorityFactory = createDefaultWindowsToolchainAuthority,
  authorityFactory = productionAuthority,
  canaryFactory = createWindowsProductionImagePhysicalCanary,
} = {}) {
  const selectedHome = absolute(home, 'production image setup home');
  const selectedState = absolute(stateDirectory, 'production image setup state directory');
  if (typeof platform !== 'string' || platform.length === 0 || typeof invoke !== 'function') throw new TypeError('production image setup dependencies are invalid');
  if (!['observe', 'advance'].includes(action)) throw new TypeError('production image setup action is invalid');
  requireFunction(mediaResolver, 'production image setup media resolver');
  requireFunction(payloadFactory, 'production image setup payload factory');
  requireFunction(toolAuthorityFactory, 'production image setup tool authority factory');
  requireFunction(authorityFactory, 'production image setup authority factory');
  requireFunction(canaryFactory, 'production image setup canary factory');
  if (platform !== 'win32') return publicStatus('platform-unavailable');

  try {
    const resolved = await mediaResolver({ home: selectedHome, stateDirectory: selectedState, platform, invoke });
    if (resolved == null) return publicStatus('media-required');
    if (!resolved || typeof resolved.location !== 'string' || !path.isAbsolute(resolved.location) || !resolved.authority) {
      throw new Error('accepted media resolution is invalid');
    }
    const payload = await payloadFactory();
    const authority = authorityFactory({ media: resolved.authority, tools: toolAuthorityFactory(), payload });
    const canary = canaryFactory({
      protocol: WINDOWS_PRODUCTION_IMAGE_PHYSICAL_CANARY_CONFIG_PROTOCOL,
      stateDirectory: selectedState,
      sourceLocation: path.resolve(resolved.location),
      authority,
      resources: RESOURCES,
    }, { platform, invoke, payloadFactory: async () => payload });
    if (!canary || typeof canary.status !== 'function' || typeof canary.run !== 'function') throw new TypeError('production image setup canary contract is incomplete');
    const physical = action === 'observe' ? await canary.status() : await canary.run();
    if (!physical || typeof physical !== 'object') throw new TypeError('production image setup physical status is invalid');
    return publicStatus(physical.complete === true ? 'complete' : physical.blocked === true ? 'blocked' : 'ready', physical, physical.reason ?? null);
  } catch {
    return publicStatus('blocked', null, 'Windows production image status reconciliation failed; inspect local setup evidence and retry');
  }
}
