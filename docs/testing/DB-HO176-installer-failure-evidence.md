# HO176 installer failure evidence — work in progress

The retained Ubuntu installation failed with APT exit 100 while Hyper-V still
reported Running and its disk continued to grow. This change supplies a bounded
failure-evidence connection to the existing construction ledger and consumers.
It does not yet establish a production pre-runtime transport or satisfy #493.

The construction owner binds observations to the exact subject, provider
instance, immutable seed digest and attempt. It commits a small terminal report
before asking for diagnostic text. Failed, malformed, oversized or interrupted
collection cannot remove an already saved failure. The original installation
deadlines remain in force. Boot advancement refuses a saved failure before any
provider effect; guest completion does not establish image acceptance.

The evidence sequence identifies the installer outcome. Outcome fields cannot
change at the same sequence. Diagnostic collection can enrich the same outcome;
replaying a small status response without logs preserves previously collected
text. Saved report and failure hashes detect inconsistent durable records.

Read-only canary status reads the existing local identity and construction
ledger without creating a runtime or contacting a VM. A subsequent run may
refresh missing diagnostics under the existing mutation lease. This recovery
path cannot advance construction or probe guest access. Its response preserves
the saved stage, exit and redacted output even if collection throws or returns
no usable evidence. Collector health is separate from installer outcome.

The Ubuntu OS builder now also defines a live-installer shell artifact with
initialize, fixed-stage command observation, error and completion hooks. Its
socket entry accepts only one-byte status/diagnostic selectors. It reads the
strictly selected Subiquity journal identifier, using the numeric suffix of the
fixed installer-info symlink. It never selects the autoinstall configuration or
server debug dump. Journal output is bounded to 16 KiB, newest entries first;
the process has a ten-second deadline plus one-second termination grace. The
normal decoder independently bounds and validates all received bytes.

This artifact is not yet attached to the production seed or a native listener.
Provider registration/attachment, production composition, originating-task
correlation, expanded evidence delivery and installation-basis export remain
outstanding. No retained VM, package state, deadline, listener, registry or
canonical installation is changed by this work.

Regression evidence: the two original progress-consumer cases failed before the
change; the new application recovery test also initially threw away the useful
failure response when the diagnostic adapter disconnected. The corrected owner
and consumer suite passed 47 tests before the standalone Ubuntu artifact was
added. The subsequent focused suite passed 48 tests with two Linux-only skips.
Local Node22 preflight passed: three standalone artifacts, 305 syntax files,
two JSON files and all 242 targeted test files. It initially exposed three
stale inventory assertions and a real composition-boundary mistake. The parent
now injects diagnostic/evidence ports into both new helpers; the existing nested
LEGO test independently imports them and checks that they know no neighboring
topology. The affected composition suite passed 25 tests. Hosted qualification
is still pending. Linux CI must execute the two shell cases that Windows skips.

Platform basis: [Subiquity command and error hooks](https://canonical-subiquity.readthedocs-hosted.com/en/latest/reference/autoinstall-reference.html),
[Hyper-V socket integration](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/make-integration-service).
Hyper-V service registration is an owned setup effect requiring independent
qualification; the presence of systemd in the guest does not prove transport
readiness. Linux-host and Windows-setup native gates remain independent.

## Native reader follow-up

The provider now defines a read-only PowerShell/C# Hyper-V socket adapter.
It rejects wildcard VM identifiers and foreign ownership before invoking its
host process, then re-observes the exact VM ID, name, marker, running state and
attached seed bytes/digest before connecting. The service ID derives from the
existing installation identity and maps to a non-reserved Linux VSOCK port.
Registry absence is explicit unavailability; this adapter never registers a
service, launches elevation or writes guest state.

The socket uses nonblocking I/O and one cumulative monotonic deadline: at most
two seconds for connection, five seconds for status or fifteen for diagnostics.
Status reads accept at most 4096 bytes; diagnostics accept at most 65536 bytes.
It half-closes after one fixed selector and requires a complete bounded response.
The outer host command is separately bounded to thirty seconds. The native
Windows test compiles the exact C# helper and verifies its 36-byte endpoint
serialization without opening a connection to a VM. Protocol/identity tests also
cover collector absence, truncation, foreign subjects and wrong outcome sequence.

The first draft checkpoint a1b60798f71cad733d421579c39aceab31e414e2 passed all
four hosted [CI jobs](https://github.com/iteathen/DevBridge/actions/runs/34010832298),
including both Ubuntu shell cases. That run predates this native reader and does
not qualify it. The reader's three focused tests passed locally; qualification
of this expanded candidate remains pending. Its local Node22 preflight passed
three standalone artifacts, 306 syntax files, two JSON files and all 243
targeted test files in 71.7 seconds.

Setup ordering needs further assessment before composition: physical image
construction currently precedes protected lifecycle-authority apply. Do not add
an ad-hoc administrative registration, silently request UAC, or treat a WSL-specific
registration exception as ordinary Hyper-V permission. The retained fixture has
not been modified and no native socket exchange has been proved.
