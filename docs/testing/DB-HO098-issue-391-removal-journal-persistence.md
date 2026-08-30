# DB-HO098 — Removal-journal persistence boundary

Date: 2026-08-30

Status: assessed, researched, and planned; implementation not started

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

