import { ENVIRONMENT_OPERATOR_STATUS_PROTOCOL } from './environment-operator.js';

export const SETUP_ENVIRONMENT_ACTIVATION_PROTOCOL = 'devbridge/setup-environment-activation-v1';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;
const MAX_ENVIRONMENTS = 64;

function safeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function assertClient(value) {
  const methods = ['list', 'status', 'run', 'resume'];
  if (!value || methods.some((name) => typeof value[name] !== 'function')) {
    throw new TypeError('setup environment activation client contract is incomplete');
  }
  return value;
}

function normalizeStatus(raw, { profile, identity = null } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || raw.protocol !== ENVIRONMENT_OPERATOR_STATUS_PROTOCOL
      || raw.profile !== profile
      || !SAFE_ID.test(raw.environmentIdentity ?? '')) {
    throw new Error('protected environment status does not match the accepted profile');
  }
  if (identity != null && raw.environmentIdentity !== identity) {
    throw new Error('protected environment identity changed during activation');
  }
  if (!raw.health || typeof raw.health !== 'object' || !raw.lifecycle || typeof raw.lifecycle !== 'object') {
    throw new Error('protected environment status is incomplete');
  }
  return raw;
}

function terminalReady(status) {
  const observed = status.observed;
  return status.health.state === 'ready'
    && status.health.cause === 'healthy'
    && status.recommendedAction === 'none'
    && status.lifecycle.active === false
    && observed?.materialization === 'present'
    && observed.systemStorage === 'present'
    && observed.attachment === 'ready'
    && observed.enrollment === 'ready'
    && observed.bootstrap === 'ready'
    && observed.guest === 'healthy'
    && observed.transition === 'clear'
    && SAFE_ID.test(observed.implementationGeneration ?? '');
}

function result({ ready, changed = false, state, blocker = null, identity = null }) {
  return Object.freeze({
    protocol: SETUP_ENVIRONMENT_ACTIVATION_PROTOCOL,
    ready,
    changed,
    state,
    blocker,
    environmentIdentity: identity,
    environmentCount: ready ? 1 : 0,
  });
}

export async function reconcileSetupEnvironmentActivation({ client, profile } = {}) {
  const selectedClient = assertClient(client);
  const selectedProfile = safeId(profile, 'setup environment profile');
  const inventory = await selectedClient.list();
  if (!Array.isArray(inventory) || inventory.length > MAX_ENVIRONMENTS) {
    throw new Error('protected environment inventory is invalid');
  }
  const matches = inventory.filter((entry) => entry?.profile === selectedProfile);
  if (matches.length !== 1) {
    return result({ ready: false, state: 'blocked', blocker: 'accepted environment profile is unavailable or ambiguous' });
  }

  const before = normalizeStatus(matches[0], { profile: selectedProfile });
  const identity = before.environmentIdentity;
  if (terminalReady(before)) return result({ ready: true, state: 'ready', identity });

  let changed = false;
  if (before.lifecycle.active === true) {
    if (before.lifecycle.operation !== 'create' || before.lifecycle.resumable !== true) {
      return result({
        ready: false,
        state: 'blocked',
        blocker: 'accepted environment has a non-create lifecycle transition requiring operator review',
        identity,
      });
    }
    await selectedClient.resume(identity);
    changed = true;
  } else if (before.health.state === 'absent'
      && before.health.cause === 'materialization-not-created'
      && before.recommendedAction === 'create') {
    await selectedClient.run('create', identity);
    changed = true;
  } else {
    return result({
      ready: false,
      state: 'blocked',
      blocker: 'accepted environment is not safely creatable through initial setup',
      identity,
    });
  }

  const after = normalizeStatus(await selectedClient.status(identity), { profile: selectedProfile, identity });
  if (!terminalReady(after)) {
    return result({
      ready: false,
      changed,
      state: 'blocked',
      blocker: 'accepted environment did not verify ready after protected activation',
      identity,
    });
  }
  return result({ ready: true, changed, state: 'ready', identity });
}
