import {
  AcceleratorBrokerEndpointAttachment,
  ACCELERATOR_BROKER_VM_SERVICE_PORT,
} from '../accelerator-broker-endpoint-attachment.js';

export const LIBVIRT_VSOCK_ACCELERATOR_BROKER_ENDPOINT_PROTOCOL = 'devbridge/libvirt-vsock-accelerator-broker-endpoint-v1';
export const VSOCK_HOST_CID = 2;

const MAX_VSOCK_CID = 0xffff_fffe;

function exactObject(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return value;
}

function guestCid(value) {
  if (!Number.isSafeInteger(value) || value <= VSOCK_HOST_CID || value > MAX_VSOCK_CID) {
    throw new TypeError('libvirt accelerator broker guest CID is invalid');
  }
  return value;
}

function localPort(value) {
  if (value !== ACCELERATOR_BROKER_VM_SERVICE_PORT) throw new TypeError('libvirt accelerator broker local port is invalid');
  return value;
}

export class LibvirtVsockAcceleratorBrokerEndpoint {
  #guestCid;
  #attachment;

  constructor(options = {}) {
    const value = exactObject(options, new Set(['guestCid', 'binding', 'service']), 'libvirt accelerator broker endpoint options');
    this.#guestCid = guestCid(value.guestCid);
    this.#attachment = new AcceleratorBrokerEndpointAttachment({ binding: value.binding, service: value.service });
  }

  descriptor() {
    return Object.freeze({
      protocol: LIBVIRT_VSOCK_ACCELERATOR_BROKER_ENDPOINT_PROTOCOL,
      platform: 'linux',
      family: 'AF_VSOCK',
      hostCid: VSOCK_HOST_CID,
      guestCid: this.#guestCid,
      port: ACCELERATOR_BROKER_VM_SERVICE_PORT,
    });
  }

  async handleConnection(rawConnection) {
    try {
      const value = exactObject(rawConnection, new Set(['peerCid', 'localPort', 'frame']), 'libvirt accelerator broker connection');
      const peerCid = guestCid(value.peerCid);
      localPort(value.localPort);
      if (peerCid !== this.#guestCid) throw new Error('peer mismatch');
      return await this.#attachment.handleFrame(value.frame);
    } catch {
      throw new Error('libvirt accelerator broker endpoint is unavailable');
    }
  }
}
