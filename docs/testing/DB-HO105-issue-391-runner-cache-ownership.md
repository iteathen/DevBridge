# DB-HO105 — Runner-cache ownership receipts

Date: 2026-08-30

Status: accepted

Coordinates with: #116, #159, #180, #391, DB-003, DB-009, DB-011, DB-020, DB-HO100, DB-HO101, DB-HO103, and DB-HO104.

GPU/CUDA work is deferred and outside this checkpoint.

## Scope and nonclaims

This checkpoint owns durable, read-only cleanup authority for replaceable runner-cache payload created by the exact-checkout and content-addressed runner providers. It may add neutral ownership-state, exact-directory, action-routing, and inventory bricks; provider-local receipt composition; cache-local topology validation; provider publication changes; and disposable tests.

It must not expose deletion or uninstall commands, bind removal while a runner is active, retire receipts, rotate operations, remove stable runner authority, alter PATH/configuration/services, request elevation, mutate VM/provider/image/environment/guest state, execute repository code outside the existing runner path, invoke a model adapter, or implement GPU/CUDA features. Application coverage remains incomplete until the independently owned managed-runtime, Stage-0/cutover, PATH/profile, and protected-service contributors or exact-absence gates exist.

## Accepted baseline and assessment

The isolated branch is clean and remote-equal at `e65e99689bae2221142dc55121a80b1f9f921f84`. The accepted Permanent Entry inventory implementation `838212d7f1d05b464d59b2ca6657bd55897f7e7c` and documentation head passed Ubuntu smoke/full and Windows bounded-smoke/serialized-full plus doctor in GitHub Actions runs [33326909315](https://github.com/iteathen/DevBridge/actions/runs/33326909315) and [33327085620](https://github.com/iteathen/DevBridge/actions/runs/33327085620).

The production runner topology is shared beneath `<home>/entry/cache`:

- the content-addressed provider creates `objects/<sha256>.mjs`;
- the exact-checkout provider creates `checkouts/<subject-identity>` and a credentials-free `control-home/gitconfig`;
- development refs and production share this cache even though their stable selection state differs; and
- `<home>/entry/state` is durable selection/last-known-good authority and must not be classified as replaceable cache payload.

Both providers currently verify the subject before launch, but neither publishes ownership evidence. The content provider deletes and replaces a corrupt pre-existing object by pathname alone. That is not authorized cleanup: a digest-shaped name is not proof that DevBridge created or adopted the object. The checkout provider recursively deletes transient directories on failure. Its random name is locally selected, but no durable pre-effect intent currently survives a crash, so later recovery cannot distinguish its residue from substitution.

The shared directories are not exclusively owned trees while independently receipted children remain. Treating the whole cache as one recursive artifact would couple the two providers and authorize deletion of unknown entries. Treating only leaf files/trees as payload would leave structural directories unaccounted for. Each structural directory therefore needs an exact identity descriptor whose removal operation is only `rmdir` after registered children; it must neither enumerate children into its ownership nor recursively delete them.

The installer-local ownership-state and inventory-source implementations are logically neutral but physically owned by the installer namespace. Importing them from a runner provider would be an explicit boundary leak. Their neutral mechanisms must move to the runtime boundary, while installer and runner-cache compositions retain separate local protocols, roots, inclusion policy, and topology.

## Primary-source research

- [Node.js 22.16.0 filesystem promises](https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#promises-api) explicitly states that promise filesystem operations use the thread pool and are not synchronized or threadsafe. Reassessment: every cooperating provider mutation must enter one cache-local activity lease, while inventory re-observes the activity and exact source before accepting any later binding.
- [`fsPromises.mkdir()`](https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#fspromisesmkdirpath-options) creates directories and recursive mode may create multiple ancestors. Reassessment: successful `mkdir` cannot prove which operation created a directory. Reserve before mutation, then record an exact post-effect directory identity; adopt an existing directory only after rejecting indirection.
- [`fsPromises.link()`](https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#fspromiseslinkexistingpath-newpath) creates a new hard link and [`fsPromises.rename()`](https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#fspromisesrenameoldpath-newpath) renames a path. Reassessment: these are publication effects, not durable ownership transactions. A receipt reservation must precede the temporary/final path effect and completion must follow exact final-object observation.
- [`fsPromises.readdir()`](https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#fspromisesreaddirpath-options) does not promise canonical ordering. Reassessment: the cache-local source validates a bounded topology and sorts every observed entry and receipt identity before deriving its generation.
- Git documents that [`status --porcelain=v1`](https://git-scm.com/docs/git-status#_porcelain_format_version_1) is stable for scripts and that untracked-file policy is explicit. Reassessment: exact head, committed runner digest, real `.git`, and clean tracked/all-untracked status remain mandatory pre-receipt checkout adoption evidence. They do not replace a private exact-artifact descriptor.
- Microsoft documents [hard links and junctions](https://learn.microsoft.com/en-us/windows/win32/fileio/hard-links-and-junctions) and [reparse points](https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-points). Reassessment: exact files stay single-link, and Windows directory/file planning continues to use an injected reparse observer rather than assuming `lstat` alone proves direct topology.

## Ownership reassessment

The neutral ownership-state brick knows only a configured value protocol, control identity, immutable collection port, operation identifier, exact request/value data, and created/adopted provenance. It must not name an installer, entry, cache, runner, repository, Git, path, provider, VM, or consumer. The installer-local module becomes a thin protocol composition; the runner-cache composition gets a distinct protocol and journal.

The neutral exact-directory action knows only one local identity, an absolute directory location, exact filesystem identity, digest/byte accounting, and injected observation/removal ports. It reports present/absent/ambiguous and removes only the same empty directory. It never recursively removes content.

Runner providers own their local identities and topology. They receive neutral activity, ownership, exact-artifact, and exact-directory ports. They reserve before creating a final or temporary path, verify/adopt only through their existing exact subject contract, complete a receipt only after exact descriptor planning, and preserve any corrupt/unowned or ambiguous object. A failed fetch with no filesystem effect may clear its reservation; an uncertain or observed effect remains reserved for reconciliation.

The cache-local inventory source owns topology validation. It reads only its own receipt protocol, observes only its cache root, withholds completeness for pending receipts, unsupported/extra paths, missing receipts, unsafe indirection, or temporary residue, and assigns removal dependencies locally. A fully absent cache can report exact absence without inventing a receipt. Stable runner state and receipt/control journals are outside payload.

The first activity lease covers provider preparation/materialization. It makes receipt/source observation honest while cache publication is in progress. Launch-to-removal mutual exclusion remains a later mandatory boundary: because removal and binding are still unreachable from a user command, this checkpoint does not pretend a preparation lease protects an executing runner.

## Primitive-to-high-level implementation plan

1. Extract the accepted ownership-state mechanism into one import-isolated configurable runtime brick. Keep the existing installer wire protocol through a thin local composition and prove no compatibility fallback or duplicate implementation remains.
2. Move the accepted ownership-receipt projection mechanism to the neutral runtime boundary. Keep producer protocol decoding, inclusion, relationships, and topology in producer-local composition.
3. Add an exact-directory action with injected filesystem/reparse ports, exact identity/digest validation, present/absent/ambiguous observation, and empty-only non-recursive removal. Add a bounded protocol router only if the inventory needs more than one action implementation.
4. Add runner-cache-local receipt and preparation-activity composition under the canonical shared state root. Development refs and production use this one shared journal/lease; stable runner selection state remains separate and preserved.
5. Change the content-addressed provider to require the neutral ports, reserve before materialization, adopt only an already exact single-link object, preserve corrupt/unowned objects, publish from an operation-bound temporary path, and complete an exact file receipt before launch becomes available.
6. Change the exact-checkout provider to require the same neutral ports, receipt structural/control state, reserve before checkout materialization, adopt only a verified clean exact subject, use an operation-bound temporary path, publish and discover an exact tree, and complete the receipt before launch becomes available. Exact owned temporary cleanup uses the exact artifact action rather than unbounded recursive deletion; ambiguous residue is preserved.
7. Add the cache-local inventory source and production composition. Validate bounded complete topology against receipts, project private descriptors through the accepted neutral inventory, keep application coverage incomplete at aggregate composition, and leave removal unreachable.
8. Test normal creation/reuse, exact adoption, crash-style reserved/final reconciliation, concurrent activity denial, corrupt/unowned preservation, wrong head/digest/dirty checkout rejection, unknown/topology residue, symlink/reparse/hard-link substitution, receipt corruption/gaps, descriptor privacy, source/activity drift, shared-provider coexistence, absent cache, and stable-state preservation.
9. Run focused tests on current and exact Node 22.16, both bounded preflights, architecture/product/standalone gates, the complete exact serialized suite, doctor, generated-artifact/diff hygiene, then push the isolated implementation and require exact-head Ubuntu/Windows smoke/full plus doctor before acceptance.

## Acceptance boundary

Acceptance requires no legacy unreceipted provider path, no recursive deletion of an unowned/corrupt cache object, no external producer identities inside neutral modules, and no user-reachable removal. Application and purge coverage remain incomplete. No VM, guest, setup/elevation, protected service/provider/image/environment, repository-execution safety, model-adapter, or GPU/CUDA behavior changes.

## Implementation checkpoint

The local candidate implements the planned boundary without retaining parallel legacy mechanisms:

- topology-neutral runtime bricks now own exact value state, receipt collection/projection, process activity leases, exact empty-directory actions, and exact-action routing; the installer-local state, projection, and lease modules are thin protocol compositions over those bricks;
- both runner providers receive neutral subject, ownership, and artifact ports from one stable-entry composition, share one cache-local preparation lease, reserve before materialization, and complete exact receipts before returning a launch surface;
- content objects use operation-bound temporary files and exact hard-link publication, adopt only an exact single-link pre-receipt object, revalidate before launch, and preserve corrupt, unowned, conflicting, or ambiguous material;
- checkout trees use operation-bound temporary directories, fixed source fetches, credentials-free Git configuration with hooks/fsmonitor/credential helpers disabled, exact clean-subject verification, exact tree discovery, and exact non-recursive cleanup of only a discovered owned temporary tree;
- structural cache directories have independent exact identities and empty-only removal actions, while the cache inventory validates a bounded sorted topology against completed receipts and withholds coverage for pending state, unknown residue, indirection, or unsupported identities;
- cache receipt/control state and stable runner authority remain outside payload; the read-only cache contributor supplies only `application` coverage, and the aggregate deliberately remains incomplete while `runtime-payload` and the other audited contributors are absent; and
- candidate qualification and the installer now consume one permanent-entry component manifest. The complete suite caught the stale candidate-staging list after the transitive cache dependency was added; the duplicate list was removed and the regression is now part of bounded preflight.

Preparation activity does not claim launch-to-removal exclusion. No removal command is exposed, so terminal receipt retirement, operation rotation, and launch/removal mutual exclusion remain the next primitive dependency rather than an implied capability.

## Local qualification

All final checks used exact Node.js 22.16.0 on Windows without elevation:

- bounded repository preflight: 2 standalone artifacts, 253 syntax files, 2 JSON files, and 203 targeted test files;
- authoritative complete serialized suite from unchanged implementation bytes: 2,057 tests, 2,036 passed, 21 expected platform skips, and zero failures in 272.5 seconds;
- focused post-review cache/provider tests: 11/11; focused installer/candidate closure tests: 19/19;
- standalone artifact regeneration/check and `git diff --check`: passed; and
- doctor: `ok: true`, coding-model adapters disabled, execution disabled, and repository execution unavailable/fail-closed because no persistent-environment route is configured.

Initial hosted run [33330536875](https://github.com/iteathen/DevBridge/actions/runs/33330536875) passed Ubuntu smoke/full and Windows serialized-full plus doctor, but the Windows smoke step was killed at its exact two-minute bound before preflight emitted a result. The full Windows suite completed successfully in 2m50s, and the same 203-file bounded preflight completed locally in about 98 seconds. GitHub documents that a step `timeout-minutes` is the maximum duration before the process is killed and that the enclosing job has its own independent timeout. Reassessment: preserve every targeted test and the concurrency-two Windows resource bound, raise only the Windows preflight step to three minutes, and raise its enclosing smoke job to four minutes so setup and the remaining smoke checks have a real budget. Do not remove tests, increase concurrency, suppress failure, or treat the timed-out run as acceptance. Require the corrected exact-head matrix. See [GitHub Actions workflow timeout syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepstimeout-minutes).

No setup/UAC request, protected service/provider/image/environment mutation, VM start, guest operation, repository-code execution, model invocation, publication/removal action, or GPU/CUDA work occurred. The local evidence is supplemented by the hosted exact-head acceptance below.

## Hosted acceptance

Exact implementation and CI-contract head `5497c46e4f55a9ab734538eb79bac138ddc6baf8` passed Ubuntu smoke/full and Windows bounded-smoke/serialized-full, repository-execution architecture gates, standalone regression, and doctor in [run 33331176770](https://github.com/iteathen/DevBridge/actions/runs/33331176770). Windows bounded preflight completed inside the corrected three-minute step budget without dropping tests or changing concurrency.

Accept this runner-cache receipt/inventory checkpoint and keep #391 open. Application and purge coverage remain incomplete, removal remains unreachable, and the next primitive dependency is launch/removal mutual exclusion with terminal receipt retirement and operation rotation. Do not infer setup, provider/VM/guest, repository-execution, model-adapter, uninstall, or GPU/CUDA readiness from this acceptance.
