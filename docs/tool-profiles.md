# Local tool profiles

DevBridge does not hard-code one coding CLI. Local configuration may define proposal/model profiles; GitHub task text may select only a profile name that already exists in local policy.

A profile is **local requested behavior**, not proof that containment or a usable repository environment exists.

DB-020 changes the target execution model: repository-controlled tools execute inside persistent repository VMs. The required initial host providers are Windows/Hyper-V and Linux/KVM-QEMU-libvirt.

Current pre-migration main still uses the legacy Linux/Bubblewrap host sandbox for supported proposal-worker/repository-code execution. Stage 1 removes that active host execution path before production VM implementation. From Stage 1 through Stage 5, repository-class tool execution is intentionally unavailable/fail-closed; Stage 6 restores it through VMs only.

Deterministic DB-013 operations remain preferred where model inference is unnecessary. DB-015 dynamic `tool.*` onboarding remains a separate validated local-operation mechanism.

## Host-sandbox-era profile fields

Current profiles may contain:

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

Before Stage 1 these fields may drive the host process-runner/Bubblewrap implementation where supported.

Stage 1 removes their ability to authorize repository-code host execution. Keys may remain temporarily recognized for migration/status/error compatibility, but they must not reactivate Bubblewrap or direct/uncontained host execution. Stage 8/9 owns deliberate operator-facing migration/deprecation.

Do not design new repository-execution features around `outsideProjectRead`, host `externalReadRoots`, host sandbox network modes, or host executable projection.

## Target VM-backed profile model

A repository-execution profile should describe logical intent/capability while DevBridge resolves it inside the exact repository environment.

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

The selected provider and exact repository environment are control-plane state.

## Host versus guest executable identity

Under DB-020, repository tools live in the guest trust domain after Stage 6.

Examples:

- Node/CMake/CTest/compiler/package-manager/coding CLI used for repository work -> guest tool;
- Git/Node/provider tooling used by DevBridge's trusted host control plane -> host tool;
- Hyper-V management tools -> host-only on Windows;
- KVM/QEMU/libvirt management tools -> host-only on Linux.

During the intentional no-provider interval, repository tools requiring execution are unavailable rather than resolved to host executables.

A guest executable path may be useful internal bridge data, but it is not host authority and should normally be derived by guest bootstrap/tool resolution rather than remote task text.

## Allowed structured placeholders

Controller/profile placeholders remain structural, not free-form command injection.

Host-sandbox-era placeholders may include:

- `{projectDir}`
- `{contextFile}`
- `{resultFile}`
- `{runId}`.

The VM bridge replaces host-path-valued assumptions with logical guest path classes/opaque endpoints where needed. Do not preserve a placeholder merely to expose a host path into a guest.

Free-form instructions never become argv, shell text, provider-management arguments, or bridge transport configuration.

## Shell rule

Trusted DevBridge host control processes continue to use `shell: false` unless a separately reviewed local adapter deliberately owns shell semantics.

Inside a guest, a repository tool may itself invoke a guest shell as ordinary untrusted development behavior. That does not grant host shell authority. The host bridge sends typed locally admitted operations rather than arbitrary remote shell text.

Provider absence never authorizes a host shell fallback for repository-controlled work.

## Execution boundary across migration

### Before Stage 1

Current pre-migration Linux main may use verified Bubblewrap for supported repository execution. Windows repository execution remains fail-closed on main.

### Stage 1 through Stage 5

There is deliberately **no production repository execution provider**.

Repository-class profile execution must fail before host spawn. In particular:

- `execution.allowUncontainedTools` or equivalent cannot bypass provider absence;
- profile `executable` cannot become direct-host authority for repository work;
- sandbox settings cannot resurrect Bubblewrap/AppContainer/ProcessContainer;
- proposal/model compatibility cannot silently drop containment;
- candidate/tool probes requiring repository-controlled execution remain unavailable.

### Stage 6 and later

Repository-controlled profiles execute through the exact persistent VM environment:

- Hyper-V repository VM on Windows host;
- KVM/QEMU/libvirt repository VM on Linux host.

If the provider/environment/bridge is unavailable, execution remains unavailable/fail-closed. No required Bubblewrap/AppContainer/ProcessContainer layer exists inside the VM.

## Networking

Host-sandbox-era profiles may contain `sandbox.network`; after Stage 1 this field no longer authorizes a host repository-execution network mode.

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

After VM restoration, repository tools should normally be installed in the persistent guest environment, not projected read-only from the host.

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
- repository-class generated tools execute inside the guest after Stage 6.

During Stage 1–5, repository-class generated operations requiring execution are unavailable, not host-executed.

Do not implement dynamic onboarding by mutating proposal profiles from repository/GitHub text.

## Declaration versus observed readiness

Keep distinct:

1. locally declared profile intent;
2. configured host provider/image/environment policy;
3. observed provider/image/writable-layer/environment/bridge readiness;
4. observed guest tool presence/usability;
5. verified candidate/test evidence.

No earlier layer automatically proves the later one.

Examples:

- profile configured != execution provider available;
- Hyper-V installed != repository environment ready;
- `/dev/kvm` exists != KVM/libvirt provider ready;
- libvirt domain exists != correct qcow2 backing chain;
- QEMU Guest Agent responds != trusted guest result;
- guest tool present != registered operation authority;
- model says tests pass != DB-019 verification evidence.

## Workstation process/resource governance

DB-018 host child priority is QoS for trusted/provider host processes, not containment and not permission for repository-code host execution.

VM-backed repository workloads use provider-specific vCPU/memory/disk/lifecycle controls where Stage 7 proves them. A profile does not get to raise provider resources or create parallel scheduling authority from remote text.

## Migration rule

- **Stage 1:** remove active host-sandbox profile execution and unsafe direct-host fallbacks; preserve only deliberate config/status migration recognition.
- **Stages 2–5:** no normal repository profile execution while VM providers/environments/bridge/tooling are built.
- **Stage 6:** restore repository profile execution through persistent VMs only.
- **Stage 8:** migrate/deprecate obsolete sandbox-era profile/config fields through discover-first setup.
- **Stage 9:** remove remaining compatibility/terminology scaffolding and confirm one VM-only execution model.

See DB-020, `docs/vm-lego-studs.md`, and `docs/vm-migration.md`.