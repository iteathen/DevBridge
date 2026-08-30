# Exclusive physical-device authority

Status: neutral control-plane lifecycle implemented; physical provider adapters and real-host qualification remain gated by issue #383.

Tracker: #383 is the semantic owner for exclusive whole-device assignment. CUDA-specific software/semantic backends remain under #186; generalized compute routing remains under #162.

## Governing invariant

At every stable point an approved physical-device generation is exactly one of:

- `AVAILABLE`: provider observation proves it is ownerless and root-safe;
- `OWNED`: one exact admitted execution-environment generation owns one exact assignment generation;
- `QUARANTINED` / `RECOVERY_REQUIRED`: DevBridge cannot yet prove safe ownership and must not offer the device to another environment.

Ambiguity never becomes availability by timeout, retry count, name matching, or a mutable owner flag. Only provider observation proving the relevant generation and root-safe state can return a device to `AVAILABLE`.

## LEGO ownership

`src/runtime/exclusive-physical-devices.js` owns only neutral authority semantics:

- stable local device subject and generation;
- local eligibility / host-criticality gate;
- exact target environment admission generation;
- exact guest preparation generation;
- exclusive claim handle and assignment generation;
- transition journal and lifecycle fence;
- guest quiescence / rebind coordination through narrow ports;
- native-capability qualification through a narrow port;
- observe-before-repeat recovery;
- quarantine when durable state and provider observation disagree.

Its public studs are deliberately small:

```text
observe(subject)
claim(subject, environment)
release(claim)
reconcile(subject)
```

The authority does not know PCI addresses, PnP identities, hypervisor partition handles, VPCI resources, libvirt node-device names, VFIO groups, IOMMU groups, provider commands, GPU vendors, CUDA packages, repositories, or workspaces. Boundary tests reject those identities from the neutral module and reject extra provider-observation properties.

## Ports

Composition supplies these provider-neutral contracts:

- `inventory.resolve(subject)` — locally approved device generation, criticality, and bounded neutral capabilities;
- `environments.observe(environment)` — exact environment-generation admission;
- `assignment.observe/claim/release` — provider-local physical assignment mechanics exposed only as neutral ownership observations;
- `preparation.observe(environment)` — durable guest software/configuration readiness and preparation generation;
- `guestLifecycle.quiesce/rebind` — guest-side drain and re-enumeration/restart behavior;
- `qualification.qualify` — independent proof that the claimed physical device is usable in the exact environment generation.

Provider-specific differences belong below `assignment`. Guest package installation belongs behind `preparation`. CUDA semantics belong behind qualification/profile tooling. The execution-environment lifecycle may consume an opaque claim but does not implement bus/device mechanics itself.

## Durable state and recovery

The authority keeps a control-owned catalog and mutation guard. Lifecycle effects are journaled through states equivalent to DB-009's `planned -> attempted -> observed -> reconciled` discipline.

Before repeating an interrupted claim or release, reconciliation observes the provider first. It also revalidates exact device, environment-admission, and guest-preparation generations before a pending claim can proceed.

Important recovery behavior:

- an interrupted claim whose provider effect already happened is adopted only when observation proves the exact intended owner; the provider claim is not issued again;
- an interrupted release whose provider effect already returned the device to root-safe state is completed without issuing another release;
- failed native qualification after assignment leaves the device `RECOVERY_REQUIRED`; another environment cannot claim it;
- unexpected owner or assignment-generation drift is quarantined rather than adopted or released by guess;
- device-generation drift invalidates prior claim authority;
- failed guest quiescence prevents provider release;
- a stale lifecycle lock is never automatically deleted merely because it looks old.

## Persistent versus ephemeral state

Guest preparation is orthogonal to physical ownership.

Persistent execution-profile state includes the guest OS, vendor driver package/module state, runtime/toolkit, profile configuration, and qualification tooling. A successful release does not uninstall or invalidate these merely because the physical device is absent.

Ephemeral claim state includes the physical assignment, live device instance, DMA/MMIO/interrupt ownership, runtime contexts, and device memory. Those resources are destroyed/drained at release and are not promised across ownership transfer.

## What this implementation does not claim

This commit deliberately does not fabricate physical backends from API documentation. It does not claim that the current Windows host/GPU can be assigned through WHP VPCI, that the current Linux host/IOMMU layout is VFIO-safe, or that either guest can yet run the required real CUDA canary.

Those are #383 real-host feasibility and provider-adapter gates. Until a provider-specific canary proves the full assignment unit, reset/root-return behavior, guest driver rebind, and real workload qualification, production composition must remain fail-closed rather than substituting GPU-P, vGPU, SR-IOV sharing, emulation, translation, or direct-host execution.

## Qualification currently present

The fake-provider suite proves the control semantics independent of a physical provider:

- environment A -> release -> environment B exclusive switching;
- local approval, host-criticality, environment admission, and guest preparation before mutation;
- exact preparation-generation revalidation on recovery;
- ambiguous claim/release reconciliation without duplicate provider effects;
- failed qualification fencing;
- owner and device-generation drift quarantine;
- provider-native identity rejection at the neutral boundary;
- quiescence before release;
- root-safe proof before quarantine can clear;
- cross-instance lifecycle locking.

Physical Windows/Linux provider qualification is intentionally still outstanding.
