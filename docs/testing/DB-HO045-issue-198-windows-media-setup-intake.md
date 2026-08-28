# DB-HO045 — issue #198 Windows media setup intake

Status: implemented and software-verified from exact predecessor `9ebb469891276873daf01800a6dbe9e00f09f6ca` on `stage8/362-protected-activity-channel`; physical media approval and Windows image construction remain pending.

## Assessment

The Windows construction owners are implemented, but they are not yet reachable from public setup. `windows-production-image-physical-canary` requires a preassembled authority plus an absolute source location, while `devbridge setup` discovers repositories and composes only the Linux development profile. No setup-owned mechanism currently:

- discovers bounded local Windows ISO candidates before presenting choices;
- reports the images inside each candidate without granting authority;
- records an exact operator approval for one candidate/image/source class;
- republishes the accepted value through the existing immutable media-authority catalog; or
- hands the exact accepted source to later Windows construction without persisting its path in generic profile or route policy.

The absence is a usability blocker, not permission to infer licensing, download opaque media, select an edition, or embed a product key. It is also not a provider concern: source discovery and approval must complete before Hyper-V construction receives an accepted subject.

The existing inspector and authority modules already own the difficult platform and validation primitives. The missing layer is a setup-owned selection transaction between them. It must not be folded into the generic image library, VM provider, environment profile, repository routing, or task protocol.

## Primary-source research

- Microsoft's [Windows 11 download page](https://www.microsoft.com/en-us/software-download/windows11) still presents the x64 ISO as multi-edition media suitable for virtual machines, requires interactive edition/language selection, says product-key state selects the installed edition, exposes short-lived download links, and provides a SHA-256 verification step after download.
- Microsoft's [Windows 11 Enterprise Evaluation Center](https://www.microsoft.com/en-us/evalcenter/evaluate-windows-11-enterprise) still requires registration and identifies the product as a 90-day evaluation. It is therefore a separate explicitly temporary source class, not an automatic fallback for normal owned media.
- DB-003 requires local operator configuration to grant host filesystem and capability authority. DB-007 requires payload-sensitive decisions to bind the exact reviewed subject. DB-009 requires observation and reconciliation before repeating effects. DB-020 requires profile selection to remain separate from repository selection and keeps source/provider paths out of generic execution topology.

There is no documented stable Microsoft API in the reviewed public source that lets DevBridge infer entitlement, accept terms, select an edition, and obtain a durable download URL noninteractively. Automated acquisition would therefore fabricate authority the operator has not granted.

## Reassessment

The smallest correct setup path is discover-first and approval-exact:

1. A Windows-owned source adapter scans only bounded local roots selected by setup and returns opaque source references. It owns filesystem paths; the selection core does not.
2. The existing inspector inventories each exact real ISO and returns its measured SHA-256 plus normalized contained images. Inventory is observation, never approval.
3. A path-free candidate subject binds the media identity and complete normalized image inventory. Setup can display this subject, digest, and image choices without granting construction authority.
4. Approval names the exact candidate subject, one image index, and either durable official-owned media or explicitly temporary Evaluation media. The source is re-inventoried before the effect; candidate drift fails closed.
5. The existing immutable authority catalog registers the selected media authority. Durable selection state records only the opaque source reference and authority subject; a local composition edge resolves the current source path transiently when construction is later invoked.
6. If no candidate exists, setup reports the two fixed official Microsoft acquisition handoffs. It does not download, open a browser, infer a license, choose Evaluation, or block an independently selected/ready Linux profile.

The selection core knows only candidate, selection, approval, and catalog contracts. It does not name a repository, provider, VM, environment, route, guest, credential, product key, source path, or downstream construction target. The source adapter owns local filesystem topology and can be replaced without changing selection logic.

## Dependency-ordered plan

1. Export a closed public normalizer for the existing Windows media inventory contract.
2. Add a bounded Windows source adapter that discovers only real non-symlink ISO files in explicitly supplied roots/locations and projects opaque references.
3. Add a setup-owned selection transaction with durable candidate state, exact candidate subjects, re-observation-before-approval, immutable catalog registration, and idempotent restart behavior.
4. Prove malformed inventory, source substitution, candidate drift, unsupported selection, silent Evaluation promotion, arbitrary paths in core state, and authority-catalog mismatch all fail closed.
5. Add setup CLI options only after the primitive tests pass: one explicit source-location hint, one exact candidate approval subject, one image index, and one source class.
6. Make plain setup discover the managed media inbox before returning acquisition instructions. Keep path-bearing source state out of remote `setup.status` projection.
7. Keep Windows media absence informational until Windows profile selection is composed; do not regress Linux construction or operational readiness.
8. Run focused tests, repository preflight, complete suite, LEGO source audits, and exact diff checks. Append implementation evidence before publication.

No UAC, provider mutation, VM construction, media download, browser action, source approval, or guest execution is part of this software checkpoint.

## Implementation evidence

The implementation follows the planned ownership order:

- `windows-install-media-source` owns bounded local roots, real non-symlink ISO admission, opaque source references, and a private path registry. Candidate discovery is the only operation that can add registry entries; resolving an already known reference performs no rescan or discovery write.
- `windows-install-media-selection` owns path-free inventory candidates, content-derived candidate subjects, exact explicit source-class/image approval, re-inventory before authority creation, and accepted source/candidate/catalog cross-binding. Rediscovery clears an accepted selection that is no longer observable without deleting its immutable catalog evidence.
- two thin state adapters persist only their local selection and source-registry contracts. Generic profile and route policy receive no source path.
- `windows-install-media-setup` is the composition edge for the source, existing inspector, selection, and existing immutable authority catalog. State-only observation does not create the managed inbox or invoke media inspection.
- public setup discovers local media before presenting exact approval commands. A missing or unusable Windows source remains profile-local while Linux can progress; a failed explicitly requested source or approval blocks that exact setup request.
- remote `setup.status` reports only bounded state/count/source-class/image facts. It removes the inbox, source reference, candidate subject, authority reference, ISO name/digest, repository identities, and local paths.
- official-owned and Evaluation are distinct closed source classes. Evaluation is never inferred and is always marked temporary. Setup publishes fixed Microsoft acquisition handoffs but performs no download, browser, terms, license, edition, or product-key action.

Boundary evidence covers malformed persisted inventory, source disappearance, path substitution, non-ISO and symlink refusal, candidate fanout, changed bytes after discovery, silent Evaluation promotion, valid-but-unrelated catalog authority rebinding, unsupported hosts, unusable media isolation, status without discovery effects, remote redaction, CLI separation, lifecycle-child capability denial, and LEGO source audits.

Verification from the complete working tree:

- repository preflight: 107 syntax files, 2 JSON files, 101 targeted test files, passed;
- complete suite: 1,568 total, 1,553 passed, 15 platform skips, 0 failures;
- `git diff --check`: passed, with only the checkout's existing LF-to-CRLF conversion notices.

No UAC prompt, elevation request, provider mutation, VM operation, Windows media approval, download, or guest execution occurred. The next physical step is still operator-owned media acquisition/placement and exact candidate/image/source-class approval, followed by the already separated construction pipeline when elevation is again available.
