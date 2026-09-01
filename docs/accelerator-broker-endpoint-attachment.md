# Accelerator broker VM endpoint attachment

Status: repository attachment-policy slice for issue #419, child of #395.

This document defines the trust and ownership boundary between the provider-neutral accelerator broker service from #418 and future provider-native Hyper-V / virtio-vsock listener drivers.

It does not install a service, register a Hyper-V GuestCommunicationServices key, mutate a libvirt domain, open AF_HYPERV/AF_VSOCK sockets, or qualify a physical VM-to-host channel.

## Governing contracts

DB-003, DB-009, DB-020, #398, #411, #412, and #418 remain normative.

The repository environment bridge is not part of this path. Accelerator traffic is a separate hostile guest-to-host effect boundary.

## Two independent admissions

A structurally valid #418 frame is never sufficient authority.

Before a request reaches the accelerator service, two independent facts must agree with trusted host composition:

1. **transport peer attachment** — the provider driver reports the kernel/hypervisor-observed VM peer identity for the accepted stream;
2. **broker generation attachment** — the normalized #398 request carries the exact profile, environment, backend, and session binding expected for this endpoint instance.

The shared `AcceleratorBrokerEndpointAttachment` owns the second test. Provider adapters own the first.

Any mismatch closes/fails the exchange generically before broker invocation. No rejection observation is fabricated because a transport-attachment mismatch is not an admitted accelerator execution.

## Shared service port

DevBridge reserves VSOCK service port **55005** for the accelerator broker VM service.

The port is a rendezvous identifier, not a secret and not authority. It is intentionally stable so guest transport code does not need repository-selected host addressing.

For Windows Hyper-V hosts, Microsoft defines a VSOCK-compatible Hyper-V service GUID template:

`00000000-facb-11e6-bd58-64006a7986d3`

The first 32-bit GUID field is replaced with the VSOCK port. Port 55005 (`0x0000d6dd`) therefore maps to:

`0000d6dd-facb-11e6-bd58-64006a7986d3`

For KVM/libvirt, the host remains the well-known VSOCK CID 2 and listens on the same port.

Knowing CID 2, port 55005, or the Hyper-V service GUID grants no execution authority. The exact peer VM identity and exact broker binding are still required.

## Windows / Hyper-V policy adapter

`WindowsHyperVAcceleratorBrokerEndpoint` is constructed only from trusted host composition:

- exact Hyper-V VM GUID;
- exact accelerator broker binding;
- injected #418 service.

Its descriptor contains:

- `AF_HYPERV` host family;
- exact VM GUID;
- fixed service GUID derived from port 55005;
- Linux-guest compatibility projection `AF_VSOCK`, host CID 2, port 55005.

A future native driver must bind/accept the actual Hyper-V socket and supply the observed VM GUID and service GUID to `handleConnection()` together with exactly one #418 frame.

The adapter rejects a different VM GUID, different service GUID, or extra connection metadata before the service is called.

The service GUID must be registered by setup/protected host lifecycle authority; this repository slice does not perform that mutation.

## Linux / libvirt virtio-vsock policy adapter

`LibvirtVsockAcceleratorBrokerEndpoint` is constructed only from trusted host composition:

- exact libvirt-assigned guest VSOCK CID;
- exact accelerator broker binding;
- injected #418 service.

Reserved/wildcard CIDs cannot be used as a trusted guest identity. CID 2 is the host and therefore cannot identify an admitted guest.

A future listener may use systemd socket activation for the host-side `AF_VSOCK` stream on port 55005. Systemd documents `vsock:CID:PORT` listeners and can pass one accepted connection to an inetd-style service with `Accept=yes` / `StandardInput=socket`.

However, systemd's documented `REMOTE_ADDR` projection covers IP and AF_UNIX peers, not AF_VSOCK. Therefore DevBridge must not infer guest authority merely because systemd accepted a connection on port 55005. A narrow provider driver must obtain the kernel-observed source CID (for example via `getpeername()` on the accepted VSOCK stream) and supply it to the policy adapter.

The adapter rejects a different peer CID, different local service port, or extra connection metadata before the service is called.

The libvirt domain must have an admitted virtio-vsock device/CID supplied by existing environment/profile lifecycle authority. This repository slice does not mutate domain XML.

## Native-driver boundary

The actual socket-acquisition driver remains deliberately below these policy adapters.

It may own only:

- platform-native socket creation/listen/accept;
- kernel/hypervisor peer-address observation;
- exact bounded frame read/write using #418's maximum;
- connection timeout/close mechanics;
- local typed failure evidence required by host supervision.

It must not own:

- #398 operation semantics;
- broker binding selection;
- generation retirement;
- backend/CUDA command selection;
- repository command/file execution;
- guest-selected host paths, executables, GUIDs, CIDs, ports, or credentials.

A native listener or helper therefore acts as an infrastructure adapter, not a new authority surface.

## Ambiguity and disconnects

If a connection is lost after a valid request may have reached #418, the caller must reconcile through the existing exact request identity and `observe` behavior before repeating an effect. DB-009 remains authoritative.

The provider adapter does not invent `failed`, `rejected`, or `succeeded` when the transport outcome is ambiguous.

## Qualification status

Repository tests for this slice can prove:

- exact peer and exact binding are both required;
- guessed service locator alone is insufficient;
- provider connection metadata is closed;
- provider details do not contaminate #418;
- provider adapters contain no listener/process/filesystem/VM mutation authority.

They cannot prove a real kernel-reported peer identity, Hyper-V service registration, libvirt VSOCK provisioning, connection-loss behavior on a live hypervisor, or hostile-guest isolation. Those remain later #419 gates before any physical CUDA canary.
