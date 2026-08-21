import { freemem } from 'node:os';

const MIN_RESERVE_BYTES = 512 * 1024 * 1024;
const MAX_SAFE_BYTES = Number.MAX_SAFE_INTEGER;

export class ExecutionProfileResourceError extends Error {
  constructor({ requestedBytes, availableBytes, reserveBytes }) {
    super(`execution profile requires ${requestedBytes} bytes of startup memory plus ${reserveBytes} bytes of host reserve, but only ${availableBytes} bytes are currently free`);
    this.name = 'ExecutionProfileResourceError';
    this.code = 'PROFILE_RESOURCES_UNAVAILABLE';
    this.requestedBytes = requestedBytes;
    this.availableBytes = availableBytes;
    this.reserveBytes = reserveBytes;
  }
}

function safeBytes(value, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SAFE_BYTES) throw new TypeError(`${name} is invalid`);
  return value;
}

export function preflightExecutionProfileMemory(settings, {
  availableBytes = freemem(),
  minimumReserveBytes = MIN_RESERVE_BYTES,
} = {}) {
  const requestedBytes = safeBytes(settings?.memoryBytes, 'execution profile memory request');
  const freeBytes = safeBytes(availableBytes, 'available host memory');
  const minimumReserve = safeBytes(minimumReserveBytes, 'host memory reserve');
  const reserveBytes = Math.max(minimumReserve, Math.ceil(requestedBytes / 4));
  const requiredBytes = requestedBytes + reserveBytes;
  if (!Number.isSafeInteger(requiredBytes) || freeBytes < requiredBytes) {
    throw new ExecutionProfileResourceError({ requestedBytes, availableBytes: freeBytes, reserveBytes });
  }
  return Object.freeze({
    ready: true,
    requestedBytes,
    availableBytes: freeBytes,
    reserveBytes,
    requiredBytes,
  });
}
