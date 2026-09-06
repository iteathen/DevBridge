import test from 'node:test';
import assert from 'node:assert/strict';
import { captureFailureDiagnostics } from '../src/run/failure-diagnostics.js';
import { renderStatusDiagnostics } from '../src/github/status-diagnostics.js';

test('diagnostic tails retain exit status and disclose missing/truncated evidence with bounded UTF-8', () => {
  const value = captureFailureDiagnostics({ stage: 'compile', attempt: 3, operationId: 'build', result: { exitCode: 100, stderr: `${'é'.repeat(9000)}missing dependency`, outputTruncated: true } });
  assert.equal(value.exitCode, 100);
  assert.equal(value.truncated, true);
  assert.ok(Buffer.byteLength(value.stderr) <= 8_000);
  assert.doesNotMatch(value.stderr, /\uFFFD/u);
  assert.match(value.stderr, /missing dependency$/u);
  const missing = captureFailureDiagnostics({ stage: 'transfer', error: new Error('channel unavailable') });
  assert.equal(missing.exitCode, null);
  assert.equal(missing.collection, 'unavailable');
  assert.match(renderStatusDiagnostics(missing), /Exit status: unknown/);
});

test('public diagnostics redact secrets, private keys and host paths and neutralize guest markup', () => {
  const evidence = captureFailureDiagnostics({ stage: 'test', attempt: 2, error: new Error('failed'), result: { exitCode: 1,
    stderr: 'fixture-secret\nTOKEN=hidden-value\nC:\\private\\host.txt\n/private/key.txt\n-----BEGIN OPENSSH PRIVATE KEY-----\nkey-data\n-----END OPENSSH PRIVATE KEY-----\n```\n@someone <script>alert(1)</script>\n\x1b[31munmet dependency',
  } });
  const rendered = renderStatusDiagnostics(evidence, ['fixture-secret']);
  assert.doesNotMatch(rendered, /fixture-secret|hidden-value|key-data|private\\|\/private|\x1b/u);
  assert.match(rendered, /\n    ```\n    @someone/);
  assert.match(rendered, /unmet dependency/);
});

test('capture redacts complete credentials and PEM blocks before a byte boundary cuts their recognizers', () => {
  const secret = 'registered-secret-with-spaces ' + 'a'.repeat(9000);
  const evidence = captureFailureDiagnostics({ stage: 'test', secretValues: [secret],
    error: new Error('x'.repeat(3990) + secret),
    result: { exitCode: 1, stderr: secret + '\n-----BEGIN PRIVATE KEY-----\n' + 'key-data\n'.repeat(1200) + '-----END PRIVATE KEY-----\nUseful failure' },
  });
  assert.doesNotMatch(JSON.stringify(evidence), /registered-secret|aaaa|key-data/);
  assert.match(evidence.stderr, /Useful failure/);
});
