import { createHash } from 'node:crypto';
import { PolicyError } from '../errors.js';

const MAX_HELP_BYTES = 256 * 1024;
const MAX_SYNTHESIZED_ARGUMENTS = 48;
const FORBIDDEN_PARAMETER_NAMES = new Set([
  'command', 'shell', 'argv', 'args', 'executable', 'cwd', 'localpath', 'absolutepath',
  'environment', 'env', 'credentials', 'credential', 'capabilities', 'gitref', 'gitsha',
  'cleanuproot', 'module', 'plugin', 'faultinjection', 'exec', 'eval', 'require', 'chdir',
]);

function codepointCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedParam(name) {
  const normalized = String(name)
    .replace(/^--?/u, '')
    .replace(/[^A-Za-z0-9_-]+/gu, '_')
    .replace(/-+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,79}$/u.test(normalized)) return null;
  if (FORBIDDEN_PARAMETER_NAMES.has(normalized.replace(/[_-]/gu, ''))) return null;
  return normalized;
}

function valueTypeForMetavar(raw) {
  const value = String(raw ?? '').replace(/[<>\[\]]/gu, '').toUpperCase();
  if (/(?:PATH|FILE|DIR|DIRECTORY|ROOT|DEST|SOURCE)/u.test(value)) return 'project-path';
  if (/(?:NUM|COUNT|JOBS|THREADS|PORT|SIZE|LIMIT|DEPTH)/u.test(value)) return 'integer';
  return 'string';
}

function parseCommands(lines) {
  const commands = [];
  let active = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(?:commands|subcommands):?$/iu.test(trimmed)) { active = true; continue; }
    if (!active) continue;
    if (trimmed === '') { if (commands.length > 0) break; continue; }
    if (/^[A-Za-z][A-Za-z ]+:$/u.test(trimmed) && !/^[a-z0-9_.-]+\s/iu.test(trimmed)) break;
    const match = line.match(/^\s{1,12}([A-Za-z0-9][A-Za-z0-9_.-]{0,63})(?:\s{2,}|\t)/u);
    if (!match) { if (commands.length > 0 && !/^\s/u.test(line)) break; continue; }
    if (!commands.includes(match[1])) commands.push(match[1]);
    if (commands.length >= 32) break;
  }
  return commands;
}

function parseOptions(lines, usedParams) {
  const descriptors = [];
  const seenFlags = new Set();
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('-')) continue;
    const match = trimmed.match(/(?:^|[\s,])(--[A-Za-z0-9][A-Za-z0-9-]{0,79})(?:(?:=|\s+)(<[^>]{1,40}>|\[[A-Za-z][A-Za-z0-9_-]{0,39}\]|[A-Z][A-Z0-9_-]{0,39}(?=$|\s{2,})))?/u);
    if (!match) continue;
    const flag = match[1];
    if (seenFlags.has(flag)) continue;
    const param = normalizedParam(flag);
    if (!param || usedParams.has(param)) continue;
    seenFlags.add(flag);
    usedParams.add(param);
    descriptors.push(match[2]
      ? { kind: 'option', param, flag, required: false, repeat: false, valueType: valueTypeForMetavar(match[2]) }
      : { kind: 'flag', param, flag });
    if (descriptors.length >= MAX_SYNTHESIZED_ARGUMENTS) break;
  }
  return descriptors;
}

function usageTokens(lines) {
  const usageLine = lines.find((line) => /^\s*usage\s*:/iu.test(line));
  if (!usageLine) return [];
  const body = usageLine.replace(/^\s*usage\s*:\s*/iu, '');
  const matches = body.match(/<[^>]{1,40}>|\[[A-Za-z][A-Za-z0-9_-]{0,39}(?:\s+\.\.\.)?\](?:\.\.\.)?|\b[A-Z][A-Z0-9_-]{1,39}(?:\.\.\.)?/gu) ?? [];
  return matches.filter((token) => !/^\[?(?:OPTIONS?|FLAGS?)\]?(?:\.\.\.)?$/u.test(token));
}

function parsePositionals(lines, commands, usedParams, remaining) {
  const descriptors = [];
  for (const rawToken of usageTokens(lines)) {
    if (descriptors.length >= remaining) break;
    const optional = rawToken.startsWith('[');
    const repeat = /\.\.\.?\]?$/u.test(rawToken) || /\s+\.\.\.\]$/u.test(rawToken);
    const metavar = rawToken.replace(/[<>\[\]]/gu, '').replace(/\.\.\./gu, '').trim();
    const upper = metavar.toUpperCase();
    if (['OPTION', 'OPTIONS', 'FLAG', 'FLAGS'].includes(upper)) continue;
    if ((upper === 'COMMAND' || upper === 'SUBCOMMAND') && commands.length > 0) {
      if (usedParams.has('subcommand')) continue;
      usedParams.add('subcommand');
      descriptors.push({ kind: 'positional', param: 'subcommand', required: !optional, repeat: false, valueType: 'enum', values: [...commands].sort(codepointCompare) });
      continue;
    }
    const param = normalizedParam(metavar);
    if (!param || usedParams.has(param)) continue;
    usedParams.add(param);
    const descriptor = { kind: 'positional', param, required: !optional, repeat, valueType: valueTypeForMetavar(metavar) };
    if (repeat) descriptor.maxItems = 16;
    descriptors.push(descriptor);
  }
  return descriptors;
}

export function parseCliHelp(helpText) {
  if (typeof helpText !== 'string' || helpText.length === 0 || Buffer.byteLength(helpText, 'utf8') > MAX_HELP_BYTES) {
    throw new PolicyError('CLI help text must be non-empty and bounded');
  }
  const clean = helpText.replace(/\r\n?/gu, '\n').replace(/[\u0000\u001b]/gu, '');
  const lines = clean.split('\n').slice(0, 4096);
  const commands = parseCommands(lines);
  const usedParams = new Set();
  const options = parseOptions(lines, usedParams);
  return {
    arguments: [...options, ...parsePositionals(lines, commands, usedParams, Math.max(0, MAX_SYNTHESIZED_ARGUMENTS - options.length))],
    commands,
    helpSha256: createHash('sha256').update(clean, 'utf8').digest('hex'),
  };
}
