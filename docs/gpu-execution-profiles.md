# GPU execution profiles

Status: roadmap architecture for post-recovery GPU support. This document does not claim that DevBridge currently exposes a qualified GPU to repository guests.

Implementation tracker: #395 supersedes #186 and owns the host-retained accelerator execution path for VM-contained workloads. Issue #419 owns the VM-to-host accelerator-broker transport attachment. Issue #162 owns later generalized compute routing.

## Sequencing rule

GPU/CUDA work follows the installer/runtime-recovery and reconstructable-VM work. It must not displace the active recovery path needed to make DevBridge installable, recoverable, and able to reconstruct missing execution environments.

The intended order is:

1. finish the application-management/install/re-entry path sufficiently that a configured installation can recover its accepted runtime and services without manual source or hypervisor surgery;
2. finish the reconstructable execution-profile lifecycle sufficiently that `create`, diagnosis, `rebuild`, supported operator UX, and exact image recovery work on the target host;
3. under #395/#419, prove one real supported host-retained GPU execution path with a deliberately small hostile-guest transport and CUDA canary;
4. under #395, add one real CUDA-capable execution profile and qualify actual kernel execution through the accepted backend without transferring host GPU ownership or falling back to host repository execution;
5. under #162 and follow-ons, generalize compute-requirement detection, alternate software backends, automatic matching, and additional hardware/provider adapters afterward.

This is deliberately different from building a broad GPU abstraction first. CUDA-dependent repositories need truthful real-device execution more urgently than they need CPU emulation of unrelated GPU APIs.

## Relationship to the execution-profile model

The existing ownership rule remains unchanged:

> **Execution profiles own persistent VMs. Repositories own isolated workspaces inside compatible execution-profile VMs.**

GPU support is therefore a profile capability, not a repository-owned device or VM.

Examples such as `windows+cuda` and `linux+cuda` are useful operator/profile labels. Generic lifecycle, routing, workspace, recovery, and evidence contracts should reason about neutral capability requirements and device/resource state rather than hard-coding current repositories or current downstream consumers.

A repository may require a CUDA-capable profile. It may not select a host PCI address, physical device identifier, provider command, driver package path, VM attachment object, or another provider-native identity.

## First milestone: feasibility before framework

Before significant implementation, #395 runs one bounded feasibility canary on the actual target host/GPU/provider combination after #419 has proven the VM-to-host attachment boundary.

The canary must establish all of the following before architecture is committed around a platform mechanism:

- the host/provider has a supported or deliberately accepted mechanism for exposing the physical GPU to the selected guest family;
- the selected device can be assigned/partitioned/exposed without granting repository code provider-management authority;
- the guest can observe the expected device through a reproducible driver/runtime configuration;
- a minimal CUDA program can allocate device memory, execute a kernel, synchronize, and return a verified result;
- shutdown/start and one reconstruction cycle do not require manual hypervisor surgery to restore device readiness.

A successful `nvidia-smi` probe alone is insufficient. The milestone requires real CUDA kernel execution.

If the intended provider path is unsupported or materially unsuitable for the actual hardware/host version, stop and select another supported execution path rather than hiding the constraint behind a generic `gpu: true` capability.

## Minimal real-CUDA path

The first useful GPU implementation should be intentionally narrow.

### Profile image/toolchain

Provide one reproducible CUDA-capable profile image/tooling generation with the minimum supported compiler/runtime/development tools required by the target repositories.

The profile owns shared driver/runtime/toolchain state where that state is genuinely profile-wide. Repository-local build outputs, dependency trees, generated kernels, caches with project semantics, and scratch remain workspace-local.

### Provider attachment

Provider adapters own host-specific device discovery, assignment/partitioning, provider lifecycle, and provider-native identifiers.

Generic environment lifecycle consumes only bounded neutral state such as:

- requested capability class;
- device availability/readiness;
- assignment generation/identity handle;
- exclusivity/share policy where relevant;
- compatibility result;
- recoverability/readiness state.

Do not manufacture one false cross-platform GPU mechanism. Hyper-V and libvirt/QEMU may expose materially different capabilities and failure semantics behind the same local contract.

### Guest qualification

A CUDA-ready claim requires runtime evidence from inside the exact profile environment, including at least:

- compiler/runtime availability as applicable;
- actual device visibility;
- driver/runtime compatibility;
- device class / compute capability or equivalent bounded compatibility evidence;
- successful memory transfer plus kernel execution;
- exact profile/image/environment generation used for the result.

The first milestone does not need automatic repository source inspection. Explicit locally configured profile requirements are sufficient to prove the execution path.

### Lifecycle and recovery

GPU device state must compose with the same execution-environment lifecycle used for ordinary profiles.

At minimum:

- `create` can materialize the CUDA-capable profile from approved durable configuration;
- `doctor` distinguishes host GPU presence, provider assignment readiness, guest CUDA readiness, and repository execution readiness;
- deleting/replacing the guest system disk and using supported `rebuild` returns the logical GPU profile to qualified CUDA readiness without manual device reconfiguration outside DevBridge;
- provider/device unavailability produces a typed blocker and never falls back to host execution or CPU execution while claiming CUDA evidence;
- reset/recreate semantics, when those lifecycle operations are production-ready, preserve the same local authority split.

## Truthful evidence

GPU evidence must distinguish what was actually proved.

At minimum keep separate:

- **compile validity** — CUDA source/toolchain can compile for a declared target;
- **functional device validity** — the workload executed on a real compatible CUDA device and produced the expected result;
- **hardware-specific validity** — claims tied to a particular device/driver/compute-capability class;
- **performance validity** — timing/throughput claims gathered under a qualified hardware/resource configuration.

A CPU fallback, software Vulkan/OpenCL implementation, compile-only pass, or mocked device is never evidence of real CUDA execution or performance.

## LEGO boundaries

Preserve the existing module-isolation rule.

- Execution-profile lifecycle does not name or depend on current downstream consumers.
- Repository requirement/routing logic does not know provider-native GPU identities.
- Provider adapters do not know repository names or project-specific build semantics.
- CUDA toolchain/image code owns CUDA-specific package/runtime details but not provider lifecycle.
- Device/runtime attestation reports bounded local facts; it does not become routing authority by itself.
- Composition decides the temporary topology: repository requirement -> compatible profile -> physical environment -> provider/device attachment.

## Follow-on generalized compute routing

Issue #162 remains useful, but it follows the first #395 real-device path rather than blocking it.

After one real device path is proven, #162 can generalize:

- deterministic repository requirement detection;
- compile-only versus device-execution versus performance requirements;
- automatic capability matching;
- CPU-backed OpenCL/Vulkan functional qualification where useful;
- framework CPU fallback only when the workload is semantically compatible;
- additional real-hardware or remote/cloud adapters;
- common result-validity vocabulary.

The generalized routing layer must be able to consume the first #395 real-CUDA profile without changing its provider or lifecycle implementation.

## Completion levels

### Level 0 — feasibility proved

#395 proves one actual host/GPU/provider/guest combination runs a real CUDA kernel through a bounded canary and its device lifecycle constraints are understood.

### Level 1 — usable CUDA profile

#395 provides one execution profile that can be created, started, diagnosed, rebuilt, and used by repository workspaces for real CUDA compile + kernel execution with truthful evidence.

### Level 2 — integrated GPU support

#395 integrates setup/reconfiguration discovery/proposal, explicit routing into the profile, `doctor` readiness/failure, and verification evidence bound to exact device/profile/environment identity.

### Level 3 — generalized compute routing

#162-style detection and alternative compute backends can automatically select among qualified execution implementations without weakening evidence semantics.

## Current coordination

Primary owners:

- #395 — host-retained accelerator execution for VM-contained workloads and first real-CUDA Level 0–2 implementation/qualification;
- #419 — Hyper-V/vsock-style VM-to-host accelerator broker attachment for #395;
- #138 — execution-profile VM/workspace ownership;
- #169–#178 — reconstructable environment/image/lifecycle and backing-store authority;
- #116 / #103 — setup, re-entry, provider/profile discovery and operator UX;
- #115 — real provider/security/resource qualification;
- #180 / #182 — whole-stack application/runtime recovery needed before VM-dependent work is dependable;
- #162 — later generalized compute-capability detection/routing and alternate backends.

#395/#419 remain blocked behind the active recovery/install work rather than competing with it. #186 is historical and superseded.
