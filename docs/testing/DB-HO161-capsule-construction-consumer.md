# HO161 — sealed Ubuntu capsule construction consumer

Status: implementation in progress; no installation or physical qualification claimed.

Current checkpoint: HO162 has implemented the exact-file media dependency and proved the complete capsule's native Windows UDF write/readback. See `DB-HO162-exact-file-media.md`. The next incomplete connection is separate data-media attachment and exact offline APT consumption, then setup integration. The original scoped plan below remains the branch's full objective; do not restart completed projection/media work.

## Assessment and governing boundaries

Baseline `279fda350a39067047dc76c18c1c8f5c64f1766e`, tree `2f411f8f488beb4b3a7f5e660adb75ee17dbe56a`; integrated CI33949874380 all four green. HO160 completed real GitHub/R2 publication of the unchanged b5b912b source and Ubuntu manifest66956be8bec7b04631d9510c99b90f1d45edd6989ea6ff8570d7b9531f54f6ce. That is available input, not installer consumption or VM readiness.

Actual code: UbuntuPackageCapsuleAvailability verifies and reacquires all groups but has no setup caller. Ubuntu authority still resolves live snapshot indexes; production seed still emits live snapshot APT update/upgrade/install. WindowsImapiDataMediaWriter accepts only small UTF-8 text and is not a binary package carrier. Do not embed packages in text or copy provider limits into Ubuntu policy. Existing #197/#417 own this work; search found no competing capsule repository/media owner.

DB-020, VM migration/studs, DB-003/008/009 and existing release-input authority remain binding. One signed capsule owns snapshot/transaction/provenance. Availability owns acquisition. Ubuntu owns repository paths/APT semantics. Media adapter owns file carrier and platform limits. Existing construction owns VM/media attachment, lifecycle and retirement. No new resolver/cache/signer/HTTP server, host repository execution, manual guest repair, or duplicate VM.

## Plan for this branch

1. Project the verified capsule onto its original repository paths, binding every path to exact acquired object bytes. Reject file/directory collisions before acquisition or media mutation. Preserve upstream InRelease/index/binary/source bytes; no regenerated unsigned indexes.
2. Extend the existing media owner with a bounded exact-file input capability, independently qualified for binary files and failure/cleanup/identity boundaries. Keep existing text clients compatible. Prove provider media support using primary documentation and native evidence before claiming it.
3. Compose that carrier into Ubuntu construction and emit an offline package transaction bound to the capsule's exact base/result package-state identities. Inspect actual APT/Subiquity behavior first; do not disable signature/expiry checks, invent package pins or assume source media alone yields the expected base state.
4. Attach setup's selected release to the capsule availability/consumer rather than clock-selected live snapshot requests. Preserve old subject receipts; a new recipe cannot silently reuse a stale build subject.
5. Focused falsification, exact offline/native APT transaction proof, preflight/architecture/generated gates, full exact-head CI, complete author review, authorized integration and post-integration qualification before physical action. Reconcile retained VM through its owner and reuse it only when its exact subject permits; otherwise owned retirement/rebuild, not another live VM.

## Primary research and unresolved assumptions

Canonical autoinstall reference: https://canonical-subiquity.readthedocs-hosted.com/en/latest/reference/autoinstall-reference.html . Ubuntu26.04 APT source contract: https://manpages.ubuntu.com/manpages/resolute/man5/sources.list.5.html . These establish supported source/installer configuration surfaces; they do NOT yet prove this exact capsule transaction installs offline or that IMAPI accepts its complete layout. Those are remaining qualification tasks, not permission for flags that weaken validation.

Read-only host observation: lifecycle service Running; one existing environment Off; one build VM Running with last durable liveness classification stalled. No job-runner process was observed by the bounded filter. Preserve retained state; no fresh guest readiness claim. Read-only canary status inspects the journal; its run path can mutate, so do not invoke run merely to refresh status.

## Implemented first consumer connection and evidence

`UbuntuPackageRepository` composes the existing signed authority verifier and availability owner. It maps all metadata/binary/source objects to original repository-relative paths, rejects duplicate/file-directory collisions before acquisition, and returns immutable exact-file references for the media consumer. It adds no copied package tree, download, cache, APT invocation, signing policy, provider identity or VM effect. Source inputs remain subject to independent availability re-observation; the eventual media owner must independently admit exact files at use time.

The missing-module test failed before implementation. Exact Node22.16.0 focused qualification passes17/17 across repository projection, capsule availability, release-input verification and acquisition-evidence boundaries. Tests compare every projected path to the signed object's size/digest, verify bytes, cached re-entry, immutable outputs, cancellation, unknown fields, and signed path conflicts with zero acquisition calls. Preflight passes3standalone/294syntax/2JSON/232targetfiles. Setup/absence/product architectural checks pass8/8. Diff hygiene passes. No complete candidate CI or physical proof yet; do not integrate/install this unfinished branch on these narrower results.

Real capsule proof completed2026-09-05T07:07:50Z in22909ms using existing `ho155-offline-cache` through normal acquisition and re-observation, without creating another package copy. Exact manifest66956be8bec7b04631d9510c99b90f1d45edd6989ea6ff8570d7b9531f54f6ce projected2564files/2914454740bytes. Stable JSON path/size/SHA256 inventory digest `2706e39109c09e7169845d962261f1736de3af6b5f498577aa5a36dcf3f1be61`; longest path149, longest segment99, no case-fold collisions or percent paths. This proves real repository projection, not successful APT installation.

Distinct lower media capability is tracked in #487. Microsoft documents `AddFile` consumes IStream and `FreeMediaBlocks` defaults to650MB; zero is unlimited and is not an acceptable bound. Cloud-init's NoCloud implementation discovers labelled vfat/iso9660 media; do not blindly replace CIDATA with UDF-only. Native write/readback and actual filename preservation remain required. Relevant primary sources:

- https://learn.microsoft.com/en-us/windows/win32/api/imapi2fs/nf-imapi2fs-ifsidirectoryitem-addfile
- https://learn.microsoft.com/en-us/windows/win32/api/imapi2fs/nf-imapi2fs-ifilesystemimage-put_freemediablocks
- https://learn.microsoft.com/en-us/windows/win32/imapi/disc-formats
- https://github.com/canonical/cloud-init/blob/main/cloudinit/sources/DataSourceNoCloud.py

Next executable work on this same branch: research/reassess and implement #487's exact binary file capability in the existing media owner, preserving old text clients and proving native guest-consumed filesystem representation. Then continue items3–5 above. Do not rerun publication, recapture packages, create another acquisition cache, or start another VM. All proof/preflight processes are terminal at this checkpoint; no authorization wait.
