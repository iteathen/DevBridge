import { spawn } from 'node:child_process';

function limit(value, name, ceiling) {
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) throw new TypeError(`${name} is invalid`);
  return value;
}

// One locally selected process, one request at a time. Reconnection and effect
// reconciliation belong to the caller; this transport never replays a request.
export function openJsonCommandChannel({ executable, arguments: args = [], inputLimit = 64 * 1024,
  outputLimit = 8 * 1024 * 1024, timeoutMs = 120_000, idleMs = 60_000, signal = null,
} = {}, { spawnProcess = spawn } = {}) {
  if (typeof executable !== 'string' || !executable || executable.includes('\0')
      || !Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new TypeError('command channel invocation is invalid');
  limit(inputLimit, 'command channel input bound', 32 * 1024 * 1024);
  limit(outputLimit, 'command channel output bound', 32 * 1024 * 1024);
  limit(timeoutMs, 'command channel timeout', 300_000);
  if (idleMs !== 0) limit(idleMs, 'command channel idle timeout', 300_000);
  if (signal?.aborted) throw signal.reason ?? new Error('command channel was cancelled');
  const child = spawnProcess(executable, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let pending = null, closed = null, idle = null, stderr = Buffer.alloc(0);
  const evidence = { exitCode: null, signal: null, timedOut: false, aborted: false, outputTruncated: false };
  const close = (code = 'CLOSED', message = 'command channel closed') => {
    if (closed) return;
    closed = Object.assign(new Error(message), { code, native: { ...evidence, stderr: stderr.toString('utf8') } });
    clearTimeout(idle);
    signal?.removeEventListener('abort', onOwnerAbort);
    if (pending) {
      const current = pending; pending = null;
      clearTimeout(current.timer);
      current.signal?.removeEventListener('abort', current.onAbort);
      current.reject(closed);
    }
    child.stdin.destroy();
    if (child.exitCode == null && child.signalCode == null) child.kill();
  };
  const onOwnerAbort = () => { evidence.aborted = true; close('ABORTED', 'command channel was cancelled'); };
  const armIdle = () => {
    clearTimeout(idle);
    if (idleMs === 0) return;
    idle = setTimeout(() => close('IDLE', 'command channel idle lifetime ended'), idleMs);
    idle.unref?.();
  };
  signal?.addEventListener('abort', onOwnerAbort, { once: true });
  child.once('error', error => close('SPAWN_FAILED', `command channel could not start: ${error.message}`));
  child.stdin.on('error', () => close('DISCONNECTED', 'command channel input disconnected'));
  child.stderr.on('data', chunk => { stderr = Buffer.from(Buffer.concat([stderr, Buffer.from(chunk)]).subarray(-8192)); });
  child.stderr.on('error', () => close('DISCONNECTED', 'command channel error stream disconnected'));
  child.stdout.on('error', () => close('DISCONNECTED', 'command channel output disconnected'));
  child.once('close', (code, childSignal) => {
    evidence.exitCode = code; evidence.signal = childSignal;
    close('DISCONNECTED', 'command channel process ended');
  });
  child.stdout.on('data', chunk => {
    if (closed) return;
    if (!pending) return close('PROTOCOL', 'command channel received an unsolicited response');
    const current = pending;
    current.bytes += chunk.length;
    if (current.bytes > outputLimit) {
      evidence.outputTruncated = true;
      return close('OUTPUT_LIMIT', 'command channel response exceeded its bound');
    }
    current.chunks.push(Buffer.from(chunk));
    if (!chunk.includes(10)) return;
    const bytes = Buffer.concat(current.chunks);
    let value;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const end = text.indexOf('\n');
      if (end < 0 || text.slice(end + 1).trim()) throw new Error('extra response');
      value = JSON.parse(text.slice(0, end));
    } catch { return close('PROTOCOL', 'command channel response framing is invalid'); }
    pending = null;
    clearTimeout(current.timer);
    current.signal?.removeEventListener('abort', current.onAbort);
    armIdle();
    current.resolve(value);
  });
  armIdle();
  return Object.freeze({
    get closed() { return closed != null; },
    exchange(value, { signal: operationSignal = null } = {}) {
      if (closed) return Promise.reject(closed);
      if (pending) return Promise.reject(new Error('command channel already has an active request'));
      if (operationSignal?.aborted) return Promise.reject(operationSignal.reason ?? new Error('command channel request was cancelled'));
      let wire;
      try {
        const serialized = JSON.stringify(value);
        if (serialized == null) throw new TypeError('command channel request is not JSON');
        wire = Buffer.from(`${serialized}\n`);
        if (wire.length > inputLimit) throw new Error('command channel request exceeded its bound');
      } catch (error) { return Promise.reject(error); }
      clearTimeout(idle);
      return new Promise((resolve, reject) => {
        const onAbort = () => { evidence.aborted = true; close('ABORTED', 'command channel request was cancelled'); };
        const timer = setTimeout(() => { evidence.timedOut = true; close('TIMEOUT', 'command channel response timed out'); }, timeoutMs);
        timer.unref?.();
        pending = { resolve, reject, chunks: [], bytes: 0, timer, signal: operationSignal, onAbort };
        operationSignal?.addEventListener('abort', onAbort, { once: true });
        child.stdin.write(wire, error => { if (error) close('DISCONNECTED', 'command channel request could not be delivered'); });
      });
    },
    close: () => close(),
  });
}
