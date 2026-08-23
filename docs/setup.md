# DevBridge setup

DevBridge is installed from one standalone stage-0 launcher and then keeps its managed runtime current through the secure supervisor.

## Current implementation versus VM target

DB-020 and `docs/execution-profile-environments.md` define the active repository-execution architecture: a trusted DevBridge controller on the host plus persistent, networked execution-profile VMs. **Execution profiles own persistent VMs; repositories own isolated workspaces inside compatible execution-profile VMs.**

Repository discovery/selection and VM provisioning are separate concerns. Selecting many repositories must not imply creating or starting one VM per repository. Repositories that use the same compatible profile share that physical profile VM through separate workspace identities.

The required initial host providers are:

- **Windows:** Hyper-V;
- **Linux:** KVM/QEMU managed through libvirt.

Stages 0–6 of that VM path are implemented on the migration stack. Stage 1 removed the old host-sandbox path; Stages 2–5 provide foundation, persistent environments, bridge, and guest preparation; Stage 6 restores routed repository execution. Stage 3's original repository-owned persistent-VM topology is historical implementation evidence and is superseded by the execution-profile ownership correction in issue #138.

The migration stack behaves as follows:

- repository-controlled and candidate-controlled execution uses only locally admitted ready persistent VM routes and otherwise remains fail-closed on both Windows and Linux;
- Windows `doctor` can observe the Stage-2 Hyper-V management/image/network/storage foundation;
- Linux `doctor` can observe the Stage-2 KVM/QEMU/libvirt management/image/network/storage foundation;
- provider/image readiness is reported separately from repository-execution readiness;
- Draft PR #106's Windows ProcessContainer/AppContainer work is superseded migration evidence and is not the supported target.

The completed Stages 3–5 interval kept execution unavailable. Stage 6 restores it through persistent VMs only. Do not introduce direct/uncontained host execution as compatibility behavior.

Stage 2 does not add installer mutation UX. Do not manually configure provider objects and assume DevBridge owns them merely because `doctor` can observe the host. VM Stage 8 (#116), coordinated with setup/reconfiguration issue #103 and fresh-host image/licensing issue #192, owns supported discovery/provisioning/re-entry after the lower VM stages are implemented and qualified. Stage 8 must provision/reuse physical environments by execution profile and create/repair repository workspaces separately.

## Blank-slate installation rule

DevBridge setup must behave as if the user is a normal new user on an unknown host. It must not rely on developer-workstation history.

Do not assume:

- virtualization/provider features are installed, enabled, authorized, or healthy;
- source ISOs or prepared base images exist;
- the user wants Windows;
- a Windows product key or organization activation service exists;
- host Windows activation can be reused in a VM;
- the user is legally permitted to publish prepared Windows bytes;
- any image artifact repository exists;
- the GitHub owner is `iteathen` or any other fixed account;
- GitHub credentials can create repositories/Releases;
- zstd/qemu-img/xorriso/ADK or other image-construction tools are installed;
- the local image cache is durable reconstruction authority.

Discover safe facts first. Ask only for unresolved choices or explicit local consent.

See `docs/fresh-host-image-provisioning.md` and #192 for the complete image/licensing/recovery flow.

## Current requirements

Current main requires:

- Node.js 22.16.0 or newer
- Git
- a GitHub account with access to the configured task queue and target repositories

Stage-2 host-foundation requirements are provider-specific when those capabilities are expected to be ready:

- Windows requires a usable Hyper-V configuration and DevBridge management authority.
- Linux requires usable KVM acceleration plus the QEMU/libvirt management path, normally a locally authorized `qemu:///system` provider.

Setup must not infer VM readiness merely from Hyper-V being installed, `/dev/kvm` existing, `virsh` being present, or a VM/domain name existing.

## Fresh install

### Linux

```sh
mkdir -p "$HOME/.devbridge/bin" && curl -fsSL https://raw.githubusercontent.com/iteathen/DevBridge/main/devbridge.mjs -o "$HOME/.devbridge/bin/devbridge.mjs" && node "$HOME/.devbridge/bin/devbridge.mjs"
```

### Windows PowerShell

```powershell
New-Item -ItemType Directory -Force "$HOME\.devbridge\bin" | Out-Null; Invoke-WebRequest "https://raw.githubusercontent.com/iteathen/DevBridge/main/devbridge.mjs" -OutFile "$HOME\.devbridge\bin\devbridge.mjs"; node "$HOME\.devbridge\bin\devbridge.mjs"
```

The launcher uses only Node.js built-ins and local Git to establish/verify the fixed managed DevBridge runtime. It does not silently enable repository execution or VM management.

On a fresh home, the managed secure bootstrap creates the safe example configuration and exits. Review local authority before enabling anything.

Then use:

```text
node ~/.devbridge/bin/devbridge.mjs doctor
node ~/.devbridge/bin/devbridge.mjs
```

PowerShell users can use `$HOME\.devbridge\bin\devbridge.mjs` in the same commands.

## Removed host-sandbox prerequisite

Bubblewrap is no longer an active repository-execution prerequisite. Stage 1 removed the host-sandbox execution implementation and Stage 2 does not reintroduce it.

Historical sandbox documentation remains evidence only. From Stage 1 until Stage 6, repository execution is unavailable rather than falling back to Bubblewrap or the direct host.

## Configuration authority

The canonical checked-in example is:

```text
config/devbridge.example.json
```

Fresh configuration keeps execution, model adapters, coordination, dynamic tool onboarding, and automatic task-branch publication conservative/off by default.

Review at least:

- `github.queueRepository`
- `github.trustedActorIds`
- `workspace.allowedOwners`
- `workspace.baselineChannels`
- `execution.*`
- `execution.decisionAuthorities`
- `coordination.*`
- `publication.*`
- local tool profiles/credentials.

`workspace.externalReadRoots`, proposal profile `sandbox.*`, and `execution.allowUncontainedTools` are host-sandbox-era surface. Stage 1 removes their ability to authorize repository-code host execution. Stage 8 defines deliberate operator-facing migration/deprecation, and Stage 9 removes remaining compatibility where appropriate.

`execution.allowUncontainedTools` or equivalent must never bypass the no-provider state.

Existing operator configuration is never silently rewritten during self-update.

## Execution remains opt-in and provider-bound

Setting `execution.enabled` is local machine authority. Task text cannot enable it.

Current pre-migration main fails closed if a requested repository-code execution class lacks the provider it actually implements/verifies.

Stage 6 VM-backed execution requires observed provider + image + compatible execution-profile environment + bridge + repository workspace-route readiness, even if `execution.enabled` is configured. If any are missing, execution remains unavailable; it never redirects to direct host execution. A legacy repository-owned VM record is not silently adopted as the physical profile environment.

## GitHub authentication

GitHub credentials are host control-plane authority under DB-003/DB-008.

DevBridge may use configured environment-variable providers or the current GitHub CLI credential for the configured hostname. Token values are not serialized into config/status/run state and are not forwarded to repository execution.

Under DB-020 repository guests normally have network access, so host GitHub/SSH/publication credentials must remain absent from the guest. Private dependency/coding-service support requires explicit later scoped mechanisms rather than copying the host token into a persistent VM.

## Persistent VM setup target

When Stage 8 lands, setup/reconfiguration follows discover-before-prompt and treats execution profiles as the VM provisioning unit.

### Windows host discovery

Discover where safe:

- Hyper-V feature/provider availability;
- management privilege/readiness;
- DevBridge-owned base image inventory;
- execution-profile VM/differencing-disk state;
- legacy repository-owned VM state as migration candidates;
- repository workspace-route state;
- provider networking and bridge readiness;
- approved/available Windows source-media options without treating discovery as license authority;
- configured activation-authority status without exposing secret material;
- configured image recovery/distribution policy;
- installed image-construction utilities and free-space requirements.

### Linux host discovery

Discover where safe:

- KVM acceleration availability/usability;
- QEMU/libvirt installation/service/provider readiness;
- access to the selected libvirt system provider (normally `qemu:///system` when local policy uses it);
- DevBridge-owned base image/qcow2 overlay inventory;
- execution-profile domain/storage state;
- legacy repository-owned domain/overlay state as migration candidates;
- repository workspace-route state;
- libvirt network and bridge readiness;
- approved/available OS image source and artifact-recovery state;
- installed image-construction/conversion utilities and free-space requirements.

### Common guided flow

1. discover host/provider/GitHub/account/repository facts before prompting;
2. ask which execution profiles are actually needed now; do not ask Windows media/license questions for Linux-only setup;
3. propose approved repositories and compatible/preferred execution profiles independently;
4. group selected repositories by compatible execution profile and show the physical profile environments actually required;
5. propose provider prerequisites and exact local changes, including elevation/reboot/package/service/group/session requirements;
6. establish exact approved image construction authority for each required profile;
7. for Windows, separately establish activation method or explicit `configure later` and separately establish whether prepared Windows bytes may be stored in the selected recovery source;
8. when GitHub Releases are selected for image recovery, derive the authenticated owner and propose a private `<authenticated-owner>/devbridge-base-images` source or another authorized repository; verify repository/Release capability before mutation;
9. construct and functionally qualify the canonical image from approved source authority;
10. package remote artifacts only through #178's complete-image zstd -> 1 GiB transport-object contract;
11. redownload/reconstruct/verify remote artifacts through the real acquisition path before accepting them;
12. create the required execution-profile environment from the exact approved image subject;
13. apply/verify Windows activation after materialization through the separate protected activation authority when required;
14. verify provider/image/profile-environment/activation/bridge/workspace-route readiness separately;
15. require explicit operator approval before enabling authority-bearing execution;
16. allow re-entering setup later to add Windows, change source/activation/artifact policy, add/remove repositories, change profiles/resources, or repair/reset/reseed environments/workspaces.

Selecting `all` repositories means approve/register all selected repository workspaces. It does **not** mean create/start one VM per repository. Setup must report repository/workspace counts separately from physical execution-profile VM counts.

Do not blindly prompt for repository names, local paths, provider object names, provider details, or GitHub usernames that can be safely discovered and verified. Do not auto-enable discovered capabilities merely because they exist.

VM/profile readiness failure must degrade/fail closed; setup never recreates the removed host repository-execution path. Resource admission failures must be reported as profile-level resource problems rather than as repository failures.

## Windows media, distribution, and activation are separate

A Windows base image must be generalized and contain no user's activation secret. Image identity is derived from the canonical image/profile/generation, not from a product key or activation method.

Setup treats these independently:

- **source/construction authority** — the approved official Microsoft source media and deterministic recipe;
- **distribution authority** — whether/where prepared Windows bytes may be stored;
- **activation authority** — retail/MAK/KMS/AD/subscription/configure-later policy applied to the materialized VM;
- **environment declaration** — exact Windows image/profile/bootstrap/resource selection.

Never infer that the host's OEM/digital activation is reusable in a VM. Never serialize a product key/MAK secret into normal config, Git/GitHub, logs, status, evidence, exported templates, or a generalized image.

Private artifact hosting is not proof of Microsoft redistribution rights. If the selected source/license permits prepared-image storage, the exact generalized image may use #178 remote-artifact recovery. If not, durable setup authority must preserve an exact local-reconstruction path from approved Microsoft source media/recipe so the same expected canonical image can be rebuilt, verified, and admitted without guessing another generation.

Windows Evaluation media is an explicit temporary evaluation path only; it is not silently substituted for a durable production image.

## Provider-owned versus operator-owned infrastructure

DevBridge setup must distinguish its own VM artifacts from shared operator infrastructure.

Windows uninstall/repair must not casually disable Hyper-V or delete operator-owned virtual switches/VMs/disks.

Linux uninstall/repair must not casually remove KVM/QEMU/libvirt packages, stop shared libvirt infrastructure, delete operator-owned domains/storage pools/networks/images, or rewrite system virtualization policy when a DevBridge-owned object suffices.

Legacy repository-owned DevBridge VMs are retained as migration candidates until their replacement workspace is proven or the operator explicitly authorizes retirement. Multiple old writable VM disks must not be blindly merged into one shared profile disk.

Remote image repositories/releases and operator Windows licensing authority are also operator-owned state. Uninstall must not delete remote artifacts or revoke/remove licensing infrastructure by default.

## Runtime updates

Stage 0 establishes only the fixed managed checkout needed to reach the secure supervisor.

DB-011 owns update policy, signed production release subjects, exact runtime artifact identity, candidate validation, daemon drain, activation health, and rollback.

Stage 1 removed the former host candidate execution path. Stage 6 restores candidate preflight/tests through one locally admitted VM validation route while release identity/last-known-good/rollback remain intact. Route or environment absence fails closed before activation.

VM validation attaches through:

- Hyper-V on Windows;
- KVM/QEMU/libvirt on Linux.

## Operator control

Canonical commands include:

```text
devbridge doctor
devbridge poll-once
devbridge run-once
devbridge daemon
devbridge status
devbridge pause
devbridge resume
devbridge stop
devbridge restart
devbridge handoff-status
devbridge handoff-seed
devbridge handoff-project
```

`pause` is cooperative task-admission pause at a safe cycle boundary, not an unsafe process/VM freeze. `stop` takes precedence.

Future VM lifecycle commands/setup surfaces preserve persistent profile VM state and unrelated repository workspace state unless an exact reset/reseed/delete action is authorized for that profile or workspace.

## Troubleshooting principle

`doctor` reports observed capabilities, not aspirations.

- Pre-Stage-1 historical main: Bubblewrap verification existed for supported Linux repository execution and Windows failed closed.
- Stage 1 through Stage 5 history: repository execution was unavailable/no-provider while trusted control-plane functions could remain usable.
- VM transition: do not interpret partial Hyper-V, KVM, libvirt, image, VM/domain, profile, workspace-route, bridge, source-media, artifact-recovery, or Windows-activation state as completed DB-020 support.
- After Stage 7/8/#192: expect exact provider/image/source/profile-environment/activation/workspace/bridge readiness evidence and no host fallback.

See `docs/execution-profile-environments.md` for VM/workspace ownership, `docs/fresh-host-image-provisioning.md` for blank-slate image/licensing setup, `docs/image-artifact-recovery.md` for immutable artifact recovery, `docs/roadmap.md` for staging, `docs/vm-lego-studs.md` for replaceability, and `docs/vm-migration.md` for removal/retention details.
