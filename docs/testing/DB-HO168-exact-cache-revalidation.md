# HO168 — byte-identical runner-cache identity recovery

Owners: #159 (runner cache), #180 (recovery composition), #391 (receipt lifecycle). Separate from #491's cross-Node device observation. Baseline: Stage8 `7ead184fe841bc5a913273f52c2f883c9666f820`, tree `2a30ffb3d3614c4d31cd9982da436ff220e3421d`, all-four CI33957360077.

## Assessment and governing authority

HO167's agent ran plain Git status on the sealed cache. Git replaced `.git/index`; its SHA256 and bytes stayed identical, but the exact receipt correctly rejected the new inode/timestamps. The provider already disables optional Git locks. This is an agent-caused identity replacement and a missing recovery capability, not an incorrect ordinary observation check.

AGENTS.md, DB-009, application-management decisions2/3/6, the application recovery matrix, and the LEGO contract govern this work. Recovery must preserve installation authority, original receipt history and exact subject binding. The existing completed-cache branch has no recovery transition. Existing incomplete-publication cleanup is not an authority to rewrite completed receipts.

Git documents its optional index refresh and `--no-optional-locks` for background status: https://git-scm.com/docs/git-status#_background_refresh . Node documents independent asynchronous filesystem calls and rename semantics: https://nodejs.org/api/fs.html . Reassessment: matching bytes do not prove the old filesystem object survived. A replacement needs fresh exact evidence and a distinct durable generation, not a relaxed `observe` comparison.

## Narrow recovery design

This slice does not repair corrupt/missing caches, rewrite Git state, quarantine arbitrary directories, or claim full application recovery. It handles only byte-identical file replacement below unchanged exact owned directories.

1. The generic ExactArtifactSet owner gains read-only `revalidateFiles(manifest)`: require an exclusive, fully SHA256/byte-bound manifest; reobserve its root and every directory against original identities; use its existing planning/held-handle/hash/reparse/topology checks for every file; require unchanged directory identities after planning; and reobserve the fresh descriptor. Missing/extra entries, changed content, unbound digests, links/reparse state, root/directory replacement and unstable observation fail closed. Original `observe/remove` semantics do not change.
2. The generic ExactValueState owner gains one atomic `replace({item,value})` CAS for completed non-control items. Preserve identity, provenance and request; assign a new operation identity; append a completed generation through the existing journal without a reserved-state crash window. Reject stale expected items. Original journal revisions are retained.
3. The exact-checkout owner composes these capabilities only when its completed receipt is no longer present. Revalidate the entire original content contract, verify the exact Git subject with optional locks disabled, reobserve the replacement descriptor, then CAS the exact old receipt. No new source, path, registry, directory, cache or launch authority is inferred. Healthy reuse remains unchanged. Absent lower capabilities remain fail-closed.
4. Return bounded recovery evidence (old/new operation identity) with the prepared subject; ordinary launch continues only after a successful receipt transition. Do not silently claim the old inode survived.

## Qualification plan

First run regressions against the baseline to demonstrate the missing lower capabilities and byte-identical replacement failure. Test real filesystem replacement and real Git index content, unchanged replay, content/topology/identity attacks, incomplete manifests, stale CAS, rejected inputs, publication failure/retry and launch exclusion. Test receipt history and inventory generation consistency. Run focused checks, preflight, architecture/product/standalone gates, complete exact-head Windows/Ubuntu CI and author review. No independent review is claimed. Native canonical repair and a further protected merge remain outside unqualified source execution.

All fixtures must be disposable and self-cleaning. Do not run plain Git status on any sealed installed cache; use owner verification or `git --no-optional-locks` with fsmonitor disabled for diagnostic inspection. No VM/UAC/owned-state repair occurs during implementation.

## Local candidate evidence — 2026-09-05

- Baseline regressions demonstrated the absent lower revalidation capability and the real Git-index receipt mismatch before the consumer correction.
- Final focused artifact/provider/state tests: 38/38 on Windows with Node 24.15.0 (31.175 seconds) and Node 22.16.0 (30.556 seconds). These include stale inventory binding rejection, changed inventory generation, live competing activity exclusion, pre/post-publication failure reconciliation, immutable receipt history, no refetch, invalid JSON and reused operation rejection. Filesystem/Git observations are real fixture evidence; injected reparse checks are not native reparse qualification.
- Repository preflight: passed, 3 standalone products / 295 syntax files / 2 JSON files / 234 targeted test files. An earlier terminal result was unavailable; it is not counted as passing evidence.
- Architecture/product/standalone gate: 37 total, 36 passed, one expected ordinary-Windows symlink-capability skip. Generated installer rebuilt through the existing generator; regeneration and diff checks passed.
- Full serialized suite, example doctor and exact-head hosted matrix remain required. Record their terminal results against the candidate SHA in the PR and operator handoff rather than treating this pre-commit checkpoint as exact-head CI.
- Author review checked the complete owning-source diff, lower CAS semantics, immutable journal lifecycle, strict original observation/removal and the generated installer. No independent review is claimed.

Native non-claims: this candidate has not changed the canonical installation, old receipt journals, unused component, VM, service or UAC state. #491 remains separate. GitHub-delivered dual-guest Hello World remains unproved. After exact integration and post-integration qualification, use supported install-only entry under the workstation's Node 24, then owner-mediated cache recovery and fresh construction-retention observation. Never apply this unintegrated source directly to owned receipts.
