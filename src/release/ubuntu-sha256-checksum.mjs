const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// Shared row grammar only. Callers retain table, path, signature, and object policy.
// InRelease may list unused empty indexes; artifact/source callers stay nonempty.
export function parseUbuntuSha256Checksum(line, { allowEmpty = false } = {}) {
  if (typeof line !== 'string' || typeof allowEmpty !== 'boolean') return null;
  const match = /^([a-f0-9]{64})[ \t]+(0|[1-9][0-9]*)[ \t]+([^\s]+)$/u.exec(line.trim());
  if (!match) return null;
  const size = Number(match[2]);
  if (!Number.isSafeInteger(size) || (size === 0 && (!allowEmpty || match[1] !== EMPTY_SHA256))) return null;
  return Object.freeze({ sha256: match[1], size, filename: match[3] });
}
