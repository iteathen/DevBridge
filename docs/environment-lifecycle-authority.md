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

- `inspect`, `list`, `status`, `plan`, and `setup-reentry` on the read/plan capability;
- `run` and `resume` on the mutation capability.

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

## Capability separation

Read/plan and mutation are separate local endpoint capabilities even though they terminate in the same protected `EnvironmentOperator` owner.

The read endpoint accepts only bounded observation/planning operations. It rejects `run` and `resume`.

The mutation endpoint accepts only `run` and `resume`. It rejects even read/plan operations so possession of one endpoint does not silently imply possession of the other.

This split is deliberate. Bounded lifecycle status and impact planning may be useful to an ordinary local control/model-visible process. That does not justify automatically granting the same process the capability that can mutate provider infrastructure. The platform-specific setup may therefore apply different OS access policy to the two endpoint classes without duplicating lifecycle semantics.

The exact destructive approval subject produced by the lifecycle owner remains defense in depth and operator-intent binding. It is **not** endpoint authentication and must not be treated as a bearer credential for the mutation endpoint.

## Local transport

`src/runtime/environment-lifecycle-authority-transport.js` provides a bounded local-only transport for Windows and Linux.

The endpoint namespace is derived from the lifecycle state owner, not from caller-supplied request data. DevBridge computes a 128-bit path-free authority identity as a one-way hash of the normalized absolute lifecycle `state.directory` under a fixed protocol domain. Windows normalization is case-folded after platform path resolution. The raw state path is not present in the wire protocol or endpoint label.

The two endpoints are deterministic from that authority identity and capability class:

- Windows: separate local named pipes for read and mutation;
- Linux: separate UNIX-domain sockets under an authority-identity runtime directory.

The client receives the configured state directory from local DevBridge configuration and derives both endpoints internally. Request payloads cannot choose an arbitrary socket, pipe, filesystem path, provider object, or privileged target.

The wire is one bounded JSON request and one bounded JSON response per connection. Oversized data, malformed JSON, multiple frames, ambiguous close, response ownership mismatch, or unavailable endpoints fail closed.

The timeout is a **connect timeout only**. Once a request has reached the authority, the transport does not impose an arbitrary short lifecycle-operation timeout. Long reconstruction remains owned by the existing durable lifecycle journal/resume/reconciliation semantics.

The transport does not create Linux `/run` authority directories itself. Production setup/service ownership must provision the runtime directory and its permissions. This prevents an ordinary application process from silently claiming a parent directory that is supposed to represent OS authority.

## Safety ownership

The protected process must compose `createLocalEnvironmentOperator` or an equivalent existing higher-level owner. `src/app/environment-lifecycle-authority-host.js` is the process-composition brick: by default it constructs the existing local environment operator inside the authority process, binds both capability endpoints around that one owner, and rolls back the read listener if the mutation listener cannot start.

That existing operator composition owns the declaration registry/journal, observation, lifecycle fence, construction/recovery pipelines, reset/recreate authorization, exact impact re-checks, verification, and superseded-generation retirement.

The broker must not dispatch destructive operations directly to `PersistentEnvironments` or provider adapters. Doing so would bypass the lifecycle safety owners even if the RPC itself were narrow.

The existing `EnvironmentOperator` destructive authorization subject is carried through the boundary; #177 does not invent another confirmation token. Possession of a plan string must not grant an ordinary model process access to the protected mutation endpoint. Endpoint access is a separate OS/local-policy authority.

## Platform authority model

The protocol/transport/host are necessary but not sufficient for #177. The authority process, mutation endpoint, provider-management capability, and protected storage must be separated by the OS/provider identity model.

### Windows / Hyper-V

Production setup must use a dedicated protected local identity that can run the Node authority host without granting the ordinary coding-model identity the same NTFS/Hyper-V authority. Candidate Windows primitives include a purpose-built service identity/per-service SID or a hardened scheduled-task identity/Task SID where that produces the required process and endpoint isolation. The exact mechanism remains subject to real Hyper-V positive/negative canaries; it must not be selected merely because it is convenient.

The selected identity must receive only the exact DevBridge-owned backing-store/provider rights required by the lifecycle authority, while preserving VMMS/platform service access. Ordinary coding/model processes must not inherit those rights. Named-pipe access policy must likewise distinguish bounded read/plan access from mutation authority as required by the final operating model.

### Linux / libvirt

Production setup should host the authority under a dedicated local identity. That identity receives only the required protected storage access and local libvirt authorization. Fine-grained libvirt/polkit authorization should be used where available so the ordinary user/model identity does not inherit broad libvirt read-write authority.

The setup/service owner must provision the `/run/devbridge/<authority-id>` runtime directory and socket permissions. Repository/model/guest processes must not receive the mutation socket, credentials, group membership, or provider-management capability as a side effect of normal execution.

## Composition rule

The ordinary installed process ultimately composes only the neutral authority client for protected lifecycle work. The protected authority process composes the existing `EnvironmentOperator` runtime, which in turn owns foundation/provider state and the lower lifecycle bricks.

Provider adapters remain replaceable Hyper-V/libvirt bricks behind neutral lifecycle/foundation studs. Provider-specific details must not be copied into controllers, CLI commands, repository routes, generalized operation manifests, or the authority wire contract.

Provider mutation reachable through lower foundation/control methods must also be moved behind the protected process before #177 is considered complete; protecting only backing-file deletion while leaving a parallel provider-control path would be an incomplete authority split.

The current ordinary CLI still constructs the local environment operator directly. That is a known migration point, not an accepted final fallback. Production composition must switch the environment CLI and relevant doctor/lifecycle inspection paths to the authority client once setup can provision and verify the protected authority. Protected mode must fail closed rather than silently recreating provider authority in the ordinary process.

## #176 coordination

The exact destructive impact/confirmation stud already exists in `EnvironmentOperator` and the reset/recreate lifecycle owners. #176 remains the operator UX owner. #177 reuses that subject and keeps its validation inside the protected lifecycle composition; it does not duplicate impact logic or accept an unbound `reset by name` request.

## Migration / rollout gates

Implementation is staged by ownership boundary:

1. **Protocol/transport/host brick:** closed operator-level request/result protocol; split read/mutation local capabilities; state-owned path-free endpoint namespace; protected host composition; adversarial tests proving lower provider/lifecycle mutation is not remotely addressable.
2. **Composition brick:** move protected lifecycle observation/mutation behind the authority client and make ordinary production composition fail closed when the protected authority is unavailable. No parallel in-process provider mutation path may remain for production.
3. **Windows authority brick:** protected identity, storage ACLs, bounded endpoint ACL, setup/recovery/uninstall behavior, and Hyper-V positive/negative canaries.
4. **Linux authority brick:** protected identity, storage ownership/mode, bounded local endpoint, narrow libvirt/polkit authority, setup/recovery/uninstall behavior, and libvirt positive/negative canaries.
5. **Setup/doctor migration brick:** detect legacy unprotected installations, report protection separately from provider readiness, migrate only exact DevBridge-owned state, and never seize foreign storage.

These are implementation seams, not permission to claim application-convention-only protection between stages. Final acceptance requires the real OS/provider negative and positive canaries in #177.

## Required final evidence

Repository tests must prove protocol bounds, forbidden-field rejection, explicit operator routing, lower-mutation unaddressability, split-capability enforcement, request/result ownership, fail-closed transport behavior, long-operation transport behavior, and preservation of the existing lifecycle safety owners.

Real provider qualification must additionally prove:

- ordinary Windows agent identity cannot directly delete/replace the exact DevBridge test VHDX or invoke provider-control mutation authority, while the authorized lifecycle can replace it;
- ordinary Linux agent identity cannot directly delete/replace the exact DevBridge qcow2/domain or invoke provider-control mutation authority, while the authorized lifecycle can replace it;
- protected authority restart/ambiguous effects reconcile through the lifecycle journal rather than widening privileges;
- foreign/operator VM/storage/network objects remain untouched;
- no coding model or repository guest needs elevation, root, sudo, Hyper-V management membership, libvirt management authority, or automatic protected-IPC credentials.

Until those OS/provider gates pass, #177 remains open and DevBridge must not describe the protocol/transport/host alone as backing-store protection.
