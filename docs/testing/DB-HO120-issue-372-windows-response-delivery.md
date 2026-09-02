# DB-HO120 — issue #372 Windows acknowledged response delivery

Date: 2026-09-01

Status: exact physical partial-response defect reproduced; narrow owner-local correction implemented and locally qualified; hosted acceptance pending

Coordinates with: #360, #362, #368, #372, #429, #430, DB-003, DB-008, DB-009, DB-011, DB-019, DB-020, DB-HO111, DB-HO116, DB-HO117, DB-HO118, and DB-HO119.

## Physical checkpoint

PR #441 merged its exact accepted head `4ccf9d264b4daf0846d3fab53f9a5ddc16187a85` into Stage 8 as `fdabc56859b2fd2f0aef27d65a0099f147fef5c5`; both commits have exact tree `4446a2ed051c0ecaebd9516deaae7ccdfe7f9d8b`. Pull-request run `33582867909` and fresh post-integration run `33583156321` each passed Ubuntu smoke/full and Windows smoke/full. The canonical ordinary command resolved only below `C:\Users\josho\.devbridge`, and its installed entry then reported exact component head `fdabc56859b2fd2f0aef27d65a0099f147fef5c5` with selected ref `stage8/362-protected-activity-channel`.

One operator-authorized ordinary, non-elevated `devbridge setup --track-ref stage8/362-protected-activity-channel` invocation requested elevation at setup elapsed zero. The ordinary CLI stated that DevBridge Protected Setup needed administrator permission to reconcile the DevBridge-owned lifecycle service and protected environment configuration. The operator directly reported approving the UAC surface out of habit and did not observe its displayed requester, publisher, or reason; those UI details are not inferred. The protected child remained active through 220 seconds, ordinary verification completed and checkpointed the exact applied subject at 300 seconds, resource-conflict reconciliation completed at 300 seconds, and environment activation started at 302 seconds. Activation failed at 324 seconds with `environment lifecycle authority is unavailable`. No retry followed.

The canonical protected state is coherent after the failure. Exact accepted-tree read-only clients report configuration ready, lifecycle ready with one accepted `linux-development` declaration, no active transition, verified local image `ubuntu-2604-production-v6`, absent provider materialization, and recommended action `create`. Configuration inspect completed in 107 ms; lifecycle inspect and list completed in 22.499 and 22.289 seconds. Activity inspect was ready; activity list returned its bounded operation failure because no environment is materialized. The current protected-apply frontier is applied.

The completed elevation channel removed itself. The zero-state handoff left one source directory and two source/stage modules for exact PID 12788 under the canonical bootstrap staging directory even though their owner promises `finally` cleanup. Those three unambiguous staging artifacts were removed by exact path and absence was verified. The pre-existing 2026-08-27 elevation channel remains preserved as documented ambiguous recovery evidence. The source worktree was clean before this correction branch was created.

## Exact diagnosis

The activation failure was not an unavailable service, a missing declaration, a provider timeout, or an exhausted connection deadline. A raw read-only lifecycle `list` used the same accepted bytes, endpoint, three-second connection bound, request protocol, and response framing but deliberately disabled diagnostic replay. Protected observation ran for 21.435 seconds, then the Windows client received native `EPIPE` after exactly 1,469 response bytes and before the JSON newline. That is a partial response.

The existing client is correct to refuse replay. A partial response may follow a completed protected operation, and the transport must not infer application semantics from an incomplete frame. DB-HO118 correctly fixed only the separate zero-response re-arm deadline. Widening that replay rule to partial bytes would weaken the established mutation/read framing boundary and hide delivery loss.

The protected C# host owns one exclusive `NamedPipeServerStream` per capability to preserve first-instance namespace ownership. It writes the worker response, calls the managed stream's ordinary `Flush`, and immediately calls `Disconnect` in `finally`. The physical 1,469-byte result proves that sequence can force the client off before it has read the complete bounded response.

Microsoft documents that disconnecting a named-pipe instance discards unread data. Its overlapped-I/O server guidance says the server must wait for a signal that the client has finished before disconnecting; it also explains that a blocking flush defeats overlapped operation because it waits for the client to empty the pipe. A direct unbounded drain is therefore not acceptable here: the ordinary operator is permitted to connect to four capabilities and must not be able to pin one capability thread indefinitely by refusing to read.

Official references:

- https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-disconnectnamedpipe
- https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-operations
- https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-server-using-overlapped-i-o

## Reassessment and nested design

1. **LEGO:** the shared local-authority response-frame owner adds one fixed acknowledgement after a complete bounded JSON line. Lifecycle, configuration, activity, and acceptance retain their existing protocols, endpoints, schemas, access rules, operation ownership, and error vocabularies.
2. **SOLID:** JavaScript framing alone recognizes a complete response and emits the fixed acknowledgement; the protected host alone waits for and validates that acknowledgement before disconnect. Neither side learns setup, provider, environment, or repository semantics.
3. **CUPID:** every successful transaction has one predictable sequence: request frame, response frame, fixed acknowledgement, server disconnect. Missing, malformed, oversized, partial, multi-frame, or unacknowledged exchanges fail closed within the existing bounded pre-request interval.
4. **KISS:** preserve one service, one exclusive pipe instance per capability, one worker per request, and the current application protocols. Add no setup retry, sleep, connection/operation timeout widening, partial-response replay, response journal, extra server instance, helper service, provider fallback, or authority expansion.

The acknowledgement is a fixed transport constant with no caller-selected field. The client sends it only after receiving and parsing one complete bounded response line with no non-whitespace suffix, but still waits for the server's normal end before returning the parsed result. A complete result remains acceptable if Windows reports a later close error, as today. A partial result sends no acknowledgement and remains terminal. The host waits only for the exact fixed acknowledgement within its existing bounded pre-request interval, then reuses the same exclusive instance. A client that withholds or corrupts the acknowledgement consumes only that bounded interval.

## Dependency-ordered implementation plan

1. Add the fixed acknowledgement constant and one shared acknowledged JSON-line transaction function to the existing neutral local-authority connection LEGO.
2. Replace the duplicated lifecycle, configuration, and activity client framing callbacks with that shared owner. Acceptance already composes the lifecycle exchange and receives the same behavior without a second implementation.
3. Add a bounded exact-acknowledgement reader to the existing protected Windows host. Write and flush the bounded worker response, require the acknowledgement, then disconnect and reuse the exclusive instance.
4. Add deterministic tests for complete acknowledgement, partial/no acknowledgement, malformed/oversized/multi-frame responses, complete-frame close errors, no response replay, and request bounds.
5. Extend the disposable compiled-host proof with a response larger than the pipe buffer and repeated public read calls, proving exact delivery across all five endpoints without a caller-level retry or second pipe instance.
6. Keep architecture/LEGO tests explicit: one shared client framing owner, one host acknowledgement owner, no provider/setup semantics, no partial-response replay, and no timeout widening.
7. Run focused tests, repository preflight, architecture/product/standalone gates, the complete serialized suite on the supported minimum Node runtime, doctor, standalone regeneration, diff hygiene, and exact disposable cleanup.
8. Publish one isolated PR against exact Stage 8 `fdabc56859b2fd2f0aef27d65a0099f147fef5c5`. Require all four hosted jobs, merge only the accepted exact head, and require a fresh four-job Stage 8 post-integration run.
9. Install only that accepted Stage 8 head, then obtain fresh authorization for one ordinary setup attempt and its immediate single UAC child. Stop on the first new blocker. Route health, one real GitHub task, and Hello World compile/test remain downstream physical gates.

## Local implementation and qualification

The implementation follows the dependency order above: one shared acknowledged JSON-line transaction owns client framing; lifecycle, configuration, and activity compose it while preserving their distinct request/result bounds and cancellation/operation timing; acceptance inherits lifecycle composition; and the existing Windows protected host validates the exact fixed acknowledgement within its existing 5,000 ms pre-request bound before disconnecting its one exclusive pipe instance. No application protocol, endpoint, DACL, service, provider operation, replay rule, or setup timeout changed.

Final focused evidence passes 22/22 on Node.js 24.15.0. It covers complete, partial, malformed, multi-frame, null, post-frame close, and acknowledgement-write-failure behavior; preserves zero-response-only replay; compiles the real C# host; proves one-instance namespace ownership; sends an 8,000-byte response across the 4 KiB pipe buffer; and completes 30 configuration, 30 lifecycle, and 30 activity reads through all five endpoint plans. Final repository preflight passes two standalone artifacts, 256 syntax files, two JSON files, and 206 dependency-selected tests. Doctor is green with GitHub admission ready, Git/CMake/CTest/MSVC present, one coherent absent Linux declaration backed by the verified v6 image, and repository execution truthfully unavailable. `git diff --check` is clean apart from the repository's existing checkout line-ending notices.

The final exact serialized suite on the official minimum Node.js 22.16.0 runtime passes 2,134 total / 2,113 passed / 21 expected skips / zero failures / zero cancellations in 322.394 seconds. The official archive's expected and actual SHA-256 were both `21c2d9735c80b8f86dab19305aa6a9f6f59bbc808f68de3eef09d5832e3bfbbd`, and the executable reported exact version `v22.16.0` before qualification.

Cleanup validated each immediate target beneath `C:\Users\josho\AppData\Local\Temp`, verified that no active process referenced a target, removed all 404 qualification/preflight-created `db-*`/`devbridge-*` directories from the 2026-09-01 18:50 onward work window, and removed the exact TAP evidence file after recording its totals. Git fixture cleanup required clearing 5,688 read-only attributes only inside those validated disposable roots. Zero matching directories from that work window and no TAP/runtime artifact remain. Canonical installation state and the pre-existing ambiguous 2026-08-27 elevation channel were not touched.

## Stop conditions

Stop rather than broaden scope if correct delivery requires replaying partial responses, changing operation semantics, adding a second pipe instance or service, weakening DACL/first-instance ownership, blocking without a hard bound, widening connection/provider timeouts, adding setup-level retry/sleep, changing provider/VM/guest state outside the existing protected owner, or manually repairing the live host.
