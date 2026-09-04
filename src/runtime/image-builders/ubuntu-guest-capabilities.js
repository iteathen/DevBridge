import { createHash } from 'node:crypto';

const HYPERV_FCOPY_UIO = 'hyperv-fcopy-uio-v1';
const FCOPY_CLASS_ID = '34d14be3-dee4-41c8-9ae7-6b174977c192';
const FCOPY_DEVICE = '/sys/bus/vmbus/devices/eb765408-105f-49b6-b4aa-c123b64d17d4';
const FCOPY_UNIT = '/etc/systemd/system/hv-fcopy-daemon.service';
const CAPABILITY = /^[a-z0-9][a-z0-9-]{0,62}-v[1-9][0-9]{0,3}$/u;

const FCOPY_UNIT_CONTENT = `[Unit]
Description=Hyper-V File Copy Protocol Daemon
ConditionVirtualization=microsoft
After=systemd-modules-load.service

[Service]
ExecStartPre=/bin/sh -eu -c 'device=${FCOPY_DEVICE}; if [ ! -d "$device/uio" ]; then /usr/sbin/modprobe uio_hv_generic; echo ${FCOPY_CLASS_ID} > /sys/bus/vmbus/drivers/uio_hv_generic/new_id; fi; test -d "$device/uio"'
ExecStart=/usr/sbin/hv_fcopy_uio_daemon -n

[Install]
WantedBy=multi-user.target
`;

const DEFINITIONS = Object.freeze({
  [HYPERV_FCOPY_UIO]: Object.freeze({
    files: Object.freeze([
      Object.freeze({ path: FCOPY_UNIT, content: FCOPY_UNIT_CONTENT, permissions: '0644' }),
    ]),
    commands: Object.freeze(['basename', 'find', 'grep', 'readlink']),
    qualification: Object.freeze([
      `fcopy_device=${FCOPY_DEVICE}`,
      `[ "$(basename "$(readlink -f "$fcopy_device/driver")")" = uio_hv_generic ]`,
      `find "$fcopy_device/uio" -mindepth 1 -maxdepth 1 -name 'uio*' -print -quit | grep -q .`,
      `printf '%s  %s\\n' '${createHash('sha256').update(FCOPY_UNIT_CONTENT).digest('hex')}' '${FCOPY_UNIT}' | sha256sum -c - >/dev/null`,
    ]),
  }),
});

export function resolveUbuntuGuestCapabilities(raw = []) {
  if (!Array.isArray(raw) || raw.length > 16) throw new TypeError('Ubuntu guest capability set is invalid');
  const seen = new Set();
  const ids = raw.map((entry, index) => {
    if (typeof entry !== 'string' || !CAPABILITY.test(entry) || seen.has(entry)) throw new TypeError(`Ubuntu guest capability ${index} is invalid`);
    if (!Object.hasOwn(DEFINITIONS, entry)) throw new TypeError(`Ubuntu guest capability ${index} is unsupported`);
    seen.add(entry);
    return entry;
  }).sort();
  const selected = ids.map((id) => DEFINITIONS[id]);
  return Object.freeze({
    ids: Object.freeze(ids),
    files: Object.freeze(selected.flatMap((entry) => entry.files)),
    commands: Object.freeze([...new Set(selected.flatMap((entry) => entry.commands))].sort()),
    qualification: Object.freeze(selected.flatMap((entry) => entry.qualification)),
  });
}

export { HYPERV_FCOPY_UIO as UBUNTU_HYPERV_FCOPY_UIO_CAPABILITY };
