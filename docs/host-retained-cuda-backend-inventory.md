# Host-retained CUDA backend inventory

Status: implementation/qualification slice for issue #395. This document does **not** claim that DevBridge currently exposes CUDA to repository guests.

This slice follows the neutral compute requirement/capability contract on `feature/395-host-retained-accelerator-capabilities`. Its purpose is deliberately narrower:

> Which already-present local host-retained CUDA substrates are worth taking to the next security/transport and real-kernel qualification gate?

Windows and Linux are co-equal first-class implementations. They develop against the same neutral observation contracts and remain independently replaceable below them. A Windows mechanism never becomes the generic model merely because that host is available first, and Linux is not a deferred port.

Inventory does not install, update, reconfigure, initialize a CUDA workload, detach a physical accelerator, or make repository execution less contained.

## Governing boundaries

DB-020 remains unchanged:

- repository-controlled CPU/control code executes only inside an admitted execution-profile VM;
- Windows hosts use Hyper-V and Linux hosts use KVM/QEMU managed through libvirt as first-class provider families;
- the guest may be fully compromised/root;
- host credentials, authoritative Git, DevBridge control state, and provider-management authority stay on the trusted host;
- no missing accelerator capability falls back to direct-host repository execution.

Issue #395 adds the ordinary-CUDA topology rule: the physical accelerator remains host-retained. A backend inventory result is evidence about a possible adapter, not permission to bypass DB-020.

DB-015 also governs this slice: **inventory reports local authority; inventory never creates local authority.** Finding a local runtime, library, helper, or driver does not register an executable operation and does not make a backend usable.

## Research and reassessment

### Windows has more than one candidate mechanism

Initial Phase-2 work evaluated WSL 2 because Microsoft and NVIDIA document shared CUDA access while Windows retains the physical display driver. Physical-host evidence then proved that the exact development host has a working CUDA-capable NVIDIA driver/GPU observation path but does **not** have WSL installed.

That evidence changes the inventory model. WSL is one concrete Windows backend candidate, not the definition of Windows host-retained CUDA.

NVIDIA documents that applications using the CUDA Driver API require the CUDA driver library (`nvcuda.dll` on Windows), which is part of the standard NVIDIA driver installation. NVIDIA's current Windows installation guide also documents WDDM as the normal driver model for Windows display devices; GeForce display GPUs do not require TCC and ordinarily cannot use it.

Primary references:

- https://developer.nvidia.com/cuda/faq
- https://docs.nvidia.com/cuda/cuda-installation-guide-microsoft-windows/
- https://docs.nvidia.com/cuda/cuda-programming-guide/05-appendices/compute-capabilities.html
- https://docs.nvidia.com/deploy/nvidia-smi/index.html
- https://learn.microsoft.com/en-us/windows/ai/directml/gpu-cuda-in-wsl
- https://docs.nvidia.com/cuda/wsl-user-guide/index.html

Therefore Phase 2 now observes two independent Windows candidates:

1. **native Windows CUDA driver substrate** — standard Windows NVIDIA driver + `nvcuda.dll` + observable CUDA-capable GPU;
2. **WSL CUDA substrate** — WSL 2 environment plus the documented WSL CUDA prerequisites.

Neither candidate is automatically selected merely because it is present. A WSL blocker does not imply native Windows CUDA is blocked, and native Windows readiness does not make WSL ready.

### Linux uses the native CUDA driver substrate

NVIDIA documents the Linux CUDA software stack as distinct layers. The CUDA user-mode driver (`libcuda.so.1`) and NVIDIA kernel-mode GPU driver are delivered with the driver package, while the CUDA Toolkit is a separate development/runtime SDK. That makes the installed native driver boundary the corresponding Linux host-retained substrate without PCIe ownership transfer.

Primary references:

- https://docs.nvidia.com/datacenter/tesla/drivers/latest/software-deployment-workflow.html
- https://docs.nvidia.com/datacenter/tesla/driver-installation-guide/latest/index.html
- https://docs.nvidia.com/cuda/cuda-installation-guide-linux/
- https://docs.nvidia.com/cuda/cuda-programming-guide/05-appendices/compute-capabilities.html
- https://docs.nvidia.com/deploy/nvidia-smi/index.html

The Linux adapter preserves a subtle read-only rule: NVIDIA documents that `nvidia-smi` may modify Linux device files when invoked as root. Therefore inventory refuses the selective `nvidia-smi` probe when the DevBridge process is elevated. Accelerator readiness remains `unknown` rather than weakening the read-only claim.

### VM-to-accelerator transport remains separate

The admitted DevBridge VM still needs a narrow way to request accelerator work from a trusted host-retained backend without receiving general host execution authority.

Hyper-V sockets/VSOCK on Windows and virtio-vsock/VSOCK on Linux/KVM remain promising transport families, but they are **not** selected by this inventory branch. Production use still needs a versioned bounded accelerator protocol, service identity, hostile-guest validation, exact session/execution binding, cancellation, recovery, and DB-009 reconciliation where effects can be ambiguous.

Primary transport references:

- https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/make-integration-service
- https://docs.kernel.org/admin-guide/sysctl/net.html
- https://www.kernel.org/doc/html/latest/admin-guide/sysctl/net.html

`boundaryTransport` and `securityBoundary` therefore remain explicitly `unknown / *-unproven` even when a local CUDA substrate is a candidate.

## LEGO ownership

### Neutral backend observation

`src/runtime/accelerator-backend-inventory.js` owns normalized provider-neutral observation data.

Single observation protocol:

`devbridge/accelerator-backend-observation-v1`

A single observation contains:

- opaque backend subject;
- opaque observation generation;
- semantic API family;
- neutral topology;
- disposition: `candidate`, `blocked`, or `unknown`;
- six closed checks:
  - `hostPlatform`;
  - `backendRuntime`;
  - `backendEnvironment`;
  - `acceleratorRuntime`;
  - `boundaryTransport`;
  - `securityBoundary`.

Every check is `ready`, `blocked`, or `unknown`. Non-ready checks use a closed neutral reason vocabulary. Disposition is derived:

- any blocked check -> `blocked`;
- otherwise any unknown core substrate check -> `unknown`;
- otherwise -> `candidate`.

Transport/security may remain unknown while a substrate is a candidate. Candidate means only **worth the next canary**; it never means a compute capability is qualified.

### Neutral multi-backend inventory

A host may expose more than one independent candidate mechanism. The collection protocol is:

`devbridge/accelerator-backend-inventory-v1`

It contains only a bounded list of normalized observations. The collection:

- rejects duplicate opaque subjects;
- sorts observations deterministically by opaque subject;
- contains no `selected`, `preferred`, fallback, priority, or winner field;
- does not infer that one candidate can substitute for another.

Backend selection belongs to a later locally authorized composition/routing layer after qualification, not to presence inventory.

### Windows native CUDA observation adapter

`src/runtime/accelerators/windows-native-cuda-backend-inventory.js` owns the native Windows driver-side observation.

It uses only fixed trusted Windows system locations. It does not search arbitrary PATH entries and accepts no executable/path/argument input from repositories/controllers.

Its checks are:

1. host platform is 64-bit Windows on a currently documented supported Windows generation;
2. the standard CUDA Driver API library (`nvcuda.dll`) is present at the fixed trusted system-library location;
3. no auxiliary backend environment is required for this native-host candidate, so `backendEnvironment` is ready when the supported host environment is ready;
4. a fixed trusted `nvidia-smi` performs only the selective compute-capability/driver-version query;
5. at least one returned row reports a valid positive CUDA compute capability.

The only subprocess observation is:

```text
nvidia-smi --query-gpu=compute_cap,driver_version --format=csv,noheader,nounits
```

Presence is still not execution proof. The adapter does not call CUDA Driver API functions, create a context, allocate memory, launch a kernel, or expose a host execution service. Those belong to later canary/broker qualification.

Missing `nvidia-smi` is an observation uncertainty, not proof that the accelerator is absent. Missing `nvcuda.dll` at its trusted native location is a concrete runtime blocker for this candidate.

### Windows WSL/CUDA observation adapter

`src/runtime/accelerators/windows-wsl-cuda-backend-inventory.js` owns the separate WSL-side observation.

It may invoke only:

```text
wsl.exe --status
wsl.exe --version
wsl.exe --list --verbose
nvidia-smi.exe --query-gpu=compute_cap,driver_version --format=csv,noheader,nounits
```

It never invokes WSL installation/update/version-conversion/default-selection/unregister/terminate operations and never changes driver/device state.

The adapter distinguishes an explicit trusted `wsl.exe` response that WSL is not installed from an unclassified command failure:

- explicit prerequisite absence -> blocked runtime/environment;
- ambiguous observation failure -> unknown.

The exact development Windows host has physically proven the former state. That is a blocker for the WSL candidate only.

### Linux native CUDA observation adapter

`src/runtime/accelerators/linux-native-cuda-backend-inventory.js` owns the Linux-side native observation and consumes the same neutral observation protocol.

Its core checks are:

1. host platform is Linux on the supported architecture family (`x64` or `arm64`);
2. a fixed trusted `ldconfig -p` observation reports `libcuda.so.1`;
3. required NVIDIA character devices are accessible to the current DevBridge identity;
4. a fixed trusted non-root `nvidia-smi` performs the selective compute-capability/driver query;
5. at least one returned row contains a valid positive compute capability and driver version.

The adapter does not run module management, persistence-mode changes, GPU reset, service changes, package installation, permission repair, or CUDA workloads.

The CUDA Toolkit is not required merely to classify the installed driver-side substrate as a candidate. Exact API/toolkit semantic coverage belongs to later qualification.

### Output minimization

Raw local observations stay below concrete adapters. Neutral observation/inventory output does not expose:

- provider/backend names;
- WSL distribution names;
- Linux distribution or host names;
- executable/library paths;
- GPU names or serials;
- PCI/PnP/VFIO identities;
- Linux device-node names;
- raw driver output;
- host user paths.

Relevant local facts contribute only to opaque generation identities so a material local change invalidates reuse without projecting local details.

## Common probe entrypoint

`src/runtime/host-retained-cuda-backend-inventory-cli.js` is a no-argument local-control entrypoint.

It selects candidate **inventory adapters**, not a usable execution backend:

- Windows -> native Windows CUDA observation **and** WSL CUDA observation;
- Linux -> native Linux CUDA observation.

The observations are returned together through `devbridge/accelerator-backend-inventory-v1` with no winner/selection field.

All subprocesses use the existing deterministic host `control-process` runner. The entrypoint accepts no controller/repository arguments and prints only normalized inventory JSON. It remains intentionally unwired from setup/doctor/routing.

Physical-host read-only canary:

```text
node src/runtime/host-retained-cuda-backend-inventory-cli.js
```

A candidate observation authorizes no installation and no repository CUDA execution.

## Current physical evidence

### Windows

On the exact target Windows host, the earlier WSL-specific inventory and direct read-only diagnosis established:

- Windows host platform ready;
- NVIDIA accelerator/driver observation ready;
- WSL explicitly not installed;
- no UAC/elevation, GUI interaction, or intentional host mutation.

After the WSL truth-model correction, the exact host correctly returned the WSL observation as blocked rather than unknown.

The **next Windows physical gate** is to run the new multi-backend inventory on the exact qualified source. This will test the additional native Windows candidate. Expected results are not authority: the actual normalized inventory must be returned and assessed.

### Linux

A physical Linux GPU-host inventory has not yet been recorded. Hosted Ubuntu CI is repository qualification, not physical CUDA evidence. Linux remains an independent Phase-2 physical gate.

## Side-by-side qualification sequence

1. Qualify this repository slice on exact Windows and Ubuntu CI.
2. Run the common inventory entrypoint on the exact target Windows host and a physical Linux GPU host without configuration changes.
3. Record every independent observation; do not collapse the host into one aggregate “GPU ready” boolean.
4. If at least one host-local candidate is physically established, assess the narrow broker/transport layer without granting repository code host execution.
5. Design one bounded accelerator semantic protocol with replaceable Windows and Linux transport/backend adapters.
6. Prove DB-020 hostile-guest containment independently on Hyper-V and KVM/libvirt.
7. Only then run bounded real CUDA canaries:
   `allocate -> transfer -> kernel -> synchronize -> transfer -> exact result`.
8. Only that later evidence may produce a qualified host-retained compute capability.

## Explicit non-goals

- treating WSL as the repository security boundary;
- treating native Windows or Linux host execution as repository execution;
- selecting a Windows candidate merely because another candidate is blocked;
- installing/updating WSL, drivers, CUDA, distributions, packages, kernel modules, or services during inventory;
- GPU detach, PCIe assignment, GPU-P/vGPU configuration, VFIO assignment, or driver reset;
- selecting Hyper-V sockets, VSOCK, TCP, or another production transport in this branch;
- claiming that driver/library/device presence proves real CUDA execution;
- wiring setup/doctor/routing before the real backend boundary is qualified;
- making either Windows or Linux the reference implementation that generic code depends on.
