# DevBridge

**Bridge remote coding controllers to a locally controlled development environment without turning remote text into workstation authority.**

[![CI](https://github.com/iteathen/DevBridge/actions/workflows/ci.yml/badge.svg)](https://github.com/iteathen/DevBridge/actions/workflows/ci.yml)
[![License: AGPL-3.0-only](https://img.shields.io/badge/License-AGPL--3.0--only-blue.svg)](LICENSE)

DevBridge is a local Node.js control plane for provenance, capability policy, repository/environment state, execution admission, verification, publication, recovery, and coordination around coding work.

## Current reality

| Area | Status |
| --- | --- |
| Release | **No published package or signed production release** |
| Hosted regression CI | Windows and Linux |
| Repository-controlled execution | VM-only architecture; Hyper-V and KVM/libvirt provider paths are implemented behind provider-neutral contracts |
| Real-provider security/resource/recovery qualification | **Incomplete**; hosted CI is not a substitute for the required real-provider evidence |
| Multi-agent leases/fencing | Implemented |
| Destination-workstation cryptographic addressing | **Not implemented**; lease identity is not sender-to-specific-workstation authorization |
| Production deployment claim | **No** |

DevBridge contains substantial executable control-plane code. It is still in active public alpha development and should be evaluated at an exact reviewed commit, not treated as a production security product because its architecture is documented or hosted CI is green.

## Verify what exists

Requirements: Node.js 22.16.0 or newer and Git.

```bash
npm run preflight
npm test
node src/cli.js doctor --config config/devbridge.example.json
```

`doctor` observes configured capability/readiness state; it does not grant authority. Real Hyper-V/KVM claims require their own exact provider/environment qualification.

For setup and reconfiguration, see [`docs/setup.md`](docs/setup.md). For current work selection and evidence limits, see [`docs/portfolio-readiness.md`](docs/portfolio-readiness.md).

## Security status

### Enforced by current control-plane contracts and regression tests

Remote task text, repository content, model output, dependency output, and guest output do not themselves grant:

- arbitrary host shell/executable authority;
- arbitrary host paths or mounts;
- credentials or environment secrets;
- provider-management authority;
- Git publication/ref authority;
- trusted task/peer identities;
- human-decision or runtime-update authority.

Authoritative Git and control-plane authority remain host-owned. Repository execution fails closed when the required VM route is unavailable; there is no direct-host repository-execution fallback.

### Implemented but not fully real-provider-qualified

DevBridge implements persistent Hyper-V and KVM/libvirt execution-profile environments, guest bridges, recovery/lifecycle behavior, and related provider-neutral control contracts. Real-provider security, storage-lineage, recovery, and resource claims remain bounded by the exact physical qualification that has actually run.

### Known missing or incomplete

- Task envelopes are not cryptographically addressed to a destination installation. Signed lease identity/fencing does **not** solve developer-to-specific-workstation dispatch authorization. Use runner-local queue/task-author policy where workstation isolation matters.
- There is no signed public production release channel.
- Blank-slate installation and real-provider qualification remain active readiness work.
- Broad credential-bearing, multi-workstation, multi-user, elevated, or publication-capable deployment requires an independent security review in addition to internal tests and provider qualification.

These limits are part of the security claim, not footnotes to it.

## Execution architecture

Repository-controlled execution is VM-only:

```text
remote request / controller
        |
        v
DevBridge host control plane
 provenance / policy / authoritative Git
 verification / leases / publication / recovery
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

Initial provider families are:

- **Windows:** Hyper-V;
- **Linux:** KVM/QEMU through libvirt.

Execution profiles own persistent VMs; repositories own isolated workspaces inside compatible profiles. The guest is treated as untrusted even with administrator/root access and normally may have network access. Host credentials, provider-management authority, signing authority, coordination private keys, and authoritative Git remain outside the guest.

See [`docs/architecture.md`](docs/architecture.md), [`docs/execution-profile-environments.md`](docs/execution-profile-environments.md), and the normative `specs/DB-*` contracts for detailed design.

## What is implemented

Current main includes, among other bounded capabilities:

- trusted GitHub task/feedback/decision provenance;
- managed authoritative Git repositories/worktrees;
- deterministic controller plans and locally registered operations;
- optional coding-model adapters, disabled by default in reference configuration;
- VM execution-profile routing for Hyper-V and KVM/libvirt;
- durable run state, bounded handoffs, restart recovery, and reconciliation;
- checkpoint/decision handling;
- candidate sealing and exact-head task-branch publication;
- installation identity and signed multi-agent leases/fencing;
- baseline-drift reconciliation/reverification;
- supervised self-update with candidate isolation and rollback;
- cooperative pause/resume and process-priority governance;
- cost-aware verification and bounded liveness evidence.

The detailed implementation inventory belongs in current specs/status rather than an ever-growing README capability defense.

## Evaluation setup

DevBridge is not published to npm. Evaluate a reviewed commit:

```text
git clone https://github.com/iteathen/DevBridge.git
cd DevBridge
git checkout <reviewed-commit-sha>
npm run preflight
npm test
```

The standalone `devbridge.mjs` Stage-0 launcher bootstraps the managed runtime. It does not silently enable repository execution or create VM/provider authority. Review local configuration and [`docs/setup.md`](docs/setup.md) before running real work.

## Development rule

Security/correctness and authority isolation outrank scaling. A missing physical host/provider/CI qualification environment is an evidence gap unless implementation is independently falsified.

New coordination, compatibility, migration, or concurrency machinery must name a current beneficiary: a real deployment/persisted-state constraint, security or recovery boundary, active consumer, or measured bottleneck. Future possibility alone is not enough.

Once a security/lifecycle boundary is sufficiently specified, prefer the thinnest meaningful executable proof through the production control-plane/provider contracts over more speculative architecture.

## Contributing and security reports

Read [`AGENTS.md`](AGENTS.md), [`CONTRIBUTING.md`](CONTRIBUTING.md), [`docs/design-principles.md`](docs/design-principles.md), and [`docs/portfolio-readiness.md`](docs/portfolio-readiness.md) before changing behavior.

Report vulnerabilities privately according to [`SECURITY.md`](SECURITY.md); do not publish exploit details, secrets, or sensitive evidence in issues.

DevBridge is licensed under [AGPL-3.0-only](LICENSE).
