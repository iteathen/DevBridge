# DB-HO095 — Stage-8 application inventory and removal primitive

Date: 2026-08-30

Status: assessment, research, reassessment, and implementation plan recorded; no removal effect authorized

Coordinates with: #116, #159, #180, #391, DB-003, DB-009, DB-011, DB-020, and DB-HO094.

GPU/CUDA work is outside this checkpoint.

## Scope and authority

This checkpoint owns the primitive application inventory/removal contract required before DevBridge can expose supported application-only uninstall or full exact purge. It may add source, tests, documentation, and read-only plans. It must not remove live installation data, change PATH, invoke setup/elevation, refresh the protected service, mutate a provider/image/environment/VM/guest, execute repository code, invoke a model adapter, or retire the legacy Stage-0 tree.

The implementation must remain below the application-management composition and above concrete resource adapters. Its internal contract may contain only local neutral identities, provenance, retention/reference state, bounded effect identities, and journal state. Provider names, repository identities, VM/domain/disk paths, permanent-entry implementation names, and foreign object types stay inside their owning adapters.

## Assessment

The isolated branch is clean and remote-equal at accepted documentation head `85fb43619cefde7fc9aa1fc1c9a5a04400ccdc61`. [GitHub Actions run 33309324877](https://github.com/iteathen/DevBridge/actions/runs/33309324877) passed Ubuntu smoke/full and Windows bounded-smoke/serialized-full plus doctor for that exact head.

The current repository already contains the lower-level bricks needed by a safe removal path:

- permanent-entry component generations have exact content manifests;
- `ExactArtifactSet` binds a bounded tree to filesystem identity, rejects filesystem indirection/substitution, removes exact files/directories non-recursively, and re-observes absence;
- the local state-store and exclusive-mutation bricks provide flushed temporary-file replacement, exact reread, and process-local serialization;
- setup PATH ownership and environment lifecycle/provider ownership already live behind narrow adapters; and
- construction retention demonstrates a DB-009 planned/attempted/observed/reconciled effect loop without granting broad recursive cleanup authority.

There is no application-wide versioned inventory, no created/adopted/foreign provenance contract, no distinct application-removal/full-purge plan, no cross-owner removal journal/report, and no supported uninstall CLI. Component manifests prove exact component bytes but do not by themselves authorize application policy or removal. Ordinary installation intentionally retains older verified generations. The pre-existing Stage-0 `runtime` subtree remains a separate #159 cutover concern, and unselected exact runner checkouts cannot be declared obsolete from age or names.

## Primary-source research

The [Node.js 24 filesystem documentation](https://nodejs.org/download/release/v24.13.1/docs/api/fs.html) states that promise filesystem mutations are not synchronized/threadsafe, `fsync` requests an OS/device-specific flush, rename is a separate operation, and recursive removal adds retry behavior. Reassessment: serialize removal state locally; write a unique file, flush it, rename it, and reread exact accepted bytes. Recursive removal is never an ownership oracle.

Microsoft documents that [DeleteFile deletes a symbolic link rather than its target and may fail or remain pending around open handles](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-deletefilew). It also documents an explicit [directory-removal mode that disallows path redirection](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-removedirectory2w), including junction behavior. Node does not expose that Windows flag directly. Reassessment: retain the existing `lstat`/reparse/canonical-identity checks, hold/recheck exact file identity, remove only the exact link or real directory expected by the adapter, use only non-recursive directory removal, and re-observe absence. Sharing/lock failures are distinct from ownership ambiguity and must be reported without widening the target.

Microsoft documents [replacement and write-through as distinct MoveFileEx flags](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexa). Reassessment: rename completion is not accepted-state proof; the owning state store must reread exact bytes, while post-crash re-entry observes and reconciles whichever exact generation exists.

## Ownership reassessment

The application-management hierarchy requires the accepted runtime to own uninstall mode, confirmation, plan binding, orchestration, and reporting. The Permanent Entry and Runner may publish neutral receipts for resources they create, but they must not grow uninstall policy. Configuration, service, and lifecycle owners likewise expose only neutral subjects/effects. Concrete path or provider actions remain inside adapters.

A manifest is evidence, not timeless deletion authority. A plan can select only exact `created` or explicitly adopted resources allowed by the chosen mode. `foreign`, ambiguous, referenced, current/LKG-required, unregistered, or changed resources are preserved and reported. Every selected effect is rebound and re-observed immediately before mutation. Full purge cannot be exposed until every required authority/environment producer is registered; application removal cannot be exposed while replaceable application producers remain unregistered.

## Primitive-to-high-level implementation plan

1. Add an import-light neutral protocol that strictly validates bounded resource snapshots, created/adopted/foreign provenance, retention and reference state, opaque effect identities, modes, deterministic ordering, and digest.
2. Implement read-only `application` and `purge` planning. Both require literal `REMOVE` plus the exact current plan digest before an effect can start. Planning returns explicit selected and preserved subjects with bounded reasons.
3. Add a durable DB-009 journal and bounded resume/reconciliation loop. Before each effect, rebuild and compare the plan/generation, bind the exact effect to the plan digest, observe it, record attempted before mutation, observe again, reconcile, and advance durably. Never blind-retry an ambiguous effect.
4. Attach filesystem effects through `ExactArtifactSet`. Prune only explicitly owned directories proven empty after owned children are absent. Surface lock/sharing failure without recursive cleanup or parent widening.
5. Register producer adapters in ownership order: permanent-entry/runner payload receipts; accepted-runtime/service payload receipts; setup/PATH receipts; configuration authority; then lifecycle/environment receipts. Each producer retains its local vocabulary and returns only the neutral contract.
6. Add `devbridge uninstall inspect --mode <application|purge>` and explicit apply/resume UX only when the selected mode's producer set is complete. No ordinary command or setup invocation silently enters removal.
7. Qualify normal, adopted/foreign, references, link/reparse/hard-link substitution, concurrent mutation, plan drift, interruption at every phase, open-file/lock failure, non-empty parent preservation, exact report, and no-provider/direct-host-fallback behavior.
8. Qualify application-only removal/recovery first. Qualify full purge through real Hyper-V and KVM/libvirt lifecycle adapters separately; hosted mocks cannot establish real provider destruction safety.

## First implementation slice

The first code slice is the complete neutral protocol, deterministic read-only planner, confirmation binding, and DB-009 journaled coordinator with fake ports. It must have no filesystem/provider/application-layer imports and no production mutation route. This establishes the primitive contract and its failure/recovery tests before concrete producers gain deletion authority.

After that slice passes local and hosted qualification, attach one exact-artifact filesystem adapter and its producer at a time. Do not expose the production CLI until the completeness gate can prove that a mode has every required producer.

## Required evidence before this checkpoint can advance

- focused protocol/planner/journal normal, failure, recovery, and boundary tests;
- module-isolation checks banning external identities/imports from the neutral owner;
- preflight, architecture/product/standalone, complete serialized suite, doctor, and diff/generated-artifact hygiene;
- hosted Ubuntu/Windows smoke/full plus doctor on the exact implementation head; and
- a durable implementation record naming remaining unregistered producers and nonclaims.

No current live artifact is authorized for removal by this plan.
