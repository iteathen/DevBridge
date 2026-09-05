# DB-HO099 — Exact artifact inventory and bound-effect studs

Date: 2026-08-30

Status: accepted primitive; no production removal route exists

Coordinates with: #116, #159, #391, DB-003, DB-009, DB-011, DB-020, DB-HO095, and DB-HO098.

GPU/CUDA work is outside this checkpoint.

## Scope and authority

This checkpoint owns the next primitive above the accepted durable removal journal: one neutral exact-artifact inventory contributor, one neutral inventory aggregator, and one bound-action bridge. It may strengthen exact-artifact discovery, persist immutable action descriptors before a test-fixture removal, and prove restart behavior through the existing application-removal studs.

It does not own a supported uninstall CLI, complete application or purge coverage, installer mutation-lock composition, service/PATH/configuration/provider/environment producers, legacy Stage-0 retirement, setup/elevation, protected service refresh, VM/guest lifecycle, repository execution, model invocation, or GPU/CUDA work. No live installation artifact is authorized for removal.

## Accepted baseline and assessment

The isolated branch is clean and remote-equal at documentation head `36454b5357d75995dd9894b5aa5085be0addb134`. [GitHub Actions run 33314477520](https://github.com/iteathen/DevBridge/actions/runs/33314477520) passed Ubuntu smoke/full and Windows bounded-smoke/serialized-full plus doctor for those exact bytes.

The accepted lower stack now provides:

- a neutral versioned removal contract, deterministic planner, exact confirmation, and DB-009 coordinator;
- a generic revisioned-record store whose exclusive session spans the complete coordinator effect loop; and
- `ExactArtifactSet`, which rejects symbolic/reparse/hard-link substitution, binds filesystem identity, removes only exact files and empty directories non-recursively, and re-observes absence.

Three gaps remain before the first real ownership producer can attach safely:

1. `ExactArtifactSet.discover()` records byte counts but not content digests, even though its held-handle observer can measure them. A discovered tree should carry exact content evidence rather than relying only on metadata identity.
2. The coordinator deliberately sees only opaque effect identities. A concrete action bridge must load the exact locally bound descriptor without returning paths or filesystem manifests through the coordinator contract.
3. A producer cannot reconstruct its plan from the live tree after an interrupted removal has already deleted one entry. The complete descriptor must be persisted before the first attempt, and the producer must continue projecting the frozen neutral receipt across restart and partial absence.

The existing permanent-entry component verifier is suitable as one locally injected authority observer in qualification, but the neutral producer must not import or name it. Installer-tree enumeration, mutation-lock observation, wrapper/staging/quarantine ownership, and production composition remain later producer-owned work.

## Primary-source research

The [Node.js filesystem promises contract](https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#promises-api) states that promise filesystem operations use the thread pool and are not synchronized or threadsafe. Its `lstat` contract observes a symbolic link itself rather than following it, while unlink remains a separate mutation. Reassessment: local serialization and exact pre/post observations remain necessary; an asynchronous discovery pass is not a lock or lasting ownership proof.

Microsoft documents that [hard links are multiple paths to one file object and junctions are reparse points](https://learn.microsoft.com/en-us/windows/win32/fileio/hard-links-and-junctions). Microsoft also documents that [reparse points can cause filesystem behavior different from ordinary path expectations](https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-points) and that `FILE_ATTRIBUTE_REPARSE_POINT` is the direct observation mechanism. Reassessment: keep Windows reparse observation behind the existing injected platform adapter; the neutral producer and coordinator must not infer safety from a pathname or from Node's symbolic-link flag alone.

[`RemoveDirectory2W`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-removedirectory2w) requires an empty directory, can disallow path redirects, and describes delete-on-close behavior. [`DeleteFileW`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-deletefilew) likewise documents delete-pending/open-handle behavior and link-target distinctions. Reassessment: retain exact non-recursive removal and post-effect absence observation. A sharing/delete-pending failure is not authority to widen, recurse, or adopt another target.

## Ownership reassessment

The removal source owns only aggregation of neutral contributor fragments and completeness policy. It must not know which component produced an item or receive a path-bearing descriptor.

The artifact contributor owns one locally configured logical item, provenance observation, exact discovery, and durable binding of its opaque action descriptor. Its ports are neutral: local observation, activity, records, and actions. It does not import the application coordinator, installer, provider, service, repository, or platform adapter.

The bound-action bridge owns only temporary topology between a catalog and an action executor. It validates that a binding preserves the caller's exact protocol/mode/item/effect/plan digest, strips the private descriptor before returning through the coordinator stud, and reloads that descriptor for observe/remove. It does not know what produced the descriptor or how the action is implemented.

Production composition remains intentionally absent. The first integration uses a disposable installed-component fixture only to prove that the existing verifier can attach as a local observation port and that the exact artifact engine can attach as an action port. This is evidence of replaceability, not a live uninstall command.

## Primitive-to-high-level implementation plan

1. Strengthen exact-artifact discovery to hash each regular single-link file through the already-held handle and carry the measured SHA-256 into the immutable manifest. Prove same-size post-discovery content drift is ambiguous.
2. Add a neutral contributor aggregator inside the removal owner. It accepts identified `snapshot()` ports, derives one deterministic generation, unions items/references/activity, and reports a mode complete only when every locally required contributor is present and claims that mode.
3. Add one import-free bound-action bridge. Its `catalog.bind/load` and `actions.observe/remove` ports use only neutral field names; private descriptors never cross the public coordinator binding.
4. Add one import-isolated exact-artifact inventory contributor. Before binding it re-observes local provenance around exact discovery. On bind it persists the complete fragment and private descriptor through an injected revisioned-record session before reporting success. After partial/full artifact absence or process restart, it projects the same frozen fragment from that record so the coordinator's exact plan remains stable.
5. Compose the pieces only in tests with a disposable permanent-entry component fixture, the existing component verifier, an exact artifact engine, two independent revisioned stores, and the normal removal coordinator. Prove exact removal, fresh-instance recovery, plan stability after absence, content/substitution ambiguity, foreign preservation, active-mutation blocking, missing-contributor incomplete coverage, and descriptor non-disclosure.
6. Add source-level LEGO tests forbidding installer/provider/platform/application identities and cross-owner imports inside the new contributor and bridge. The aggregator may import only sibling removal-contract code.
7. Run focused current/exact Node 22.16 tests, bounded preflight, architecture/product/standalone gates, the complete serialized suite, doctor, generated-artifact/diff hygiene, and exact-head hosted Ubuntu/Windows smoke/full plus doctor.
8. Document exact implementation evidence and keep #391 open. Next assess the permanent-entry producer composition: exact generation discovery, installer-mutation observation, wrappers and retained trees, and durable receipt retirement/operation rotation. Do not expose CLI apply until application coverage is complete.

## Nonclaims

- A persisted action descriptor is not permission to remove any different or newly recreated object.
- This slice does not make repeated reinstall/uninstall operation rotation complete; bound receipts remain fail-closed evidence until a later exact retirement contract owns their transition.
- This slice does not inventory every permanent-entry, runner, runtime, service, PATH, configuration, provider, image, environment, or VM resource.
- Hosted tests do not qualify provider/environment purge.
- No failure enables repository-code host execution.

## Implementation

`ExactArtifactSet` now hashes every discovered regular single-link file through its held file handle and records the measured SHA-256 in the immutable descriptor. Planning also measures and rejects a caller-supplied digest that does not match the current bytes before a descriptor can become effect evidence. Existing real-directory, canonical-identity, reparse, hard-link, bounded-tree, non-recursive removal, and post-effect observation rules remain unchanged.

The application-removal owner now exposes one contributor-source stud. Locally configured contributor identities and required mode sets remain composition data. Each contributor returns only its neutral snapshot; the owner validates every fragment through its own contract, derives a deterministic generation from required and observed generations, unions items/references/activity, and claims a mode complete only when every required contributor is present and independently claims it. Missing or malformed contributors create no removal readiness.

Two import-isolated runtime bricks attach below those studs:

- the bound-action bridge validates the exact protocol, mode, item, effect, and plan digest; persists or reloads a private exact-JSON descriptor through an injected catalog; returns only the neutral binding fields to the coordinator; and delegates observation/removal without learning descriptor meaning; and
- the exact-artifact inventory contributor consumes only locally injected source, activity, record, discovery, and observation ports. It projects absent/created/adopted/foreign state, blocks discovery while mutation is active, double-observes provenance/activity around discovery, re-observes the exact action before binding, and writes the complete private descriptor plus neutral plan input to a revisioned record before reporting the binding.

After a partial or complete effect, a fresh contributor instance projects the same frozen neutral fragment from the durable record. It does not reconstruct deletion authority from the remaining live tree. A changed source, active mutation, changed descriptor, conflicting plan, corrupt record, or substituted content fails closed before removal. The application coordinator still owns literal `REMOVE`, plan-digest acceptance, durable planned/attempted/observed/reconciled phases, and bounded restart behavior.

The integration proof installs the exact current committed subject only into a disposable temporary home, independently verifies that fixture, composes the neutral bricks, removes only that fixture's exact component tree, and recreates every process-local object to prove durable absence reconciliation. Public plans/results contain no path. Separate tests prove same-size content substitution is ambiguous and preserved; foreign state is preserved; active mutation prevents discovery; source drift before binding creates no durable record; missing contributors keep coverage incomplete; non-JSON private descriptors and substituted bindings fail closed; and the new modules contain no neighboring topology or higher-level owner identity.

There is deliberately no production contributor registration, application/purge completeness claim, CLI route, live installation effect, or receipt-retirement/operation-rotation mechanism in this candidate.

## Local qualification

Final-byte qualification under the exact supported minimum Node 22.16.0 passes:

- focused inventory/removal/state/LEGO tests on current Node and exact Node 22.16.0: 44 passed, 0 failed on each runtime;
- bounded repository preflight: 2 standalone artifacts, 230 syntax files, 2 JSON files, and 188 targeted test files, including every source and regression changed by this slice;
- repository-execution architecture plus product/standalone gates: 37 total, 36 passed, 1 expected Windows symlink-capability skip, 0 failed;
- complete serialized suite: 1,995 total, 1,974 passed, 21 expected platform skips, 0 failed in 193.5 seconds;
- doctor: exit zero and `ok: true`, coding adapters disabled, repository execution unavailable/fail-closed because no persistent-environment route is configured, and lifecycle still `setup-reentry-required`; and
- standalone regeneration check and diff hygiene: clean.

No setup, elevation/UAC, protected service, provider, image, environment, VM, guest, repository-code execution, model-adapter, live installation-removal, or GPU/CUDA effect occurred. Commit and push this candidate on the isolated branch, then require exact-head Ubuntu/Windows smoke/full plus doctor before accepting it or beginning the next producer-composition assessment.

## Hosted acceptance

Exact implementation `34cdada887a8f327e77e08c5ea380c06ecb01a42` passed Ubuntu smoke/full and Windows bounded-smoke/serialized-full plus doctor in [GitHub Actions run 33316264686](https://github.com/iteathen/DevBridge/actions/runs/33316264686). The artifact inventory, bound-action bridge, aggregator, exact discovery digest, and their registered smoke coverage are accepted as lower bricks.

Keep #391 open. Next assess exact production composition for the Permanent Entry ownership surface: installer mutation admission/activity, wrapper and selected/current generation receipts, staging/quarantine and retained-generation boundaries, and durable receipt retirement/operation rotation. Do not expose application removal until required producer coverage is complete; do not infer full purge or provider/environment cleanup from this acceptance.
