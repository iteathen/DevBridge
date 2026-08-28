import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  normalizeWindowsInstallMediaAuthority,
} from '../runtime/image-builders/windows-install-media-authority.js';
import { createWindowsInstallMediaAuthorityCatalog } from '../runtime/image-builders/windows-install-media-authority-catalog.js';
import {
  createWindowsInstallMediaInspector,
  normalizeWindowsInstallMediaInventory,
} from '../runtime/image-sources/windows-install-media-inspector.js';
import { createWindowsInstallMediaSource } from '../runtime/image-sources/windows-install-media-source.js';
import { createWindowsInstallMediaAuthorityStateStore } from '../state/windows-install-media-authority-state-store.js';
import { createWindowsInstallMediaSelectionStateStore } from '../state/windows-install-media-selection-state-store.js';
import { createWindowsInstallMediaSourceStateStore } from '../state/windows-install-media-source-state-store.js';
import {
  WINDOWS_INSTALL_MEDIA_ACQUISITION,
  createWindowsInstallMediaSelection,
} from '../setup/windows-install-media-selection.js';

function absolute(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !path.isAbsolute(value)) throw new TypeError(`${name} must be an absolute local path`);
  return path.resolve(value);
}

function authorityValue({ media, image, sourceClass, reference, temporary }) {
  return normalizeWindowsInstallMediaAuthority({
    protocol: 'devbridge/windows-install-media-authority-v1',
    media,
    approval: { sourceClass, expectedSha256: media.sha256, reference, temporary },
    image,
  });
}

function unavailableStatus() {
  return Object.freeze({
    protocol: 'devbridge/windows-install-media-selection-status-v1',
    state: 'platform-unavailable',
    candidates: Object.freeze([]),
    rejectedCount: 0,
    accepted: null,
    acquisition: WINDOWS_INSTALL_MEDIA_ACQUISITION,
    inbox: null,
  });
}

function blockedStatus(inbox) {
  return Object.freeze({
    protocol: 'devbridge/windows-install-media-selection-status-v1',
    state: 'blocked',
    blocker: 'Windows install media reconciliation failed; inspect the local setup evidence and retry',
    candidates: Object.freeze([]),
    rejectedCount: 0,
    accepted: null,
    acquisition: WINDOWS_INSTALL_MEDIA_ACQUISITION,
    inbox,
  });
}

export async function reconcileWindowsInstallMediaSetup({
  home,
  stateDirectory,
  platform = process.platform,
  invoke,
  discover = false,
  location = null,
  approval = null,
} = {}) {
  const selectedHome = absolute(home, 'install media setup home');
  const selectedState = absolute(stateDirectory, 'install media setup state directory');
  if (typeof platform !== 'string' || platform.length === 0 || typeof invoke !== 'function' || typeof discover !== 'boolean') throw new TypeError('install media setup dependencies are invalid');
  if (platform !== 'win32') {
    if (location != null || approval != null) throw new Error('Windows install media setup requires a Windows host');
    return unavailableStatus();
  }

  const inbox = path.join(selectedHome, 'media', 'windows');
  try {
    const root = path.join(selectedState, 'windows-install-media');
    if (discover || location != null) await mkdir(inbox, { recursive: true, mode: 0o700 });
    const source = createWindowsInstallMediaSource({
      roots: [inbox],
      locations: location == null ? [] : [absolute(location, 'install media source location')],
      registry: createWindowsInstallMediaSourceStateStore(path.join(root, 'sources.json')),
      platform,
      invoke,
      inspectorFactory: (options) => createWindowsInstallMediaInspector(options),
    });
    const selection = createWindowsInstallMediaSelection({
      source,
      catalog: createWindowsInstallMediaAuthorityCatalog({ store: createWindowsInstallMediaAuthorityStateStore(path.join(root, 'authorities.json')) }),
      state: createWindowsInstallMediaSelectionStateStore(path.join(root, 'selection.json')),
      normalizeInventory: normalizeWindowsInstallMediaInventory,
      createAuthority: authorityValue,
    });
    const status = approval != null
      ? await selection.approve(approval)
      : (discover || location != null) ? await selection.discover() : await selection.status();
    return Object.freeze({ ...status, inbox });
  } catch {
    return blockedStatus(inbox);
  }
}
