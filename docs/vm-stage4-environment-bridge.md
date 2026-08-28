# VM Stage 4 — narrow environment bridge

Status: Stage 4 implementation contract and qualification record.

Stage 4 adds the narrow host-controlled command/file exchange required by DB-020 on top of the repaired Stage 3 persistent-environment head `e553e42e8510e3f3f811812d2b70fa616efa3ab7`.

It deliberately does **not** restore normal repository-controlled execution. Production `RepositoryExecution` remains the Stage-1 no-provider/fail-closed implementation until Stage 6.

## LEGO boundary

Stage 4 is split into replaceable components with deliberately neutral studs:

- `src/runtime/environment-bridge.js` owns the provider-neutral bridge protocol, request/result validation, bounded execution observation, cancellation, file transfer, and ambiguous-completion behavior.
- `src/guest/bridge-agent.mjs` owns only guest-local execution/transfer mechanics and its durable request journal. It does not know the host provider, repository controller, worker topology, or host filesystem.
- `src/runtime/providers/hyperv-environment-bridge.js` owns only the Windows-host attachment details used to reach an exact Stage-3 environment.
- `src/runtime/providers/libvirt-environment-bridge.js` owns only the Linux-host attachment details used to reach an exact Stage-3 environment.
- `src/app/environment-bridge.js` is composition. It is the only Stage-4 module that selects a concrete host attachment and maps the current Stage-3 provider-local object convention into the neutral `locate(target)` stud.

The generic bridge and guest helper do not name Hyper-V, PowerShell, SSH, libvirt, QEMU, QGA, VHD/VHDX, qcow2, repository execution, worker exchange, or the removed host-sandbox implementations.

Provider attachments do not import one another and do not derive Stage-3 object names, ownership-marker formats, or provider identities. Each receives a neutral local locator result (`reference`, `proof`, and where needed an opaque `identity`) from composition. That keeps the attachment reusable if lifecycle naming or provider topology changes: only the composition wire changes.

This follows the topology rule: provider attachment is current wiring, not component identity.

## Common protocol

Protocol: `devbridge/environment-bridge-v1`

Current bridge version: `1.0.0`

Required features:

- `health`
- `execute`
- `observe`
- `cancel`
- `put`
- `get`

Every request binds:

- protocol;
- opaque 128-bit request identity;
- opaque exact environment target identity;
- one operation kind;
- a closed, bounded operation body.

Every accepted response must echo the same protocol, request identity, target identity, and operation kind. Unknown response fields, malformed frames, mismatched identities, invalid state combinations, non-canonical base64, and oversized data fail closed.

The guest is allowed to forge a syntactically valid response because the guest is untrusted. Therefore a valid bridge response is only **untrusted execution/output data**. It is never proof of authoritative Git state, publication, verification, a lease, a human decision, provider ownership, or another host authority.

## Logical guest locations

No bridge request contains a host destination path.

Guest file/cwd references use only a local logical location:

```text
{ class, path }
```

Current classes are:

- `input`
- `work`
- `output`
- `scratch`
- `cache`

The common bridge admits only the class subset appropriate to each action. Paths are portable, bounded, relative, and traversal-free.

Guest operation arguments may be ordinary bounded strings or logical locations. The guest helper resolves a logical location inside its own class root immediately before spawning the guest process. This is the Stage-4 fit point for Stage-1 input/output transfer arguments without exposing a guest-native or host-native absolute path to generic controller code.

## Command model

An execution request carries only:

- a bounded logical program identity;
- bounded arguments;
- a logical working directory;
- explicitly supplied bounded environment values;
- bounded stdin text;
- timeout;
- aggregate stdout/stderr byte ceiling.

It does not inherit a host executable path or host environment into the guest protocol. The guest helper also does not pass its complete service environment to the guest operation: it constructs a small OS-runtime allowlist (for example PATH/system/temp/locale basics) and overlays only the explicitly admitted request values. Bridge binding/configuration variables therefore do not become repository-process inputs accidentally.

The provider attachment selects every host management executable, provider argument, VM/domain target, transport option, helper path, and authentication mechanism locally.

### Asynchronous execution and durable observation

The bridge does not hold one provider session open for the lifetime of a build or test.

`execute` starts one exact request and returns a state such as `planned`/`running`. The guest helper durably journals the request before launching a detached local monitor process. The host then polls `observe` using the same request identity.

This has two important properties:

1. a long guest build is not coupled to a long-lived PowerShell Direct, SSH, QGA, or virsh call;
2. a daemon/provider-session interruption does not grant permission to replay a side-effecting command.

The helper rejects reuse of a request identity with a different operation body. Concurrent exact starts are fenced by a request-owned monitor claim so they cannot launch duplicate side effects. A `planned` record is the one safely restartable pre-effect state: before any guest command can start, the monitor must durably advance the record to `attempting`. If a monitor disappears while the record is still `planned`, the host observes that state and may re-present the exact same request so the helper can replace only a stale pre-effect monitor claim. Once `attempting` is durable, a dead/unobservable monitor becomes indeterminate rather than replayable.

Exclusive creation publishes the claim path before its small JSON body is necessarily complete. A losing concurrent starter therefore observes incomplete JSON and Windows sharing/open failures through a fixed bounded reread window; exhaustion still fails closed. If the claim disappears between exclusive-create failure and observation, the caller returns only to the same exclusive acquisition step. Observation alone never grants monitor ownership.

If the initial transport call fails, the common bridge observes the exact request before deciding whether the identical start request may be repeated. If observation itself is unavailable or contradictory, completion is `indeterminate` rather than guessed.

## Timeout and cancellation

Cancellation is bound to the exact request identity.

Host timeout or an external abort sends a bounded `cancel` for that request and then observes for a bounded reconciliation interval.

Possible outcomes are deliberately distinct:

- observed completion, including an observed guest result whose `timedOut` or `aborted` flag is true;
- an explicit guest operation failure;
- a protocol failure;
- an attachment/provider failure;
- indeterminate completion when the host cannot prove whether the side effect completed.

Indeterminate completion is not success and is not permission for a generic blind retry.

Guest-side timeout independently terminates the local process tree and records the result. Stopping/cancelling one command never deletes the Stage-3 persistent environment or its writable disk.

## File transfer

Stage 4 introduces no writable host share.

### Host to guest — `put`

The caller supplies a read capability. It does not supply a host path to the bridge.

The common bridge:

- reads bounded chunks from the capability;
- binds every chunk to one request identity and logical guest destination;
- hashes the complete byte stream with SHA-256;
- requires exact offset progression;
- retries only the exact same chunk after an interrupted transfer response.

The guest helper:

- writes into request-owned staging under its own bridge root;
- validates exact chunk replays against already-staged bytes;
- validates the complete digest before final rename;
- revalidates containment/parent shape immediately before the final rename;
- refuses traversal and symlink substitution.

A lost final response can therefore be reconciled by replaying the identical final chunk without rewriting a different object.

### Guest to host — `get`

The caller supplies a write/staging capability. It does not let the guest name the host destination.

The common bridge buffers at most the transfer ceiling, validates the complete SHA-256 digest, and calls the host sink only after the full object is validated. A forged final digest therefore cannot expose partial guest bytes to the host staging capability.

Stage 6 remains responsible for interpreting/importing returned candidate bytes into authoritative host Git. Stage 4 never writes guest data directly into publication authority.

## Explicit limits

Current common limits are intentionally smaller than the broad Stage-1 logical schema where the selected MVP transports require it:

- common request frame: 44 KiB;
- inline stdin: 16 KiB;
- file chunk: 16 KiB;
- one file transfer: 32 MiB;
- aggregate stdout + stderr: 3 MiB;
- command timeout: up to 8 hours;
- operation arguments: at most 256;
- explicit environment variables: at most 128;
- response hard-frame ceiling: 24 MiB.

The 44 KiB request ceiling is a transport-floor decision, not an arbitrary repository-size limit. The libvirt MVP sends the fixed helper request through QGA `guest-exec`; its `input-data` is base64 inside one locally constructed Guest Agent command, while the existing trusted host command-invocation LEGO bounds one argv element. Large source/context belongs in `put`, not in an oversized command frame.

Stage 6 must preserve these observed bridge limits when adapting the broader Stage-1 request schema. It must not silently widen the provider transport or fall back to host execution merely because a logical Stage-1 request is larger.

## Provider transport matrix

| Host provider | Guest profile | Stage-4 carrier | Why | Stage-5 prerequisite |
| --- | --- | --- | --- | --- |
| Hyper-V | Windows | PowerShell Direct to the fixed guest helper | host-initiated, independent of guest networking, supports a fixed remote helper | installed helper, local guest-management credential |
| Hyper-V | Linux | pinned noninteractive SSH to the fixed guest helper | practical Node-only MVP without introducing a native AF_HYPERV host helper | guest networking, installed helper, host-pinned guest SSH identity/host key |
| KVM/QEMU/libvirt | Linux | QEMU Guest Agent `guest-exec` carrying the fixed guest helper | structured libvirt/QGA path; no repository shell/XML/argv construction | virtio guest-agent channel, qemu-ga, installed helper |
| KVM/QEMU/libvirt | Windows | QEMU Guest Agent `guest-exec` carrying the fixed guest helper | same host attachment and typed DevBridge protocol | virtio guest-agent channel, qemu-ga service, installed helper |

The matrix says which Stage-4 attachment exists. Stage 7 still owns the real host/guest qualification claims. Stage 5 owns bootstrap/network/tool installation needed to make these attachment paths actually ready on a fresh guest.

## Hyper-V attachment

### Windows guests — PowerShell Direct

Microsoft documents PowerShell Direct as a Windows-host/Windows-guest mechanism that operates regardless of guest network configuration. It requires a local running VM and valid guest credentials.

Reference:

- https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/powershell-direct

The Stage-4 attachment:

1. receives the current exact target reference and ownership proof through the injected local `locate(target)` contract;
2. verifies that proof and running state before opening a guest session;
3. receives the guest-management credential only from a host-local access resolver;
4. opens a PowerShell Direct session;
5. starts only the fixed guest helper path;
6. passes the protocol frame as data, not interpolated PowerShell;
7. returns only the helper's bounded structured response.

The guest credential is not embedded in the helper request and the guest cannot select another host VM or host command.

### Linux guests — pinned SSH

Microsoft Hyper-V sockets were explicitly researched. Microsoft documents host `AF_HYPERV` and Linux guest `AF_VSOCK` as a network-independent integration transport identified by VM/service identities:

- https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/make-integration-service

They remain a viable future attachment, but using them directly from the current Node host would require an additional Windows-native socket integration layer. Adding that native helper solely for Stage 4 would expand the security/release surface before the common bridge protocol is qualified.

The MVP therefore uses SSH after Stage 5 supplies guest networking.

The SSH attachment is deliberately host-pinned and noninteractive:

- no user SSH config (`-F NUL`);
- batch mode;
- strict host-key checking;
- one explicit host-controlled known-hosts file;
- global known-hosts disabled for this call;
- one explicit host-controlled identity file;
- identity-only authentication;
- password/keyboard-interactive authentication disabled;
- agent/X11/other forwarding disabled;
- local-command/config-driven command expansion disabled;
- fixed remote command: the guest bridge helper only.

The protocol frame travels on stdin and cannot select SSH options or a remote shell fragment.

## libvirt/QEMU attachment

The Linux-host attachment uses the fixed local `qemu:///system` connection and receives the current exact domain reference, opaque identity, and ownership proof through its injected local `locate(target)` contract before every exchange.

It verifies:

- exact deterministic domain UUID;
- exact ownership marker in domain XML;
- running/blocked domain state.

It then issues locally constructed QEMU Guest Agent protocol requests through `virsh qemu-agent-command`.

References:

- https://libvirt.org/html/libvirt-libvirt-qemu.html#virDomainQemuAgentCommand
- https://qemu.readthedocs.io/en/master/interop/qemu-ga-ref.html
- https://wiki.libvirt.org/Qemu_guest_agent.html

QEMU documents `guest-exec` with structured `path`, `arg`, `env`, base64 `input-data`, and captured output, plus `guest-exec-status` for exit/output observation. The provider adapter uses that only to run the fixed Stage-4 helper and collect its response.

QGA does **not** satisfy the trust boundary. Libvirt explicitly warns that a hostile guest can send spurious replies. The DevBridge protocol therefore rebinds target/request/kind and revalidates sizes/digests after QGA returns.

### Stage-5 QGA bootstrap dependency

Libvirt's documented QGA setup requires a virtio serial channel named `org.qemu.guest_agent.0`, and the guest must run qemu-ga.

Stage 3 intentionally did not couple persistent-environment creation to a particular future bridge. Stage 4 likewise does not reach into the Stage-3 lifecycle LEGO to install another module's transport device. Stage 5 owns the guest/profile bootstrap that supplies the QGA channel/agent/helper for profiles using this carrier.

Until those prerequisites exist, bridge health is unavailable/fails closed rather than switching to a host execution fallback.

## Guest helper trust and filesystem defense

The helper is operational machinery, not a root of trust. Guest administrator/root may replace it or alter all guest files.

The helper still applies local safety constraints because they prevent accidental cross-class behavior and give honest guests deterministic semantics:

- dedicated class roots;
- relative path normalization;
- no symlink parents/targets;
- realpath containment checks;
- bounded operation/transfer journals;
- shell-free process spawn;
- bounded stdout/stderr;
- durable exact request identity;
- exact-body replay check;
- transfer digest checks.

A compromised guest can forge these observations. The host therefore treats all returned bytes/status as untrusted and never converts them directly into authority.

Windows junction/reparse and real-provider filesystem behavior are Stage-7 qualification subjects. The generic protocol does not claim a Windows-specific filesystem primitive based only on Linux CI mocks.

## Stage-1 stud fit

Stage 4 includes an architecture test that attaches a test-only adapter to the unchanged Stage-1 `repository-execution` request/input/output/result contracts.

The adapter demonstrates the intended future Stage-6 mapping:

- Stage-1 input transfer capability -> bridge `put` to a logical `input` location;
- Stage-1 output transfer reference -> logical `output` location;
- Stage-1 working directory -> logical `work` location;
- locally admitted logical tool -> guest bridge program/operation selected outside the generic bridge;
- Stage-1 signal/activity -> bridge cancellation/liveness;
- bridge result -> normalized Stage-1 result evidence;
- bridge `get` -> Stage-1 output capability.

This is deliberately a **test attachment only** in Stage 4. No production `src/app/runtime.js` import/registration of the Stage-4 bridge is added. Stage 6 owns production routing and source/candidate synchronization.

## Recovery model

Bridge effects follow DB-009's observe-before-repeat principle.

Command execution:

1. exact request identity is chosen before the effect;
2. guest journal persists `planned` before command launch;
3. a request-owned monitor claim fences concurrent starters before the monitor advances `planned` to `attempting`;
4. only still-`planned` pre-effect state may restart a stale monitor after observation;
5. same-body/same-ID replay is idempotent;
6. different-body/same-ID replay is rejected;
7. after a lost start response the host observes before repeating;
8. any post-`attempting` state whose completion cannot be proved becomes indeterminate.

File `put`:

- request-owned staging persists across exchange interruption;
- already-staged exact bytes can be re-observed through exact chunk replay;
- final identity is digest-bound.

File `get`:

- guest bytes are untrusted until full host-side digest validation;
- no partial bytes reach the supplied host sink before validation.

Provider/daemon restart therefore does not imply environment deletion or side-effect replay.

## Verification boundary

Focused Stage-4 tests cover:

- protocol/version feature negotiation;
- exact target/request response binding;
- malformed/unknown/oversized frames;
- common request transport ceiling;
- long-operation start/observe separation;
- observe-before-repeat after interrupted start;
- concurrent-start fencing and safe recovery of a stale pre-effect `planned` monitor;
- indeterminate completion;
- exact-request cancellation and guest timeout;
- logical cwd/argument location resolution;
- path/traversal rejection;
- host-to-guest transfer digest and exact chunk replay;
- guest-to-host complete-digest validation before sink exposure;
- real local guest-helper execution and durable replay prevention;
- Hyper-V exact ownership and fixed PowerShell Direct command construction;
- pinned SSH options and fixed Linux helper command;
- libvirt exact domain UUID/marker/state checks;
- fixed QGA `guest-exec`/`guest-exec-status` structure for Linux and Windows profiles;
- QGA truncation/foreign ownership failure;
- static LEGO checks preventing provider/neighbour vocabulary from leaking into common components;
- unchanged Stage-1 stud attachment in full repository CI;
- static proof that Stage 4 does not reconnect production repository execution or reintroduce legacy host isolation.

Hosted CI does not prove real Hyper-V/KVM guest execution. DB-020 assigns real provider/security/matrix qualification to Stage 7.

## What Stage 4 does not do

Stage 4 does not:

- install guest helpers, qemu-ga, SSH keys, network interfaces, SDKs, or compilers;
- inject host GitHub/SSH/release/coordination secrets into a guest;
- expose arbitrary writable host directories;
- make guest Git authoritative;
- interpret guest success as publication/test authority;
- reconnect normal repository task routing;
- add a direct-host fallback;
- restore Bubblewrap/AppContainer/ProcessContainer or sandbox mailbox/mount IPC;
- make Hyper-V and libvirt raw provider state look identical;
- change controller plans, publication logic, worker semantics, or authoritative Git.

Those omissions are intentional stage boundaries, not missing fallback behavior.
