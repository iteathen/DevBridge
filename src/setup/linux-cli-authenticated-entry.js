import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { observeLinuxCliAuthenticationOrigin } from './linux-cli-authentication-origin.js';
import { runLinuxLifecycleAuthorityRefreshChild } from './linux-lifecycle-authority-refresh-child.js';
import {
  dispatchProtectedOperation,
  PROTECTED_OPERATION_DISPATCH_PROTOCOL,
} from './protected-operation-dispatcher.js';
import { PROTECTED_REFRESH_CHILD_RESULT_PROTOCOL } from './protected-refresh-child-contract.js';

const DIGEST = /^[0-9a-f]{64}$/u;
const REASON = /^[a-z][a-z0-9-]{0,63}$/u;
const MAX_OUTPUT_BYTES = 32 * 1024;

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  const prototype = Object.getPrototypeOf(value);
  if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${name} is invalid`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!allowed.has(key) || descriptors[key].enumerable !== true || !Object.hasOwn(descriptors[key], 'value')) {
      throw new TypeError(`${name} contains an unknown field`);
    }
  }
  return value;
}

function exactDispatch(value) {
  exactKeys(value, new Set(['protocol', 'completed', 'output', 'reason']), 'authenticated entry dispatch result');
  if (value.protocol !== PROTECTED_OPERATION_DISPATCH_PROTOCOL || typeof value.completed !== 'boolean') {
    throw new TypeError('authenticated entry dispatch result is invalid');
  }
  if (value.completed) {
    if (typeof value.output !== 'string' || value.output.length < 2 || value.reason !== null
        || new TextEncoder().encode(value.output).byteLength > MAX_OUTPUT_BYTES) {
      throw new TypeError('authenticated entry completed dispatch result is invalid');
    }
  } else if (value.output !== null || typeof value.reason !== 'string' || !REASON.test(value.reason)) {
    throw new TypeError('authenticated entry unavailable dispatch result is invalid');
  }
  return value;
}

function readyOperation(value) {
  try {
    exactKeys(value, new Set(['protocol', 'ready', 'changed', 'generation', 'reason']), 'authenticated entry operation result');
    return value.protocol === PROTECTED_REFRESH_CHILD_RESULT_PROTOCOL && value.ready === true
      && typeof value.changed === 'boolean' && typeof value.generation === 'string'
      && DIGEST.test(value.generation) && value.reason === null;
  } catch {
    return false;
  }
}

export async function runLinuxCliAuthenticatedEntry(value = {}, providedPorts = {}) {
  exactKeys(value, new Set(['input', 'output']), 'authenticated entry request');
  exactKeys(providedPorts, new Set(['dispatch', 'perform', 'observeOrigin']), 'authenticated entry ports');
  const input = value.input ?? process.stdin;
  const output = value.output ?? process.stdout;
  if (!output || typeof output.write !== 'function') throw new TypeError('authenticated entry output is invalid');
  const dispatch = providedPorts.dispatch ?? dispatchProtectedOperation;
  const observeOrigin = providedPorts.observeOrigin ?? observeLinuxCliAuthenticationOrigin;
  const perform = providedPorts.perform ?? ((subject) => runLinuxLifecycleAuthorityRefreshChild(subject, { observeOrigin }));
  if (typeof dispatch !== 'function' || typeof perform !== 'function' || typeof observeOrigin !== 'function') {
    throw new TypeError('authenticated entry composition is invalid');
  }

  let performed = null;
  const dispatched = exactDispatch(await dispatch({ input }, {
    perform: async (subject) => {
      performed = await perform(subject);
      return performed;
    },
  }));
  output.write(`${dispatched.completed ? dispatched.output : JSON.stringify(dispatched)}\n`);
  let projected = null;
  try { projected = JSON.stringify(performed); }
  catch {}
  const ready = dispatched.completed === true && readyOperation(performed) && dispatched.output === projected;
  return Object.freeze({ completed: dispatched.completed === true, ready });
}

const selectedEntry = process.argv[1] == null ? null : path.resolve(process.argv[1]);
if (selectedEntry === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = await runLinuxCliAuthenticatedEntry();
    process.exitCode = result.ready ? 0 : 1;
  } catch {
    process.stdout.write(`${JSON.stringify({ protocol: 'devbridge/protected-operation-entry-v1', completed: false, ready: false })}\n`);
    process.exitCode = 1;
  }
}
