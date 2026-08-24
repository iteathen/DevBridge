import path from 'node:path';
import process from 'node:process';
import { environmentLifecycleAuthorityIdentity } from './environment-lifecycle-authority-transport.js';

function absoluteDirectory(value, platform, name) {
  const localPath = platform === 'win32' ? path.win32 : path.posix;
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !localPath.isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute local path`);
  }
  return localPath.resolve(value);
}

function windowsProgramData(environment) {
  const configured = environment?.ProgramData ?? environment?.PROGRAMDATA ?? null;
  if (typeof configured === 'string' && configured.length > 0) return path.win32.resolve(configured);
  const drive = typeof environment?.SystemDrive === 'string' && /^[A-Za-z]:$/u.test(environment.SystemDrive)
    ? environment.SystemDrive
    : 'C:';
  return path.win32.resolve(`${drive}\\ProgramData`);
}

export function environmentLifecycleAuthorityLayout({
  stateDirectory,
  platform = process.platform,
  environment = process.env,
  protectedRoot = null,
  runDirectory = '/run/devbridge',
} = {}) {
  if (!['win32', 'linux'].includes(platform)) throw new Error(`environment lifecycle authority layout is unsupported on platform ${String(platform)}`);
  const endpointStateDirectory = absoluteDirectory(stateDirectory, platform, 'environment lifecycle endpoint state directory');
  const authorityIdentity = environmentLifecycleAuthorityIdentity(endpointStateDirectory, { platform });

  if (platform === 'win32') {
    const root = protectedRoot == null
      ? path.win32.join(windowsProgramData(environment), 'DevBridge', 'lifecycle-authority', authorityIdentity)
      : absoluteDirectory(protectedRoot, platform, 'environment lifecycle protected root');
    return Object.freeze({
      protocol: 'devbridge/environment-lifecycle-authority-layout-v1',
      platform,
      authorityIdentity,
      endpointStateDirectory,
      protectedRoot: root,
      codeDirectory: path.win32.join(root, 'code'),
      protectedStateDirectory: path.win32.join(root, 'state'),
      taskPath: `\\DevBridge\\LifecycleAuthority\\${authorityIdentity}`,
      serviceName: null,
      runDirectory: null,
    });
  }

  const root = protectedRoot == null
    ? path.posix.join('/var/lib/devbridge/lifecycle-authority', authorityIdentity)
    : absoluteDirectory(protectedRoot, platform, 'environment lifecycle protected root');
  const runtimeRoot = absoluteDirectory(runDirectory, platform, 'environment lifecycle run directory');
  return Object.freeze({
    protocol: 'devbridge/environment-lifecycle-authority-layout-v1',
    platform,
    authorityIdentity,
    endpointStateDirectory,
    protectedRoot: root,
    codeDirectory: path.posix.join(root, 'code'),
    protectedStateDirectory: path.posix.join(root, 'state'),
    taskPath: null,
    serviceName: `devbridge-lifecycle-authority-${authorityIdentity}.service`,
    runDirectory: runtimeRoot,
  });
}
