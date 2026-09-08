import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEnvironmentLifecycleDiagnostics } from '../src/runtime/environment-lifecycle-diagnostics.js';
import { createEnvironmentLifecycleStateStore } from '../src/state/environment-lifecycle-state-store.js';
import { createLifecycleAuthorityReadHandler, createLifecycleAuthorityMutationHandler, LifecycleAuthorityClient } from '../src/runtime/environment-lifecycle-authority.js';

test('native failure facts survive restart and pass the versioned read contract without executing work', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'devbridge-lifecycle-diagnostics-'));
  try {
    const create = () => createEnvironmentLifecycleDiagnostics({ port: createEnvironmentLifecycleStateStore(path.join(directory, 'state.json')).diagnostics });
    const error = Object.assign(new Error('copy argument rejected at C:\\protected\\file GH_TOKEN=secret-value'), {
      name: 'NativeError', code: 'INVALID_ARGUMENT',
      evidence: { exitCode: 9, timedOut: false, aborted: true, outputTruncated: false, category: 'InvalidArgument', nativeCode: '0x1234', stdout: '💥'.repeat(10000), stderr: 'powershell.exe GH_TOKEN=secret-value\n/var/lib/private/file' },
    });
    await create().record({ environmentIdentity: 'environment-a', declarationRevision: 2, operation: 'create',
      journal: { operationId: 'operation-a', entries: [{ stage: 'fenced-attempt', implementationGeneration: 'generation-a' }] }, error });
    const effects = () => { throw new Error('diagnostics cannot invoke effects'); };
    const operator = { inspect: effects, list: effects, status: effects, plan: effects, run: effects, resume: effects, setupReentry: effects,
      diagnostics: identity => create().inspect(identity) };
    const client = new LifecycleAuthorityClient({ readExchange: createLifecycleAuthorityReadHandler({operator}), mutationExchange: createLifecycleAuthorityMutationHandler({operator}) });
    const result = await client.diagnostics('environment-a');
    assert.equal(result.operationId, 'operation-a');
    assert.equal(result.failure.native.exitCode, 9);
    assert.equal(result.failure.native.category, 'InvalidArgument');
    assert.equal(result.failure.native.aborted, true);
    assert.equal(result.failure.native.outputTruncated, true);
    assert.equal(result.guestEvidence, 'unavailable');
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 16000);
    assert.doesNotMatch(JSON.stringify(result), /secret-value|protected|powershell|\/var\/lib/iu);
    assert.equal((await client.diagnostics('environment-other')).available, false);
    await assert.rejects(client.run('create', 'environment-a'), /operation failed/u);
  } finally { await rm(directory, {recursive:true,force:true}); }
});

test('an older operator rejects the optional diagnostic capability explicitly', async () => {
  const effects = () => { throw new Error('unexpected effect'); };
  const operator = { inspect: effects, list: effects, status: effects, plan: effects, run: effects, resume: effects, setupReentry: effects };
  const client = new LifecycleAuthorityClient({ readExchange: createLifecycleAuthorityReadHandler({operator}), mutationExchange: effects });
  await assert.rejects(client.diagnostics('environment-a'), error => error.code === 'UNSUPPORTED_CAPABILITY');
});
