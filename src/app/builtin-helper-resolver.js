import { readFile } from 'node:fs/promises';
import {
  CHAT_C_PROJECT_DIAGNOSTIC_PROFILE,
  LIFECYCLE_ROUNDTRIP_DIAGNOSTIC_PROFILE,
  NATIVE_COMPILER_DIAGNOSTIC_PROFILE,
  TRANSIENT_RECOVERY_DIAGNOSTIC_PROFILE,
} from '../runtime/builtin-tool-profiles.js';

const DEFINITIONS = new Map([
  [NATIVE_COMPILER_DIAGNOSTIC_PROFILE, {
    entry: 'native-compiler-probe-cli.js',
    files: ['native-compiler-probe-cli.js', 'native-compiler-probe.js', 'executable-resolver.js', 'process-tree.js', 'result-emission.js'],
  }],
  [CHAT_C_PROJECT_DIAGNOSTIC_PROFILE, {
    entry: 'chat-c-project-probe-cli.js',
    files: ['chat-c-project-probe-cli.js', 'chat-c-project-probe.js', 'executable-resolver.js', 'process-tree.js', 'result-emission.js'],
  }],
  [LIFECYCLE_ROUNDTRIP_DIAGNOSTIC_PROFILE, {
    entry: 'lifecycle-roundtrip-probe-cli.js',
    files: ['lifecycle-roundtrip-probe-cli.js', 'lifecycle-roundtrip-probe.js', 'process-tree.js', 'result-emission.js'],
  }],
  [TRANSIENT_RECOVERY_DIAGNOSTIC_PROFILE, {
    entry: 'transient-recovery-probe-cli.js',
    files: ['transient-recovery-probe-cli.js', 'result-emission.js'],
  }],
]);

async function runtimeResource(name) {
  return { path: `runtime/${name}`, bytes: await readFile(new URL(`../runtime/${name}`, import.meta.url)) };
}

export async function resolveBuiltInHelper(name) {
  const definition = DEFINITIONS.get(name);
  if (!definition) return null;
  const resources = await Promise.all(definition.files.map(runtimeResource));
  if (definition.files.includes('executable-resolver.js')) {
    resources.push({ path: 'errors.js', bytes: await readFile(new URL('../errors.js', import.meta.url)) });
  }
  resources.push({ path: 'package.json', bytes: Buffer.from('{"type":"module"}\n', 'utf8') });
  resources.sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze({
    program: 'node',
    arguments: Object.freeze([]),
    entry: `runtime/${definition.entry}`,
    resources: Object.freeze(resources.map((resource) => Object.freeze({ path: resource.path, bytes: Buffer.from(resource.bytes) }))),
  });
}
