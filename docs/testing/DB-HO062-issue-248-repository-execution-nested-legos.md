# DB-HO062: nested repository-execution LEGO internals

Date: 2026-08-28

Issue: #248

Status: implementation complete locally; hosted qualification pending. This document authorizes no setup, elevation, service, provider, image, VM, guest, or repository-execution effect.

## Assessment

`createRepositoryExecution` is the correct externally meaningful composition surface, but `src/app/repository-execution.js` currently interleaves five independently changing responsibilities in 425 lines:

- exact route subject/profile/environment selection and source-root admission;
- token-bound cross-process session exclusion;
- buffered input/output transfer adaptation and bounds;
- logical operation descriptor plus resource-bundle materialization; and
- stateful source synchronization, execution, candidate collection/import, and scratch cleanup.

The parent must retain production topology and authority: policy loading, protected activity attachment, bridge creation, route/foundation readiness, guest helper bytes/current logical locations, host file-tree authority, exact staging-root selection, protected-value projection, and construction of the sole public `RepositoryEnvironmentExecution`. No child may create a second execution implementation, select a provider, fall back to a host process, infer readiness, import candidate bytes without the parent-supplied bounded ports, or expose physical environment/access/path details.

The stable public request/result protocols remain in `src/runtime/repository-execution.js`; provider-neutral sequencing remains in `src/runtime/repository-environment-execution.js`; portable tree validation remains in `src/runtime/file-tree-transfer.js`; and route policy publication remains in `src/runtime/environment-activity-policy.js`. This issue does not duplicate or move those existing owners.

Existing integration and Stage-6 tests prove fail-closed no-route/no-activity behavior, exact compatible route selection, one active session, source resynchronization with ignored-cache persistence, host source-drift rejection, candidate import, logical transfer workers, built-in resource staging, Node/CMake/CTest flows, cancellation ordering, and absence of provider/direct-host topology.

## Primary-source research

- Node.js 22 documents that the exclusive `x` file flag fails when the path exists and maps create-exclusive behavior to the applicable operating-system primitive. The session child must retain direct `open(..., 'wx')` as its only acquisition mechanism rather than a check-then-create sequence: <https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#file-system-flags>.
- Node.js requires explicit `FileHandle.close()` and warns against relying on automatic descriptor cleanup. The extracted session owner must finish lock publication and close its handle on both successful and exceptional paths: <https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#class-filehandle>.
- Node.js documents that `Buffer.from(buffer)` copies an existing `Buffer` or `Uint8Array`, while the `ArrayBuffer` overload may share memory. Transfer boundaries will continue copying admitted bytes with the buffer overload before retaining or slicing them: <https://nodejs.org/download/release/v22.16.0/docs/api/buffer.html#static-method-bufferfrombuffer>.

## Reassessment

Moving only generic helpers would leave the source/candidate state machine coupled to routing and descriptor details. Moving the full `open` closure into one child would instead produce another oversized object that knows every sibling. The smallest coherent decomposition is:

1. A **route-access owner** receives only a normalized route value and neutral selection/observation/root ports. It resolves one stable subject to one compatible target and one canonical source root. It cannot load policy, create activity, or acquire a session.
2. A **session-guard owner** owns one hashed identity lock, exclusive creation, random token publication, exact token re-observation, idempotent release, and stale/conflicting fail-closed behavior.
3. A **byte-channel owner** adapts one opaque target's `put/get` port to bounded `write`, `read`, `ingest`, and `emit` actions. It knows no route, source tree, operation, or repository identity.
4. An **operation-materializer** validates resolved local program/resources, protected-value exclusion, transfer/location registration, bounded resource bundle staging, and descriptor staging through an injected byte-write action. It knows no target, route, bridge, workspace, or candidate.
5. A **workspace-session owner** owns the source/evidence state machine: prepare/synchronize, named input/output, bounded operation invocation, candidate eligibility and collection, host re-observation, staged apply, scratch cleanup, and close. It receives only neutral action/value ports and current helper/location values from the parent. It imports no sibling and cannot resolve routing or create a channel.

Only the parent composes the five children. Concrete helper locations, program/action names, policy module identity, protected activity adapter, file-tree functions, and operation-class mapping stay at the composition edge. Children import no local module or sibling and name no provider, platform, remote service, controller, model, or host fallback.

## Scoped plan

1. Extract exact route/access resolution without changing stable numeric subject validation, preferred-route selection, one-match requirement, compatible observation checks, or real-directory admission.
2. Extract the exclusive guard without changing lock naming, `wx`, token format/content, conflict/stale behavior, exact release check, or idempotence.
3. Extract byte ports while preserving copy behavior, contiguous output offsets, complete-buffer sink semantics, and the 16 MiB transfer bound.
4. Extract operation/resource materialization while preserving safe program/path rules, count/byte limits, digest-derived locations, transfer-registration checks, protected-value rejection, and the 8 MiB descriptor bound.
5. Extract the source/candidate session state machine behind injected neutral ports. Preserve all cancellation checkpoints, source digest re-observation, candidate exclusion for current probe classes, staging-before-apply, cleanup verification, and exact evidence identity.
6. Reduce `createRepositoryExecution` to validation, readiness/topology composition, immutable helper loading, staging-root creation, child wiring, and public adapter construction.
7. Add direct route/session/byte/materializer/session tests and a source gate proving no child imports a local implementation or contains provider, platform, remote, controller, model, direct-host, or sibling topology. Extend the Stage-6 gate across all nested files.
8. Run focused child and parent tests, repeated session/source/candidate stress, repository preflight, the complete suite, `git diff --check`, and exact hosted Windows/Ubuntu CI before closing #248.

## Acceptance boundary

This is behavior-preserving structural work. It does not execute repository code, establish provider readiness, build or start an environment, move source/candidate bytes through a physical guest, or prove the Windows/Linux C canary. During the operator's three-day no-UAC interval it performs no protected operation and requests no elevation.

## Implementation checkpoint

`createRepositoryExecution` remains the sole production topology and public-adapter composition edge. Its former route, session, byte-transfer, operation-materialization, and source/candidate-session mechanics now live in five closed nested owners. The parent supplies current policy/activity/helper/file-tree topology and all context-specific diagnostics; the children expose neutral local contracts, import no sibling or local implementation, and name no provider, platform, remote service, controller/model, bridge/helper implementation, or legacy/direct-host execution path. Moved code was deleted rather than retained through compatibility wrappers.

The behavior-preserving pass retained the exact existing externally observable diagnostics at the parent edge, including transfer framing/bounds, logical operation/resource validation, protected-value rejection, route availability, source/candidate drift, and cleanup failures. The byte owner copies admitted buffers; the session owner retains direct exclusive creation plus token re-observation; and candidate bytes still cross host validation and staging before apply.

Local qualification on 2026-08-28:

- direct child, parent integration, execution-contract, and Stage-6 boundary tests: 30/30 passed;
- broader Stage-6 execution, worker, transfer, scratch/isolation, and composition tests: 60 total, 58 passed, 2 expected Windows platform skips, zero failures;
- ten direct nested-owner repetitions and five real exclusive-session repetitions: all passed;
- repository preflight: 145 syntax files, 2 JSON files, and 135 targeted test files passed;
- complete suite: 1,701 total, 1,686 passed, 15 expected platform skips, zero failures;
- topology scan and `git diff --check`: passed.

No UAC request, protected operation, setup, service/provider/image/environment/VM/guest action, or repository-code execution occurred. Commit and push the exact checkpoint, then require hosted Windows/Ubuntu qualification before closing #248.

## Accepted hosted qualification

GitHub Actions run `33214619626` passed on exact implementation commit `b68078dfcae35526e143c2e8ce0146c08568fd41`: Windows serialized complete suite plus doctor, Windows preflight/identity/standalone-installer regression, Ubuntu complete suite plus doctor, and Ubuntu preflight/identity/standalone-installer regression all completed successfully. Issue #248 may close. The protected activation and physical dual-guest C canary remain separate later acceptance work and were not implied by this structural qualification.
