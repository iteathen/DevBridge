import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

function fileIdentity(info) {
  return { device: String(info.dev), inode: String(info.ino), createdNs: String(info.birthtimeNs ?? 0n) };
}

function sameFileIdentity(left, right) {
  return left?.device === right?.device && left?.inode === right?.inode && left?.createdNs === right?.createdNs;
}

export class LibvirtOverlayLineage {
  #invoke;

  constructor({ invoke }) {
    if (typeof invoke !== 'function') throw new TypeError('invoke must be a function');
    this.#invoke = invoke;
  }

  async #require(argumentsList, options = {}) {
    const result = await this.#invoke({ executable: 'qemu-img', arguments: argumentsList, ...options });
    if (!result || result.exitCode !== 0 || result.timedOut || result.aborted || result.outputTruncated) {
      const detail = result?.stderr?.trim() || result?.stdout?.trim() || 'environment management operation failed';
      throw new Error(detail.slice(0, 2048));
    }
    return result.stdout;
  }

  create(parent, destination) {
    return this.#require(['create', '-f', 'qcow2', '-F', 'qcow2', '-b', parent, destination], { timeoutMs: 60_000 });
  }

  async observe(record) {
    let overlayInfo;
    let parentInfo;
    try {
      [overlayInfo, parentInfo] = await Promise.all([lstat(record.diskPath, { bigint: true }), lstat(record.parentPath, { bigint: true })]);
    } catch (error) {
      if (error?.code === 'ENOENT') return { compatible: false, reason: 'environment storage lineage is incomplete', storage: null };
      throw error;
    }
    if (!overlayInfo.isFile() || overlayInfo.isSymbolicLink() || !parentInfo.isFile() || parentInfo.isSymbolicLink()) {
      return { compatible: false, reason: 'environment storage lineage shape changed', storage: null };
    }
    if (!sameFileIdentity(record.parentFileIdentity, fileIdentity(parentInfo))) {
      return { compatible: false, reason: 'environment source filesystem identity changed', storage: null };
    }
    if (record.diskFileIdentity && !sameFileIdentity(record.diskFileIdentity, fileIdentity(overlayInfo))) {
      return { compatible: false, reason: 'environment writable filesystem identity changed', storage: null };
    }
    let parsed;
    try {
      parsed = JSON.parse(await this.#require(['info', '-U', '--output=json', '--backing-chain', record.diskPath], { timeoutMs: 30_000, maxOutputBytes: 2 * 1024 * 1024 }));
    } catch (error) {
      return { compatible: false, reason: `environment storage inspection failed: ${error.message}`, storage: null };
    }
    const chain = Array.isArray(parsed) ? parsed : [parsed];
    const head = chain[0];
    if (!head || chain.length !== 2 || String(head.format).toLowerCase() !== 'qcow2' || String(chain[1]?.format).toLowerCase() !== 'qcow2') {
      return { compatible: false, reason: 'environment storage backing depth or format changed', storage: null };
    }
    const backing = head['full-backing-filename'] ?? head['backing-filename'];
    if (typeof backing !== 'string') return { compatible: false, reason: 'environment storage backing identity is absent', storage: null };
    const actualParent = path.resolve(path.dirname(record.diskPath), backing);
    const [expectedParent, canonicalActual] = await Promise.all([realpath(record.parentPath), realpath(actualParent).catch(() => null)]);
    if (!canonicalActual || canonicalActual !== expectedParent) return { compatible: false, reason: 'environment storage backing identity changed', storage: null };
    const allocatedBytes = Number(overlayInfo.blocks) * 512;
    const storageIdentity = createHash('sha256').update(`${overlayInfo.dev}:${overlayInfo.ino}`).digest('hex').slice(0, 32);
    return {
      compatible: true,
      reason: null,
      storage: { identity: storageIdentity, sourceIdentity: record.sourceIdentity, allocatedBytes: Number.isSafeInteger(allocatedBytes) ? allocatedBytes : Number(overlayInfo.size) },
      fileIdentity: fileIdentity(overlayInfo),
    };
  }
}
