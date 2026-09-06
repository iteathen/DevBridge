# Host-retained accelerator execution

Status: active architecture plan for issue #395. This replaces whole-device PCIe handoff as the normal CUDA-development topology.

## Decision

Normal accelerator-backed repository execution must preserve two boundaries simultaneously:

1. **DB-020 remains the host-security boundary.** Repository-controlled CPU/control code stays inside an admitted execution-profile VM and never falls back to direct host execution.
2. **The host retains the accelerator.** Normal CUDA testing does not dismount, detach, or transfer ownership of the user's display GPU away from the host.

The resulting topology is intentionally mechanism-neutral:

```text
repository workspace in admitted VM
  -> bounded accelerator requirement
  -> exact qualified profile accelerator capability
  -> replaceable backend adapter
  -> host-retained accelerator
  -> bounded result/evidence
```

A concrete backend may eventually use a shared local GPU facility, a narrow accelerator broker, a supported hardware partition, or remote hardware. Those are adapters, not the core contract.

## Why direct physical assignment is not the normal path

Issue #383 explored exclusive whole-device ownership transfer. Read-only target-host evidence showed the current NVIDIA GPU is also the active host display adapter. A design that requires removing that device from the host would make ordinary CUDA testing disruptive and would require special display topology merely to run development workloads.

That is the wrong default user contract. Exclusive physical assignment can be reconsidered later only as a deliberately requested specialized capability with its own operational constraints; it is not a prerequisite for normal CUDA support.

## Environment assessment

The active DevBridge architecture already provides the correct ownership hierarchy:

> **Execution profiles own persistent VMs. Repositories own isolated workspaces inside compatible execution-profile VMs.**

DB-020 treats the guest as untrusted even if repository code obtains administrator/root. Provider-management authority, host credentials, authoritative Git/publication state, and arbitrary host filesystem/process authority stay outside that guest.

Therefore a useful shared-GPU mechanism is not sufficient by itself. It must compose with the existing VM boundary rather than replacing the VM with an environment whose root user can reach host authority through ordinary integration features.

## Research conclusions

### Shared Windows/Linux CUDA proves the user experience is feasible

NVIDIA and Microsoft document CUDA on WSL as GPU paravirtualization: Windows retains the physical GPU and Windows display driver while Linux CUDA applications access GPU compute. This is strong evidence that consumer Windows hardware can support the desired host-retained behavior.

It is not, by itself, evidence that an ordinary WSL distribution satisfies DB-020. WSL integration is intentionally close to the Windows host, while DB-020 assumes the repository execution environment may be fully compromised. DevBridge may evaluate WSL as a trusted accelerator-side implementation detail, but repository-controlled execution remains in the admitted VM unless another security specification independently replaces DB-020.

### GPU partitioning and vGPU are qualified-platform options, not universal assumptions

Current Microsoft Hyper-V GPU partitioning documentation is constrained by host OS, SR-IOV, driver, and supported GPU requirements. NVIDIA vGPU similarly supports defined product families and platform combinations. DevBridge must observe exact support rather than treating the existence of these technologies as evidence that the current consumer GPU can use them.

### CUDA remoting is possible but requires its own qualification

Research projects and libraries demonstrate API-forwarding/remoting approaches. That does not establish a production DevBridge backend. Any broker/remoting adapter must separately prove semantic coverage, hostile-input handling, bounded authority, version compatibility, cancellation/recovery, concurrency, resource behavior, and evidence identity.

## LEGO ownership

### Neutral compute requirement/capability contract

Issue #162 remains the owner of generalized compute semantics. The first implementation slice is deliberately small and is implemented in `src/runtime/compute-capabilities.js`.

A requirement contains only:

- API/semantic family;
- required semantic feature IDs;
- required independent evidence claims;
- required neutral topology class.

Protocol v1 deliberately uses a small closed topology vocabulary:

- `host-retained` — physical accelerator remains owned/usable by the host while the workload consumes a qualified mediated/shared capability;
- `exclusive` — accelerator ownership is exclusive to one execution environment for the relevant epoch;
- `emulated-local` — no physical accelerator execution is claimed; a local emulator/simulator supplies the semantics;
- `remote` — the accelerator execution occurs on a separately qualified remote subject.

Issue #395 requires `host-retained`. Exact topology matching means `exclusive`, `emulated-local`, or `remote` cannot satisfy a normal CUDA request merely because another evidence claim looks stronger. Provider names such as WSL, VFIO, GPU-P, or vendor/device identities are not topology values. New topology classes require an explicit protocol revision rather than arriving as arbitrary input strings.

An observed capability contains only:

- opaque capability subject and generation;
- exact execution profile identity;
- exact environment identity and generation;
- API/semantic family;
- qualified semantic features;
- independent evidence claims;
- neutral topology class;
- status (`qualified`, `unknown`, or `unsupported`);
- exact opaque qualification identity/generation or an exact blocker.

Provider-native implementation details are not part of these objects.

### Matching

`matchComputeCapability(requirement, capability, context)` is pure data matching. It neither discovers nor installs a backend and it has no fallback policy.

A match requires:

- capability status is `qualified`;
- exact profile match;
- exact environment identity and generation match;
- exact API-family match;
- exact topology match;
- set inclusion for every required semantic feature;
- set inclusion for every required evidence claim.

Evidence claims are independent facts, not a numeric quality ladder. For example, `performance-qualified` does not imply `hardware-backed` unless both facts are present.

An unsatisfied result is explicit (`COMPUTE_REQUIREMENT_UNSATISFIED`) and reports missing features/evidence plus exact identity/topology mismatches. The matcher never chooses another backend or direct-host execution.

### Profile accelerator attachment

A later profile-level attachment will own observation of one exact qualified capability and the narrow execution/session port associated with it. It will not own VM lifecycle, repository routing, provider installation, or arbitrary host process execution.

### Backend adapter

A concrete backend owns its mechanism-specific identifiers, transport, setup, and qualification. Those details terminate below the neutral contract.

If a backend needs a trusted host-side helper, that helper is an accelerator service, not a shell. It must not accept arbitrary host executables, paths, environment values, provider-management objects, or general command lines from the guest.

## First implementation slice

Issue #395 Phase 1 intentionally implements no physical backend. It freezes the replaceable connection studs before choosing a provider:

- bounded requirement normalization;
- bounded capability normalization;
- exact profile/environment/capability/qualification generations;
- closed neutral topology vocabulary with #395 requiring `host-retained`;
- independent semantic feature/evidence sets;
- explicit qualified/unknown/unsupported capability state;
- pure deterministic matching;
- typed satisfied/unsatisfied result;
- adversarial tests for stale generation, wrong topology, missing semantics/evidence, unsupported state, arbitrary/provider-shaped topology, extra provider-shaped fields, and LEGO/provider vocabulary isolation.

Passing these tests does **not** mean DevBridge currently runs CUDA. It means future backend experiments cannot silently redefine what a usable capability means.

## Next physical gate: read-only backend inventory

Before any host mutation, observe the exact target Windows installation and determine:

- whether WSL and its GPU-compute prerequisites are installed/usable;
- whether the installed display driver supports the required shared CUDA path;
- whether any supported partition/vGPU capability exists for the exact GPU/OS/driver combination;
- what bounded transport can connect the DB-020 VM to a trusted accelerator-side adapter without becoming a general host execution channel;
- exact blockers and relevant generations.

Observation produces capability candidates only. It does not create authority or claim readiness.

## First real CUDA canary

After a backend candidate survives the security/authority audit, the smallest end-to-end proof is:

```text
untrusted workload inside exact profile VM
  -> bounded accelerator operation
  -> host-retained backend
  -> real device allocation/transfer
  -> real kernel launch
  -> synchronization
  -> result transfer
  -> exact result verification
```

The same run must prove the host display remains usable and the physical device remains host-owned. Provider/device reassignment is a failure of this normal topology.

The canary must also cover malformed requests, stale capability generations, bounded input/output, timeout/cancel, backend loss, and no direct-host/emulation fallback.

## Evidence and recovery

Capability configuration is not execution evidence.

A functional result must bind, as applicable, the exact:

- profile identity;
- environment identity/generation;
- capability subject/generation;
- qualification identity/generation;
- semantic probe generation;
- backend/driver/device facts held behind opaque local evidence subjects.

If backend start/cancel/execution effects can become ambiguous, DB-009 observe/reconcile-before-repeat applies. A duplicate request must not become a duplicate accelerator effect merely because a response was lost.

Relevant generation drift invalidates affected evidence under DB-019 rather than silently reusing stale success.

## Resource and fault claims

Shared use does not imply perfect GPU fault containment. A bad kernel or driver defect can still affect a shared physical accelerator. DevBridge must distinguish:

- host ownership/topology;
- functional semantic coverage;
- enforceable resource limits;
- timeout/cancellation behavior;
- fault/recovery behavior;
- performance qualification.

Do not advertise a limit or isolation property merely because a configuration knob exists. Qualify what the selected backend actually enforces and observes.

## Operational reporting

`doctor` remains read-only and should eventually report independent facts such as:

```text
compute api: cuda
profile capability: observed
capability status: qualified
topology: host-retained
semantic coverage: <versioned evidence>
functional evidence: ready
performance evidence: unavailable
backend blocker: none
```

or a truthful blocked state without mutating the host.

Setup/re-entry owns any locally approved backend installation/configuration changes.

## Non-goals

- requiring a second display GPU for ordinary CUDA development;
- whole-device PCIe handoff as the normal CUDA path;
- treating an ordinary WSL distro as the repository security boundary without a separate security decision;
- assuming a partition/vGPU feature applies to unsupported hardware;
- generic host command execution through a CUDA/accelerator helper;
- silent emulation/translation/direct-host fallback;
- claiming physical/performance evidence from compile-only or simulated execution;
- promising perfect isolation from a broken kernel/driver on shared hardware.

## Coordination

- #395 — host-retained CUDA architecture and backend qualification.
- #162 — neutral compute requirement/capability/evidence vocabulary and later routing.
- #138 / `docs/execution-profile-environments.md` — profile VM/workspace ownership.
- DB-003 — local authority/security.
- DB-009 — ambiguous-effect recovery.
- DB-018 — resource/lifecycle governance.
- DB-019 — verification/evidence identity.
- DB-020 — repository VM execution boundary.
