import { PolicyError } from '../errors.js';

const SAFE_COMMAND = /^[A-Za-z0-9_.+-]{1,80}$/u;
const SAFE_OPERATION = /^tool\.[A-Za-z0-9_.-]{1,75}$/u;
const SAFE_HELP_ARG = /^-{1,2}[A-Za-z0-9][A-Za-z0-9_.=-]{0,79}$/u;

function operationName(command, explicit = null) {
  if (explicit != null) {
    if (typeof explicit !== 'string' || !SAFE_OPERATION.test(explicit)) throw new PolicyError('tool onboarding operation is invalid');
    return explicit;
  }
  const suffix = command.replace(/[^A-Za-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '');
  if (!suffix) throw new PolicyError('tool onboarding command cannot produce a safe operation name');
  return `tool.${suffix}`;
}

function entryOf(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PolicyError(`tool onboarding autoIntegrate[${index}] must be an object`);
  for (const key of Object.keys(raw)) if (!['command', 'operation', 'helpArgs'].includes(key)) throw new PolicyError(`tool onboarding autoIntegrate[${index}].${key} is not allowed`);
  if (typeof raw.command !== 'string' || !SAFE_COMMAND.test(raw.command)) throw new PolicyError(`tool onboarding autoIntegrate[${index}].command is invalid`);
  const helpArgs = raw.helpArgs ?? ['--help'];
  if (!Array.isArray(helpArgs) || helpArgs.length === 0 || helpArgs.length > 4 || helpArgs.some((value) => typeof value !== 'string' || !SAFE_HELP_ARG.test(value))) {
    throw new PolicyError(`tool onboarding autoIntegrate[${index}].helpArgs must contain 1-4 fixed safe option arguments`);
  }
  return Object.freeze({ command: raw.command, operation: operationName(raw.command, raw.operation ?? null), helpArgs: Object.freeze([...helpArgs]) });
}

export function validateToolOnboardingPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new PolicyError('tool onboarding policy must be an object');
  const entries = policy.autoIntegrate ?? [];
  if (!Array.isArray(entries) || entries.length > 32) throw new PolicyError('tool onboarding autoIntegrate must contain at most 32 entries');
  const normalized = entries.map(entryOf);
  const commands = new Set();
  const operations = new Set();
  for (const entry of normalized) {
    if (commands.has(entry.command)) throw new PolicyError(`tool onboarding duplicates command ${entry.command}`);
    if (operations.has(entry.operation)) throw new PolicyError(`tool onboarding duplicates operation ${entry.operation}`);
    commands.add(entry.command);
    operations.add(entry.operation);
  }
  return Object.freeze(normalized);
}
