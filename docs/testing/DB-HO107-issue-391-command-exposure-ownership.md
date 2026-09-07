# DB-HO107 — Command exposure ownership and application inventory

Date: 2026-08-30

Status: assessed and planned; implementation pending

Coordinates with: #103, #116, #159, #180, #391, DB-003, DB-009, DB-011, DB-019, DB-020, DB-HO095, DB-HO103, DB-HO104, DB-HO105, and DB-HO106.

GPU/CUDA work is deferred and outside this checkpoint.

## Scope and nonclaims

This checkpoint owns the ordinary-user command exposure created by guided setup: the stable command file and the exact current-user PATH/profile publication that makes it discoverable. It adds durable pre-effect ownership, bounded restart reconciliation, one read-only application-payload inventory contributor, and launch/removal exclusion through a local activity transaction.

It does not expose an uninstall command, remove the live canonical installation, retire legacy Stage-0 state, alter configuration authority, stop or remove a protected service, mutate provider/image/environment/VM/guest state, request elevation, execute repository code, invoke a coding model, or implement GPU/CUDA behavior. Application coverage remains incomplete until the remaining independently owned producer or explicit absence gates are present. Full purge remains separately gated by protected lifecycle adapters and real Hyper-V plus KVM/libvirt evidence.

## Accepted baseline and repository assessment

The isolated branch is clean and remote-equal at accepted documentation head `a7605b0f2311c2b9e79dd3fd3a939878be700430`. Exact removal-interlock implementation `c2c95fb059b235cddf18a5817070a77b1981e949` and that documentation head passed Ubuntu smoke/full and Windows bounded-smoke/serialized-full, architecture gates, standalone installer regression, and doctor in runs [33334772070](https://github.com/iteathen/DevBridge/actions/runs/33334772070) and [33334973190](https://github.com/iteathen/DevBridge/actions/runs/33334973190).

The accepted stack now provides exact Permanent Entry and runner-cache receipts, neutral dynamic inventory, durable per-effect binding, complete multi-owner activity transactions, exact effect reconciliation, terminal receipt retirement, and completed-operation rotation. Neither accepted payload producer owns the command published by `src/setup/path-installation.js` or the external current-user exposure that setup changes.

The exact setup audit found:

- Permanent Entry receipts own `devbridge-entry.mjs`, its sparse direct wrappers, and exact component generations. They do not own the separate stable `devbridge`/`devbridge.cmd` command written by setup.
- Setup writes that command and then mutates either the Windows current-user `Path` value or a marked block in the user's POSIX `.profile`. It persists no pre-effect reservation, completed ownership receipt, original value, exact post-effect value, or recovery evidence.
- Setup can therefore report success, then lose the only durable record of whether it created or adopted the exposure. A later remover would have to guess from a marker, current pathname, or current value, which DB-003/009 prohibit.
- The current-user `Path` and `.profile` are shared operator state. They may change independently after setup. They cannot be represented as an exclusive filesystem tree and must never be recursively removed or rewritten from stale evidence.
- The setup call is not currently mutually exclusive with future application removal. The accepted removal source can observe contributors, but it cannot close this missing owner's observation-to-effect race until setup publishes a transaction stud.
- Read-only canonical observation confirms the modern entry and command are present while legacy runtime and protected/state trees also remain. This is topology evidence only; it grants no removal authority and no canonical mutation is included here.

## Primary-source research

- [Node.js 22.16 filesystem promises](https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#promises-api) states that promise-based filesystem operations use the thread pool and are not synchronized or threadsafe. Its `writeFile` contract also warns against overlapping writes. Reassessment: an inventory observation is not admission, and profile publication/removal requires one local transaction plus exact rereads around every effect.
- [Node.js `rename`](https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#fspromisesrenameoldpath-newpath) is a separate filesystem operation; it does not provide a content compare-and-swap contract. Reassessment: temporary-file publication may make replacement atomic to readers, but it cannot turn a stale profile observation into authority. The owner must reject changed source values before effect and re-observe its exact result.
- [Microsoft `Environment.SetEnvironmentVariable`](https://learn.microsoft.com/en-us/dotnet/api/system.environment.setenvironmentvariable) documents that the `User` target writes the current user's environment registry key and notifies Explorer with `WM_SETTINGCHANGE`. It exposes create/modify/delete behavior, not conditional compare-and-swap. Reassessment: the Windows adapter must bind the exact complete before/after values, refuse a changed value, apply only through its fixed current-user operation, and verify the complete accepted result.
- [Microsoft user environment variables](https://learn.microsoft.com/en-us/windows/win32/shell/user-environment-variables) documents that processes inherit copies of environment blocks. Reassessment: successful persistent mutation does not change the current process's inherited PATH and uninstall cannot claim immediate visibility in already-running shells; status must remain truthful about session refresh.
- The [POSIX shell rationale](https://pubs.opengroup.org/onlinepubs/9799919799/xrat/V4_xcu_chap01.html) describes `.profile` as typically executed at session startup, unlike per-invocation `ENV`. Reassessment: the current setup choice is session-oriented shared state. This checkpoint preserves that existing contract but gives its exact marked publication an owner; it does not broaden into shell-specific startup-file discovery.

## Ownership reassessment

The command exposure owner needs two distinct local effects:

1. one exact regular command file beneath the already selected installation bin directory; and
2. one exact shared-state publication that makes that directory discoverable for future user processes.

They share one owner and activity transaction but not one mutation mechanism. The command file can use the accepted exact-artifact action with a non-exclusive, non-root-removing manifest. The external exposure needs a small owner-local action whose private descriptor binds platform, exact target, exact complete before value, exact complete after value, and bounded byte count. Its public inventory projection remains only an opaque effect.

The owner may classify an exact already-present command/exposure as `adopted` only after the same static content/value checks used for creation succeed. Missing state is `created` and must be durably reserved before the first write. A pending reservation may complete after restart only when observation proves either the exact pre-effect or exact post-effect state. Any third state, duplicate exposure, foreign command bytes, indirection, or changed shared value is ambiguous and preserved.

The shared current-user value is not made safe by a DevBridge lock against unrelated editors. The accepted bounded policy is deliberately conservative: automatic removal is eligible only while the complete value still equals the exact post-effect value bound in the receipt. Unrelated later edits therefore preserve the exposure and report ambiguity rather than risking lost user data. This is a truthful limitation, not a fallback.

The neutral receipt/value inventory bricks must not learn command, PATH, profile, platform, setup, Permanent Entry, runtime, service, provider, repository, or VM identities. The platform-local adapter owns its descriptor and effect. A small composition owns receipt locations, contributor identity, relationships, action routing, and the transaction stud.

Removal order is external exposure first, then command file. The command item therefore depends on the exposure item in the neutral removal graph. Receipt/control history, binding records, installation identity, configuration, setup authority, provider/environment declarations, and unregistered state remain preserved.

## Primitive-to-high-level implementation plan

1. Add an import-isolated owner-local command-exposure adapter with a closed descriptor protocol and fixed `observe`, `publish`, and `remove` ports. Validate exact object shape, bounded complete before/after values, one normalized target, and deterministic identity. Keep PowerShell/script details and POSIX profile structure inside this adapter.
2. On Windows, read and write only the current-user `Path` through a fixed noninteractive PowerShell operation with bounded structured output. Reject duplicate target entries, widened output, timeout, truncation, nonzero exit, and any complete-value mismatch. On POSIX, require a real regular non-link profile when present, one exact marker block, bounded content, same-source re-observation, atomic same-directory replacement, and exact post-effect reread.
3. Add one stable local process activity transaction for the complete command/exposure publication and future removal session. Expose only neutral `observe` and awaited `run` studs; never expose its path/token.
4. Add one owner-local immutable receipt collection and exact value state. Reserve both effects before mutation, publish the external exposure before reporting command availability, complete only from exact post-effect evidence, reconcile exact pending state on restart, and preserve foreign/ambiguous state. Do not add a post-hoc compatibility receipt path.
5. Represent the command with the accepted exact-artifact descriptor using `exclusive: false` and `removeRoot: false`. Represent the shared exposure with the new owner-local descriptor. The completed receipt values remain private.
6. Add one read-only inventory composition over the accepted dynamic value inventory. Route only the two registered descriptor protocols, project `application` coverage only when receipts are complete and current, and order exposure before command deletion. Exact terminal retirement must use the accepted receipt CAS path.
7. Refactor `installStableDevBridgeCommand` to use this owner without changing its public setup result, branch/ref authority, launcher selection, collision policy, or session-refresh reporting. Delete superseded direct mutation logic; do not retain a compatibility implementation.
8. Test created/adopted/idempotent publication, interruption before/after each effect, exact restart completion, foreign command, link/reparse state, duplicate exposure, changed shared value, malformed/widened platform output, activity contention, source generation/retirement, dependency order, private-descriptor non-disclosure, cross-platform deterministic behavior, and LEGO import/name isolation.
9. Compose only disposable application-removal fixtures to prove exact command/exposure deletion and receipt retirement. Keep aggregate production application coverage incomplete and expose no CLI until the remaining producer/absence gates are separately accepted.
10. Regenerate standalone artifacts as required, run focused tests on current and exact Node 22.16.0, bounded preflight, architecture/product/standalone gates, the complete exact serialized suite, doctor, freshness/diff hygiene, then push only the isolated branch and require exact-head Ubuntu/Windows smoke/full acceptance.

## Acceptance boundary

Acceptance proves that future application removal can consume exact, restartable, setup-owned command-exposure evidence without guessing from current PATH/profile or filenames, and that setup publication cannot overlap the removal transaction. It does not make uninstall reachable or DevBridge operational. Legacy runtime, configuration/setup authority, protected service/provider/environment state, and every unregistered or changed external value remain preserved.
