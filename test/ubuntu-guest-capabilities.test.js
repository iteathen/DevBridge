import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveUbuntuGuestCapabilities, UBUNTU_HYPERV_FCOPY_UIO_CAPABILITY } from '../src/runtime/image-builders/ubuntu-guest-capabilities.js';

test('Ubuntu Hyper-V fcopy capability is one sealed UIO unit with exact qualification', () => {
  const selected = resolveUbuntuGuestCapabilities([UBUNTU_HYPERV_FCOPY_UIO_CAPABILITY]);
  assert.deepEqual(selected.ids, ['hyperv-fcopy-uio-v1']);
  assert.equal(selected.files.length, 1);
  assert.equal(selected.files[0].path, '/etc/systemd/system/hv-fcopy-daemon.service');
  assert.match(selected.files[0].content, /^\[Unit\]\nDescription=Hyper-V File Copy Protocol Daemon\nConditionVirtualization=microsoft/u);
  assert.doesNotMatch(selected.files[0].content, /ConditionPathExists|BindsTo/u);
  assert.match(selected.files[0].content, /modprobe uio_hv_generic/u);
  assert.match(selected.files[0].content, /34d14be3-dee4-41c8-9ae7-6b174977c192/u);
  assert.match(selected.files[0].content, /test -d "\$device\/uio"/u);
  assert.match(selected.files[0].content, /ExecStart=\/usr\/sbin\/hv_fcopy_uio_daemon -n/u);
  assert.deepEqual(selected.commands, ['basename', 'find', 'grep', 'readlink']);
  assert.match(selected.qualification.join('\n'), /uio_hv_generic/u);
  assert.match(selected.qualification.join('\n'), /sha256sum -c/u);
});

test('Ubuntu guest capabilities reject unknown, duplicate, or authority-shaped input', () => {
  assert.throws(() => resolveUbuntuGuestCapabilities(['future-capability-v1']), /unsupported/u);
  assert.throws(() => resolveUbuntuGuestCapabilities(['hyperv-fcopy-uio-v1', 'hyperv-fcopy-uio-v1']), /capability 1 is invalid/u);
  assert.throws(() => resolveUbuntuGuestCapabilities(['../hyperv-fcopy-uio-v1']), /capability 0 is invalid/u);
});
