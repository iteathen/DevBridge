# Working DevBridge assessment — 2026-08-27

Status: active recovery assessment. This records the repository, issue, host, and primary-source evidence used to choose the next implementation sequence. It is not a replacement for DB-001–DB-020 or the owning issue contracts.

## Objective and constraints

The objective is a correctly working DevBridge, developed from primitive authority and recovery dependencies toward higher-level task execution and operator experience.

This pass preserves these constraints:

- repository-controlled execution remains VM-only and fails closed;
- Hyper-V and KVM/QEMU/libvirt remain first-class provider families;
- GPU, CUDA, and ROCm implementation is deferred until the recovery/installability chain is complete;
- provider, repository, lifecycle, bridge, setup, and runtime owners connect through neutral LEGO studs;
- no direct-host, legacy-sandbox, or ordinary-process provider-mutation fallback is admitted;
- existing local configuration and exact durable VM/construction evidence are not discarded or rewritten;
- cleanup targets only exact owned, superseded, or abandoned development artifacts after re-observation.

## Repository assessment

The visible default branch is not the active implementation frontier.

At assessment time:

- `origin/main` is `ae8fd88e125252a446e912eb17d337c4a1cf4931`;
- the active Windows/recovery candidate is PR #300 head `c50845f4e7da11a0202449613aaea4d892bcd2e5`;
- their merge base is `0745dd2dc57b2af4f3bbad4d5a57c1965c173783`;
- `origin/main` has three unique commits after that base;
- `origin/cuda-target` has 476 unique commits after that base before PR #300;
- PR #300 is clean against `cuda-target` and its four Windows/Ubuntu smoke/full CI jobs passed;
- draft PR #295 contains the preserved Linux authority slices but is intentionally behind the shared Windows reconciliation work and currently reports a dirty merge state.

The branch name `cuda-target` is historical and misleading for dependency analysis. Its current unique history contains the non-GPU permanent-entry, setup, lifecycle, image-construction, application-recovery, and protected Windows authority work required before GPU support. Commit contents and owning contracts, not that branch name, determine whether work is deferred.

The three current-main commits remain relevant and must not be lost:

1. public project entry-point hardening and repository tests;
2. the accepted agent-native guest execution-runtime design;
3. the accepted GitHub Issue chat-agent exchange design.

They should be integrated into the recovery candidate as a bounded baseline synchronization, with documentation conflicts resolved against the newer normative contracts rather than by choosing one side wholesale.

## Local checkout and installation assessment

The original checkout is intentionally not used for new edits. It is on the retired local `codex/temp-fast-functional` branch and contains operator-owned changes:

- modified `config/devbridge.fast.json`;
- untracked `config/devbridge.fast.json.before-setup`.

Those files are preserved. New work uses an isolated worktree rooted at PR #300 head.

The installed Windows entry exists at the user-scoped DevBridge home. Read-only observation found:

- Node `24.15.0`;
- Hyper-V available with 16 logical processors and about 32 GiB memory;
- one running protected lifecycle service under its own `NT SERVICE\DevBridgeLifecycle-*` identity;
- the ordinary identity cannot enumerate the protected lifecycle runtime beneath `C:\ProgramData\DevBridge`, which is useful negative evidence but not a substitute for the complete exact acceptance canary;
- setup authority includes the selected UCI Arena repositories and other approved repositories;
- the production-image construction journal contains two exact historical/current construction subjects;
- one old VM is off and one current VM is still running;
- the current VM is durably recorded as `installing`, with a stalled liveness observation, no CPU use, no guest IP, and no KVP contact after its hard deadline;
- the current construction VHDX has material allocation, so this is not the earlier zero-write boot failure.

The current VM and its durable journal are recovery evidence. Directly stopping, deleting, replacing, or editing it outside the owning lifecycle would violate DB-009 and the #169/#177 boundary. The next physical action must be an exact supported setup/lifecycle re-entry after the candidate is accepted, not manual Hyper-V surgery.

### Exact protected setup and construction re-entry

The recovery baseline was synchronized with current `main`, qualified locally and in Windows/Ubuntu CI, and merged into `cuda-target` as exact commit `4483474fc85e5f50a21accd7fef7c4a7a6067dfb` through PR #306.

The installed permanent entry then selected that exact commit for two physical invocations:

1. Ordinary `setup` exited `0`, reached the construction gate, retained all 16 configured repositories, and reported the protected Windows lifecycle service/state ready. It observed the existing durable construction frontier and performed no image or VM construction.
2. One `setup --construct` re-entry exited `1` and preserved the running VM. It reported overdue installer liveness, 1,314 minutes without progress, `9,332,326,400` allocated VHDX bytes, `0%` CPU, and no automatic VM repair. The bounded console evidence failed with `Hyper-V thumbnail dimensions are invalid: 512x1112`.

Read-only provider observation localized that final message to the console-evidence adapter:

- the running exact VM remains `db-image-build-a6dd830d2c150f2b` with provider identity `96327cb7-decd-41ed-93be-5e36e7dd83a8`;
- `GetVirtualSystemThumbnailImage(320, 240)` returns success and a `System.Byte[]` of 153,604 bytes;
- independent `GetSummaryInformation` large-thumbnail observation reports explicit width `320`, height `240`, and the identical 153,604-byte payload;
- the provider returns exactly four bytes beyond `width * height * 2` for tested `16x16`, `80x60`, `100x75`, `160x120`, `319x239`, and `320x240` requests;
- the first four bytes vary with the scaled image and do not encode the requested dimensions, while the last four observed bytes are zero;
- row-boundary coherence is materially better when the first expected RGB565 bytes are retained than when four leading bytes are removed.

The current adapter's newest compatibility branch treats the first four bytes as a little-endian width/height frame. That interpretation is falsified by the provider's independently reported dimensions and by the same four-byte excess at arbitrary sizes. The defect is diagnostic-only: no guest input, power operation, media change, disk mutation, or journal rewrite occurred.

The adapter fix passed local and Windows/Ubuntu CI, merged through PR #307 as `4d5dc5633d978773a3adf02414acbc4234076ca6`, and passed the exact physical gate. Plain setup exited `0`; one construction re-entry preserved the VM and published bounded console evidence with SHA-256 `0404afa06f60cf153b5e55dcff53ce9418af4b12fa257fd15b0361b68570ec92`.

A higher-resolution read-only provider observation then classified the guest state. Subiquity completed final system configuration and entered the user-supplied late commands. The exact snapshot update completed, but the following target transaction exited `100`:

```text
apt-get --snapshot 20260821T230000Z install -y --no-install-recommends \
  build-essential=12.12ubuntu2 \
  cmake=4.2.3-2ubuntu2 \
  git=1:2.53.0-1ubuntu1 \
  linux-cloud-tools-virtual=7.0.0-14.14 \
  nodejs=22.22.1+dfsg+~cs22.19.15-1ubuntu1 \
  npm=9.2.0~ds3-1
```

The exact top-level package records and files remain present in the Ubuntu snapshot, and direct dependency names are present across `main` and `universe`. That is not proof that apt can solve and apply the transaction against the installed target. The current setup authority validates top-level metadata presence only; it does not validate dependency closure, conflicts with the target base, download closure, or package configuration effects.

Two bounded Ubuntu 26.04 diagnostics supplied the missing solver evidence. The minimal container first showed that an APT snapshot update can exit zero after HTTPS certificate failures while retaining live-archive indexes; `--error-on=any` is required for the update to be authoritative. After bootstrapping the exact release `ca-certificates` package, the snapshot update succeeded and the exact six-package simulation failed on a mixed-generation dependency state: `npm -> node-gyp -> libnode-dev -> libssl-dev` selected snapshot `libssl-dev=3.5.5-1ubuntu3.3`, while the existing target state could not select its exact `libssl3t64` peer. This reproduces the class of physical failure without claiming the container is byte-identical to the installed server image.

Canonical's Subiquity implementation explains how the mixed state arises in the physical install: the default `updates: security` run executes `unattended-upgrades` after package installation and before user late commands. DevBridge previously applied its snapshot only inside late commands, after that installer-owned update had already moved target packages. Canonical's snapshot service documents `APT::Snapshot` as the source-wide control for all APT commands, expressly including `unattended-upgrades`. Subiquity forwards the autoinstall `apt.conf` field through Curtin, which writes the install-time target APT configuration. Subiquity restores that temporary configuration after unattended upgrades and before late commands, so the existing explicit late-command snapshot remains independently necessary.

The smallest owning repair is therefore in the Ubuntu seed: bind installer-owned APT work to the same exact snapshot through neutral package-set input, retain explicit snapshot binding for the later DevBridge-owned transaction, and make snapshot metadata refresh fail on any source error. It is not an authority expansion, a package downgrade workaround, or a second package source. The actual physical target already completed an HTTPS snapshot update, so the container-only CA bootstrap is diagnostic evidence and does not justify adding another production package stage.

The implemented candidate follows that boundary. It adds no interface field: the seed consumes the existing neutral `packages.snapshot`, renders it as install-time `APT::Snapshot`, and uses it in the existing late-command operations. The changed behavior is content-addressed by recipe generation `ubuntu-2604-autoinstall-v5`. The diagnostic workflow was deleted after recording its bounded evidence. Focused tests, repository preflight, and the full 1,145-test local suite pass with zero failures; exact provider construction remains the required capability proof.

## Issue and dependency assessment

The lowest unfinished product dependency is provider-management authority isolation, not polling, agent UX, or GPU routing.

The active chain is:

1. **Protected lifecycle authority — #177/#292/#293.** The ordinary coding/model identity must not own Hyper-V/libvirt mutation or backing storage. Windows repository-side work is qualified but still needs exact physical re-entry on the latest candidate. Linux has qualified plan and read-only inspection slices but lacks shared-reconciler integration, provisioning, and physical proof.
2. **Reconstructable lifecycle — #169–#178.** Declaration, journal, create/repair/rebuild/reset/recreate, exact image availability, and operator UX are implemented substantially on the recovery lineage and depend on the protected authority for safe production use.
3. **Fresh-host image/install chain — #192 and #197–#201.** The Ubuntu production image is the immediate real-host construction blocker. Windows media/licensing/activation and private image distribution remain separate later owners.
4. **Permanent entry and recovery composition — #153/#159/#180/#182.** The stable entry, runner, accepted runtime, recovery control plane, and environment reconstruction must compose after the lower lifecycle and image supply are dependable.
5. **VM Stage 7–9 — #115–#117.** Real provider/security/recovery qualification, setup/reconfiguration, and final migration cleanup follow the working primitive chain.
6. **Higher-level execution usability.** Multi-repository polling, controller/agent proposal work, UCI Arena execution, guest console/runtime ergonomics, and generalized roles become meaningful only when the admitted VM route can be installed and recovered.
7. **GPU/CUDA/ROCm — #162/#186/#283.** Deferred until the preceding recovery/installability gates are complete.

Open architecture issues #244–#254 are relevant when a touched parent LEGO has an unsafe reasoning surface. They are not authorization for a broad behavior-changing rewrite. A touched owner should be nested first only where inspection shows that doing so materially lowers the risk of the current functional change.

## Primary-source research

### Windows authority and Hyper-V

Microsoft documents that a service SID can be placed in the service process token and used to ACL exact resources to `NT SERVICE\<service>`. `SERVICE_SID_TYPE_RESTRICTED` also places the SID in the restricted SID list, limiting service writes rather than merely distinguishing the service identity. The configured SID type takes effect on the next service start. This supports the current dedicated-service design and requires restart-aware verification rather than trusting configuration alone.

Sources:

- [SERVICE_SID_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/ns-winsvc-service_sid_info)
- [Service Security and Access Rights](https://learn.microsoft.com/en-us/windows/win32/services/service-security-and-access-rights)

Microsoft's named-pipe contract confirms that a pipe DACL controls both server and client access, and that generic write includes `FILE_CREATE_PIPE_INSTANCE`. The mutation pipe therefore must use explicit minimal rights and prove that the ordinary identity cannot connect or create another instance; a guess-resistant pipe name is not an authority boundary.

Source: [Named Pipe Security and Access Rights](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)

Hyper-V uses VM-specific SIDs to access attached VHD/VHDX state. Removing a VM removes its configuration but does not remove its virtual hard disks, and checkpoint deletion/merge can retain file activity. This supports separate provider-removal and exact backing-file-retirement stages plus bounded reconciliation for transient post-provider file release. It does not support an unbounded generic retry or direct caller-selected deletion.

Sources:

- [Hyper-V VM disk access permissions](https://learn.microsoft.com/en-us/troubleshoot/windows-server/virtualization/hyper-v-virtual-machine-not-start-0x80070005)
- [Remove-VM](https://learn.microsoft.com/en-us/powershell/module/hyper-v/remove-vm)
- [Hyper-V snapshot and differencing-disk guidance](https://learn.microsoft.com/en-us/troubleshoot/windows-server/virtualization/hyper-v-snapshots-checkpoints-differencing-disks)

Microsoft defines `GetVirtualSystemThumbnailImage` as returning raw RGB565 in a `uint8[]` for the requested width and height. The separate `GetSummaryInformation` API exposes fixed small, medium, and large thumbnail requests, and `Msvm_SummaryInformation` reports `ThumbnailImageWidth` and `ThumbnailImageHeight` independently of its raw RGB565 byte array. DevBridge must therefore validate dimensions from the provider contract and normalize only an exactly observed transport-size variant; it must not reinterpret arbitrary image pixels as an undocumented dimension header.

Sources:

- [GetVirtualSystemThumbnailImage](https://learn.microsoft.com/en-us/windows/win32/hyperv_v2/getvirtualsystemthumbnailimage-msvm-virtualsystemmanagementservice)
- [GetSummaryInformation](https://learn.microsoft.com/en-us/windows/win32/hyperv_v2/getsummaryinformation-msvm-virtualsystemmanagementservice)
- [Msvm_SummaryInformation](https://learn.microsoft.com/en-us/windows/win32/hyperv_v2/msvm-summaryinformation)

Ubuntu documents that a snapshot update must run immediately before the snapshot package command. It also documents `APT::Snapshot` as the way to bind every snapshot-capable repository for every APT command, including `unattended-upgrades`. APT returns `100` for an error, while an update without `--error-on=any` can still exit successfully after individual source failures. Subiquity supports exact-version entries in its `packages` list and permits `curtin in-target` late commands. Its default `updates: security` contract runs before late commands, and its implementation forwards other `apt` configuration such as `conf` to Curtin. Curtin writes that `conf` to the target's install-time APT configuration. These are separate contracts: the source-wide snapshot prevents installer-owned drift, while the explicit late-command snapshot binds the later DevBridge-owned transaction after Subiquity restores its temporary install configuration.

Sources:

- [Ubuntu Snapshot Service](https://snapshot.ubuntu.com/)
- [Ubuntu `apt-get` manual](https://manpages.ubuntu.com/manpages/noble/man8/apt-get.8.html)
- [Subiquity autoinstall configuration reference](https://canonical-subiquity.readthedocs-hosted.com/en/latest/reference/autoinstall-reference.html)

The exact v5 Hyper-V construction disproved the source-wide conclusion above. Its new subject `subject-b75a87f28715720d2e51d6547f868753` reached Curtin curthooks, then failed while Curtin attempted to install the neutral UEFI boot prerequisite set (`efibootmgr`, `grub-efi-amd64`, `grub-efi-amd64-signed`, and `shim-signed`). A read-only `640x480` call to Hyper-V's documented thumbnail API exposed that earlier failure without guest input or VM/disk/media mutation. The accepted v4 subject had passed this same installer phase; v5's only relevant source-policy change was global `APT::Snapshot`. A global snapshot is therefore rejected for the installer-owned APT configuration even though it is valid for a bounded target transaction.

Subiquity has no supported “none” value for `updates`: its schema admits only `security` and `all`, and the controller always runs unattended-upgrades when archive networking is available. The unattended-upgrades owner provides a narrower control. `Unattended-Upgrade::Package-Blacklist` is a list of Python regular expressions used to give matching package names a never-install pin. Its implementation returns success when no packages are eligible. A temporary installer APT fragment containing only an all-package blacklist can therefore leave Curtin's ordinary prerequisite installs untouched, prevent the pre-late automatic update from producing a mixed target generation, and disappear when Subiquity restores the installer APT configuration before late commands. DevBridge's explicit late commands remain responsible for the accepted snapshot transaction.

This is a sequencing control, not permission to omit security maintenance. The next construction design must keep the image's final exact package qualification and its snapshot-bound security baseline consistent. If applying the snapshot's wider update/security pockets changes a qualified top-level package, setup authority must resolve and record the same final candidate version; qualification may not silently weaken from exact equality.

The implemented v6 candidate preserves that equality: setup resolves the greatest package version across the release, updates, and security pockets using Debian's documented ordering; the seed blocks only installer-owned unattended package selection, then runs snapshot update, a no-removal snapshot upgrade, and exact top-level installation in that order. Package comparison is its own small owner with neutral string inputs and a numeric comparison result. Ubuntu authority owns pocket topology; the seed consumes only the already accepted snapshot/package contract. Recipe and package generations advance independently, so neither v5 construction state nor its top-level pins can alias this candidate.

PR #309 qualified this implementation in all four Ubuntu/Windows smoke and full CI jobs, including direct Ubuntu `dpkg` agreement for the fixed comparison corpus, and merged it into the recovery line as exact commit `d38c662254d388edcbf1a0760e2efce8bd05b8e1`. The software evidence is complete for this slice. Physical acceptance remains open because a new protected runtime generation must be installed before v6 can derive and construct its own exact Hyper-V subject; no older installed generation or manual VM mutation can substitute for that gate.

The exact v6 physical gate subsequently reached installed-system boot and disproved the remaining access assumption. Subject `subject-7d53b430cc49c26753d9eb090be633f0` installed, detached both media, booted from its retained VHDX, reported healthy Hyper-V heartbeat/KVP state and one private DHCP address, but kept TCP 22 closed through at least 15 minutes 25 seconds of idle uptime. The local contract is internally inconsistent: the seed says `ssh.install-server: false`, the exact package authority omits `openssh-server`, and the next phase requires `ssh.service`. Canonical documents that `install-server` controls target OpenSSH installation and defaults to false.

The replacement stays within the Ubuntu image owner. It enables key-only SSH installation, adds `openssh-server` to snapshot-resolved exact package and qualification evidence, and advances immutable recipe/package/output generations. No provider retry, network change, guest repair, password access, live package source, or host fallback is admitted. The failed v6 subject remains preserved physical evidence. A separate neutral readiness-observation slice should give transient first-boot access a bounded next observation and terminal deadline; it must not be hidden as an unbounded transport retry.

The isolated implementation completes both software slices. A provider-free readiness-window LEGO now reports observing/slow/expired state from neutral time inputs; the physical composition supplies its local two-minute expected, ten-minute hard, and 30-second recheck policy. Focused tests, repository preflight, and the complete 1,223-test Windows suite pass with zero failures. Remote Ubuntu/Windows CI and an exact v7 physical construction remain open acceptance gates.

Additional primary sources:

- [Subiquity install controller](https://github.com/canonical/subiquity/blob/main/subiquity/server/controllers/install.py)
- [Subiquity autoinstall schema](https://github.com/canonical/subiquity/blob/main/autoinstall-schema.json)
- [unattended-upgrades configuration and behavior](https://github.com/mvo5/unattended-upgrades)
- [unattended-upgrades implementation](https://github.com/mvo5/unattended-upgrades/blob/master/unattended-upgrade)
- [Debian package-version ordering](https://manpages.debian.org/trixie/dpkg-dev/deb-version.7.en.html)

### Linux authority, systemd, libvirt, and qcow2

Libvirt's modular `virtqemud` uses local Unix sockets and is commonly systemd socket-activated. Its RW socket can grant authority comparable to root. Socket group membership alone is therefore too coarse as the final security story.

Sources:

- [virtqemud](https://libvirt.org/manpages/virtqemud.html)
- [Libvirt daemons and modular sockets](https://libvirt.org/daemons.html)

Libvirt supports polkit-backed fine-grained checks over permission and object identity, including domain UUID and storage pool/volume identity. On supported hosts, the Linux adapter should prefer exact local policy over broad persistent ordinary-user libvirt membership. Where a distribution lacks the needed mechanism, readiness must report the limitation or use a separately proven service-only socket capability; it must not silently broaden ordinary identity authority.

Sources:

- [Libvirt connection authentication](https://libvirt.org/auth.html)
- [Libvirt polkit access control](https://libvirt.org/aclpolkit.html)

The QEMU system driver normally runs guests under a non-root QEMU identity and manages disk access through DAC and, where present, sVirt/SELinux/AppArmor. DevBridge must preserve those platform layers. It must not disable security drivers, make storage world-writable, or assume that authority-service access alone proves the QEMU process can operate exact disks.

Source: [Libvirt QEMU driver security architecture](https://libvirt.org/drvqemu)

Systemd's execution contract supports a read-only service filesystem with explicit writable state/runtime locations. `StateDirectory=` and related directory owners may create writable exceptions under `ProtectSystem=strict`; that behavior must be represented deliberately and verified on the target distribution rather than duplicated with a broad `ReadWritePaths=` grant.

Source: [systemd.exec source contract](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml)

QEMU exposes backing-chain identity through structured `qemu-img info --backing-chain` output. Unsafe rebase only changes recorded backing metadata and can corrupt guest-visible content if the caller supplies the wrong parent. This reinforces DB-020's rule: observe and bind exact backing identity; never infer lineage from filenames or silently rebase an overlay to a new image generation.

Sources:

- [QEMU disk image utility](https://www.qemu.org/docs/master/tools/qemu-img.html)
- [qcow2 format](https://www.qemu.org/docs/master/interop/qcow2.html)

## Reassessment

The research and current evidence preserve the original primitive ordering but refine the implementation choices:

- **Windows:** continue the dedicated service-SID and explicit pipe-DACL design. Treat service configuration, running token, pipe capability, backing-store ACL, Hyper-V operation, and exact cleanup as separate observations. PR #300's bounded exact-fixture cleanup retry is architecturally valid only because it admits a small Windows transient set and preserves terminal failure.
- **Linux:** keep the per-install system service and immutable root-owned runtime, but do not freeze broad libvirt group membership as the universal provider capability. The adapter must detect modular versus monolithic daemon/socket behavior and select a locally supported, bounded service-only authorization policy. Ordinary identity must remain outside provider RW authority.
- **Physical recovery:** exact protected-authority re-entry and console capture pass. The first replacement design also has terminal physical evidence: source-wide snapshot configuration moved failure earlier into Curtin's boot-prerequisite installation. Reject that design, preserve both failed subjects, and replace it with the narrower unattended-update sequencing control plus a final snapshot/package contract that exact qualification can prove.
- **Branch integration:** PR #300 and the three current-main commits are synchronized and qualified at recovery commit `4483474fc85e5f50a21accd7fef7c4a7a6067dfb`. Continue new recovery behavior on fresh isolated branches from that commit. Do not develop on the retired fast-track checkout or directly on `main`.
- **Mainline merge:** do not overwrite or force main. Open an evidence-backed integration PR only after the synchronized core branch is green and the intended fail-closed/working platform state is documented. Incomplete Linux readiness may merge only if Linux remains explicitly unavailable with no fallback and the PR scope says so.
- **GPU:** no GPU/CUDA/ROCm implementation, device routing, image specialization, or provider attachment work belongs in the current sequence.

## Current blockers and safe frontier

1. The v4 exact Ubuntu package transaction failed in-target with apt exit `100`; the v5 global-snapshot replacement failed earlier in Curtin curthooks. The next authority must preserve installer prerequisites, suppress only the pre-late mutation, and make the final snapshot package/security state exactly qualifiable.
2. No VM repair, snapshot rotation, replacement, or exact-owned retirement is admissible until the corrected package authority derives a new exact subject. The v4 and v5 failures remain evidence, not reusable construction state.
3. Linux protected-authority implementation must be rebased onto the shared reconciler and completed before Linux can be declared ready.
4. The synchronized recovery lineage remains intentionally separate from `main` until the primitive provider/image/install gates have physical evidence.

The implementation sequence and acceptance gates are recorded in `working-devbridge-plan.md`.
