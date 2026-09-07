# HO164 — capsule installation-source mismatch

Status: source-binding correction and exact minimal-source extraction/APT solving qualified at62b3c81232417af454bd958d0b76d4c0adf1102a. Actual installed-target transaction, complete hosted matrix and protected integration remain pending. This supersedes blindly proceeding from HO163 to APT wiring. Existing projection, UDF writer and owned construction data medium remain valid; do not redo them.

Tracking: #488, dependency of the #197/#417 consumer path. No authorization wait.

## Source-binding correction under qualification

The existing signed release contract accepts an explicit installSource and includes it in its canonical signing payload. Historical manifests without this field remain cryptographically verifiable without inferred source. Older readers already reject the new unknown field; no reader silently ignores a bound source. Generic capture/sealing preserve that signed value. New production policy requires the value, compares it against the product-owned preparation receipt, and checks that capture and sealing did not substitute it. Syntax is owned by the authority contract, not copied into the producer.

The repository consumer requires and compares its explicit expected source before acquisition. Minimal-source selection remains unchanged, exported from its existing seed owner as UBUNTU_PRODUCTION_INSTALL_SOURCE; no new source catalog, parser, layer-expansion implementation, solver, cache or native escape was introduced. Tests first failed on unsupported installSource. Source modification/removal, legacy omission, consumer mismatch, missing production policy and capture/sealer substitution have regression coverage. No old capsule was altered, resealed or republished.

The extractor intentionally consumes explicit operator-owned layer selections. A source label alone is not proof of the ISO catalog mapping. The next public-only hosted qualification must observe casper/install-sources.yaml from the exact digest-verified ISO and assert that the actual production source selects the single minimal fsimage before using the existing preparer/solver. This is exact-profile qualification of release policy, not a second production source resolver or an inferred universal mapping.

Observed Node22.16.0 preflight session85245 passed: 3 standalone artifacts, 294 syntax files, 2 JSON files, 233 dependency-selected tests. The previous session46474 ended without recoverable completion output and is not counted. Focused tests including setup architecture and unchanged production seed passed57/57 before adding the two late-substitution regression cases; the final producer file passed6/6 including those cases. Author review checked the complete source-binding diff and legacy signing-payload preservation; this is not independent review. Complete branch/platform qualification remains pending; no physical installation or construction follows from these portable checks.

## Assessment and evidence

### Qualified source-binding checkpoint

Implementation62b3c81232417af454bd958d0b76d4c0adf1102a, tree4a2f64af8865bc77ca2f20d574ebb86bad9d36fd, is published only on feature/197-capsule-construction-consumer. Protected Stage8 remains279fda350a39067047dc76c18c1c8f5c64f1766e, tree2f411f8f488beb4b3a7f5e660adb75ee17dbe56a. No PR/integration or four-job candidate CI is claimed.

The complete serialized Windows Node22.16.0 suite passed2,322 tests with24 platform/opt-in skips, zero failed/cancelled, out of2,346 total in388.013 seconds. The retained ho164-full-suite.tap has SHA2560941b6b4ec28edf0901b03a06e586159e8b5bc8805832700d21498fd65af472a. Native IMAPI checks were not re-executed; HO162 remains their separate unchanged evidence.

Public-only Ubuntu run33954632771 / job101275587025 passed at workflow wrapper782495adcbf19cdfee1ab49a929c116ffd272c98, checking out the exact implementation above. The digest-verified ISO catalog actually has version2 and identifies ubuntu-server-minimal as single fsimage ubuntu-server-minimal.squashfs. Existing product extraction, preparation verification and real apt-get solving yielded:

- base504 packages, semantic SHA256d7712d92c385d10ae7737fff0a76da4c1cbdd318f6b50c75ea03001457b645f4;
- result920 packages, semantic SHA2560ac416b3bed2eb9819ff64511ff49df351e076ca17b37142f1a7bb5b4eb4dc82;
- selected523 binaries, of which518 exact name/architecture/version identities occur in the old capsule's qualified selection;
- the five additional identities are git-man1:2.53.0-1ubuntu1, liberror-perl0.17030-1, libuv1t641.51.0-2ubuntu1, patch2.8-2build1 and python3-packaging26.0-1. This comparison is reuse planning, not admission of bytes or a replacement release.

The five exported public files total668,564 bytes and were re-observed as direct single-link regular files, compared to exact hosted sizes/SHA256, and admitted through the existing solution/package-state normalizers:

| File | Bytes | SHA256 |
| --- | ---: | --- |
| solution.json | 153220 | 0b51ca2d67a4733015efb8c20ca726207f5e07f60f7f63c73d4814e79a4baf6d |
| evidence.json | 3696 | 32f22d957878f453cef8221d9239c81420c0f5e1b40caf7ffcfd022fbacbb38b |
| base-status | 507291 | 64c1be75c4526c3f96bcf0c145b0fd42d3c83ef64d323dcc2f1e561069949f06 |
| ubuntu-archive-keyring.gpg | 3607 | 80a36b0a6de2f69f49d2df75ef473ccde121e9e190b9ea01d20a4f63778d5c31 |
| install-sources.yaml | 750 | 8977a8e3b57b8cc3c2cc4f92ba9f9e5d2c4b612aa7029e4fb84a4e0dbb02f2c0 |

Local evidence is retained under the established release-authority directory in ho164-minimal-evidence. Hosted artifact9966013266 was removed after verified admission; readback shows zero artifacts. The exact temporary proof branch was removed remotely with expected-head CAS and locally. Its workflow never entered the consumer feature branch. The disposable hosted ISO/layers were not copied to the workstation.

Cleanup removed119 attributable inactive test roots in two checked batches:5,108 files,22,176,053 bytes. Final fixture inventory is zero. No retained recovery caches, keys, images, installations, services, VM objects or guest disks were removed or changed.

### Actual transaction seam remains open

The newly qualified minimal base still lacks openssh-server and contains grub-pc rather than the later UEFI-installed state. Production seed explicitly asks Subiquity to install OpenSSH before late-commands. Canonical's implementation runs curtin extraction/curthooks, postinstall target-package installation and APT deconfiguration before user late-commands: https://github.com/canonical/subiquity/blob/fd4da11699ef061f1b59453c071e8cbbcc199867/subiquity/server/controllers/install.py . Therefore the extracted base cannot simply become the exact pre-late-command transaction authority. Do not sign or consume a replacement capsule from this partial evidence.

Read-only inspection found retained historical canary probes/completed images, but the journal contains qualification summaries rather than pre-transaction dpkg state. Current subject1247bff6897985fec3dc476b055e05a3 still has no probe/finalization/image; its old deadline must not be reset. Fresh host observation confirms the existing build VM Running, environment VM Off and lifecycle service Running; no guest-readiness claim follows.

Continue by establishing the actual supported installer transaction boundary through the existing Ubuntu release/installer owners and retained evidence before changing seed semantics. If extra observation capability is needed, add it at that owner with permanent regression and qualification; do not synthesize a dpkg base, filter out installer packages, patch a guest/owned journal, invent a second package resolver, or treat hosted nested virtualization as Hyper-V proof. Public GitHub documentation says hosted nested virtualization is not officially supported; no speculative hosted VM construction was attempted: https://docs.github.com/en/actions/concepts/runners/github-hosted-runners . This is an engineering dependency, not an authorization wait.

### Original mismatch assessment

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
