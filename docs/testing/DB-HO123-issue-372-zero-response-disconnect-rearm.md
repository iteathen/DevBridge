# DB-HO123 — issue #372 zero-response terminal re-arm

Date: 2026-09-01

Status: exact post-DB-HO122 physical blocker classified; isolated bounded transport correction implemented; complete local and hosted-equivalent qualification green; pull-request qualification pending

Coordinates with: #360, #362, #368, #372, #445, DB-003, DB-008, DB-009, DB-011, DB-019, DB-020, DB-HO116, DB-HO117, DB-HO118, DB-HO120, DB-HO121, and DB-HO122.

## Accepted basis and physical checkpoint

DB-HO122 candidate `597171c118d59fa071a56247892767d53d3bd601` passed all four jobs in pull-request run `33596908087` and rebase-merged as exact Stage 8 head `109720e64da6a2e4894374af4ec7a05670a71a0b`, tree `096baf1afddbd780848a72db3129a15210652dbc`. Fresh Stage 8 run `33597235148` passed Ubuntu and Windows full plus smoke. The canonical non-OneDrive installation was pinned to that exact head.

The bootstrap bind also performed ordinary setup preparation and stopped normally at protected frontier revision 11 `prepared`; it emitted no elevation request. After fresh operator authorization, one ordinary non-elevated `devbridge setup` emitted the identified elevation request at setup elapsed zero and entered one bounded protected transaction. DevBridge reported the protected child and elevation completed at 142 seconds, ordinary protected verification completed at 200 seconds, and the exact prepared subject checkpointed as applied. Environment activation began at 201 seconds and failed at 214 seconds on its first lifecycle `list` with `environment lifecycle authority is unavailable`. DevBridge process evidence does not prove what the operator physically saw on the Windows secure desktop.

The durable frontier is revision 12 `applied` with the same exact subject. The service is Running/Automatic under `LocalSystem` at new generation `c36d50e8ddaf2da1d23eb726d6ca28f44e0704b915414905d146f01c2d04aab1`. No lifecycle `create` mutation began. No setup retry, construction command, or manual service, group, ACL, provider, network, image, VM, guest, PATH, installation, OneDrive, or D: correction followed.

## Exact remaining source boundary

Ordinary protected verification successfully exercises the accepted authority before setup creates a fresh lifecycle client for activation. The failure is therefore a consecutive single-instance handoff, not general service startup, provider health, missing profile state, or a long-running provider timeout. A later raw read-only lifecycle `list` using the exact accepted endpoint, request protocol, framing, and three-second connection bound succeeded in 14.366 seconds. Five additional immediate single-attempt traced reads all succeeded in 13.757–14.598 seconds with one valid 1,469-byte frame followed by native Windows `EPIPE`, proving DB-HO120/122 complete-frame handling works in steady state.

The shared bounded re-arm adapter already permits a protocol-classified replay-safe Windows read to retry native `EPIPE` only when zero response bytes arrived. A retiring one-instance pipe may instead terminate cleanly through `end`/`close` with zero bytes. `transactAcknowledgedLocalAuthorityJsonLine` converted that condition directly into its public authority failure without attaching the byte count or a neutral terminal classification, so the existing bounded re-arm owner could not distinguish it from a semantic failure. The accepted code's new deterministic composition test reproduced that exact gap: 15 tests passed and the clean-zero-response re-arm test failed with `fixture authority closed without a result`.

The public lifecycle client intentionally erases native transport details. The failed physical invocation therefore does not retain whether its zero-result terminal event was clean or carried a native code. The physical timing, immediately preceding readiness success, later healthy complete-frame reads, and exact source gap identify clean zero-response termination as the remaining candidate seam, but final physical causality remains an inference until the accepted correction clears one later authorized setup attempt.

## Nested correction

1. **LEGO:** keep the existing neutral local-authority transaction adapter as the sole owner of Windows connection and stale-instance re-arm. Lifecycle, activity, configuration, acceptance, setup, service, and provider components retain their protocols and responsibilities.
2. **SOLID:** the framing transaction reports only its observed terminal class and response-byte count; the bounded transaction owner combines that evidence with the protocol owner's existing `replaySafe` decision.
3. **CUPID:** replay-safe Windows reads receive one predictable zero-response rule whether the retiring instance reports native `EPIPE` or a clean terminal disconnect. Any response byte makes the exchange non-replayable.
4. **KISS:** attach two internal evidence fields to the existing clean-terminal failure and extend one existing predicate. Add no setup retry, sleep, cache, journal, extra pipe/server/service, provider fallback, or timeout change.

## Authority and timeout decision

Only a protocol-classified replay-safe operation on a Windows named pipe may re-arm after the new terminal class, and only when `localAuthorityResponseBytes` is exactly zero. Mutations, Linux sockets, denied opens, cancellation, acknowledgement-write failures, partial responses, malformed frames, oversized frames, and multiple frames remain single-attempt and fail closed.

The caller-selected first connection window and the separately bounded re-arm connection budget are unchanged. Connected transaction time still does not consume a connection budget; reconnect delay and open work do; later failures cannot replenish it. No production timeout is widened, shortened, added, or removed.

## Qualification and remaining gates

The new regression composes the real framing transaction with the real bounded re-arm adapter. It fails on exact accepted Stage 8 and passes after the correction. It also proves a partial clean terminal response is not replayed. The focused adapter file passes 16/16 after the change.

Current Node.js qualification passes the broader lifecycle/configuration/activity/setup/acceptance/compiled-host selection 86/86; repository preflight at two standalone artifacts / 257 syntax files / two JSON files / 207 selected tests; architecture at 34 total / 33 passed / one expected Windows symlink skip; and product identity plus standalone launcher at 3/3.

The official exact-minimum Node.js 22.16.0 archive contained 35,466,975 bytes and matched SHA-256 `21c2d9735c80b8f86dab19305aa6a9f6f59bbc808f68de3eef09d5832e3bfbbd`. Under that runtime, the same preflight, architecture, product/standalone, and 86-test focused selection all passed. The complete exact serialized suite passed 2,137 total / 2,116 passed / 21 expected skips / zero failed / zero cancelled in 331.467 seconds. Exact doctor is green with GitHub admission, Git, CMake, CTest, MSVC, lifecycle authority, and verified environment declaration ready; repository execution remains truthfully unavailable because no route is configured. Doctor persisted no reference to the temporary runtime in the canonical installation or worktree.

Attributable cleanup checked 151 Temp targets containing 11,192 files / 171,551,722 bytes, all beneath the resolved Windows Temp root with no reparse points, invalid paths, or live process users. It removed 150 fixture/runtime directories and the TAP evidence file, including 2,736 read-only entries only within those checked targets. The exact runtime, TAP file, and all matching qualification-window roots are absent afterward. The only recent canonical-installation file is the revision 12 protected-apply checkpoint produced by the authorized physical setup; cleanup did not touch it.

Publish one isolated pull request against exact Stage 8, require all four hosted jobs, merge only the accepted exact head, and require a fresh four-job Stage 8 run. Bind only that accepted head with the explicit install-only path. Obtain fresh authorization before any later ordinary setup re-entry; do not infer authorization from this source qualification.

Environment construction, route publication, one real GitHub task, and Hello World compile/test remain required downstream acceptance gates.
