# DB-HO103 — Permanent Entry production ownership receipts

Date: 2026-08-30

Parent work: Stage 8 #116 and application removal #391.

Coordinates with: #159, #391, DB-003, DB-009, DB-011, DB-020, DB-HO095, DB-HO098, DB-HO099, DB-HO100, DB-HO101, and DB-HO102.

## Scope and safety boundary

This checkpoint owns the first production writer of the accepted immutable ownership-receipt journal. It may add a neutral conditional collection editor above the journal, make Permanent Entry installation asynchronous, initialize protected receipt/control state, reserve exact installer-created temporary names before mutation, classify exact component and wrapper publications as created/adopted/retained, finalize exact artifact descriptors, preserve older accepted component-generation receipts, expose read-only installer activity, regenerate the standalone entry stages, and update call sites/tests/documentation.

It does not expose an application-removal contributor or CLI, bind or execute an application/purge deletion, retire/rotate the receipt/control store, remove legacy Stage-0, declare staging/quarantine residue removable, change setup choices, request elevation, refresh a protected service, mutate a provider/image/environment/VM/guest, execute repository code, invoke a model, or implement GPU/CUDA work. All integration effects use disposable installation homes; the canonical installation is not inspected or mutated.

## Assessment

The accepted lower stack now supplies immutable receipt revisions, strict expected-generation conditional acceptance, exact artifact discovery/planning/observation, restart-stable private action binding, and a transitive standalone compiler. Production composition is still absent.

The current synchronous installer cannot truthfully add receipts after the fact:

- `component-store.mjs` creates a randomly named staging directory internally, may quarantine an invalid target, publishes a component, and deletes staging before returning. A caller cannot durably identify the temporary name before creation or distinguish created, adopted, retained, and preserved outcomes.
- `entry-publication.mjs` creates random `.next-*` files internally and ordinary rename replaces existing wrapper files. It checks only regular-file shape before replacement, so post-hoc `created` provenance could be assigned after overwriting an arbitrary pre-existing file.
- component manifests verify current component bytes but do not prove installation-wide provenance. Older verified generations are intentionally retained; unverified historical generations cannot be adopted merely from their names.
- the installer mutation lease serializes installers but exposes no read-only activity observation for a future inventory producer.
- journal `compareAndAccept` prevents stale replacement but deliberately does no merge. Production owners still need one declarative, bounded collection-CAS brick that preserves unrelated contributors and detects same-item conflicts without callback side effects.
- the installer and bootstrap call graph assumes synchronous installation. Receipt I/O is asynchronous; retaining a second synchronous compatibility path would create an unreceipted production route.

The current entry component and wrapper names are installer-local topology and belong only in the composition root/local adapters. The receipt journal, collection editor, exact-artifact set, and future application-removal source must remain topology-neutral.

## Primary-source research

- Node.js 22.16.0 documents that `fsPromises.mkdir()` rejects an existing directory when `recursive` is false. A caller-selected unpredictable name can therefore be durably reserved first and then created without treating pre-existence as success: https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#fspromisesmkdirpath-options
- Node warns that checking existence before open/write introduces a race and recommends direct exclusive open with `wx`, which fails if the path exists. Exact temporary file publication must use the effect operation itself as admission rather than `exists` as authority: https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#fsopenpath-flags-mode-callback
- Node 22.16.0 states that ordinary `rename` overwrites an existing file. It is not a no-replace CAS and cannot make an arbitrary observed target safe to replace: https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#fsrenameoldpath-newpath-callback
- Node's `link` delegates to the platform hard-link contract. Linux `link(2)` says an existing destination is not overwritten and reports `EEXIST`, while ambiguous network-filesystem completion must be resolved by observation. That supports the accepted create-if-absent plus exact-reread pattern but not blind retry: https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#fspromiseslinkexistingpath-newpath and https://man7.org/linux/man-pages/man2/link.2.html
- Linux `rename(2)` exposes `RENAME_NOREPLACE`, but Node's portable rename API does not expose that flag; ordinary rename atomically replaces an existing destination. The installer cannot claim a cross-platform no-replace rename primitive it does not have: https://man7.org/linux/man-pages/man2/renameat2.2.html
- Microsoft documents that `CreateHardLinkW` creates a new file name for an existing file, is limited to files on one volume, and shares the underlying file/security identity. The receipt journal and wrapper staging roots must therefore be on the installation volume, and hard links must be reread/cleaned to one final link before becoming exact artifact evidence: https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createhardlinkw

## Reassessment and ownership boundary

Add a neutral declarative collection editor above the accepted journal. It receives only exact before/after receipt items and the journal's `read`/`compareAndAccept` ports. One mutation is an item-level CAS: unrelated concurrent items are preserved; an exact already-applied change is idempotent; a touched item that differs from both expected and desired state fails closed; and a losing generation race is retried only from the exact observed winner within a fixed bound. It performs no caller callback, filesystem effect, topology lookup, merge by naming convention, or deletion.

The Permanent Entry composition owns its private receipt value protocol and paths. It creates a protected anchor record first so the journal has an installation epoch and never needs an invalid empty item set. The anchor describes protected control evidence and is never projected as an ordinary removable artifact.

For every new filesystem effect, exact random names and intended final state are generated before mutation and recorded in one receipt reservation. This includes component staging, any quarantine destination, and wrapper staging names. A reservation is durable intent/recovery evidence, not a removable exact-artifact descriptor. It is cleared only after the exact temporary name is observed absent. A surviving reservation remains protected/incomplete and cannot contribute application-removal coverage.

Production artifacts use separate receipt items so provenance is truthful:

- one item per exact component generation;
- one sparse exact-artifact item per owned wrapper file under the shared command directory; and
- no item for unrelated siblings, unverified quarantine, unverified old component generations, the legacy Stage-0 entry/tree, or receipt/control self-state as removable payload.

An absent final artifact followed by successful publication is `created`. A complete statically verified artifact observed during an explicit local install with no receipt may be `adopted`. An artifact matching an accepted complete receipt is `retained`. A reserved interrupted operation may finalize as `created` only after the local verifier proves its exact intended result. Arbitrary, ambiguous, link-indirected, or merely name-matching state is never adopted.

Wrapper adoption requires exact regenerated bytes, not execution of the installed wrapper. A recognized older generated primary/previous wrapper must parse to bounded local metadata, regenerate byte-for-byte, and reference an exact verified retained component before transition. Command and shell wrappers must match their fixed exact bytes. Anything else fails closed or is preserved under a separately recorded local transition; it is never overwritten and labeled created merely because the filename is reserved.

Component publication continues to preserve an invalid same-head target rather than declaring it owned. Its exact quarantine destination becomes part of the pre-effect reservation, but quarantine remains unregistered and non-removable. Only the newly verified target becomes a completed created receipt.

The public installation operation becomes async end-to-end. Bootstrap, setup ref tracking, direct installer invocation, and tests await it. The synchronous API is removed with no compatibility overload, so there is no second unreceipted production path.

The mutation lease adds only a read-only local activity observation. It does not learn uninstall policy or grant mutation authority. A future contributor will adapt that boolean through its own local topology edge; this checkpoint does not register the contributor.

## Primitive-to-high-level plan

1. Implement and isolate the declarative conditional receipt-collection editor. Prove unrelated-writer preservation, same-item conflict, exact replay, empty-result rejection, bounded contention, and malicious-port response rejection.
2. Add a small installer-local ownership-state adapter that initializes/validates the protected anchor, creates bounded reservation/completion values, and applies only declarative collection changes.
3. Extend the mutation lease with side-effect-free active/inactive observation and pin live, dead, absent, corrupt, and link-indirected behavior.
4. Refactor component publication so the composition supplies exact staging/quarantine names and receives neutral created/adopted/retained/preserved observations. Record reservations before any new name is created. Keep unverified quarantine outside removal receipts.
5. Refactor wrapper publication into inspect/plan/apply. Statically recognize only exact generated wrapper bytes, reserve exact stage/preservation names before effects, publish primary last, return neutral observations, and reject arbitrary/ambiguous state.
6. Compose one protected receipt journal and separate same-volume scratch below the installation home. Record exact component trees with discovery and wrapper files as sparse non-root-removing artifact sets. Preserve unrelated receipt items and all accepted older component generations.
7. Make `installDevBridge` and tracked-ref installation async; update the zero-state bootstrap, CLI setup route, direct standalone invocation, and all callers with no synchronous compatibility path.
8. Prove fresh created installation, exact no-op retry, explicit static adoption, branch advancement with old component receipt retention, interrupted reservation recovery, receipt contention, foreign wrapper refusal, invalid-component preservation, activity observation, sparse-wrapper isolation, and no live removal authority.
9. Regenerate both standalone artifacts and run current/exact Node 22.16 focused tests, bounded preflight, LEGO/architecture/product/standalone gates, the exact serialized suite, doctor, diff hygiene, and hosted Ubuntu/Windows qualification.
10. Document accepted implementation and keep #391 open. Only then attach a receipt-backed read-only inventory contributor, complete application-mode producer coverage, and separately design terminal receipt retirement/removal-operation rotation before exposing uninstall.

## Acceptance

- [ ] Unrelated receipt items survive conditional installer updates; same-item drift fails closed.
- [ ] Every production-artifact staging/preservation name is durably reserved before creation and cleared only after exact absence; the accepted journal keeps ownership of its own self-publication scratch contract.
- [ ] Exact component and sparse wrapper receipts distinguish created, adopted, and retained state without inferring authority from names.
- [ ] Older accepted component-generation receipts remain current; unverified historical/quarantine state remains unregistered and preserved.
- [ ] Arbitrary, ambiguous, or indirect wrapper state is not overwritten or adopted.
- [ ] Installer activity is observable without granting removal or installer authority.
- [ ] Installation is async end-to-end with no synchronous/unreceipted compatibility path.
- [ ] Neutral collection/receipt/artifact modules contain no installer, wrapper, component, repository, provider, VM, guest, or removal topology.
- [ ] No uninstall contributor/CLI, application/purge deletion, canonical-install mutation, setup/UAC, protected/provider/VM/guest effect, repository execution, model, or GPU/CUDA action occurs.
