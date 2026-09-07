import { createHash, createHmac } from 'node:crypto';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();

// Pure, header-authenticated, signed-payload S3 subset. No transport, credential
// discovery, presigned URLs, session tokens, or administrative operations.
export function signS3RequestHeaders({ method, url, region, date, headers, accessKeyId, secretAccessKey } = {}) {
  if (!['GET', 'HEAD', 'PUT'].includes(method) || !(url instanceof URL)
      || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.search
      || typeof region !== 'string' || !/^[a-z0-9-]{1,32}$/u.test(region)
      || !(date instanceof Date) || !Number.isFinite(date.getTime())
      || typeof accessKeyId !== 'string' || !/^[A-Za-z0-9]{1,128}$/u.test(accessKeyId)
      || typeof secretAccessKey !== 'string' || !/^[\x21-\x7e]{1,256}$/u.test(secretAccessKey)
      || !headers || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new TypeError('S3 signing request is invalid');
  }
  const selected = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[a-z][a-z0-9-]*$/u.test(name) || ['authorization', 'host', 'x-amz-date'].includes(name)
        || typeof value !== 'string' || !/^[\x20-\x7e]+$/u.test(value)) {
      throw new TypeError('S3 signing header is invalid');
    }
    selected[name] = value.trim().replace(/ +/gu, ' ');
  }
  if (!/^[a-f0-9]{64}$/u.test(selected['x-amz-content-sha256'] ?? '')) throw new TypeError('S3 signed payload digest is invalid');
  const timestamp = date.toISOString().replace(/[:-]|\.\d{3}/gu, '');
  if (!/^\d{8}T\d{6}Z$/u.test(timestamp)) throw new TypeError('S3 signing date is invalid');
  selected.host = url.hostname;
  selected['x-amz-date'] = timestamp;
  const names = Object.keys(selected).sort();
  const canonical = [method, url.pathname, '', names.map((name) => `${name}:${selected[name]}\n`).join(''), names.join(';'), selected['x-amz-content-sha256']].join('\n');
  const day = timestamp.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`;
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), 's3'), 'aws4_request');
  const signature = hmac(key, `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(canonical)}`).toString('hex');
  selected.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  return Object.freeze(selected);
}
