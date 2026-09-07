# DB-HO104 — Receipt-backed application payload inventory

Date: 2026-08-30

Status: first implementation boundary accepted; production removal remains unavailable

Coordinates with: #116, #159, #180, #391, DB-003, DB-009, DB-011, DB-020, DB-HO095, DB-HO098, DB-HO099, DB-HO100, DB-HO101, DB-HO102, and DB-HO103.

GPU/CUDA work is deferred and outside this checkpoint.

## Scope and safety boundary

This checkpoint owns the read-only production path from exact application-payload ownership evidence to the accepted neutral application-removal source. It must register every replaceable payload producer required for `application` mode before that mode can report complete.

It may add neutral inventory/catalog bricks, producer-local read-only adapters, exact ownership receipts at the owning payload publication boundary, disposable integration tests, and read-only inspection composition. It must not expose deletion or an uninstall CLI, retire the receipt/control journal, rotate a completed removal operation, remove legacy Stage-0 state, change PATH or configuration, request elevation, refresh a protected service, mutate provider/image/environment/VM/guest state, execute repository code, invoke a model adapter, or implement GPU/CUDA features.

## Accepted baseline and repository assessment

The isolated branch is clean and remote-equal at accepted documentation head `015e0eeb49e5325aa0bb6c7767f06946e9682216`. Exact implementation `7da445fb5adafdf1ee55396623f7e9ad386394ad` and the documentation head passed Ubuntu smoke/full and Windows bounded-smoke/serialized-full plus doctor in GitHub Actions runs [33325147542](https://github.com/iteathen/DevBridge/actions/runs/33325147542) and [33325297082](https://github.com/iteathen/DevBridge/actions/runs/33325297082).

The lower stack now provides:

- a neutral removal contract, deterministic planner, explicit confirmation, durable DB-009 coordinator, and contributor completeness gate;
- exact non-recursive artifact observation/removal with content digests, link/reparse defenses, and frozen private action binding;
- an immutable exact-JSON ownership-receipt journal with generation CAS;
- production Permanent Entry receipts for every exact component generation and sparse primary/previous/command/shell publication; and
- a read-only installer activity observation.

Those receipts do not yet create a production inventory contributor. They are a dynamic item set, while `createExactArtifactInventory` owns one statically configured item. A correct adapter must preserve every completed component generation and sparse launch file, reject or withhold completeness for pending/corrupt receipt state, keep private descriptors out of the removal contract, and re-observe the exact artifact before any later binding.

The repository audit also disproves the narrower assumption that Permanent Entry receipts alone complete application mode. First normal use creates additional replaceable payload beneath `entry/cache`:

- development mode materializes an independently cloned exact checkout plus a credentials-free control home;
- production mode materializes content-addressed runner objects; and
- the stable runner journal beneath `entry/state` is durable selection/last-known-good authority, not replaceable payload.

The cache providers currently verify their exact subject before launch but publish no ownership receipt. Inferring deletion authority later from the cache directory name would violate DB-003/009. Therefore the next two independently owned contributor families are receipt-owned entry publications and runner-owned cache materialization. They are necessary but not sufficient for complete application mode.

The broader payload audit finds additional required producer or absence-gate ownership:

- legacy Stage-0 owns `runtime`, runtime-candidate/activation state, and a separate Stage-0 launcher; #159 must either retire that exact payload or let an absence gate prove it is not present;
- PATH/profile integration is an external application entry effect and must be removed through the setup-owned adapter without deleting unrelated user profile content;
- an accepted runtime/supervisor may still be active and must cross a cooperative stop/fence boundary before its payload can become removable; and
- protected Windows/Linux lifecycle services join operational service payload to separately retained environment authority. Application mode must stop/remove only the service instance and replaceable runtime generation while preserving protected authority, declarations, images, VMs, and guests. That split remains provider/service-owner work and can require later explicit local authorization.

Stable runner state, bootstrap selection evidence still needed for recovery, configuration, service authority, and provider/environment state remain outside application payload and must be preserved. A required producer may truthfully report exact absence; it may not be omitted merely because a clean modern installation does not currently use that topology.

The existing development cache is an independent clone with its own `.git` directory, not a linked Git worktree. No application-removal component may nevertheless assume all future cache adapters share that topology; the cache provider must own its local removal descriptor and expose only neutral receipt data.

## Primary-source research

- [Node.js 22.16.0 filesystem promises](https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#promises-api) use the thread pool and are explicitly not synchronized or threadsafe. Reassessment: inventory observation is not admission. Producer generation/activity and exact artifact state must be re-observed around binding, and future removal must share one mutually exclusive operation boundary with installation/materialization.
- [`fsPromises.readdir()`](https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#fspromisesreaddirpath-options) returns directory entries but specifies no canonical order. Reassessment: every producer and aggregate must validate and sort bounded identities before digesting or comparing them.
- [`fsPromises.rm()`](https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#fspromisesrmpath-options) adds linear-backoff retries only in recursive mode. Reassessment: recursive cleanup is not ownership evidence and is not an application-removal action. Exact artifacts remain non-recursive and re-observed.
- Microsoft documents that [hard links are multiple paths to one file object and junctions are reparse points](https://learn.microsoft.com/en-us/windows/win32/fileio/hard-links-and-junctions). Microsoft also documents that [reparse points can change ordinary file-open behavior](https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-points). Reassessment: retain single-link and injected Windows reparse observation at the exact-artifact boundary; a receipt path or successful prior verification does not waive current identity checks.
- Git documents that a [linked worktree has repository-side administrative state and should be removed through `git worktree remove`](https://git-scm.com/docs/git-worktree), while the current DevBridge cache provider creates an independent repository. Reassessment: no generic inventory/removal brick may know or guess checkout topology. A future provider that adopts linked worktrees needs its own locally registered action adapter; the current independent-clone producer may use an exact artifact descriptor only after its provider verifies the exact clean subject.
- Git documents that [`status --porcelain` is stable for scripts and can include all untracked files](https://git-scm.com/docs/git-status). Reassessment: the existing provider's exact-head plus clean tracked/untracked verification remains the local adoption prerequisite, but Git cleanliness alone is not the private removal descriptor.

## Ownership reassessment

The neutral dynamic inventory owner should know only a bounded source generation, readiness, item identity, created/adopted provenance, neutral relationships, private exact-JSON action value, activity observation, record port, and action-observation port. It must not import or name the installer, entry, wrapper, component, runner, cache, Git, repository, filesystem, platform, removal coordinator, or any downstream topology.

Producer-local adapters own receipt protocols, path layout, adoption policy, and relationship assignment. The Permanent Entry adapter may decode only its own protected control/reserved/completed receipt values. The runner/cache producer may verify and receipt only subjects it created or can statically adopt through its existing exact verification contract. Neither producer owns uninstall mode, confirmation, planning, reporting, or cross-producer ordering.

The accepted runtime composition owns the temporary topology: required contributor identities, `application` completeness, source aggregation, read-only inspection, private catalog routing, and eventual effect routing. A contributor identity or interface name must describe only the local contract, not its current neighbor.

Pending reservations, active publication, corrupt history, unknown items, ambiguous artifact state, or missing cache ownership make application coverage incomplete or preserved; they never disappear from consideration by being omitted and never enable a fallback. Receipt/control journals, stable runner authority, application-removal journals/bindings, quarantine, staging residue, bootstrap evidence, configuration, protected service state, and provider/environment state are protected or unregistered until their own terminal contracts exist.

## Primitive-to-high-level implementation plan

1. Add one import-isolated dynamic exact-value inventory. Its source returns a bounded, sorted generation/readiness/item set; each item carries only neutral provenance/relationships and one private descriptor. The brick validates exact JSON, derives opaque effect identities, observes each descriptor, preserves ambiguous state, and emits a deterministic fragment. It stores one exact plan binding per item through the existing revisioned-record stud so partial absence/restart projects frozen authority. No source path or descriptor crosses the public removal contract.
2. Add one neutral item-catalog router only if the dynamic owner cannot itself satisfy `bind/load`. It must route by an already-registered local item identity and contain no producer identity. Do not retain a parallel static compatibility path.
3. Add a Permanent Entry-local read-only source adapter. It opens the existing immutable journal and activity observer, validates the protected control anchor and every local ownership value, maps only completed artifact descriptors, reports pending reservations as incomplete, preserves control/self-state, and assigns wrapper-before-component dependencies locally. Compose it with the neutral dynamic inventory in disposable homes.
4. Prove that the entry contributor is read-only and correct across created/adopted receipts, retained generations, absent sparse items, pending reservations, active installation, corrupt/extra/gapped receipt history, descriptor/path/link/reparse substitution, unordered input, partial absence, restart, and private-descriptor non-disclosure. Application coverage remains incomplete while the runner/cache producer is absent.
5. Add exact ownership publication to each runner/cache provider at its existing verified publication boundary. Reserve unpredictable temporary names before creation where necessary; classify exact pre-receipt subjects only through the provider's existing subject and cleanliness verification; receipt independent checkout trees, content-addressed objects, and credentials-free cache support state as payload; and leave the stable runner journal as authority. Do not make the Permanent Entry core understand cache topology.
6. Add the cache-local inventory adapter. Keep application coverage incomplete while managed-runtime/supervisor, Stage-0/cutover, PATH integration, and protected-service payload producers or exact-absence gates are missing.
7. Register the remaining application producers in ownership order: cooperative runtime/supervisor admission and payload; exact legacy Stage-0 absence/retirement under #159; setup-owned PATH/profile integration; and protected-service instance/runtime payload separated from retained environment authority. Each producer remains local and may report coverage from exact absence. Do not pull their topology into the neutral inventory.
8. Compose the complete required producer set. Application mode may report complete only when every current application payload topology is exactly receipted or exactly absent and every producer is inactive. Purge remains incomplete because configuration and provider/environment authority producers are intentionally absent.
9. Expose a read-only application inspection surface and bounded public report only after the complete application contributor set passes. Keep apply/delete unreachable until the separate operation-interlock, receipt-retirement, and completed-operation rotation design is documented and accepted.
10. Qualify current and exact Node 22.16 focused tests, bounded preflight, LEGO/architecture/product/standalone gates, the complete serialized suite, doctor, generated-artifact/diff hygiene, and exact-head hosted Ubuntu/Windows smoke/full plus doctor after each accepted ownership boundary.

## Required boundary evidence

- no neutral module contains current producer, path, platform, Git, repository, provider, VM, guest, setup, service, or downstream owner identities;
- source generation or activity drift before binding creates no durable action authority;
- dynamic items are sorted, bounded, globally unique after aggregation, and stable through partial absence/restart;
- private artifact descriptors never enter public plans, journals, results, status, or errors;
- pending/corrupt/unknown receipts and ambiguous artifacts preserve or block rather than disappear;
- exact cache adoption rejects dirty, wrong-head, wrong-runner-digest, indirect, hard-linked, reparse, or unsupported topology;
- stable runner state and every non-payload authority remain unchanged by application inspection;
- application coverage stays incomplete until entry, cache, managed-runtime/supervisor, Stage-0/cutover, PATH integration, and protected-service payload producers or exact-absence gates are registered; purge stays incomplete; and
- no failure enables direct/uncontained host repository execution or a model fallback.

## Nonclaims

This plan does not authorize removal of the canonical installation or any disposable fixture. It does not claim complete application coverage before every required payload producer or exact-absence gate lands. It does not establish terminal receipt retirement, reinstall/uninstall operation rotation, a mutual exclusion boundary between removal and publication, a supported uninstall CLI, Stage-0 retirement, PATH/service/configuration purge, or real provider/environment destruction. It changes no VM, guest, setup, UAC/elevation, repository-execution, model-adapter, or GPU/CUDA state.

## First implementation checkpoint

The first primitive boundary is implemented without exposing a removal command. `exact-value-inventory` is one import-isolated, topology-neutral dynamic owner over injected source, activity, record, and action-observation ports. It validates and sorts a bounded acyclic item set, keeps private exact-JSON descriptors behind opaque effect identities, withholds coverage for an incomplete source, withholds binding during active mutation, preserves ambiguous state as a protection, re-observes source/activity/action state before accepting a binding, and persists one exact revisioned binding per item for restart and partial-absence reconciliation.

The Permanent Entry-local source reads the accepted immutable ownership receipt journal, validates its protected control and selected reservation/completion values, ignores unrelated receipt values without learning their protocols, maps only completed component/entry payloads, and reports any selected reservation as incomplete. The production composition assigns wrapper-before-component removal relationships locally and uses the accepted installer activity observation and exact artifact action adapter. A disposable real-installation test proves the projection is read-only, path/private-descriptor free, and incapable of completing application coverage while the independently required runtime-payload contributor is absent.

Final-byte local qualification on current Node 24.15.0 and exact minimum Node 22.16.0 passes the focused boundary set (31/31 on exact Node), both bounded preflights at 2 standalone artifacts / 239 syntax files / 2 JSON files / 196 targeted test files, and the exact architecture/product/standalone gate at 45 total / 44 passed / one expected Windows symlink skip. The complete exact serialized suite passes 2,046 total / 2,025 passed / 21 expected platform skips / zero failures in 234.8 seconds. Exact doctor reports `ok: true`, coding adapters disabled, and repository execution unavailable/fail-closed because no persistent-environment route is configured. Standalone regeneration and diff hygiene pass.

Commit and push this isolated candidate, then require exact-head Ubuntu/Windows smoke/full plus doctor before accepting the boundary. Keep #391 open and proceed next to runner/cache ownership receipts. Application and purge coverage remain incomplete. No canonical installation or payload was removed, and no CLI, setup/elevation, protected service/provider/image/environment/VM/guest effect, repository execution, model invocation, or GPU/CUDA action occurred.

Hosted acceptance: exact implementation `838212d7f1d05b464d59b2ca6657bd55897f7e7c` passed Ubuntu smoke/full and Windows bounded-smoke/serialized-full plus doctor in [run 33326909315](https://github.com/iteathen/DevBridge/actions/runs/33326909315). Accept the dynamic inventory and Permanent Entry read-only contributor, keep #391 open, and proceed to runner/cache ownership receipts. Do not infer complete application coverage, deletion authority, or uninstall readiness from this accepted lower boundary.
