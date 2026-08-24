# Environment lifecycle authority isolation

Status: active implementation design for issue #177. This document complements DB-020, `docs/vm-migration.md`, and `docs/vm-lego-studs.md`; it does not supersede them.

## Problem

DevBridge already has lifecycle owners that validate logical identity, desired declaration, current generation, impact, fencing, ownership, verification, retirement, and durable reconciliation. However, the Hyper-V/libvirt provider adapters and their backing-store mutations still execute under the ordinary DevBridge Node/OS identity.

An ordinary coding-model process with that same host authority can bypass the lifecycle owners and mutate provider state or backing files directly. Recovery from #169 is necessary but is not prevention.

## Security invariant

Production provider VM/domain/backing-store mutation must be owned by a protected local authority identity that ordinary repository/model/agent execution does not possess.

The intended composition is:

`operator-authorized local control plane -> neutral EnvironmentOperator client -> protected lifecycle authority -> existing EnvironmentOperator/recovery owners -> foundation/provider adapters -> Hyper-V or libvirt`

There is still one lifecycle semantic owner. The protected boundary does not create a second reset/rebuild/delete implementation.

## Lifecycle authority protocol

`src/runtime/environment-lifecycle-authority.js` defines the bounded provider-neutral request/result stud used across the process/OS boundary.

The remotely addressable vocabulary is intentionally the existing `EnvironmentOperator` surface only:

- `inspect` and `list`;
- `status` for one logical environment identity;
- `plan` for one supported lifecycle action;
- `run` for one supported lifecycle action with the existing approval subject when required;
- `resume` for the exact interrupted lifecycle owner.

Supported lifecycle actions remain `create`, `repair`, `rebuild`, `reset`, and `recreate`.

Lower `PersistentEnvironments` and provider operations are deliberately **not** RPC operations. A caller cannot remotely address `remove`, `replace`, `reseed`, provider start/stop, provider reconciliation, exact backing-store retirement, or provider-native mutation methods directly. Those remain internal bricks used by the existing higher lifecycle owners.

Each request accepts only bounded neutral operation/identity/approval fields. Unknown fields are rejected before dispatch.

The protocol has no representation for:

- arbitrary filesystem paths or media locations;
- executable paths, shell, PowerShell, scripts, argv, or commands;
- raw Hyper-V/libvirt provider names, XML, or objects;
- VM/domain/disk names;
- provider identity values supplied by the caller;
- unrestricted file operations.

Authority results are request-ID bound, size bounded, JSON-only, and reject provider-authority-shaped fields and obvious host-path/command leakage. Raw provider exceptions do not cross the boundary. Transport errors, ownership mismatch, malformed envelopes, unknown operations, and oversized/authority-shaped results fail closed.

## Safety ownership

The protected process must compose `createLocalEnvironmentOperator` or an equivalent existing higher-level owner. That composition already owns the declaration registry/journal, observation, lifecycle fence, construction/recovery pipelines, reset/recreate authorization, exact impact re-checks, verification, and superseded-generation retirement.

The broker must not dispatch destructive operations directly to `PersistentEnvironments` or provider adapters. Doing so would bypass the lifecycle safety owners even if the RPC itself were narrow.

The existing `EnvironmentOperator` destructive authorization subject is carried through the boundary; #177 does not invent another confirmation token. That subject is **not endpoint authentication**. Possession of a plan string must not grant an ordinary model process access to the protected IPC endpoint. Endpoint access is a separate OS/local-policy authority.

## Platform authority model

The protocol is necessary but not sufficient for #177. The authority process, IPC endpoint, provider-management capability, and protected storage must be separated by the OS/provider identity model.

### Windows / Hyper-V

Production setup must use a dedicated protected local identity that can run the Node authority host without granting the ordinary coding-model identity the same NTFS/Hyper-V authority. Candidate Windows primitives include a purpose-built service identity/per-service SID or a hardened scheduled-task identity/Task SID where that produces the required process and endpoint isolation. The exact mechanism remains subject to real Hyper-V positive/negative canaries; it must not be selected merely because it is convenient.

The selected identity must receive only the exact DevBridge-owned backing-store/provider rights required by the lifecycle authority, while preserving VMMS/platform service access. Ordinary coding/model processes must not inherit those rights.

### Linux / libvirt

Production setup should host the authority under a dedicated local identity. That identity receives only the required protected storage access and local libvirt authorization. Fine-grained libvirt/polkit authorization should be used where available so the ordinary user/model identity does not inherit broad libvirt read-write authority.

Repository/model/guest processes must not receive the authority socket, credentials, group membership, or provider-management capability as a side effect of normal execution.

## Composition rule

The ordinary process ultimately composes only the neutral authority client for protected lifecycle work. The protected authority process composes the existing `EnvironmentOperator` runtime, which in turn owns foundation/provider state and the lower lifecycle bricks.

Provider adapters remain replaceable Hyper-V/libvirt bricks behind neutral lifecycle/foundation studs. Provider-specific details must not be copied into controllers, CLI commands, repository routes, generalized operation manifests, or the authority wire contract.

Provider mutation reachable through lower foundation/control methods must also be moved behind the protected process before #177 is considered complete; protecting only backing-file deletion while leaving a parallel provider-control path would be an incomplete authority split.

## #176 coordination

The exact destructive impact/confirmation stud already exists in `EnvironmentOperator` and the reset/recreate lifecycle owners. #176 remains the operator UX owner. #177 reuses that subject and keeps its validation inside the protected lifecycle composition; it does not duplicate impact logic or accept an unbound `reset by name` request.

## Migration / rollout gates

Implementation is staged by ownership boundary:

1. **Protocol brick:** closed operator-level request/result protocol with adversarial tests proving lower provider/lifecycle mutation is not remotely addressable.
2. **Composition brick:** move protected lifecycle observation/mutation behind the authority client and make ordinary production composition fail closed when the protected authority is unavailable. No parallel in-process provider mutation path may remain for production.
3. **Windows authority brick:** protected identity, storage ACLs, bounded endpoint ACL, setup/recovery/uninstall behavior, and Hyper-V positive/negative canaries.
4. **Linux authority brick:** protected identity, storage ownership/mode, bounded local endpoint, narrow libvirt/polkit authority, setup/recovery/uninstall behavior, and libvirt positive/negative canaries.
5. **Setup/doctor migration brick:** detect legacy unprotected installations, report protection separately from provider readiness, migrate only exact DevBridge-owned state, and never seize foreign storage.

These are implementation seams, not permission to claim application-convention-only protection between stages. Final acceptance requires the real OS/provider negative and positive canaries in #177.

## Required final evidence

Repository tests must prove protocol bounds, forbidden-field rejection, explicit operator routing, lower-mutation unaddressability, request/result ownership, fail-closed transport behavior, and preservation of the existing lifecycle safety owners.

Real provider qualification must additionally prove:

- ordinary Windows agent identity cannot directly delete/replace the exact DevBridge test VHDX or invoke provider-control authority, while the authorized lifecycle can replace it;
- ordinary Linux agent identity cannot directly delete/replace the exact DevBridge qcow2/domain or invoke provider-control authority, while the authorized lifecycle can replace it;
- protected authority restart/ambiguous effects reconcile through the lifecycle journal rather than widening privileges;
- foreign/operator VM/storage/network objects remain untouched;
- no coding model or repository guest needs elevation, root, sudo, Hyper-V management membership, libvirt management authority, or automatic protected-IPC credentials.

Until those OS/provider gates pass, #177 remains open and DevBridge must not describe the protocol alone as backing-store protection.
