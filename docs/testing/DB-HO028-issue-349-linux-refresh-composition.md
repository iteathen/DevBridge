# DB-HO028 — issue #349 exact Linux refresh composition

Status: implemented, qualified, and integrated into `cuda-target` from exact baseline `0b16e8b4e184efd8c8fc6fc6a219a7ba878db7a2`; physical Linux provider qualification and the explicitly deferred downstream work remain pending.

## Assessment

DB-HO027 completed the platform-local refresh mechanic that fits the shared protected-authority reconciler. The repository already has separately qualified Linux bricks for protected records, immutable numeric identity, generation staging and historical verification, volatile endpoint topology, exact unit-definition reconciliation, fixed service-manager actions, service observation, and the configured local authority client.

The remaining gap is topology, not another lifecycle algorithm. No production Linux composition currently projects the concrete bricks into DB-HO027's neutral `journal`, `transition`, `state`, `subjects`, `preparation`, `definition`, `activity`, and `probe` ports. Linux setup must therefore remain unavailable.

Two facts must be proved at this boundary rather than inferred:

- a unit file on disk can differ from the definition loaded by the service manager; and
- a successful service start does not prove that the application initialized its local protocol.

The current broad Linux inspector remains final-readiness evidence. It is deliberately not reused as the transition engine because doing so would collapse storage, identity, generation, endpoint, service, process, and health ownership into one permanent component.

## Primary research

Current systemd source documentation states that `Type=exec` waits until `fork()` and `execve()` succeed, but does not propagate failure from the service's own initialization code. It also documents definition refresh, enablement, start, and stop as distinct operations. `ReadWritePaths=` creates unit-specific writable exceptions but does not replace ordinary filesystem permission checks.

Linux procfs documents `/proc/<pid>/exe` as the kernel-reported pathname of the executed command, including an explicit ` (deleted)` marker when the pathname was unlinked. Node 22 documents `net.createConnection(path)` as the Unix-domain IPC client surface. These facts support separate configured-definition, running-executable, numeric-process-identity, and application-protocol evidence.

Primary sources:

- [systemd service units](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml)
- [systemd execution environment](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml)
- [systemctl operations](https://github.com/systemd/systemd/blob/main/man/systemctl.xml)
- [Linux `/proc/<pid>/exe`](https://man7.org/linux/man-pages/man5/proc_pid_exe.5.html)
- [Node.js 22 `node:net`](https://nodejs.org/download/release/v22.5.1/docs/api/net.html)

## Reassessment and selected boundary

Implement one Linux-only composition root. It may know the local Linux plan because topology is its sole responsibility, but every value handed to DB-HO027 is projected into that mechanic's neutral closed contract. No protected-record, manifest, service-observation, process-status, client, plan, filesystem, or manager object crosses the stud unchanged.

The composition will:

1. construct one record store using the shared journal normalizer and an explicit local claim-admission port;
2. project the ownership record to and from neutral bound active/staged/retained state without changing immutable identity evidence;
3. project only an exact pending shared effect into the neutral transition record;
4. discover a bounded generation catalog, reject foreign names and undeclared installed generations, load self-describing manifests, and reuse exact historical verification;
5. stage only the measured candidate through the existing protected-tree installer;
6. reconcile identity, exact protected writable state, and volatile endpoint topology before definition activation;
7. select configured generation from exact admitted unit bytes, require exact loaded unit identity with no drop-ins, and select running generation from `/proc/<MainPID>/exe` plus immutable numeric process identity/group evidence;
8. quiesce and activate only the selected exact generation through the fixed service manager;
9. reconcile the exact selected unit while admitting only the explicitly supplied prior definition; and
10. run bounded local client inspection after activation and require the `devbridge/environment-operator-v1` protocol.

The generation and activity projections will remain small read-only owners if keeping those proofs inline would make the composition root algorithmic. Their interfaces use only neutral subjects, definitions, executable identities, activity, and bounded evidence.

No compatibility reader will be added. There is no production Linux protected-generation format to preserve. Missing, malformed, foreign, extra, symlinked, aliased, or unverifiable state blocks.

## Writable-state finding

The generated unit currently grants writable mount exceptions only for the protected authority state, the exact ordinary coordination directory, and the two volatile endpoint directories. That is appropriately narrower than the whole ordinary DevBridge state root and must not be widened in this slice.

The protected environment runtime's lifecycle fence still addresses the ordinary daemon lock in the state root. It is harmless for read-only health inspection and for lifecycle work when no daemon lock exists, but it cannot safely coordinate with a running ordinary daemon through the current unit boundary. Broadening `ReadWritePaths` to the state root would grant excessive authority. Production client cutover therefore remains blocked until a separately owned narrow governance handoff or equivalent exact control surface is implemented and qualified. This issue records that blocker; it does not conceal it or weaken the unit.

## Plan

1. Add strict projections for ownership state, pending transition, installed generation subjects, unit/process activity, effect evidence, and bounded health results.
2. Compose record storage with explicit claim admission and shared journal normalization.
3. Compose candidate staging and historical generation verification through the existing protected-tree ports; add bounded catalog observation needed to reject undeclared state.
4. Compose identity binding, exact authority-state directory preparation, and endpoint topology without provider or setup identities.
5. Compose definition publication/refresh/enablement and exact activity stop/start actions.
6. Compose bounded local protocol health retries independently of `systemctl start` success.
7. Prove fresh install, no-op, refresh, rollback, interruption replay, foreign/extra generation, foreign definition/drop-in, configured/running mismatch, process identity mismatch, health failure, and interface/source isolation.
8. Add focused qualification to preflight, then run related Linux/shared/Windows tests, architecture gates, the full suite, and doctor.
9. Publish only this isolated branch, require exact-head Ubuntu and Windows CI, integrate only after evidence, close #349, and leave parent #293 open for one-command elevation, governance cutover, provider authority, and physical libvirt/qcow2 qualification.

## Explicitly deferred

This slice does not attach setup or sudo elevation, change daemon governance, authorize libvirt, inspect or mutate qcow2, execute a VM, switch the production client, claim Linux readiness, touch GPU/CUDA behavior, or clean arbitrary state.

## Implementation

The implementation adds `linux-lifecycle-authority-refresh-composition.js` as the Linux-only topology root for the already qualified neutral refresh mechanic. It projects concrete records and effects into closed local contracts rather than teaching the mechanic about Linux, systemd, procfs, paths, accounts, endpoints, or runtime manifests.

The composition now:

- establishes the protected ownership claim through an explicit idempotent record-store port before immutable numeric identity binding;
- discovers at most eleven exact generation names, loads self-describing manifests under the protected file policy, and reuses the qualified generation/tree verifiers;
- reports undeclared installed generations as inexact and stages only the measured candidate;
- reconciles the exact protected writable directory, narrow ordinary coordination directory, and volatile endpoint topology without provider authority;
- identifies configured generation only from exact admitted root-owned unit bytes and identifies running generation only from the loaded unit identity, immutable process UID/GID/groups, and `/proc/<MainPID>/exe`;
- rejects foreign drop-ins, definitions, process identity, executable identity, unavailable effect subjects, duplicate subjects, unknown request fields, and unknown injected ports;
- publishes, reloads, and enables only an exact selected definition while admitting no more than the exact previous definition during refresh or restoration; and
- retries the configured local IPC health client on the bounded `100`, `250`, `500`, `1000`, and `2000` millisecond schedule, accepting only the exact environment-operator protocol.

The record owner exposes only one new operation, `claim.ensure()`. Its focused test proves first establishment, one admission, no refresh-journal creation, and an effect-free second call. Preflight now includes the new composition source and focused tests.

Shared refresh-mechanic tests remain the owners of the platform-neutral refresh, rollback, interruption, and recovery algorithms. The composition tests prove the Linux projections and a complete fresh/no-op reconciliation through that same mechanic rather than duplicating its state machine.

## Local qualification

Qualification on Windows from the isolated branch completed with:

- focused records and composition tests: 14 passed, 0 failed;
- repository preflight: passed with 50 syntax files, 2 JSON files, and 50 targeted test files;
- architecture-gate selection: 33 passed, 1 expected Windows symlink skip, 0 failed;
- Linux/shared selection: 160 passed, 4 expected platform skips, 0 failed;
- final full repository suite after review fixes: 1,308 tests, 1,297 passed, 11 expected platform skips, 0 failed; and
- doctor: exited successfully and correctly reported repository execution unavailable because no local persistent-environment route or constructed base image is configured.

This is software qualification of the composition boundary, not physical Linux provider evidence. Real libvirt/qcow2 construction, service installation, refresh, rollback, and host-fallback-negative qualification remain required before Linux readiness or Stage 7 can be claimed.

## Remote qualification and integration evidence

Pull request [#350](https://github.com/iteathen/DevBridge/pull/350) reviewed exact topic head `66928d80632fdf5bd60ee76eff1c4c2454def633` and targeted `cuda-target`.

GitHub Actions run [33138709514](https://github.com/iteathen/DevBridge/actions/runs/33138709514) completed successfully on that exact reviewed head:

- Ubuntu smoke job `98744478982`: passed;
- Windows smoke job `98744479038`: passed;
- Ubuntu architecture gates, full tests, and doctor job `98744479023`: passed; and
- Windows architecture gates, full tests, and doctor job `98744478899`: passed.

The PR was squash-merged as `08667af36746dea8e7df2f13efbec7c59553fdae`. The reviewed topic and integrated commit both resolve to tree `15def231d913e6b6c91a0d3f442bc1705c3b3f61`; an exact tree diff is empty. This binds the integrated bytes to the reviewed and remotely qualified bytes despite the expected squash-commit identity change.
