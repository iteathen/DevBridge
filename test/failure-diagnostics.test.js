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
  assert.doesNotMatch(captureFailureDiagnostics({ stage: 'test', error: new Error('API_KEY=sensitive-key AWS_ACCESS_KEY_ID=another-key') }).message, /sensitive-key|another-key/);
});

test('collected early failure text beyond the compact tail is automatically supplied as bounded expanded evidence', () => {
  const stderr = `FIRST_CAUSE matching dependency rejected\n${'follow-up detail\n'.repeat(750)}LAST_FAILURE`;
  const evidence = captureFailureDiagnostics({ stage: 'apt-install', attempt: 2, result: { exitCode: 100, stderr } });
  assert.doesNotMatch(evidence.stderr, /FIRST_CAUSE/);
  const rendered = renderStatusDiagnostics(evidence, [], 40_000);
  assert.match(rendered, /FIRST_CAUSE/);
  assert.match(rendered, /LAST_FAILURE/);
  assert.match(rendered, /Expanded diagnostic evidence/);
  assert.match(rendered, /retained until.*comment.*removed/i);
  assert.equal(evidence.expanded.truncated, false);
  assert.equal(evidence.expanded.stderr, stderr);
});

test('expanded capture redacts complete secrets before its larger bound and discloses owner and retention truncation', () => {
  const secret = 'expanded-private-token ' + 'x'.repeat(20_000);
  const evidence = captureFailureDiagnostics({ stage: 'install', secretValues: [secret], result: {
    exitCode: 100, stdout: secret + '\n' + 'é'.repeat(12_000) + 'FINAL_STDOUT',
    stderr: 'z'.repeat(17_000) + 'FINAL_STDERR', outputTruncated: true,
  } });
  assert.doesNotMatch(JSON.stringify(evidence), /expanded-private|xxxx|\uFFFD/u);
  assert.ok(Buffer.byteLength(evidence.expanded.stdout) <= 16_384);
  assert.ok(Buffer.byteLength(evidence.expanded.stderr) <= 16_384);
  assert.equal(evidence.expanded.truncated, true);
});

test('bounded expanded rendering preserves both stream endpoints despite hostile newline and Unicode floods', () => {
  const evidence = captureFailureDiagnostics({ stage: 'install', result: {
    exitCode: 100,
    stdout: `STDOUT_BEGIN\n${'\n'.repeat(9000)}STDOUT_END`,
    stderr: `STDERR_BEGIN\n${'é\n'.repeat(4000)}\n</details>\n@someone\nSTDERR_END`,
  } });
  const rendered = renderStatusDiagnostics(evidence, [], 3000);
  assert.ok(Buffer.byteLength(rendered) <= 3000);
  assert.match(rendered, /STDOUT_BEGIN/);
  assert.match(rendered, /STDOUT_END/);
  assert.match(rendered, /STDERR_BEGIN/);
  assert.match(rendered, /STDERR_END/);
  assert.match(rendered, /intermediate text omitted/);
  assert.match(rendered, /\n    @someone/);
  assert.equal(rendered.match(/^<\/details>$/gm)?.length, 1);
  assert.doesNotMatch(rendered, /\uFFFD/u);
});

test('carriage-return-only guest lines remain inert in compact and expanded diagnostic code blocks', () => {
  for (const padding of ['', 'detail\r'.repeat(1400)]) {
    const evidence = captureFailureDiagnostics({ stage: 'install', result: { exitCode: 100,
      stderr: `${padding}failed\r\r@someone\r<script>alert(1)</script>\rFINAL_FAILURE`,
    } });
    const rendered = renderStatusDiagnostics(evidence, [], 40_000);
    assert.doesNotMatch(rendered, /\r/u);
    assert.match(rendered, /\n    @someone\n    <script>/);
    assert.match(rendered, /\n    FINAL_FAILURE/);
  }
});
