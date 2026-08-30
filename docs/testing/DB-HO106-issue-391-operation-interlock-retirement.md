# DB-HO106 — Removal interlock, receipt retirement, and operation rotation

Date: 2026-08-30

Status: planned

Coordinates with: #116, #159, #180, #391, DB-003, DB-009, DB-011, DB-019, DB-020, DB-HO095, DB-HO098, DB-HO099, DB-HO100, DB-HO101, DB-HO103, DB-HO104, and DB-HO105.

GPU/CUDA work is deferred and outside this checkpoint.

## Scope and nonclaims

This checkpoint owns the primitive interlock and lifecycle needed before an application-removal composition can safely become reachable. It covers one neutral same-owner activity transaction, launch-to-removal mutual exclusion, exact terminal ownership-receipt retirement, durable binding retirement/reuse, and completed-removal operation rotation.

It does not expose an uninstall command, complete application or purge producer coverage, remove the live installation, infer authority for legacy Stage-0 state, alter configuration/PATH/service/provider/environment state, request elevation, start or mutate a VM/guest, execute repository code outside the existing runner path, invoke a model adapter, or implement GPU/CUDA features. Full purge remains separately gated by real Hyper-V and KVM/libvirt lifecycle evidence.

## Accepted baseline and assessment

The isolated branch is clean and remote-equal at `2e82085d960c8f7af1ac9ae10214df961fe00117`. Exact implementation and CI-contract head `5497c46e4f55a9ab734538eb79bac138ddc6baf8` plus the documentation head passed Ubuntu smoke/full and Windows bounded-smoke/serialized-full, architecture gates, standalone regression, and doctor in runs [33331176770](https://github.com/iteathen/DevBridge/actions/runs/33331176770) and [33331392458](https://github.com/iteathen/DevBridge/actions/runs/33331392458).

The accepted ownership stack is intentionally read-only. Its remaining gaps are now exact:

- runner preparation holds the cache-local activity lease, but the returned launch path releases that lease before revalidation and process execution;
- inventory only observes activity. A removal coordinator can observe inactivity and then race with a launch or installation before its first effect;
- locking each effect independently would still permit a launch between effects and would not protect a multi-owner removal transaction;
- completed ownership receipts remain in their append-only journals after exact payload absence, so the producer no longer has a complete absent topology;
- durable effect bindings have no terminal phase, so a later reinstall of the same logical item cannot safely bind a new source generation;
- a completed removal journal rejects every different plan digest, so a later exact reinstall/removal cycle cannot start; and
- retiring one receipt while other payload effects remain would change the aggregate plan mid-operation. Receipt retirement must therefore be a second phase after every removal effect is reconciled absent.

The shared activity roots, immutable receipt journals, conditional item collection, exact private action descriptors, revisioned binding store, DB-009 removal journal, and provider-local launch verification already provide the lower bricks. No new global lock, recursive deletion path, pathname inference, provider identity, or compatibility implementation is needed.

## Primary-source research

- [Node.js 22.16.0 process documentation](https://nodejs.org/download/release/v22.16.0/docs/api/process.html#processkillpid-signal) specifies that signal `0` tests whether a process exists and has no effect when it does. Reassessment: the existing process-backed lease may conservatively classify a live/reused PID as active, but it must never treat that observation as proof of artifact identity or deletion authority.
- [Node.js 22.16.0 child-process documentation](https://nodejs.org/download/release/v22.16.0/docs/api/child_process.html#child_processspawnsynccommand-args-options) specifies that `spawnSync()` blocks until the child exits or is terminated. Reassessment: a lease around the complete launch callback covers the current synchronous production runner, while the neutral transaction must also `await` an injected asynchronous launch before release.
- [Node.js 22.16.0 filesystem promises](https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#promises-api) states that promise filesystem operations are not synchronized or threadsafe. Reassessment: a read-only activity observation cannot close the admission race. Every contributor required by a removal mode must hold its own local transaction for the complete coordinator operation, acquired in deterministic neutral-identity order.
- [Microsoft DeleteFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-deletefilew) documents that ordinary deletion can fail when another handle lacks delete sharing, may remain pending until the last handle closes, and deletes a symbolic link rather than its target. Reassessment: the activity transaction is coordination, not filesystem authority. Exact held-handle/reparse identity checks and post-effect absence observation remain mandatory, and sharing/lock outcomes remain failures to reconcile rather than permission to widen cleanup.

## Ownership reassessment

The neutral activity brick owns only a local root, one operation callback, a process-bound record, and same-operation re-entry. It does not know whether the protected action is installation, launch, inventory, or removal. A local composition may translate its errors and choose its root; callers receive no path or token.

The aggregate source owns only contributor identities, mode requirements, deterministic nesting, and snapshots. It may require each contributor to run one callback under its own local activity boundary. It does not know paths, receipt protocols, artifacts, providers, repositories, or current topology. Inspection remains read-only; mutation runs only after every required contributor supplies the transaction stud.

An inventory owns its private binding lifecycle. A bound record retains the exact source generation, item, plan, and action descriptor. Retirement is permitted only after the exact terminal action observes absent under the held activity transaction. For receipt-backed sources, the source removes only the exact expected completed receipt through conditional generation CAS, preserves the immutable journal history/control anchor, and refuses a changed or reinstalled item. The binding then advances to `retired`; a later source generation may replace it with a new bound revision, while the same generation cannot be resurrected.

The application coordinator owns DB-009 sequencing. It removes and reconciles every effect first. It then enters a separately persisted retirement sweep over terminal effects. A crash after receipt retirement but before the journal save repeats only the idempotent exact retirement. The source plan is no longer required to remain unchanged during this second sweep because its intended effect is to change producer generations. Only after the sweep is terminal may a different exact current plan rotate the completed journal into a new operation revision.

## Primitive-to-high-level implementation plan

1. Extend the neutral process activity lease with one awaited callback transaction and same-operation observation/re-entry. Preserve direct acquire/observe as the lower primitive, but move production owners to the callback so release is structurally in `finally`.
2. Expose local transaction studs from the Permanent Entry and runner-cache owners. Hold the runner-cache transaction around exact launch revalidation and the complete launch callback. Do not move launch semantics, paths, subjects, or process objects into the neutral lease.
3. Require every application-removal contributor to provide one neutral transaction callback. The aggregate source acquires the required contributors in sorted identity order and runs the complete removal journal session inside them. Read-only inspection does not acquire or mutate.
4. Add exact receipt retirement to the neutral receipt-value source over its conditional collection. Require the original source generation and exact projected item; remove only the matching completed receipt; treat exact absence as idempotent; reject a present item under any changed generation.
5. Add `bound` and `retired` phases to exact dynamic-value bindings. Retire only after exact action absence and source retirement, persist the transition, keep old binding evidence loadable for interrupted coordinator recovery, and permit replacement only from a distinct later source generation.
6. Give the bound-effect bridge one neutral terminal-retirement operation. It must load the exact bound action and delegate retirement to the owning catalog without exposing private descriptors.
7. Extend the application-removal journal with an explicit post-effect retirement cursor/phases. Persist intent before each terminal retirement, resume idempotently without replaying deletion, complete only after all terminal bindings retire, and rotate a completed record only when a newly confirmed exact current plan has a different digest.
8. Apply the same binding-rotation contract to the earlier single-artifact inventory fixture so the lower reusable action path has one lifecycle rather than a retained compatibility variant.
9. Test held launch/removal exclusion, awaited asynchronous release, same-operation re-entry, deterministic multi-contributor acquisition, missing transaction denial, exact receipt CAS retirement, changed-generation preservation, crash/restart at every retirement phase, multi-effect deferment, reinstall/rebind, completed-operation rotation, open-handle/ambiguous action failure, and LEGO import/name isolation.
10. Run focused tests on current and exact Node 22.16.0, bounded preflight, architecture/product/standalone gates, the complete exact serialized suite, doctor, generated-artifact/diff hygiene, then push only the isolated branch and require exact-head Ubuntu/Windows smoke/full acceptance before exposing any removal CLI.

## Acceptance boundary

Acceptance proves that a launch cannot overlap the complete application-removal transaction for the same local owner, terminal receipts and bindings retire only after exact absence, interrupted retirement reconciles without deleting a changed reinstall, and a later exact plan can rotate completed operation state. It still does not make application coverage complete or authorize a live uninstall. Legacy Stage-0, setup/PATH/configuration, protected service, provider/environment, VM/guest, and every unregistered or ambiguous subject remain preserved.
