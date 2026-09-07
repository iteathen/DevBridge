# DB-HO094 — No-elevation current candidate restaging

Date: 2026-08-30

Status: exact candidate staged and independently observed; documentation-head acceptance pending

Coordinates with: #116, #360, #362, #372–#374, DB-003, DB-008, DB-009, DB-011, DB-019, DB-020, and DB-HO091.

GPU/CUDA work is outside this checkpoint.

## Scope and authority

This checkpoint may update only the manifest-owned user installation and its exact Permanent Entry runner selection. It must not invoke setup or authentication, request UAC, refresh the protected service, accept media, mutate a provider/image/environment/VM/guest, execute repository code, or invoke a coding-model adapter.

The supported zero-state bootstrap `--install-only` route is the maximum admissible effect. Its purpose is to advance the already-staged candidate from the earlier accepted checkpoint to one exact, newly accepted head before the later administrator-authorized protected refresh.

## Assessment

The isolated worktree is clean and remote-equal on `stage8/362-protected-activity-channel` at `ffbdcafefbb891e25a517eaaacfb1effbc301129`. [GitHub Actions run 33308721004](https://github.com/iteathen/DevBridge/actions/runs/33308721004) passed Ubuntu smoke/full and Windows bounded-smoke/serialized-full plus doctor for that exact head, and all four checks report zero annotations.

The canonical installation home exists below the current user profile. Command discovery resolves `devbridge-entry` and `devbridge` to its manifest-owned wrappers. `DEVBRIDGE_HOME` is unset, so there is no competing installation selector. DB-HO091 records that component, selected runner, and pinned runner are currently exact commit `d7d35e6d0a7b7b6e73326ee9155049447a7a9276` and that installed read-only doctor is green but repository execution is unavailable/fail-closed pending the protected route.

Since DB-HO091, installer-owned runtime changes are limited to the self-contained construction-retention CLI/liveness behavior and its neutral composition. The zero-state bootstrap, Permanent Entry wrappers, manifest transaction, and install-only/setup separation are unchanged. The remaining changes are tests, documentation, and hosted workflow maintenance.

## Contract research and reassessment

No new external platform mechanism is introduced. The applicable primary contracts remain the audited repository-owned sources:

- DB-003 preserves local capability authority and forbids installation from granting repository-code host execution;
- DB-008 requires an immutable accepted Git identity;
- DB-009 requires an intent-bound, observable, restart-reconcilable effect;
- DB-011 assigns runtime selection, activation, rollback, and recovery to Permanent Entry;
- DB-019 binds qualification evidence to the exact candidate; and
- DB-020 keeps installation distinct from protected provider and repository-execution readiness.

`docs/self-install.md` and the zero-state bootstrap's input contract continue to specify exact-ref resolution, fixed component admission, manifest and digest verification, staged replacement, wrapper-last publication, and `--install-only` termination before setup. Because those owners have not changed, inventing another installer, copying checkout files, editing installed state directly, or using a moving ref would add risk without satisfying another contract.

Reassessment: first publish this plan and accept its exact head in all four hosted jobs. Then invoke only the checked-in exact-head bootstrap with the canonical installation home and `--install-only`. Stop on setup continuation, UAC, identity mismatch, ambiguity, or any protected/provider effect. Independently verify the bounded result, wrapper-owned status, command resolution, and installed read-only doctor.

## Primitive-to-high-level plan

1. Commit and push this plan as the exact candidate subject.
2. Require Ubuntu smoke/full and Windows bounded-smoke/serialized-full plus doctor on that exact plan head.
3. Invoke `src/bootstrap/zero-state-bootstrap.mjs` with the accepted 40-hex head, canonical installation home, and `--install-only`.
4. Require a zero exit and one bounded `devbridge/entry-install-v1` result binding component, selected runner, and pinned runner to the exact head.
5. Run wrapper-owned `entry-install-status` and require all three identities to match independently.
6. Re-resolve both manifest-owned commands and run installed read-only doctor with the installed component's verified example configuration.
7. Document the exact effect and nonclaims, commit and push that record, and require its hosted matrix.

This checkpoint cannot close the protected-service, provider, environment, guest, physical C-canary, or Stage 7 gates. It merely prepares their exact already-qualified user-owned controller subject without elevation.

## Hosted plan-head acceptance

[GitHub Actions run 33308965436](https://github.com/iteathen/DevBridge/actions/runs/33308965436) passed Ubuntu smoke/full and Windows bounded-smoke/serialized-full plus doctor on exact plan head `b535a5d2ce04a420ac3e0f559be712009747c8e2`.

## Installation and independent observation

The checked-in zero-state bootstrap was invoked with exact selector `b535a5d2ce04a420ac3e0f559be712009747c8e2`, the canonical user installation home, and explicit `--install-only`. It exited zero and returned one bounded `devbridge/entry-install-v1` result binding component head, selected runner ref, and pinned runner head to that exact selector. It named only the three manifest-owned Permanent Entry wrapper outputs and did not enter setup.

Wrapper-owned `entry-install-status` independently exited zero with `devbridge/entry-install-status-v1` and the same three exact identities. Command discovery resolves `devbridge-entry` and `devbridge` to the canonical installation's manifest-owned command wrappers. Invoking the installed command materialized and reverified one clean exact checkout at the accepted head before launching its control-plane entry.

The first doctor check supplied the old Stage-0 runtime subtree's example configuration. Current parsing rejected that file's removed singular `github.queueRepository` field and exited one. This was a fail-closed verification-path mistake, not a candidate fallback: the installed command still launched the exact selected head, no setup or execution occurred, and the obsolete runtime subtree was not selected as code. It was not removed because this checkpoint has no exact manifest-owned retirement authorization for that pre-existing data.

Doctor was then supplied with `config/devbridge.example.json` from the clean exact selected checkout. It exited zero with `ok: true` and reported:

- GitHub CLI authentication available;
- execution disabled by local configuration;
- repository execution `unavailable`/not ready because no persistent-environment route is configured;
- lifecycle `setup-reentry-required`, zero declarations, and zero environments; and
- coding-model adapters disabled.

The transaction and observations did not invoke setup or authentication, display or request UAC, refresh the protected service, mutate provider/image/environment/VM/guest state, execute repository code, run a physical canary, invoke a model adapter, or touch GPU/CUDA work. The exact next physical dependency remains one later administrator-authorized protected-service refresh/re-entry.

## Remaining acceptance

Require this documentation-only head to pass the same four hosted jobs plus doctor. This staging checkpoint does not close #116, #360, #362, #372, #373, or #374 because their protected-service and physical canary evidence remains incomplete.
