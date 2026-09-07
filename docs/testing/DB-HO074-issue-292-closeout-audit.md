# DB-HO074 — Issue #292 closeout audit

Date: 2026-08-29

Status: acceptance evidence complete; no implementation change required

## Scope and authority

Issue #292 owns the platform-neutral protected-authority refresh transaction and its Windows one-command usability milestone. It does not own Linux physical qualification, current candidate installation, provider/profile activation, guest execution, or Stage 7 acceptance. Those remain with #293, #360, #372–#374, #177, and #115–#116.

This audit is read-only except for durable documentation and issue status. It invokes no setup command, elevation broker, service control, provider, image, VM, guest, repository execution, or coding-model adapter.

## Assessment

The issue was intentionally left open after its physical Windows gate while downstream construction recovery continued. That continuation is now complete enough to classify the issue boundary accurately:

- the shared reconciler and thin Windows adapter remain present and are exercised by the current exact head;
- one ordinary physical `devbridge setup` invocation on recovery commit `4483474fc85e5f50a21accd7fef7c4a7a6067dfb` crossed the bounded elevation transaction, returned to the ordinary caller, reported the protected service ready, retained all 16 repositories, reached the read-only construction gate, and exited zero;
- the one-command readiness contract requires the ordinary negative proofs and fixed positive acceptance fixture before it can report that result, so that terminal result is evidence that those gates and exact cleanup completed rather than a declaration based only on service presence;
- subsequent supported construction re-entry proceeded through the protected owner, which supplies downstream evidence that the accepted authority was operational rather than a mock-only boundary;
- current software has advanced beyond the installed protected generation. Requiring one later operator-approved refresh for a newer exact generation is the expected self-refresh contract, not unfinished #292 implementation.

The Linux platform remains explicitly fail-closed. Its protected service/provider evidence remains owned by #293 and cannot be inferred from the Windows result.

## Governing contracts reread

- DB-003 keeps executable, filesystem, provider, and privilege authority local.
- DB-009 requires intent/effect observation and reconciliation before replay.
- DB-011 owns exact runtime generation, activation, rollback, and Permanent Entry recovery.
- DB-020 forbids any direct host repository-execution fallback.
- `docs/environment-lifecycle-authority.md` defines the shared reconciler, separate read/mutation capabilities, one-command setup contract, platform-scoped readiness, and the remaining parent #177 gates.
- `docs/working-devbridge-assessment-2026-08-27.md` records the exact physical Windows setup and downstream construction re-entry.

## Primary-source recheck

Microsoft's current contracts continue to support the accepted design:

- [`SERVICE_SID_INFO`](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/ns-winsvc-service_sid_info) documents service SIDs in the process token, including restricted-SID behavior and the service-specific `NT SERVICE\\<name>` identity used for exact resource ACLs.
- [Service Security and Access Rights](https://learn.microsoft.com/en-us/windows/win32/services/service-security-and-access-rights) states that service configuration controls the executable that runs and that change-config authority should be administrator-only.
- [Named Pipe Security and Access Rights](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights) documents token/DACL checks for clients and server instances and confirms that generic write includes pipe-instance creation, so the mutation endpoint requires explicit minimal rights.

No source change invalidates the service-SID, bounded elevation, exact-generation, or explicit pipe-capability model.

## Reassessment and closeout plan

No code change is warranted. Reopening the reconciler or forcing a no-elevation service update would either duplicate accepted behavior or violate the protected-authority boundary.

1. Re-run the current neutral reconciler and Windows one-command/service/protection/acceptance suites.
2. Require the current exact PR head to retain all four hosted Windows/Ubuntu jobs.
3. Record the exact historical physical and current regression evidence.
4. Close #292 as the completed architecture/Windows-usability milestone.
5. Keep #177, #293, #360, #372–#374, and #115–#116 open for their distinct current-generation, Linux, provider, guest, and Stage 7/8 physical evidence.

## Current verification

On exact documentation predecessor `f8dbd5458dd70b997de5dace3308de67dbc3c5b7`:

- the complete focused `protected-authority-*` and `windows-lifecycle-authority-*` corpus passed 156 tests with one expected filesystem-capability skip and zero failures on Node 24.15.0;
- the corpus proves exact-current mutation-free no-op, stale-generation single-elevation resume, refusal without retry, interruption reconciliation, candidate drift rejection, rollback, ordinary mutation/storage denial, fixed positive lifecycle acceptance, exact fixture cleanup, closed argv/path admission, neutral reconciler topology, and bounded diagnostics;
- [GitHub Actions run 33285419333](https://github.com/iteathen/DevBridge/actions/runs/33285419333) passed all four Windows/Ubuntu smoke and complete-suite/doctor jobs on that exact head;
- historical PR #306 merged the physically exercised recovery line as `4483474fc85e5f50a21accd7fef7c4a7a6067dfb`; [GitHub Actions run 33105360623](https://github.com/iteathen/DevBridge/actions/runs/33105360623) passed all four jobs immediately before that merge;
- the physical result and exact downstream re-entry are recorded in `docs/working-devbridge-assessment-2026-08-27.md` and the terminal issue evidence.

Issue #292 may be closed. This is not a claim that the newer candidate is installed, that Linux is ready, or that either guest C canary has passed.
