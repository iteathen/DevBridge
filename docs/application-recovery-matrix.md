# DevBridge application recovery matrix

This document is the qualification companion to `docs/application-management.md`.

It answers one question:

> Given a particular set of missing or damaged DevBridge layers, which surviving layer owns reconstruction, and where must DevBridge stop rather than invent authority?

## Layer abbreviations

- **PE** — Permanent Entry
- **R** — Runner / Bootstrap Manager
- **AR** — Accepted Runtime
- **S** — DevBridge Services
- **A** — Durable installation/configuration authority
- **E** — Declared execution environment and its desired-state/lifecycle records
- **I** — Local immutable base-image cache
- **M** — Current provider materialization: VM/domain/system disk
- **W** — Guest/workspace materialization

`A` and the desired-state portion of `E` are authority-bearing durable state. The executable/materialized layers are replaceable.

## Recovery matrix

| Condition | Surviving authority | Recovery owner | Expected supported behavior |
| --- | --- | --- | --- |
| Runner cache missing/corrupt | PE + A | Permanent Entry | Resolve/reacquire exact runner, verify, hand off |
| Accepted runtime missing/corrupt | PE + R + A | Runner | Reconstruct exact approved runtime, activate/reconcile, preserve installation identity |
| Accepted runtime stale/incompatible | PE + R + A + old AR | Permanent Entry + Runner compatibility path | Stage independently verified compatible runtime; do not require stale runtime to repair itself |
| Services stopped/deleted | AR + A | Accepted Runtime | Restart/recreate services from durable state |
| Local base-image cache missing | AR + A + E | Environment image lifecycle | Reacquire exact approved image; verify canonical and provider-native compatibility before publication |
| VM/domain absent | AR + A + E + image availability | Environment construction lifecycle | Create a new implementation generation from the declaration |
| Guest system disk absent | AR + A + E | Environment rebuild lifecycle | Diagnose `system-storage-missing`, rebuild from approved image, reseed workspaces |
| Guest bootstrap/bridge degraded | AR + A + E + M | Repair/rebuild owner according to diagnosis | Repair only when in-place preservation is truthful; otherwise recommend rebuild/recreate |
| Workspace materialization absent | AR + A + E + healthy M | Workspace reconstruction owner | Recreate routes/roots and reseed from host-authoritative source |
| Runner + runtime + services + image cache + VM + guest/workspaces all absent | PE + A + E desired state | Whole-stack composition | PE→R→AR→S→image→environment→workspace→DB-020 readiness |
| Operator authority/configuration also absent | PE only | PE→R→AR, then setup | Restore application software; stop at guided setup/re-entry for authority that cannot be inferred |
| Permanent Entry absent | none of the application bootstrap anchor | External installation entry | Reinstall the small permanent entry through the supported installer/distribution path; do not pretend DevBridge can execute when no DevBridge entry exists |

## Durable authority rule

Automatic recovery is allowed only when the surviving higher layer has enough exact local authority to reconstruct the lower layer.

Examples:

- PE may know the fixed runner source/trust policy needed to acquire R.
- R may know the release/compatibility policy needed to establish AR.
- AR may know the durable local setup/configuration needed to establish S and invoke environment construction.
- E desired state may specify the exact immutable image/profile/bootstrap/resource/workspace requirements needed to rebuild M/W.

Automatic recovery is **not** permission to reconstruct authority from implementation residue.

Do not infer operator authority from:

- a surviving repository checkout;
- guest Git configuration;
- VM/domain names;
- VHDX/qcow2 filenames;
- old process command lines;
- model/chat history;
- GitHub issue text;
- cached provider output;
- a mutable branch name;
- a last-known filesystem path.

## Combined-loss qualification profile

The primary whole-stack recovery canary deliberately removes all replaceable state while retaining only the permanent entry and durable local authority.

Precondition:

- PE installed and valid;
- installation identity and operator-approved authority/configuration retained;
- desired execution declarations retained;
- external immutable runner/runtime/image sources available according to local policy.

Deliberately remove or isolate:

- verified runner cache;
- accepted runtime payload;
- runtime service processes/state that is reconstructable from durable application-management records;
- current VM/domain implementation;
- guest system/writable disk;
- local base-image cache;
- guest bridge/bootstrap state tied to the old implementation;
- guest repository/workspace materialization.

Then invoke only the supported DevBridge entry surface.

Required result:

1. PE resolves one exact runner subject.
2. PE reacquires and verifies R.
3. R reconstructs/reconciles one exact AR generation.
4. AR recreates required services.
5. The same logical installation identity remains current.
6. Existing operator-approved configuration remains authoritative.
7. Environment desired state is observed rather than recreated from provider residue.
8. Exact approved base image is reacquired and provider-validated.
9. One new provider implementation generation is created.
10. Guest/bridge identity is newly established where implementation identity must rotate.
11. Declared bootstrap/tooling becomes ready.
12. Workspace routes/roots are recreated.
13. Workspace source is reseeded from host-authoritative repository state.
14. DB-020 readiness becomes healthy.
15. A deterministic repository operation completes inside the VM.
16. No intermediate failure condition enables direct-host repository execution.

## Fresh-host qualification profile

A separate qualification proves that DevBridge does not confuse software reconstruction with authority reconstruction.

Precondition:

- PE installed and valid;
- no managed runner/runtime/services;
- no prior operator configuration/installation authority to recover;
- no DevBridge VM/image/workspace state.

Required result:

1. PE acquires/verifies R.
2. R installs/reconstructs a working AR.
3. AR enters supported first-run/guided setup.
4. Discovery is read-only until the operator approves authority-bearing choices.
5. DevBridge does not fabricate repositories, trusted actors, execution profiles, provider ownership, image generations, destructive policy, or credentials.
6. After setup establishes exact local authority, the same environment construction path used by normal lifecycle `create` is used to build execution infrastructure.

## Interrupted recovery qualification

Each boundary must also be tested with interruption after durable intent but before completion.

At minimum inject interruption during:

- runner acquisition/materialization;
- runtime candidate/materialization;
- runtime activation switch;
- service startup;
- base-image download;
- compressed-object assembly/decompression;
- provider storage creation;
- provider instance creation;
- guest enrollment;
- bootstrap/tooling application;
- workspace route publication;
- final readiness verification.

On restart, observe exact current state and continue/reconcile the same subject. Do not create a new generation or repeat an ambiguous effect merely because the previous process disappeared.

## Ownership boundaries during recovery

The combined recovery flow is orchestration, not a license to collapse LEGO modules.

- PE does not implement runtime update policy.
- R does not implement setup policy or VM construction.
- AR setup does not implement another provider lifecycle stack.
- Environment lifecycle does not acquire DevBridge application runtimes.
- Provider adapters do not read repositories or permanent-entry state.
- Guest/bootstrap helpers do not regain host Git/GitHub/provider authority.

The integration owner may sequence these capabilities, observe progress, and report the current blocker. It must not duplicate their mechanics.

## Completion rule

DevBridge application recovery is not complete merely because `devbridge` starts.

For a configured installation that requires repository execution, the whole-stack recovery path reaches terminal success only when:

- application runtime is accepted and healthy;
- required services are healthy;
- desired execution declaration is reconstructable;
- provider/image/resource prerequisites are ready;
- execution environment is materially present and exact-owned;
- guest enrollment/bootstrap/tooling is ready;
- workspace routing is ready;
- DB-020 VM-only repository execution completes a deterministic canary.

For a true fresh host without prior authority, terminal application bootstrap success is instead: a working accepted runtime reaches guided setup and refuses to invent missing authority.
