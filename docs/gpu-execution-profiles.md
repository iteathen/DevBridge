# GPU execution profiles

Status: active roadmap architecture. DevBridge does not yet claim that a production execution profile has a physically qualified GPU.

Primary ownership:

- #383 — exclusive whole-physical-device claim/release authority, provider assignment adapters, transfer recovery, and native-device handoff qualification;
- #186 — CUDA-specific compile/emulation/compatibility/native semantic qualification and tooling that consumes device/profile capabilities but does not own physical assignment;
- #162 — later generalized compute requirement detection and routing.

## Sequencing rule

GPU-capable profiles remain specializations of the existing execution-profile VM architecture:

> **Execution profiles own persistent VMs. Repositories own isolated workspaces inside compatible execution-profile VMs.**

The installer/runtime-recovery, protected provider-authority, and reconstructable-environment work remain prerequisites for production GPU use. Device work must compose with those owners rather than create a GPU-only installation, VM lifecycle, privilege, or recovery path.

For the native physical-device route, #383 is the first device-ownership layer. It proves safe exclusive assignment and return-to-root before CUDA-specific code may treat the device as usable. #186 then proves the requested CUDA semantics on the exact claimed environment/device generations. #162 can later route among those already-qualified capabilities.

Repository selection never grants physical-device authority. A repository may require a neutral capability such as native CUDA execution, but it may not select a PCI/PnP/device identifier, hypervisor partition, assignment handle, reset method, provider command, host driver, or another provider-native object.

Emulation or compatibility backends may still be useful CUDA evidence under #186, but they are separate capability classes. They never satisfy a requirement for native physical hardware or performance evidence and never become a fallback for a failed #383 direct-assignment canary.

## Protected authority composition

The current DevBridge development line already has the #177 protected environment-lifecycle authority architecture. That work establishes the reusable security pattern for privileged provider effects: the complete high-level semantic owner lives behind the protected mutation boundary while provider-native details and lower mutation primitives remain internal.

#383 reuses that **authority boundary and installation/reconciliation pattern**, not a second ad-hoc elevation path. Device semantics remain their own LEGO:

- `ExclusivePhysicalDevices` is the neutral high-level owner of claim/release/reconcile state, fencing, journal/recovery, preparation, quiescence/rebind, and qualification composition;
- the protected device protocol exposes only the same high-level `observe / claim / release / reconcile` studs;
- lower `assignment.observe/claim/release` mechanics are internal to the protected semantic owner and are not remotely addressable;
- the existing `EnvironmentOperator` lifecycle protocol remains unchanged and does not acquire PCI/device verbs;
- read and mutation capabilities remain separate; `reconcile` is mutation-capable because it may safely resume a journaled effect;
- protected local ports resolve and revalidate exact device/environment/provider facts from local approved state;
- the ordinary process cannot supply paths, commands, PCI/PnP identities, VPCI/VFIO handles, reset methods, provider objects, raw assignment generations, or arbitrary provider operations;
- physical-device mutation is unavailable when the protected high-level authority is absent or unqualified; there is no direct ordinary-process fallback and no repeated interactive-UAC runtime design.

This placement deliberately follows the #177 lesson: exposing a lower destructive provider primitive through a bounded RPC still bypasses the higher semantic owner. For devices that would bypass the exact claim journal, guest quiescence, qualification, and DB-009 recovery logic. The lower provider assignment port therefore stays private to the protected owner.

The non-elevating Windows #383 checkpoint strengthens the protected-boundary requirement: medium-integrity `WHvAllocateVpciResource` returned `E_ACCESSDENIED`, so ordinary process authority is not sufficient for VPCI resource allocation. That observation does not authorize widening the ordinary process; it points the implementation at the already-established protected-authority pattern.

## Persistent and ephemeral GPU state

A GPU-prepared profile remains prepared while it does not own the physical device.

Persistent profile state may include:

- guest OS and profile identity;
- installed vendor driver package/module state;
- CUDA runtime/toolkit and compiler state;
- profile-level configuration;
- qualification tooling and compatible software generations.

Exclusive physical claim state is separate and ephemeral:

- physical function/device assignment;
- live device instance;
- DMA/IOMMU ownership;
- MMIO and interrupt mappings;
- runtime contexts, kernels, allocations, and device memory.

Normal release must not uninstall the guest driver/toolkit. Runtime/device state is not preserved across ownership transfer.

## Native physical-device path — #383

The neutral authority is documented in `exclusive-physical-device-authority.md`. It owns the stable local device generation, exclusivity fence, exact claim handle, transition journal, provider observation reconciliation, quarantine, and recovery state.

Provider adapters own the actual host-specific mechanics below that protected semantic owner. Generic routing and execution-profile lifecycle do not learn provider identities or commands.

A native claim is not ready merely because a device is enumerated. Readiness requires all relevant gates to be true, including:

1. exact locally approved, non-host-critical physical-device generation;
2. complete safe assignment unit / isolation boundary;
3. exact admitted execution-environment generation;
4. compatible durable guest preparation generation;
5. protected high-level device authority available and independently authorized;
6. provider-observed exclusive assignment to that environment;
7. guest rebind or controlled restart using the already-installed driver;
8. independent native-device qualification;
9. exact assignment/device/environment/provider generations bound to the evidence.

Release must drain/fence guest work, remove the exact assignment, and observe ownerless root-safe state before another environment may claim the device. Ambiguous release is quarantine, not availability.

Live hot-remove/hot-add is not required for the first implementation. A controlled guest stop/start around transfer is acceptable when that is the proven safe provider boundary.

## CUDA qualification — #186

CUDA-specific qualification remains independent of physical assignment. For a native NVIDIA claim it must prove, at minimum, real device visibility through the ordinary guest driver, compatible runtime/driver state, memory allocation/transfer, kernel launch, synchronization, result transfer, and exact result verification.

`nvidia-smi`, compiler presence, or device enumeration alone is insufficient.

#186 may also qualify emulated or compatibility/translated CUDA backends. Evidence must state which class was actually proved:

- compile validity;
- emulated functional validity;
- compatibility/translated-device validity;
- native-device functional validity;
- hardware-specific validity;
- performance validity.

No lower evidence class silently implies a higher one.

## Execution-environment composition

The shared execution-environment lifecycle is a composition consumer, not another device owner.

`create`, `rebuild`, `reset`, and `recreate` must use the same high-level protected device authority rather than growing separate GPU/PCI implementations. A physical-device claim may be composed before start or through a proven live-rebind path, but the lifecycle sees only neutral requirement/claim/evidence handles.

Profile rebuild must reconstruct durable GPU preparation from approved inputs. It must not assume ownership of a physical device merely because the profile is GPU-capable. Destructive environment replacement must release or quarantine any existing exact device claim before superseding the owning environment generation.

## Setup, doctor, and routing truth

Setup is allowed to propose explicit local device/profile changes; read-only diagnosis is not.

Operator-visible evidence should keep these facts separate:

- physical device observed and locally eligible;
- host-criticality / safe alternate host control path;
- protected high-level device authority installed and qualified;
- provider direct-assignment mechanism qualified;
- current physical claim owner/availability/recovery state;
- guest software preparation ready/stale/blocked;
- native device rebind ready;
- CUDA semantic qualification ready;
- performance evidence available only when separately qualified.

A generic `gpu: true` or `cuda: true` flag is not evidence of any of these.

Routing consumes neutral capabilities and exact evidence. It never receives provider-native device identities and never falls back to direct-host repository execution when a required GPU capability is absent.

## Current host evidence

The first non-elevating Windows checkpoint under #383 proves only Phase-1 observations:

- Windows 11 build 26200 exposes the required WHP/VPCI API surface;
- the hypervisor is active and an empty process-local WHP partition can be created/deleted;
- platform DMA protection is reported available;
- the exact local GPU subject and its four-function topology were observed without publishing provider-native identity;
- the target GTX 1660 Ti is currently host-critical because it is the only active display adapter;
- VPCI resource allocation is denied to the medium-integrity process even for an explicitly empty resource.

Therefore physical mutation remains fail-closed. Before a GPU canary, the host needs an independently proven alternate display/control path and the provider adapter must live below the installed protected high-level device authority. Assignment-unit isolation, physical-function allocation, reset/root-return, guest rebind, CUDA, Linux VFIO/libvirt, and repeated Windows/Linux mobility remain unproved.

## Stop conditions

Do not broaden architecture to hide a failed direct-assignment canary. Stop at the owning decision boundary if evidence shows, for example:

- the target host/provider cannot expose the required physical function safely;
- the device's assignment unit includes a host-critical sibling;
- reset/root-return cannot prove the previous environment lost DMA/device authority;
- the ordinary guest driver cannot rebind without unsupported surgery;
- repeated transfer wedges the device/host;
- implementing the path would require provider-native identities in generic lifecycle/routing code;
- provider mutation would require granting ordinary model/repository processes persistent privileged authority.

GPU-P/PV, vGPU/mediated sharing, SR-IOV sharing, translation layers, and CUDA emulation are separate designs/capability classes, not automatic fallbacks for those failures.

## Completion levels

### Level 0 — direct-device feasibility proved

#383 proves the actual host/device/provider/guest assignment and root-return path, and #186 proves a real CUDA kernel on the exact claimed device.

### Level 1 — usable CUDA profile

A prepared execution profile can claim, use, release, and later reclaim the physical device without normal driver/toolkit reinstall, with provider mutation occurring only inside the protected high-level device authority.

### Level 2 — integrated GPU support

Setup/reconfiguration, doctor, lifecycle composition, explicit routing, recovery, and verification evidence are bound to exact device/profile/environment/provider generations.

### Level 3 — generalized compute routing

#162-style detection and alternative compute backends can automatically select among qualified execution implementations without weakening evidence semantics.

## Current coordination

Primary owners:

- #383 — exclusive physical-device ownership, protected high-level device authority, provider adapters, transfer/recovery, and real-host mobility qualification;
- #186 — CUDA semantic/toolchain qualification consuming the physical-device capability;
- #177 — protected provider-control authority pattern and OS/service identity boundary reused by device mutation;
- #138 — execution-profile VM/workspace ownership;
- #169–#178 — reconstructable environment/image/lifecycle and backing-store authority;
- #116 / #103 — setup, re-entry, provider/profile discovery and operator UX;
- #115 — real provider/security/resource qualification;
- #162 — later generalized compute-capability detection/routing and alternate backends.

The neutral #383 authority, protected high-level protocol, and fake-provider recovery suites are repository-qualification work. Real Windows/Linux assignment adapters and hardware acceptance remain gated by the exact evidence above.
