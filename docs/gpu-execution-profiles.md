# GPU execution profiles

Status: active roadmap architecture for post-recovery GPU support. DevBridge does not yet claim a qualified CUDA backend for repository guests.

Architecture owner for ordinary CUDA execution: #395 and `docs/host-retained-accelerator-execution.md`.
General compute requirement/evidence owner: #162.

## Governing decision

**Normal CUDA development uses a host-retained accelerator capability.** DevBridge must not make whole-device PCIe detach/reassignment a prerequisite for ordinary repository CUDA tests.

The existing execution ownership rule remains normative:

> **Execution profiles own persistent VMs. Repositories own isolated workspaces inside compatible execution-profile VMs.**

DB-020 remains the host-security boundary. Repository-controlled CPU/control code executes inside an admitted untrusted profile VM. Missing GPU support never causes direct-host repository execution.

The intended normal topology is:

```text
repository workspace in profile VM
  -> neutral compute requirement
  -> exact qualified profile accelerator capability
  -> replaceable backend adapter
  -> host-retained accelerator
  -> bounded result/evidence
```

The host may continue using the physical accelerator for display/desktop work while DevBridge uses a separately qualified compute path. A backend that requires the host display device to be dismounted or transferred does not satisfy the normal `host-retained` topology.

## Why the roadmap changed

The direct-assignment work under #383 proved an important negative requirement on the target Windows host: the candidate NVIDIA GPU is also the active host display adapter. Whole-device ownership transfer would make ordinary CUDA testing operationally disruptive and would force users to provision an alternate display/control path merely to run development code.

That is the wrong default product behavior.

The direct-assignment evidence remains historical research, but #383 is superseded as the normal CUDA architecture. Exclusive physical-device execution may be reconsidered later only as an explicitly requested specialized capability whose operational constraints are acceptable to the user.

## Research constraints on concrete mechanisms

### Shared CUDA behavior exists

NVIDIA/Microsoft CUDA-on-WSL demonstrates the desired host-retained behavior: Windows owns the display GPU/driver while Linux applications use CUDA through GPU paravirtualization.

That does not make an ordinary WSL distribution a drop-in DB-020 repository VM. DevBridge assumes repository code can obtain root in its execution environment and must not gain host authority as a consequence. WSL may be evaluated as a trusted accelerator-side adapter/broker implementation, but repository-controlled execution remains behind DB-020 unless another security specification deliberately replaces that boundary.

### GPU partitioning/vGPU are platform-specific adapters

Hardware partition/vGPU mechanisms are useful where the exact host OS, GPU, firmware, driver, and provider combination is supported and qualified. They are not the core contract and must not be inferred from feature names on unsupported consumer hardware.

### API mediation/remoting is a candidate, not an assumption

A bounded CUDA/accelerator broker may eventually connect the DB-020 VM to host-retained hardware. That broker must be qualified as a narrow accelerator service, not a general remote shell. Current research demonstrates feasibility of API forwarding but does not justify claiming a production backend before semantic/security/recovery qualification.

## Neutral compute connection studs

Issue #162 remains the generalized semantic owner. The first contract slice is implemented in `src/runtime/compute-capabilities.js`.

A compute requirement states only:

- API/semantic family;
- required semantic feature IDs;
- required independent evidence claims;
- required neutral topology class.

Protocol v1 topology classes are deliberately bounded and provider-neutral:

- `host-retained`;
- `exclusive`;
- `emulated-local`;
- `remote`.

For normal CUDA under #395 the required topology is `host-retained`. Exact topology equality prevents the other neutral classes from satisfying that request. Provider/backend names are not topology values and adding a genuinely new topology class requires a protocol decision rather than accepting arbitrary strings.

An exact observed capability binds:

- opaque capability subject/generation;
- execution profile identity;
- environment identity/generation;
- API/semantic family;
- supported semantic features;
- independent evidence claims;
- neutral topology class;
- qualified/unknown/unsupported status;
- exact opaque qualification evidence or exact blocker.

Generic schemas do not contain device IDs, provider commands, host paths, backend sockets, partition handles, VM provider objects, or implementation-specific names.

Matching is deterministic set/identity comparison. Evidence is not a numeric quality score: one claim never silently implies another. An unsatisfied request returns `COMPUTE_REQUIREMENT_UNSATISFIED`; it does not choose a weaker backend.

## Provider/backend boundary

Provider/backend adapters may differ materially. One system may expose shared local acceleration, another a supported hardware partition, another a bounded remote accelerator.

The neutral lifecycle/routing layers do not manufacture false symmetry. A backend owns its exact transport/device/provider details and reports only bounded capability/evidence facts upward.

If a trusted host-side helper is required, it must:

- accept only a versioned accelerator-specific protocol;
- treat guest input as hostile;
- expose no arbitrary host executable/path/environment/provider-management authority;
- bind operations to exact sessions/capability generations;
- bound input/output and result identities;
- provide observed timeout/cancel/recovery behavior;
- reconcile ambiguous effects before repeat where DB-009 applies.

A design that requires arbitrary host code execution to support CUDA fails the architecture rather than weakening DB-020.

## Profile lifecycle

GPU/accelerator capability composes with the ordinary execution-profile lifecycle.

At minimum:

- profile creation/rebuild may prepare guest-side toolchain/runtime state without claiming a backend is qualified;
- accelerator capability is observed and qualified separately from VM existence;
- relevant profile/environment/backend/driver generation change invalidates stale capability evidence;
- reset/recreate does not grow a second CUDA-specific VM lifecycle;
- unavailable accelerator capability produces a typed blocker with no direct-host fallback.

A repository may require a CUDA-capable profile. It may not select a host GPU, provider partition, backend process, socket, host driver object, or provider-native VM identity.

## Qualification levels

Keep conclusions independent rather than compressing them into `gpu: true`.

### Compile validity

The requested toolchain produced the requested CUDA target artifact. This does not prove device execution.

### Functional validity

A qualified accelerator path executed the required memory/launch/synchronize/result semantics and produced the expected result.

### Hardware-backed validity

The functional execution is bound to qualified physical accelerator evidence rather than simulation-only evidence.

### Hardware-specific validity

The conclusion is bound to a qualified device/driver/architecture compatibility domain where required.

### Performance validity

Timing/throughput/resource conclusions were gathered under separately qualified hardware/resource conditions. Functional success alone does not establish this.

These facts remain independent. For example, performance evidence does not automatically imply some other unrecorded hardware or semantic claim.

## First real backend gate

Before host mutation, #395 performs read-only observation of the exact target Windows installation:

- shared-CUDA prerequisites and driver support;
- exact candidate backend availability;
- whether any supported partition/vGPU path exists for this exact hardware/OS combination;
- the narrow transport/security boundary between the DB-020 VM and an accelerator-side adapter;
- exact blockers and relevant generations.

No candidate becomes authority merely because documentation says the technology exists.

## First CUDA canary

The first production-relevant proof must run a real CUDA operation while preserving host ownership:

```text
untrusted repository workload in exact profile VM
  -> bounded accelerator request
  -> qualified host-retained backend
  -> device allocation/transfer
  -> kernel launch
  -> synchronization
  -> result transfer
  -> exact result verification
```

The canary must additionally prove:

- the host display remains active;
- the physical accelerator remains host-owned;
- no general host command/filesystem/provider authority is exposed;
- malformed/stale requests fail closed;
- backend loss and timeout/cancel are bounded and observable;
- no weaker backend or direct-host execution is silently substituted;
- evidence binds exact profile/environment/capability/qualification generations.

A successful device-listing utility alone is insufficient.

## Semantic expansion

After the minimum canary, qualify only the CUDA semantics actual consumers require. Potential features include memory operations, kernel launch, streams/events, synchronization, atomics, warp operations, dynamic/device-side launch, CUDA Graph semantics, and error propagation.

Partial support is reported as partial support. Tests are not rewritten merely to fit backend limitations.

## Resource and fault behavior

A host-retained shared GPU avoids voluntary display-device removal; it does not guarantee that a pathological kernel or driver defect cannot affect the shared GPU/desktop.

DevBridge must qualify and report separately:

- functional semantic coverage;
- host-retained topology;
- resource limits actually enforceable by the backend;
- timeout/cancellation behavior;
- concurrency behavior;
- backend/driver restart recovery;
- hardware/performance evidence.

Do not advertise perfect fault isolation or quotas that have not been demonstrated.

## Setup and doctor

`doctor` remains read-only. It eventually reports independent facts such as:

- compute API requested/observed;
- exact profile/environment generation;
- accelerator capability status;
- topology (`host-retained` when qualified for normal CUDA);
- semantic coverage;
- qualification generation;
- functional/hardware/performance evidence;
- exact blocker.

Setup/re-entry owns any locally approved backend installation/configuration changes.

## LEGO requirements

- Compute requirement/capability matching contains no provider/backend implementation identity.
- Repository routing contains no physical device identity.
- Provider/backend adapters contain no repository-specific build semantics or routing policy.
- VM lifecycle does not grow separate CUDA provisioning implementations.
- A backend can be replaced without changing the neutral contracts.
- Capability/evidence observation does not become authority to install or mutate a backend.
- Unsupported compute fails explicitly and never falls back to direct host execution.

## Current coordination

- #395 — host-retained CUDA architecture, backend feasibility, canary, and operational integration.
- #162 — neutral generalized compute semantics/evidence and later automatic routing.
- #138 / `docs/execution-profile-environments.md` — execution-profile VM/workspace ownership.
- #169 and lifecycle follow-ons — common create/rebuild/reset/recreate behavior.
- #115 — real provider/security/resource qualification.
- #116 / #103 — setup/re-entry/doctor UX.
- DB-003 — local authority/security.
- DB-009 — ambiguous-effect reconciliation.
- DB-018 — resource/lifecycle governance.
- DB-019 — exact verification/evidence identity.
- DB-020 — VM-only repository execution boundary.

## Completion definition

GPU support is usable for normal CUDA development when repository code stays in an admitted DevBridge VM, a qualified `host-retained` accelerator capability executes the required real CUDA semantics on physical hardware, results/evidence are exact and bounded, and ordinary execution/recovery does not require dismounting the user's display GPU or granting repository code general host/provider authority.
