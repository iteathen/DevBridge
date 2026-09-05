# HO162 — exact-file media for #487 / #197 / #417

Status: local implementation and native media qualification; construction consumer branch remains unfinished and unintegrated.

## Assessment / research / reassessment

The published capsule's repository projection has2564binary/metadata/source files,2914454740bytes and99-character filename segments. Existing IMAPI text media is intentionally small and cannot carry it. NoCloud discovery intersects labelled devices with vfat/iso9660; therefore packages use a separate UDF data medium and existing CDFS seed behavior stays unchanged. This is not a new repository/cache/server/signature owner.

Microsoft's IMAPI contract supports UDF filenames up to255characters and file-backed IStream inputs. FreeMediaBlocks defaults to650MB; zero is unlimited and is not used. WorkingDirectory otherwise defaults to the host temp directory. Sources:

- https://learn.microsoft.com/en-us/windows/win32/imapi/disc-formats
- https://learn.microsoft.com/en-us/windows/win32/api/imapi2fs/nf-imapi2fs-ifsidirectoryitem-addfile
- https://learn.microsoft.com/en-us/windows/win32/api/imapi2fs/nf-imapi2fs-ifilesystemimage-put_freemediablocks
- https://learn.microsoft.com/en-us/windows/win32/api/imapi2fs/nf-imapi2fs-ifilesystemimage-put_workingdirectory
- https://learn.microsoft.com/en-us/windows/win32/api/imapi2fs/nf-imapi2fs-ifilesystemimage-put_stagefiles
- https://github.com/canonical/cloud-init/blob/main/cloudinit/sources/DataSourceNoCloud.py

## Implementation

The existing WindowsImapiDataMediaWriter gains `createFiles` for original relative paths plus exact regular-file location/size/SHA256 inputs. Its old `create` text contract remains intact. Source declaration admission, case/file-directory collision denial, existing-output protection and independent exact-file verification precede platform effects. Caller supplies finite image and operation budgets; the fixed deadline covers Node observation, native construction and result verification, with cancellation and no automatic retry. UDF resource acceptance is not a promise that arbitrary2TiB inputs finish within the supported operation window; only the demonstrated profile below is qualified.

The reusable acquisition-evidence owner exposes its existing held-file observer as `reobserveExactFile`, avoiding another consumer-side hash/identity implementation. The IMAPI adapter independently locks and hashes native file streams, preserves those streams until result completion, bounds output bytes, and explicitly releases COM/file resources. It writes inside exclusive identity-checked staging and publishes create-only on the same volume. Native stash files stay inside its owned working directory; no second package staging tree is created. Ambiguous/substituted scratch fails closed and is retained rather than broadly removed. Already published caller output is not erased by later cleanup failure.

This capability contains no Ubuntu filenames, package logic, snapshot, credentials, GitHub, VM management, NoCloud selection, or construction policy. The separate medium still needs attachment through the existing construction owner; setup/APT integration has not happened.

## Falsification and native evidence

Tests first failed because `createFiles` was absent. Focused tests cover NUL/nontext content, original long paths, exact-file identity, links, contradictory paths, unknown fields, size/time bounds, changed input, late failure, cancellation, foreign publication targets, retryability and old text behavior. Real native tests use non-elevated hidden platform commands to create/mount/read/detach exact UDF and CDFS images.

Two test-harness diagnoses were corrected without weakening production validation: Dismount-DiskImage output polluted JSON, so its output is explicitly suppressed; MSFT_Volume.FileSystemType does not identify UDF here, so exact Win32_Volume.FileSystem is observed by matching volume identity. Primary class references: https://learn.microsoft.com/en-us/windows-hardware/drivers/storage/msft-volume and https://learn.microsoft.com/en-us/previous-versions/windows/desktop/legacy/aa394515(v=vs.85) . Both native tests now pass, including exact99-character filename and binary bytes plus unchanged CDFS seed content.

The complete real capsule passed native UDF file enumeration/name/size/SHA256 readback twice. The final-code proof completed2026-09-05T07:30:44.804Z in95631ms (cleanup terminal95639ms), after binding IMAPI scratch to the owned root. Original capsule manifest66956be8bec7b04631d9510c99b90f1d45edd6989ea6ff8570d7b9531f54f6ce;2564files2914454740bytes. Generated image2925592576bytes/SHA256a9bdad93a3ef8cbf35ca4b6d8024aeaaef628f429a185d67a9a84e5c6db93c69. Every original name was enumerated case-exact and every file size/hash matched. The image was detached and removed immediately; no redundant3GB artifact retained. Earlier proof97055ms is superseded for scratch-placement qualification. No deterministic ISO-byte reproduction claim.

Native proof is Windows media creation/readback only, not a Linux mount/APT transaction, installed guest, VM construction, or GitHub Hello World. All existing VM/service/installation state is untouched. No UAC invocation occurred. Complete exact-head branch CI and integration qualification remain pending until the construction consumer is connected.

Final native-proof implementation file digests before Git line-ending normalization: media writer SHA256`16224ed161e917da2b32389cbc8f371bcc906b20afed4fb4aaa24483be164405`; evidence owner SHA256`afd8fab8c204c1d000bcdc5ff71560d1034096325b996d895fb6dbf59b430e33`. Later edits were tests/docs only.15/15focused tests and8/8setup/absence/product architecture checks passed. Separate native tests passed2/2; existing NoCloud suite passed3/3 including its direct ISO9660/Joliet directory inspection. First wider preflight found one stale source-shape assertion expecting an unconditional filesystem assignment. It now proves the unchanged text branch selects3 and receives no exact-file input, backed by both native CDFS/Joliet checks. No production validation was weakened.

Final preflight passed3standalone/294syntax/2JSON/233targetfiles; session32596 exited0. Native/full-capsule proof sessions81758 and78284 are terminal; temporary mounted images were detached and their scratch removed. The one-use full-capsule proof script was removed; compact receipts remain. Full branch CI is deliberately deferred until the cohesive construction-consumer implementation is complete; this is not an integration gate claim.
