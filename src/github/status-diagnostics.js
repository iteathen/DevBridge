import { sanitizeDiagnosticText as sanitizeStatusText } from '../security/diagnostic-redaction.js';
export { sanitizeStatusText };

function prefix(bytes, maximum) {
  let end = Math.min(bytes.length, Math.max(0, maximum));
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function fitLog(bytes, maximum) {
  if (bytes.length <= maximum) return bytes.toString('utf8');
  const omission = '\n    [intermediate text omitted]\n    ';
  const part = Math.max(0, Math.floor((maximum - Buffer.byteLength(omission)) / 2));
  let start = Math.max(0, bytes.length - part);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  // Each retained line is already indented. A tail starting midway through a
  // line gets a fresh indent so guest markup cannot escape its code block.
  return `${prefix(bytes, part)}${omission}${bytes.subarray(start).toString('utf8')}`;
}

function streamBudgets(streams, total) {
  const budgets = streams.map(() => 0);
  const remaining = new Set(streams.map((_, index) => index));
  while (remaining.size) {
    const share = Math.floor(total / remaining.size);
    const small = [...remaining].filter(index => streams[index].bytes.length <= share);
    if (!small.length) {
      for (const index of remaining) budgets[index] = share;
      break;
    }
    for (const index of small) {
      budgets[index] = streams[index].bytes.length;
      total -= budgets[index];
      remaining.delete(index);
    }
  }
  return budgets;
}

export function renderStatusDiagnostics(diagnostics, secrets = [], maxBytes = 20_000) {
  if (!diagnostics) return '';
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024) throw new RangeError('diagnostic comment budget is invalid');
  const evidence = diagnostics;
  const expanded = evidence.expanded?.protocol === 'devbridge/expanded-failure-diagnostics-v1' ? evidence.expanded : null;
  const label = value => prefix(Buffer.from(sanitizeStatusText(String(value ?? 'unknown'), secrets)
    .replace(/[\r\n`]/gu, ' ')), Math.min(120, Math.floor(maxBytes / 16)));
  const lines = [
    `Attempt: ${label(evidence.attempt)}; failing stage: ${label(evidence.stage)}; operation: ${label(evidence.operationId)}.`,
    `Exit status: ${label(evidence.exitCode)}; timed out: ${evidence.timedOut === true}; cancelled: ${evidence.aborted === true}.`,
    `Diagnostic collection: ${evidence.collection === 'available' ? 'available' : 'unavailable'}; retained output truncated: ${(expanded ?? evidence).truncated === true}.`,
  ];
  const ending = [];
  if (expanded) {
    lines.push('', '<details>', '<summary>Expanded diagnostic evidence</summary>', '',
      'Shares this task comment\'s access policy; retained until the comment is updated or removed, or the repository is removed.');
    ending.push('', '</details>');
  }
  if (evidence.collection !== 'available') ending.push('', 'Operation output was not supplied by its owner; the reported error is retained above.');
  const streams = [
    ['Error', evidence.message],
    ['stdout', (expanded ?? evidence).stdout],
    ['stderr', (expanded ?? evidence).stderr],
  ].filter(([, value]) => typeof value === 'string' && value.length).map(([name, value]) => ({
    name,
    // Redaction precedes all byte cuts. Fixed indentation neutralizes guest
    // fences, HTML and mentions, including inside the static details section.
    bytes: Buffer.from(sanitizeStatusText(value, secrets).split(/\r\n|\r|\n/u).map(line => `    ${line}`).join('\n')),
  }));
  const fixedBytes = Buffer.byteLength([...lines, ...ending].join('\n'));
  const budgets = streamBudgets(streams, Math.max(0, maxBytes - fixedBytes - 256));
  for (let index = 0; index < streams.length; index += 1) {
    lines.push('', `${streams[index].name}:`, '', fitLog(streams[index].bytes, budgets[index]));
  }
  if (streams.some((stream, index) => stream.bytes.length > budgets[index])) {
    lines.push('', 'Published evidence is bounded; marked intermediate text was omitted.');
  }
  lines.push(...ending);
  return lines.join('\n');
}
