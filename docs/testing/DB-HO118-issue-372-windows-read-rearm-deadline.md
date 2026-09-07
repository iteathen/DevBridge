# DB-HO118 — issue #372 Windows read re-arm deadline

Date: 2026-09-01

Status: exact physical deadline defect reproduced; isolated source correction passes complete local qualification; hosted acceptance pending

Coordinates with: #360, #362, #368, #372, DB-003, DB-008, DB-009, DB-011, DB-019, DB-020, DB-HO111, DB-HO116, and DB-HO117.

## Physical checkpoint

PR #439 merged at exact Stage 8 head `d7f9b45ba0fef0e2677eaf39afb5d60d213b1a5d`. Pull-request run `33568922051` and fresh post-integration run `33569257424` each passed Ubuntu smoke/full and Windows smoke/full. Install-only then bound the canonical component, selected runner, and pinned runner to that exact head.

The first ordinary setup invocation completed preparation in 42 seconds without elevation and durably requested explicit protected-apply re-entry. After fresh operator authorization, one ordinary `devbridge setup` requested its single UAC child at elapsed zero. Protected transaction completed at 236 seconds, protected verification completed at 469 seconds, and the exact prepared subject was checkpointed as applied. Environment activation began at 470 seconds and setup terminated at 492 seconds with `Protected environment activation failed: environment lifecycle authority is unavailable`. No retry followed.

Read-only inspection showed checkpoint revision 4 in `applied` state and the protected service Running/Automatic under `LocalSystem` at exact generation `4586b2932e283ea48a4cbc2158bd96faf9e8137162b798c2b3eab6b0333a9810`. No setup process remained. No service, group, ACL, WMI, provider, network, image, VM, guest, PATH, installation, OneDrive, or D: state was manually changed.

## Exact diagnosis

Setup creates the lifecycle client with a three-second connection timeout, then activation begins with lifecycle `list`. Provider observation legitimately takes approximately 22 seconds. The DB-HO117 transaction adapter calculated its single replay deadline before opening the first connection. A replay-safe Windows named-pipe zero-response `EPIPE` after that 22-second operation therefore found the original three-second connection deadline already expired and could never re-arm.

The defect was a boundary error: a connection timeout had accidentally become a transaction-lifetime deadline only on the stale-instance replay path. It was not evidence for a longer provider or operation timeout.

## Nested correction

1. **LEGO:** the neutral local-authority socket adapter owns only connection establishment and stale Windows named-pipe re-arm. Protocol owners continue to own operation classification, framing, bounds, and errors.
2. **SOLID:** the first connection keeps its own caller-selected bounded window. Only a protocol-classified replay-safe zero-response `EPIPE` opens one separate re-arm connection budget of the same bounded duration.
3. **CUPID:** the re-arm budget is created once after the first proven stale transaction. Only reconnect delay and pipe-open work consume it; time inside an established replay-safe transaction does not. Later failures cannot replenish consumed connection budget, and successful connected operations are not converted into operation timeouts.
4. **KISS:** add no sleep to setup, no timeout widening, no server/service/provider change, no caller retry, and no mutation or partial-response replay.

An initial one-retry candidate was rejected by the real compiled-host regression: the one-instance Windows pipe can produce more than one immediate stale `EPIPE` while re-arming. A second wall-clock-window candidate passed focused qualification but failed the exact serialized suite on activity read 21/30. Temporary local diagnostics, removed immediately after classification, proved another native zero-response `EPIPE`: connected activity cleanup had consumed the nominal connection window. The accepted candidate preserves the established bounded rapid-retry behavior while measuring only connection re-arm time, not connected read-operation time.

## Evidence and remaining gates

The deterministic adapter set passes 9/9, and the exact-runtime focused authority/setup/compiled-host set passes 43/43. They prove a transaction may outlive the connection timeout, a late zero-response read receives one fresh bounded re-arm budget, replayed connected operations do not spend that budget, transient pipe-open retries do spend it, repeated zero-response failures cannot replenish it, cancellation stops re-arm, and replay-unsafe or partial-response operations remain single-attempt. Four repeated exact-runtime disposable compiled-host cycles plus the final focused run pass 450 real five-endpoint reads after the final correction.

Final-byte exact Node.js 22.16.0 preflight passes two standalone artifacts, 256 syntax files, two JSON files, and 206 dependency-selected test files. The complete exact serialized suite passes 2,122 total / 2,101 passed / 21 expected Windows skips / zero failed / zero cancelled in 333.2 seconds. Exact doctor reports `ok: true`, GitHub repository admission and native C/CMake/CTest toolchains available, lifecycle authority ready with one clean absent environment, and repository execution truthfully unavailable until setup creates that environment. Diff and artifact hygiene pass.

Cleanup removed the checksum-verified exact Node runtime and all 1,770 `db-*`/`devbridge-*` qualification roots created in Windows Temp, measuring 334.3 MiB after the checked runtime was already deleted. Read-only Git fixture attributes were normalized only inside the validated disposable roots; no ACL or ownership change occurred. Final verification reports zero same-day matching Temp roots.

Publish one isolated pull request, require all four hosted jobs, merge only its accepted exact head, and require a fresh four-job Stage 8 post-integration run before install-only.

One new ordinary setup attempt requires fresh operator authorization after those gates. Route health, GitHub task receipt, and Hello World compile/test remain downstream physical acceptance gates.
