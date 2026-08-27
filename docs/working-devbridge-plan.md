# Working DevBridge implementation plan

Status: active dependency-ordered plan derived from `working-devbridge-assessment-2026-08-27.md`.

## Governing method

Each implementation slice follows:

`assess -> primary-source research -> reassess -> document -> plan -> implement -> test -> document implementation`

Every slice stays inside one coherent owner. A child LEGO uses only local neutral inputs/outputs; it does not name siblings, current callers, repositories, providers outside a provider adapter, or temporary topology. The parent composition owns wiring. No legacy compatibility path is added unless a live specification requires a bounded migration, and no migration path remains as a second production authority.

## Phase 0 — establish one truthful integration baseline

Owner: repository integration and documentation, not runtime behavior.

1. Preserve the dirty retired fast-track checkout untouched.
2. Use the isolated core-recovery branch rooted at PR #300 head.
3. Review and integrate PR #300 into its current integration target after exact-head checks remain green.
4. Merge the three unique current-main commits into the core-recovery branch.
5. Resolve documentation conflicts by current specification authority; preserve public entry-point tests and the accepted guest-runtime/chat-exchange designs.
6. Run preflight, architecture gates, focused changed-owner tests, full Windows tests, and doctor.
7. Publish the isolated branch and open/update an integration PR; do not update `main` directly.

Exit evidence:

- one exact candidate contains the recovery lineage plus all current-main changes;
- no GPU/CUDA/ROCm implementation is introduced;
- exact changed paths, tests, and remaining platform gates are documented.

## Phase 1 — close the Windows protected-authority gate

Owners: protected-authority reconciler and Windows platform adapter.

1. Run the latest exact candidate's ordinary, non-construction `devbridge setup` path.
2. Allow at most the one bounded platform elevation transaction already defined by #292 when reconciliation is required.
3. Require automatic return to the original ordinary process.
4. Prove service/runtime generation, service SID/token, read/mutation/acceptance pipe policy, ordinary mutation denial, direct protected-state denial, exact positive lifecycle canary, and exact fixture cleanup.
5. If candidate health fails, preserve rollback evidence and repair the smallest owning Windows adapter/reconciler seam; do not add another setup command or direct service workaround.
6. Record the exact physical evidence on #292/#177 and in repository testing documentation.

Exit evidence:

- one ordinary setup invocation reaches the read-only construction gate;
- ordinary identity lacks protected mutation/storage authority;
- exact protected lifecycle positive canary succeeds and cleans its owned fixture;
- no unprotected local-provider fallback exists.

## Phase 2 — reconcile the stalled Ubuntu production image construction

Owners: canonical image canary, Hyper-V image-construction adapter, and Ubuntu media/preparation adapters.

1. Re-observe the exact durable construction subject, provider identity, VM identity, attached media, disk growth, liveness, and console evidence.
2. Use the supported `setup --construct` re-entry only after Phase 1's ordinary setup gate passes.
3. Reconcile the existing effect before deciding whether it is still running, failed, or recoverably superseded.
4. Diagnose from bounded console/thumbnail and provider evidence. Do not send guest input or mutate media merely to make progress.
5. If replacement is required, create it through the existing canonical-image/lifecycle authority with a new exact subject only when desired media/recipe identity materially changes.
6. Finalize, sanitize, qualify, publish to the local immutable image library, and retire only exact superseded construction artifacts after the new image is verified.

Exit evidence:

- a qualified Ubuntu base-image generation exists locally;
- construction is restartable and reaches terminal journal state;
- signed source cache and exact recipe/package/payload identities are preserved;
- no stale running VM or orphaned exact-owned construction artifact remains after safe terminal cleanup.

## Phase 3 — finish Linux protected lifecycle authority

Owners: Linux authority plan/inspection/reconciliation/protection adapters.

1. Rebase the preserved #293 Linux slices onto the shared protected-authority reconciler from the synchronized core baseline.
2. Preserve the qualified read-only plan/inspection contracts unless primary evidence requires a change.
3. Add bounded reconciliation for exact system account/group, root-owned immutable runtime, service-owned mutable state, systemd unit, split socket parents, and service lifecycle.
4. Detect modular `virtqemud` versus legacy/proxy socket topology and locally supported authorization.
5. Prefer fine-grained service-only polkit/object policy where supported; otherwise require an explicitly proven service-only socket/group policy. Never add the ordinary operator/model identity to provider RW authority.
6. Preserve QEMU DAC and mandatory-access-control layers and exact qcow2/backing-chain ownership.
7. Qualify interruption/re-entry and arbitrary path/command/domain/XML/provider-object rejection in hosted tests.
8. Run real Linux negative and positive qcow2/domain canaries on a capable host before declaring Linux ready.

Exit evidence:

- Linux setup is one-command and resumable;
- ordinary identity lacks libvirt RW and backing-store mutation authority;
- protected authority can perform the exact lifecycle operation;
- unqualified Linux hosts fail closed without a local-provider fallback.

## Phase 4 — complete fresh-host install and image supply

Owners: image acquisition/cache, provider-specific image builders, setup authority, distribution, and activation adapters.

Order:

1. exact reconstructable image acquisition/cache (#178);
2. Ubuntu construction/publication completion (#197);
3. generalized Windows media construction with explicit operator media/licensing authority (#198);
4. protected Windows activation authority (#199);
5. private immutable image artifact distribution without developer-repository assumptions (#200);
6. blank-slate install, image-loss, rebuild, and re-entry qualification (#201).

Setup remains discover-first. Repository selection never provisions one VM per repository. Provider/image/profile decisions remain separate from repository/workspace approval.

## Phase 5 — complete permanent-entry and recovery composition

Owners: permanent entry, runner, accepted runtime, recovery control plane, and application manager.

1. Qualify a stable installed entry independent of a developer checkout.
2. Ensure stale runtime can reach the updater/recovery path without executing a candidate on the host.
3. Compose exact runner acquisition, signed/static recovery-control admission, candidate-validation environment reconstruction, DB-020 validation, accepted-runtime activation, LKG rollback, and service handoff.
4. Recreate declared execution profiles and workspaces only after accepted runtime authority is healthy.
5. Prove missing runtime + VM + image-cache recovery from retained durable local authority.

Exit evidence: one installed command recovers a configured installation without branch-specific/manual host surgery or candidate host execution.

## Phase 6 — Stage 7/8/9 qualification and product cleanup

1. Complete real Hyper-V and KVM/libvirt security, lineage, bridge, workspace, resource, cancellation, and recovery qualification (#115).
2. Complete guided setup/reconfiguration/repair/uninstall manifests for both host families (#116/#103).
3. Remove obsolete sandbox-era and repository-owned-VM migration scaffolding only after the new path is qualified (#117).
4. Resolve touched oversized parent LEGOs through the #244 nested-LEGO method where their reasoning seams are a demonstrated defect risk.
5. Close fixed issues; update partially satisfied issues with exact remaining evidence.

Cleanup rules:

- clean only exact DevBridge-owned provider objects after lifecycle re-observation;
- remove worktrees/branches only after their commits are merged, superseded, or durably preserved;
- never discard the operator's dirty fast-track config;
- remove stale remote development branches after confirming no open PR, unique unmerged commit, or current handoff depends on them;
- keep historical checksum-bound handoffs as evidence, not live authority.

## Phase 7 — working end-to-end DevBridge

After the lower gates are green:

1. configure approved task authors and repositories independently;
2. poll all configured repositories under the existing serialized admission/rate-budget contracts;
3. keep coding-model use opt-in only;
4. route UCI Arena work into an admitted compatible VM profile/workspace;
5. transfer source/candidate through the bounded bridge;
6. compile/test inside the guest;
7. import, verify, seal, and publish through host-authoritative Git;
8. prove daemon restart, pause, lease loss, baseline drift, and publication recovery.

Exit evidence: a real UCI Arena task completes through the supported installed entry without direct-host repository execution, manual VM surgery, or coding-model default fallback.

## Deferred GPU program

Issues #162, #186, and #283 remain deferred until Phases 0–7 establish recoverable, installable CPU profiles. No generic compute abstraction is built speculatively. Later GPU work begins with a real provider/guest feasibility canary and plugs into the same profile, lifecycle, bridge, evidence, and setup studs.

## Verification order for every slice

1. static/preflight and contract-shape checks;
2. focused owner tests including normal/failure/restart/boundary cases;
3. architecture/LEGO isolation gates;
4. relevant Windows and Ubuntu full suites;
5. doctor/readiness checks;
6. real provider qualification only when the slice claims OS/hypervisor behavior;
7. exact diff/status/remote-state reconciliation;
8. implementation and issue evidence update.

Passing mocks prove composition, not Hyper-V/libvirt enforcement. Expensive still-valid evidence is reused only when its exact candidate/provider/image/environment/policy identity remains valid.
