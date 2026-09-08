import { createExecutionProfileRouting } from './execution-profile-routing.js';
import {
  normalizeEnvironmentBridgeRequest,
  rebindEnvironmentBridgeRequest,
  rebindEnvironmentBridgeResponse,
} from '../runtime/environment-bridge.js';

function assertState(value) {
  const methods = ['inspect', 'listEnvironments', 'observeEnvironment'];
  if (!value || methods.some((name) => typeof value[name] !== 'function')) throw new TypeError('environment activity state contract is incomplete');
  return value;
}

function assertPreparation(value) {
  if (!value || typeof value.ensure !== 'function') throw new TypeError('environment activity preparation contract is incomplete');
  return value;
}

function assertPolicyLoader(value) {
  if (typeof value !== 'function') throw new TypeError('environment activity policy loader is required');
  return value;
}

function assertExchange(value) {
  if (typeof value !== 'function') throw new TypeError('environment activity exchange contract is required');
  return value;
}

export function createEnvironmentActivityRuntime({ state, loadPolicy, preparation, exchange, authorityBinding = async () => null } = {}) {
  const selectedState = assertState(state);
  const selectedPolicy = assertPolicyLoader(loadPolicy);
  const selectedPreparation = assertPreparation(preparation);
  const selectedExchange = assertExchange(exchange);
  if (typeof authorityBinding !== 'function') throw new TypeError('environment activity authority binding is invalid');
  const attachments = new Map();

  const routing = async () => createExecutionProfileRouting({ state: selectedState, policy: await selectedPolicy() });
  const attachment = async (logicalTarget) => {
    const current = await routing();
    const committed = await current.attachmentBinding(logicalTarget);
    const authority = committed == null ? null : await authorityBinding(committed.record.identity);
    const key = committed == null ? null : JSON.stringify([committed, authority]);
    const previous = attachments.get(logicalTarget);
    if (key != null && previous?.key === key) return previous.value;
    const target = await current.physicalTarget(logicalTarget);
    if (committed != null && target !== committed.record.identity) throw new Error('environment activity attachment changed during observation');
    const value = Object.freeze({ target, prefix: `workspaces/${current.workspaceIdentity(logicalTarget)}`, binding: key });
    if (key != null) {
      if (attachments.size >= 32) attachments.delete(attachments.keys().next().value);
      attachments.set(logicalTarget, { key, value });
    }
    return value;
  };

  return Object.freeze({
    async inspect() {
      return selectedState.inspect();
    },
    async list() {
      const current = await routing();
      return current.listEnvironments();
    },
    async observe(target) {
      const current = await routing();
      return current.observeEnvironment(target);
    },
    async prepare(target) {
      const selected = await attachment(target);
      const result = await selectedPreparation.ensure(selected.target);
      return Object.freeze({ generation: result?.generation });
    },
    async exchange(rawFrame, options = {}) {
      const logical = normalizeEnvironmentBridgeRequest(rawFrame);
      const selected = await attachment(logical.target);
      const attached = rebindEnvironmentBridgeRequest(logical, selected);
      try {
        const result = await selectedExchange(attached, { ...options, binding: selected.binding });
        return rebindEnvironmentBridgeResponse(result, { from: attached, to: logical });
      } catch (error) {
        attachments.delete(logical.target);
        throw error;
      }
    },
    close() { attachments.clear(); selectedExchange.close?.(); },
  });
}
