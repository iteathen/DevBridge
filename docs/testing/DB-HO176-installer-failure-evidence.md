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
