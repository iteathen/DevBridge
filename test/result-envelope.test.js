import test from 'node:test';
import assert from 'node:assert/strict';
import { parseToolResult } from '../src/run/result-envelope.js';

test('accepts structured result envelopes and preserves continuation data', () => { const result = parseToolResult({ protocol: 'patch-poller/result-v1', status: 'continue', summary: 'first pass', progress: ['compiled'], tests: [{ name: 'unit', status: 'pass' }], nextStep: 'run integration' }); assert.equal(result.status, 'continue'); assert.equal(result.nextStep, 'run integration'); assert.equal(result.inferred, false); });
test('infers successful completion for legacy CLIs with clean exit and no result file', () => { const result = parseToolResult(null, { exitCode: 0, stdout: 'done' }); assert.equal(result.status, 'complete'); assert.equal(result.inferred, true); });
test('turns malformed structured output into a bounded terminal protocol failure', () => { const result = parseToolResult(null, { resultParseError: 'bad json' }); assert.equal(result.status, 'failed'); assert.equal(result.blocker, 'tool-protocol'); assert.match(result.summary, /bad json/u); });
test('rejects missing mandatory summary without accepting completion', () => { const result = parseToolResult({ protocol: 'patch-poller/result-v1', status: 'complete' }); assert.equal(result.status, 'failed'); assert.equal(result.blocker, 'tool-protocol'); assert.match(result.summary, /summary must be a non-empty string/u); });
test('rejects non-JSON test entries as protocol data instead of throwing an incidental TypeError', () => { const result = parseToolResult({ protocol: 'patch-poller/result-v1', status: 'complete', summary: 'done', tests: [undefined] }); assert.equal(result.status, 'failed'); assert.equal(result.blocker, 'tool-protocol'); });
