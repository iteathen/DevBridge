# DevBridge

**Safely bridge remote coding controllers and agents to a locally controlled development environment.**

DevBridge is a local Node.js control plane. Remote content may request development work, but DevBridge retains machine authority: provenance, capability policy, repository/environment state, execution admission, verification, leases/fencing, publication, runtime activation, and recovery remain locally controlled.

## Current implementation and VM direction

Current mainline includes:

- exact trusted GitHub task/feedback/decision provenance;
- managed authoritative Git repositories/worktrees;
- deterministic controller plans and locally registered operations;
- optional coding-model adapters, disabled by default;
- verified Linux/Bubblewrap containment for the current supported untrusted-execution path;
- durable run state, bounded handoffs, restart recovery, and reconciliation;
- checkpoint-and-proceed human gates;
- candidate sealing and exact-head task-branch publication;
- persistent installation identity, signed multi-agent leases, TTL recovery, and fencing;
- baseline-drift reconciliation/reverification;
- supervised self-update with candidate isolation and rollback;
- cooperative pause/resume and below-normal child-process priority;
- effective serialized task admission.

Repository execution is now moving to DB-020's VM architecture.

**Target host providers:**

- Windows -> Hyper-V;
- Linux -> KVM/QEMU managed through libvirt.

Each approved repository receives a persistent VM environment for each enabled guest OS/profile. The guest is untrusted even at administrator/root, normally has network access, and receives no host control secrets, authoritative Git state, arbitrary writable host mounts, or provider-management authority.

Base images are immutable/versioned. Repository state uses provider-native copy-on-write storage where supported:

- Hyper-V differencing VHD/VHDX;
- QEMU qcow2 backing/overlay chains.

The legacy Bubblewrap/AppContainer/ProcessContainer direction is transitional only. Full removal is blocked until Hyper-V and KVM/libvirt replacement paths are implemented, qualified, and installable, so Linux support is not lost during migration.

See DB-020, `docs/architecture.md`, `docs/roadmap.md`, and `docs/vm-migration.md`.

## Security model

**Remote content requests work; it does not create machine authority.**

Remote task text, repository content, dependencies, model output, tool documentation, guest output, and process output cannot grant:

- host executable/shell authority;
- arbitrary host paths or mounts;
- environment secrets or credentials;
- VM/provider-management authority;
- trusted task/peer identities;
- Git publication/ref authority;
- human decision authority.

`github.trustedActorIds` is a runner-local remote development-job submission allowlist, not a generic collaborator list. Task-author trust, decision authority, coordination-peer trust, repository authorization, VM-management authority, and publication authority remain distinct local policies.

Under DB-020, repository guests have normal network access by default. Confidentiality therefore comes from **keeping host secrets out of the guest**, not from assuming guest network denial will protect them.

## Install

Requirements today:

- Node.js 22.16.0 or newer;
- Git;
- GitHub account/access needed by the configured queue/repositories;
- Bubblewrap only for the current transitional Linux untrusted-execution path.

### Linux

```sh
mkdir -p "$HOME/.devbridge/bin" && curl -fsSL https://raw.githubusercontent.com/iteathen/DevBridge/main/devbridge.mjs -o "$HOME/.devbridge/bin/devbridge.mjs" && node "$HOME/.devbridge/bin/devbridge.mjs"
```

### Windows PowerShell

```powershell
New-Item -ItemType Directory -Force "$HOME\.devbridge\bin" | Out-Null; Invoke-WebRequest "https://raw.githubusercontent.com/iteathen/DevBridge/main/devbridge.mjs" -OutFile "$HOME\.devbridge\bin\devbridge.mjs"; node "$HOME\.devbridge\bin\devbridge.mjs"
```

`devbridge.mjs` is a standalone stage-0 launcher. It establishes/validates the fixed managed DevBridge runtime and transfers control to secure bootstrap. It does not silently enable execution or provision a VM provider.

On a fresh install, the managed bootstrap creates `~/.devbridge/config.json` from the safe example and exits. Review local authority first, then run:

```text
node ~/.devbridge/bin/devbridge.mjs doctor
node ~/.devbridge/bin/devbridge.mjs
```

PowerShell users can use `$HOME\.devbridge\bin\devbridge.mjs`.

See `docs/setup.md` for current-vs-target setup details.

## Future VM setup

VM Stage 8 will add discover-first provider setup/reconfiguration.

Windows setup will inspect Hyper-V readiness before prompting.

Linux setup will inspect KVM acceleration, QEMU/libvirt service/provider access, image/storage/network state, and normally the locally authorized libvirt system provider before prompting.

Neither `Hyper-V installed` nor `/dev/kvm exists` is enough to claim repository execution ready.

Setup will propose repositories/guest profiles/image generations/resource/storage policy and require explicit operator consent before authority-bearing changes.

## Self-update

Stage 0 establishes only the managed checkout needed to reach secure bootstrap. DB-011 owns update/release policy, exact artifact identity, candidate validation, daemon drain, activation, health, and rollback.

Current main validates candidate-controlled code through the transitional host sandbox. DB-020 targets provider-native VM validation:

- Hyper-V on Windows;
- KVM/QEMU/libvirt on Linux.

Production mode requires a locally trusted Ed25519-signed immutable release subject binding repository, exact Git head, package version, and runtime artifact SHA-256.

## CLI

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

`pause` is cooperative admission control. It does not suspend an active child/VM or bypass lease heartbeat/fencing. `stop` takes precedence.

## Task protocol

DevBridge task envelopes use the DevBridge namespace:

````markdown
```devbridge-task
{
  "protocol": "devbridge/task-v1",
  "target": { "repository": "iteathen/example" },
  "instructions": "Implement the requested change, follow project specs, build, and test.",
  "requestedCapabilities": ["project.write", "process.execute"]
}
```
````

A task names repository intent, not a local path, VM/domain name, image path, hypervisor command, executable, environment secret, or publication ref.

## Configuration

The canonical checked-in example is:

```text
config/devbridge.example.json
```

Fresh configuration keeps execution, model adapters, coordination, dynamic tool onboarding, and automatic task-branch publication conservative/off by default.

Current host-sandbox-era fields such as `workspace.externalReadRoots`, `execution.allowUncontainedTools`, and profile `sandbox.*` remain transitional. VM Stage 8/9 owns deliberate migration/deprecation; they must not be silently reinterpreted as VM authority.

DevBridge never silently rewrites existing operator configuration during self-update.

## Multi-agent coordination

Coordination is disabled by default. When enabled, each installation owns a persistent local Ed25519 identity. Signed task leases use exact expected-value Git-ref CAS.

Lease ownership is not task authority, machine capability, human approval, provider-management authority, or publication authority.

## Human checkpoints

DevBridge uses **checkpoint and proceed**, not blanket stop-and-wait. Safe reversible work may continue while a consequential decision is pending. Hard-gated effects remain blocked until an exact still-valid subject is authorized by an actor locally delegated for that class.

Remote decisions cannot expand filesystem, executable, credential, network, provider-management, peer-trust, or other machine capability.

## Current limitations

Important explicit boundaries include:

- VM program #107 is not yet implemented; Hyper-V and KVM/libvirt target providers are architecture/roadmap, not current execution capability;
- per-installation task destination/dispatch authorization for shared team queues;
- complete generic effect journaling for every possible remote mutation;
- numeric GitHub repository-ID pinning and complete tool/profile identity evidence outside the VM Stage-1 work;
- GitHub App installation authentication;
- general parallel task scheduling;
- automatic default-branch merge/release/deployment as ordinary task effects.

## Documentation

- `docs/setup.md` — installation and current-vs-target provider setup.
- `docs/architecture.md` — control-plane/provider/VM/bridge architecture.
- `docs/vm-migration.md` — legacy sandbox removal inventory/hard gates.
- `docs/bootstrap.md` — stage-0/self-update behavior.
- `docs/design-principles.md` — engineering principles.
- `docs/tool-profiles.md` — current profile surface and VM migration.
- `docs/roadmap.md` — staged implementation plan.
- `specs/DB-001` through `DB-020` — live normative contracts.

Checksum-bound handoffs and point-in-time audits remain historical evidence. Their historical bytes are not live compatibility behavior.

## Tests

```text
npm run preflight
npm test
node src/cli.js doctor --config config/devbridge.example.json
```

Current CI runs Ubuntu/Windows control-plane regressions and real Bubblewrap coverage on Linux. Future Stage-7 provider qualification may require dedicated/self-hosted virtualization-capable Windows and Linux runners for real Hyper-V and KVM/libvirt evidence.

## License

AGPL-3.0-only. See `LICENSE`.
