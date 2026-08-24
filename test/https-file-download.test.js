import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HttpsFileDownload } from '../src/runtime/https-file-download.js';

async function root() { return mkdtemp(path.join(os.tmpdir(), 'db-https-download-')); }
function body(...chunks) { return { async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield Buffer.from(chunk); } }; }
function failedBody(error, ...chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield Buffer.from(chunk);
      throw error;
    },
  };
}
function responseWithBody(status, stream, headers = {}) {
  const values = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return { status, body: stream, headers: { get: (name) => values.get(String(name).toLowerCase()) ?? null } };
}
function response(status, chunks = [], headers = {}) {
  return responseWithBody(status, chunks === null ? null : body(...chunks), headers);
}

test('HTTPS downloader follows only approved redirect hops and reports final source', async () => {
  const directory = await root();
  try {
    const calls = [];
    const adapter = new HttpsFileDownload({
      allowedHosts: ['releases.example.test', 'cdn.example.test'],
      fetchImpl: async (url) => {
        calls.push(String(url));
        if (calls.length === 1) return response(302, null, { location: 'https://cdn.example.test/media.iso' });
        return response(200, ['abc', 'def'], { 'content-length': '6' });
      },
    });
    const destination = path.join(directory, 'media.iso');
    const result = await adapter.download({ url: 'https://releases.example.test/media.iso', destination });
    assert.deepEqual(calls, ['https://releases.example.test/media.iso', 'https://cdn.example.test/media.iso']);
    assert.equal(result.finalUrl, 'https://cdn.example.test/media.iso');
    assert.equal(result.bytes, 6);
    assert.equal(await readFile(destination, 'utf8'), 'abcdef');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('HTTPS downloader retries a terminated body from clean output and accepts only a complete replacement', async () => {
  const directory = await root();
  try {
    let calls = 0;
    const adapter = new HttpsFileDownload({
      allowedHosts: ['releases.example.test'],
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return responseWithBody(200, failedBody(new TypeError('terminated'), 'partial'), { 'content-length': '8' });
        return response(200, ['complete'], { 'content-length': '8' });
      },
    });
    const destination = path.join(directory, 'media.iso');
    const result = await adapter.download({ url: 'https://releases.example.test/media.iso', destination });
    assert.equal(calls, 2);
    assert.equal(result.bytes, 8);
    assert.equal(await readFile(destination, 'utf8'), 'complete');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('HTTPS downloader bounds repeated transient failures and removes every partial output', async () => {
  const directory = await root();
  try {
    let calls = 0;
    const adapter = new HttpsFileDownload({
      allowedHosts: ['releases.example.test'],
      maxAttempts: 2,
      fetchImpl: async () => {
        calls += 1;
        return responseWithBody(200, failedBody(new TypeError('terminated'), 'partial'));
      },
    });
    const destination = path.join(directory, 'media.iso');
    await assert.rejects(
      () => adapter.download({ url: 'https://releases.example.test/media.iso', destination }),
      /download transport failed after 2 attempt\(s\): terminated/u,
    );
    assert.equal(calls, 2);
    await assert.rejects(() => readFile(destination), /ENOENT/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('HTTPS downloader rejects an unapproved redirect before requesting it', async () => {
  const directory = await root();
  try {
    let calls = 0;
    const adapter = new HttpsFileDownload({
      allowedHosts: ['releases.example.test'],
      fetchImpl: async () => { calls += 1; return response(302, null, { location: 'https://evil.example/media.iso' }); },
    });
    const destination = path.join(directory, 'media.iso');
    await assert.rejects(() => adapter.download({ url: 'https://releases.example.test/media.iso', destination }), /host is not approved/u);
    assert.equal(calls, 1);
    await assert.rejects(() => readFile(destination), /ENOENT/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('HTTPS downloader enforces a streaming byte bound without retry and removes partial output', async () => {
  const directory = await root();
  try {
    let calls = 0;
    const adapter = new HttpsFileDownload({
      allowedHosts: ['releases.example.test'], maxBytes: 5,
      fetchImpl: async () => { calls += 1; return response(200, ['abc', 'def']); },
    });
    const destination = path.join(directory, 'media.iso');
    await assert.rejects(() => adapter.download({ url: 'https://releases.example.test/media.iso', destination }), /byte bound/u);
    assert.equal(calls, 1);
    await assert.rejects(() => readFile(destination), /ENOENT/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('HTTPS downloader refuses a non-real parent and does not replace caller data', async () => {
  const directory = await root();
  try {
    let calls = 0;
    const adapter = new HttpsFileDownload({
      allowedHosts: ['releases.example.test'],
      fetchImpl: async () => { calls += 1; return response(200, ['new']); },
    });
    const destination = path.join(directory, 'media.iso');
    await writeFile(destination, 'caller');
    await assert.rejects(() => adapter.download({ url: 'https://releases.example.test/media.iso', destination }), /already exists/u);
    assert.equal(calls, 0);
    assert.equal(await readFile(destination, 'utf8'), 'caller');

    const missingParent = path.join(directory, 'absent', 'media.iso');
    await assert.rejects(() => adapter.download({ url: 'https://releases.example.test/media.iso', destination: missingParent }), /ENOENT/u);
    assert.equal(calls, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
