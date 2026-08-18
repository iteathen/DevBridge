import { spawn } from 'node:child_process';
import { access, constants, mkdir, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveExecutable } from './executable-resolver.js';
import { containedSpawnOptions, terminateProcessTree } from './process-tree.js';

const OUTPUT_LIMIT = 128 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;

function appendBounded(current, chunk, maxBytes = OUTPUT_LIMIT) {
  const combined = Buffer.concat([current, Buffer.from(chunk)]);
  return combined.length <= maxBytes ? combined : combined.subarray(combined.length - maxBytes);
}

async function runProcess(executable, args, { cwd, env, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  const child = spawn(executable, args, containedSpawnOptions({ cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }));
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  child.stdout.on('data', (chunk) => { stdout = appendBounded(stdout, chunk); });
  child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
  let timedOut = false;
  let termination = null;
  const timer = setTimeout(() => {
    timedOut = true;
    termination = terminateProcessTree(child);
  }, timeoutMs);
  timer.unref?.();
  try {
    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    if (termination) await termination;
    return {
      exitCode: exit.code,
      signal: exit.signal,
      timedOut,
      stdout: stdout.toString('utf8'),
      stderr: stderr.toString('utf8')
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runnable(candidate) {
  try {
    await access(candidate, constants.X_OK);
    return await realpath(candidate);
  } catch {
    return null;
  }
}

function compilerFamily(executable) {
  const base = path.basename(executable).toLowerCase();
  if (base === 'cl.exe' || base === 'cl') return 'msvc';
  if (base === 'clang-cl.exe' || base === 'clang-cl') return 'clang-cl';
  if (base.startsWith('clang')) return 'clang';
  if (base.startsWith('gcc') || base === 'cc' || base === 'cc.exe') return 'gcc';
  return 'c-compiler';
}

function boundedVersion(text, fallback = 'unknown') {
  const first = String(text || '').split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
  return (first || fallback).slice(0, 240);
}

async function versionForPathCompiler(descriptor, env) {
  const args = descriptor.family === 'msvc' ? [] : ['--version'];
  try {
    const observed = await runProcess(descriptor.executable, args, { cwd: os.tmpdir(), env, timeoutMs: 10_000 });
    return boundedVersion(observed.stdout || observed.stderr, descriptor.version ?? 'unknown');
  } catch {
    return descriptor.version ?? 'unknown';
  }
}

async function findPathCompiler(env) {
  const candidates = process.platform === 'win32'
    ? ['clang-cl.exe', 'clang.exe', 'cl.exe', 'gcc.exe', 'cc.exe']
    : ['cc', 'clang', 'gcc'];
  for (const name of candidates) {
    try {
      const executable = await resolveExecutable(name, env);
      const descriptor = { executable, family: compilerFamily(executable), source: 'PATH', version: 'unknown' };
      descriptor.version = await versionForPathCompiler(descriptor, env);
      return descriptor;
    } catch {
      // Try the next locally constrained candidate.
    }
  }
  return null;
}

async function latestMsvcToolset(installationPath) {
  const root = path.join(installationPath, 'VC', 'Tools', 'MSVC');
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch { return null; }
  const versions = entries
    .filter((entry) => entry.isDirectory() && /^\d+(?:\.\d+)+$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left, 'en', { numeric: true }));
  for (const version of versions) {
    const executable = await runnable(path.join(root, version, 'bin', 'Hostx64', 'x64', 'cl.exe'));
    if (executable) return { executable, family: 'msvc', source: 'visual-studio', version };
  }
  return null;
}

async function findVisualStudioCompiler(env) {
  const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.ProgramW6432].filter(Boolean);
  const seen = new Set();
  for (const root of roots) {
    const key = path.resolve(root).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const vswhere = await runnable(path.join(root, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'));
    if (!vswhere) continue;
    let observed;
    try {
      observed = await runProcess(vswhere, [
        '-latest', '-products', '*',
        '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
        '-property', 'installationPath'
      ], { cwd: os.tmpdir(), env, timeoutMs: 15_000 });
    } catch {
      continue;
    }
    if (observed.exitCode !== 0) continue;
    const installationPath = String(observed.stdout || '').split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
    if (!installationPath || !path.isAbsolute(installationPath)) continue;
    const compiler = await latestMsvcToolset(installationPath);
    if (compiler) return compiler;
  }
  return null;
}

export async function discoverNativeCompiler({ env = process.env, platform = process.platform } = {}) {
  const fromPath = await findPathCompiler(env);
  if (fromPath) return fromPath;
  if (platform === 'win32') return findVisualStudioCompiler(env);
  return null;
}

function compileArguments(compiler, sourceName, objectName, { warnings = false } = {}) {
  if (compiler.family === 'msvc' || compiler.family === 'clang-cl') {
    return ['/nologo', '/c', '/TC', warnings ? '/W4' : '/W0', sourceName, `/Fo${objectName}`];
  }
  return ['-c', '-x', 'c', warnings ? '-Wall' : '-w', sourceName, '-o', objectName];
}

function scrub(text, values) {
  let result = String(text || '');
  for (const value of values.filter(Boolean).sort((a, b) => String(b).length - String(a).length)) {
    result = result.split(String(value)).join('<local-path>');
    result = result.split(String(value).replace(/\\/g, '/')).join('<local-path>');
  }
  return result.slice(-4000);
}

async function exists(filePath) {
  try { await stat(filePath); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

function invocationEvidence(name, run, extra = {}, redactions = []) {
  return {
    name,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    stdoutPresent: run.stdout.length > 0,
    stderrPresent: run.stderr.length > 0,
    stdoutTail: scrub(run.stdout, redactions),
    stderrTail: scrub(run.stderr, redactions),
    ...extra
  };
}

export async function runNativeCompilerProbe({ workDir, env = process.env } = {}) {
  const root = path.resolve(workDir);
  const probeDir = path.join(root, 'native-compiler-probe');
  const sourceName = 'probe.c';
  const objectName = process.platform === 'win32' ? 'probe.obj' : 'probe.o';
  const sourcePath = path.join(probeDir, sourceName);
  const objectPath = path.join(probeDir, objectName);
  const tests = [];
  await rm(probeDir, { recursive: true, force: true });
  await mkdir(probeDir, { recursive: true, mode: 0o700 });

  try {
    const compiler = await discoverNativeCompiler({ env });
    if (!compiler) {
      return {
        protocol: 'patch-poller/result-v1',
        status: 'failed',
        summary: 'PATCH-POLLER native compiler diagnostic could not find an authorized local C compiler.',
        progress: [],
        tests: [{ name: 'native-compiler-discovery', available: false }],
        nextStep: null,
        blocker: 'native-compiler-unavailable'
      };
    }

    tests.push({
      name: 'native-compiler-discovery',
      available: true,
      family: compiler.family,
      version: compiler.version,
      source: compiler.source
    });
    const redactions = [root, probeDir, compiler.executable, path.dirname(compiler.executable)];
    const validSource = 'int patch_poller_compiler_probe(void) { return 0; }\n';
    const invalidSource = 'int patch_poller_compiler_probe(void) { return missing + ; }\n';

    await writeFile(sourcePath, validSource, 'utf8');
    let run = await runProcess(compiler.executable, compileArguments(compiler, sourceName, objectName), { cwd: probeDir, env });
    const firstObject = await exists(objectPath);
    tests.push(invocationEvidence('native-compiler-valid', run, { objectCreated: firstObject }, redactions));
    if (run.exitCode !== 0 || run.timedOut || !firstObject) {
      return {
        protocol: 'patch-poller/result-v1', status: 'failed',
        summary: `Native compiler ${compiler.family} was discovered but could not compile the valid probe.`,
        progress: [], tests, nextStep: null, blocker: 'native-compiler-valid-build-failed'
      };
    }

    await rm(objectPath, { force: true });
    await writeFile(sourcePath, invalidSource, 'utf8');
    run = await runProcess(compiler.executable, compileArguments(compiler, sourceName, objectName), { cwd: probeDir, env });
    const diagnosticText = `${run.stdout}\n${run.stderr}`;
    const diagnosticObserved = run.exitCode !== 0 && /(?:error|fatal|expected|syntax)/iu.test(diagnosticText);
    tests.push(invocationEvidence('native-compiler-intentional-error', run, { diagnosticObserved }, redactions));
    if (run.exitCode === 0 || run.timedOut || !diagnosticObserved) {
      return {
        protocol: 'patch-poller/result-v1', status: 'failed',
        summary: `Native compiler ${compiler.family} did not produce trustworthy failure diagnostics for the intentional syntax error.`,
        progress: [], tests, nextStep: null, blocker: 'native-compiler-diagnostic-missing'
      };
    }

    await rm(objectPath, { force: true });
    await writeFile(sourcePath, validSource, 'utf8');
    run = await runProcess(compiler.executable, compileArguments(compiler, sourceName, objectName), { cwd: probeDir, env });
    const repairedObject = await exists(objectPath);
    tests.push(invocationEvidence('native-compiler-repair', run, { objectCreated: repairedObject }, redactions));
    if (run.exitCode !== 0 || run.timedOut || !repairedObject) {
      return {
        protocol: 'patch-poller/result-v1', status: 'failed',
        summary: `Native compiler ${compiler.family} did not recover after the intentional compiler failure.`,
        progress: [], tests, nextStep: null, blocker: 'native-compiler-repair-failed'
      };
    }

    await rm(objectPath, { force: true });
    await writeFile(sourcePath, 'int patch_poller_warning_probe(void) { int unused = 1; return 0; }\n', 'utf8');
    run = await runProcess(compiler.executable, compileArguments(compiler, sourceName, objectName, { warnings: true }), { cwd: probeDir, env });
    const warningText = `${run.stdout}\n${run.stderr}`;
    tests.push(invocationEvidence('native-compiler-warning', run, {
      status: run.exitCode === 0 ? 'observed' : 'skipped',
      warningObserved: /warning/iu.test(warningText)
    }, redactions));

    return {
      protocol: 'patch-poller/result-v1',
      status: 'complete',
      summary: `Native compiler durability probe completed with ${compiler.family}: valid compile, intentional diagnostic failure, and repaired compile all behaved correctly.`,
      progress: ['Compiler failure was treated as test evidence and the same probe workspace recovered successfully.'],
      tests,
      nextStep: null,
      blocker: null
    };
  } catch (error) {
    return {
      protocol: 'patch-poller/result-v1',
      status: 'failed',
      summary: `PATCH-POLLER native compiler diagnostic failed: ${String(error?.message || error).slice(0, 1000)}`,
      progress: [],
      tests,
      nextStep: null,
      blocker: 'native-compiler-infrastructure'
    };
  } finally {
    await rm(probeDir, { recursive: true, force: true });
  }
}
