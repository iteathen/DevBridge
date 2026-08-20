const PREFIX = '\u001eRESULT_JSON ';
const MAX_RESULT_BYTES = 1_048_576;

function resultText(value) {
  const text = JSON.stringify(value);
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_RESULT_BYTES) throw new TypeError('result must be bounded JSON');
  return text;
}

export function emitResult(value, write = (text) => process.stdout.write(text)) {
  const encoded = Buffer.from(resultText(value), 'utf8').toString('base64');
  write(`${PREFIX}${encoded}\n`);
}

export function extractResultEmission(value) {
  const text = String(value ?? '');
  const lines = text.split(/(?<=\n)/u);
  const records = [];
  const retained = [];
  for (const line of lines) {
    const normalized = line.endsWith('\n') ? line.slice(0, -1).replace(/\r$/u, '') : line;
    if (normalized.startsWith(PREFIX)) records.push(normalized.slice(PREFIX.length));
    else retained.push(line);
  }
  if (records.length === 0) return { text: null, output: text };
  if (records.length !== 1 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(records[0])) {
    throw new TypeError('result emission must contain exactly one valid record');
  }
  const decoded = Buffer.from(records[0], 'base64');
  if (decoded.length > MAX_RESULT_BYTES || decoded.toString('base64') !== records[0]) throw new TypeError('result emission is invalid or exceeds its bound');
  return { text: decoded.toString('utf8'), output: retained.join('') };
}
