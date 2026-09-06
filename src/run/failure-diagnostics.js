import { sanitizeDiagnosticText } from '../security/diagnostic-redaction.js';

const TAIL_BYTES = 8_000;
const EXPANDED_BYTES = 16_384;

function tail(value, maximum = TAIL_BYTES) {
  const bytes = Buffer.from(typeof value === 'string' ? value : '', 'utf8');
  if (bytes.length <= maximum) return { text: bytes.toString('utf8'), truncated: false };
  let start = bytes.length - maximum;
  while ((bytes[start] & 0xc0) === 0x80) start += 1;
  return { text: bytes.subarray(start).toString('utf8'), truncated: true };
}

// An operation supplies its own result. Never infer an exit status or select
// the last unrelated operation from a run to fill a missing diagnostic.
export function captureFailureDiagnostics({ stage, attempt = 1, operationId = null, error = null, result = null, secretValues = [] }) {
  const source = result ?? error ?? {};
  // Redact before truncating: slicing a credential or PEM header first can
  // remove the very prefix the public projection needs to recognize it.
  const safe = value => sanitizeDiagnosticText(value ?? '', secretValues);
  const safeStdout = safe(source.stdout);
  const safeStderr = safe(source.stderr);
  const stdout = tail(safeStdout);
  const stderr = tail(safeStderr);
  let expanded = null;
  if (stdout.truncated || stderr.truncated) {
    const fullStdout = tail(safeStdout, EXPANDED_BYTES);
    const fullStderr = tail(safeStderr, EXPANDED_BYTES);
    expanded = {
      protocol: 'devbridge/expanded-failure-diagnostics-v1',
      stdout: fullStdout.text,
      stderr: fullStderr.text,
      truncated: source.outputTruncated === true || fullStdout.truncated || fullStderr.truncated,
    };
  }
  return {
    protocol: 'devbridge/failure-diagnostics-v1',
    stage: String(stage ?? 'unknown').slice(0, 120),
    attempt: Math.max(1, Number.isSafeInteger(attempt) ? attempt : 1),
    operationId: operationId == null ? null : String(operationId).slice(0, 120),
    exitCode: Number.isSafeInteger(source.exitCode) ? source.exitCode : null,
    timedOut: source.timedOut === true,
    aborted: source.aborted === true,
    collection: typeof source.stdout === 'string' || typeof source.stderr === 'string' ? 'available' : 'unavailable',
    truncated: source.outputTruncated === true || stdout.truncated || stderr.truncated,
    stdout: stdout.text,
    stderr: stderr.text,
    message: safe(error?.message).slice(0, 4000),
    ...(expanded == null ? {} : { expanded }),
  };
}
