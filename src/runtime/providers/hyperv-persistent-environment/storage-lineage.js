import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

function fileIdentity(info) {
  return { device: String(info.dev), inode: String(info.ino), createdNs: String(info.birthtimeNs ?? 0n) };
}

function sameFileIdentity(left, right) {
  return left?.device === right?.device && left?.inode === right?.inode && left?.createdNs === right?.createdNs;
}

export class HyperVStorageLineage {
  #inspect;

  constructor({ inspect }) {
    if (typeof inspect !== 'function') throw new TypeError('storage inspection port is required');
    this.#inspect = inspect;
  }

  async observe(record) {
    let parentInfo;
    let diskInfo;
    try {
      [parentInfo, diskInfo] = await Promise.all([lstat(record.parentPath, { bigint: true }), lstat(record.diskPath, { bigint: true })]);
    } catch (error) {
      if (error?.code === 'ENOENT') return { compatible: false, reason: 'environment storage lineage is incomplete' };
      throw error;
    }
    if (!parentInfo.isFile() || parentInfo.isSymbolicLink() || !diskInfo.isFile() || diskInfo.isSymbolicLink()) return { compatible: false, reason: 'environment storage lineage shape changed' };
    if (!sameFileIdentity(record.parentFileIdentity, fileIdentity(parentInfo))) return { compatible: false, reason: 'environment source filesystem identity changed' };
    if (record.diskFileIdentity && !sameFileIdentity(record.diskFileIdentity, fileIdentity(diskInfo))) return { compatible: false, reason: 'environment writable filesystem identity changed' };
    const observed = await this.#inspect(record);
    return observed?.compatible === true
      ? { compatible: true, reason: null }
      : { compatible: false, reason: String(observed?.reason ?? 'environment storage lineage is incompatible') };
  }

  async changed(record) {
    try {
      const [parentInfo, diskInfo] = await Promise.all([lstat(record.parentPath, { bigint: true }), lstat(record.diskPath, { bigint: true })]);
      if (!sameFileIdentity(record.parentFileIdentity, fileIdentity(parentInfo))) return 'environment source filesystem identity changed';
      if (record.diskFileIdentity && !sameFileIdentity(record.diskFileIdentity, fileIdentity(diskInfo))) return 'environment writable filesystem identity changed';
      return null;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async capture(location) {
    const info = await lstat(location, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('environment writable state shape changed');
    return fileIdentity(info);
  }

  async existing(location) {
    try { return await lstat(location); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  }

  async assertContainedFile(rootLocation, fileLocation, info) {
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('environment writable state shape changed');
    const [root, actual] = await Promise.all([realpath(rootLocation), realpath(fileLocation)]);
    const relative = path.relative(root, actual);
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('environment writable state escaped the owned root');
  }
}
