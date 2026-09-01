import { matchAcceleratorBrokerBinding } from './accelerator-broker-protocol.js';
import {
  decodeAcceleratorBrokerServiceRequestFrame,
  encodeAcceleratorBrokerServiceResponseFrame,
} from './accelerator-broker-service.js';

export const ACCELERATOR_BROKER_VM_SERVICE_PORT = 55_005;

function normalizeExpectedBinding(raw) {
  return matchAcceleratorBrokerBinding(raw, raw).binding;
}

function assertService(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.handle !== 'function') {
    throw new TypeError('accelerator broker endpoint service is invalid');
  }
  return value;
}

export class AcceleratorBrokerEndpointAttachment {
  #binding;
  #service;

  constructor({ binding, service } = {}) {
    this.#binding = normalizeExpectedBinding(binding);
    this.#service = assertService(service);
  }

  async handleFrame(rawFrame) {
    try {
      const request = decodeAcceleratorBrokerServiceRequestFrame(rawFrame);
      const matched = matchAcceleratorBrokerBinding(request.body.binding, this.#binding);
      if (matched.matched !== true) throw new Error('binding mismatch');
      const response = await this.#service.handle(request);
      return encodeAcceleratorBrokerServiceResponseFrame(response);
    } catch {
      throw new Error('accelerator broker endpoint is unavailable');
    }
  }
}
