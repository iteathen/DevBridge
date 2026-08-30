# GPU execution profiles

Status: active roadmap architecture. DevBridge does not yet claim that a production execution profile has a physically qualified GPU.

Primary ownership:

- #383 — exclusive whole-physical-device claim/release authority, provider assignment adapters, transfer recovery, and native-device handoff qualification;
- #186 — CUDA-specific compile/emulation/compatibility/native semantic qualification and tooling that consumes device/profile capabilities but does not own physical assignment;
- #162 — later generalized compute requirement detection and routing.

## Sequencing rule

GPU-capable profiles remain specializations of the existing execution-profile VM architecture:

> **Execution profiles own persistent VMs. Repositories own isolated workspaces inside compatible execution-profile VMs.**

Repository selection never grants physical-device authority. A repository may require a neutral capability such as native CUDA execution, but it may not select a PCI/PnP/device identifier, hypervisor partition, assignment handle, reset method, provider command, host driver, or another provider-native object.

For the native physical-device route, #383 is the first ownership layer. It proves safe exclusive assignment and return-to-root before CUDA-specific code may treat the device as usable. #186 then proves the requested CUDA semantics on the exact claimed environment/device generations. #162 can later route among those already-qualified capabilities.

Emulation or compatibility backends may still be useful CUDA evidence under #186, but they are separate capability classes. They never satisfy a requirement for native physical hardware or performance evidence and never become a fallback for a failed #383 direct-assignment canary.

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

Provider adapters own the actual host-specific mechanics. The generic authority and execution-profile lifecycle do not learn provider identities or commands.

A native claim is not ready merely because a device is enumerated. Readiness requires all relevant gates to be true, including:

1. exact locally approved, non-host-critical physical-device generation;
2. complete safe assignment unit / isolation boundary;
3. exact admitted execution-environment generation;
4. compatible durable guest preparation generation;
5. provider-observed exclusive assignment to that environment;
6. guest rebind or controlled restart using the already-installed driver;
7. independent native-device qualification;
8. exact assignment/device/environment generations bound to the evidence.

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

`create`, `rebuild`, `reset`, and `recreate` must use the same device authority and provider adapter studs rather than growing separate GPU/PCI implementations. A physical-device claim may be composed before start or through a proven live-rebind path, but the lifecycle sees only neutral requirement/claim/evidence handles.

Profile rebuild must reconstruct durable GPU preparation from approved inputs. It must not assume ownership of a physical device merely because the profile is GPU-capable.

## Setup, doctor, and routing truth

Setup is allowed to propose explicit local device/profile changes; read-only diagnosis is not.

Operator-visible evidence should keep these facts separate:

- physical device observed and locally eligible;
- provider direct-assignment mechanism qualified;
- current physical claim owner/availability/recovery state;
- guest software preparation ready/stale/blocked;
- native device rebind ready;
- CUDA semantic qualification ready;
- performance evidence available only when separately qualified.

A generic `gpu: true` or `cuda: true` flag is not evidence of any of these.

Routing consumes neutral capabilities and exact evidence. It never receives provider-native device identities and never falls back to direct-host repository execution when a required GPU capability is absent.

## Stop conditions

Do not broaden architecture to hide a failed direct-assignment canary. Stop at the owning decision boundary if evidence shows, for example:

- the target host/provider cannot expose the required physical function safely;
- the device's assignment unit includes a host-critical sibling;
- reset/root-return cannot prove the previous environment lost DMA/device authority;
- the ordinary guest driver cannot rebind without unsupported surgery;
- repeated transfer wedges the device/host;
- implementing the path would require provider-native identities in generic lifecycle/routing code.

GPU-P/PV, vGPU/mediated sharing, SR-IOV sharing, translation layers, and CUDA emulation are separate designs/capability classes, not automatic fallbacks for those failures.

## Current completion boundary

The neutral exclusive physical-device authority and fake-provider recovery qualification are implemented on the #383 feature branch. Real Windows WHP/VPCI and Linux libvirt/VFIO assignment adapters, target-host feasibility canaries, guest rebind proof, and real CUDA qualification remain outstanding and must be demonstrated on the actual hardware before DevBridge reports native GPU readiness.
