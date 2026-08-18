import { spawn } from 'node:child_process';
import { access, constants, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { containedSpawnOptions, terminateProcessTree } from './process-tree.js';

export const LIFECYCLE_ROUNDTRIP_NONCE = 'PPTESTCTX-20260818-R1';
export const LIFECYCLE_TEMP_DIR = 'pp-lifecycle-roundtrip-r1';

const TEST_TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT = 64 * 1024;

async function exists(candidate) {
  try {
    await access(candidate, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function tail(value, max = 8000) {
  const text = String(value ?? '');
  return text.length <= max ? text : text.slice(-max);
}

function runProcess(executable, args, { cwd, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...containedSpawnOptions()
    });

    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let outputTruncated = false;
    let timedOut = false;

    const append = (kind, chunk) => {
      const text = chunk.toString('utf8');
      const bytes = Buffer.byteLength(text);
      if (outputBytes + bytes > OUTPUT_LIMIT) {
        outputTruncated = true;
        const remaining = Math.max(0, OUTPUT_LIMIT - outputBytes);
        if (remaining > 0) {
          const slice = Buffer.from(text).subarray(0, remaining).toString('utf8');
          if (kind === 'stdout') stdout += slice;
          else stderr += slice;
          outputBytes += Buffer.byteLength(slice);
        }
        return;
      }
      outputBytes += bytes;
      if (kind === 'stdout') stdout += text;
      else stderr += text;
    };

    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));

    const timer = setTimeout(async () => {
      timedOut = true;
      await terminateProcessTree(child.pid);
    }, TEST_TIMEOUT_MS);
    timer.unref?.();

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, signal: null, timedOut, outputTruncated, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: code, signal, timedOut, outputTruncated, stdout, stderr });
    });
  });
}

function generatedTestSource() {
  return `import assert from 'node:assert/strict';\nimport { mkdir, readFile, writeFile } from 'node:fs/promises';\nimport path from 'node:path';\n\nconst [fixtureFile, scratchFile, expectedNonce] = process.argv.slice(2);\nconst fixture = await readFile(fixtureFile, 'utf8');\nassert.equal(fixture, \`context-nonce=\${expectedNonce}\\n\`);\nawait mkdir(path.dirname(scratchFile), { recursive: true });\nawait writeFile(scratchFile, \`scratch-nonce=\${expectedNonce}\\n\`, 'utf8');\nconst scratch = await readFile(scratchFile, 'utf8');\nassert.equal(scratch, \`scratch-nonce=\${expectedNonce}\\n\`);\nprocess.stdout.write(\`PATCH-POLLER-LIFECYCLE-PASS \${expectedNonce}\\n\`);\n`;
}

export async function runLifecycleRoundtripProbe({ projectRoot, context, env = process.env }) {
  const root = path.resolve(projectRoot);
  const tempRoot = path.join(root, LIFECYCLE_TEMP_DIR);
  const testFile = path.join(tempRoot, 'generated-roundtrip.test.mjs');
  const fixtureFile = path.join(tempRoot, 'context-fixture.txt');
  const scratchFile = path.join(tempRoot, 'nested', 'runtime.tmp');

  const summary = String(context?.priorSummary ?? '');
  const objective = String(context?.objective ?? '');
  const contextMatched = summary.includes(LIFECYCLE_ROUNDTRIP_NONCE) && objective.includes(LIFECYCLE_ROUNDTRIP_NONCE);
  const tests = [];
  let scratchCreated = false;
  let cleanupError = null;

  if (context?.protocol !== 'patch-poller/context-v1') {
    return {
      protocol: 'patch-poller/result-v1', status: 'failed',
      summary: 'Lifecycle roundtrip diagnostic did not receive patch-poller/context-v1.',
      progress: [], tests, nextStep: null, blocker: 'lifecycle-context-protocol'
    };
  }
  if (!contextMatched) {
    return {
      protocol: 'patch-poller/result-v1', status: 'failed',
      summary: `Lifecycle roundtrip context nonce ${LIFECYCLE_ROUNDTRIP_NONCE} was not present in both objective and prior summary.`,
      progress: [], tests: [{ name: 'context-input', nonce: LIFECYCLE_ROUNDTRIP_NONCE, matched: false }],
      nextStep: null, blocker: 'lifecycle-context-mismatch'
    };
  }

  try {
    if (await exists(tempRoot)) {
      return {
        protocol: 'patch-poller/result-v1', status: 'failed',
        summary: `Lifecycle temporary directory ${LIFECYCLE_TEMP_DIR} already exists; refusing to delete pre-existing evidence.`,
        progress: [], tests, nextStep: null, blocker: 'lifecycle-preexisting-temp'
      };
    }

    await mkdir(tempRoot);
    await writeFile(testFile, generatedTestSource(), 'utf8');
    await writeFile(fixtureFile, `context-nonce=${LIFECYCLE_ROUNDTRIP_NONCE}\n`, 'utf8');
    const created = {
      testFile: await exists(testFile),
      fixtureFile: await exists(fixtureFile),
      tempRoot: await exists(tempRoot)
    };
    tests.push({
      name: 'test-files-created',
      status: created.testFile && created.fixtureFile && created.tempRoot ? 'pass' : 'fail',
      files: ['generated-roundtrip.test.mjs', 'context-fixture.txt']
    });

    const run = await runProcess(process.execPath, [testFile, fixtureFile, scratchFile, LIFECYCLE_ROUNDTRIP_NONCE], {
      cwd: root,
      env
    });
    scratchCreated = await exists(scratchFile);
    const marker = `PATCH-POLLER-LIFECYCLE-PASS ${LIFECYCLE_ROUNDTRIP_NONCE}`;
    const markerObserved = run.stdout.includes(marker);
    tests.push({
      name: 'generated-test-run',
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      outputTruncated: run.outputTruncated,
      stdoutTail: tail(run.stdout),
      stderrTail: tail(run.stderr),
      markerObserved,
      scratchArtifactCreated: scratchCreated
    });
    tests.push({
      name: 'context-roundtrip-input',
      status: 'pass',
      nonce: LIFECYCLE_ROUNDTRIP_NONCE,
      contextSequence: context.sequence,
      issueNumber: context?.task?.issueNumber ?? null,
      priorSummaryMatched: summary.includes(LIFECYCLE_ROUNDTRIP_NONCE),
      objectiveMatched: objective.includes(LIFECYCLE_ROUNDTRIP_NONCE)
    });

    if (run.exitCode !== 0 || run.timedOut || !markerObserved || !scratchCreated) {
      return {
        protocol: 'patch-poller/result-v1', status: 'failed',
        summary: 'Generated lifecycle test did not complete with trustworthy pass evidence.',
        progress: [], tests, nextStep: null, blocker: 'lifecycle-test-failed'
      };
    }
  } finally {
    try {
      await rm(tempRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupError = String(error?.message || error);
    }
  }

  const cleanup = {
    tempRootRemoved: !(await exists(tempRoot)),
    testFileRemoved: !(await exists(testFile)),
    fixtureFileRemoved: !(await exists(fixtureFile)),
    scratchFileRemoved: !(await exists(scratchFile)),
    error: cleanupError
  };
  const cleanupPass = cleanup.tempRootRemoved && cleanup.testFileRemoved && cleanup.fixtureFileRemoved && cleanup.scratchFileRemoved && cleanup.error == null;
  tests.push({ name: 'cleanup', status: cleanupPass ? 'pass' : 'fail', ...cleanup });

  if (!cleanupPass) {
    return {
      protocol: 'patch-poller/result-v1', status: 'failed',
      summary: 'Lifecycle test executed successfully but temporary test cleanup was not trustworthy.',
      progress: [], tests, nextStep: null, blocker: 'lifecycle-cleanup-failed'
    };
  }

  return {
    protocol: 'patch-poller/result-v1',
    status: 'complete',
    summary: `Lifecycle roundtrip passed for ${LIFECYCLE_ROUNDTRIP_NONCE}: generated test ran successfully and all temporary test/runtime files were removed before completion.`,
    progress: [
      `Returned context nonce ${LIFECYCLE_ROUNDTRIP_NONCE} with test evidence for same-status publication verification.`,
      'Generated test source, context fixture, nested runtime scratch file, and temporary directory were removed before candidate sealing.'
    ],
    tests,
    nextStep: null,
    blocker: null
  };
}
