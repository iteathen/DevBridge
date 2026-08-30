# DB-HO087 — no-elevation current-candidate staging

Date: 2026-08-30

Status: assessed and planned; user-owned installation update pending

## Scope and authority

This checkpoint advances only the manifest-owned Permanent Entry component and its exact default runner selection. It must not invoke setup, request elevation, refresh the protected service, mutate provider/image/environment/VM/guest state, execute repository code, or invoke a coding-model adapter.

The operator has explicitly directed work to continue without UAC. The supported `--install-only` path is therefore the maximum authorized installation effect. The existing protected service and all physical acceptance subjects remain unchanged.

## Assessment

Read-only wrapper-owned observation established:

- `devbridge-entry` resolves to the owned launcher at `C:\Users\josho\.devbridge\bin\devbridge-entry.cmd`;
- `devbridge` resolves to the owned stable launcher at `C:\Users\josho\.devbridge\bin\devbridge.cmd`;
- `entry-install-status` reports component, selected runner, and pinned runner `ef70f581d8eeb5b39fd378548091de9ba34a16bd`;
- current branch head `9aeacaaff34819c7c49d9050ebb2cba7457d377d` contains the accepted Linux setup/authentication/resource-reobservation continuation; and
- [GitHub Actions run 33298282461](https://github.com/iteathen/DevBridge/actions/runs/33298282461) passed the complete Ubuntu/Windows smoke and full-test matrix on that exact current head.

The user-owned runner is therefore healthy but stale. Leaving it stale would make the later single protected refresh enter from code that predates the accepted setup re-entry corrections.

## Contract and research recheck

DB-003 keeps runtime selection and executable authority local and prohibits installation from granting repository-code host execution. DB-008 requires immutable Git identity for accepted supply-chain subjects. DB-009 requires the installation transition to be intent-bound, observable, and restart-reconcilable. DB-011 makes Permanent Entry the stable owner of exact runtime selection and rollback. DB-020 keeps setup/runtime installation separate from provider and repository-execution readiness.

`docs/self-install.md` specifies that an explicit development selector is reduced to one exact commit, the fixed reviewed Permanent Entry closure is fetched from that immutable subject, every file is manifest/digest verified, replacement is staged, the JavaScript wrapper is published last, and `--install-only` prevents the setup continuation. Wrapper-owned `entry-install-status` observes the installed component without first trusting or importing that component.

No new external platform mechanism is introduced. The current installer implementation and its exact-head Windows/Ubuntu standalone-installer CI are the applicable evidence; the prior accepted DB-HO075 physical procedure remains valid.

## Reassessment

Use the checked-in zero-state bootstrap from the exact accepted head rather than editing runner state, copying checkout files, or invoking the protected setup path. Supply the exact 40-hex commit, the canonical installation home, and `--install-only`. Exact selection prevents branch movement during the effect; fixed component admission prevents the large development branch from becoming implicit installation authority.

If installation succeeds, independently re-read wrapper-owned status and verify the owned stable command. A mismatch, ambiguous result, setup continuation, UAC prompt, or protected/provider activity is a stop condition, not permission for repair by direct state edits.

## Plan

1. Commit and push this assessment/plan and require all four hosted jobs on its exact head.
2. Invoke `bootstrap-devbridge.mjs` with that exact commit, canonical home, and `--install-only`.
3. Require a zero exit and one bounded `devbridge/entry-install-v1` result.
4. Re-run wrapper-owned `entry-install-status` and require component, selected runner, and pinned runner to equal the exact plan head.
5. Re-resolve the stable `devbridge` command and run only installed read-only doctor with the verified example configuration.
6. Record exact installation and doctor evidence in a documentation-only commit and require the hosted matrix again.

No setup continuation, UAC, protected service/provider/storage action, VM/guest operation, repository execution, physical canary, or model invocation is authorized by this plan.
