# Issue #116 execution-profile selection

Date: 2026-08-28
Branch: `stage8/362-protected-activity-channel`

Post-checkpoint note: DB-HO049 subsequently generalized the explicit construction action to the next incomplete accepted profile while preserving this checkpoint's selection and isolation contracts.

## Assessment

The public setup path currently has no execution-profile choice. It always performs Linux/Ubuntu authority and construction-status work, while the CLI always asks the Windows media owner to discover candidates. Consequently a default Linux-only setup can surface Windows questions, a Windows-only or no-profile install cannot be expressed, and the existing restartable setup-authority record is not connected to setup.

This is a setup-policy and composition defect, not a provider defect. Repository selection must remain independent from profile selection, and accepting a profile must not create a VM, enable a host feature, install provider packages, approve media, or claim readiness.

The existing neutral `SetupAuthorityManager` already owns accepted-versus-working revisions, restart recovery, profile replacement, validation invalidation, and transactional commit. Reimplementing that persistence inside the CLI or main setup coordinator would create duplicate authority and violate the LEGO boundary.

## Prerequisite review

The governing material was reread before planning: DB-003, DB-007, DB-009, DB-020, issues #103 and #116, `docs/setup.md`, `docs/fresh-host-image-provisioning.md`, `docs/vm-migration.md`, `docs/vm-lego-studs.md`, the current CLI/setup composition, the setup-authority manager/state adapter, and their restart/isolation tests.

The current VM migration state remains unchanged: persistent VMs are owned by execution profiles, repositories own workspaces, both Hyper-V and KVM/libvirt remain first-class, and absence of a ready route fails closed without host execution.

## Primary-source research

This checkpoint adds no provider effect, but Stage 8 requires profile choice to remain separate from provider establishment:

- Microsoft documents that enabling Hyper-V requires an Administrator context and may require a restart. Merely selecting a Windows profile cannot imply that effect or readiness: <https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/get-started/Install-Hyper-V>.
- Libvirt documents distinct system and session QEMU/KVM connections and identifies `qemu:///system` as the system-mode daemon connection. Merely selecting a Linux profile cannot infer daemon access, KVM acceleration, or system-provider readiness: <https://libvirt.org/uri.html>.

These sources reinforce the existing design: persist requested intent first, then let provider-owned discovery/reconciliation independently prove or establish capability under a later explicit authority boundary.

## Reassessment

The smallest complete slice is a transactional selection stud at the start of setup:

- no explicit choice + no accepted state selects the ordinary Linux profile;
- no explicit choice + accepted state preserves it;
- explicit `linux`, `windows`, `both`, or `none` replaces the working selection transactionally;
- explicit `defer` performs no authority write and preserves any accepted or interrupted working generation;
- selecting a profile performs no provider, image, media, lifecycle, activation, or guest effect;
- Windows media observation attaches only when Windows is selected;
- Linux authority/construction work attaches only when Linux is selected;
- Windows-only, none, and deferred paths stop before Linux-specific work rather than using Linux as a hidden fallback;
- at this checkpoint, the existing Linux-only `--construct` action was rejected unless Linux was selected.

The profile vocabulary belongs only in the application composition adapter. The reusable selection policy receives opaque profile identifiers and neutral choice mappings; it contains no operating-system, provider, VM, repository, or media names.

## Dependency-ordered implementation plan

1. Add an import-free neutral choice resolver with default, accepted, interrupted-working, explicit replacement, empty, and deferred semantics.
2. Add a thin application composition edge that maps public choices to the two current profile identities and uses the existing setup-authority manager/state port for begin, replace, validate, commit, and restart recovery.
3. Extend the setup CLI with one bounded `--profiles <linux|windows|both|none|defer>` option and reject contradictory explicit construction/media combinations before effects.
4. Reconcile profile selection before platform-specific setup, then attach Windows media observation and Linux authority/construction only for selected profiles.
5. Project selected/deferred state in the local handoff without exposing authority operation IDs or state paths.
6. Test defaulting, preservation, replacement, none/defer, restart recovery, invalid input, CLI child isolation, Windows-question suppression, Linux-work suppression, construction gating, and LEGO source isolation.
7. Run repository preflight and the complete suite, record evidence, commit/push the isolated branch, and update issue #116.

## Safety envelope

This slice is configuration authority only. It performs no prerequisite installation, download, UAC/elevation request, protected-service action, provider mutation, image construction, VM action, media approval, activation, environment creation, or guest execution. Those effects remain behind their existing owners and later explicit gates.

## Implementation

The implemented slice has three ownership layers:

- `src/setup/profile-selection.js` is an import-free, closed-contract resolver over opaque profile identifiers. It owns default, accepted, interrupted-working, explicit replacement, empty, and deferred semantics without naming an operating system, provider, VM, repository, or media source.
- `src/app/setup-profile-selection.js` is the application composition edge. It maps the public choices to the current profile identities and commits through the existing setup-authority manager/state port. Its operation identities are component-owned, so a re-entry resumes its own interrupted selection but fails closed without editing a foreign setup transaction.
- `src/app/setup.js` consumes the validated selection before attaching platform owners. Windows media/read-only construction status is attached only for a selected Windows profile; Ubuntu prerequisites/release/canary/lifecycle/activation are attached only for a selected Linux profile. Empty and deferred choices stop after repository persistence, and cross-profile action requests stop before the corresponding platform adapter.

The CLI exposes `--profiles <linux|windows|both|none|defer>`, rejects repetitions and unknown values, excludes the option from the protected lifecycle child, rejects Linux construction without Linux, and rejects Windows media actions without Windows. The local result projects only accepted/deferred state, revision, changed state, selected/pending profile identifiers, and selection source; it exposes no operation identity or state path.

Windows-only selection remains deliberately fail-closed after its current media/construction observation frontier because Windows environment activation is not yet connected through setup. Selecting a profile never substitutes for provider, image, environment, bridge, or workspace readiness.

## Verification

Focused tests cover:

- neutral default/preservation/replacement/empty/defer resolution and closed input/policy shapes;
- transactional first commit, no-op re-entry, replacement, empty selection, interrupted-operation resume, and refusal to absorb another component's transaction;
- default Linux suppression of Windows questions;
- deferred and empty suppression of every platform-specific owner;
- Windows-only observation with zero Ubuntu prerequisite/authority/canary/lifecycle calls;
- cross-profile action rejection before media or construction adapters;
- CLI choice bounds, contradiction checks, and protected-child isolation; and
- source isolation of the neutral resolver.

Verification on the exact uncommitted candidate completed without invoking setup, a provider, a VM, or elevation:

- focused selection/setup/CLI/architecture tests: 69 passed, 0 failed;
- repository preflight: 112 syntax files, 2 JSON files, and 105 targeted test files passed;
- complete repository suite: 1,590 total, 1,575 passed, 15 platform skips, and 0 failed.

The platform skips are the repository's expected Windows filesystem limitations. This evidence proves the selection and composition contracts only. Real Hyper-V and KVM/libvirt setup, Windows activation, image construction, and both-guest C acceptance remain separate physical gates.
