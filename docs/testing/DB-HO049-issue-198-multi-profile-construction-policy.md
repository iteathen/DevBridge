# DB-HO049 — issue #198 serialized multi-profile construction policy

Date: 2026-08-28
Branch: `stage8/362-protected-activity-channel`
Exact predecessor: `6e4abb67ad0a71faee2dac570d49279378770331`

## Assessment

Setup now has an accepted execution-profile selection and read-only construction observations for both current image profiles, but its one explicit `--construct` authority is hard-coded to Ubuntu. The Windows setup composition can derive the exact accepted media/tool/payload/recipe/resource authority and instantiate a canary, yet it exposes only `status` even though the canary already owns a restartable `run` operation.

Adding another Windows-named flag would create two permanent public mechanisms for the same local action. Expanding one invocation to advance both canaries would also be unsafe: it would cross two provider mutation frontiers, blur which durable result belongs to the invocation, and make liveness/recovery harder to explain.

The missing owner is a small serialized action-selection policy. It must decide which one of the already selected, already observed profiles is the next incomplete construction target. It must not learn provider objects, media paths, canary types, VM identities, repository identities, or commands.

## Governing review

Before planning, the current issue #198 body, DB-HO030, DB-HO045, DB-HO046, DB-HO048, DB-003, DB-009, DB-019, DB-020, `docs/fresh-host-image-provisioning.md`, `docs/vm-migration.md`, `docs/vm-lego-studs.md`, the setup CLI/coordinator, both physical-canary contracts, and the Windows setup composition were reviewed.

The controlling invariants are:

- plain setup remains observation-only at every physical construction gate;
- one explicit local `--construct` request grants only bounded construction intent for accepted profiles, not UAC, provider installation, media approval, activation, or host fallback;
- durable canaries observe/reconcile before each effect and retain exact subject state across re-entry;
- at most one selected profile construction frontier advances per setup invocation;
- a blocked earlier target is not skipped to mutate a later target;
- Windows media absence remains profile-local during ordinary Linux setup, but it is a focused blocker when an explicit construction request reaches Windows as its next target.

## Primary-source research

Microsoft's current documentation reinforces the existing canary lifecycle rather than requiring another mechanism:

- [Sysprep generalization](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/sysprep--generalize--a-windows-installation?view=windows-11) requires a reusable Windows installation to be generalized and shut down before capture, and documents `/mode:vm` for a VHD redeployed on the same hypervisor family.
- [Sysprep process overview](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/sysprep-process-overview?view=windows-11) states that Sysprep is administrator-only and single-instance. Construction must therefore remain a noninteractive guest-owned privileged phase, not a guest UAC workflow or a concurrently duplicated setup action.
- [Start-VM](https://learn.microsoft.com/en-us/powershell/module/hyper-v/start-vm?view=windowsserver2025-ps) is an explicit VM lifecycle effect. Setup must reach it only through the already owned physical-canary/provider composition after a fresh read-only gate; selection alone is not effect authority.

No new raw Hyper-V, Windows deployment, or guest command is needed in setup. The existing Windows physical canary remains the only construction owner.

## Reassessment

The smallest complete design is:

1. Keep the single public `--construct` option. Its meaning becomes “advance the next incomplete accepted profile construction,” which preserves the Linux-only workflow without retaining a separate legacy mode.
2. Put deterministic ordering in the application composition. Pass opaque identifiers and closed observations into an import-free serial action selector.
3. The selector returns only `ready`, `blocked`, or `complete` plus the selected opaque identifier and bounded reason. It performs no effect.
4. When both current profiles are selected, Linux is the first construction frontier and Windows is next. A setup invocation advances at most one.
5. Extend the Windows setup composition with a closed `observe|advance` action. `observe` calls only canary status; `advance` calls only the canary's existing run operation after accepted media is re-resolved.
6. Setup invokes `advance` only for the selector's exact target. It returns that target's bounded waiting/blocked/completed evidence without entering another profile's construction in the same invocation.
7. Windows environment activation remains a later gate. Completing the Windows base image must not be reported as a ready repository-execution environment.

## Dependency-ordered implementation plan

1. Add the import-free serial action selector with closed input, ordering, complete, blocked, missing-observation, and first-incomplete behavior.
2. Extend the Windows production setup composition with an explicit closed action while retaining a truly read-only default observation.
3. Reinterpret `--construct` against accepted profile selection: reject only empty/deferred selections, not Windows-only selection.
4. Attach construction observations in setup, invoke exactly one matching canary action, and project the active profile in bounded local status.
5. Update handoff text so Windows advancement is never mislabeled a read-only gate or Linux result.
6. Test ordinary zero-run behavior, Windows-only advance, both-profile ordering, blocked-target no-skip, one-frontier-per-invocation, restart-style re-entry, CLI constraints, source isolation, and no host/elevation invocation.
7. Run preflight and the complete suite, record exact evidence, commit/push, and update #198/#116. Physical media approval and construction remain unclaimed.

## No-UAC safety envelope

Implementation and tests in this checkpoint use injected canary/setup ports only. Do not run the installed setup command, a physical canary entry, Hyper-V mutation, media approval, lifecycle refresh, or any elevation path during the operator's three-day no-UAC window.

## Implementation

- `src/setup/serial-profile-action.js` is an import-free, topology-agnostic selector. It accepts only opaque profile identifiers plus closed complete/blocked observations and returns one bounded `ready`, `blocked`, or `complete` decision. Missing, foreign, duplicate, contradictory, widened, or unbounded input fails closed.
- `src/app/setup.js` owns the current topology mapping and fixed Linux-then-Windows order. Plain setup still invokes only observation ports. Explicit construction selects one target, invokes only that target's local action, returns immediately with its durable evidence, and never skips an earlier blocker.
- `src/app/windows-production-image-setup.js` exposes the closed local action `observe|advance`. Its default remains `observe`; `advance` delegates to the existing restartable physical canary and does not add provider commands or another construction implementation.
- CLI admission now permits Windows-only or combined construction and rejects empty/deferred selections. Public results identify the active profile without exposing media, provider, VM, path, or command authority.
- Setup handoff text reports the active profile and distinguishes a Windows construction result from an ordinary read-only Windows status gate.

## Verification

- Focused setup, construction, CLI, Windows composition, and LEGO tests: 79 passed, 0 failed.
- Repository preflight: 113 syntax files, 2 JSON files, and 106 targeted test files passed.
- Complete Windows repository suite: 1,598 total; 1,583 passed; 15 expected platform skips; 0 failed.
- The first complete-suite pass exposed one obsolete architecture assertion that required the former Linux-only branch expression. The assertion was updated to require the neutral selector and explicit one-target action, after which the focused set and complete suite passed.

No installed setup, media approval, elevation request, provider mutation, VM action, guest execution, or physical construction occurred. This is software evidence only; real Windows construction and both-guest acceptance remain open.
