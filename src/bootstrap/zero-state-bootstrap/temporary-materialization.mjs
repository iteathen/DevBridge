import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

async function defaultLoader(modulePath) {
  return import(pathToFileURL(modulePath).href);
}

export function createTemporaryMaterialization() {
  function write(root, head, bytes, role = 'stage') {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1) throw new TypeError('temporary module bytes must be a non-empty buffer');
    const target = path.join(root, `.${role}-${head.slice(0, 12)}-${process.pid}-${randomUUID()}.mjs`);
    writeFileSync(target, bytes, { mode: 0o600, flag: 'wx', flush: true });
    return target;
  }

  function directory(root, head) {
    return path.join(root, `.source-${head.slice(0, 12)}-${process.pid}-${randomUUID()}`);
  }

  async function load(modulePath, loader = defaultLoader) {
    if (typeof loader !== 'function') throw new TypeError('loader must be a function');
    return loader(modulePath);
  }

  function removeFile(target) {
    try { rmSync(target, { force: true }); } catch {}
  }

  function removeTree(target) {
    try { rmSync(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 }); } catch {}
  }

  return Object.freeze({ directory, load, removeFile, removeTree, write });
}
