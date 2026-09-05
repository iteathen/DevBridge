# DB-HO050 — issue #116 selected-profile environment activation

Date: 2026-08-28
Branch: `stage8/362-protected-activity-channel`
Exact predecessor: `eed880cbe43a10438617682fe1dc430a5acc7fb5`

## Assessment

Serialized construction now supports the accepted Linux and Windows profiles, but the next setup boundary is still Linux-specific:

- accepted environment-profile configuration derives only the Ubuntu production output;
- the setup composition returns early for every Windows-only selection, even when the exact Windows image is complete;
- protected environment activation always selects the Ubuntu profile;
- setup handoff text equates environment readiness with Linux readiness.

The physical environment, access, bootstrap, workspace, lifecycle, and activity owners already accept a Windows declaration through their existing neutral contracts. Adding Windows-specific provider or guest operations to setup would duplicate those owners. The missing work is declaration-source composition plus serialized invocation of the existing profile-neutral activation port.

## Governing review

Issue #116, DB-020, `docs/vm-migration.md`, `docs/vm-lego-studs.md`, `docs/execution-profile-environments.md`, Stages 3–6, `docs/testing/DB-HO036-issue-360-protected-environment-activation.md`, the environment declaration/configuration/activation implementations, Windows image publication, and Windows persistent-access composition were reviewed before planning.

The controlling boundaries are:

- execution profiles own persistent VMs; repository subjects become isolated workspace declarations and never provider identities;
- setup publishes desired declarations through the accepted configuration registry and invokes lifecycle only through the protected client;
- Windows image, provider, access, bootstrap, and bridge details remain in their existing owners;
- configuration may include only an exact currently accepted image output and bootstrap generation;
- one setup invocation may advance at most one incomplete environment activation frontier;
- a blocked earlier selected profile is not skipped;
- selected but unavailable profiles remain unavailable and never create a host-execution fallback;
- plain software qualification must not invoke installed setup, elevation, provider mutation, VM lifecycle, or guest execution during the operator-declared no-UAC interval.

## Primary-source research

Microsoft documents the relevant platform facts:

- [Windows 11 VM requirements](https://learn.microsoft.com/en-us/windows/whats-new/windows-11-requirements) require Generation 2, at least 4 GiB memory, two virtual processors, 64 GiB storage, Secure Boot, and virtual TPM. The Windows declaration must therefore select the existing protected EFI boot requirement and the same bounded resource floor used by image construction.
- [PowerShell Direct](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/powershell-direct) requires a locally running VM, Hyper-V administrator membership on the host, and valid guest credentials. The host receives no implied guest administrator access. Setup must continue to use the protected lifecycle/access composition and its dedicated locally protected guest material rather than prompting inside the guest or embedding credentials in a declaration.
- [Generation 2 VM security features](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/generation-2-virtual-machine-security-features) distinguishes the Windows Secure Boot template and virtual TPM behavior. That mapping remains provider-owned behind the neutral boot-protection requirement.

No source justifies a second setup-specific Hyper-V path, interactive guest UAC, or a weaker Windows declaration.

## Reassessment

The smallest complete correction is:

1. centralize the current Windows production-output identity so construction and declaration selection cannot drift;
2. derive platform-owned declaration specifications in isolated modules;
3. move image/current-record selection and declaration construction into a neutral source primitive that knows no platform or provider identities;
4. make the accepted configuration publisher consume only injected sources and a neutral workspace-identity function;
5. let the setup composition attach sources only for selected profiles and preserve current exact-image retention behavior;
6. serialize existing profile-neutral activation calls in accepted order, advancing at most one changed profile per invocation;
7. remove the Windows-only early stop only after a complete exact Windows image can produce an accepted declaration;
8. keep incomplete Windows state profile-local when Linux is independently available, but never report a Windows-only environment ready without exact protected lifecycle proof;
9. make public handoff language profile-neutral and bounded.

## Dependency-ordered implementation plan

1. Add the neutral declaration-source primitive and architecture tests for closed inputs, exact image/bootstrap matching, retained exact authority, ambiguous images, and topology isolation.
2. Add isolated Ubuntu and Windows specification owners; bind the Windows specification to the exact current payload/output identity and protected EFI/resource policy.
3. Refactor the accepted configuration publisher to consume injected sources and publish deterministic declarations for only the selected/available profiles.
4. Add an import-free serial reconciliation primitive that stops on the first blocker and returns immediately after one changed profile.
5. Recompose setup around the selected declaration sources and serialized existing activation adapter; remove hard-coded Ubuntu activation and Windows-only completion stop.
6. Test Linux-only preservation, Windows-only ready/create/resume, combined ordering, unavailable-image behavior, no-skip blocking, restart re-entry, workspace identity isolation, and zero provider/elevation calls in the software harness.
7. Update setup/working documentation, repository preflight, run focused and complete suites, push the exact checkpoint, and update #116/#198.

## No-UAC safety envelope

All implementation and tests in this checkpoint use local state fixtures and injected lifecycle/configuration ports. Do not invoke the installed setup command, approve media, refresh the protected service, call Hyper-V mutation, create/start a VM, access a guest, or request elevation during the operator-declared three-day no-UAC interval.

## Implementation

- Added an import-free profile-source primitive that accepts only a local specification contract, an image inventory, current accepted configuration, opaque subject identities, and an injected identity function. It selects one exact non-retired image generation, verifies the bootstrap generation, or retains only the exact previously accepted image authority.
- Moved Ubuntu and Windows declaration policy into separate profile-owned source modules. The shared publisher no longer imports either platform, a provider, or execution topology.
- Centralized the Windows production output profile/generation so image construction and declaration publication cannot drift independently.
- Changed setup composition to attach declaration sources only for accepted profiles and to require the published configuration to cover every selected profile before lifecycle reconciliation.
- Added an import-free serial reconciliation primitive. It preserves the supplied order, stops at the first blocker, and returns immediately after one changed item so one setup invocation cannot fan out environment mutations.
- Removed the hard-coded Ubuntu activation target. Windows-only setup can now continue from an exact complete Windows image through the existing protected configuration/lifecycle/activation studs without invoking Ubuntu prerequisites or construction authority.
- Combined selections activate Linux before Windows. A changed Linux activation produces a bounded re-entry frontier; a subsequent invocation re-observes Linux and may then advance Windows. An earlier blocker is never skipped.
- Public handoff data and prose now report selected/ready environment counts without equating the shared activation boundary with Linux.
- Added all new modules and tests to candidate repository preflight.

No compatibility route, direct-host execution path, platform-specific branch inside the neutral primitives, or setup-specific provider operation was retained or added.

## Verification evidence

- Focused owner/boundary suite: 55 tests passed, zero failed.
- Candidate repository preflight: 118 syntax files, 2 JSON files, and 109 targeted test files passed.
- Complete repository suite: 1,614 total; 1,599 passed; 15 expected platform skips; zero failed.
- `git diff --check`: passed.
- Physical/provider evidence: deliberately not attempted. The operator prohibited UAC/elevation for three days, and this checkpoint required no installed setup, media approval, provider mutation, VM operation, guest execution, or elevation request.

## Remaining frontier

This checkpoint proves the selected-profile composition and restartable software policy; it does not prove real Hyper-V behavior. When elevation becomes available again, the next physical step remains protected lifecycle readiness followed by exact Linux and Windows environment materialization and the two-guest C acceptance canary. Runtime operational readiness must remain unclaimed until that real evidence exists.
