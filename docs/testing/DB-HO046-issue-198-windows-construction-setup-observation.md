# DB-HO046 — issue #198 Windows construction setup observation

Status: implemented and software-verified from exact predecessor `8481be5f759cf15c2ef29185b916eec6c73da10e` on `stage8/362-protected-activity-channel`; physical construction remains pending.

## Assessment

The public setup command can now discover and explicitly approve one exact Windows media candidate, while the existing Windows physical canary can construct and qualify a production image from a complete local config. One connection stud is still absent: setup does not derive the immutable production authority/config from its accepted media or expose the canary read-only state.

This gap currently forces a caller to assemble a path-bearing canary config manually. That is the wrong authority boundary because it duplicates fixed toolchain, payload, recipe, profile, resource, and state-root decisions outside the setup owner. It also means setup cannot distinguish:

- media accepted but host construction prerequisites unavailable;
- exact construction authority ready but not started;
- a resumable durable Windows construction frontier;
- completed immutable Windows image admission; or
- media/source/authority drift after approval.

The media selector already owns the only source-path registry and its `resolve` operation is observational. The physical canary already proves its `status` path is read-only. The missing component is therefore a setup composition edge, not a new provider, media, image, toolchain, guest, or authority implementation.

## Research and reassessment

No new platform effect is introduced in this checkpoint. The current Microsoft sources and conclusions recorded in DB-HO030 and DB-HO045 remain the governing external evidence: Windows 11 VM construction requires the already implemented protected-boot/resource policy; media acquisition and edition/license choice remain explicit operator actions; unattended construction must not fall back to GUI or UAC; and Evaluation remains separately temporary.

The smallest safe next step is observation-only:

1. Resolve only an already accepted opaque media selection through its source-owned local registry.
2. Bind that exact authority to the current Windows guest payload generation, pinned default toolchain authority, fixed unattended recipe generation, fixed Windows development profile/output generation, and fixed resource policy.
3. Instantiate the existing physical canary and call only its read-only `status` operation.
4. Project the bounded physical status beside media status in local setup output and through the existing path-redacting remote status boundary.
5. Keep Windows physical blockers profile-local. They must not prevent Linux construction or operational readiness unless a future explicit Windows construction request owns that gate.
6. Do not add a construction flag, invoke `run`, register authority, create media, request elevation, mutate a provider, or start a VM in this checkpoint.

This establishes the exact configuration handoff needed for later construction without silently expanding the existing Linux `--construct` meaning or inventing a temporary compatibility flag. The future explicit multi-profile construction command remains a setup-policy decision and must preserve serialized provider work.

## Dependency-ordered implementation plan

1. Refactor the media setup composition just enough to expose a separate observational resolution function; discovery remains the only operation that can add source-registry entries.
2. Add a Windows production setup-status composition edge that accepts neutral local ports for media resolution, payload authority, tool authority, authority normalization, and physical status.
3. Fix the setup-owned Windows profile, output generation, recipe generation, and minimum supported resource policy in that composition edge.
4. Return only bounded status and keep the resolved source path inside the canary config call.
5. Add normal, absent-media, accepted-ready, blocked-preflight, source-drift, dependency-failure, no-run, restart-stability, remote-redaction, and LEGO tests.
6. Extend repository preflight, run the complete suite, record evidence, commit/push the isolated branch, and update issue #198.

No UAC, provider mutation, VM operation, construction run, media approval, download, or guest execution is authorized by this plan.

## Implementation evidence

- The media setup composition now exposes a separate local resolver for an already accepted opaque selection. It does not discover, inventory, write the source registry, create an inbox, or publish the path.
- `windows-production-image-setup` binds accepted media to the current exact guest payload, pinned default tool authority, fixed Audit Mode recipe, `windows-development` output profile, versioned output generation, and fixed 4 GiB / 2 CPU / 64 GiB virtual disk / 40 GiB sparse-allocation policy.
- The composition passes the resolved local source path only into the existing closed physical-canary config and invokes only `status`. Its source contains no call to the canary mutation operation.
- Public setup composes this observation only after media is accepted. A Windows construction blocker remains inside the Windows profile and does not block independent Linux progress.
- Local handoff reports the bounded read-only construction gate. Remote `setup.status` independently projects its state, reason, physical state, and bounded preflight capability booleans while removing source, candidate, authority, image, provider-state, and local path details.
- Tests prove media absence stops before canary creation, exact fixed authority/resource binding, one status call and zero run calls, bounded preflight blocker propagation, dependency error redaction, non-Windows detachment, observational accepted-source resolution, setup profile-local behavior, remote path/subject redaction, and LEGO composition isolation.

Verification from the complete working tree:

- repository preflight: 108 syntax files, 2 JSON files, 102 targeted test files, passed;
- complete suite: 1,574 total, 1,559 passed, 15 platform skips, 0 failures;
- focused setup/media/construction/LEGO tests and `git diff --check`: passed.

No UAC request, elevation process, canary run, authority registration, provider mutation, VM action, media approval, download, or guest execution occurred. The next construction step still requires operator-owned media to be accepted and a separately designed explicit multi-profile mutation request after elevation is available.
