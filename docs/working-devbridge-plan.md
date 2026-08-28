# Working DevBridge implementation plan

Status: active dependency-ordered plan derived from `working-devbridge-assessment-2026-08-27.md`. Phase 0 and the Phase 1 physical gate are complete. Exact v7 Hyper-V construction proved the SSH/package correction was present but stopped earlier when the live installer faulted in layered OverlayFS extraction; Phase 2 now owns the immutable single-image replacement.

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
3. Repair the provider-local thumbnail normalization defect before making any VM recovery decision:
   - preserve the neutral `captureInstallConsole()` result contract;
   - accept the documented exact RGB565 byte count and the physically observed exact four-terminal-byte variant only;
   - retain the first `width * height * 2` bytes for the observed variant and reject other counts;
   - do not interpret image pixels as width/height metadata;
   - add executable normal, exact-variant, malformed-count, and output-boundary tests rather than regex-only source assertions.
4. Re-run non-construction setup on the exact candidate, then make one supported construction re-entry and require a valid bounded console artifact without changing VM state.
5. Treat steps 3–4 as complete at exact merge `4d5dc5633d978773a3adf02414acbc4234076ca6`; the artifact proves the existing guest failed in the pinned apt late command.
6. Reproduce the exact snapshot transaction in a disposable Ubuntu 26.04 environment outside the production construction frontier (complete):
   - first run snapshot update;
   - then simulate, download, and install the exact six pinned packages;
   - preserve complete bounded apt output and exact base/snapshot identity;
   - remove the temporary diagnostic workflow after evidence is captured.
7. Treat the v5 source-wide `APT::Snapshot` design as rejected physical evidence. Its exact replacement subject failed in Curtin curthooks while installing UEFI boot prerequisites, before Subiquity's update or DevBridge's late-command phases.
8. Preserve Curtin's native prerequisite APT behavior. Use the installer APT pass-through only for a narrow all-package unattended-upgrades blacklist, which is ignored by ordinary apt operations and removed by Subiquity's existing restore step before late commands.
9. Keep the explicit DevBridge-owned snapshot update/install transaction after restore. Make every snapshot metadata refresh fail on any source error; do not treat stale or live-archive indexes as snapshot evidence.
10. Preserve the required security baseline deliberately under the same accepted snapshot. Resolve final top-level candidates across every enabled release/update/security pocket using Debian's specified version ordering, run a no-removal snapshot-bound upgrade before the exact package installation, and require final exact-version qualification.
11. Prove the comparator against dpkg on Ubuntu CI, prove pocket conflicts and missing/oversized index failures locally, and prove that the emitted command order is blacklist -> restore boundary -> exact update -> bounded upgrade -> exact install.
12. Do not add a CA bootstrap stage merely because the minimal diagnostic container lacked it: the physical server target already completed its HTTPS snapshot update. Reassess only if the next exact construction subject produces contrary target evidence.
13. Keep executable/package paths and solver mechanics local and preserve neutral authority/seed contracts. Add bounded installer failure telemetry only through the seed owner's static contract; never expose host secrets or accept caller-supplied commands/paths.
14. Advance the recipe/package generation for every desired guest-byte or install-behavior change, deriving a new exact construction subject rather than reusing either failed media subject.
15. Treat the v6 physical construction as rejected access evidence: it reached an operating installed boot with healthy provider integration and DHCP, while its exact seed disabled SSH installation and its package authority omitted `openssh-server`.
16. In the Ubuntu image owner, enable key-only target SSH installation, resolve and qualify `openssh-server` through the existing exact snapshot package contract, and advance recipe, package, and output generations. Do not repair the guest or add a provider/network fallback.
17. Add focused tests for seed SSH policy, exact package selection, qualification projection, and immutable generation changes. Run preflight, full Windows tests, and all Ubuntu/Windows CI jobs before another protected-runtime install.
18. Follow with a neutral bounded readiness-observation slice: consume elapsed time and a local clock, classify two minutes as the expected frontier and ten minutes as the hard deadline, schedule non-terminal observations at no more than 30 seconds, and block after expiry without repair. Do not expose transport/provider identity through that contract.
19. Reconcile the existing failed effect, create the replacement through the canonical image/lifecycle authority, and retain old subjects until the replacement is qualified.
20. Treat the exact v7 physical subject as rejected installer evidence: the running VM advanced its VHDX, then hit a kernel fault in `ovl_iterate_merged` during Curtin `stage-extract`; the existing twenty-minute no-progress gate captured console evidence and stopped without repair.
21. Select Canonical's supported `ubuntu-server-minimal` source in the Ubuntu seed owner. This exact source is a single `fsimage`, while the default server source is `fsimage-layered`; preserve every other package/network/access/payload/qualification boundary and do not add kernel flags or retry the failed guest.
22. Advance recipe and output generations so the source-selection change derives a new subject. Prove emitted source selection, authority subject change, topology rejection, preflight, full local tests, and all four hosted jobs before another physical construction.
23. Treat the v8 access result as rejected host-key-binding evidence: installation and installed boot succeeded, but strict verification proved cloud-init replaced the subject-owned expected key. Preserve the failed subject and never learn the replacement key into host trust.
24. In the Ubuntu seed owner, project the exact Ed25519 pair through target `user-data.ssh_keys` with deletion of inherited image keys retained, and remove ordinary host-key `write_files` entries. Keep the access/probe/provider contracts unchanged.
25. Advance recipe/output generations, prove the exact SSH-module projection and immutable subject change, and repeat the complete software/CI/install gates before a fresh physical subject.
26. Treat the exact v9 result as rejected bridge-state-root evidence: installation, installed boot, strict subject-owned host-key verification, and bridge entry all succeeded, but the unprivileged guest identity correctly received `EACCES` when the bridge agent tried to create `/var/lib/devbridge`.
27. Move the bridge agent's Linux default into its own persistent per-user XDG state root, preserving its explicit override and Windows default. Reject relative roots, keep module import side-effect-free, and do not add sudo, broader access identity, image-seed directory ownership, provider inputs, or legacy-path migration.
28. Update whole-image sanitization to remove the neutral user-state root, advance recipe/output generations, and prove root selection, override, platform behavior, import isolation, sanitizer projection, immutable subject change, and existing bridge boundaries before full local/hosted verification.
29. Install only the exact accepted runtime and construct one fresh immutable subject through the public gate. Preserve the v9 VM/disk/journal as physical failure evidence until replacement qualification is terminal.
30. Finalize, sanitize, qualify, publish to the local immutable image library, and retire only exact superseded construction artifacts after the new image is verified.

Software checkpoint: steps 16–18 are implemented. Fifty-one focused tests, repository preflight with 39 targeted tests, and the complete 1,223-test Windows suite passed with zero failures. PR #319 passed all four Ubuntu/Windows smoke and full jobs in CI run `33124150724` and merged at exact recovery commit `9925905622d31caa985c27a47c18ebf817748feb`. Exact v7 physical construction then produced the bounded OverlayFS failure evidence recorded in `docs/testing/DB-HO005-issue-197-physical-qualification.md`. Steps 21–22 are complete: 41 focused tests, preflight with 50 targeted tests, the complete 1,330-pass local suite, and all four hosted jobs in CI run `33144784604` passed with zero failures; PR #354 merged at exact accepted commit `041ebd4cb364c8141cfedc1b84c1902c90bd0423`, and the zero-state bootstrap installed that exact component. Fresh v8 subject `subject-a527ba4de198188473c3f22c7f4778af` completed installation and reached installed SSH, then blocked after the exact ten-minute window because cloud-init replaced the subject-owned host key. Steps 24–25 are complete: the same local gates and all four hosted jobs in CI run `33146383449` passed, PR #355 merged at exact accepted commit `452565fa931d7a0e04849b3e32a7f6c60e003483`, and the zero-state bootstrap installed that exact component. Fresh v9 subject `subject-1a3e4a19173f0f6c75fd0758e287bcaf` physically accepted the host key, then failed closed in guest qualification because the bridge agent's Linux default required privilege to create `/var/lib/devbridge`. Steps 27–29 and the local qualification/publication portion of step 30 are complete: 58 focused tests, preflight with 50 targeted tests, the complete 1,332-pass suite, all four hosted jobs in CI run `33148218419`, exact accepted-runtime installation, and physical v10 subject `subject-8a7a9afe109534b2c128f272ab586bcf` all passed. The terminal revision-12 journal binds a qualified parentless `ubuntu-2604-production-v5` VHDX in the local immutable image library. Exact-subject cleanup of older failed construction artifacts remains pending behind a supported lifecycle surface; no manual deletion is authorized.

Exit evidence:

- a qualified Ubuntu base-image generation exists locally;
- construction is restartable and reaches terminal journal state;
- signed source cache and exact recipe/package/payload identities are preserved;
- no stale running VM or orphaned exact-owned construction artifact remains after safe terminal cleanup.

## Phase 3 — finish Linux protected lifecycle authority

Owners: Linux authority plan/inspection/reconciliation/protection adapters.

1. Rebase the preserved #293 Linux slices onto the shared protected-authority reconciler from the synchronized core baseline.
2. Preserve the qualified neutral identity and provider-free service-entry contracts, but correct the primary-source discrepancies recorded in `docs/testing/DB-HO010-issue-293-linux-authority-reassessment.md`: use `Type=exec`, make the read socket parent service-writable/group-traversable (`0750`), use NSS-aware account/group evidence plus actual process groups, and prove the complete content-addressed runtime generation.
3. Add bounded reconciliation for exact system account/group, root-owned immutable runtime, service-owned mutable state, systemd unit, split socket parents, and service lifecycle.
4. Detect modular `virtqemud` versus legacy/proxy socket topology and locally supported authorization. The first supported `service-group` adapter must prove every effective endpoint and fail closed on wide/polkit topology until exact policy evidence is implemented; it must not select the first socket path that exists.
5. Prefer fine-grained service-only polkit/object policy where supported; otherwise require an explicitly proven service-only socket/group policy. Never add the ordinary operator/model identity to provider RW authority.
6. Preserve QEMU DAC and mandatory-access-control layers and exact qcow2/backing-chain ownership.
7. Qualify interruption/re-entry and arbitrary path/command/domain/XML/provider-object rejection in hosted tests.
8. Run real Linux negative and positive qcow2/domain canaries on a capable host before declaring Linux ready.

Hosted checkpoint: the corrected plan/service entry, read-only NSS/systemd/process/runtime inspection, and shared refresh adapter are implemented and locally qualified on `security/293-linux-authority-recovery`; see `docs/testing/DB-HO010-issue-293-linux-authority-reassessment.md`. No privileged Linux mutation or readiness composition is attached. Steps 3–8 remain active work.

Protected-mechanics checkpoint: DB-HO011 records the exact name/numeric-identity ownership model, atomic generation/unit contract, append-only ordinary membership, exact service membership, and provider-separation plan for the next isolated slice.

Protected-storage checkpoint: DB-HO012 is integrated at `bcfae330cb223ed7705feff888bd9c9690c137e4`; all four CI jobs passed and Ubuntu exercised the real-filesystem canary. DB-HO013 now scopes the next dependency to admitted lifecycle claim plus ownership/transaction persistence, with no account, service, provider, VM, or runtime mutation.

Protected-transfer checkpoint: DB-HO013 is integrated at `f1f0400f7087a9ea81f69bb68b0d16c1af9b2524`. DB-HO015 is integrated at `f9d410f5399bb2def945179ae93dfc8c47fdacfa`: descriptor-bound streamed transfer preserves the 1 MiB record boundary, uses a separate bounded streaming contract, and passed all four hosted jobs including its real Linux canary.

Protected-tree checkpoint: DB-HO015 is integrated at `f9d410f5399bb2def945179ae93dfc8c47fdacfa`, with all four CI jobs green and the Ubuntu real-filesystem canary passing. DB-HO016 isolates immutable tree installation behind neutral relative-path and file contracts; lifecycle generation projection composes it only after this lower transaction is independently qualified.

Protected-storage checkpoint: DB-HO012 isolates normalized no-follow directory/file policy, bounded atomic replacement, file and parent-directory durability, and exact pending-file recovery before lifecycle records or runtime staging consume that capability.

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

Protected-profile checkpoint 2026-08-28: `docs/testing/DB-HO035-issue-360-protected-profile-configuration.md` records the bounded accepted-configuration and declaration-CAS slice. Setup projects stable subjects into neutral desired declarations; the elevated child verifies/adopts the exact protected image, reconciles and re-observes its foundation resources, and registers by revision; the ordinary read client proves the declaration digest and consumes only aggregate protected readiness. The full repository suite and candidate preflight pass; physical activation is pending. Issue #364 and `docs/testing/DB-HO038-issue-364-conflict-retirement.md` replace the former ad hoc NAT prerequisite with setup discovery, opaque exact-subject consent, elevated re-observation, and retirement through the existing one-shot protected transaction.

Protected-activation checkpoint 2026-08-28: `docs/testing/DB-HO036-issue-360-protected-environment-activation.md` adds the provider-free setup activation adapter and corrects public setup ordering. Only an exact absent environment or interrupted create crosses the protected lifecycle client; final healthy status is independently re-read, and the existing construction workspace stage verifies roots before publishing credential-free routes. Incomplete images return before protected configuration/environment mutation. Focused gates, candidate preflight, and the complete 1,467-pass repository suite are green. The #364 setup-owned conflict flow is now the physical entry to UAC activation; the Linux fixed-source C canary and operational configuration/execution opt-in remain after that live route proof.

Operational-configuration assessment 2026-08-28: `docs/testing/DB-HO039-issue-360-operational-configuration.md` records the remaining gap between verified protected routes and a usable normal runtime. The planned publisher is setup-owned, deterministic, digest-bound, restart-reconcilable, refuses unmanaged config drift, enables controller-plan execution only after route readiness, and keeps coding-model adapters/direct-host fallback disabled. This work may proceed without provider mutation while the physical UAC gate waits.

Multiple-queue checkpoint 2026-08-28: `docs/testing/DB-HO037-issue-363-multiple-queue-runtime.md` replaces the false singular operational queue with one ordered collection. Credential, conditional-request, mutation-pacing, and rate-budget authority are shared once; queue runtimes retain isolated run/lease/status/handoff state and execute serially under one daemon admission. Ordinary queue failures are isolated, shared rate-limit evidence stops globally, and no singular compatibility path remains. This enables setup to publish every accepted repository later without multiplying daemons or execution concurrency. It does not delay the physical VM frontier further: protected setup and the Linux/Windows C canaries remain next.

### Windows critical-path checkpoint

Ubuntu v10 is admitted, but DevBridge is not minimally functional until the real Windows image and dual-guest C route pass. The Windows work now proceeds without another broad infrastructure detour:

1. bind approved local Microsoft media to exact integrity and edition/build metadata;
2. implement unattended Setup -> Audit Mode -> pinned tool provisioning -> qualification -> sanitation -> Sysprep shutdown;
3. replace the current Hyper-V Secure-Boot-off assumption with a neutral protected-boot requirement mapped locally to supported Windows 11 Secure Boot/vTPM settings in both construction and persistent environments;
4. establish fresh per-environment Windows enrollment plus a distinct non-administrative routine execution identity;
5. admit the generalized VHDX and materialize the persistent Windows profile;
6. run the exact Windows+Ubuntu C transfer/compile/execute/result proof, then repeat it across normal restart/reuse.

Interactive Windows Setup pages, installer UI, guest UAC prompts, credential prompts, and GUI babysitting are failures, not supported continuations. Construction privilege exists only in documented unattended setup/audit passes. Routine repository work is noninteractive and non-administrative. Exact assessment, Microsoft source research, ownership seams, and the primitive plan are recorded in `docs/testing/DB-HO030-issue-198-windows-construction-assessment.md`.

Checkpoint 2026-08-28: bricks 1–4 and the restartable physical-canary composition are implemented and pass repository preflight/focused tests. The host read-only gate proves Hyper-V protected-boot operations, IMAPI, managed connectivity, memory, and the declared sparse-allocation storage budget without UAC. A supply-chain reassessment replaced the insufficient bootstrapper-only compiler claim: the authority now binds Microsoft's fixed Build Tools `17.14.39` artifact, requires installed build `17.14.37614.0`, explicitly selects compiler/CMake/Windows SDK components, disables installer self-update, and rejects version drift during both preparation and qualification. The exact remaining external input is approved official Windows ISO media; bounded discovery currently finds none. No image, persistent Windows profile, or dual-guest C acceptance is claimed yet. Continue at the media inventory/approval frontier rather than reopening lower-level topology work.

Persistent-access reassessment 2026-08-28: `docs/testing/DB-HO040-issue-198-windows-persistent-access.md` records one prerequisite exposed before physical activation. The generalized image contains a fixed LocalSystem access-seed service and non-admin account policy, but the protected environment runtime does not yet compose per-environment Windows credential creation, exact seed delivery, strict PowerShell Direct re-observation, or the resulting routine connection. Implement that Windows-owned adapter before multi-profile setup; construction Administrator material must never become repository execution authority.

Persistent-access implementation checkpoint 2026-08-28: the Windows-owned adapter is implemented with fixed `devbridge` material, exact transient seed cleanup, provider-owned PowerShell Direct proof, and default protected-runtime composition. The unused injected-access compatibility path is deleted. Focused tests and repository preflight pass. One unrelated liveness test failed only during the first concurrent complete-suite run and passed in isolation; the clean complete-suite repeat then passed 1,529 total / 1,514 passed / 15 platform skips / zero failures. Commit this checkpoint and resume physical activation.

Multi-profile route assessment 2026-08-28: `docs/testing/DB-HO041-issue-360-multi-profile-route-admission.md` records a dual-guest blocker found while UAC activation waits. Construction currently leaves every route non-preferred and verifies a subject's preferred route rather than the exact subject/profile route being admitted. Preserve first-admitted preference and bind pre-publication verification to the exact derived workspace target before attempting a second guest profile.

Multi-profile route implementation checkpoint 2026-08-28: first-admitted preference is now stable, sole non-preferred policy is normalized only when topology expands, ambiguous existing topology fails closed, and health/put/execute proof binds to the exact subject/profile workspace before policy publication. Focused 21/21, preflight, and the complete 1,531-total / 1,516-pass / 15-skip / zero-failure suite are green. Commit this primitive, then resume the UAC-gated physical Linux activation without changing its accepted image or profile.

Physical conflict reassessment 2026-08-28: the approved one-shot host elevation refreshed the protected runtime and retired the exact stale translation, then failed closed on a separate unmarked deterministic target switch left by an earlier partial attempt. Extend the existing neutral conflict stud with one provider-local, exact-subject retirement for an unattached internal switch with only link-local address state. Never stamp/adopt the unmarked object from planned state alone. Test and push this correction before spending the final available UAC transaction.

Partial-switch implementation checkpoint 2026-08-28: the unchanged neutral conflict stud now classifies an exact unmarked target switch only when it is internal, guest-unattached, and has no configured non-link-local IPv4 state. Subject-bound re-observation/removal remains inside the one-shot elevated child. A live read-only probe produced subject `00dbc6dd7feff1861a435eb45c715739819ce3d1ec75e044bc50919e9d8b67ef`; focused 18/18, preflight 99/2/95, and full 1,541-total / 1,526-pass / 15-skip / zero-failure evidence are green. Commit and push before requesting the last available UAC transaction.

Physical switch-consent checkpoint 2026-08-28: `dc60348` is pushed and the exact consent is persisted, but the final announced host elevation was cancelled/refused before the child transaction began. Re-observation proves no partial second effect: the refreshed protected service remains running, no NAT exists, the target switch remains unchanged/unmarked, and no persistent VM exists. Do not request another UAC during the operator's stated three-day unavailable window. Continue no-elevation acceptance/tooling work and later resume with the exact saved subject.

Deterministic C acceptance assessment 2026-08-28: `docs/testing/DB-HO042-issue-360-c-route-acceptance.md` replaces the unsuitable self-materializing diagnostic idea with one normalized, all-ephemeral controller plan. It uses only registered CMake/CTest operations, an exact stdout challenge, target-aware SHA-256 reporting, empty changed paths, and verified scratch cleanup. Implement the fixed verbose CTest evidence option and plan factory while host elevation is unavailable; physical route proof remains separate and unclaimed.

Deterministic C acceptance implementation checkpoint 2026-08-28: the normalized plan factory and closed optional verbose CTest result channel are implemented. Focused tests pass 9/9 and repository preflight passes 100 syntax files, 2 JSON files, and 96 targeted test files. The first complete-suite run had one unrelated transient Windows temporary-file `EPERM`; its owning daemon-governance suite immediately passed 6/6, and a fresh complete-suite run passed 1,529 with 15 platform skips and 0 failures. The exact physical setup re-entry was then approved: protected reconciliation crossed the saved partial-switch frontier and started one exact Linux installer VM. Subsequent ordinary bounded observations show healthy provider status and advancing VHDX allocation; no second UAC has been requested.

Canonical payload reassessment 2026-08-28: the Linux installer subsequently completed guest qualification and finalization, but immutable publication correctly refused different bytes under existing output generation `ubuntu-2604-production-v5`. `docs/testing/DB-HO043-issue-197-canonical-payload-text.md` proves the new authority was accidental CRLF/LF source-delivery drift: current `i/lf w/crlf` payload members normalize to exact accepted generation `guest-image-688e4295403761cf5ae78fd1`. Fix the payload owner to canonical LF with bare-CR refusal; do not bump the release, overwrite the accepted image, edit journals/catalogs, or delete the retained failed subject.

Canonical payload implementation checkpoint 2026-08-28: canonical LF derivation and bare-CR refusal are implemented at the self-contained payload boundary. The current Windows checkout now reproduces exact accepted payload generation `guest-image-688e4295403761cf5ae78fd1`. Focused tests pass 52/52, preflight passes 101 syntax files + 2 JSON files + 97 targeted test files, and the complete suite passes 1,531 with 15 platform skips and 0 failures. The qualified/finalized colliding VHDX remains exact retained evidence; the accepted image/catalog are unchanged and no construction VM remains. The operator has declared no UAC available for three days, so do not launch elevation or bypass protected-runtime freshness. Publish this fix and continue no-elevation work; resume exact one-command refresh/re-entry only when the operator returns.

Acceptance-isolation reassessment 2026-08-28: `docs/testing/DB-HO044-issue-360-ephemeral-parent-cleanup.md` records why root `CMakeLists.txt`/`main.c` is not portable to arbitrary configured repositories. Extend the generic controller-plan cleanup ledger to own only parent directories observed absent before ephemeral writes, then remove them exactly, deepest-first and non-recursively after files. Use that primitive to place the C fixture under a challenge-derived directory and validate the complete ordinary task envelope. Do not add a special compiler path or acceptance bypass.

Acceptance-isolation implementation checkpoint 2026-08-28: the generic executor now durably owns only absent-before-effect ephemeral parents, cleans files before deepest exact directories, preserves pre-existing parents, and fails closed without recursive deletion when unexpected content appears. The challenge-derived C proposal traverses the ordinary `devbridge/task-v1` parser with no coding-tool selection. Focused tests pass 21/21, preflight passes 102 syntax files + 2 JSON files + 98 targeted test files, and the complete suite passes 1,534 with 15 platform skips and 0 failures. Publish this no-elevation checkpoint; physical guest proof remains pending and no UAC may be requested for three days.

Windows-media setup reassessment 2026-08-28: `docs/testing/DB-HO045-issue-198-windows-media-setup-intake.md` records the missing public seam between the existing Windows media inspector/authority and setup. Implement bounded local discovery through opaque source references, a path-free inventory candidate, exact re-observation at explicit approval, immutable catalog registration, and fixed official acquisition handoffs when no source exists. Do not silently download or select Evaluation, do not persist source paths in generic profile/route policy, and do not let Windows media absence block the independently usable Linux profile. This checkpoint must remain entirely non-elevated.

Windows-media setup implementation checkpoint 2026-08-28: the public setup seam now discovers bounded real ISO sources, exposes path-free inventory choices, requires a separate exact candidate/image/source-class approval, re-observes before immutable catalog registration, and keeps accepted source resolution observational. Stale accepted media is reconciled back to selection without deleting catalog evidence. Remote setup status exposes counts and bounded accepted-image facts but no local path/source/candidate/authority/media identity. Preflight passes 107 syntax files + 2 JSON files + 101 targeted test files; the complete suite passes 1,568 total / 1,553 passed / 15 platform skips / zero failures. Publish this non-elevated checkpoint and update issue #198; physical media approval, Windows construction, and both-guest C proof remain pending, with no UAC request for three days.

Windows construction setup-observation reassessment 2026-08-28: `docs/testing/DB-HO046-issue-198-windows-construction-setup-observation.md` records the remaining manual-config seam between accepted media and the existing physical canary. Compose the exact setup-owned authority/resource config and expose only canary `status` beside the Windows media state. Keep blockers profile-local, do not widen Linux `--construct`, and add no Windows mutation/elevation surface during the no-UAC window.

Windows construction setup-observation implementation checkpoint 2026-08-28: accepted media now resolves observationally into one fixed Windows production authority/resource config, and public setup exposes the existing physical canary status without any `run` path. Windows preflight blockers remain profile-local; remote status removes source/candidate/authority/image/provider paths while retaining bounded readiness facts. Preflight passes 108 syntax files + 2 JSON files + 102 targeted test files; the complete suite passes 1,574 total / 1,559 passed / 15 platform skips / zero failures. Publish and update issue #198. The explicit multi-profile construction mutation policy, real media, UAC-gated provider action, and physical qualification remain pending.

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

### Minimal non-CUDA functional acceptance

The first product-level vertical slice deliberately uses trivial application logic so the evidence measures DevBridge rather than the fixture:

1. Admit one fixed C source from a trusted remote task and bind it to the exact repository revision, route, profile, image, environment, workspace, bridge, and locally registered tool operations.
2. Transfer that source through the bounded bridge to one native Windows guest and one Linux guest.
3. Compile and execute inside each exact guest, never through a host compiler/process or coding-model fallback.
4. Return exit code zero, one exact bounded run-specific stdout challenge, compiler evidence, and executable digest through the result contract.
5. Keep GitHub credentials, provider-management authority, authoritative Git, and publication state host-only; a missing compiler, route, environment, bridge, or provider fails closed.
6. Repeat after normal reuse and daemon/service restart to prove persistent-environment and recovery behavior.

Passing both guest profiles on a Windows Hyper-V host establishes this minimal product slice on that host. It does not establish Linux-host provider equivalence: Stage 7 still requires the corresponding real KVM/libvirt route, security, storage-lineage, cancellation, and recovery evidence before cross-platform provider readiness is claimed.

### Baseline guest toolchain qualification

The C vertical slice proves the DevBridge pipeline; it is not the complete prepared-profile usability claim. Each supported Windows and Linux guest profile should also advertise and smoke-test a bounded baseline matrix:

- Node.js plus its standard package client, including the TypeScript path when present;
- Python plus its standard package/environment path;
- native C and C++ compiler/linker support;
- Rust plus Cargo;
- .NET SDK and C#;
- a JDK and the ordinary Java build path;
- Go;
- Git, CMake, Ninja and/or Make as appropriate to the guest; and
- the native noninteractive shell surface (PowerShell on Windows and POSIX shell tooling on Linux).

Qualification means exact in-guest inventory plus one tiny deterministic compile-or-run smoke for every capability the profile claims. It does not mean exhaustive language conformance testing, host-side compiler discovery, or a separate DevBridge adapter for each package ecosystem. Additional ecosystems such as Ruby or PHP remain demand-driven unless a declared profile or admitted repository requirement makes them part of the local contract. Tool additions still require pinned/acquired guest authority, bounded evidence, and no host-execution fallback.

## Deferred GPU program

Issues #162, #186, and #283 remain deferred until Phases 0–7 establish recoverable, installable CPU profiles. No generic compute abstraction is built speculatively. Later GPU work begins with a real provider/guest feasibility canary and plugs into the same profile, lifecycle, bridge, evidence, and setup studs.

The operator has supplied a candidate path to preserve for that later research gate:

- keep repository-controlled GPU execution VM-only and fail closed when the exact hardware profile is unavailable;
- model GPU/device/driver requirements as host-owned execution-profile policy, never repository-granted authority;
- evaluate first-class PCIe passthrough or mediated/SR-IOV assignment, with the physical device and DMA boundary proved per provider rather than assumed;
- keep compilation and artifact production in the admitted persistent workspace VM, while evaluating a separate disposable execution worker for tests that require resettable device state;
- compare a direct-passthrough VM path with a separately bounded NVIDIA `nvproxy`/gVisor path; do not combine them into one implicit topology or claim equivalent isolation;
- evaluate a narrow host-controlled guest transport such as `virtio-vsock`, read-only execution roots, and ephemeral writable state without exposing host credentials, paths, provider objects, or Git authority;
- treat binaries and PTX/SPIR-V transferred between environments as untrusted candidate artifacts bound to exact source, toolchain, driver, device, and verification identity;
- require teardown/reset, IOMMU grouping, peer-device, DMA, driver, firmware, bus-I/O, and hostile-pointer/memory-copy qualification before admitting low-level GPU tests.

This is a roadmap hypothesis, not an accepted security claim. Later assessment must use current primary NVIDIA, Linux VFIO/IOMMU, KVM/QEMU/libvirt, Hyper-V GPU-assignment/GPU-P, gVisor, and virtio-vsock sources and must explicitly separate Linux and Windows provider capabilities. No GPU implementation or host fallback is authorized by recording it here.

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
