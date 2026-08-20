# DevBridge setup

## Disposable fast-track VM branch

The `codex/temp-fast-functional` branch uses one persistent Ubuntu Hyper-V environment per admitted repository identity through the Stage 6 source/operation/candidate contract. Run `npm run fast:doctor`, `npm run fast:run`, or `npm run fast:daemon` from that branch. The fast configuration explicitly selects the VMs attached to Hyper-V's existing `Default Switch`; it does not silently fall back to the host when a VM is unavailable.

Normal build, test, and repository work is headless. DevBridge keeps the VM running during active use and can resume a saved or paused environment without VMConnect. `scripts/fast-vm/manage-environment.ps1` provides exact-owned-target `Status`, `Save`, and `Resume` actions; `Show` is the explicit diagnostic action that opens a console.

The disposable unattended Ubuntu installer has also been proven end to end without VMConnect: a fresh owned VM installed, powered itself off, booted from disk, and exposed the expected development toolchain and guest services. This is fast-track evidence, not yet the supported Stage 8 install/re-entry interface. Fresh guests generate unique SSH host keys; the production installer still needs an authenticated, environment-bound enrollment channel instead of the probe-only trust-on-first-use shortcut.

Controller-submitted file changes and locally registered deterministic build/test operations are the normal path. The `codex-fast` adapter is available but has no default fallback: it runs only when a remote task explicitly requests it, or after an operator deliberately sets `execution.defaultTool` as a local opt-in.

This branch still contains an intentionally temporary direct-host implementation, but `execution.fastHost` is disabled and configuration rejects enabling it with the VM topology. That implementation and the Default Switch/network/host-key shortcuts are not intended for `main`. See `docs/fast-track-field-notes.md` for exact evidence and the production problems each shortcut exposes.

DevBridge is installed from one standalone stage-0 launcher and then keeps its managed runtime current through the secure supervisor.

## Current implementation versus VM target

DB-020 defines the target repository-execution architecture: a trusted DevBridge controller on the host plus persistent, networked repository VMs.

The required initial host providers are:

- **Windows:** Hyper-V;
- **Linux:** KVM/QEMU managed through libvirt.

Stages 0–6 of that VM path are implemented on the migration stack. Stage 1 removed the old host-sandbox path; Stages 2–5 provide foundation, persistent environments, bridge, and guest preparation; Stage 6 restores routed repository execution.

The migration stack behaves as follows:

- repository-controlled and candidate-controlled execution uses only locally admitted ready persistent VM routes and otherwise remains fail-closed on both Windows and Linux;
- Windows `doctor` can observe the Stage-2 Hyper-V management/image/network/storage foundation;
- Linux `doctor` can observe the Stage-2 KVM/QEMU/libvirt management/image/network/storage foundation;
- provider/image readiness is reported separately from repository-execution readiness;
- Draft PR #106's Windows ProcessContainer/AppContainer work is superseded migration evidence and is not the supported target.

The completed Stages 3–5 interval kept execution unavailable. Stage 6 restores it through persistent VMs only. Do not introduce direct/uncontained host execution as compatibility behavior.

Stage 2 does not add installer mutation UX. Do not manually configure provider objects and assume DevBridge owns them merely because `doctor` can observe the host. VM Stage 8 (#116), coordinated with setup/reconfiguration issue #103, owns supported discovery/provisioning/re-entry after the lower VM stages are implemented and qualified.

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

- `github.queueRepositories`
- `github.repositoryDiscovery`
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

Stage 6 VM-backed execution requires observed provider + image + repository environment + bridge readiness plus a local stable-identity route, even if `execution.enabled` is configured. If any are missing, execution remains unavailable; it never redirects to direct host execution.

## GitHub authentication

GitHub credentials are host control-plane authority under DB-003/DB-008.

DevBridge may use configured environment-variable providers or the current GitHub CLI credential for the configured hostname. Token values are not serialized into config/status/run state and are not forwarded to repository execution.

Under DB-020 repository guests normally have network access, so host GitHub/SSH/publication credentials must remain absent from the guest. Private dependency/coding-service support requires explicit later scoped mechanisms rather than copying the host token into a persistent VM.

## Multiple repository queues

`github.queueRepositories` is the explicit local queue allowlist. DevBridge polls each selected queue through its own isolated runtime and state namespace while sharing one serialized GitHub client/rate budget. Effective task execution remains one task at a time. Issue numbers are always reported with their queue repository so identically numbered issues cannot collide.

Authenticated discovery is separate local policy:

```json
{
  "github": {
    "queueRepositories": ["owner/control", "owner/project"],
    "repositoryDiscovery": {
      "enabled": false,
      "affiliations": ["owner", "collaborator", "organization_member"],
      "maxRepositories": 30
    }
  }
}
```

When explicitly enabled, discovery uses GitHub's authenticated-user repository endpoint with conditional requests, a local owner allowlist, a hard result bound, and filters for active repositories with issues enabled. Configured repositories remain selected even when discovery has no matching result. The response reports when GitHub pagination indicates that the configured bound truncated discovery. See GitHub's [authenticated repository endpoint](https://docs.github.com/en/rest/repos/repos#list-repositories-for-the-authenticated-user) and [REST API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).

Token access is observation, not execution authority. Discovery never adds trusted task actors, enables execution, creates a VM, adopts a provider object, grants publication, or supplies guest credentials. Each newly selected repository still needs a host-observed immutable repository ID and an independently admitted persistent-environment route; otherwise repository execution fails closed for that queue while other queues can continue polling. Shared GitHub rate-limit exhaustion stops the whole repository set so one installation cannot evade its account-wide budget by adding queues.

## Persistent VM setup target

When Stage 8 lands, setup/reconfiguration follows discover-before-prompt.

### Windows host discovery

Discover where safe:

- Hyper-V feature/provider availability;
- management privilege/readiness;
- DevBridge-owned base image inventory;
- repository VM/differencing-disk state;
- provider networking and bridge readiness.

### Linux host discovery

Discover where safe:

- KVM acceleration availability/usability;
- QEMU/libvirt installation/service/provider readiness;
- access to the selected libvirt system provider (normally `qemu:///system` when local policy uses it);
- DevBridge-owned base image/qcow2 overlay inventory;
- libvirt domain/storage/network and bridge readiness.

### Common guided flow

1. discover provider/account/repository facts before prompting;
2. propose approved repositories and guest OS profiles;
3. propose image generations and provider-native storage implications;
4. show required host changes such as elevation/reboot or Linux package/service/group/session actions;
5. require explicit operator approval before provisioning/enabling authority-bearing changes;
6. verify provider/image/environment/bridge readiness;
7. allow re-entering setup later to add/remove/change repositories, guest profiles, images, resource policy, or repair/reset/reseed environments.

Do not blindly prompt for repository names, local paths, provider object names, or provider details that can be safely discovered and verified. Do not auto-enable discovered capabilities merely because they exist.

VM readiness failure must degrade/fail closed; setup never recreates the removed host repository-execution path.

## Provider-owned versus operator-owned infrastructure

DevBridge setup must distinguish its own VM artifacts from shared operator infrastructure.

Windows uninstall/repair must not casually disable Hyper-V or delete operator-owned virtual switches/VMs/disks.

Linux uninstall/repair must not casually remove KVM/QEMU/libvirt packages, stop shared libvirt infrastructure, delete operator-owned domains/storage pools/networks/images, or rewrite system virtualization policy when a DevBridge-owned object suffices.

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

Future VM lifecycle commands/setup surfaces preserve persistent repository disk state unless an explicit reset/reseed/delete action is authorized.

## Troubleshooting principle

`doctor` reports observed capabilities, not aspirations.

- Pre-Stage-1 current main: expect Bubblewrap verification for supported Linux repository execution and fail-closed Windows repository execution.
- Stage 1 through Stage 5: expect repository execution unavailable/no-provider while trusted control-plane functions may remain usable.
- VM transition: do not interpret partial Hyper-V, KVM, libvirt, image, VM/domain, or bridge state as completed DB-020 support.
- After Stage 7/8: expect exact provider/image/writable-layer/environment/bridge readiness evidence and no host fallback.

See `docs/roadmap.md` for staging, `docs/vm-lego-studs.md` for replaceability, and `docs/vm-migration.md` for removal/retention details.
