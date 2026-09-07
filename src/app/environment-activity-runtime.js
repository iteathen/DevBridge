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

export function createEnvironmentActivityRuntime({ state, loadPolicy, preparation, exchange } = {}) {
  const selectedState = assertState(state);
  const selectedPolicy = assertPolicyLoader(loadPolicy);
  const selectedPreparation = assertPreparation(preparation);
  const selectedExchange = assertExchange(exchange);

  const routing = async () => createExecutionProfileRouting({ state: selectedState, policy: await selectedPolicy() });
  const attachment = async (logicalTarget) => {
    const current = await routing();
    return Object.freeze({
      target: await current.physicalTarget(logicalTarget),
      prefix: `workspaces/${current.workspaceIdentity(logicalTarget)}`,
    });
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
      const result = await selectedExchange(attached, options);
      return rebindEnvironmentBridgeResponse(result, { from: attached, to: logical });
    },
  });
}
