import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const neutralFiles = [
  new URL('../src/runtime/file-tree-transfer.js', import.meta.url),
  new URL('../src/runtime/repository-environment-execution.js', import.meta.url),
  new URL('../src/runtime/tool-onboarding.js', import.meta.url),
  new URL('../src/runtime/tool-onboarding-policy.js', import.meta.url),
  new URL('../src/runtime/cli-help-parser.js', import.meta.url),
  new URL('../src/runtime/external-directory.js', import.meta.url),
];
const businessFiles = [
  new URL('../src/run/controller-plan-executor.js', import.meta.url),
  new URL('../src/run/run-coordinator.js', import.meta.url),
  new URL('../src/runtime/process-runner.js', import.meta.url),
  new URL('../src/runtime/deterministic-process-runner.js', import.meta.url),
];

test('Stage 6 neutral transfer and orchestration LEGO contains no provider, transport, or neighboring-module identity', async () => {
  const forbidden = [
    /hyper-?v/iu, /libvirt/iu, /qemu/iu, /powershell/iu, /virsh/iu,
    /environment-bridge/iu, /environment-foundation/iu, /persistent-environment/iu,
    /worker-exchange/iu, /github/iu, /bubblewrap/iu, /appcontainer/iu, /processcontainer/iu,
    /from ['"].*providers\//u,
  ];
  for (const file of neutralFiles) {
    const source = await readFile(file, 'utf8');
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern, `${file.pathname} leaked ${pattern}`);
  }
});

test('Stage 6 guest work helper remains agnostic to host topology and provider families', async () => {
  const source = await readFile(new URL('../src/guest/workspace-agent.mjs', import.meta.url), 'utf8');
  for (const pattern of [
    /hyper-?v/iu, /libvirt/iu, /qemu/iu, /powershell/iu, /virsh/iu,
    /environment-bridge/iu, /environment-foundation/iu, /persistent-environment/iu,
    /worker-exchange/iu, /github/iu, /bubblewrap/iu, /appcontainer/iu, /processcontainer/iu,
  ]) assert.doesNotMatch(source, pattern, `guest work helper leaked ${pattern}`);
});

test('Stage 6 restoration does not add provider or bridge topology to controller and worker business logic', async () => {
  for (const file of businessFiles) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /hyper-?v|libvirt|qemu|powershell|virsh|environment-bridge|environment-foundation/iu);
    assert.doesNotMatch(source, /bubblewrap|appcontainer|processcontainer/iu);
  }
});

test('Stage 6 composition owns temporary topology while candidate validation stays provider and repository agnostic', async () => {
  const composition = await readFile(new URL('../src/app/repository-execution.js', import.meta.url), 'utf8');
  assert.match(composition, /createEnvironmentFoundation/u);
  assert.match(composition, /createEnvironmentBootstrap/u);
  assert.match(composition, /createEnvironmentBridge/u);
  assert.doesNotMatch(composition, /from ['"].*providers\//u);
  assert.doesNotMatch(composition, /bubblewrap|appcontainer|processcontainer/iu);

  const validator = await readFile(new URL('../src/bootstrap/candidate-validator.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(validator, /hyper-?v|libvirt|qemu|powershell|virsh/iu);
  assert.doesNotMatch(validator, /iteathen|devbridge\.git|github\.com/iu);

  const runtime = await readFile(new URL('../src/app/runtime.js', import.meta.url), 'utf8');
  assert.match(runtime, /createRuntimeExecutionContext/u);
  assert.doesNotMatch(runtime, /UnavailableRepositoryExecution/u);
});
