import { spawn } from 'node:child_process';
import { access, constants, mkdir, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveExecutable } from './executable-resolver.js';
import { containedSpawnOptions, terminateProcessTree } from './process-tree.js';

const OUTPUT_LIMIT = 128 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const EXECUTABLE_MARKER = 'DevBridge-NATIVE-LINK-OK';
const EXECUTABLE_EXIT_CODE = 17;

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

async function readableFile(candidate) {
  try {
    const info = await stat(candidate);
    return info.isFile() ? await realpath(candidate) : null;
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

async function descriptorForExecutable(executable, env, source = 'PATH') {
  const descriptor = { executable, family: compilerFamily(executable), source, version: 'unknown', linker: null };
  if (descriptor.family === 'msvc') descriptor.linker = await runnable(path.join(path.dirname(executable), 'link.exe'));
  descriptor.version = await versionForPathCompiler(descriptor, env);
  return descriptor;
}

async function findPathCompiler(env, candidates) {
  for (const name of candidates) {
    try {
      const executable = await resolveExecutable(name, env);
      return descriptorForExecutable(executable, env);
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
    const binDir = path.join(root, version, 'bin', 'Hostx64', 'x64');
    const executable = await runnable(path.join(binDir, 'cl.exe'));
    const linker = await runnable(path.join(binDir, 'link.exe'));
    if (executable && linker) return { executable, linker, family: 'msvc', source: 'visual-studio', version };
  }
  return null;
}

function localProgramFilesRoots(env) {
  const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.ProgramW6432];
  if (env.SystemDrive) roots.push(path.join(env.SystemDrive, 'Program Files (x86)'));
  return [...new Set(roots.filter(Boolean).map((entry) => path.resolve(entry)))];
}

async function findVisualStudioCompiler(env) {
  const seen = new Set();
  for (const root of localProgramFilesRoots(env)) {
    const key = root.toLowerCase();
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

async function findWindowsSdkKernel32(env) {
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
  for (const programFiles of localProgramFilesRoots(env)) {
    const libRoot = path.join(programFiles, 'Windows Kits', '10', 'Lib');
    let entries;
    try { entries = await readdir(libRoot, { withFileTypes: true }); }
    catch { continue; }
    const versions = entries
      .filter((entry) => entry.isDirectory() && /^\d+(?:\.\d+)+$/u.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, 'en', { numeric: true }));
    for (const version of versions) {
      const library = await readableFile(path.join(libRoot, version, 'um', architecture, 'kernel32.lib'));
      if (library) return { library, version, architecture };
    }
  }
  return null;
}

export async function discoverNativeCompiler({ env = process.env, platform = process.platform } = {}) {
  if (platform === 'win32') {
    const msvcOnPath = await findPathCompiler(env, ['cl.exe']);
    if (msvcOnPath?.linker) return msvcOnPath;
    const visualStudio = await findVisualStudioCompiler(env);
    if (visualStudio) return visualStudio;
    return findPathCompiler(env, ['clang-cl.exe', 'clang.exe', 'gcc.exe', 'cc.exe']);
  }
  return findPathCompiler(env, ['cc', 'clang', 'gcc']);
}

function compileArguments(compiler, sourceName, objectName, { warnings = false, noRuntime = false } = {}) {
  if (compiler.family === 'msvc' || compiler.family === 'clang-cl') {
    const args = ['/nologo', '/c', '/TC', warnings ? '/W4' : '/W0'];
    if (noRuntime) args.push('/GS-', '/Zl');
    return [...args, sourceName, `/Fo${objectName}`];
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

function windowsLinkSource({ broken = false } = {}) {
  if (broken) {
    return 'void missing_devbridge_link_symbol(void); void __stdcall devbridge_entry(void) { missing_devbridge_link_symbol(); }\n';
  }
  return [
    'typedef void* PP_HANDLE;',
    'typedef unsigned long PP_DWORD;',
    '__declspec(dllimport) PP_HANDLE __stdcall GetStdHandle(PP_DWORD);',
    '__declspec(dllimport) int __stdcall WriteFile(PP_HANDLE, const void*, PP_DWORD, PP_DWORD*, void*);',
    '__declspec(dllimport) void __stdcall ExitProcess(unsigned int);',
    `void __stdcall devbridge_entry(void) { const char message[] = "${EXECUTABLE_MARKER}\\n"; PP_DWORD written = 0; WriteFile(GetStdHandle((PP_DWORD)-11), message, (PP_DWORD)(sizeof(message)-1), &written, 0); ExitProcess(${EXECUTABLE_EXIT_CODE}); }`,
    ''
  ].join('\n');
}

function posixLinkSource({ broken = false } = {}) {
  if (broken) return 'extern int missing_devbridge_link_symbol(void); int main(void) { return missing_devbridge_link_symbol(); }\n';
  return `#include <stdio.h>\nint main(void) { fputs("${EXECUTABLE_MARKER}\\n", stdout); return ${EXECUTABLE_EXIT_CODE}; }\n`;
}

async function linkWindowsMsvc({ compiler, probeDir, env, sourcePath, sourceName, objectName, executableName, broken, redactions }) {
  const sdk = await findWindowsSdkKernel32(env);
  if (!compiler.linker || !sdk) {
    return { unavailable: true, reason: !compiler.linker ? 'msvc-linker-unavailable' : 'windows-sdk-kernel32-unavailable' };
  }
  redactions.push(compiler.linker, path.dirname(compiler.linker), sdk.library, path.dirname(sdk.library));
  await writeFile(sourcePath, windowsLinkSource({ broken }), 'utf8');
  const compile = await runProcess(compiler.executable, compileArguments(compiler, sourceName, objectName, { noRuntime: true }), { cwd: probeDir, env });
  if (compile.exitCode !== 0 || compile.timedOut) return { compile, sdk, link: null };
  const link = await runProcess(compiler.linker, [
    '/nologo', '/nodefaultlib', '/subsystem:console', '/entry:devbridge_entry',
    `/out:${executableName}`, objectName, sdk.library
  ], { cwd: probeDir, env });
  return { compile, sdk, link };
}

async function linkPosix({ compiler, probeDir, env, sourcePath, sourceName, executableName, broken }) {
  await writeFile(sourcePath, posixLinkSource({ broken }), 'utf8');
  const link = await runProcess(compiler.executable, [sourceName, '-o', executableName], { cwd: probeDir, env });
  return { compile: null, sdk: null, link };
}

async function runLinkAttempt(options) {
  if (process.platform === 'win32' && options.compiler.family === 'msvc') return linkWindowsMsvc(options);
  return linkPosix(options);
}

export async function runNativeCompilerProbe({ workDir, env = process.env } = {}) {
  const root = path.resolve(workDir);
  const probeDir = path.join(root, 'native-compiler-probe');
  const sourceName = 'probe.c';
  const objectName = process.platform === 'win32' ? 'probe.obj' : 'probe.o';
  const executableName = process.platform === 'win32' ? 'probe.exe' : 'probe-executable';
  const sourcePath = path.join(probeDir, sourceName);
  const objectPath = path.join(probeDir, objectName);
  const executablePath = path.join(probeDir, executableName);
  const tests = [];
  await rm(probeDir, { recursive: true, force: true });
  await mkdir(probeDir, { recursive: true, mode: 0o700 });

  try {
    const compiler = await discoverNativeCompiler({ env });
    if (!compiler) {
      return {
        protocol: 'devbridge/result-v1',
        status: 'failed',
        summary: 'DevBridge native compiler diagnostic could not find an authorized local C compiler.',
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
    const validSource = 'int devbridge_compiler_probe(void) { return 0; }\n';
    const invalidSource = 'int devbridge_compiler_probe(void) { return missing + ; }\n';

    await writeFile(sourcePath, validSource, 'utf8');
    let run = await runProcess(compiler.executable, compileArguments(compiler, sourceName, objectName), { cwd: probeDir, env });
    const firstObject = await exists(objectPath);
    tests.push(invocationEvidence('native-compiler-valid', run, { objectCreated: firstObject }, redactions));
    if (run.exitCode !== 0 || run.timedOut || !firstObject) {
      return {
        protocol: 'devbridge/result-v1', status: 'failed',
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
        protocol: 'devbridge/result-v1', status: 'failed',
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
        protocol: 'devbridge/result-v1', status: 'failed',
        summary: `Native compiler ${compiler.family} did not recover after the intentional compiler failure.`,
        progress: [], tests, nextStep: null, blocker: 'native-compiler-repair-failed'
      };
    }

    await rm(objectPath, { force: true });
    await writeFile(sourcePath, 'int devbridge_warning_probe(void) { int unused = 1; return 0; }\n', 'utf8');
    run = await runProcess(compiler.executable, compileArguments(compiler, sourceName, objectName, { warnings: true }), { cwd: probeDir, env });
    const warningText = `${run.stdout}\n${run.stderr}`;
    tests.push(invocationEvidence('native-compiler-warning', run, {
      status: run.exitCode === 0 ? 'observed' : 'skipped',
      warningObserved: /warning/iu.test(warningText)
    }, redactions));

    await rm(objectPath, { force: true });
    await rm(executablePath, { force: true });
    let linkAttempt = await runLinkAttempt({ compiler, probeDir, env, sourcePath, sourceName, objectName, executableName, broken: false, redactions });
    if (linkAttempt.unavailable) {
      tests.push({ name: 'native-linker-discovery', available: false, reason: linkAttempt.reason });
      return {
        protocol: 'devbridge/result-v1', status: 'failed',
        summary: `Native compiler ${compiler.family} passed, but the fixed local linker diagnostic could not resolve its required local linker components.`,
        progress: [], tests, nextStep: null, blocker: linkAttempt.reason
      };
    }
    if (linkAttempt.compile) tests.push(invocationEvidence('native-linker-valid-compile', linkAttempt.compile, {}, redactions));
    const linkedExecutable = await exists(executablePath);
    tests.push(invocationEvidence('native-linker-valid', linkAttempt.link, { executableCreated: linkedExecutable }, redactions));
    if (!linkAttempt.link || linkAttempt.link.exitCode !== 0 || linkAttempt.link.timedOut || !linkedExecutable) {
      return {
        protocol: 'devbridge/result-v1', status: 'failed',
        summary: `Native linker for ${compiler.family} could not produce the valid executable probe.`,
        progress: [], tests, nextStep: null, blocker: 'native-linker-valid-build-failed'
      };
    }

    run = await runProcess(executablePath, [], { cwd: probeDir, env, timeoutMs: 10_000 });
    const markerObserved = run.stdout.includes(EXECUTABLE_MARKER);
    tests.push(invocationEvidence('native-executable-run', run, { markerObserved, expectedExitCode: EXECUTABLE_EXIT_CODE }, redactions));
    if (run.timedOut || run.exitCode !== EXECUTABLE_EXIT_CODE || !markerObserved) {
      return {
        protocol: 'devbridge/result-v1', status: 'failed',
        summary: 'Linked native executable did not preserve the expected stdout marker and process exit code.',
        progress: [], tests, nextStep: null, blocker: 'native-executable-run-failed'
      };
    }

    await rm(objectPath, { force: true });
    await rm(executablePath, { force: true });
    linkAttempt = await runLinkAttempt({ compiler, probeDir, env, sourcePath, sourceName, objectName, executableName, broken: true, redactions });
    if (linkAttempt.compile) tests.push(invocationEvidence('native-linker-error-compile', linkAttempt.compile, {}, redactions));
    const linkerErrorText = `${linkAttempt.link?.stdout ?? ''}\n${linkAttempt.link?.stderr ?? ''}`;
    const linkerDiagnosticObserved = Boolean(linkAttempt.link) && linkAttempt.link.exitCode !== 0 && /(?:unresolved external|undefined reference|undefined symbol|LNK20\d\d|linker command failed|ld: error)/iu.test(linkerErrorText);
    if (linkAttempt.link) tests.push(invocationEvidence('native-linker-intentional-error', linkAttempt.link, { diagnosticObserved: linkerDiagnosticObserved }, redactions));
    if (!linkAttempt.link || linkAttempt.link.exitCode === 0 || linkAttempt.link.timedOut || !linkerDiagnosticObserved) {
      return {
        protocol: 'devbridge/result-v1', status: 'failed',
        summary: `Native linker for ${compiler.family} did not produce trustworthy diagnostics for the intentional unresolved symbol.`,
        progress: [], tests, nextStep: null, blocker: 'native-linker-diagnostic-missing'
      };
    }

    await rm(objectPath, { force: true });
    await rm(executablePath, { force: true });
    linkAttempt = await runLinkAttempt({ compiler, probeDir, env, sourcePath, sourceName, objectName, executableName, broken: false, redactions });
    if (linkAttempt.compile) tests.push(invocationEvidence('native-linker-repair-compile', linkAttempt.compile, {}, redactions));
    const repairedExecutable = await exists(executablePath);
    tests.push(invocationEvidence('native-linker-repair', linkAttempt.link, { executableCreated: repairedExecutable }, redactions));
    if (!linkAttempt.link || linkAttempt.link.exitCode !== 0 || linkAttempt.link.timedOut || !repairedExecutable) {
      return {
        protocol: 'devbridge/result-v1', status: 'failed',
        summary: `Native linker for ${compiler.family} did not recover after the intentional linker failure.`,
        progress: [], tests, nextStep: null, blocker: 'native-linker-repair-failed'
      };
    }

    run = await runProcess(executablePath, [], { cwd: probeDir, env, timeoutMs: 10_000 });
    const repairMarkerObserved = run.stdout.includes(EXECUTABLE_MARKER);
    tests.push(invocationEvidence('native-linker-repair-run', run, { markerObserved: repairMarkerObserved, expectedExitCode: EXECUTABLE_EXIT_CODE }, redactions));
    if (run.timedOut || run.exitCode !== EXECUTABLE_EXIT_CODE || !repairMarkerObserved) {
      return {
        protocol: 'devbridge/result-v1', status: 'failed',
        summary: 'Repaired native executable did not preserve the expected stdout marker and process exit code.',
        progress: [], tests, nextStep: null, blocker: 'native-linker-repair-run-failed'
      };
    }

    return {
      protocol: 'devbridge/result-v1',
      status: 'complete',
      summary: `Native toolchain durability probe completed with ${compiler.family}: compiler error recovery, linker error recovery, and executable stdout/exit propagation all behaved correctly.`,
      progress: [
        'Compiler failure was treated as test evidence and the same probe workspace recovered successfully.',
        'Linker failure was treated as test evidence and the same probe workspace relinked and executed successfully.'
      ],
      tests,
      nextStep: null,
      blocker: null
    };
  } catch (error) {
    return {
      protocol: 'devbridge/result-v1',
      status: 'failed',
      summary: `DevBridge native compiler diagnostic failed: ${String(error?.message || error).slice(0, 1000)}`,
      progress: [],
      tests,
      nextStep: null,
      blocker: 'native-compiler-infrastructure'
    };
  } finally {
    await rm(probeDir, { recursive: true, force: true });
  }
}
