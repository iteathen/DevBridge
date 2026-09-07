# HO176 installer failure evidence — work in progress

The next v18 construction passed APT update/upgrade and reached package install,
then powered off with its installer disc ejected. On 2026-09-06 the installed-boot
adapter failed by passing that empty DVD path to GetFullPath. Empty media is a
normal [Hyper-V DVD state](https://learn.microsoft.com/en-us/powershell/module/hyper-v/set-vmdvddrive?view=windowsserver2025-ps).
The adapter now permits empty paths only while detaching media before installed
boot. Exact provider/marker/disk, stopped state, expected controller/slot,
duplicate-slot rejection and matching paths for nonempty media remain required.
Preparation and installation still reject empty media. Native PowerShell tests
reproduced the original failure and verify those boundaries without provider
effects. The same retained VM can continue; no recipe change or rebuild is needed.

Fresh construction at integrated source `c57bacd1198d5c71734aebd7222c47a3699d53f6`
automatically returned a subject/VM/seed-bound status and then complete, untruncated
failure diagnostics on 2026-09-06. The reported stage was `apt-update`, exit 127:
`/run/devbridge-installer-evidence/agent: 82: curtin: not found`. The listener came
from the production seed, with no manual guest attachment. The journal also shows
installer-owned APT using the selected snapshot alongside the installer media.
This proves automatic pre-runtime collection during a real construction, while
successful image construction and originating GitHub-task delivery remain open.

The observer's fixed PATH hid the installer's command wrapper. Canonical's exact
[Subiquity snap configuration](https://github.com/canonical/subiquity/blob/9b41f1418858e38f88ba2724f540389b3fa41a0a/snapcraft.yaml)
adds its bin/sbin directories to the server's PATH, and its
[late-command launcher](https://github.com/canonical/subiquity/blob/9b41f1418858e38f88ba2724f540389b3fa41a0a/subiquity/server/controllers/cmdlist.py)
passes the inherited environment through without special handling of Curtin.
The observer now saves the
caller's PATH and umask before setting its own diagnostic defaults, then restores
them only inside the wrapped child. Its record updates and socket reader retain
their controlled PATH and private file mode. The Linux regression uses a command
available only on the caller's PATH, checks original arguments/environment/file
mask and exit 73, and shadows bookkeeping commands to prove they remain isolated.
This follows [POSIX command search and subshell environment rules](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/V3_chap02.html).
Recipe v18/output v14 distinguish the corrected observer from the failed seed.

Current correction: the Windows registry prerequisite and both registration gates
have been removed. This transport connects from the host to the guest listener;
it does not expose a host listener. Exact VM ownership, running state, attached
seed identity/hash, response identity, bounds and deadlines remain enforced.
Transport readiness comes from an actual exchange, not a registry entry.
The registration sections below record earlier implementation history and are
superseded. See [the socket library's direction-specific documentation](https://github.com/SvenGroot/Ookii.VmSockets#hyper-v-sockets).

The resumed physical check found `/run` mounted `noexec` in the actual Ubuntu
installer. The exact generated agent had mode `0700`, but direct initialization
failed with `Permission denied`. Every lifecycle hook now invokes `/bin/sh`
explicitly, matching the existing socket service. The mount policy is unchanged.
The first Linux CI run skipped the mount-dependent regression because its
`/dev/shm` allowed execution. The portable regression now initializes the agent,
removes its executable permission, proves direct execution fails, and exercises
the generated hooks for wrapped exit 100, sticky failure and completion denial.
The physical installer observation supplies the actual `noexec` evidence.
Recipe v16/output v12 prevent adoption of the earlier direct-execution seed.
This follows the kernel's documented [noexec/EACCES behavior](https://man7.org/linux/man-pages/man2/execve.2.html).

The host's native invocation also lacked `Get-FileHash`. Seed verification now
uses a disposed .NET SHA-256 file stream, retaining byte-length and digest
rejection. A Windows test executes that exact verification code with the hash
cmdlet unavailable and checks both matching and changed seed bytes.

Physical exchange at source `593e43fe96201525c773e6a35b2ee3c414b06c68`
passed on 2026-09-06 with an ordinary Windows token and the service registry key
absent. The exact reader received a 266-byte status frame and a 10,663-byte
diagnostic frame containing 7,799 bytes of installer journal; both native calls
exited zero, with no timeout or truncation. The returned journal includes the
actual OpenSSH 3.5/3.6 dependency conflict. This was the product listener manually
attached in `/run` to the retained failed VM; it proves transport, not a fresh
automatic construction or historical lifecycle observation. Its newly created
record correctly reports `installer-start`, unknown exit, sequence 2.
The temporary listener and files were removed after collection. The original
package capture and construction ledger remained byte-identical. Automatic
provisioning correlation, successful image construction and Hello World remain
open under #493/#488.

Current source supersedes the intermediate composition-pending checkpoints below:
PR501 head ea6e5da passed all four jobs in CI34013618479 with Ubuntu seed
activation, the exact owned Windows prerequisite and physical adapter composition.
Its native probe observed missing registration; no successful native socket
exchange or originating provisioning-task delivery is claimed. HO182 now extends
the same run/status owners with bounded expanded evidence, described below.

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

## HO182: bounded expanded status evidence

The collector's16KiB stream could contain an earlier useful failure that the
run's8KB compact tail discarded. Four new regressions first reproduced that
loss. captureFailureDiagnostics now preserves the compact fields and a redacted
16KiB-per-stream expansion when additional collected text is available. The
existing run record and status intent persist it before GitHub delivery.

The same status comment supplies the expansion automatically in a fixed details
section, under the task repository's access policy. Its explicit retention lasts
until the comment is updated/removed or the repository is removed. There is no
second publisher, gist, attachment store or delivery registry. The existing
comment budget reserves space for exact identity/context and distributes its
remaining diagnostic budget across streams. If rendering must omit text, each
stream retains its beginning and end with an explicit intermediate omission.
Collected-output truncation remains distinct from this publication bound.

All guest text remains in indented code. Review found an existing carriage-return
line-break escape in both diagnostic and summary rendering; two additional
regressions first failed, then passed after all three standard line endings were
handled. New tests also cover Unicode/newline floods at4096/48000-byte comment
budgets, redaction before both retention bounds, and ambiguous POST/outage/restart
without duplicate comments. Focused reporting/recovery tests passed32/32. An
initial preflight passed3artifacts307syntax2JSON244targeted before the carriage
correction; final preflight and exact hosted qualification follow this checkpoint.
These are source/reporting tests, not native installation or task-provisioning
correlation proof. No Python or canonical/native mutation was used.

Final HO182 Node22 preflight passed3 standalone artifacts,307 syntax files,2 JSON files and244 targeted test files after the carriage correction (71.2 seconds for targeted tests). Hosted and live expanded-comment qualification remain pending at this source checkpoint.
