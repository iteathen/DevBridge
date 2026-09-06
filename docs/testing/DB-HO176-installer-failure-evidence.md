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

The expanded reader candidate 1e0cffa5a513cc5c01526ce48cc8b22bec9a25b9
subsequently passed all four [CI jobs](https://github.com/iteathen/DevBridge/actions/runs/34011670835).
Its read-only native probe found the required service registration absent and
returned explicit unavailability. Canonical state bytes were unchanged; no VM,
guest, registry or elevation effect occurred. This is an observed prerequisite
failure, not successful socket collection.

The next composition unit adds bounded systemd socket/service artifacts and a
local constructor port on UbuntuProductionSeedFactory. A composed seed installs
the live agent and activation before late transactions, wraps the existing basis
capture and three APT commands without changing them, records errors and reports
completion. Task/guest seed requests cannot provide this port. Production has not
enabled it or changed recipe/output generations; that must accompany the owned
setup prerequisite and physical composition. Two new seed tests first failed,
then the focused suite passed 15 cases with three Linux-only skips. Linux CI must
verify the exact generated systemd units without starting them, in addition to
executing the existing shell protocol tests. This unit's wider qualification is
pending.

Separately, HO177 exported the retained immutable installation basis using
existing guest curl and a bounded, one-transfer operator receiver. Host readback
and post-transfer guest checks both match raw SHA256
e5d910bdfa9556c7f4ede59c396231081c14484a3d1783b7dcf324dfc9275cc0:
526998 bytes, mode444, linkcount1. The existing release normalizer found 522
installed packages, semantic SHA256
50f71358fc39927703b48cb06d833aed032744a37e81556414cb0bfe1ba9b583.
OpenSSH client/server/SFTP are all3.6 before the explicit late APT commands.
The exact raw and normalized files remain unsigned operator evidence. This
UI/network export advances #489; it does not satisfy automatic offline #493
collection, release admission, solving, signing or Hello World acceptance.

## Owned prerequisite and production composition

The socket/seed candidate3c6f91de193282c350d6ec4ed6d7d383602e519f passed all
four [CI jobs](https://github.com/iteathen/DevBridge/actions/runs/34013109851),
including actual Linux systemd unit verification and both shell tests. Its local
preflight passed3 artifacts,306 syntax files,2 JSON files and243 targeted files.

Further ownership assessment found the existing Windows prerequisite reconciler
already runs before construction and establishes fixed OS prerequisites only
when invoked with an administrator token. The new Windows-specific child uses
that same boundary for the exact per-installation Hyper-V service registration.
Ordinary setup only observes and reports the missing prerequisite. It never
requests elevation. Conflicting or incomplete registry ownership is not adopted
or replaced; establishment uses no Force, and independent readback is mandatory.
An ambiguous effect stays unavailable until re-entry re-observes the native key.
No generic protected-service command or second state registry was added.

The selected Linux profile now requires this prerequisite. The physical canary
composes the read-only collector and its exact port into the seed, and checks
registration after media/patch validation but before network/access/VM allocation.
Prepared seed evidence must carry the expected protocol and port. Recipe v15 and
output v11 distinguish the new behavior from retained v14/v10 subjects. Existing
retained VMs and seeds are never retrofitted by this source change.

Eight prerequisite/reader tests passed, including Windows parsing of the actual
PowerShell source without executing registry operations. Composition tests passed
44/44. The existing invalid-media test first caught an unnecessary earlier host
inspection; the check now follows patch validation, preserving that original
allocation boundary. The added production-composition regression proves absent
registration prevents network/access/VM allocation, and its suite plus preflight
contracts passed24/24. Local Node22 preflight passed3 artifacts,307 syntax files,
2 JSON files and244 targeted files in72.2seconds. Hosted qualification of this
expanded prerequisite composition remains pending. No host registration,
elevation, native socket exchange, new construction or automatic GitHub
installer-failure delivery is claimed.
