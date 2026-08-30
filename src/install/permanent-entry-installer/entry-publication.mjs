import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import process from 'node:process';

const MAX_WRAPPER_BYTES = 512 * 1024;

function fail(message) { throw new Error(message); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function samePath(left, right) {
  const selectedLeft = path.resolve(left);
  const selectedRight = path.resolve(right);
  return process.platform === 'win32'
    ? selectedLeft.toLowerCase() === selectedRight.toLowerCase()
    : selectedLeft === selectedRight;
}

function sameFile(left, right) {
  if (left.ino === 0n || right.ino === 0n || left.ino !== right.ino) return false;
  if (left.dev === 0n || right.dev === 0n) return process.platform === 'win32';
  return left.dev === right.dev;
}

function ensureChildDirectory(parent, name) {
  const candidate = path.join(parent, name);
  try { mkdirSync(candidate, { mode: 0o700 }); }
  catch (error) { if (error?.code !== 'EEXIST') throw error; }
  const info = lstatSync(candidate);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`${name} must be a real directory.`);
  return realpathSync.native(candidate);
}

function existingChildDirectory(parent, name) {
  const candidate = path.join(parent, name);
  const info = lstatSync(candidate);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`${name} must be a real directory.`);
  return realpathSync.native(candidate);
}

function exactChild(root, candidate, name) {
  const selectedRoot = path.resolve(root);
  const selected = path.resolve(candidate);
  if (path.dirname(selected) !== selectedRoot || selected === selectedRoot) fail(`${name} is outside its owned root.`);
  return selected;
}

function fileBytes(candidate) {
  let descriptor;
  let observed = false;
  try {
    const before = lstatSync(candidate, { bigint: true });
    observed = true;
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(MAX_WRAPPER_BYTES)) {
      fail(`Refusing unsafe entry state: ${path.basename(candidate)}`);
    }
    const actual = realpathSync.native(candidate);
    if (!samePath(actual, candidate)) fail(`Refusing indirect entry state: ${path.basename(candidate)}`);
    descriptor = openSync(candidate, 'r');
    const held = fstatSync(descriptor, { bigint: true });
    if (!held.isFile() || held.nlink !== 1n || held.size > BigInt(MAX_WRAPPER_BYTES)
        || held.size !== before.size || !sameFile(before, held)) {
      fail(`Entry state changed while opening: ${path.basename(candidate)}`);
    }
    const bytes = readFileSync(descriptor);
    const heldAfter = fstatSync(descriptor, { bigint: true });
    const after = lstatSync(candidate, { bigint: true });
    if (!heldAfter.isFile() || heldAfter.nlink !== 1n || heldAfter.size !== held.size
        || !sameFile(held, heldAfter) || !after.isFile() || after.isSymbolicLink() || after.nlink !== 1n
        || after.size !== held.size || !sameFile(held, after) || BigInt(bytes.length) !== held.size
        || !samePath(realpathSync.native(candidate), candidate)) {
      fail(`Entry state changed during observation: ${path.basename(candidate)}`);
    }
    return bytes;
  } catch (error) {
    if (!observed && error?.code === 'ENOENT') return null;
    throw error;
  } finally {
    if (descriptor != null) closeSync(descriptor);
  }
}

export function createEntryPublication({ statusProtocol, isExactSubject, names, route }) {
  if (typeof statusProtocol !== 'string' || statusProtocol.length < 1) throw new TypeError('statusProtocol must be non-empty text');
  if (typeof isExactSubject !== 'function') throw new TypeError('isExactSubject must be a function');
  const requiredNames = ['directory', 'primary', 'previous', 'command', 'shell'];
  for (const name of requiredNames) {
    const value = names?.[name];
    if (typeof value !== 'string' || value.length < 1 || path.basename(value) !== value) {
      throw new TypeError(`names.${name} must be one safe name`);
    }
  }
  for (const name of ['targetPrefix', 'targetSuffix', 'operation', 'statusAction', 'homeFlag', 'selectionFlag', 'alternateSelectionFlag', 'errorPrefix']) {
    if (typeof route?.[name] !== 'string' || route[name].length < 1) throw new TypeError(`route.${name} must be non-empty text`);
  }
  if (!Array.isArray(route.selectionAliases) || route.selectionAliases.length < 1 ||
      route.selectionAliases.some((value) => typeof value !== 'string' || value.length < 1)) {
    throw new TypeError('route.selectionAliases must be a non-empty text array');
  }

  function javascriptWrapper(root, subject, selection) {
    const selected = selection == null ? 'null' : JSON.stringify(selection);
    const pinned = selection != null && isExactSubject(selection) ? JSON.stringify(String(selection).toLowerCase()) : 'null';
    const target = `${route.targetPrefix}${subject}${route.targetSuffix}`;
    return `#!/usr/bin/env node
import process from 'node:process';
const home = ${JSON.stringify(root)};
const componentHead = '${subject}';
const componentUrl = new URL(${JSON.stringify(target)}, import.meta.url).href;
const selected = ${selected};
const pinned = ${pinned};
const argv = [...process.argv.slice(2)];
if (argv[0] === ${JSON.stringify(route.statusAction)}) {
  if (argv.length !== 1) throw new Error(${JSON.stringify(`${route.statusAction} accepts no additional arguments`)});
  process.stdout.write(JSON.stringify({ protocol: '${statusProtocol}', home, componentHead, selectedRunnerRef: selected, pinnedRunnerHead: pinned }) + '\\n');
} else {
  const hasHome = argv.some((value) => value === ${JSON.stringify(route.homeFlag)});
  const hasSelector = argv.some((value) => ${JSON.stringify(route.selectionAliases)}.includes(value));
  const hasAlternateSelector = argv.some((value) => value === ${JSON.stringify(route.alternateSelectionFlag)});
  if (!hasHome) argv.push(${JSON.stringify(route.homeFlag)}, home);
  if (pinned && !hasSelector) argv.unshift(${JSON.stringify(route.selectionFlag)}, pinned);
  else if (selected && !hasSelector && !hasAlternateSelector) argv.unshift(${JSON.stringify(route.alternateSelectionFlag)}, selected);
  try {
    const module = await import(componentUrl);
    const operation = module?.[${JSON.stringify(route.operation)}];
    if (typeof operation !== 'function') throw new Error('installed entry operation is unavailable');
    const status = await operation(argv);
    if (Number.isInteger(status)) process.exitCode = status;
  } catch (error) {
    process.stderr.write(${JSON.stringify(route.errorPrefix)} + String(error?.message ?? error) + '\\n');
    process.exitCode = 1;
  }
}
`;
  }

  function recognizedJavascript(bytes, root) {
    if (!bytes || bytes.length < 1 || bytes.length > MAX_WRAPPER_BYTES) return null;
    const source = bytes.toString('utf8');
    const homeMatch = source.match(/^const home = (.+);$/mu);
    const subjectMatch = source.match(/^const componentHead = '([0-9a-f]{40})';$/mu);
    const selectedMatch = source.match(/^const selected = (.+);$/mu);
    if (!homeMatch || !subjectMatch || !selectedMatch) return null;
    let home;
    let selection;
    try {
      home = JSON.parse(homeMatch[1]);
      selection = JSON.parse(selectedMatch[1]);
    } catch { return null; }
    if (home !== root || (selection != null && typeof selection !== 'string')) return null;
    const subject = subjectMatch[1];
    const expected = Buffer.from(javascriptWrapper(root, subject, selection), 'utf8');
    return expected.equals(bytes) ? Object.freeze({ subject, selection }) : null;
  }

  function fixedBytes(role) {
    if (role === 'command') return Buffer.from(`@echo off\r\nnode "%~dp0${names.primary}" %*\r\n`, 'utf8');
    if (role === 'shell') return Buffer.from(`#!/bin/sh\nexec node "$(dirname "$0")/${names.primary}" "$@"\n`, 'utf8');
    throw new TypeError('entry role has no fixed bytes');
  }

  function observeFile(candidate, expected, { generated = false, root = null } = {}) {
    const bytes = fileBytes(candidate);
    if (bytes == null) return Object.freeze({ state: 'absent', digest: null, bytes: null, metadata: null });
    const sha256 = digest(bytes);
    if (expected && expected.equals(bytes)) return Object.freeze({ state: 'exact', digest: sha256, bytes, metadata: null });
    if (generated) {
      const metadata = recognizedJavascript(bytes, root);
      if (metadata) return Object.freeze({ state: 'generated', digest: sha256, bytes, metadata });
    }
    return Object.freeze({ state: 'foreign', digest: sha256, bytes: null, metadata: null });
  }

  function inspect({ root, subject, selection }) {
    const directory = existingChildDirectory(root, names.directory);
    const targets = Object.freeze(Object.fromEntries(['primary', 'previous', 'command', 'shell']
      .map((role) => [role, path.join(directory, names[role])])));
    const primaryBytes = Buffer.from(javascriptWrapper(root, subject, selection), 'utf8');
    return Object.freeze({
      root,
      directory,
      subject,
      selection,
      targets,
      desired: Object.freeze({ primary: primaryBytes, command: fixedBytes('command'), shell: fixedBytes('shell') }),
      observed: Object.freeze({
        primary: observeFile(targets.primary, primaryBytes, { generated: true, root }),
        previous: observeFile(targets.previous, null, { generated: true, root }),
        command: observeFile(targets.command, fixedBytes('command')),
        shell: observeFile(targets.shell, fixedBytes('shell')),
      }),
    });
  }

  function plan(input) {
    const observed = inspect(input);
    for (const role of ['primary', 'previous', 'command', 'shell']) {
      if (observed.observed[role].state === 'foreign') fail(`Refusing to replace unrecognized entry state: ${names[role]}`);
    }
    const changes = [];
    const primary = observed.observed.primary;
    if (primary.state === 'generated') {
      changes.push(Object.freeze({
        role: 'previous', target: observed.targets.previous, bytes: primary.bytes, mode: 0o700,
        beforeDigest: observed.observed.previous.digest,
      }));
    }
    for (const role of ['command', 'shell']) {
      if (observed.observed[role].state === 'absent') changes.push(Object.freeze({
        role, target: observed.targets[role], bytes: observed.desired[role], mode: 0o700, beforeDigest: null,
      }));
    }
    if (primary.state !== 'exact') changes.push(Object.freeze({
      role: 'primary', target: observed.targets.primary, bytes: observed.desired.primary, mode: 0o700,
      beforeDigest: primary.digest,
    }));
    return Object.freeze({ ...observed, changes: Object.freeze(changes) });
  }

  function comparablePlan(value) {
    return Object.freeze({ root: value.root, subject: value.subject, selection: value.selection, observed: value.observed, changes: value.changes });
  }

  function apply({ prepared, stages }) {
    if (!prepared || !stages || typeof stages !== 'object' || Array.isArray(stages)) {
      throw new TypeError('entry publication application is invalid');
    }
    const current = plan({ root: prepared.root, subject: prepared.subject, selection: prepared.selection });
    if (!isDeepStrictEqual(comparablePlan(current), comparablePlan(prepared))) fail('Entry state changed after planning.');
    const expectedRoles = current.changes.map((entry) => entry.role).sort();
    if (!isDeepStrictEqual(Object.keys(stages).sort(), expectedRoles)) throw new TypeError('entry stage set is invalid');
    const created = [];
    try {
      for (const change of current.changes) {
        const stage = exactChild(current.directory, stages[change.role], 'Entry stage path');
        if (Object.values(current.targets).includes(stage)) fail('Entry stage path conflicts with an active target.');
        writeFileSync(stage, change.bytes, { mode: change.mode, flag: 'wx' });
        chmodSync(stage, change.mode);
        created.push(Object.freeze({ role: change.role, stage, change }));
      }
      for (const role of ['previous', 'command', 'shell', 'primary']) {
        const selected = created.find((entry) => entry.role === role);
        if (!selected) continue;
        renameSync(selected.stage, selected.change.target);
        const accepted = fileBytes(selected.change.target);
        if (!accepted?.equals(selected.change.bytes)) fail(`Published entry state changed: ${names[role]}`);
      }
    } catch (error) {
      for (const selected of created) {
        try { rmSync(selected.stage, { force: true }); } catch {}
      }
      throw error;
    }
    const accepted = plan({ root: prepared.root, subject: prepared.subject, selection: prepared.selection });
    if (accepted.changes.length !== 0) fail('Entry publication did not reconcile to its desired state.');
    return Object.freeze({ primary: accepted.targets.primary, command: accepted.targets.command, shell: accepted.targets.shell });
  }

  return Object.freeze({ open: (root) => ensureChildDirectory(root, names.directory), inspect, plan, apply });
}
