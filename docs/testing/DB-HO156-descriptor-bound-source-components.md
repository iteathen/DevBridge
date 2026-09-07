# DB-HO156 — descriptor-bound source component inventory

Date: 2026-09-05

Status: focused qualification passed; complete exact-head qualification pending

## Completed operational predecessor

#482 integrated as `dffb85bc2a57aea2a5c34ec17a33b646403d192a`, parent `6097240fa2a6d37418a0012ce1e495775d04edf2`, tree `ddb647645c6e83ba1496d7510a98c9ed85d9a270` exactly matches candidate `8f8bd959f7ce87b964eefb66861c73932ff3eb86`. Candidate CI33945774497 and fresh integrated CI33945952928 passed all four Windows/Ubuntu full/smoke jobs on attempt1. #481 is closed. This supersedes DB-HO154's pending status without rewriting its historical proof.

Native HO155 capture completed at2026-09-05T05:24:36.782Z in1594063ms (26m34s). It acquired and verified2564 artifacts/2914454740 bytes:15 metadata,546 binaries,2003 source files covering426 source packages. It passed the exact kernel source encoding seam that stopped HO153. Result receipt SHA256 `beffba9a1629b9ae90bedee2c0929f8dc2e6361ab61d488fefd9781052a432bf`. The capture is retained once, outside OneDrive; no recapture is required. This is not a sealed release, construction, or GitHub Hello World result.

## Assess, research, reassess

Read-only inspection of the next sealing precondition found #483: the Ubuntu authority child capped each source package at64 non-dsc files. Exact authenticated resolute/universe Sources.gz (16779065 bytes/SHA256 `9d246335cf6ccdd33177a4832bd91d8c346624094e5764a4e43dee54375900f5`) authorizes node-lodash4.17.23+dfsg-1 with292 files including its dsc, hence291 components. Its dsc is98395 bytes/SHA256 `1957b8d3cac9f6d4b4016bbd023bc1679ad12f663986be2a923306b11238874b`. Terminal capture confirms this is the only selected source package exceeding64.

AGENTS, DB-003/008/009/019, DB-HO129/130, actual authority/descriptor/capture/sealer/availability implementations and tests were inspected before changing this boundary. No overlapping fix was found. [Debian's source-package documentation](https://www.debian.org/doc/manuals/debian-handbook/sect.source-package-structure.en.html) and [dpkg-source](https://manpages.debian.org/unstable/dpkg-dev/dpkg-source.1.en.html) describe multiple upstream component archives in3.0(quilt). The64-file cutoff is not that format's completeness rule. Accepted authority requires every binary's complete exact source set.

The existing immutable descriptor already owns the global8192-object/65536-chunk resource limit. The manifest remains bounded at16MiB, dsc at4MiB, capture at2GiB per object/16GiB total. Copying gigabytes and decrypting a signing key against a demonstrated failed pure precondition would add no useful evidence, so local sealing has not been attempted yet.

## Plan and smallest ownership correction

In the existing Ubuntu semantic owner, derive source component cardinality from the already normalized descriptor's object count, reserving one distinct object for the source's dsc. Keep existing unique object claims and exact global descriptor coverage. Do not choose a larger magic constant, split one source identity into fabricated packages, drop components, add another registry, or change the neutral resource ceilings. No new public field or transport/timeout/VM behavior is introduced.

The before-fix pure65-file probe failed; both new regression groups fail before correction. After the one-condition correction the focused authority/descriptor/capture/sealer/availability chain passes38/38 on Windows Node22.16.0. Tests cover65 and the real291 components, signed round trip, canonical ordering, acceptance at the existing8192-object descriptor boundary, rejection at8193, missing/extra/duplicate claims, empty inventory, and insufficient descriptor cardinality including its required dsc. Existing hash/signature/path/mapping checks remain unchanged.

## Qualification, review and retention

Next: local preflight/architecture, complete exact-head four-job matrix, full-diff author review (not independent review), exact same-scope Stage8 integration, fresh integrated matrix, and local real sealing through the accepted memory-only host-key port. No physical installation/construction or default/protected promotion follows from this correction. #368 remains draft.

Keep the completed HO155 capture and compact receipt/journals until an independently verified replacement exists. Reuse those exact bytes; do not rerun the network capture for a manifest-only correction. Failed HO153 data and attributable completed test scratch were removed. No private key has been decrypted for sealing, no real release has been published/retargeted, and no VM/UAC/installation changes occurred. Cleanup will remove only attributable redundant scratch after proof; recovery and active installation state remain outside scope.
