import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function fail(message) { throw new Error(message); }

function ensureChildDirectory(parent, name) {
  const candidate = path.join(parent, name);
  if (!existsSync(candidate)) mkdirSync(candidate, { mode: 0o700 });
  const info = lstatSync(candidate);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`${name} must be a real directory.`);
  return realpathSync.native(candidate);
}

function safeExistingFile(candidate) {
  if (!existsSync(candidate)) return;
  const info = lstatSync(candidate);
  if (!info.isFile() || info.isSymbolicLink()) fail(`Refusing to replace unsafe target: ${path.basename(candidate)}`);
}

function stageFile(target, content, mode) {
  const next = `${target}.next-${process.pid}-${randomUUID()}`;
  writeFileSync(next, content, { mode, flag: 'wx' });
  if (mode & 0o111) chmodSync(next, mode);
  return Object.freeze({ target, next });
}

function cleanupStagedFile(staged) {
  try { rmSync(staged.next, { force: true }); } catch {}
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

  function publish({ root, subject, selection }) {
    const directory = ensureChildDirectory(root, names.directory);
    const primary = path.join(directory, names.primary);
    const previous = path.join(directory, names.previous);
    const command = path.join(directory, names.command);
    const shell = path.join(directory, names.shell);
    for (const candidate of [primary, previous, command, shell]) safeExistingFile(candidate);

    const previousBytes = existsSync(primary) ? readFileSync(primary) : null;
    const staged = [];
    try {
      if (previousBytes != null) staged.push({ role: 'previous', file: stageFile(previous, previousBytes, 0o700) });
      staged.push({ role: 'command', file: stageFile(command, `@echo off\r\nnode "%~dp0${names.primary}" %*\r\n`, 0o700) });
      staged.push({ role: 'shell', file: stageFile(shell, `#!/bin/sh\nexec node "$(dirname "$0")/${names.primary}" "$@"\n`, 0o700) });
      staged.push({ role: 'primary', file: stageFile(primary, javascriptWrapper(root, subject, selection), 0o700) });

      for (const role of ['previous', 'command', 'shell']) {
        const item = staged.find((entry) => entry.role === role);
        if (item) renameSync(item.file.next, item.file.target);
      }
      const entry = staged.find((item) => item.role === 'primary');
      renameSync(entry.file.next, entry.file.target);
    } catch (error) {
      for (const entry of staged) cleanupStagedFile(entry.file);
      throw error;
    }
    return Object.freeze({ primary, command, shell });
  }

  return Object.freeze({ publish });
}
