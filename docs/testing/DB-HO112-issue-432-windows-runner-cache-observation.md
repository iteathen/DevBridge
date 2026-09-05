# DB-HO112 — issue #432 Windows runner-cache observation

Date: 2026-09-01

Status: implementation candidate; hosted and installed acceptance pending

Coordinates with: #159, #180, #429, #430, DB-009, DB-019, DB-020, DB-HO105, and DB-HO111.

## Scope and observed failure

This checkpoint owns the Windows adapter cost of observing reparse-point evidence for an already bounded exact artifact set. It does not change checkout provenance, Git verification, file/directory identity, digest verification, receipt authority, cache cleanup, setup sequencing, UAC, provider state, VM construction, guest execution, or publication.

On the canonical physical Windows installation, `devbridge setup --track-ref stage8/362-protected-activity-channel` remained silent for more than twelve minutes before selected-runner or setup progress began. An exact zero-state installation of head `8880a1a3545493189d3b613b3f8e3ce53a167e0c` committed the permanent-entry component and reproduced the same runner handoff delay. Both observations were interrupted before setup, UAC, service, lifecycle, construction, or guest effects.

The current 2.3 MiB, 22-revision cache ownership record validates in 485 ms. The expensive edge was instead `ExactArtifactSet`: on Windows it asked the injected attribute adapter about every path before and after observation, and the adapter started a separate `powershell.exe` for each fixed `Get-Item` probe. This is below the setup/UAC owners in DB-HO111 and belongs to Permanent Entry runner-cache verification.

## Primary-source reassessment

- Microsoft documents that `GetFileAttributes` can determine whether a path has `FILE_ATTRIBUTE_REPARSE_POINT`: [Reparse Point Operations](https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-point-operations) and [File Attribute Constants](https://learn.microsoft.com/en-us/windows/win32/fileio/file-attribute-constants).
- Node documents `lstat` behavior for symbolic links and junctions, but does not make it the general observation contract for every Windows reparse class: [Node.js file system API](https://nodejs.org/api/fs.html).
- Git documents that `status` refreshes the index by default and that `--no-optional-locks` suppresses optional index updates: [`git status`](https://git-scm.com/docs/git-status). The exact-checkout provider already supplies `GIT_OPTIONAL_LOCKS=0`; this checkpoint does not alter Git invocation.

Reassessment: preserve the explicit Windows attribute adapter and reduce process-boundary crossings. Do not replace it with a narrower Node-only inference and do not weaken exact identity or content checks.

## Nested design decision

The design follows the repository hierarchy from the outside inward:

1. **LEGO:** `ExactArtifactSet` remains the platform-neutral ownership/integrity brick. The Windows observer remains a replaceable platform adapter. Their new stud is one bounded ordered batch of local paths and one equally sized ordered result.
2. **SOLID:** the neutral parent owns chunk sequencing and before/after policy; the adapter owns PowerShell and `FILE_ATTRIBUTE_REPARSE_POINT`; runner-cache composition owns wiring. Destructive removal retains the existing single-entry exact check and gains no wider authority.
3. **CUPID:** the batch protocol is composable, predictable, domain-named, and fail-closed. It rejects missing fields, extra fields, wrong count/order/index, invalid existence/reparse combinations, timeouts, truncation, and malformed output.
4. **KISS:** one fixed script handles at most 512 paths and 2 MiB of JSON input, with at most 256 KiB of output. No worker pool, daemon, cache of security observations, native addon, second artifact implementation, or setup-specific fast path is introduced.

Planning and observation obtain reparse evidence before and after the existing exact filesystem checks. Discovery batches only the direct children of the directory currently being enumerated; it will not recurse through a child already reported as a reparse point. The completed discovered manifest is still passed through the ordinary exact plan, which rechecks the complete bounded set. Any observation ambiguity remains non-retryable and no cleanup authority is derived from it.

## Candidate evidence

Focused Windows tests currently prove:

- fixed bounded adapter invocation and strict ordered result parsing;
- invalid/empty/oversized input rejection;
- no per-entry adapter calls during Windows plan and observe;
- 514 locations split exactly into `512 + 2` before and after observation;
- positive reparse evidence fails closed; and
- existing exact-artifact removal, unexpected-content, identity-drift, hard-link, digest, partial-recovery, discovery, and provider/receipt tests remain green.

Final local qualification used exact Node.js 22.16.0 on Windows. The focused cache/provider set passed 33/33; the repository-execution architecture gate passed 33 with one expected Windows symlink skip; bounded repository preflight passed two standalone artifacts, 255 syntax files, two JSON files, and 205 targeted test files; doctor reported `ok: true`, model adapters disabled, and repository execution truthfully unavailable pending setup re-entry; and the complete serialized suite passed 2,105 tests (2,084 passed, 21 expected platform skips, zero failures) in 349.1 seconds. Standalone regeneration and diff hygiene passed.

A read-only physical benchmark used the candidate source against an existing complete, receipt-bound checkout at exact head `0ace83bf25d131d0d6bcd4f00617b30e96f9bb93`. It observed all 1,017 descriptor entries as `present` in 3,481 ms. A separate older checkout at head `634c9b0479b1bc7dd19c7a53ce28fc15d2ebe3ec` remains correctly ambiguous because its recorded `.git/index` filesystem identity drifted after its receipt; this candidate does not reclassify or delete it.

## Remaining acceptance

Before issue #432 is accepted:

1. run repository preflight and the complete local suite on unchanged candidate bytes;
2. require Ubuntu and Windows smoke/full hosted jobs on the exact pushed head;
3. merge only that green head into Stage 8 and require fresh post-integration CI;
4. install the exact accepted Stage 8 component through the supported bootstrap path;
5. prove a canonical-cache entry invocation reaches the exact selected runner within a documented bounded budget; and
6. retire superseded cache payload only through its existing exact owned cleanup surface after the replacement path is proven.

No manual cache, receipt, activity-lease, PATH, service, ACL, provider, image, VM, or guest mutation is authorized by this checkpoint.
