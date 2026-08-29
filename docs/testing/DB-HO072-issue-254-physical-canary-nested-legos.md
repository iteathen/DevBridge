# DB-HO072 — Issue #254 physical-canary nested LEGO plan

Date: 2026-08-29

Status: assessed, researched, and planned; implementation pending

## Scope and governing contracts

Issue #254 is the remaining open child under the nested-LEGO parent #244. Its scope is the physical Ubuntu image canary composition in `src/app/ubuntu-production-image-physical-canary.js`. The public status/run surface and current Hyper-V/Ubuntu composition topology must stay in that parent. Only substantial local mechanics may move into replaceable, independently testable children.

The mandatory VM planning gate was completed before editing. The following live material was read:

- DB-003, DB-008, DB-009, DB-011, DB-013, DB-015, DB-017, DB-018, DB-019, and DB-020;
- `docs/vm-migration.md`, `docs/vm-lego-studs.md`, `docs/ubuntu-physical-image-construction.md`, `docs/lego-module-contract.md`, and `docs/nested-lego-restructuring.md`;
- the complete physical-canary parent and all direct canary, construction, setup, release-authority, and composition tests;
- the current repository-preflight registration;
- open issue #254 and independently filed correctness issue #375.

This change is software-only. It does not authorize setup, installation, UAC/sudo, service or provider mutation, image/environment creation, VM/guest access, repository execution, or a physical canary run. The operator's no-UAC interval remains binding.

## Exact baseline and inventory

Assessment is bound to branch `stage8/362-protected-activity-channel` at `465f89f3b9e8d203ce791b6bd1352df5bab5af9b`.

The focused physical-canary, construction, setup-composition, and release-authority baseline passed 31/31 with zero failures. This is behavior evidence only; no provider or guest was contacted.

The current parent is approximately 619 lines and owns five separable mechanics in addition to its valid composition responsibility:

1. configuration validation and derivation of local durable paths;
2. bounded preparation-receipt normalization, exact regular-file/digest evidence, and access-seed validation;
3. exclusive mutation admission and cleanup of `run.lock`;
4. completed-state release/discard aggregation;
5. the bounded phase/progress loop that translates neutral observations into waiting, blocked, or completed results.

The parent also owns public request/status projection, durable current identity, and the concrete construction/provider/access/release topology. Those are not generic mechanics and remain in the parent.

## Correctness finding: mutation cleanup is not exact-owner bound

The current `withRunLock` path correctly uses exclusive create, writes and syncs the current PID, and makes any pre-existing path fail closed. Its `finally` block then removes the pathname unconditionally. If that path has been removed and replaced while work is in progress, the current owner can delete a foreign/replacement record it never acquired.

Issue #375 now owns this correctness prerequisite. It is intentionally separate from #254 so the semantic change is reviewable and cannot be mistaken for a purely structural move.

The correction will:

- retain exclusive create and the current conflict diagnostic;
- write one versioned, bounded record carrying an unpredictable token and PID, then sync it;
- retain the acquired regular-file identity from the open handle;
- on release, re-observe the exact regular-file identity and exact record bytes;
- unlink only when both observations still match the acquired owner record;
- preserve a missing, malformed, symlink, non-regular, or replacement path;
- never parse an old PID-only record to reclaim it and never infer stale ownership.

This is conservative cleanup, not an atomic compare-and-unlink primitive. Node exposes no cross-platform atomic pathname compare-and-delete operation. The state root remains host-control-owned, and the implementation will make no stronger adversarial-filesystem claim than exact re-observation immediately before removal.

## Primary research

Node.js 22 documents the filesystem primitives that define this boundary:

- the `wx` flag behaves like `w` but fails when the path already exists;
- on Windows, exclusive create maps to the corresponding `CreateFileW` exclusive-creation behavior;
- exclusive creation may be unreliable on some network filesystems, so the lock root remains a local host-control path rather than a remote coordination primitive;
- `FileHandle.sync()` requests that the operating system flush file data to storage, subject to OS/device behavior;
- file handles must be explicitly closed;
- `lstat()` observes the link itself rather than dereferencing a symbolic link;
- file read streams close their file descriptor by default.

Source: [Node.js 22 filesystem API](https://nodejs.org/docs/latest-v22.x/api/fs.html).

These facts support preserving the existing local exclusive-create admission, flushing the owner record, using `lstat` for non-following release observation, and explicitly closing the acquired handle. They do not support stale-owner inference, network-lock claims, or unconditional cleanup.

## Reassessment and selected structure

Do not extract concrete topology merely to reduce the parent's line count. Provider, image, bridge, construction, access, and release composition belong together in the application parent because that is where the current wiring is selected. Moving those names into a child would create exactly the boundary leak #254 is meant to remove.

Use five children below `src/app/ubuntu-production-image-physical-canary/`:

1. `configuration-contract.js`
   - owns local input validation and derived state paths;
   - receives protocol/limits and the authority-value normalizer;
   - imports only Node's path API and names no provider, image, guest, repository, or sibling.
2. `preparation-contract.js`
   - owns bounded receipt normalization, exact regular-file digest checks, and bounded seed reading;
   - receives expected protocol/media/network/access values from the parent;
   - imports only Node filesystem/crypto/path APIs and names no current topology.
3. `mutation-lease.js`
   - owns local exclusive admission and exact-owner release for one pathname;
   - receives the local protocol and current conflict message;
   - exposes no arbitrary command, provider, path-root selection, or stale-reclaim authority.
4. `completion-reconciliation.js`
   - runs all parent-supplied neutral release actions and returns bounded failure reasons;
   - learns no address, SSH, provider, environment, image, or VM identity.
5. `progress-coordinator.js`
   - owns the bounded phase loop and neutral waiting/blocked/completed projection;
   - consumes only local operations such as inspect, advance, observe, resolve, capture, reconcile, and clock;
   - receives any context-specific diagnostic text from the parent and names no current provider or guest topology.

Only `src/app/ubuntu-production-image-physical-canary.js` composes those children. It remains the sole public surface and the only module that imports/names the concrete construction canary, persistent provider, image source, access material, environment state, and release actions. It retains the exact public request/status/result values and phase-to-topology wiring.

No child imports another child or any local implementation. No broad parent/runtime object crosses a child boundary. Each child accepts only the values and actions required by its own contract. Moved implementation is deleted from the parent; no wrapper around a duplicate/legacy implementation remains.

## Dependency-ordered implementation plan

1. Extract configuration and preparation contracts first because they are pure admission/evidence prerequisites. Preserve every accepted/rejected value and exact-file check.
2. Implement #375 as the isolated mutation-lease child. Add direct normal, failure, pre-existing, malformed, replacement, and concurrent-owner proofs without any provider operation.
3. Extract completion reconciliation as an action-list owner. Prove every action is attempted and all bounded failures are returned without learning the action's external identity.
4. Extract the bounded progress coordinator. Preserve the existing phase ordering, timeout/liveness behavior, access readiness, console capture conditions, and outward result values.
5. Reduce the parent to public validation/projection plus explicit concrete topology composition. Delete all moved mechanics.
6. Add one targeted nested-LEGO test that imports every child, verifies independent source/data-URL loading where applicable, rejects sibling/local imports and foreign topology names, and proves only the parent names the complete current topology.
7. Register the parent, child syntax, and one targeted nested test in repository preflight. Avoid redundant per-child test processes at the fixed Windows cheap-preflight boundary tracked by #290.
8. Run focused tests, repeated failure/recovery tests, repository preflight, complete suite, doctor, topology searches, and `git diff --check`.
9. Document exact implementation evidence, commit/push the branch, require exact-head hosted Windows and Ubuntu acceptance, and close #375/#254 only if their exact contracts are proved. Update #244 without claiming physical readiness.

## Explicit nonclaims

This work does not refresh or mutate the protected Windows service, install/configure a provider, create or start a VM, reach a guest, run the Windows/Linux C canaries, prove Hyper-V/libvirt behavior, enable repository execution, merge the Stage-8 branch, or implement GPU/CUDA behavior. Hosted CI and mock/fake composition cannot substitute for the later real-provider Stage-7/Stage-8 acceptance.

