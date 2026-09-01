import {
  AcceleratorBrokerEndpointAttachment,
  ACCELERATOR_BROKER_VM_SERVICE_PORT,
} from '../accelerator-broker-endpoint-attachment.js';

export const WINDOWS_HYPERV_ACCELERATOR_BROKER_ENDPOINT_PROTOCOL = 'devbridge/windows-hyperv-accelerator-broker-endpoint-v1';
export const WINDOWS_HYPERV_VSOCK_TEMPLATE_SUFFIX = '-facb-11e6-bd58-64006a7986d3';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const VMADDR_CID_HOST = 2;

function exactObject(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return value;
}

function canonicalGuid(value, name) {
  if (typeof value !== 'string' || !GUID.test(value)) throw new TypeError(`${name} is invalid`);
  return value.toLowerCase();
}

export function windowsHyperVAcceleratorBrokerServiceId() {
  return `${ACCELERATOR_BROKER_VM_SERVICE_PORT.toString(16).padStart(8, '0')}${WINDOWS_HYPERV_VSOCK_TEMPLATE_SUFFIX}`;
}

export class WindowsHyperVAcceleratorBrokerEndpoint {
  #vmId;
  #serviceId;
  #attachment;

  constructor(options = {}) {
    const value = exactObject(options, new Set(['vmId', 'binding', 'service']), 'Hyper-V accelerator broker endpoint options');
    this.#vmId = canonicalGuid(value.vmId, 'Hyper-V accelerator broker VM id');
    this.#serviceId = windowsHyperVAcceleratorBrokerServiceId();
    this.#attachment = new AcceleratorBrokerEndpointAttachment({ binding: value.binding, service: value.service });
  }

  descriptor() {
    return Object.freeze({
      protocol: WINDOWS_HYPERV_ACCELERATOR_BROKER_ENDPOINT_PROTOCOL,
      platform: 'win32',
      family: 'AF_HYPERV',
      vmId: this.#vmId,
      serviceId: this.#serviceId,
      guestFamily: 'AF_VSOCK',
      hostCid: VMADDR_CID_HOST,
      port: ACCELERATOR_BROKER_VM_SERVICE_PORT,
    });
  }

  async handleConnection(rawConnection) {
    try {
      const value = exactObject(rawConnection, new Set(['vmId', 'serviceId', 'frame']), 'Hyper-V accelerator broker connection');
      const vmId = canonicalGuid(value.vmId, 'Hyper-V accelerator broker peer VM id');
      const serviceId = canonicalGuid(value.serviceId, 'Hyper-V accelerator broker peer service id');
      if (vmId !== this.#vmId || serviceId !== this.#serviceId) throw new Error('peer mismatch');
      return await this.#attachment.handleFrame(value.frame);
    } catch {
      throw new Error('Hyper-V accelerator broker endpoint is unavailable');
    }
  }
}
