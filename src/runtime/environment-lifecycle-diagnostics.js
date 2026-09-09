import { sanitizeDiagnosticText } from '../security/diagnostic-redaction.js';

export const ENVIRONMENT_LIFECYCLE_DIAGNOSTICS_PROTOCOL = 'devbridge/environment-lifecycle-diagnostics-v1';
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;
function identity(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw new TypeError('diagnostic environment identity is invalid');
  return value;
}
function text(value, limit = 2048) {
  let selected = sanitizeDiagnosticText(String(value ?? ''))
    .replace(/\b(?:powershell(?:\.exe)?|virsh|Remove-VM|Remove-VMSwitch|rm\s+-rf)\b/giu, '[NATIVE TOOL]')
    .slice(0, limit);
  while (Buffer.byteLength(selected, 'utf8') > limit) selected = selected.slice(0, -1);
  return selected;
}

export function createEnvironmentLifecycleDiagnostics({ port, now = () => new Date().toISOString() }) {
  if (!port || typeof port.load !== 'function' || typeof port.save !== 'function') throw new TypeError('lifecycle diagnostic persistence is required');
  return Object.freeze({
    async record({ environmentIdentity, declarationRevision, operation, journal, error }) {
      const evidence = error?.evidence ?? null;
      const native = evidence == null ? null : {
        exitCode: Number.isInteger(evidence.exitCode) ? evidence.exitCode : null,
        timedOut: evidence.timedOut === true, aborted: evidence.aborted === true,
        outputTruncated: evidence.outputTruncated === true || Buffer.byteLength(String(evidence.stdout ?? '')) > 2048 || Buffer.byteLength(String(evidence.stderr ?? '')) > 2048,
        stdout: text(evidence.stdout), stderr: text(evidence.stderr),
        category: text(evidence.category, 128), nativeCode: text(evidence.nativeCode, 128),
      };
      const record = {
        protocol: ENVIRONMENT_LIFECYCLE_DIAGNOSTICS_PROTOCOL, available: true,
        environmentIdentity: identity(environmentIdentity), declarationRevision, operation,
        operationId: journal?.operationId ?? null,
        stage: journal?.entries?.at(-1)?.stage ?? 'admission',
        implementationGeneration: journal?.entries?.at(-1)?.implementationGeneration ?? null,
        observedAt: now(),
        failure: { name: text(error?.name, 128), code: text(error?.code, 128), message: text(error?.message), native, nativeEvidenceAvailable: native != null },
        guestEvidence: 'unavailable',
      };
      await port.save(record.environmentIdentity, record);
      return record;
    },
    async inspect(environmentIdentity) {
      const selected = identity(environmentIdentity);
      const record = await port.load(selected);
      if (record != null && (record.protocol !== ENVIRONMENT_LIFECYCLE_DIAGNOSTICS_PROTOCOL || record.environmentIdentity !== selected)) throw new Error('lifecycle diagnostic subject changed');
      return structuredClone(record ?? { protocol: ENVIRONMENT_LIFECYCLE_DIAGNOSTICS_PROTOCOL, environmentIdentity: selected, available: false, failure: null, guestEvidence: 'unavailable' });
    },
  });
}
