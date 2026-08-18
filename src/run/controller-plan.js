import { createHash } from 'node:crypto';
import path from 'node:path';
import { ProtocolError } from '../errors.js';

export const CONTROLLER_PLAN_PROTOCOL = 'patch-poller/controller-plan-v1';
const MAX_PLAN_BYTES = 1_048_576;
const MAX_FILES = 256;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;
const MAX_OPERATIONS = 128;
const MAX_ASSERTIONS = 256;
const MAX_OPERATION_PARAMS_BYTES = 64 * 1024;
const DIGEST_RE = /^[0-9a-f]{64}$/u;
const ID_RE = /^[A-Za-z0-9_.-]{1,80}$/u;
const CHANNEL_RE = /^[A-Za-z0-9_.-]{1,40}$/u;

function byteLength(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError(`${name} must be an object`);
  }
  return value;
}

function rejectAuthorityFields(value, name) {
  for (const forbidden of [
    'command', 'shell', 'argv', 'executable', 'cwd', 'localPath', 'absolutePath',
    'environment', 'env', 'credentials', 'credential', 'capabilities', 'gitRef',
    'gitSha', 'cleanupRoot', 'module', 'plugin'
  ]) {
    if (Object.hasOwn(value, forbidden)) {
      throw new ProtocolError(`${name}.${forbidden} is forbidden controller authority`);
    }
  }
}

export function normalizePlanPath(value, name = 'path') {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.includes('\0')) {
    throw new ProtocolError(`${name} must be a bounded repository-relative path`);
  }
  const portable = value.replace(/\\/gu, '/');
  if (portable.startsWith('/') || /^[A-Za-z]:\//u.test(portable) || portable.startsWith('//')) {
    throw new ProtocolError(`${name} must not be absolute`);
  }
  const normalized = path.posix.normalize(portable);
  if (normalized !== portable || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new ProtocolError(`${name} must be normalized and must not traverse`);
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new ProtocolError(`${name} contains an unsafe path segment`);
  }
  const first = segments[0].toLowerCase();
  if (first === '.git' || first === '.patch-poller') {
    throw new ProtocolError(`${name} targets a reserved PATCH-POLLER path`);
  }
  return normalized;
}

function normalizeDigest(value, name, { required = false } = {}) {
  if (value == null && !required) return null;
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) {
    throw new ProtocolError(`${name} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function normalizeFile(raw, index) {
  const file = requireObject(raw, `controllerPlan.files[${index}]`);
  rejectAuthorityFields(file, `controllerPlan.files[${index}]`);
  const scope = file.scope ?? 'persistent';
  if (!['persistent', 'ephemeral'].includes(scope)) {
    throw new ProtocolError(`controllerPlan.files[${index}].scope is invalid`);
  }
  const action = file.action ?? 'create';
  if (!['create', 'replace', 'delete', 'reserve'].includes(action)) {
    throw new ProtocolError(`controllerPlan.files[${index}].action is invalid`);
  }
  if (action === 'reserve' && scope !== 'ephemeral') {
    throw new ProtocolError('only ephemeral files may use reserve');
  }
  if (scope === 'ephemeral' && ['replace', 'delete'].includes(action)) {
    throw new ProtocolError('ephemeral files may only be created or reserved');
  }
  const filePath = normalizePlanPath(file.path, `controllerPlan.files[${index}].path`);
  const expectedSha256 = normalizeDigest(
    file.expectedSha256,
    `controllerPlan.files[${index}].expectedSha256`,
    { required: scope === 'persistent' && ['replace', 'delete'].includes(action) }
  );
  let content = null;
  let contentSha256 = null;
  if (action === 'create' || action === 'replace') {
    if (typeof file.content !== 'string') {
      throw new ProtocolError(`controllerPlan.files[${index}].content must be a string`);
    }
    if (byteLength(file.content) > MAX_FILE_BYTES) {
      throw new ProtocolError(`controllerPlan.files[${index}].content exceeds file limit`);
    }
    if (file.encoding != null && file.encoding !== 'utf8') {
      throw new ProtocolError(`controllerPlan.files[${index}].encoding must be utf8`);
    }
    content = file.content;
    contentSha256 = createHash('sha256').update(content, 'utf8').digest('hex');
  } else if (file.content != null) {
    throw new ProtocolError(`controllerPlan.files[${index}].content is not allowed for ${action}`);
  }
  return { scope, action, path: filePath, encoding: 'utf8', content, expectedSha256, contentSha256 };
}

function normalizeOperation(raw, index) {
  const operation = requireObject(raw, `controllerPlan.operations[${index}]`);
  rejectAuthorityFields(operation, `controllerPlan.operations[${index}]`);
  if (typeof operation.id !== 'string' || !ID_RE.test(operation.id)) {
    throw new ProtocolError(`controllerPlan.operations[${index}].id must be a safe identifier`);
  }
  if (typeof operation.operation !== 'string' || !ID_RE.test(operation.operation)) {
    throw new ProtocolError(`controllerPlan.operations[${index}].operation must be a safe registered operation name`);
  }
  const params = operation.params == null ? {} : requireObject(operation.params, `controllerPlan.operations[${index}].params`);
  rejectAuthorityFields(params, `controllerPlan.operations[${index}].params`);
  if (byteLength(params) > MAX_OPERATION_PARAMS_BYTES) {
    throw new ProtocolError(`controllerPlan.operations[${index}].params exceeds operation limit`);
  }
  return { id: operation.id, operation: operation.operation, params: structuredClone(params) };
}

function normalizeAssertion(raw, index) {
  const assertion = requireObject(raw, `controllerPlan.assertions[${index}]`);
  rejectAuthorityFields(assertion, `controllerPlan.assertions[${index}]`);
  const kind = assertion.kind;
  const allowed = new Set([
    'exit-equals', 'exit-not-equals', 'stdout-equals', 'stdout-contains',
    'stderr-equals', 'stderr-contains', 'outputs-equal', 'file-exists',
    'file-absent', 'file-sha256', 'json-field-equals', 'workspace-clean'
  ]);
  if (!allowed.has(kind)) throw new ProtocolError(`controllerPlan.assertions[${index}].kind is unsupported`);
  const normalized = { kind };
  if (kind.startsWith('exit-') || kind.startsWith('stdout-') || kind.startsWith('stderr-') || kind === 'json-field-equals') {
    if (typeof assertion.operation !== 'string' || !ID_RE.test(assertion.operation)) {
      throw new ProtocolError(`controllerPlan.assertions[${index}].operation is required`);
    }
    normalized.operation = assertion.operation;
  }
  if (kind === 'outputs-equal') {
    for (const key of ['leftOperation', 'rightOperation']) {
      if (typeof assertion[key] !== 'string' || !ID_RE.test(assertion[key])) {
        throw new ProtocolError(`controllerPlan.assertions[${index}].${key} is required`);
      }
      normalized[key] = assertion[key];
    }
    normalized.stream = assertion.stream ?? 'stdout';
    if (!['stdout', 'stderr'].includes(normalized.stream)) throw new ProtocolError('outputs-equal stream is invalid');
  }
  if (kind.startsWith('file-')) normalized.path = normalizePlanPath(assertion.path, `controllerPlan.assertions[${index}].path`);
  if (kind === 'file-sha256') normalized.sha256 = normalizeDigest(assertion.sha256, `controllerPlan.assertions[${index}].sha256`, { required: true });
  if (kind.startsWith('exit-')) {
    if (!Number.isInteger(assertion.value) || assertion.value < -2147483648 || assertion.value > 2147483647) {
      throw new ProtocolError(`controllerPlan.assertions[${index}].value must be an integer exit code`);
    }
    normalized.value = assertion.value;
  }
  if (kind.startsWith('stdout-') || kind.startsWith('stderr-')) {
    if (typeof assertion.value !== 'string' || byteLength(assertion.value) > 32 * 1024) {
      throw new ProtocolError(`controllerPlan.assertions[${index}].value must be a bounded string`);
    }
    normalized.value = assertion.value;
  }
  if (kind === 'json-field-equals') {
    if (typeof assertion.field !== 'string' || !/^[A-Za-z0-9_.-]{1,160}$/u.test(assertion.field)) {
      throw new ProtocolError(`controllerPlan.assertions[${index}].field is invalid`);
    }
    if (!['stdout', 'stderr'].includes(assertion.stream ?? 'stdout')) {
      throw new ProtocolError(`controllerPlan.assertions[${index}].stream is invalid`);
    }
    if (!['string', 'number', 'boolean'].includes(typeof assertion.value) && assertion.value !== null) {
      throw new ProtocolError(`controllerPlan.assertions[${index}].value must be a JSON primitive`);
    }
    normalized.field = assertion.field;
    normalized.stream = assertion.stream ?? 'stdout';
    normalized.value = assertion.value;
  }
  return normalized;
}

export function normalizeControllerPlan(raw) {
  const plan = requireObject(raw, 'controllerPlan');
  if (byteLength(plan) > MAX_PLAN_BYTES) throw new ProtocolError('controllerPlan exceeds plan limit');
  if (plan.protocol !== CONTROLLER_PLAN_PROTOCOL) throw new ProtocolError('unsupported controller plan protocol');
  rejectAuthorityFields(plan, 'controllerPlan');

  const baselineChannel = plan.baselineChannel == null ? null : String(plan.baselineChannel);
  if (baselineChannel != null && !CHANNEL_RE.test(baselineChannel)) {
    throw new ProtocolError('controllerPlan.baselineChannel must be a safe semantic channel name');
  }

  const rawFiles = plan.files ?? [];
  if (!Array.isArray(rawFiles) || rawFiles.length > MAX_FILES) throw new ProtocolError('controllerPlan.files exceeds file-count limit');
  const files = rawFiles.map(normalizeFile);
  const uniquePaths = new Set();
  let bundleBytes = 0;
  for (const file of files) {
    if (uniquePaths.has(file.path)) throw new ProtocolError(`controllerPlan contains duplicate file path ${file.path}`);
    uniquePaths.add(file.path);
    bundleBytes += file.content == null ? 0 : byteLength(file.content);
  }
  if (bundleBytes > MAX_BUNDLE_BYTES) throw new ProtocolError('controllerPlan file bundle exceeds byte limit');

  const rawOperations = plan.operations ?? [];
  if (!Array.isArray(rawOperations) || rawOperations.length > MAX_OPERATIONS) throw new ProtocolError('controllerPlan.operations exceeds operation-count limit');
  const operations = rawOperations.map(normalizeOperation);
  const operationIds = new Set();
  for (const operation of operations) {
    if (operationIds.has(operation.id)) throw new ProtocolError(`duplicate controller operation id ${operation.id}`);
    operationIds.add(operation.id);
  }

  const rawAssertions = plan.assertions ?? [];
  if (!Array.isArray(rawAssertions) || rawAssertions.length > MAX_ASSERTIONS) throw new ProtocolError('controllerPlan.assertions exceeds assertion-count limit');
  const assertions = rawAssertions.map(normalizeAssertion);
  for (const assertion of assertions) {
    for (const key of ['operation', 'leftOperation', 'rightOperation']) {
      if (assertion[key] && !operationIds.has(assertion[key])) {
        throw new ProtocolError(`controller assertion references unknown operation ${assertion[key]}`);
      }
    }
  }

  const rawExpected = plan.expectedChangedPaths ?? files.filter((file) => file.scope === 'persistent').map((file) => file.path);
  if (!Array.isArray(rawExpected) || rawExpected.length > MAX_FILES) throw new ProtocolError('controllerPlan.expectedChangedPaths exceeds limit');
  const expectedChangedPaths = [...new Set(rawExpected.map((value, index) => normalizePlanPath(value, `controllerPlan.expectedChangedPaths[${index}]`)))].sort();

  return {
    protocol: CONTROLLER_PLAN_PROTOCOL,
    baselineChannel,
    files,
    operations,
    assertions,
    expectedChangedPaths
  };
}

export function controllerPlanDigest(plan) {
  return createHash('sha256').update(JSON.stringify(plan), 'utf8').digest('hex');
}
