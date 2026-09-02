# DB-HO122 — issue #372 close-only response completion

Date: 2026-09-01

Status: new physical activation blocker classified; isolated transport correction implemented; complete local qualification passed; hosted qualification pending

Coordinates with: #360, #362, #368, #372, #429, DB-003, DB-008, DB-009, DB-011, DB-019, DB-020, DB-HO116, DB-HO117, DB-HO118, DB-HO120, and DB-HO121.

## Physical checkpoint

Exact accepted Stage 8 head `7b4d0f91e2c1b65d1b4ebac56c985318c68a2362` is installed under the canonical non-OneDrive home `C:\Users\josho\.devbridge`. One authorized ordinary setup invocation prepared exact protected frontier revision 9 without elevation. After separate fresh authorization, one ordinary re-entry emitted `elevation-consent: requesting` at setup elapsed zero and entered one protected transaction. DevBridge reported the transaction and elevation outcome completed at 146 seconds, completed ordinary protected verification and checkpointed the exact subject at 202 seconds, and started environment activation at 204 seconds. Activation failed at 217 seconds with `Protected environment activation failed: environment lifecycle authority is unavailable`; setup exited 3. DevBridge process evidence does not prove what the operator physically saw on the Windows secure desktop.

The protected frontier is revision 10 in `applied` state. The service is Running/Automatic at new generation `fba8db09a7c5f4073989f6de1c235dc80f42d859c75896694f88f955d5557f10`. No create mutation began: setup activation failed on its first lifecycle `list` read. A later exact accepted-source read returned the coherent absent `linux-development` declaration in 14.273 seconds. Five additional no-replay diagnostic reads returned complete valid 1,468-byte results in 14.752, 14.346, 14.280, 14.828, and 14.033 seconds. The declaration remains absent, the v6 image remains verified locally, no transition is active, and `create` remains the supported next action.

Cleanup removed one verified orphan test process tree from this worktree (PIDs 21704, 1748, and 19300) and confirmed all three processes absent. The source worktree contained no other change before this correction branch.

## Exact source defect and evidence boundary

The shared acknowledged JSON-line transaction recognizes a complete bounded response, parses it, and queues the fixed acknowledgement. It then waits for the server terminal event. `end` accepts the complete frame. A later `error` also accepts the complete frame. The remaining `close` handler unconditionally returned `connection closed ambiguously`, even when the same complete frame had already been parsed and acknowledged.

That asymmetry is an independent transport defect. A socket `close` is terminal delivery evidence, not a second application frame. Once one bounded JSON line is complete and the fixed acknowledgement has been queued, accepting it on `close` has the same authority and framing meaning as accepting it on `end` or a post-frame close error. If no newline arrived, JSON is malformed, a suffix contains another frame, the response exceeds its bound, or acknowledgement queuing fails, the transaction remains failed closed.

The public lifecycle client intentionally maps native transport details to `LIFECYCLE_AUTHORITY_UNAVAILABLE`, so the failed setup invocation does not retain whether Windows delivered `end`, `error`, or `close`. The physical timing and later healthy reads locate the blocker at terminal response delivery, while the new deterministic regression proves the close-only source defect exactly. Do not overstate that inference: final proof that this correction clears the physical blocker requires complete acceptance, exact installation, and one newly authorized setup attempt.

## Nested design

1. **LEGO:** only the neutral local-authority complete-frame owner changes. Lifecycle, activity, configuration, acceptance, setup, provider, and construction bricks retain their protocols and responsibilities.
2. **SOLID:** terminal socket events delegate to the single existing complete-frame predicate instead of duplicating domain or framing decisions.
3. **CUPID:** one complete bounded acknowledged frame has one predictable outcome across `end`, post-frame `error`, and `close`; incomplete or ambiguous bytes remain rejected.
4. **KISS:** replace the unconditional close failure with the existing `acceptResponse` function and add one focused regression. Add no retry, sleep, cache, journal, service, server instance, provider fallback, or timeout change.

## Timeout and authority decision

No production timeout is widened, shortened, added, or removed. The caller-selected connection deadline, replay re-arm accounting, provider command bounds, five-second protected acknowledgement bound, response size limits, and operation cancellation rules are unchanged. The correction grants no mutation replay or broader authority and does not reinterpret partial response bytes as success.

## Implementation and focused evidence

`transactAcknowledgedLocalAuthorityJsonLine` now routes `close` through its existing `acceptResponse` predicate. The new regression proves a complete parsed-and-acknowledged frame succeeds on close-only delivery while a partial close sends no acknowledgement and remains failed closed.

Current Node.js 24.15.0 focused lifecycle/configuration/activity/connection tests pass 32/32. The real PowerShell 5.1 compiled protected host passes 8/8, including namespace exclusivity, an 8,000-byte response, 30 configuration reads, 30 lifecycle reads, and 100 activity reads across all five endpoints. Both changed files were already explicit repository-preflight inputs.

## Complete local qualification and cleanup

The broader authority/setup selection passes 342 total / 341 passed / one expected Windows symlink-capability skip / zero failed. Current-runtime preflight passes two standalone artifacts / 257 syntax files / two JSON files / 207 dependency-selected tests; the architecture gate passes 34 total / 33 passed / one expected symlink skip; and product plus standalone gates pass 7/7.

The same gates pass on the official minimum Node.js 22.16.0 runtime whose downloaded archive matched SHA-256 `21c2d9735c80b8f86dab19305aa6a9f6f59bbc808f68de3eef09d5832e3bfbbd`: broader selection 342 / 341 / one expected skip / zero failed; preflight two artifacts / 257 syntax / two JSON / 207 selected tests; and combined architecture/product/standalone 41 total / 40 passed / one expected skip / zero failed. The complete exact-runtime serialized suite passes 2,136 total / 2,115 passed / 21 expected platform skips / zero failed / zero cancelled in 340.292 seconds. Exact doctor reports `ok: true`, GitHub admission ready, native Git/CMake/CTest/MSVC available, the coherent absent lifecycle declaration ready for `create`, and repository execution truthfully unavailable because no route is configured.

Cleanup terminated only the verified orphan qualification process tree (PIDs 21704, 1748, and 19300). It removed the checked 133,896,200-byte Node runtime, the 507,758-byte TAP transcript, and all 124 isolated qualification fixture roots containing 7,722 files / 31,945,839 bytes. Forty-five fixture roots required clearing their test-owned read-only attributes before removal. Final verification reports zero matching work-window roots, zero checked-runtime or TAP artifacts, and zero attributable live processes. The earlier interim description of those roots as empty was stale; the measured file and byte totals above are the corrected cleanup record.

## Remaining acceptance plan

1. Commit the locally accepted isolated candidate against exact Stage 8, publish it on #372/#368, require all four pull-request jobs, merge only the accepted exact head, and require a fresh four-job post-integration run.
2. Install only that accepted head. Obtain fresh authorization before one ordinary setup attempt. Do not manually alter the service, groups, ACLs, provider, network, image, VM, guest, PATH, or installation state.
3. After environment construction and route readiness, receive one real GitHub task and prove Hello World compile/test through the admitted VM execution path.

## Stop conditions

Stop rather than broaden scope if success would require accepting partial or multi-frame responses, replaying a mutation, extending a timeout, adding setup sleep/retry, weakening first-instance or DACL protection, adding a direct-host/provider bypass, or manually repairing protected host state.
