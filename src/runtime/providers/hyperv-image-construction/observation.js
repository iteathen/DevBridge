const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/u;

function privateIpv4(value) {
  const [first, second] = value.split('.').map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

export class HyperVConstructionObservation {
  status(identity, record, observed) {
    if (!record) return { identity, phase: 'absent', exists: false, owned: false, state: 'absent', diskPresent: false, diskAttached: false, mediaCount: 0, uptimeMilliseconds: 0, cpuUsagePercent: 0, providerStatus: 'absent', diskAllocatedBytes: 0 };
    if (observed.exists === true && observed.owned !== true && (record.phase !== 'planned' || record.providerIdentity)) {
      throw new Error('construction provider object is not owned by this operation');
    }
    if (observed.exists === true && observed.owned === true && observed.compatible !== true) throw new Error(String(observed.reason ?? 'construction provider object is incompatible'));
    if (record.providerIdentity && observed.exists === true && observed.providerIdentity !== record.providerIdentity) throw new Error('construction provider identity changed');
    const mediaCount = Number(observed.mediaCount ?? 0);
    if (!Number.isSafeInteger(mediaCount) || mediaCount < 0 || mediaCount > 16) throw new Error('construction media observation is invalid');
    const uptimeMilliseconds = Number(observed.uptimeMilliseconds ?? 0);
    if (!Number.isSafeInteger(uptimeMilliseconds) || uptimeMilliseconds < 0) throw new Error('construction uptime observation is invalid');
    const cpuUsagePercent = Number(observed.cpuUsagePercent ?? 0);
    if (!Number.isSafeInteger(cpuUsagePercent) || cpuUsagePercent < 0 || cpuUsagePercent > 100) throw new Error('construction CPU observation is invalid');
    const diskAllocatedBytes = Number(observed.diskAllocatedBytes ?? 0);
    if (!Number.isSafeInteger(diskAllocatedBytes) || diskAllocatedBytes < 0) throw new Error('construction disk allocation observation is invalid');
    const providerStatus = String(observed.providerStatus ?? 'unknown');
    if (providerStatus.length === 0 || providerStatus.length > 256) throw new Error('construction provider status observation is invalid');
    return {
      identity,
      phase: record.phase,
      exists: observed.exists === true,
      owned: observed.owned === true,
      state: String(observed.state ?? 'unknown'),
      diskPresent: observed.diskPresent === true,
      diskAttached: observed.diskAttached === true,
      mediaCount,
      uptimeMilliseconds,
      cpuUsagePercent,
      providerStatus,
      diskAllocatedBytes,
    };
  }

  address(observed) {
    if (observed?.ready !== true) return Object.freeze({ ready: false, reason: String(observed?.reason ?? 'construction guest address is unavailable'), address: null });
    if (!Array.isArray(observed.addresses)) throw new Error('construction guest address observation is invalid');
    const addresses = [...new Set(observed.addresses.map(String).filter((entry) => IPV4.test(entry) && privateIpv4(entry)))];
    if (addresses.length === 0) return Object.freeze({ ready: false, reason: 'construction guest has not reported a private IPv4 address', address: null });
    if (addresses.length !== 1) throw new Error('construction guest reported ambiguous private IPv4 addresses');
    return Object.freeze({ ready: true, reason: null, address: addresses[0] });
  }
}
