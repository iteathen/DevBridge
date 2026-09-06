import { sanitizeDiagnosticText as sanitizeStatusText } from '../security/diagnostic-redaction.js';
export { sanitizeStatusText };

export function renderStatusDiagnostics(diagnostics, secrets = [], maxBytes = 20_000) {
  if (!diagnostics) return '';
  const evidence = diagnostics;
  const label = value => sanitizeStatusText(String(value ?? 'unknown'), secrets).replace(/[\r\n`]/gu, ' ').slice(0, 120);
  const lines = [
    `Attempt: ${label(evidence.attempt)}; failing stage: ${label(evidence.stage)}; operation: ${label(evidence.operationId)}.`,
    `Exit status: ${label(evidence.exitCode)}; timed out: ${evidence.timedOut === true}; cancelled: ${evidence.aborted === true}.`,
    `Diagnostic collection: ${evidence.collection === 'available' ? 'available' : 'unavailable'}; source truncated: ${evidence.truncated === true}.`,
  ];
  const raw = [evidence.message, evidence.stdout, evidence.stderr].filter(value => typeof value === 'string' && value.length).join('\n');
  const safe = sanitizeStatusText(raw, secrets);
  // Diagnostics reserve space separately from the compactable context capsule.
  // Four-space code indentation prevents guest Markdown/fences/mentions from
  // becoming active report markup.
  const indented = safe.split(/\r?\n/u).map(line => `    ${line}`).join('\n');
  const bytes = Buffer.from(indented, 'utf8');
  let end = Math.min(bytes.length, Math.max(0, maxBytes - Buffer.byteLength(lines.join('\n'), 'utf8') - 512));
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
  const text = bytes.subarray(0, end).toString('utf8');
  if (text) lines.push('', text);
  if (end < bytes.length) lines.push('', 'Published diagnostic excerpt truncated; additional text is not delivered by this projection.');
  if (evidence.collection !== 'available') lines.push('', 'Operation output was not supplied by its owner; the reported error is retained above.');
  return lines.join('\n');
}
