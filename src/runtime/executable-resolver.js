import { access, constants, realpath } from 'node:fs/promises';
import path from 'node:path';
import { delimiter } from 'node:path';
import { PolicyError } from '../errors.js';

async function executable(candidate) {
  try {
    await access(candidate, constants.X_OK);
    return await realpath(candidate);
  } catch {
    return null;
  }
}

export async function resolveExecutable(name, env = process.env) {
  if (typeof name !== 'string' || name.trim() === '') throw new PolicyError('tool executable must be a non-empty string');

  if (path.isAbsolute(name)) {
    const resolved = await executable(name);
    if (!resolved) throw new PolicyError(`configured executable is not runnable: ${name}`);
    return resolved;
  }

  if (name.includes('/') || name.includes('\\')) throw new PolicyError('relative executable paths are not allowed');

  const searchPath = env.PATH ?? env.Path ?? env.path ?? '';
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];

  for (const directory of searchPath.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, process.platform === 'win32' && path.extname(name) === '' ? `${name}${extension}` : name);
      const resolved = await executable(candidate);
      if (resolved) return resolved;
      if (path.extname(name) !== '') break;
    }
  }

  throw new PolicyError(`configured executable was not found on PATH: ${name}`);
}
