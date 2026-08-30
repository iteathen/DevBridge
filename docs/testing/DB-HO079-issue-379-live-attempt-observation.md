# DB-HO079: exact live-attempt observation during journal publication

Date: 2026-08-29

Issue: #379

Status: locally implemented and qualified; hosted acceptance pending. No setup, elevation, protected-service, provider, VM, guest-transport, repository-execution, product-release, or model effect is authorized by this document.

## Assessment

GitHub Actions run `33289350133` qualified documentation-only head `07c8c14e1857be46ae227c3bdcb2521282727138`. Windows smoke/full and Ubuntu smoke passed, but Ubuntu full failed `fast children cannot exit before their completion hooks become authoritative`. One of sixteen concurrent requests returned:

```text
bridge operation attempt identity is incomplete
operationState=planned attemptExists=true activityCount=1
```

The exact implementation commit immediately below that documentation-only head, `ddda1fc4248db505d8be2941fb83f13f8e4c8697`, had already passed the complete four-job run `33289229145`. The docs change cannot alter bridge execution. This is timing-sensitive evidence in the existing Stage 6 guest bridge and is tracked separately rather than attributed to the accepted Linux plan-selection brick.

The operation transition is currently three separate publications:

1. `activity.claim(identity, token)` exclusively creates and fully writes a permanent attempt fence containing the exact opaque token.
2. `activity.publish(identity, token)` atomically publishes a current activity record bound to that token.
3. The operation journal atomically changes from `planned`/no token to `attempting`/that token.

The bridge deliberately retries a cross-file mismatch for 5/10/20/40/80/160 milliseconds. If step 3 is delayed beyond that fixed window, a `planned` observation asks only whether the fence exists. The activity owner returns a Boolean, so the caller discards the complete fence's exact token and cannot correlate the already-current activity record. It reports `indeterminate` even though the exact winner is currently observable.

The immutable fence remains necessary. A planned record plus any fence means execution may have crossed into side effects, so the request must never be replayed or the fence reclaimed. A partial, malformed, substituted, missing-activity, stale-activity, or otherwise unverifiable fence/activity pair must remain indeterminate.

## Ownership boundary

`src/guest/activity-store.mjs` owns both the attempt fence schema and the token-bound activity schema. It is therefore the only module that can safely correlate those records without leaking its token/file topology into the bridge controller. Its interface must remain neutral and return only bounded local observation states.

The bridge owns the durable operation journal and maps a neutral current transition to its public nonterminal state. It must not parse activity filenames, import activity schemas, probe process identifiers, lengthen a timeout as the sole fix, or gain provider/repository/controller/transport knowledge.

## Primary-source research

- Node.js 22.16 documents that promise-based filesystem operations use the thread pool and are not synchronized or thread-safe; concurrent modifications of the same data require application-owned sequencing: <https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#promises-api>.
- Node.js 22.16 documents `fsPromises.open()` as the source of a file handle and requires explicit handle closure rather than relying on automatic cleanup: <https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#fspromisesopenpath-flags-mode>.
- Node.js maps `wx` to exclusive creation and documents failure when the path already exists. The permanent fence's exclusive claim remains the correct exact-effect acquisition primitive: <https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#file-system-flags>.
- `fsPromises.rename()` fulfills only after the requested rename completes, but the operation journal and activity publications are independent calls and no cross-file transaction is supplied: <https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#fspromisesrenameoldpath-newpath>.

## Reassessment

Increasing the 315 millisecond retry budget would only move the failure boundary and would ignore exact current-owner evidence already durably available. Reordering the journal before activity would create the inverse interval: a token-bearing nonterminal journal with no current activity. Combining all records into one file would enlarge the activity owner's responsibility into the operation journal and disrupt independent heartbeat replacement.

The smallest complete design is a store-owned aggregate observation for the no-token transition:

- no attempt path returns `absent`;
- an exact fence whose exact token names a strictly valid current activity record returns `current`;
- every existing but partial, malformed, substituted, absent-activity, stale-activity, or invalid-activity condition returns `indeterminate`.

The store returns no token, path, timestamp, or raw error. The bridge maps `absent` to `planned`, `current` to the existing public `running` observation, and `indeterminate` to the existing bounded incomplete-attempt reason. Terminal operation records remain authoritative. Token-bearing `attempting`/`running` records continue using exact-token inspection. The bounded reread schedule remains useful for honest partial publication, but correctness no longer depends on completing journal publication within that duration.

## Scoped plan

1. Replace the activity store's Boolean fence query with a closed aggregate observation that strictly validates the fence and its exact current activity.
2. Keep exclusive claim, permanent fence retention, token-bound heartbeat publication/removal, freshness bounds, and exact-token inspection unchanged.
3. Update planned-state bridge observation to consume only `absent`, `current`, or `indeterminate`; expose no token or file topology.
4. Add direct tests for absent, exact-current, partial/malformed, substituted-token, missing, stale, invalid, and symlink-shaped evidence.
5. Add a bridge-level planned/current transition proof while retaining incomplete-fence non-replay and exact-token running tests.
6. Repeat the sixteen-fast-child stress test, then qualify focused tests, repository preflight, architecture gates, the complete suite, doctor, generated artifacts, and diff hygiene under current and exact supported Node where material.
7. Commit and push the exact checkpoint, require hosted Windows/Ubuntu acceptance, update/close #379 only if the exact head passes, and then resume the lower-to-higher Linux protected-authority plan.

## Acceptance boundary

This repair proves only guest-local exact-effect observation and recovery behavior in deterministic and hosted operating-system tests. It does not prove a VM provider, image, bridge transport, protected setup/service, physical guest, C toolchain canary, or repository-execution route. It performs no UAC/sudo or protected/physical operation.

## Implementation checkpoint

The activity store now owns one closed aggregate observation. It validates the complete immutable fence schema, reads only the exact token named by that fence, delegates to the same strict freshness/shape check used by token-bearing journal records, and returns only `absent`, `current`, or `indeterminate`. The prior Boolean `attempted` interface was deleted; no compatibility surface remains. The bridge maps current transition evidence to its existing public running state while preserving incomplete-attempt indeterminacy and the permanent non-replayable fence.

Direct tests cover absent, partial, widened, non-string-token, symbolic, missing-activity, mismatched-token, stale, invalid, exact-current, removal, and bridge-level planned/current evidence. Focused current-Node and exact Node 22.16.0 bridge/activity tests pass 29 total / 28 passed / 1 expected Windows symbolic-link skip. The full payload/LEGO set passes 41 total / 40 passed / 1 expected skip. Twenty additional sixteen-request fast-child repetitions pass.

Current and exact Node 22.16.0 repository preflights both pass the unchanged 2 standalone artifacts / 205 syntax files / 2 JSON files / 168 targeted-test files. Architecture gates pass 34 total / 33 passed / 1 expected Windows skip. The complete serialized suite passes 1,849 total / 1,832 passed / 17 expected platform skips / zero failures in 193.8 seconds. Doctor reports `ok: true`, coding adapters remain disabled, and repository execution remains explicitly unavailable because no persistent-environment routes are configured. Standalone/identity tests pass 3/3 and diff hygiene passes. Commit and push the exact checkpoint, then require all four hosted Windows/Ubuntu jobs before closing #379.
