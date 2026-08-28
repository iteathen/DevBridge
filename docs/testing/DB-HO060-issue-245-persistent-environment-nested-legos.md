# DB-HO060: nested persistent-environment LEGO internals

Date: 2026-08-28

Issue: #245

Status: implementation planned; this document authorizes no setup, elevation, service, provider, image, VM, guest, or repository-execution effect.

## Assessment

`PersistentEnvironments` is the correct parent authority and caller-facing contract, but its 997-line implementation is one indivisible reasoning surface. The same file owns:

- the durable `devbridge/persistent-environments-v1` catalog;
- process-local serialization and cross-process lifecycle exclusion;
- request/source/observation validation and provider-port normalization;
- first-generation provisioning and ambiguous-effect recovery;
- read observation plus ordinary start/stop transitions;
- reset/reseed rotation, request-bound replace/recreate/rebuild, retained-generation history, and recovery;
- exact superseded retirement and current-generation removal; and
- generic pending-effect reconciliation.

The public tests already divide along these state-machine boundaries. A bounded generation-recovery change currently requires loading persistence, ordinary transition, removal, and unavailable-provider behavior into attention even though those mechanics have independent failure rules.

The parent contract must remain unchanged: `PersistentEnvironments` continues to own lifecycle authority and expose `ensure`, `list`, `observe`, `start`, `stop`, `reset`, `reseed`, `replace`, `recreate`, `rebuild`, `retireSuperseded`, `remove`, `reconcile`, and `protectedSourceIdentities`. `UnavailablePersistentOperations` and `PERSISTENT_ENVIRONMENTS_PROTOCOL` remain exported from the same module. Callers must not learn the nested topology.

DB-020 and `docs/execution-profile-environments.md` confirm that the opaque `subject` is composed from execution-profile identity. This structural change must not reintroduce repository-owned VM identity, provider names, physical storage paths, or repository topology. Exact attachment binding, immutable source lineage, generation identity/history, owned-provider observation, explicit destructive authority, and observe-before-repeat behavior remain parent-domain invariants.

## Primary-source research

- Node.js 22.16 states that promise-based filesystem operations are not synchronized or threadsafe and warns that concurrent modifications to the same file can corrupt data. Durable lifecycle mutations therefore continue through one explicit serialized/exclusive owner: <https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#promises-api>.
- Node.js maps `wx` to exclusive creation that fails when the path exists. The existing exact guard-file acquisition remains the cross-process exclusion primitive; there is no check-then-create replacement: <https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#file-system-flags>.
- Node.js advises opening the file directly and handling `EEXIST` rather than testing accessibility first because the latter creates a race. The extracted guard keeps that ordering: <https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#fsopenpath-flags-mode-callback>.
- Node.js requires explicit `FileHandle.close()` rather than relying on automatic descriptor cleanup, and `FileHandle.sync()` requests data flush to the storage device. Guard publication retains write, sync, and explicit close before protected work begins: <https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#class-filehandle> and <https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#filehandlesync>.
- Node.js defines `rename` as the single filesystem operation that replaces the destination path. Catalog publication retains write-to-an-exclusive temporary file followed by rename; this issue does not claim stronger crash durability than the existing contract: <https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#fspromisesrenameoldpath-newpath>.

## Reassessment

One file per method would create geometry without ownership. Conversely, extracting only generic helpers would leave the independent effect state machines coupled. The smallest coherent decomposition is:

1. A **durable ledger** owns the directory, exact catalog filename/protocol shell, revision advancement, temporary publication, process-local queue, cross-process exclusive guard, and guard-token release proof.
2. An **effect channel** owns the two injected external ports and converts their untrusted values into the neutral binding, resolved-source, observation, lifecycle, and removal contracts. It is the only nested piece that knows those external port shapes.
3. A **provisioning owner** owns ensure/reuse checks, first-generation planning, and provision completion/recovery.
4. An **ordinary lifecycle owner** owns current-entry observation/list projection and planned start/stop completion/recovery.
5. A **generation owner** owns reset/reseed rotation plus request-bound replace/recreate/rebuild state machines. Their shared invariant is generation change with exact old/new identity, durable switch, source lineage, and intentionally different superseded cleanup rules.
6. A **retirement owner** owns exact historical-generation retirement and current-generation removal/recovery.

The parent composes these pieces and retains public input normalization, stable identity derivation, exact entry lookup, generic pending-effect dispatch, protected-source projection, and the public API. Children import no sibling and receive only neutral local functions/ports such as `read`, `commit`, `observe`, `resolve`, `present`, `find`, `now`, and identity allocation. Replacing any child requires parent wiring changes, not sibling changes.

No compatibility wrapper, alternate catalog, legacy parser, or parallel implementation will remain. Code moves completely to its owner and is deleted from the parent.

## Scoped plan

1. Extract the durable ledger without changing filenames, protocol, revision behavior, exclusive-create guard, token verification, or error text.
2. Extract the effect channel without changing required provider/source methods, accepted observation/source fields, normalization, lineage checks, or optional quiesce semantics.
3. Move complete ensure/provision and ordinary observation/start/stop state machines behind separate closed contracts.
4. Move complete rotation/replacement/recreate/rebuild state machines behind one generation contract; preserve generic reconciliation's deliberate refusal to replay request-bound replace/recreate/rebuild effects.
5. Move exact superseded retirement and current removal behind one retirement contract.
6. Reduce `PersistentEnvironments` to public validation, identity/value rules, nested composition, generic reconciliation dispatch, and protected-source projection.
7. Add direct ledger/effect and nested-boundary tests. Extend the Stage 3 LEGO gate across every nested member. Retain all existing parent lifecycle/interruption/restart/ownership/lineage tests unchanged.
8. Run focused child and parent tests, repeated concurrency/recovery stress, repository preflight, the complete local suite, `git diff --check`, and hosted Windows/Ubuntu CI on the exact pushed commit before closing #245.

## Acceptance boundary

This is behavior-preserving structural work. It does not establish provider readiness, image readiness, profile provisioning, guest transport, repository execution, or the physical Windows/Linux C canary. During the operator's three-day no-UAC interval it performs no protected operation and requests no elevation.

## Implementation checkpoint

`PersistentEnvironments` remains the only public lifecycle authority and the sole nested composition point. Its implementation now contains public validation, stable identity/value rules, child wiring, pending-effect dispatch, and protected-source projection in 286 lines rather than containing every effect implementation.

The nested owners are:

- `ledger.js`: exact directory, `catalog.json`, `lifecycle.lock`, v1 state shell, revisioned publication, process-local sequencing, cross-process exclusion, and guard-token release proof;
- `effect-channel.js`: source/action port admission plus strict binding, source, observation, lifecycle-result, and lineage normalization;
- `provisioning.js`: ensure/reuse, first-generation planning, provider-effect observation, and ambiguous provision recovery;
- `ordinary-lifecycle.js`: current observation/list projection and planned start/stop recovery;
- `generation-change.js`: reset/reseed rotation and request-bound replace/recreate/rebuild, including exact old/new generation, durable switching, and each operation's existing retention rule; and
- `retirement.js`: exact superseded-history retirement and current-generation removal/recovery.

Only the parent imports these members. No child imports a sibling, and the child source gate rejects concrete provider, platform, repository, controller, or model topology. Moved implementations were deleted from the parent; there is no compatibility wrapper, legacy catalog parser, alternate state file, or parallel lifecycle implementation. The public exports and `devbridge/persistent-environments-v1` catalog shape are unchanged.

Added direct tests prove ledger publication/reload, local and cross-instance exclusion, guard-token substitution, normalized source/effect translation, foreign-field and identity substitution rejection, and source-lineage rejection. Parent tests additionally prove the exact durable v1 provision record, ambiguous removal recovery, and all existing provisioning, start/stop, reset/reseed, replacement, recreation, rebuild, retirement, attachment, lineage, concurrency, restart, and reconciliation behavior.

## Local evidence

- focused child/parent/LEGO suite: 34 passed, 0 failed;
- ten additional persistent-lifecycle recovery/concurrency repetitions: passed;
- repository preflight: 135 syntax files, 2 JSON files, and 133 targeted test files passed;
- complete repository suite: 1,686 total, 1,671 passed, 15 expected platform skips, 0 failed;
- external-topology source scan: no forbidden identity found;
- `git diff --check`: passed.

Hosted Windows and Ubuntu qualification on the exact pushed implementation commit remains required before #245 closes. No setup, elevation, service, provider, image, environment, VM, guest, or repository-execution effect occurred.
