# VM Stage 2 provider foundation

Stage 2 implements the host-side provider and immutable base-image foundation required by DB-020 while deliberately leaving repository execution unavailable. It does not restore workers, tests, builds, package commands, or candidate-controlled validation to host execution.

## LEGO boundaries

The implementation is split into replaceable components with neutral studs:

- `src/runtime/environment-foundation.js` owns the provider-neutral status and lifecycle contract. It normalizes every value crossing the boundary and never forwards raw adapter objects.
- `src/runtime/base-image-library.js` owns immutable/versioned image publication, provenance, integrity, retirement, collection, and interrupted-publication reconciliation.
- `src/runtime/command-invocation.js` owns bounded local command invocation. It never selects a provider or accepts repository execution requests.
- `src/runtime/local-identity.js` owns one opaque installation-local identity.
- `src/runtime/providers/hyperv-environment.js` owns all Hyper-V/PowerShell/VHD/NAT details locally.
- `src/runtime/providers/libvirt-environment.js` owns all KVM/libvirt/QEMU/qcow2/network/pool details locally.
- `src/app/environment-foundation.js` is the topology/composition root. It is the only component that names and selects concrete host adapters.

Generic components do not contain concrete provider names or provider command/URI vocabulary. Provider adapters do not import each other or the generic foundation implementation; they satisfy the injected local contract structurally. External connections are therefore transient topology rather than component identity.

The existing Stage-1 `RepositoryExecution` contract is unchanged. Stage 2 is reported separately by `doctor`; `RepositoryExecution` remains `unavailable` until Stage 6.

## Readiness

`EnvironmentFoundation.inspect()` reports only neutral capability keys:

- `management`
- `images`
- `networking`
- `storage`

`ready` means all four are live-observed ready. Configuration or executable presence alone is never enough.

Windows management readiness requires a live `Get-VMHost` call and the fixed management operations needed by the adapter. Linux management readiness requires read/write access to `/dev/kvm`, a live `qemu:///system` libvirt connection, capabilities that expose a KVM domain type, and a working `qemu-img` command.

A missing base image, missing owned network/storage state, inaccessible management service, changed media identity, changed backing/parent state, or changed provider-owned object identity makes the relevant capability unready without changing repository-execution state.

## Immutable base-image lifecycle

Image publication is import/verify first rather than vendor-download first.

Each publication requires:

- a neutral `profile`;
- an explicit `generation`;
- a real regular local source file outside the image library;
- provenance containing at least `origin`;
- an optional authoritative expected SHA-256 digest when the upstream source publishes one.

The library always computes SHA-256 itself. `(profile, generation)` is immutable: attempting to publish different bytes under an existing generation is rejected. A new generation coexists with the old one and never rewrites a consumer silently.

Publication is journaled as `planned -> attempted -> reconciled`. The durable plan is written before the final rename. Recovery observes the owned staging/final objects and their digest before completing or failing the operation; it never blindly retries a copy/rename based on a guessed state.

Published bases are made read-only and record digest, size, filesystem identity, media format/virtual size, provenance, publication time, and last full verification time. Full SHA-256 verification is performed on publication and explicit use verification. Fast readiness checks also require the recorded file identity to remain unchanged.

Retirement is separate from collection. Collection removes only retired, unprotected identities that are tracked inside the exclusive library root. Untracked cleanup is limited to filenames and directories owned by this library.

### Windows media validation

The Windows adapter validates imported media with fixed `Test-VHD`/`Get-VHD` operations. A Stage-2 base must be a usable VHD/VHDX with no parent. The adapter records the VHD format, disk identity when present, and virtual size through neutral media fields.

### Linux media validation

The Linux adapter validates imported media with fixed `qemu-img info --output=json --backing-chain`. A Stage-2 base must be qcow2 and the observed chain must contain exactly one element with no backing parent. Human-readable `qemu-img` output and filename inference are not used as identity evidence.

Stage 3 owns writable differencing/overlay creation and exact parent/backing tracking for persistent repository environments.

## Provider-owned networking and storage

Provider object names are generated from the opaque local installation identity. Repository names, task identities, model names, and arbitrary caller-provided VM/network names never become provider object names.

Windows uses an owned internal virtual switch plus an owned NAT/private gateway. The switch carries an installation-specific ownership marker. Reconciliation verifies switch type/marker, NAT prefix, and gateway state before declaring networking ready or removing anything.

Linux uses an owned libvirt NAT network with a pre-recorded UUID, ownership metadata, generated bridge name, and collision-checked RFC1918 subnet. Storage is an owned libvirt directory pool targeting the managed image root with a pre-recorded UUID. Network/pool UUID, topology/target, and active state are re-observed before readiness or cleanup.

Network/storage setup records the intended identity before provider effects. An interruption leaves a planned record. Reconciliation re-observes the exact owned object and resumes only compatible incomplete effects; permission/service errors are never reclassified as absence.

## Bounded instance management primitives

Stage 2 provides bounded observe/start/stop/remove primitives for provider-owned instance identities without creating persistent repository environments. Stage 3 owns actual per-repository environment creation and persistence.

Instance inputs are opaque local tokens, not names. Each adapter derives its provider object identity internally and requires ownership evidence before start/stop/remove. Removal never requests provider-side deletion of arbitrary storage.

## Raw authority containment

No public Stage-2 contract accepts:

- PowerShell source or arguments;
- libvirt connection URIs;
- libvirt XML;
- QEMU argv;
- provider VM/domain/network/pool names;
- arbitrary provider management arguments;
- repository/task/model-shaped instance names;
- arbitrary image-library destination paths.

PowerShell scripts and `qemu:///system`/virsh/qemu-img argv are fixed inside their owning adapters. Dynamic values travel only through bounded adapter-owned data fields.

## Image acquisition and licensing policy

Stage 2 intentionally does not encode a universal automatic guest-image downloader. Media licensing, redistribution terms, evaluation expiry, and publisher integrity mechanisms differ by source.

For example, Microsoft Windows Server evaluation VHDs are evaluation media with time-limited terms, while Ubuntu cloud releases publish versioned VHD/qcow2 artifacts alongside signed checksum material. The reusable core therefore records provenance and digest and lets Stage 8 setup/acquisition adapters handle source-specific consent, license, download, and signature policy.

Primary references used during Stage-2 planning:

- Microsoft Hyper-V `Get-VMHost`: https://learn.microsoft.com/powershell/module/hyper-v/get-vmhost
- Microsoft Hyper-V `Get-VHD`: https://learn.microsoft.com/powershell/module/hyper-v/get-vhd
- Microsoft Hyper-V `Test-VHD`: https://learn.microsoft.com/powershell/module/hyper-v/test-vhd
- Microsoft Hyper-V NAT networking: https://learn.microsoft.com/virtualization/hyper-v-on-windows/user-guide/setup-nat-network
- Microsoft Evaluation Center: https://www.microsoft.com/evalcenter/
- libvirt connection URIs: https://libvirt.org/uri.html
- libvirt host capabilities: https://libvirt.org/html/libvirt-libvirt-host.html
- libvirt network format: https://libvirt.org/formatnetwork.html
- libvirt storage API: https://libvirt.org/html/libvirt-libvirt-storage.html
- QEMU `qemu-img`: https://www.qemu.org/docs/master/tools/qemu-img.html
- Ubuntu cloud-image releases: https://cloud-images.ubuntu.com/releases/

## Stage boundary

Stage 2 does **not**:

- provision per-repository writable disks;
- create persistent repository VMs/domains;
- implement the host/guest command or file bridge;
- bootstrap guest toolchains;
- route repository-controlled execution;
- add a direct-host fallback;
- add installer/provider mutation UX.

Those remain Stages 3–8 as assigned by issue #107.
