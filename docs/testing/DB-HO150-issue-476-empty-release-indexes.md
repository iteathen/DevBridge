# DB-HO150 — issue #476 empty ancillary Release indexes

Date: 2026-09-05

Status: correction under qualification; not integrated; no operational Hello World proof

## Assess → research → reassess

Accepted implementation: `11c16939127efd18063ac2e220e86d6caed370fa`, all-four integrated CI `33941500918` attempt 2. A fresh public-only hosted preparation/solver run `33943026596` (job `101243943577`) succeeded, using this implementation and wrapper head `83b6bf7a1fd50f400d2ab8fd6fc3866bce4dd0c0`. Artifact `9962449139`, 212450 bytes, SHA-256 `23a02cfed277b9d216ae19dad502a29e0703afce09311e10726820215296c3d1`, was admitted on Windows as exactly four regular files totaling 894407 bytes. All file hashes matched the exact run log before extraction. No runner path or instruction became host authority.

Windows normalized the real solution (710 base packages, 546 selected) and reproduced base digest `a6df9eb75cd023b9bf06cffd0732f491c12fb342138d360909ec49f3e0df3f6f` and result digest `0d1172910b629988b6df07286506dc853982c3d2019d8678ff2c1cb8b0a3f42f`. Installed native gpgv verified snapshot `20260821T230000Z` resolute InRelease against archive signer `F6ECB3762474EDA9D21B7022871920D1991BC93C`. Exact signed bytes: 135549 bytes, SHA-256 `45f95ce276cdba3e41870516a130e03c58b8b7a79e9546b0efe9e526d255740c`.

The one capture attempt failed in 1162 ms after that first read: `Ubuntu snapshot resolute InRelease checksum is invalid`. Its owner removed the partial destination. No package/source payload was downloaded. The authenticated table has 444 SHA256 rows, including 32 zero-byte ancillary debian-installer Packages indexes, all with the known empty SHA256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. The real APT solver had already accepted these metadata. This is an implementation defect, not a snapshot outage or UAC/VM failure.

Read AGENTS, DB-008 and applicable DB-003/007/009/019/020 authority, existing capture/verifier/builder implementations and tests before related tracker state. Debian repository format and Debian Policy describe checksum/size/name rows; the directly authenticated Canonical bytes establish the actual empty ancillary index case. References: <https://wiki.debian.org/DebianRepository/Format>, <https://www.debian.org/doc/debian-policy/ch-controlfields.html>. Debian wiki full-page fetch was blocked; no claim relies on inaccessible prose. No overlapping open capsule correction was found. #476 owns this demonstrated blocker under #417, on #197's eventual construction path; unrelated timeout issue #475 remains separate.

## Plan → execute

Use a fresh correction branch from accepted Stage 8, not the temporary qualification wrapper. Both existing consumers incorrectly duplicate strictly-positive checksum row grammar. Introduce one tiny release-owned row parser, shared by capture and independent verification; it owns decimal/digest/name row syntax only. Consumers retain signature, table uniqueness, path, selected-index, source, and object authority. Only InRelease tables opt into zero length, and zero must carry the exact empty SHA256. Source/DSC rows and all downloaded objects retain nonempty requirements. No new public manifest, provider, installer, retry, timeout, transport, or signing policy.

Two permanent composition regressions failed on the unmodified baseline at the exact capture and independent sealing parsers, while six prior tests passed. Correct that demonstrated seam, add malformed/unsafe size and empty-hash checks, duplicate/selected-empty rejection and rollback/retry checks. Qualify focused tests, preflight, architecture gates, full exact-head matrix, and doctor. Author-review the complete diff; do not call it independent review. Freeze exact candidate/base/tree/CI tuple before requesting integration authority. Native package capture resumes only against a qualified accepted implementation; no workstation construction or install follows implicitly.

## Qualification checkpoint

The corrected focused set passes 28/28 tests on native Windows Node 22.16.0. Repository-execution architecture gates pass 33 with one expected skip. A fresh read-only native probe verified the exact Canonical signature again and admitted all 444 checksum rows, including 32 empty ancillary rows; no package fetch occurred. Preflight and example-config doctor were launched and remain pending at this commit checkpoint. The complete CI matrix and exact-head review must complete before integration. No independent review is claimed. No schema, generated artifact, workflow, installation, or runtime policy changed.

## Cleanup and retained state

Canonical checkout remains outside OneDrive. Small admitted public evidence and capture intent/progress remain under the existing operator-owned LocalAppData release-authority directory for resumption; no ZIP, ISO, or failed capture root is retained locally. The prior exact Node 22 qualification directory remains subject to its separately recorded tool-policy deletion denial and is reused without duplication. No signing/R2 key, real release, installation, UAC, or VM was changed. The temporary hosted wrapper remains on its evidence branch, not this correction branch; hosted artifact expires after one day. Useful evidence must be admitted before removing that transport.
