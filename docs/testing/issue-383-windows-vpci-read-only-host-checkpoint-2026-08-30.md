# Issue #383 Windows VPCI read-only host checkpoint — 2026-08-30

Status: point-in-time qualification evidence for
`feature/383-exclusive-pcie-device-authority@0b9d83067c063ee30e1ddb41475f23cafc0bce1e`.
This checkpoint clears only the non-elevating Windows Phase 1 observations listed below.
It does not qualify physical-device assignment, guest rebind, reset/root return, CUDA, or
Windows/Linux device mobility.

## Scope and safety boundary

The run used an ordinary medium-integrity PowerShell 7.6.4 process. The account is a member
of the local Hyper-V Administrators group, but the process was not elevated. No UAC prompt
was requested or displayed.

The run was intentionally limited to:

- read-only OS, feature, hypervisor, PnP, display, and driver observations;
- dynamic-library export lookup;
- `WHvGetCapability(WHvCapabilityCodeHypervisorPresent)`;
- creation and deletion of one empty, process-local WHP partition;
- one `WHvAllocateVpciResource(NULL, None, NULL, 0, ...)` call, which Microsoft documents
  as an empty-resource allocation when both provider and descriptor are null;
- the existing provider-neutral focused test suite.

The empty-resource call returned access denied and no handle. The run did not disable,
dismount, reset, allocate, assign, or otherwise mutate a physical device; did not alter a
VM; and did not start repository-controlled execution.

## Exact evidence identity

| Identity | Observed value |
| --- | --- |
| DevBridge candidate | `0b9d83067c063ee30e1ddb41475f23cafc0bce1e` |
| Host OS | Windows 11 Pro x64 `10.0.26200` |
| WHP runtime | `WinHvPlatform.dll` `10.0.26100.9278` |
| Windows SDK header | `WinHvPlatform.h` `10.0.26100.0` |
| Process integrity | medium (`S-1-16-8192`) |
| Physical-device subject digest | SHA-256 `860dcbabf842182d5c5919c2b9c5d1f992b9e39073d6b8f2de152e27c1e072a7` |
| Display device | NVIDIA GeForce GTX 1660 Ti |
| Host display driver | Windows driver `32.0.16.1074`; NVIDIA KMD `610.74` |
| NVIDIA runtime observation | CUDA UMD `13.3`; BAR1 total `256 MiB` |

The subject digest is computed from the normalized local PnP instance identity. The raw PnP
instance identity and host name are deliberately not published; they remain local provider
data. A later qualification is reusable only if the candidate, OS/provider runtime, device
subject, driver, and relevant host policy identities still match.

## Results

| Phase 1 fact | Result | Evidence / exact blocker |
| --- | --- | --- |
| Windows build | `eligible` for API presence testing | Windows 11 Pro x64 build `26200`; newer than the documented x64 VPCI minimum. |
| Hypervisor active | `eligible` | CIM reported `HypervisorPresent=True`; `WHvGetCapability(HypervisorPresent)` returned `S_OK`, `true`, and four written bytes. |
| WHP partition lifecycle | `eligible` | One empty process-local partition returned `S_OK` from both create and delete. |
| VPCI API surface | `eligible` for API presence only | Allocation, create, delete, property, MMIO-map, and interrupt-map exports are present in the loaded WHP runtime. |
| VPCI resource allocation at current integrity | `ineligible` | An explicitly empty, unbacked allocation returned `0x80070005` (`E_ACCESSDENIED`) and no handle. Membership in Hyper-V Administrators did not make this operation usable from the current medium-integrity process. |
| DMA-protection capability | `eligible` as a platform prerequisite | `Win32_DeviceGuard.AvailableSecurityProperties` includes value `3`, which Microsoft defines as DMA protection available. This is not per-device assignment proof. |
| Target physical-device observation | `eligible` for local inventory | Device is present and healthy. The stable local identity is represented publicly only by the digest above. |
| Complete function topology | `unknown` for assignment; topology observed | Four present PCI functions share the same upstream bridge: display, high-definition audio, USB controller, and USB Type-C policy controller. Read-only PnP data does not prove which subset Windows VPCI must transfer as one safe assignment unit. |
| IOMMU / interrupt-remapping isolation | `unknown` | Platform DMA protection is available and PnP exposes ACS-related properties, but these observations do not prove the exact IOMMU assignment unit or interrupt-remapping ownership for these four functions. |
| BAR / Resizable BAR | `unknown` | NVIDIA reports a `256 MiB` BAR1 aperture. The available read-only surfaces did not report authoritative Resizable BAR state or the complete VPCI MMIO requirement. |
| Reset / FLR | `unknown` | The available non-elevating PnP and NVIDIA surfaces did not expose authoritative reset/FLR capability or root-return behavior. No reset was attempted. |
| Host criticality | `ineligible` | The GTX 1660 Ti is the only present or retained display adapter; one attached monitor is active at 1920x1080; NVIDIA reports display attached and active. Under #383 policy it is host-critical until an independently usable alternate host display/control path is locally configured and proven. |
| Physical-function allocation | `unknown with exact blockers` | The target is host-critical, the current process cannot allocate even an empty VPCI resource, and the public null-provider descriptor documents SR-IOV VF selection rather than a complete discrete-PF selector for this GPU. A physical allocation attempt would be a privileged ownership mutation, not a read-only probe. |
| Hyper-V DDA command availability | `not authority for this path` | DDA cmdlets are installed, but Microsoft documents the supported host path for DDA on Windows Server/Azure Local and requires host administrator rights. Their presence on Windows 11 does not establish a supported assignment mechanism. No DDA mutation was attempted. |
| Linux libvirt/VFIO | `not tested` | This Windows host cannot provide the required native Linux-host KVM/libvirt/VFIO evidence. |

## Focused candidate regression

The provider-neutral tests were rerun locally on Node.js `v24.15.0`:

```text
node --test test/exclusive-physical-devices.test.js test/exclusive-physical-device-lego-boundary.test.js
tests 14; pass 14; fail 0; duration 630 ms
```

This confirms the branch's neutral authority and LEGO boundary behavior on the live host.
It does not substitute for a physical provider adapter or real device handoff.

## Reassessment

The live checkpoint supports the branch's architecture but does not authorize implementation
to guess at provider mechanics:

1. Windows 11 on this machine has a usable WHP partition surface and the published VPCI API.
2. The current non-elevated execution identity is insufficient for VPCI resource allocation.
   Automatic operation therefore needs an explicitly installed/local-authorized privileged
   provider boundary; repeated interactive UAC is not an acceptable runtime design.
3. The target GPU cannot be used as the first physical mutation canary while it remains the
   only active host display under #383's host-criticality rule.
4. Function-group, reset/root-return, physical allocation, ordinary guest-driver rebind, and
   CUDA evidence remain genuine provider qualification gates. None may be inferred from API
   export presence or PnP metadata.

The next safe Windows step is to establish and prove an alternate host display/control path,
then design an operator-installed privileged adapter that exposes only the narrow local
claim/release contract. After both exist, an explicitly authorized disposable physical-device
canary may test allocation and root-safe recovery. Until then, production physical assignment
must remain unavailable.

## Primary references used for interpretation

- Microsoft, `WHvAllocateVpciResource`: https://learn.microsoft.com/en-us/virtualization/api/hypervisor-platform/funcs/whvallocatevpciresource
- Microsoft, `WHvCreateVpciDevice`: https://learn.microsoft.com/en-us/virtualization/api/hypervisor-platform/funcs/whvcreatevpcidevice
- Microsoft, VPCI data types: https://learn.microsoft.com/en-us/virtualization/api/hypervisor-platform/funcs/whvvpcidatatypes
- Microsoft, Windows Hypervisor Platform API definitions: https://learn.microsoft.com/en-us/virtualization/api/hypervisor-platform/hypervisor-platform
- Microsoft, `Win32_DeviceGuard` security-property meanings: https://learn.microsoft.com/en-us/windows/security/hardware-security/enable-virtualization-based-protection-of-code-integrity
- Microsoft, Hyper-V DDA graphics deployment scope and prerequisites: https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/deploy/deploying-graphics-devices-using-dda
