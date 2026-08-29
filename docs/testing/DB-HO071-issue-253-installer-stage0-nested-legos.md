# DB-HO071 — Issue #253 installer and Stage-0 nested LEGO plan

Date: 2026-08-29

Status: implemented and locally qualified; hosted acceptance pending

## Scope and governing contracts

Issue #253 is the next non-elevated child under #244 after #252 and the independently discovered setup-authority serialization defect #371. The active functional Stage-8 branch is physically gated by the future protected-service refresh, so this structural work may proceed without displacing a safe runnable host action.

The following live material was read before planning:

- DB-003, DB-009, DB-011, and DB-020;
- `docs/design-principles.md`, `docs/lego-module-contract.md`, and `docs/nested-lego-restructuring.md`;
- `docs/bootstrap-durability.md`, `docs/bootstrap-compatibility.md`, `docs/permanent-entry.md`, and `docs/self-install.md`;
- closed zero-state prerequisite issue #238 and open parent issues #244/#253;
- the complete current `install-devbridge.mjs`, `bootstrap-devbridge.mjs`, `src/bootstrap/exact-source-acquisition.mjs`, installed entry, and stable-entry composition;
- every direct installer/zero-state test and the current repository preflight registration.

This issue is structural. It does not authorize setup, installation, service refresh, UAC/sudo, provider/image/environment/VM/guest mutation, repository execution, or publication outside the already authorized development branch.

## Exact baseline

Assessment is bound to branch `stage8/362-protected-activity-channel` at `2a05119947401bc05fee7d586c3c4e8071bf3e52`.

The direct baseline command covered installer, zero-state, exact-source, setup handoff, and permanent-entry parent behavior. It passed 37/37 with zero failures.

Current implementation inventory:

- `install-devbridge.mjs`: 735 lines. It owns Node/version and selector values, CLI parsing, isolated Git execution, exact subject resolution, exact checkout, component path/manifest admission, component publication/quarantine, installer locking, wrapper generation/publication, setup continuation, and parent sequencing.
- `bootstrap-devbridge.mjs`: 389 lines. It owns Node/version and selector values, CLI parsing, exact GitHub ref observation, durable selection state, bounded HTTP retrieval, temporary stage publication/loading, exact-source-child acquisition, cleanup, installer/setup continuation, and parent sequencing.
- `src/bootstrap/exact-source-acquisition.mjs` is already one healthy nested child: it owns only bounded exact-revision file acquisition and disposable partial cleanup.

Both parents are valid security-sensitive domains, but each physical source surface contains multiple independently changeable state/effect responsibilities. A bounded change to wrapper publication currently requires loading Git isolation, manifest admission, lock recovery, and setup continuation into attention. A bounded selection-record change currently requires loading HTTP, temporary module materialization, installer invocation, and source cleanup. This meets #244's agent-attention criterion.

## Parent contracts that remain frozen

The installer parent retains:

- the exported installation/status/lock protocol values;
- fixed source repository and explicit installed component membership;
- public callable names and behavior for Node validation, selector normalization, argument parsing, exact subject resolution, component verification, installation, tracked development-ref persistence, setup continuation, and help;
- exact subject selection, installation-root topology, component target selection, ordered install transaction, and result shape;
- the JavaScript wrapper as the authority-changing commit point;
- setup handoff only after lock release and successful installation commit.

The zero-state parent retains:

- the exported bootstrap protocol/source/stage identities;
- public callable names and behavior for Node validation, argument parsing, selection path/read, durable subject resolution, selection clearing, stage fetch, bootstrap run, and help;
- branch-to-exact selection authority and argument-equivalent recovery;
- stage/source/installer/setup sequencing and cleanup topology;
- clearing the durable exact selection only after the installer commit returns successfully.

Externally durable protocols and record shapes remain unchanged. The redundant internal `pinSelectedRunner` handoff field is not a durable protocol or independent authority: exact pinning is already completely derivable from `selectedRunnerRef`. It will be deleted rather than carried as a compatibility path. Generated wrapper behavior and status fields remain unchanged.

## Primary research

### Standalone ES-module shape

Node 22 documents `file:`, `node:`, and `data:` ES-module support. A `data:` module can resolve built-in `node:` imports and other absolute specifiers, but cannot resolve relative specifiers because a data URL has no relative base. This explains why a normal extraction followed by relative imports would break the supported first-byte `data:` bootstrap and copied single-file installer.

Source: [Node.js 22 ECMAScript module `data:` imports](https://nodejs.org/docs/latest-v22.x/api/esm.html#data-imports).

The supported modular/source and one-file/distribution requirements can coexist by deterministically embedding isolated child-module bytes as `data:text/javascript;base64,...` specifiers in the committed standalone artifacts. Each child may import only Node built-ins and must not import siblings or local relative modules. A build/check adapter owns only this transformation; it does not run installation logic or create runtime authority.

### Filesystem publication and lock observations

Node 22 documents that `writeFileSync(..., { flush: true })` calls `fsyncSync()` after a successful write. It documents `linkSync()` as hard-link creation and `renameSync()` as the underlying rename operation. These primitives support the current file-before-name-publication sequence, but the documentation does not make a cross-platform claim that every containing-directory update is crash-durable merely because file contents were flushed. This structural change therefore preserves the existing effect order and exact rereads without inventing a stronger durability claim.

Source: [Node.js 22 filesystem APIs](https://nodejs.org/docs/latest-v22.x/api/fs.html#fswritefilesyncfile-data-options).

Node documents signal `0` as a platform-independent existence test. It is not a process-generation identity. The current installer lock consequently remains deliberately conservative: an existing PID, including a reused PID, fails closed; reclamation happens only after absence plus exact lock-file identity re-observation. The extraction must preserve that behavior rather than turning PID observation into unsupported ownership proof.

Source: [Node.js 22 `process.kill()`](https://nodejs.org/docs/latest-v22.x/api/process.html#processkillpid-signal).

### Fixed Git source compatibility path

Git documents `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, and `GIT_CONFIG_NOSYSTEM` as ways to replace/skip inherited configuration, and `GIT_TERMINAL_PROMPT=0` as disabling terminal credential prompts. Git configuration documents `protocol.<name>.allow`, while `git ls-remote --exit-code` reports failure when no matching ref is found. These are the current direct-installer compatibility controls and remain owned by one source child. They must not leak into the parent or another child.

Sources: [Git environment variables](https://git-scm.com/docs/git#Documentation/git.txt-codeGITCONFIGNOSYSTEMcode), [Git protocol policy](https://git-scm.com/docs/git-config#Documentation/git-config.txt-protocolallow), and [`git ls-remote`](https://git-scm.com/docs/git-ls-remote).

### Exact GitHub ref observation

GitHub's current REST documentation defines the single-reference endpoint with a full `refs/heads/...` response and exact commit SHA, permits unauthenticated reads for public repositories, and returns 404 when the ref is absent. The zero-state source child will keep validating both the full returned ref and exact 40-hex commit before durable selection.

Source: [GitHub REST — Get a reference](https://docs.github.com/en/rest/git/refs#get-a-reference).

## Reassessment and selected structure

A simple relative-import extraction is rejected because it would make the first-byte `data:` module and copied standalone installer nonfunctional. Keeping all mechanics in two physical files is rejected because it does not solve the #244 reasoning boundary. Hand-maintaining modular and bundled copies is rejected as duplicate/legacy code.

Use modular source parents plus deterministic committed standalone artifacts:

```text
modular parent source
  -> isolated child modules (Node built-ins only; no siblings)
  -> deterministic standalone-artifact builder
  -> root single-file bootstrap/installer artifacts
```

The root artifacts remain the public/distribution modules and preserve their exports. Their implementation comes only from the modular source graph. Preflight regenerates in check mode and fails on any drift, missing child, unembedded relative import, or unexpected artifact difference.

Installer children:

1. input contract — Node/version, selector, and argv normalization;
2. source channel — reduced Git environment, exact ref observation, and exact checkout verification;
3. component store — contained file values, manifest creation/verification, staged component publication, and quarantine;
4. mutation lease — exclusive installer admission, conservative liveness, exact stale-record reclamation, and non-authoritative release;
5. entry publication — wrapper value, same-directory staging, prior JavaScript preservation, ordered delegate publication, and JavaScript commit point;
6. continuation — fixed installed-launcher setup handoff and bounded exit status.

Zero-state children:

1. input contract — Node/version, selector, and argv normalization;
2. selection state — record validation, exact-path storage, link-based first-writer publication, recovery comparison, and exact clearing;
3. source channel — bounded fetch, exact-ref observation, exact raw-file retrieval, and response validation;
4. temporary materialization — exact temporary stage/source-helper publication, module contract admission, prepared-source cleanup, and partial cleanup.

Only each parent composes its children and supplies fixed protocol/source/component/stage constants plus current sequencing. Children expose local actions and values, import no sibling or parent, name no setup/provider/repository-task/model/VM topology, and receive no broad foreign objects.

## Dependency-ordered implementation plan

1. Add the deterministic standalone-artifact build/check adapter and a focused proof that a source parent plus import-isolated child becomes one executable module with byte-stable regeneration and no remaining relative import.
2. Extract installer input and source responsibilities. Preserve every public normalization/error/result contract and exact reduced Git argv/environment. Add direct child tests before changing later effects.
3. Extract component-store responsibility as one complete manifest/admission/publication state machine. Keep the explicit file membership in the parent and pass it as immutable local data.
4. Extract the complete mutation lease and entry-publication responsibilities. Preserve exact effect order, file-identity checks, conservative PID behavior, cleanup, wrapper bytes, and commit point.
5. Extract setup continuation and reduce the installer source parent to public constants/re-exports plus explicit transaction composition. Delete moved implementation and the redundant pin flag; do not retain wrappers around a second implementation.
6. Generate `install-devbridge.mjs`, prove a copy with no neighboring source still passes syntax/help and completes the existing fixture transaction.
7. Extract zero-state input, selection-state, source-channel, and temporary-materialization responsibilities. Keep exact selection/install/setup sequencing in the parent and keep the existing exact-source acquisition child independent.
8. Generate `bootstrap-devbridge.mjs`, prove direct `data:` import and branch-movement/interruption recovery with no Git executable.
9. Add source-isolation tests: every child imports only Node built-ins, no child imports/names a sibling, parents alone name current topology, and generated artifacts are exact.
10. Register modular parents, children, artifact checker, and targeted nested tests in repository preflight without displacing the existing standalone smoke or full parent/recovery suites.
11. Run focused tests, repeated real-filesystem/Git recovery tests, public export/JSON equivalence checks, preflight, complete suite, doctor, `git diff --check`, and topology searches.
12. Document implementation evidence, commit/push the exact branch, require exact-head Windows/Ubuntu CI, update #253/#244, and close #253 only after hosted acceptance. No physical install/setup/provider/VM action is part of acceptance.

## Explicit nonclaims

This plan does not make Stage 8 physically operational, refresh the installed Windows service, perform Linux systemd installation, qualify Hyper-V/libvirt/qcow2, run either guest C canary, or implement GPU/CUDA behavior. It does not strengthen the existing filesystem primitives beyond their observed/documented contract and does not introduce a second installer, Stage-0 authority, or legacy reader.

## Implementation checkpoint

The implementation follows the selected source/artifact split without retaining either monolith as a second hand-maintained code path:

- the installer source parent is now a 191-line composition/public-contract module around six children for input, source, component storage, mutation leasing, entry publication, and continuation;
- the zero-state source parent is now a 153-line composition/public-contract module around four children for input, durable selection state, bounded source retrieval, and temporary materialization;
- every child imports only Node built-ins, imports and names no sibling, and accepts only its neutral local values/actions; concrete filenames, protocol values, source endpoints, wrapper routes, operation names, and current topology are supplied by the parents;
- `scripts/build-standalone-artifacts.mjs` deterministically compiles the two source graphs into the committed root artifacts by embedding children as `data:` modules;
- `src/bootstrap/standalone-artifact.mjs` rejects an incomplete/duplicate child set, any child import outside `node:`/`data:`, duplicate parent imports, and any remaining relative import;
- repository preflight checks exact generated bytes before syntax/tests, so a changed source, child, or committed root artifact cannot silently diverge;
- the redundant `pinSelectedRunner` field and handling were deleted. `selectedRunnerRef` remains the one selection value, and the entry publisher derives exact pinning locally from it. No compatibility reader or alternate implementation was added.

The public root artifacts remain independently executable single files. Their export sets and argument projections match their modular parents. The installer retains reduced no-prompt Git execution, exact source verification, contained component admission, content manifests, quarantine, exact lock-file identity checks, conservative PID liveness, prior-wrapper preservation, JavaScript-last publication, and post-install setup handoff. Stage 0 retains exact branch observation, first-writer durable selection, argument-equivalent recovery, bounded stage/helper retrieval, Git-free exact-source materialization, commit-before-selection-clear ordering, and temporary cleanup.

## Local qualification evidence

All evidence below was collected on Windows without setup, UAC, protected service/provider/image/environment/VM/guest effects, repository execution, or product publication:

- focused standalone, nested-boundary, installer, selection, exact-source, and handoff suites: 24/24 passed;
- three additional real-filesystem/real-Git recovery repetitions: 19/19 passed in each repetition;
- repository preflight: 2 exact standalone artifacts, 199 syntax files, 2 JSON files, and 160 targeted test files passed;
- complete serialized suite: 1,798 total, 1,782 passed, 16 expected platform skips, zero failures;
- doctor: passed and continued to report repository execution unavailable because no persistent-environment routes are configured;
- exact artifact regeneration check and `git diff --check`: passed.

The next acceptance step is exact-head hosted Windows/Ubuntu CI. Close #253 only after all four jobs pass on the committed implementation. This structural checkpoint does not change the physical readiness gates listed under the explicit nonclaims.

## Hosted attempt 1 and line-ending correction

[GitHub Actions run 33281103991](https://github.com/iteathen/DevBridge/actions/runs/33281103991) on implementation commit `6a8efc9cf0d494d034210b6b6dd7a2ce6dfac081` passed both Ubuntu jobs. Windows smoke failed immediately and correctly at the exact artifact check: both generated root launchers were reported stale after checkout. The Windows full suite continued separately.

The source and committed Git-object bytes are LF. With no repository attributes, the hosted Windows checkout was free to materialize CRLF working-tree bytes, while the deterministic compiler deliberately emits canonical LF. Git's `gitattributes` documentation defines `eol=lf` as LF line endings in the working tree and requires the path to be treated as text. Add that contract only to the two generated root artifacts. Do not weaken exact comparison, normalize the artifact during verification, or impose a broad repository-wide line-ending policy.

Source: [Git attributes — Effects (`eol`)](https://git-scm.com/docs/gitattributes#_effects).

A local `checkout-index` qualification forced `core.autocrlf=true` and `core.eol=crlf`; both attributed artifact copies retained canonical LF with zero CRLF sequences and their exact expected byte lengths (24,241 and 46,817 bytes). Hosted Windows remains the acceptance authority for the correction.
