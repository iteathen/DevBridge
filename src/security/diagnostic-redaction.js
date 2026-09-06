import { redactText } from './redaction.js';

export function sanitizeDiagnosticText(value, secrets = []) {
  return redactText(String(value).replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/gu, ''), secrets)
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/gu, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:[A-Z_]*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|ACCESS_KEY)[A-Z_]*)\s*[=:]\s*[^\s]+/giu, '[REDACTED ASSIGNMENT]')
    .replace(/\b[A-Za-z]:[\\/][^\r\n\t<>"|]+/gu, '[LOCAL PATH]')
    .replace(/(?<![A-Za-z0-9:/])\/(?:[^\s<>"'`]+\/)*[^\s<>"'`]+/gu, '[LOCAL PATH]')
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, '');
}
