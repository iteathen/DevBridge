# HO164 — capsule installation-source mismatch

Status: demonstrated release-input/consumer integration defect; correction not implemented. This supersedes blindly proceeding from HO163 to APT wiring. Existing projection, UDF writer and owned construction data medium remain valid; do not redo them.

Tracking: #488, dependency of the #197/#417 consumer path. No authorization wait.

## Assessment and evidence

At a61e899072a1264a30a749ae7c37e69f464e050f, UbuntuProductionSeedFactory selects ubuntu-server-minimal. Its regression test explicitly rejects the full ubuntu-server source. This is deliberate: accepted PR #354 / commit041ebd4cb364c8141cfedc1b84c1902c90bd0423 avoided a demonstrated layered extraction failure, with later physical progress documented in DB-HO005 sections18–19. Restoring the full source would undo that correction without new proof.

The retained, qualified ho149-evidence/evidence.json instead binds installSource ubuntu-server, leaf ubuntu-server-minimal.ubuntu-server, two ordered layers, and status from the upper layer. The real solver's710-package base has semantic SHA256 a6df9eb75cd023b9bf06cffd0732f491c12fb342138d360909ec49f3e0df3f6f and its1120-package result has SHA256 0d1172910b629988b6df07286506dc853982c3d2019d8678ff2c1cb8b0a3f42f. These are the transaction hashes in published capsule manifest66956be8bec7b04631d9510c99b90f1d45edd6989ea6ff8570d7b9531f54f6ce. Source ISO remains dec49008a71f6098d0bcfc822021f4d042d5f2db279e4d75bdd981304f1ca5d9.

The current signed release owns ISO digest and transaction base/result hashes, but does not carry the install-source identifier. The producer preparation receipt does carry it. Therefore successful acquisition, signing, publication and native media readback do not prove that this capsule applies to the current installer. The published capsule is not corrupt; its proved base differs from the intended consumer. Do not relabel it, change the installer to fit it, bypass the base hash, or reuse an existing construction subject.

There is a second unproven boundary: Subiquity late-commands execute after package/update installation. Choosing the correct extracted source alone does not establish that the late-command target still equals its extracted dpkg state. Actual installer changes (kernel/bootloader/SSH and others) must be inspected and qualified at the exact transaction seam, not excluded from state comparison by ad hoc filtering. Current full-server solver result has no grub-efi/shim package entries; this is evidence to investigate, not by itself proof of the actual installed target's contents.

## Research and owner-directed correction plan

Canonical source selection authority is the exact ISO's casper/install-sources.yaml; the source default is not consumer authority. Primary reference: https://canonical-subiquity.readthedocs-hosted.com/en/latest/reference/autoinstall-reference.html#source . The same reference documents late-commands after installation/updates and explicit mirror/geoip behavior. Existing UbuntuInstallerLayerEntrySource, UbuntuCapsuleSolverInputPreparer and UbuntuAptTransactionSolver are the appropriate reusable owners; no new extraction/solver implementation in setup or seed.

1. Bind the actual production source choice through one explicit Ubuntu installation-basis contract shared by release preparation and construction. Preserve the minimal source correction. Extend the existing signed release contract where necessary so a consumer can reject source mismatch before acquisition/media/VM effects. Do not copy lower-layer layer-expansion rules into upper-layer policy.
2. Establish exact minimal-source package-state evidence using the existing product-owned extraction and APT preparation/solver on a qualified Ubuntu runner. No live-host VM repair, second local VM, synthetic status or altered current signed capsule. Preserve useful current caches for digest-addressed reuse after new selection; do not blindly recapture all bytes.
3. Prove the offline APT transaction at its actual supported installer seam, including base/result state and installer-owned additions. Preserve original Canonical signature/index/expiry validation. None of the three current InRelease files contains Valid-Until; no need has been demonstrated for an expiry override. Acquire-By-Hash is advertised and file transport behavior still requires actual APT proof.
4. Produce a distinctly identified replacement release only after exact consumer-aligned selection qualifies. Preserve old signatures/history, bind new recipe/subject identities, then finish setup composition and exact-head CI/integration before physical installation/construction.

No source/manifest/signature changes, recapture, upload, new credentials, UAC or VM effect occurred during this assessment. Existing #197/#417 own the end-to-end dependency; record this distinct source-binding defect separately. Search of current issues found no competing source-binding issue. The overall goal stays active without an authorization wait.
