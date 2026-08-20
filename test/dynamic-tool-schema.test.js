import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { DeterministicOperationRegistry } from '../src/runtime/deterministic-operation-registry.js';
import {
  LOCAL_OPERATION_MANIFEST_PROTOCOL,
  createManifestOperationAdapter,
} from '../src/runtime/local-operation-manifest.js';
import { ToolInventoryService } from '../src/runtime/tool-inventory.js';
import { parseCliHelp } from '../src/runtime/cli-help-parser.js';
import { REPOSITORY_EXECUTION_STATUS_PROTOCOL } from '../src/runtime/repository-execution.js';

function repositoryExecution() {
  return {
    inspect() {
      return {
        protocol: REPOSITORY_EXECUTION_STATUS_PROTOCOL,
        state: 'ready',
        ready: true,
        identity: 'fixture',
        reason: null,
      };
    },
    async execute() { throw new Error('inventory must not execute repository code'); },
  };
}

test('dynamic operation inventory exposes only controller-facing parameter shape, not executable or argv construction', async () => {
  const registry = new DeterministicOperationRegistry();
  registry.register('tool.fixture', createManifestOperationAdapter({
    protocol: LOCAL_OPERATION_MANIFEST_PROTOCOL,
    operation: 'tool.fixture',
    executable: process.execPath,
    arguments: [
      { kind: 'literal', value: 'private-fixed-subcommand' },
      { kind: 'flag', param: 'verbose', flag: '--private-verbose-flag' },
      { kind: 'option', param: 'count', flag: '--private-count-flag', valueType: 'integer' },
      { kind: 'option', param: 'mode', flag: '--private-mode-flag', valueType: 'enum', values: ['fast', 'safe'] },
      { kind: 'positional', param: 'input', required: true, valueType: 'project-path' },
      { kind: 'positional', param: 'tag', repeat: true, maxItems: 3, valueType: 'string' },
    ],
    requireAnyParameter: true,
    source: { kind: 'operator' },
  }));

  const service = new ToolInventoryService({
    operationRegistry: registry,
    toolchainRegistry: { inspect: async () => [] },
    repositoryExecution: repositoryExecution(),
    discoverPathToolsEnabled: false,
  });
  const record = await service.refresh();
  const operation = record.inventory.operations.find((entry) => entry.name === 'tool.fixture');

  assert.equal(operation.layer, 'local-manifest');
  assert.equal(operation.repositoryCode, true);
  assert.equal(operation.repositoryExecutionRequired, true);
  assert.equal(operation.usable, true);
  assert.deepEqual(operation.parameterSchema, {
    protocol: 'devbridge/operation-parameters-v1',
    requireAnyParameter: true,
    parameters: [
      { name: 'verbose', kind: 'flag', valueType: 'boolean', required: false, repeat: false },
      { name: 'count', kind: 'option', valueType: 'integer', required: false, repeat: false },
      { name: 'mode', kind: 'option', valueType: 'enum', required: false, repeat: false, values: ['fast', 'safe'] },
      { name: 'input', kind: 'positional', valueType: 'project-path', required: true, repeat: false },
      { name: 'tag', kind: 'positional', valueType: 'string', required: false, repeat: true, maxItems: 3 },
    ],
  });

  const serialized = JSON.stringify(record);
  assert.doesNotMatch(serialized, /private-fixed-subcommand/u);
  assert.doesNotMatch(serialized, /private-verbose-flag/u);
  assert.doesNotMatch(serialized, /private-count-flag/u);
  assert.doesNotMatch(serialized, /private-mode-flag/u);
  assert.doesNotMatch(serialized, new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
});

test('path-shaped enum metadata is withheld rather than becoming a remote machine-path disclosure', async () => {
  const registry = new DeterministicOperationRegistry();
  registry.register('tool.private-enum', createManifestOperationAdapter({
    protocol: LOCAL_OPERATION_MANIFEST_PROTOCOL,
    operation: 'tool.private-enum',
    executable: process.execPath,
    arguments: [
      { kind: 'option', param: 'mode', flag: '--mode', valueType: 'enum', values: ['/private/operator/path'] },
    ],
    requireAnyParameter: true,
    source: { kind: 'operator' },
  }));
  const service = new ToolInventoryService({
    operationRegistry: registry,
    toolchainRegistry: { inspect: async () => [] },
    repositoryExecution: repositoryExecution(),
    discoverPathToolsEnabled: false,
  });
  const record = await service.refresh();
  const operation = record.inventory.operations.find((entry) => entry.name === 'tool.private-enum');
  assert.equal(Object.hasOwn(operation, 'parameterSchema'), false);
  assert.doesNotMatch(JSON.stringify(record), /private\/operator\/path/u);
});

test('help subcommands use a bounded non-authority parameter name', () => {
  const parsed = parseCliHelp(`Usage: helper <COMMAND>\n\nCommands:\n  scan      Inspect project\n  format    Format project\n\nOptions:\n  --quiet   Quiet\n`);
  assert.deepEqual(parsed.commands, ['scan', 'format']);
  assert.deepEqual(parsed.arguments, [
    { kind: 'flag', param: 'quiet', flag: '--quiet' },
    {
      kind: 'positional',
      param: 'subcommand',
      required: true,
      repeat: false,
      valueType: 'enum',
      values: ['format', 'scan'],
    },
  ]);
});
