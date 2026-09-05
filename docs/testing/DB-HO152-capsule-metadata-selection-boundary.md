# DB-HO152 — capsule metadata versus selected acquisition

Date: 2026-09-05

Status: native metadata qualification passed; complete candidate qualification pending

## Assess and research

PR #477 was explicitly authorized and squash-integrated as `1321a9a3c26714ac4fed09ce096a896e2002a438`, parent `11c16939127efd18063ac2e220e86d6caed370fa`. Its tree `feece13d0a399776797565e774c0ef844ca1045f` exactly matches the approved candidate. Post-integration CI `33944103043` passed all four Windows/Ubuntu full and smoke jobs on attempt 1. #476 is closed. This supersedes the pending integration status in DB-HO150; it does not imply Hello World or production capsule completion.

The next real capture (HO151) failed after 1243 ms and one authenticated 135549-byte InRelease read: `Ubuntu snapshot resolute InRelease path is invalid`. The exact resolute metadata SHA256 remains `45f95ce276cdba3e41870516a130e03c58b8b7a79e9546b0efe9e526d255740c`. Its 444 checksum rows include 24 unused DEP-11 HiDPI names containing `@2`, such as `main/dep11/icons-128x128@2.tar.gz`. #478 records the naming-boundary defect. The product rolled back its partial root; no packages were downloaded.

After the minimal path correction, native metadata qualification exposed #479: the unrelated, unselected `qgis-api-doc` signed record has size `3197044082`, SHA256 `1b7cfe82963152ee80bd3dd2951594efb6506cc4086c1467dc2b42b97545ad12`. Authenticated resolute/universe Packages.gz is 20128002 bytes, SHA256 `9dd6e056941dd060e14a12b9981df7a711c9a857b035a943893999bd37c94fbd`. Applying the 2-GiB download bound to every unused record incorrectly rejects the whole metadata index. This probe stopped after five metadata reads / 40190966 bytes and removed its operation-owned root.

AGENTS and applicable DB-007/008/009/019/020 authority, actual capture/source/verifier implementations and tests were inspected before tracker changes. DEP-11/AppStream metadata packaging is described by <https://dep-team.pages.debian.net/deps/dep11/> and <https://packages.debian.org/sid/hppa/apt-config-icons-hidpi>; exact signed Canonical bytes, not secondary reports, establish the observed filenames and sizes. No overlapping correction was found. #478 and #479 are distinct findings under #417 on #197's construction path, addressed together because both belong to this one capture metadata/selection boundary.

## Reassess, plan, execute

The existing capture brick is sufficient. Do not add an acquisition framework, package-specific exception, new provider, or transport policy. Permit `@` only for names in the signed index checksum table; downloadable package/source path alphabets and fixed selected index names are unchanged. Existing traversal, encoded separator, absolute path, query/fragment and duplicate rejection remain. An unused icon name cannot add a download.

Keep metadata binary identity validation positive, safe-integer, exact-digest and structurally strict. Move the unchanged per-object maximum enforcement to the existing `readExact` acquisition boundary, before invoking the reader port. Thus an unused large record is representable, but selecting an oversized object fails before its payload request. The existing source/index/2-GiB object/16-GiB total bounds are not increased. Independent sealing already accepts unused metadata names/positive safe sizes, so it needs no matching relaxation.

The HiDPI composition regression failed before correction. Both oversized-record regressions failed before the acquisition-boundary correction; after correction all 31 focused producer/capture/source/verifier/builder tests pass. New coverage rejects nine path-escape/redirection forms, verifies no ancillary/unused-large download, enforces selected oversize before any pool request, and checks failed-root cleanup and retry to the same destination.

## Native qualification and scope

The corrected candidate was exercised through the actual capture/source/native-gpgv ports with the retained exact real solver evidence. It verified all three Canonical InRelease signatures and all twelve exact binary/source gzip indexes: 15 metadata reads totaling 42655285 bytes. All record parsing succeeded and the first selected package acquisition was reached. The controlled reader then deliberately stopped before any `pool/` request with `METADATA_ADMITTED_BEFORE_PACKAGE_ACQUISITION`; capture rollback removed the scratch root and absence was verified. This proves the entire real metadata boundary, not just a standalone row parser, but does not prove binary/source acquisition, sealing or VM operation.

This metadata-only diagnostic is native control-plane qualification, not physical installation or construction. No need to integrate a partial correction merely to discover the next metadata defect. Existing accepted CI/commit requirements remain binding before actual installation/construction. Focused tests precede preflight, architecture gates, full matrix, complete-diff author review, and exact-head reporting. No independent review is claimed. No timeout/retry workaround, key, release, UAC, installation, VM, public schema or generated-product change is included.

## Retained state and next action

The canonical checkout and operator evidence remain outside OneDrive. Retain the four verified public HO149 files (894407 bytes) and terminal HO149/HO151 intent/progress; completed capture/probe roots contain nothing and were removed by their owner. No ISO or package cache was created. Reuse the existing Node 22 runtime; its prior tool-policy deletion block is not bypassed. Next: complete exact candidate qualification, review/report integration identity, then one new bounded full capture using the accepted mechanism and existing evidence. Do not overwrite old attempt journals or infer publication/construction authority from metadata success.
