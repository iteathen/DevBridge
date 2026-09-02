# DB-HO121 — issue #372 absent-environment recovery evidence

Date: 2026-09-01

Status: physical defect classified; owner-local correction implemented and locally qualified; hosted acceptance pending

Coordinates with: #116, #169, #170, #171, #172, #176, #177, #360, #368, #372, #429, DB-009, DB-019, DB-020, DB-HO050, and DB-HO120.

## Physical checkpoint

Stage 8 exact head `21e4db6d35d095acd8bea4f14b73b02613df3467` passed all four hosted Ubuntu/Windows smoke/full jobs in post-integration run `33589024847` and is installed under the canonical non-OneDrive home `C:\Users\josho\.devbridge`.

One authorized ordinary `devbridge setup` invocation prepared protected revision 7 without elevation and stopped at its intentional re-entry fence. One separately authorized ordinary re-entry then requested the single protected child at setup elapsed zero, completed the protected transaction and ordinary verification, and reached environment activation. Activation failed after approximately 20 seconds with `environment lifecycle authority is unavailable`; setup exited 3. No retry or manual provider, service, ACL, path, image, VM, or guest mutation followed.

Post-failure read-only evidence shows the protected service running with the expected five endpoints and protected revision 8 applied. The exact accepted client observes one valid `linux-development` declaration, the verified `ubuntu-2604-production-v6` image, no active transition, and `materialization: none` with supported next action `create`. Lifecycle `inspect` and `list` each take approximately 21–22 seconds. Five diagnostic no-replay reads each received a complete valid 1,469-byte `ok: true` response after 21.8–22.4 seconds; the later pipe close event is already handled by the production complete-frame rule. The diagnostic-only 60-second observation guard was not written into product configuration or source and is not proposed as production policy.

## Exact diagnosis

The lifecycle read path observes materialization, then independently gathers recovery evidence. `createEnvironmentRecoveryEvidence` always calls `foundation.inspect()` before considering whether a materialization exists. On Windows that foundation inspection invokes the Hyper-V capability script, including `Get-VMHost`, through its existing owner-local 20-second command bound.

Microsoft documents `Get-VMHost` as retrieving a Hyper-V host, with a parameterless call retrieving the local host. It is therefore a live provider-capability observation. It is required for provider foundation readiness and later create admission, but it cannot change the already-authoritative lifecycle fact that this declaration has never been materialized.

`diagnoseEnvironment` deterministically maps a valid `materialization: none` observation to `materialization-not-created` and supported action `create` before resource, network, or workspace evidence is consulted. Calling foundation, preparation, or workspace evidence on this path is redundant work at the wrong ownership boundary. It makes an ordinary read depend on a slow provider probe and exposes the transport to an avoidable long-response seam.

Primary reference:

- https://learn.microsoft.com/en-us/powershell/module/hyper-v/get-vmhost

## Reassessment and nested design

1. **LEGO:** the recovery-evidence brick owns only evidence needed to refine a materialized environment diagnosis. A positive absent observation terminates this brick with neutral evidence; provider capability remains owned by foundation/create admission.
2. **SOLID:** the lifecycle observer supplies the materialization fact, recovery evidence gathers only conditionally relevant dependencies, and construction retains its independent provider/resource gates. No provider concern moves into diagnosis.
3. **CUPID:** absence produces one predictable, composable result without hidden provider I/O. Present and unobservable materializations keep their established evidence behavior.
4. **KISS:** add one early return and focused contract tests. Add no retry, sleep, cache, new service, alternate provider path, direct-host fallback, or timeout change.

The absent-state evidence is conservatively neutral:

```text
resources: unknown
network: unknown
workspaces: unknown
```

These values do not claim provider readiness. The diagnosis owner already gives the stronger and earlier result: the environment is absent and `create` is the next action. The later create lifecycle still performs its own image, resource, materialization, preparation, workspace, and readiness stages.

## Timeout safety decision

No production timeout is widened, shortened, added, or removed in this correction. The existing Hyper-V command bound remains owned by the provider adapter for operations that actually need the capability probe.

Any later timing-policy change must have one explicit operation owner, a locally controlled hard ceiling, bounded liveness reporting, fail-closed behavior, and durable observe/reconcile semantics after interruption. A timeout must not grant replay or broader authority, and a diagnostic guard must not silently become product policy. This follows DB-009 and DB-019 and remains coordinated with #429 rather than being absorbed into this defect correction.

## Dependency-ordered implementation plan

1. Add an early absent-materialization return to `createEnvironmentRecoveryEvidence.inspect` before foundation, preparation, or workspace inspection.
2. Return only the closed neutral evidence shape and preserve existing behavior for present, missing, unavailable, ambiguous, and malformed downstream conditions.
3. Add a focused test proving all three evidence ports remain uncalled and the exact neutral result is returned for `materialization: none`.
4. Preserve the existing present-materialization test and add/retain evidence that materialized state still consults its required owners.
5. Run the focused recovery/diagnosis/lifecycle tests, repository preflight, architecture gates, and the complete serialized suite on the supported minimum Node runtime.
6. Verify diff hygiene and remove only exact disposable test artifacts created by this checkpoint.
7. Publish one isolated PR against exact Stage 8 `21e4db6d35d095acd8bea4f14b73b02613df3467`; require all four hosted jobs, merge only the accepted exact head, and require a fresh four-job post-integration run.
8. Install only the accepted Stage 8 head. Obtain fresh authorization before one new ordinary setup attempt and its immediate single UAC child. Stop at the first new physical blocker.
9. After construction and route readiness, receive one real GitHub task and prove Hello World compile/test through the admitted VM execution path.

## Implementation

`createEnvironmentRecoveryEvidence.inspect` now returns the closed neutral evidence shape immediately when the authoritative observation says `materialization: none`. Foundation, preparation, and workspace ports are not invoked on that path. All other materialization states retain the existing evidence flow, and the provider adapter's 20-second command bound is unchanged.

The focused test records every evidence-port invocation and proves the absent path returns `unknown` for resources, network, and workspaces with an empty event list. The existing present-materialization test still proves foundation, preparation, and workspace evidence combine into the established result. The changed source and focused test are now explicit members of repository preflight.

## Local qualification

- Current Node.js 24.15.0 focused recovery/diagnosis set: 11/11 passed.
- Current Node.js 24.15.0 broader lifecycle/setup/LEGO set: 32/32 passed.
- Current-runtime bounded repository preflight: 2 standalone artifacts, 257 syntax files, 2 JSON files, and 207 targeted test files passed.
- Repository-execution architecture gate: 34 total, 33 passed, one expected local Windows symlink-capability skip, zero failures.
- Product identity: 1/1 passed; standalone launch: 2/2 passed.
- Official exact Node.js 22.16.0 archive: expected and actual SHA-256 `21c2d9735c80b8f86dab19305aa6a9f6f59bbc808f68de3eef09d5832e3bfbbd`; runtime reported `v22.16.0`.
- Exact Node.js 22.16.0 broader lifecycle/setup/LEGO set: 32/32 passed; architecture gate: the same 33 passed / one expected skip.
- Exact Node.js 22.16.0 bounded repository preflight: the same 2 / 257 / 2 / 207 inventory passed.
- Exact Node.js 22.16.0 complete serialized suite: 2,135 total, 2,114 passed, 21 expected platform skips, zero failures, zero cancellations in 362.818 seconds.
- Exact-runtime doctor: `ok: true`, GitHub admission ready, one reconstructable absent Linux declaration backed by the verified v6 image, and repository execution truthfully unavailable pending construction/routing.
- Standalone artifact check and diff whitespace hygiene passed; Windows emitted only the repository's existing line-ending notices.

Read-only doctor still took 23.690 seconds because its lifecycle query correctly crossed into the currently installed protected service, which still runs the accepted pre-correction Stage 8 bytes. Local source code cannot and must not replace that protected runtime during software qualification. A response-time proof for this correction therefore remains a post-merge exact-install physical gate, not a simulated local claim.

Cleanup first resolved every target beneath the exact LocalAppData Temp root, verified zero active executable references and zero reparse entries, and then removed the one checksum-verified Node qualification root plus 120 test-created `db-*`/`devbridge-*` roots from this checkpoint's work window. It cleared 1,950 read-only fixture attributes only inside those validated roots. Zero matching checkpoint-created roots remain. Canonical installation, protected service/provider state, and the pre-existing ambiguous elevation channel were not changed.

## Stop conditions

Stop rather than broaden scope if the correction requires changing provider timeout policy, bypassing provider/create admission, treating unknown capability as ready, adding client/setup replay, weakening protected transport behavior, adding direct-host execution, mutating the live host during software qualification, or manually repairing provider/service state.
