import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function runAbortCase(preAborted) {
  const script = `
    import { EventEmitter } from 'node:events';
    import { superviseDaemon } from './src/bootstrap/transactional-bootstrap.mjs';

    const paths = {
      home: '/managed',
      runtime: '/managed/runtime',
      runtimeCandidates: '/managed/runtime-candidates',
      activationStateFile: '/managed/runtime-activation.json',
      config: '/operator/config.json',
    };
    const runtime = {
      head: 'a'.repeat(40),
      ref: 'main',
      cliPath: '/managed/runtime/src/cli.js',
      runtimeDir: '/managed/runtime',
      version: '0.1.0',
    };
    const child = new EventEmitter();
    child.pid = 9001;
    const controller = new AbortController();
    let stopCalls = 0;

    if (${preAborted ? 'true' : 'false'}) controller.abort();
    else setTimeout(() => controller.abort(), 10);

    const result = await superviseDaemon(
      { channel: 'testing', update: false },
      paths,
      runtime,
      {
        spawnImpl: () => child,
        maxIterations: 1,
        stopExisting: false,
        signal: controller.signal,
        runDevBridgeCliFn: (command) => {
          if (command !== 'stop') return 0;
          stopCalls += 1;
          setTimeout(() => child.emit('exit', 0, null), 10);
          return 0;
        },
      },
    );

    process.stdout.write(JSON.stringify({ result, stopCalls }));
  `;

  return spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 2_000,
    windowsHide: true,
  });
}

for (const preAborted of [false, true]) {
  test(`operator ${preAborted ? 'pre-abort' : 'abort'} requests one stop and observes daemon exit`, () => {
    const observed = runAbortCase(preAborted);
    assert.equal(observed.error, undefined, observed.error?.message);
    assert.equal(observed.status, 0, observed.stderr || observed.stdout);
    const line = observed.stdout.trim().split(/\r?\n/u).at(-1);
    assert.deepEqual(JSON.parse(line), { result: 0, stopCalls: 1 });
  });
}
