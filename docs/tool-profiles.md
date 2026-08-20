# Local tool profiles

DevBridge does not hard-code one coding CLI. Local configuration may define proposal/model profiles; GitHub task text may select only a profile name that already exists in local policy.

A profile is **local requested behavior**, not proof that containment or a usable repository environment exists.

DB-020 changes the target execution model: repository-controlled tools execute inside persistent repository VMs. The required initial host providers are Windows/Hyper-V and Linux/KVM-QEMU-libvirt.

Current main still uses the legacy Linux/Bubblewrap host sandbox for supported proposal-worker/repository-code execution. The host-sandbox fields below are therefore transitional compatibility, not the target architecture.

Deterministic DB-013 operations remain the preferred path where model inference is unnecessary. DB-015 dynamic `tool.*` onboarding remains a separate validated local-operation mechanism.

## Current transitional profile fields

Current proposal-worker profiles may contain:

- `executable`
- `args`
- `inputMode`
- `timeoutMs`
- `maxOutputBytes`
- `environment.pass`
- `environment.set`
- `sandbox.enforcement`
- `sandbox.outsideProjectRead`
- `sandbox.outsideProjectWrite`
- `sandbox.network`.

Today these fields drive the host process-runner/Bubblewrap implementation where supported.

Do not design new long-term repository-execution features around `outsideProjectRead`, host `externalReadRoots`, host sandbox network modes, or host executable projection. Stage 8/9 will migrate/deprecate obsolete fields after VM-backed execution exists.

## Target VM-backed profile model

A repository-execution profile should ultimately describe logical intent/capability, while DevBridge resolves it inside the exact repository environment.

Useful target concepts include:

- logical profile/tool name;
- required guest OS/profile or compatible set;
- bounded structured arguments/placeholders;
- input/result protocol;
- timeout/output/liveness policy;
- whether model/network service access is required;
- required guest tool capability/version class;
- provider/environment readiness requirements;
- local credential policy, if any authenticated service is intentionally supported.

It should **not** expose to remote/controller content:

- host executable paths;
- host PATH/tool roots;
- host filesystem read roots;
- Hyper-V VM names/VHDX paths/PowerShell management args;
- libvirt domain/storage/network names as raw authority;
- qcow2 paths/QEMU argv/libvirt XML;
- bridge socket paths/transport parameters;
- host credentials or environment values.

The selected host provider and exact repository environment are control-plane state.

## Host versus guest executable identity

Under DB-020, repository tools live in the guest trust domain.

Examples:

- Node/CMake/CTest/compiler/package-manager/coding CLI used for repository work -> guest tool.
- Git/Node/provider tooling used by DevBridge's trusted host control plane -> host tool.
- Hyper-V management tools -> host-only on Windows.
- KVM/QEMU/libvirt management tools -> host-only on Linux.

A guest executable path may be useful internal bridge data, but it is not host authority and should normally be derived by the guest bootstrap/tool resolver rather than supplied by remote task text.

## Allowed structured placeholders

Controller/profile placeholders remain structural, not free-form command injection.

Current host-runner placeholders include:

- `{projectDir}`
- `{contextFile}`
- `{resultFile}`
- `{runId}`.

The VM bridge may replace host-path-valued placeholders with logical guest path classes/opaque endpoints. Do not preserve a placeholder merely to expose a host path into the guest.

Free-form instructions never become argv, shell text, provider management arguments, or bridge transport configuration.

## Shell rule

DevBridge host control processes continue to use `shell: false` unless a separately reviewed local adapter deliberately owns shell semantics.

Inside a guest, a repository tool may itself invoke a guest shell as ordinary untrusted development behavior. That does not grant host shell authority. The host bridge still sends typed locally admitted operations rather than arbitrary remote shell text.

## Current outer isolation boundary

Current main's built-in proposal-worker provider is Bubblewrap on Linux. DevBridge verifies that provider before current host-sandboxed worker execution and fails closed where unavailable.

This is a **current implementation statement only**.

DB-020's target outer boundary is the VM:

- Hyper-V repository VM on Windows host;
- KVM/QEMU/libvirt repository VM on Linux host.

No required Bubblewrap/AppContainer/ProcessContainer layer exists inside that VM.

Stage 9 removes the host sandbox path only after both required host providers are qualified and installable. Linux support must not disappear during that cleanup.

## Networking

Current host profiles expose `sandbox.network` because Bubblewrap implements host-process network policy.

DB-020 guests instead have normal network access by default. This supports package managers, SDK installers, source/documentation access, browser tests, and coding services.

The security consequence is explicit: anything placed in a guest may be exfiltrated. Host secrets therefore stay out of the guest.

A future profile may request an optional offline/restricted guest mode for workload reasons, but network denial is not the foundational security boundary and is not an excuse to inject host credentials.

## Credentials

GitHub control-plane authentication never belongs in a proposal/repository guest.

Do not inject:

- DevBridge GitHub tokens;
- host SSH agent/private keys;
- coordination private keys;
- release/signing keys;
- daemon-control state;
- provider-management credentials/capability.

A coding/model/package service may require authentication. Stage 6 must define any supported credential relay/scoped token topology explicitly. A broad host credential must not simply be copied into a persistent networked guest.

Any credential intentionally placed in a guest must be treated as guest-visible/exfiltratable.

## Tool installation and persistence

Repository tools should normally be installed in the persistent guest environment, not projected read-only from the host.

This allows per-repository state such as:

- `node_modules` / package caches;
- compilers/SDK additions;
- build-system caches;
- coding CLI installs/config;
- generated tool state

to survive command and VM stop/start cycles.

The immutable base image carries common broadly reusable tools; repo-specific additions live in the repository writable layer.

Reset/reseed intentionally discards that untrusted persistent state and returns to the base/bootstrap generation.

## Provider-specific guest bridge considerations

Profile/controller code must remain transport-independent.

Hyper-V transport candidates include PowerShell Direct for supported Windows guests and Hyper-V sockets/integration channels.

KVM/libvirt transport candidates include QEMU Guest Agent and libvirt/QEMU channels. QEMU Guest Agent is guest-controlled and may forge responses under compromise; it is a transport, not evidence authority.

A profile must not depend directly on `virsh`, libvirt XML, QGA JSON, PowerShell snippets, socket paths, or provider-specific file locations.

## Structured result protocol

A compatible worker may produce `devbridge/result-v1` with fields such as:

```json
{
  "protocol": "devbridge/result-v1",
  "status": "complete",
  "summary": "Implemented and tested the requested change.",
  "progress": ["Updated parser", "Added regression tests"],
  "tests": [
    { "command": "npm test", "status": "pass" }
  ],
  "nextStep": null
}
```

`complete` remains proposal intent, not host completion authority.

The bridge/worker exchange binds result bytes to exact run/environment/operation identity, bounds size, rejects malformed/ambiguous data, and returns them to host validation/sealing.

A compromised guest may forge a `complete` result. That cannot create verified tests, a host commit, publication, lease ownership, or hard-gate approval.

## Inventory and dynamic `tool.*` operations

DB-015 remains authoritative:

- inventory reports capability; it never creates it;
- host inventory is for control-plane/provider prerequisites;
- guest inventory is bound to exact repository environment generation;
- unfamiliar-tool onboarding requires local allowlisting/delegation;
- help/man/spec output is untrusted data;
- generated operation schemas expose only bounded non-authority parameters;
- repository-class generated tools execute inside the guest.

Do not implement dynamic onboarding by mutating proposal profiles from repository/GitHub text.

## Declaration versus observed readiness

Keep these concepts distinct:

1. locally declared profile intent;
2. configured host provider/image/environment policy;
3. observed provider/image/writable-layer/environment/bridge readiness;
4. observed guest tool presence/usability;
5. verified candidate/test evidence.

No earlier layer automatically proves the later one.

Examples:

- Hyper-V installed != repository environment ready;
- `/dev/kvm` exists != KVM/libvirt provider ready;
- libvirt domain exists != correct qcow2 backing chain;
- QEMU Guest Agent responds != trusted guest result;
- guest tool present != registered operation authority;
- model says tests pass != DB-019 verification evidence.

## Workstation process/resource governance

DB-018 below-normal host child priority remains transitional QoS for current host processes.

VM-backed repository workloads use provider-specific vCPU/memory/disk/lifecycle controls where Stage 7 proves them. A profile does not get to raise provider resources or create parallel scheduling authority from remote text.

## Migration rule

During VM Stages 1–8, keep current host-sandbox profile behavior working where needed for supported mainline execution, but do not add new architectural dependencies on it.

Stage 9 removes/deprecates host-sandbox-only profile/config semantics after:

- Hyper-V replacement acceptance;
- KVM/QEMU/libvirt replacement acceptance;
- Stage-8 config/setup migration.

See DB-020 and `docs/vm-migration.md`.
