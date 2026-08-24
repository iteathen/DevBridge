# Environment lifecycle authority isolation

Status: active implementation design for issue #177. This document complements DB-020, `docs/vm-migration.md`, and `docs/vm-lego-studs.md`; it does not supersede them.

## Problem

The provider-neutral lifecycle already validates logical environment identity, current generation, source lineage, ownership evidence, lifecycle fencing, and durable transition state. However, the Hyper-V and libvirt persistent-environment adapters still execute provider mutation and delete their owned backing-store directories under the same ordinary Node/OS identity as the DevBridge control process.

That means application-level lifecycle checks are bypassable if an ordinary coding-model/agent process obtains the same host identity and directly mutates the backing store or provider. Recovery from #169 is valuable but is not prevention.

## Security invariant

Production provider VM/domain/backing-store mutation must be owned by a protected local lifecycle authority identity that ordinary repository/model/agent execution does not possess.

The intended composition is:

`ordinary control plane -> provider-neutral lifecycle client -> protected lifecycle authority -> existing PersistentEnvironments owner -> provider adapter -> Hyper-V or libvirt`

There is still one lifecycle semantic owner. The authority boundary is not a second reset/rebuild/delete API.

## Lifecycle authority protocol

`src/runtime/environment-lifecycle-authority.js` defines the provider-neutral request/result stud used across the process/OS boundary.

The request vocabulary is closed to the lifecycle operations already owned by `PersistentEnvironments`:

- ensure/list/observe/start/stop;
- reset/reseed/remove/reconcile;
- protected source identity observation;
- rebuild/replace/recreate;
- exact superseded-generation retirement.

Each operation accepts only its bounded provider-neutral identity/settings fields. Unknown fields are rejected before dispatch.

The protocol deliberately has no representation for:

- arbitrary filesystem paths or media locations;
- executable paths, shell, PowerShell, scripts, argv, or commands;
- raw Hyper-V/libvirt provider names or objects;
- VM/domain names;
- provider identity values supplied by the caller;
- unrestricted file operations.

Authority results are request-ID bound, size bounded, JSON-only, and reject provider-authority-shaped fields. Raw provider exceptions are not returned across the boundary.

Transport errors, result ownership mismatch, malformed envelopes, unknown operations, and oversized/authority-shaped results fail closed.

## Platform authority model

The protocol is necessary but not sufficient for issue #177. The transport endpoint and provider storage must be protected by the OS/provider identity model.

### Windows / Hyper-V

Production setup should host the lifecycle authority under a dedicated Windows service identity/per-service SID and grant that identity the required DevBridge backing-store rights plus the minimum Hyper-V management authority. Ordinary coding/model processes must not inherit those ACL/provider rights. Hyper-V/VMMS-required access must be preserved.

Windows service isolation/per-service SIDs are the preferred primitive because access can be granted to the service identity without granting the same object access to the caller's ordinary account.

### Linux / libvirt

Production setup should host the lifecycle authority under a dedicated local identity. The authority receives only the required protected storage access and local libvirt access. Fine-grained libvirt/polkit authorization should be used where available so the ordinary user/model identity does not inherit broad libvirt read-write authority.

Libvirt authorization remains local-socket based; repository/model/guest processes must not receive the authority socket/credentials as a side effect of normal execution.

## Composition rule

The ordinary control plane must eventually compose a lifecycle client at the existing lifecycle stud. The protected authority process composes the existing `PersistentEnvironments` lifecycle, image/source resolver, provider adapter, lifecycle registry/journal, and provider-native storage paths.

Provider adapters remain replaceable Hyper-V/libvirt bricks behind the same neutral lifecycle contract. Provider-specific details must not be copied into controllers, CLI commands, repository routes, or generalized operation manifests.

## #176 coordination

Issue #176 remains the owner of operator lifecycle UX and exact destructive impact confirmation. Issue #177 must consume the exact current lifecycle/impact subject when that contract lands. The authority boundary must not invent a second approval token or accept an unbound `reset by name` request.

## Migration / rollout gates

The implementation is intentionally staged by ownership boundary:

1. **Protocol brick:** closed provider-neutral lifecycle authority protocol/client/dispatcher with adversarial boundary tests.
2. **Composition brick:** move ordinary lifecycle calls to the client stud and move provider-native lifecycle/source state behind the protected host composition. In-process provider mutation must become test/development-only and production fail-closed.
3. **Windows authority brick:** dedicated service identity, protected storage ACLs, bounded endpoint ACL, setup/recovery/uninstall behavior, and Hyper-V positive/negative canaries.
4. **Linux authority brick:** dedicated local identity, protected storage ownership/mode, bounded local endpoint, narrow libvirt/polkit authority, setup/recovery/uninstall behavior, and libvirt positive/negative canaries.
5. **Setup/doctor migration brick:** detect legacy unprotected installations, report protection state separately from provider readiness, migrate only exact DevBridge-owned state, and never seize foreign storage.

These are ownership boundaries, not permission to ship an application-convention-only security claim between stages. Final acceptance requires the real OS/provider negative and positive canaries in issue #177.

## Required final evidence

Repository tests must prove protocol bounds, forbidden-field rejection, explicit operation routing, request/result ownership, fail-closed transport behavior, and preservation of lifecycle fencing/ownership semantics.

Real provider qualification must additionally prove:

- ordinary Windows agent identity cannot directly delete/replace the exact DevBridge test VHDX, while the authorized lifecycle can replace it;
- ordinary Linux agent identity cannot directly delete/replace the exact DevBridge qcow2/domain, while the authorized lifecycle can replace it;
- protected authority restart/ambiguous effects reconcile through the lifecycle journal rather than widening privileges;
- foreign/operator VM/storage/network objects remain untouched;
- no coding model or repository guest needs elevation, root, sudo, Hyper-V management membership, or libvirt management authority.

Until those OS/provider gates pass, issue #177 remains open and DevBridge must not describe the protocol alone as backing-store protection.
