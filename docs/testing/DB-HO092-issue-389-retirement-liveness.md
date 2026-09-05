# DB-HO092 — Bounded local retirement liveness

Date: 2026-08-30

Issue: [#389](https://github.com/iteathen/DevBridge/issues/389)

Parent work: VM Stage 8 #116 and exact construction retirement #388. Coordinates with DB-009, DB-019, and DB-020.

GPU/CUDA work is outside this checkpoint.

## Assessment

The exact construction-retirement transaction is correct and durable, but each data-bearing CLI invocation under #388 was silent for several minutes while it planned and hashed exact artifacts and then reconciled six ordered effects. Only the final JSON receipt appeared. This makes healthy work indistinguishable from a hung process to the local operator and violates DB-019's bounded-liveness requirement.

The existing ownership split is sound:

- `construction-retention.js` owns topology-neutral plan authorization and durable effect phases;
- `ubuntu-production-image-retention.js` maps one fixed local construction topology into the neutral source/effect ports;
- `ubuntu-production-image-retention-command.js` derives local state and selects inspect versus exact retire;
- `cli.js` owns terminal presentation.

The slow exact plan is built while the neutral owner awaits its injected source snapshot. Therefore, effect adapters alone cannot provide complete liveness. Conversely, the neutral owner must not import a terminal, stream, timer, provider, filesystem, or concrete construction module.

The current CLI keeps stdout as one terminal JSON value. That contract must remain intact. Progress is local observability only: it cannot grant authority, prove an effect, declare completion, change retry behavior, or influence the returned result/error.

## Primary-source research

Node's current [Timers documentation](https://nodejs.org/api/timers.html) states that interval timers keep the event loop alive by default, while `Timeout.unref()` makes the timer unable to keep the process alive on its own. It also states that timer timing is approximate rather than exact. Repeated liveness must therefore use one interval, unref it, clear it deterministically, and treat its cadence as bounded observation rather than a deadline or correctness signal.

Node's current [Writable stream documentation](https://nodejs.org/api/stream.html#writablewritechunk-encoding-callback) states that `write()` returning `false` requests that the caller stop writing until drain; continued writes are buffered and can grow memory without bound. The local projection must consequently stop producing further records after backpressure rather than queueing heartbeats.

Node's current [process I/O documentation](https://nodejs.org/api/process.html#a-note-on-process-io) states that stdout/stderr writes can be synchronous or asynchronous depending on platform and destination, and warns that synchronous writes can block under slow terminals, filesystems, or unread pipes. Liveness records must be small, infrequent, and best-effort; a blocked or failing presentation surface cannot block, fail, or alter the retirement transaction.

## Reassessment

Use two replaceable LEGO bricks joined only by a neutral callback:

1. Add an optional progress stud to the neutral retention owner. It projects only a bounded local phase, completed-effect count, total-effect count when known, and bounded attempt count. It emits before awaiting plan construction and after durable phase saves. It exposes no subject, effect identity, digest, path, provider, filename, byte content, executable, or topology identity. Observer failure is swallowed because observation has no transaction authority.
2. Add an isolated local liveness projector that accepts only those neutral scalar fields, starts with a neutral `starting` phase, emits one immediate status and one bounded periodic status, uses one unref'ed timer, and stops in `finally`. It reconstructs a fresh path-free record instead of forwarding caller objects. It never emits a terminal/completed assertion. If the output rejects a write or throws, projection stops without affecting the operation.

The command composition forwards the callback without inspecting progress. The concrete retention composition forwards it to the neutral owner without adding concrete facts. The CLI alone attaches stderr presentation. Stdout remains the sole terminal machine result.

This design covers slow read-only planning as well as mutation because the timer begins before command composition and retains the latest neutral phase while the awaited source/effect work is active. It avoids adding timer or terminal concerns to the transaction owner and avoids a duplicate liveness mechanism inside every exact adapter.

## Primitive-to-high-level implementation plan

1. Implement and unit-test the import-free bounded local projector: field normalization, fixed output schema, elapsed time, one timer, unref, stop, no-progress repetition, backpressure suppression, output-failure isolation, and `finally` cleanup.
2. Add the optional neutral progress stud to construction retention and test normal phases, slow awaited work, observer failure, and resumed-journal reconciliation without changing authorization/effect semantics.
3. Forward the stud through the concrete composition and command boundary without adding topology data.
4. Attach the projector only to the `construction-retention` CLI branch; preserve one terminal stdout JSON value and route bounded liveness only to stderr.
5. Add source-isolation and bounded-schema tests proving that neither neutral brick imports or names concrete topology and that arbitrary foreign fields cannot cross the projector.
6. Run focused normal/failure/restart/slow-I/O/no-progress/bounded-output tests, then repository preflight, architecture/product gates, the complete serialized suite, doctor, diff/generated hygiene, and hosted Ubuntu/Windows CI on the exact implementation head.
7. Document exact evidence and close #389 only if both local and hosted acceptance pass. Do not infer protected-service, provider, VM, guest, route, repository-execution, or Stage 7 readiness.

## Acceptance boundaries

- stdout contains exactly one terminal JSON result on success;
- stderr liveness is bounded, path-free, non-terminal, and local only;
- planning/hash silence is bounded even before the first effect exists;
- a stalled phase continues to show elapsed liveness without inventing progress;
- a slow or failed output surface cannot accumulate unbounded writes or affect transaction success/failure;
- observer exceptions/rejections cannot grant, deny, retry, or complete an effect;
- restart resumes from durable journal evidence and progress reflects the recovered neutral phase;
- exact plan confirmation, held-handle hashing, one bounded retry, ambiguity failure, and effect ordering remain unchanged;
- the neutral owners contain no CLI, filesystem, provider, topology, or foreign module dependency.

## Non-goals

No recursive deletion, compatibility route, timeout-policy expansion, concurrency, GitHub heartbeat, setup/doctor mutation, elevation/UAC, protected service/provider/VM/guest action, repository execution, model invocation, or GPU/CUDA work belongs in this checkpoint.

## Implementation and verification

Plan commit `5cd8372960f3667d4c0919c4e7cd1cf937c3c403` passed Ubuntu/Windows smoke and full jobs plus doctor in [GitHub Actions run 33307245004](https://github.com/iteathen/DevBridge/actions/runs/33307245004) before implementation began.

Implementation `a061110bc37f926b802f09e7e384dcd1860c9f26` adds three deliberately separate surfaces:

- the neutral retention owner accepts one optional callback and publishes only `phase`, `completed`, `total`, and `attempt`; it emits before awaited plan construction and after durable non-terminal phase saves, and contains observer failures;
- an import-free local liveness owner rebuilds one fixed `devbridge/local-liveness-v1` record, starts immediately, uses one 15-second unref'ed interval, clears it in `finally`, ignores malformed updates, and permanently suppresses further writes after backpressure or output failure;
- a thin CLI composition attaches the status output to stderr and writes exactly one terminal JSON result to stdout after success. The command and concrete construction composition only forward the neutral callback.

No completion claim is emitted through liveness. Exact plan authorization, held-handle hashing, effect binding/order, durable phases, ambiguity handling, and bounded retry remain owned by the existing transaction.

Focused tests pass 27/27 across normal status, awaited slow planning, no-progress elapsed observation, output backpressure/failure, exact operation failure, malformed/foreign-field projection, one-result output separation, observer failure, interrupted-journal restart, and LEGO isolation. Repository preflight passes two standalone artifacts, 219 syntax files, two JSON files, and 178 targeted tests. Repository-execution architecture plus product/standalone gates pass 37 total / 36 passed / one expected Windows symlink skip. The complete serialized suite passes 1,957 total / 1,936 passed / 21 expected platform skips / zero failures in 190 seconds. Doctor is green and truthfully reports repository execution unavailable/fail-closed with model adapters disabled.

A real ordinary-token read-only `construction-retention inspect` emitted bounded local liveness before its one terminal plan. The plan retained digest `ccf36efc59e4011d9c965e84a80408596aa0737477c57fe0fb6a4d67814ef15b`, no lease, the same protected current/accepted/retained subjects, and no eligible obsolete subject. It performed no mutation and required no UAC.

[GitHub Actions run 33307730400](https://github.com/iteathen/DevBridge/actions/runs/33307730400) passed the exact implementation across Ubuntu/Windows smoke and full jobs plus doctor. This accepts the software liveness boundary only; it proves no protected-service, provider, VM, guest, route, repository-execution, or Stage 7 readiness.
