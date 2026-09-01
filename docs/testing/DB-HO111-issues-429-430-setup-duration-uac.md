# DB-HO111 — issues #429/#430 setup duration and UAC entry

## Scope

This handoff owns setup phase observability, one exact durable protected-apply frontier, and the Windows ordinary-to-UAC entry order. It does not own construction budgets, hosted-CI timeouts, provider mechanics, a reusable privileged service, or a second protected reconciliation implementation.

## Composition decision

The accepted runtime keeps three independent LEGOs:

1. `setup-progress` emits bounded neutral phase events with elapsed time and a periodic active heartbeat for a long protected transaction.
2. `setup-protected-apply-frontier` persists only `prepared`, `applied`, or `invalidated` plus the SHA-256 subject derived from the accepted configuration revision/digest, profile-selection revision, and accepted identity/repository/package checkpoint.
3. the existing Windows lifecycle authority remains the sole owner of readiness inspection, its one UAC child, protected journals, and fresh ordinary proof.

Ordinary setup calls lifecycle readiness without an elevation port after all preparation gates. Only an explicit `elevationRequired` observation may create the prepared frontier. The invocation then returns without prompting. A subsequent ordinary `devbridge setup` accepts the frontier only when the current configuration, profile-selection authority, and setup checkpoint still match exactly. It resolves the already-installed command locally and calls the existing elevation adapter directly. No lifecycle/service probe, endpoint health check, old-receipt cleanup scan, PATH persistence, GitHub authentication/discovery, media inspection, package/release authority, construction status, conflict inspection, or publication work occurs before `RunAs`. Fresh ordinary readiness proof and bounded cleanup occur after the child returns. Setup then re-observes the local conflict gate and resumes activation and operational publication from the exact accepted record and checkpoint without repeating remote discovery or construction-authority work.

The prompt transaction still contains one narrow elevated child and no generic privileged RPC. Cancellation or failure leaves the prepared frontier intact and setup issues no second prompt in that invocation. After exact protected readiness, the frontier advances to `applied`; ordinary setup may then re-observe its independently owned gates.

## Qualification contract

Automated acceptance requires:

- fake-clock phase timing and bounded/redacted detail;
- idempotent prepare/apply plus stale configuration/profile-selection rejection;
- first invocation checkpointing with zero elevation;
- re-entry order proving local command resolution, then elevation, then lifecycle verification, with no ordinary command installation or remote discovery replay;
- readiness proof that distinguishes an elevation-required structural state from protection failure;
- existing one-child, cancellation, uncertainty, historical-generation, and clean-invocation recovery tests unchanged.

Physical Windows acceptance remains a separate newly authorized action. Record exact start, prompt, terminal, phase-heartbeat, and protected-journal times. Do not infer prompt timing or total-duration success from CI alone.
