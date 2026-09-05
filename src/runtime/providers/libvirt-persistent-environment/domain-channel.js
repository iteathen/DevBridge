const URI = 'qemu:///system';

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function xmlEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function stateFromText(text) {
  const first = String(text).trim().split(/\r?\n/u)[0]?.trim().toLowerCase() || 'unknown';
  return first.replace(/\s+\([^)]*\)\s*$/u, '').trim();
}

export class LibvirtDomainChannel {
  #invoke;

  constructor({ invoke }) {
    if (typeof invoke !== 'function') throw new TypeError('invoke must be a function');
    this.#invoke = invoke;
  }

  async #require(argumentsList, options = {}) {
    const result = await this.#invoke({ executable: 'virsh', arguments: argumentsList, ...options });
    if (!result || result.exitCode !== 0 || result.timedOut || result.aborted || result.outputTruncated) {
      const detail = result?.stderr?.trim() || result?.stdout?.trim() || 'environment management operation failed';
      throw new Error(detail.slice(0, 2048));
    }
    return result.stdout;
  }

  async observe(record) {
    const names = (await this.#require(['-c', URI, 'list', '--all', '--name'])).split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean);
    if (!names.includes(record.name)) return { exists: false, owned: false, compatible: false, state: 'absent', reason: 'owned environment configuration is absent' };
    const uuid = (await this.#require(['-c', URI, 'domuuid', record.name])).trim();
    const state = stateFromText(await this.#require(['-c', URI, 'domstate', record.name, '--reason']));
    if (uuid !== record.uuid) return { exists: true, owned: false, compatible: false, state, reason: 'environment ownership identity does not match' };
    const xml = await this.#require(['-c', URI, 'dumpxml', record.name], { maxOutputBytes: 2 * 1024 * 1024 });
    if (!xml.includes(record.marker)) return { exists: true, owned: false, compatible: false, state, reason: 'environment ownership marker does not match' };
    if (!new RegExp(`<source\\s+file=['"]${regexEscape(xmlEscape(record.diskPath))}['"]`, 'u').test(xml) && !xml.includes(`file='${xmlEscape(record.diskPath)}'`) && !xml.includes(`file=\"${xmlEscape(record.diskPath)}\"`)) {
      return { exists: true, owned: true, compatible: false, state, reason: 'environment storage attachment does not match' };
    }
    return { exists: true, owned: true, compatible: true, state, reason: null, xml };
  }

  define(location) { return this.#require(['-c', URI, 'define', location], { timeoutMs: 30_000 }); }
  start(name) { return this.#require(['-c', URI, 'start', name], { timeoutMs: 60_000 }); }
  shutdown(name) { return this.#require(['-c', URI, 'shutdown', name], { timeoutMs: 20_000 }); }
  destroy(name) { return this.#require(['-c', URI, 'destroy', name], { timeoutMs: 20_000 }); }

  async remove(record) {
    const xml = await this.#require(['-c', URI, 'dumpxml', record.name], { maxOutputBytes: 2 * 1024 * 1024 });
    const args = xml.includes('<nvram') ? ['-c', URI, 'undefine', record.name, '--nvram'] : ['-c', URI, 'undefine', record.name];
    await this.#require(args, { timeoutMs: 30_000 });
  }
}
