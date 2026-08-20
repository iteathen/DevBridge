import path from 'node:path';

export class ProjectRelativePathError extends TypeError {}

function reject(message) {
  throw new ProjectRelativePathError(message);
}

export function normalizeProjectRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.includes('\0')) {
    reject('must be a bounded project-relative path');
  }
  const portable = value.replace(/\\/gu, '/');
  if (portable.startsWith('/') || /^[A-Za-z]:\//u.test(portable) || portable.startsWith('//')) {
    reject('must not be absolute');
  }
  const normalized = path.posix.normalize(portable);
  if (normalized !== portable || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    reject('must be normalized and must not traverse');
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    reject('contains an unsafe path segment');
  }
  if (new Set(['.git', '.devbridge']).has(segments[0].toLowerCase())) {
    reject('targets a reserved root');
  }
  return normalized;
}
