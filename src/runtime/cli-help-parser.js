import { createHash } from 'node:crypto';
import { PolicyError } from '../errors.js';

const MAX_HELP_BYTES = 256 * 1024;
const MAX_ARGUMENTS = 48;
const FORBIDDEN_NAMES = new Set([
  'command', 'shell', 'argv', 'args', 'executable', 'cwd', 'localpath', 'absolutepath',
  'environment', 'env', 'credentials', 'credential', 'capabilities', 'gitref', 'gitsha',
  'cleanuproot', 'module', 'plugin', 'faultinjection', 'exec', 'eval', 'require', 'chdir',
]);

function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }

function parameterName(value) {
  const normalized = String(value).replace(/^--?/u, '').replace(/[^A-Za-z0-9_-]+/gu, '_')
    .replace(/-+/gu, '_').replace(/^_+|_+$/gu, '').toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,79}$/u.test(normalized)) return null;
  if (FORBIDDEN_NAMES.has(normalized.replace(/[_-]/gu, ''))) return null;
  return normalized;
}

function valueType(value) {
  const normalized = String(value ?? '').replace(/[<>\[\]]/gu, '').toUpperCase();
  if (/(?:PATH|FILE|DIR|DIRECTORY|ROOT|DEST|SOURCE)/u.test(normalized)) return 'project-path';
  if (/(?:NUM|COUNT|JOBS|THREADS|PORT|SIZE|LIMIT|DEPTH)/u.test(normalized)) return 'integer';
  return 'string';
}

function commandsFrom(lines) {
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

function optionsFrom(lines, used) {
  const result = [];
  const flags = new Set();
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('-')) continue;
    const match = trimmed.match(/(?:^|[\s,])(--[A-Za-z0-9][A-Za-z0-9-]{0,79})(?:(?:=|\s+)(<[^>]{1,40}>|\[[A-Za-z][A-Za-z0-9_-]{0,39}\]|[A-Z][A-Z0-9_-]{0,39}(?=$|\s{2,})))?/u);
    if (!match || flags.has(match[1])) continue;
    const param = parameterName(match[1]);
    if (!param || used.has(param)) continue;
    flags.add(match[1]);
    used.add(param);
    result.push(match[2]
      ? { kind: 'option', param, flag: match[1], required: false, repeat: false, valueType: valueType(match[2]) }
      : { kind: 'flag', param, flag: match[1] });
    if (result.length >= MAX_ARGUMENTS) break;
  }
  return result;
}

function usageTokens(lines) {
  const line = lines.find((entry) => /^\s*usage\s*:/iu.test(entry));
  if (!line) return [];
  const matches = line.replace(/^\s*usage\s*:\s*/iu, '')
    .match(/<[^>]{1,40}>|\[[A-Za-z][A-Za-z0-9_-]{0,39}(?:\s+\.\.\.)?\](?:\.\.\.)?|\b[A-Z][A-Z0-9_-]{1,39}(?:\.\.\.)?/gu) ?? [];
  return matches.filter((token) => !/^\[?(?:OPTIONS?|FLAGS?)\]?(?:\.\.\.)?$/u.test(token));
}

function positionalsFrom(lines, commands, used, limit) {
  const result = [];
  for (const token of usageTokens(lines)) {
    if (result.length >= limit) break;
    const optional = token.startsWith('[');
    const repeat = /\.\.\.?\]?$/u.test(token) || /\s+\.\.\.\]$/u.test(token);
    const metavar = token.replace(/[<>\[\]]/gu, '').replace(/\.\.\./gu, '').trim();
    const upper = metavar.toUpperCase();
    if (['OPTION', 'OPTIONS', 'FLAG', 'FLAGS'].includes(upper)) continue;
    if ((upper === 'COMMAND' || upper === 'SUBCOMMAND') && commands.length > 0) {
      if (used.has('subcommand')) continue;
      used.add('subcommand');
      result.push({ kind: 'positional', param: 'subcommand', required: !optional, repeat: false, valueType: 'enum', values: [...commands].sort(compare) });
      continue;
    }
    const param = parameterName(metavar);
    if (!param || used.has(param)) continue;
    used.add(param);
    const descriptor = { kind: 'positional', param, required: !optional, repeat, valueType: valueType(metavar) };
    if (repeat) descriptor.maxItems = 16;
    result.push(descriptor);
  }
  return result;
}

export function parseCliHelp(value) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_HELP_BYTES) throw new PolicyError('CLI help text must be non-empty and bounded');
  const clean = value.replace(/\r\n?/gu, '\n').replace(/[\u0000\u001b]/gu, '');
  const lines = clean.split('\n').slice(0, 4096);
  const commands = commandsFrom(lines);
  const used = new Set();
  const options = optionsFrom(lines, used);
  return {
    arguments: [...options, ...positionalsFrom(lines, commands, used, Math.max(0, MAX_ARGUMENTS - options.length))],
    commands,
    helpSha256: createHash('sha256').update(clean, 'utf8').digest('hex'),
  };
}
