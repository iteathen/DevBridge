# GPU execution profiles

Status: roadmap architecture for post-recovery GPU/compute support. This document does not claim that DevBridge currently exposes a qualified GPU, GPU emulator, or compatibility backend to repository guests.

Primary trackers:

- #186 — CUDA track: no-GPU emulation feasibility first, CUDA-on-AMD compatibility next where useful, native NVIDIA later for native-device/hardware proof;
- #283 — AMD/ROCm track: rocJITsu emulation, emerging VM-visible emulated AMD device, then native AMD hardware;
- #162 — small early neutral compute-validity contract plus later generalized requirement detection/routing.

## Sequencing rule

GPU/compute work still follows the installer/runtime-recovery and reconstructable-VM work. It must not displace the active recovery path needed to make DevBridge installable, recoverable, and able to reconstruct missing execution environments.

The corrected order is:

1. finish the application-management/install/re-entry path sufficiently that a configured installation can recover its accepted runtime and services without manual source or hypervisor surgery;
2. finish the reconstructable execution-profile lifecycle sufficiently that `create`, diagnosis, `rebuild`, supported operator UX, exact image recovery, and the protected provider/storage authority boundary work on the target host;
3. land only the small early #162 contract slice needed to distinguish compute requirement/capability/evidence classes;
4. prioritize #186 CUDA functional emulation because CUDA semantics are the nearer-term downstream need;
5. pursue #283 AMD/ROCm emulation as a parallel specialized backend when recovery capacity permits, taking advantage of AMD's active rocJITsu work;
6. add compatibility/translated physical-device routes and native physical GPU paths when their stronger evidence is required;
7. implement the broad #162 detector/automatic router only after useful backend evidence exists.

The important correction is that **physical GPU passthrough is no longer required to be the first useful GPU-semantic milestone**. Emulation can provide real functional evidence when its supported semantic subset is explicitly qualified. It still cannot substitute for physical-hardware or performance evidence.

## Relationship to the execution-profile model

The existing ownership rule remains unchanged:

> **Execution profiles own persistent VMs. Repositories own isolated workspaces inside compatible execution-profile VMs.**

GPU emulation, compatibility layers, and physical devices are profile capabilities. They are not repository-owned devices and do not create separate lifecycle systems.

Useful operator/profile labels may eventually include concepts such as:

- `linux+cuda-emulated`;
- `linux+cuda-compat-amd`;
- `linux+cuda-native`;
- `linux+rocm-emulated`;
- `linux+rocm-native`.

These are illustrative operator labels, not generic contract names. Generic lifecycle/routing/workspace/recovery/evidence contracts reason about neutral requirement and capability facts rather than backend/vendor strings.

A repository may require a compute capability. It may not select host PCI addresses, physical device identifiers, provider commands, emulator sockets, raw QEMU/libvirt configuration, driver package paths, or provider-native VM/device identities.

## Truth model: what did the run actually prove?

One boolean such as `gpu: true` or `cuda: true` is not sufficient.

The neutral contract introduced by the early #162 slice must distinguish at least these independent validity classes:

1. **compile validity** — source/toolchain produced the requested target artifact;
2. **emulated functional validity** — the workload executed against an exact declared simulator/emulator/model and returned the expected semantic result;
3. **compatibility/translated-device validity** — source/API semantics executed on a physical device through a declared compatibility/translation implementation that is not the native vendor path;
4. **native-device functional validity** — the workload executed on a real compatible physical device through the native runtime/device path;
5. **hardware-specific validity** — evidence is bound to a qualified physical architecture/driver/device class;
6. **performance validity** — timing/throughput/resource conclusions came from separately qualified physical hardware/resources.

These are not always a simple linear ladder. A compatibility-device run may be more representative than an emulator for some behavior while still failing to prove native-vendor behavior. Results should carry independent facts and claims rather than one ordinal quality score.

No lower or orthogonal evidence class may silently satisfy a stronger requirement.

Examples:

- CUDA source compiles, but no execution backend is available -> compile validity only;
- a GPGPU-Sim kernel produces the expected result -> CUDA emulated-functional validity for the exact qualified subset;
- CUDA source passes through SCALE on an AMD GPU -> CUDA compatibility-device validity for the exact qualified subset and AMD device class;
- a HIP kernel runs under rocJITsu -> ROCm/HIP emulated-functional validity for the exact qualified subset;
- a kernel runs on a real NVIDIA/AMD device through its native stack -> native-device validity for that compatibility domain;
- a controlled benchmark on qualified physical hardware -> performance validity in addition to applicable functional/device evidence.

Simulated timing is never DevBridge physical-performance evidence merely because the simulator has a cycle model.

## Semantic matrices before backend claims

Backend qualification must use a **versioned semantic feature matrix**, not only a hello-world vector-add canary.

A backend-specific probe owner may test requirements such as:

- device-visible allocation/free;
- host/device transfer semantics;
- ordinary kernel launch and synchronization;
- shared/local memory and barriers;
- atomics;
- warp/wave operations;
- streams/events or queue semantics;
- runtime/driver API calls actually required;
- toolchain/IR/ISA compatibility;
- device-side launch/dynamic parallelism where required;
- CUDA Graphs or device-side graph semantics where required;
- debugger/fault/error behavior where it is part of the claimed capability.

The generic contract stores neutral capability facts and evidence identity. CUDA-, HIP-, emulator-, and vendor-specific probe implementation remains backend-local.

A backend that passes only part of the matrix exposes only that qualified subset. DevBridge does not rewrite the workload or weaken the requirement merely to obtain a green result.

## CUDA track — #186

CUDA remains the higher-priority compatibility target because current downstream work needs CUDA-specific semantics. The revised path is intentionally layered.

### CUDA Level A — no-physical-GPU functional simulation

The first candidate is GPGPU-Sim.

Current upstream evidence as of 2026-08-24:

- GPGPU-Sim provides detailed NVIDIA GPU simulation for CUDA/OpenCL workloads;
- current public release is `v4.2.1`;
- upstream describes support including CUDA Dynamic Parallelism and Tensor Cores.

Sources:

- https://github.com/gpgpu-sim/gpgpu-sim_distribution
- https://github.com/gpgpu-sim/gpgpu-sim_distribution/releases

That is enough to justify qualification, not enough to claim modern CUDA compatibility.

#186 must pin one exact simulator/config/toolchain subject and run the actual required semantic matrix inside a reconstructable Linux execution profile without a physical GPU. The minimum functional canary allocates/copies data, launches a kernel, synchronizes, retrieves output, and verifies an exact result.

If GPGPU-Sim cannot support a required advanced semantic such as the selected device-side-launch or graph behavior, DevBridge records that precise capability gap. A narrower simulator capability can still be useful for workloads whose requirements fit it.

### CUDA Level B — compatibility/translated execution on AMD hardware

If a physical AMD GPU is available, CUDA source can potentially obtain broader functional coverage without an NVIDIA GPU.

**SCALE** is the preferred first source-based candidate. Current SCALE 1.7.x documentation describes:

- a CUDA-compatible toolkit for NVIDIA and AMD GPUs;
- a drop-in `nvcc` capable of compiling CUDA-dialect source for AMD targets;
- CUDA runtime/driver/math API implementations for AMD;
- CUDA-X wrappers backed by ROCm libraries;
- compilation of existing CUDA code for AMD without source changes;
- no Windows support yet in the current documented product.

Sources:

- https://docs.scale-lang.com/stable/
- https://docs.scale-lang.com/stable/manual/faq/

SCALE is **not** a no-GPU emulator. It is a compatibility/translation path on real AMD hardware.

**ZLUDA** is a secondary candidate where its drop-in/binary compatibility adds useful coverage. It has active preview releases, but compatibility maturity must be proved for the selected workload rather than inferred from the project description.

Sources:

- https://github.com/vosen/ZLUDA
- https://github.com/vosen/ZLUDA/releases

SCALE/ZLUDA runs may establish CUDA compatibility-device validity. They cannot be labeled native NVIDIA CUDA evidence.

The physical AMD profile/device lifecycle is not owned by #186. #186 consumes an already-qualified compatible profile/device boundary, coordinated with #283, and owns only the CUDA compatibility implementation and CUDA semantic evidence.

### CUDA Level C — native NVIDIA device

Physical NVIDIA qualification remains required whenever the requirement explicitly depends on a real CUDA device, NVIDIA hardware behavior, native driver/runtime behavior, or performance.

The actual provider path is selected from real host evidence when this level is implemented. DevBridge must not assume GPU-P, DDA, VFIO, mediated devices, or another provider mechanism is usable merely because documentation names it.

The native canary must prove:

- exact locally approved device exposure;
- no repository/provider-authority leakage;
- compatible native driver/runtime;
- real memory transfer + kernel execution + exact result;
- the required semantic matrix on the physical device;
- restart/rebuild restores the declared device readiness without manual hypervisor surgery.

`nvidia-smi` or compiler presence alone is insufficient.

## AMD / ROCm track — #283

AMD now has a particularly interesting emulator path because the active work is occurring inside the official ROCm systems tree and is moving toward a VM-visible device model.

### ROCm Level A — rocJITsu in-process functional emulation

Current upstream evidence as of 2026-08-24 shows rocJITsu operating as a simulated KFD and current AMD/ROCm development using it for real GPU-kernel debugging flows. One July 2026 upstream issue documents a HIP kernel driven through real ROCgdb via `mirage run`, including breakpoint/continue and correct final result under the emulator.

Sources:

- https://github.com/ROCm/rocm-systems/issues/8371
- https://github.com/ROCm/rocm-systems

#283 should first pin an exact rocJITsu + ROCm/HIP subject and prove the same basic memory/launch/synchronize/result canary plus the selected HIP/ROCm semantic matrix inside a normal Linux execution profile.

That result may establish ROCm/HIP emulated-functional validity without any physical AMD GPU.

### ROCm Level B — VM-visible rocJITsu device

AMD is actively developing a `rocjitsu-vfu` mode using `libvfio-user` to present an emulated AMD Instinct MI350P / GFX950 PCIe device to a QEMU guest. The upstream goal explicitly includes VM-based GPU workload testing without physical hardware and exercising the emulator against the real guest `amdgpu` driver.

Source:

- https://github.com/ROCm/rocm-systems/issues/8218

This path is unusually well aligned with DevBridge's VM architecture, but it is **not yet assumed complete**. Current upstream notes describe partial PCI/BAR/MMIO/device-init work and say compute through the guest-visible device is follow-on work.

DevBridge therefore treats it as a separate maturity gate:

1. provider-local composition starts the emulator/device bridge without repository-selected paths/argv;
2. QEMU/KVM presents the exact emulated device to the DevBridge guest;
3. the real guest `amdgpu` kernel driver probes/binds it;
4. the guest ROCm stack reaches actual HIP kernel execution through that device;
5. restart/reconnect is deterministic;
6. `create`/`rebuild` reconstruct the profile without manual QEMU/libvirt surgery;
7. guest/repository code gains no host provider-management authority.

PCI enumeration alone is insufficient.

### ROCm Level C — gem5 reference/fallback

If rocJITsu lacks a required ISA/runtime behavior, gem5 Full System AMD GPU simulation is a second emulator adapter rather than a branch inside the rocJITsu implementation.

Current gem5 documentation describes Full System AMD GPU simulation using the native ROCm software stack, with configurations including gfx90a and MI300X/gfx942.

Source:

- https://www.gem5.org/documentation/general_docs/gpu_models/gpufs

It is a heavier reference/backend and should not displace rocJITsu without evidence that it fills a required gap. Its output remains emulated-functional evidence, not physical-performance evidence.

### ROCm Level D — native AMD device

Physical AMD qualification proves the same semantic matrix through the native AMD device/runtime path and binds evidence to the actual supported GPU/driver/runtime class.

Only this level establishes native AMD device validity. Performance validity requires a separately controlled/resource-qualified physical run.

## CPU-backed non-GPU implementations

CPU OpenCL/Vulkan or CPU-compatible ML framework paths remain useful where the workload semantics genuinely permit them. They are different from GPU emulation.

A CPU OpenCL implementation proves the relevant OpenCL functional path; it does not prove CUDA or HIP GPU-device semantics. Likewise, hiding a GPU or rewriting explicit CUDA placement into CPU execution is not an equivalent run.

These backends belong in reproducible/versioned execution profiles or deliberate guest tooling state and eventually participate in #162 matching under the same truthful evidence model.

## Lifecycle and recovery

Every compute backend composes with the same execution-environment lifecycle used for ordinary profiles.

At minimum:

- `create` can materialize/reconstruct the selected backend profile from approved durable configuration;
- `doctor` distinguishes backend/toolchain/emulator/device/runtime readiness from ordinary VM/storage readiness;
- deleting/replacing guest system storage and using supported `rebuild` returns the logical profile to its declared capability level without manual backend/provider surgery;
- emulator/model/toolchain/device evidence is invalidated when the relevant generation changes;
- provider/backend unavailability produces a typed blocker and never falls back to direct-host repository execution;
- DevBridge never silently substitutes emulation for a requirement that explicitly needs native physical-device or performance evidence;
- reset/recreate continue to use the same lifecycle owner and protected provider authority boundary.

Emulator runtime state may be replaceable implementation state. It must not become the only durable authority required to reconstruct the logical capability declaration.

## Setup and doctor

Discovery must report multiple readiness dimensions instead of one GPU boolean.

Representative CUDA status:

- CUDA compiler/toolchain ready;
- no-GPU simulator available;
- simulator semantic coverage qualified;
- CUDA-on-AMD compatibility backend available;
- compatibility physical device/profile ready;
- native NVIDIA device observed/assigned;
- native CUDA functional proof ready;
- performance qualification ready.

Representative ROCm status:

- ROCm/HIP toolchain ready;
- rocJITsu subject available;
- rocJITsu functional canary qualified;
- vfio-user/QEMU emulated-device mode available;
- guest `amdgpu` binding ready;
- emulated-device HIP functional proof ready;
- native AMD device observed/assigned;
- native HIP functional proof ready;
- performance qualification ready.

`doctor` remains read-only. Setup/re-entry owns authority-bearing installation/profile/device changes.

A detected emulator or physical GPU is observation only and does not silently create a specialized profile.

## LEGO boundaries

Preserve the existing module-isolation rule.

- Generic execution-profile lifecycle does not name GPGPU-Sim, SCALE, ZLUDA, rocJITsu, gem5, NVIDIA, AMD, or current downstream consumers.
- Repository requirement/detection logic does not know provider-native GPU identities or backend invocation details.
- Provider adapters do not know repository names or project-specific CUDA/HIP build semantics.
- Emulator adapters own emulator/model/configuration details, not generic routing or VM lifecycle.
- CUDA/HIP toolchain and semantic-probe owners do not own provider lifecycle.
- Compatibility-layer adapters consume an already-qualified physical profile instead of duplicating physical-device lifecycle.
- Device/runtime attestation reports bounded local facts; it does not become routing authority by itself.
- Composition decides the temporary topology: requirement -> compatible profile -> backend implementation -> evidence.
- Exact backend/model/toolchain/device subjects, not mutable labels such as `latest`, participate in reusable evidence identity.

## Full generalized routing — later #162 phase

Once useful backend evidence exists, #162 can implement the broad routing system:

- deterministic repository requirement detection;
- explicit compile versus functional versus emulated versus compatibility-device versus native-device versus performance requirements;
- automatic capability matching across already-qualified profiles/backends;
- CPU-backed OpenCL/Vulkan functional qualification where useful;
- framework CPU fallback only when the workload is semantically compatible;
- remote/cloud or additional physical GPU adapters;
- common runtime attestation and evidence reuse.

The full router must consume #186/#283 backend evidence without changing their provider/emulator/device lifecycle implementation.

Unsupported work returns a typed `not-run / unsatisfied compute requirement`. It does not silently rewrite tests, change devices/APIs, claim stronger evidence, or run repository code directly on the host.

## Completion levels

### Level 0 — neutral truth contract

#162 freezes the small common compute requirement/capability/validity schema and tests that evidence classes cannot be confused.

### Level 1 — useful emulated backend

#186 and/or #283 qualifies at least one real functional emulator path against a versioned semantic subset and reconstructable execution profile.

### Level 2 — stronger compatibility/native backends

CUDA-on-AMD compatibility and/or native AMD/NVIDIA device paths are qualified where their stronger evidence is required.

### Level 3 — lifecycle/operator integration

Specialized profiles participate in supported `create`, diagnosis, `rebuild`, setup/re-entry, `doctor`, exact evidence invalidation, and protected provider authority.

### Level 4 — generalized compute routing

Full #162 detection/matching can automatically select among qualified compute implementations without weakening evidence semantics.

## Current coordination

Primary owners:

- #186 — CUDA emulator/compatibility/native track;
- #283 — ROCm/AMD emulator/VM-device/native track;
- #162 — early neutral truth schema and later generalized routing;
- #138 — execution-profile VM/workspace ownership;
- #169–#178 — reconstructable environment/image/lifecycle and backing-store authority;
- #116/#103 — setup, re-entry, provider/profile discovery and operator UX;
- #115 — real provider/security/resource qualification;
- #180/#182 — whole-stack application/runtime recovery;
- #214 — secure guest-console extensibility used by recovered persistent development environments.

GPU backend implementation remains blocked behind the active recovery/install work rather than competing with it. The plan correction changes **which GPU proof we try first after that gate**, not the priority of the recovery gate itself.
