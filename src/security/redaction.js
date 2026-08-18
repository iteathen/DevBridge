const TOKEN_PATTERNS = [
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bgh[opusr]_[A-Za-z0-9]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}=*\b/gi
];

export function stripUnsafeControls(text) {
  return String(text)
    .replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

export function redactText(value, secretValues = []) {
  let text = stripUnsafeControls(value);
  for (const secret of secretValues) {
    if (typeof secret !== 'string' || secret.length < 4) continue;
    text = text.split(secret).join('[REDACTED]');
  }
  for (const pattern of TOKEN_PATTERNS) text = text.replace(pattern, '[REDACTED]');
  return text;
}
