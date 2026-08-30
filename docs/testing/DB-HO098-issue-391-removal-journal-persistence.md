# DB-HO098 — Removal-journal persistence boundary

Date: 2026-08-30

Status: implemented and locally qualified; exact-head hosted acceptance pending

Coordinates with: #391, DB-003, DB-009, DB-011, DB-020, and DB-HO095.

GPU/CUDA work is outside this checkpoint.

## Scope and authority

This checkpoint owns the next primitive beneath the neutral application-removal coordinator: one durable, locally serialized, revision-checked record boundary. It may refactor already-neutral local durability bricks out of a setup-specific source path, add a generic revisioned record store, strengthen the coordinator's injected journal stud, and add persistence/concurrency/restart tests.

It does not own artifact inventory, filesystem deletion, application producer registration, CLI routing, setup/elevation, service refresh, provider/image/environment/VM/guest lifecycle, repository execution, legacy Stage-0 retirement, or GPU/CUDA work. No production removal route or live removal effect is authorized.

## Assessment

The accepted first slice at `2bbc9d71acb4cdd1a2299e4a2781d4fb30421879` gives each journal record a strict monotonic revision and requires `load(mode)` plus `save(mode, record)`, but its tests use only an in-memory map. A naive file adapter would leave two correctness gaps:

1. a stale writer could replace a newer revision unless comparison and replacement occur inside one local exclusive-mutation boundary; and
2. two removal coordinators could persist the same next revision idempotently and both execute the same external effect unless one local owner holds admission across the complete observe/attempt/reconcile loop.

The repository already has suitable lower bricks in `src/state/setup-authority-state-store/`: a neutral OS-local exclusive-mutation primitive and a neutral flushed temporary-record replacement primitive. Their implementations contain no setup concepts, but their location makes a reusable state component reference a foreign owner identity. That topology violates the LEGO boundary even though the file bodies are neutral.

`JsonStateStore` is not suitable for this journal. It caches one process-local document, serializes only within that instance, writes without an explicit file flush/exact reread, and does not provide revision comparison. It remains valid for its existing lower-risk owners but cannot substantiate this destructive recovery boundary.

The existing JSON record primitive also treats a syntactically valid non-object root as an empty document. At a removal journal boundary, corrupt or substituted state must fail closed rather than be overwritten as absence.

## Primary-source research

The [Node.js 22.16 filesystem promises documentation](https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#promises-api) states that promise filesystem operations are not synchronized or threadsafe. The [`FileHandle.sync()` contract](https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#filehandlesync) requests that in-core data be flushed to storage, while [`fsPromises.rename()`](https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#fspromisesrenameoldpath-newpath) is a separate rename operation.

Reassessment: process-local promise ordering is not ownership. The store must use the existing OS-local exclusive-mutation primitive, write one unique file, flush it, close it, rename it, and reread the exact accepted bytes. Rename success alone is not the durable acceptance claim. The record root must be a strict object, and an unexpected current revision must fail rather than retry or overwrite.

Microsoft separately documents replacement and write-through as distinct [`MoveFileEx`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexa) flags. Node does not expose that exact flag composition through `fsPromises.rename()`. Reassessment: retain the platform-neutral flush/rename/exact-reread claim already accepted in DB-HO095; do not overclaim filesystem or power-loss atomicity that the adapter cannot prove.

## Ownership reassessment

The persistence component should know only a bounded local subject, an opaque record object with a positive revision, and a callback. It must not import the application-removal module or name uninstall modes, artifacts, paths, providers, repositories, VMs, services, or setup concepts.

The application-removal coordinator should know only that its journal port can admit one bounded subject into an exclusive local session. The session exposes `load()` and `save(record)` for that subject. The coordinator remains the sole owner of record schema, effect phases, and recovery meaning; the store owns serialization, revision comparison, exact replacement, and contention.

Holding local admission across the whole effect loop is intentional. It does not pretend the filesystem lock makes an external effect atomic. It prevents concurrent local callers from attempting the same effect while the durable DB-009 phases continue to provide crash recovery. A crashed process releases OS-local admission; the next caller reloads and observes the exact durable phase before acting.

## Primitive-to-high-level implementation plan

1. Move the two already-neutral durability bricks to neutral state ownership and update the setup authority adapter/tests to consume those neutral studs. Delete the old setup-nested files; do not leave compatibility copies.
2. Make the JSON-record reader reject a valid JSON root that is not an object. Preserve unique create, file flush, close, rename, exact reread, and exact temporary cleanup.
3. Add one generic revisioned record store with a single `run(subject, operation)` stud. The store validates bounded subject/revision shape, acquires OS-local exclusive admission for its exact file, supplies subject-bound `load()`/`save()`, accepts only absent→revision 1 or exact +1 transitions, reconciles an identical already-accepted revision, and rejects stale/conflicting/skipped revisions.
4. Change the removal coordinator's injected journal contract from free `load/save` calls to one exclusive `run(mode, operation)` session. Keep all filesystem and state-store identity outside the module. Update fake-port tests without adding an optional legacy path.
5. Compose the generic store with the neutral coordinator only in boundary tests. Prove restart after interrupted attempt, no replay after exact absence, cross-instance contention, idempotent accepted-save reconciliation, stale/conflicting revision rejection, mode isolation, corrupt-root fail-closed behavior, and lock release after failure.
6. Run focused current/exact Node 22.16 tests, preflight, architecture/product/standalone gates, the complete serialized suite, doctor, generated-artifact/diff hygiene, and exact-head hosted Ubuntu/Windows smoke/full plus doctor.
7. Document the implementation and acceptance evidence. Keep #391 open. The next primitive remains the exact artifact-effect adapter and first neutral producer; no CLI is exposed until mode coverage is complete.

## Nonclaims

- This checkpoint does not create a distributed lease or multi-host uninstall authority.
- It does not make external removal effects transactional or exactly once.
- It does not authorize recursive cleanup or infer ownership from a filename.
- It does not make application or purge mode available to users.
- It does not refresh the protected service or touch a provider, VM, guest, repository workload, model adapter, or GPU/CUDA feature.

## Implementation

The implementation moves `exclusive-mutation.js` and `json-record-file.js` from the setup-specific child path to neutral `src/state` ownership and updates the setup authority adapter to consume those same studs. The old files are deleted; no forwarding modules or compatibility copies remain. The JSON record reader now rejects a valid JSON scalar, array, or null root instead of converting corrupt state to an empty document.

`revisioned-record-state-store.js` is a generic local component. Its only public stud is `run(subject, operation)`. It validates a bounded neutral subject, acquires one OS-local exclusive mutation lease for the exact record file, and supplies a subject-bound session with `load()` and `save(record)`. Records must be exact JSON objects with positive safe-integer revisions. The store accepts only absent-to-revision-1 or exact +1 transitions, reconciles an identical already-accepted revision, and rejects conflicting, stale, skipped, non-JSON, or corrupt records. Each changed record uses the existing unique create, file flush, close, rename, exact reread, and temporary cleanup sequence.

The application-removal journal stud now requires `run(mode, operation)` rather than free-standing `load/save`. The coordinator performs the complete plan revalidation and observe/attempt/observe/reconcile loop inside the injected session. This keeps the coordinator free of filesystem/locking identity while preventing two local processes from entering the same effect loop concurrently. A crash still releases only the local lease; recovery meaning remains in the durable DB-009 record and the next caller re-observes before acting.

Boundary tests prove:

- exact revision advancement, accepted-write idempotency, stale/skipped/conflicting rejection, subject isolation, and corrupt-root fail-closed behavior;
- local cross-instance serialization, bounded lock release after failure, and exact temporary-file cleanup;
- an exact record written by one process and loaded by a fresh process;
- a fresh removal coordinator reconciling an interrupted attempted effect from durable state without replay; and
- two independent coordinators producing only one exact effect attempt while the second waits and returns the terminal receipt.

The argument-driven process fixture initially failed the complete suite because Node's default test discovery executes `.mjs` files beneath `test/`. The fixture now follows the repository's existing fixture convention: no arguments means import-safe no-op, while an explicit action enters the bounded fixture path and invalid actions fail. This is test topology only and does not change product behavior.

## Local qualification

- current and exact Node 22.16.0 focused removal/state/setup qualification: 33/33 passed;
- exact Node 22.16.0 bounded preflight: 2 standalone artifacts, 226 syntax files, 2 JSON files, and 183 targeted test files;
- exact Node architecture/product/standalone gates: 37 total / 36 passed / 1 expected Windows symlink skip;
- complete exact Node 22.16.0 serialized suite on final bytes: 1,983 total / 1,962 passed / 21 expected platform skips / zero failures in 189.3 seconds;
- standalone artifact regeneration check and diff hygiene: clean; and
- exact Node doctor: `ok: true`, coding adapters disabled, environment setup re-entry still required, and repository execution unavailable/fail-closed because no route is configured.

Plan head `12f3a37e14b979fc3eda47fa3f4f55078f952ffd` passed all four hosted Ubuntu/Windows smoke/full jobs plus doctor in [run 33312776472](https://github.com/iteathen/DevBridge/actions/runs/33312776472). Commit and push the exact implementation, then require its complete hosted matrix before treating this slice as accepted. #391 remains open; no production composition, inventory producer, artifact effect, CLI route, or live removal authority exists.
