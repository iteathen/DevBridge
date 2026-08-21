# DevBridge

**Safely bridge remote coding controllers and agents to a locally controlled development environment.**

DevBridge is a local Node.js control plane. Remote content may request development work, but DevBridge retains machine authority: provenance, capability policy, repository/environment state, execution admission, verification, leases/fencing, publication, runtime activation, and recovery remain locally controlled.

## What DevBridge does

DevBridge coordinates development work without giving remote task text, repository code, or coding models direct authority over the workstation.

The preferred flow is:

```text
remote request / controller
        |
        v
trusted DevBridge host control plane
        |
        +-- provenance / policy / authoritative Git / leases / verification / publication
        |
        v
execution-profile router
        |
        v
persistent untrusted VM
        |
        v
repository workspace
```

Current main includes:

- exact trusted GitHub task/feedback/decision provenance;
- managed authoritative Git repositories/worktrees;
- deterministic controller plans and locally registered operations;
- optional coding-model adapters, disabled by default in reference configuration;
- persistent Hyper-V and KVM/libvirt repository-execution environments behind provider-neutral contracts;
- execution-profile-owned physical VMs with repository-owned workspaces inside compatible profiles;
- durable run state, bounded handoffs, restart recovery, and reconciliation;
- checkpoint-and-proceed human gates;
- candidate sealing and exact-head task-branch publication;
- persistent installation identity and signed multi-agent leases/fencing;
- baseline-drift reconciliation/reverification;
- supervised self-update with candidate isolation and rollback;
- Stage-0/runtime compatibility detection and bounded legacy recovery;
- cooperative pause/resume and process-priority governance;
- cost-aware verification policy and long-running liveness evidence.

## Current execution architecture

Repository-controlled execution is **VM-only**.

Initial required host provider families are:

- **Windows:** Hyper-V;
- **Linux:** KVM/QEMU managed through libvirt.

The active ownership rule is:

> **Execution profiles own persistent VMs. Repositories own isolated workspaces inside compatible execution-profile VMs.**

Therefore repository count does not determine physical VM count. Several repositories can use separate workspaces inside one compatible profile VM.

A profile represents a materially different execution platform such as OS, driver/device, architecture, or other real compatibility/isolation requirement. Do not create profiles merely because repositories differ.

The guest is untrusted even at administrator/root and normally has network access. Host GitHub credentials, publication authority, coordination private keys, runtime-control state, provider management, signing authority, and authoritative Git remain outside the guest.

If the required profile/environment/bridge/workspace route is unavailable, repository execution fails closed. There is no direct-host or legacy host-sandbox fallback.

See [`docs/architecture.md`](docs/architecture.md), [`docs/execution-profile-environments.md`](docs/execution-profile-environments.md), and DB-020.

## Installation identity versus runtime version

A workstation may run more than one DevBridge installation—for example:

- one persistent project bridge;
- one or more disposable test/qualification installations.

Protocol-1 Stage 0 exposes a stable path-free installation tag:

```text
DB-<12 uppercase hex digits>
```

The installation tag answers **which local installation is this?** It is not a version number.

- one persistent installation keeps the same tag across runtime updates;
- another installation home receives another tag;
- two processes with the same tag belong to the same installation ownership domain;
- the exact accepted runtime Git head is separate evidence.

For runtime/update diagnosis, keep these identities separate:

- installation tag;
- Stage-0 protocol;
- accepted runtime exact head/version;
- activation state;
- supervisor/daemon generation;
- execution-profile/environment identity;
- repository workspace identity;
- task/run identity.

See [`docs/operations.md`](docs/operations.md) and [`docs/bootstrap-compatibility.md`](docs/bootstrap-compatibility.md).

## Security model

**Remote content requests work; it does not create machine authority.**

Remote task text, repository content, dependencies, model output, tool documentation, guest output, and process output cannot grant:

- host executable/shell authority;
- arbitrary host paths or mounts;
- environment secrets or credentials;
- VM/provider-management authority;
- trusted task/peer identities;
- Git publication/ref authority;
- human decision authority;
- runtime-update/recovery authority.

`github.trustedActorIds` is a runner-local development-job submission allowlist, not a generic collaborator list.

Guest networking is not the primary confidentiality boundary. Confidentiality comes from keeping host secrets and control authority out of the guest.

No production repository-execution provider means repository-controlled execution is unavailable; it never means “run it directly on the host.”

## Install

Current requirements:

- Node.js 22.16.0 or newer;
- Git;
- GitHub account/access required by the configured task queue/repositories;
- an admitted/ready VM execution route for repository-controlled work.

### Linux

```sh
mkdir -p "$HOME/.devbridge/bin" \
  && curl -fsSL https://raw.githubusercontent.com/iteathen/DevBridge/main/devbridge.mjs \
     -o "$HOME/.devbridge/bin/devbridge.mjs" \
  && node "$HOME/.devbridge/bin/devbridge.mjs"
```

### Windows PowerShell

```powershell
New-Item -ItemType Directory -Force "$HOME\.devbridge\bin" | Out-Null
Invoke-WebRequest "https://raw.githubusercontent.com/iteathen/DevBridge/main/devbridge.mjs" -OutFile "$HOME\.devbridge\bin\devbridge.mjs"
node "$HOME\.devbridge\bin\devbridge.mjs"
```

`devbridge.mjs` is the standalone Stage-0 launcher. It establishes/verifies the fixed managed DevBridge runtime and transfers control to secure bootstrap. It does not silently enable repository execution or provision VM authority.

On a fresh installation, secure bootstrap creates the conservative example configuration and exits. Review local authority before enabling it.

Then run:

```text
node <stage0-launcher> doctor
node <stage0-launcher>
```

See [`docs/setup.md`](docs/setup.md) for setup and reconfiguration behavior.

## Inspect an installation

For a protocol-1 launcher:

```text
node <stage0-launcher> bootstrap-status
```

The bounded final JSON line reports:

- installation tag;
- Stage-0 protocol;
- migration recovery result, if any;
- activation state;
- exact accepted runtime head/version;
- runtime minimum Stage-0 protocol;
- whether the runtime is a pre-protocol legacy runtime.

It intentionally does not expose credentials, installation paths, owner tokens, provider internals, or guest topology.

Use `doctor` for observed capability/readiness state:

```text
node <stage0-launcher> doctor
```

`doctor` reports evidence; it does not grant capabilities.

## Runtime updates and recovery

Stage 0 is intentionally small. DB-011 secure supervision owns ordinary update/release policy, candidate validation, daemon drain, activation health, and rollback.

Ordinary update conceptually keeps the accepted runtime live while it:

1. resolves/materializes an exact candidate separately;
2. performs static/integrity/compatibility checks;
3. validates candidate-controlled code inside the admitted VM execution boundary;
4. drains the accepted daemon only after validation;
5. activates the exact validated candidate;
6. performs health-window and `doctor` checks;
7. records `healthy` only after those checks;
8. preserves/restores last-known-good on failure.

A runtime may declare a minimum Stage-0 compatibility protocol. If the installed launcher is too old, it fails closed and requires a launcher refresh rather than executing incompatible candidate code.

Pre-protocol development/testing installations may require one explicit local compatibility migration after the replacement exact head has already been independently validated. Production recovery remains on the signed immutable release path.

See [`docs/bootstrap.md`](docs/bootstrap.md) and [`docs/bootstrap-compatibility.md`](docs/bootstrap-compatibility.md).

## Operator controls

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

`pause` is cooperative admission control at a safe cycle boundary. It is not process/thread/VM suspension. `stop` takes precedence.

Do not work around singleton-owner failures by starting another supervisor for the same installation home/tag.

See [`docs/operations.md`](docs/operations.md) for the operator runbook.

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

A task names repository intent. It does not grant a local path, VM/domain name, image path, hypervisor command, executable, environment secret, publication ref, or recovery policy.

Deterministic controller plans are data, not a remote shell language. They may reference locally registered operations and bounded repository-relative proposals; executable identity and machine authority stay local.

## Configuration

The canonical checked-in example is:

```text
config/devbridge.example.json
```

Fresh configuration keeps execution, model adapters, coordination, dynamic tool onboarding, and automatic task-branch publication conservative/off by default.

Existing operator configuration is never silently rewritten during self-update.

Important authority areas include:

- `github.queueRepository` and `github.trustedActorIds`;
- `workspace.allowedOwners` and baseline channels;
- `execution.*` and decision authorities;
- coordination/peer trust;
- publication policy;
- local VM/profile/tool configuration.

Historical host-sandbox fields must never be reinterpreted as direct-host repository-execution authority.

## Multi-agent coordination

Coordination is disabled by default. When enabled, each installation owns a persistent local Ed25519 identity. Signed task leases use exact expected-value Git-ref CAS and fencing.

Lease ownership is not task authority, machine capability, human approval, provider-management authority, or publication authority.

## Human checkpoints

DevBridge uses **checkpoint and proceed**, not blanket stop-and-wait.

Safe reversible work may continue while a consequential decision is pending. Hard-gated effects remain blocked until an exact still-valid subject is authorized by an actor locally delegated for that decision class.

Remote decisions cannot expand filesystem, executable, credential, network, provider-management, peer-trust, or other machine capability.

## Verification

Verification is cost-aware and evidence-bound.

- cheap high-signal checks run before expensive suites where dependency order permits;
- long-running tests are allowed when their operation-specific bounded policy permits them;
- exact still-valid expensive evidence should be reused rather than rerun after every restart/context change;
- VM/security/provider claims require the appropriate real-provider evidence and are not replaced by mocks merely because hosted CI lacks a hypervisor.

See DB-019.

## Current project checkpoint

The VM-only execution pivot is implemented through Stage 6. Current roadmap work focuses on:

- Stage 7 real-provider/security/recovery/resource qualification;
- Stage 8 discover-first setup/reconfiguration;
- final cleanup of superseded migration/topology documentation and compatibility after qualification.

The active persistent-VM topology is execution-profile-owned, not repository-owned.

See [`docs/roadmap.md`](docs/roadmap.md).

## Troubleshooting

Start with:

```text
node <stage0-launcher> bootstrap-status
node <stage0-launcher> doctor
```

Then classify the failure by owning boundary rather than repeatedly restarting or changing unrelated settings.

[`docs/troubleshooting.md`](docs/troubleshooting.md) covers common cases including:

- stale installed runtime versus current task baseline;
- Stage-0 protocol mismatch;
- incomplete activation/migration recovery;
- missing model result artifacts;
- VM-route absence;
- Hyper-V/KVM resource failures;
- slow candidate validation;
- competing supervisor/restart failures;
- guest network/security interpretation;
- publication/reconciliation failures.

## Documentation

Start at [`docs/README.md`](docs/README.md).

Core guides:

- [`docs/setup.md`](docs/setup.md) — install/configuration and discover-first setup.
- [`docs/operations.md`](docs/operations.md) — installed-runtime/operator runbook.
- [`docs/troubleshooting.md`](docs/troubleshooting.md) — symptom-to-boundary diagnosis.
- [`docs/architecture.md`](docs/architecture.md) — control-plane/provider/VM/bridge architecture.
- [`docs/execution-profile-environments.md`](docs/execution-profile-environments.md) — profile VM/workspace ownership.
- [`docs/bootstrap.md`](docs/bootstrap.md) — Stage-0/self-update behavior.
- [`docs/bootstrap-compatibility.md`](docs/bootstrap-compatibility.md) — installation tags and compatibility recovery.
- [`docs/design-principles.md`](docs/design-principles.md) — engineering principles.
- [`docs/tool-profiles.md`](docs/tool-profiles.md) — profile/tool surface.
- [`docs/roadmap.md`](docs/roadmap.md) — implementation/qualification checkpoint.
- `specs/DB-001` through `DB-020` — live normative contracts.

Migration-stage files, handoffs, audits, and point-in-time test records remain valuable evidence but are not automatically current product authority. The docs index explains how to interpret them.

## Development checks

```text
npm run preflight
npm test
node src/cli.js doctor --config config/devbridge.example.json
```

Hosted Windows/Linux CI provides broad architecture/regression evidence. Real Hyper-V/KVM claims require appropriate virtualization-capable qualification under the roadmap/specs.

## License

AGPL-3.0-only. See `LICENSE`.
