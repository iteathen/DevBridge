# DB-HO075 — No-elevation installed-candidate staging

Date: 2026-08-29

Status: assessed and planned; exact installation effect pending

## Scope and authority

This checkpoint prepares the user-owned Permanent Entry to select one exact, already-qualified commit from the active draft integration branch. It does not invoke setup, request elevation, refresh the protected service, mutate a provider/image/VM/guest, execute repository code, or invoke a coding-model adapter.

The local operator's continuing request to make DevBridge operational authorizes the DevBridge-owned user installation. `--install-only` is mandatory for this no-elevation checkpoint. The protected service and physical route remain unchanged.

## Assessment

Read-only observation on branch head `cd9920bfbe12f7bf016a2208b4d4b68d9bb33645` established:

- `resolveInstalledCommand()` proves the exact owned launcher under the canonical installation home;
- bare command discovery now resolves that same launcher in the current PowerShell process;
- the installed development stable state still selects runner head `0ace83bf25d131d0d6bcd4f00617b30e96f9bb93`;
- the active draft branch is newer and its exact head has passed the complete local and hosted qualification recorded by DB-HO073 and DB-HO074;
- the protected Windows service is a distinct, older generation and remains behind its operator-approved elevation boundary.

Leaving the Permanent Entry on the older runner would make the later one-command protected refresh start from stale controller code. Directly editing entry state or copying a checkout into the installation would bypass DB-011 source, manifest, transaction, and rollback ownership.

## Governing contracts reread

- DB-003: installation paths, executable authority, and local consent remain host-local.
- DB-009: publication must be intent-bound, observed, and restart-reconcilable.
- DB-011: Permanent Entry and accepted runner generation own exact runtime selection, activation, rollback, and recovery.
- DB-020: installing controller/runtime bytes grants no host repository-execution fallback.
- `docs/self-install.md`: a moving development selector is reduced to an exact commit before publication; `--install-only` stops before the setup continuation.
- `docs/setup.md`: setup remains the sole owner of protected/provider/profile/guest readiness and is not implied by entry installation.

## Reassessment

The supported zero-state bootstrap is the smallest correct owner. It fetches its fixed installation stages from the selected exact remote commit, admits only the explicit Permanent Entry component closure, verifies content digests, publishes the wrapper last, and records rollback state. Supplying the exact commit after its hosted gate avoids branch movement during the effect.

No manual state edit, direct component copy, legacy launcher path, or setup invocation is warranted.

## Plan

1. Commit and push this plan, then require all four hosted jobs on its exact head.
2. Invoke the checked-in zero-state bootstrap with that exact commit, the canonical installation home, and `--install-only`.
3. Require a zero exit and a bounded installed-component result. Do not accept or interact with an elevation prompt; none should be reachable.
4. Use wrapper-owned `entry-install-status` to prove the installed component and exact default runner without loading the candidate.
5. Use the installation-owned command resolver again to prove the stable launcher.
6. Invoke only the installed `doctor` surface to materialize/inspect the selected exact runner through normal Permanent Entry. Doctor remains read-only with respect to authority-bearing setup/provider state.
7. Record the exact installed subject, doctor result, nonclaims, and any blocker. Preserve all existing DevBridge-owned state; perform no ad hoc cleanup.

## Stop conditions

Stop without workaround if the bootstrap cannot bind the exact remote commit, component admission fails, the owned wrapper cannot be proved, doctor attempts setup/elevation, or observed state is ambiguous. Provider absence or stale protected generation remains a truthful blocker, never permission for direct host execution.
