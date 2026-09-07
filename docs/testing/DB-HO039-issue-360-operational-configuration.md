# DB-HO039 — issue #360 operational configuration activation

Status: assessment, research, reassessment, and dependency-ordered implementation plan from exact predecessor `3a7e8c0e734552904ade9a06135985c6a1943e08` on `stage8/362-protected-activity-channel`.

## Assessment

Public setup now owns repository selection, accepted Linux profile configuration, protected image adoption, protected environment activation, and verified workspace-route publication. Its successful handoff nevertheless states that operational configuration and execution opt-in remain pending. The normal config file is absent on the physical installation, so `doctor`, polling, and the daemon cannot consume the verified protected route. DevBridge therefore remains structurally fail-closed but is not usable.

Copying `config/devbridge.example.json` would be incorrect. It contains one repository-specific example, disables execution, and names policy that was not derived from the current accepted setup state. Editing an arbitrary existing config would also be incorrect: setup must distinguish an exact setup-owned generation from operator drift and must not overwrite the latter.

The required boundary is local configuration publication, not VM/provider mutation. Provider, image, environment, bridge, credential, or hypervisor identities must not enter the config publisher. The publisher consumes only accepted queue subjects, local task-author identities, workspace owners, local installation roots, and an explicit execution-ready decision from setup.

## Research

- DB-003 makes configuration local machine authority. Repository discovery is observation until the local setup transaction accepts it; task authorship remains a separate explicit allowlist and must not be expanded from collaborator membership.
- DB-009 requires intent before effect and observation/reconciliation after an interrupted or ambiguous effect. A generic retry is insufficient.
- DB-020 requires a ready VM route and forbids direct-host fallback. Setting `execution.enabled` cannot create readiness by declaration.
- Node's official [`fs` documentation](https://nodejs.org/api/fs.html) states that promise filesystem calls are not synchronized with one another, that callers must order them explicitly, and that `rename` overwrites an existing destination. The implementation must therefore serialize its own phases, flush created files, and verify exact bytes after replacement rather than treating a returned write call as sufficient evidence.

No external platform behavior beyond the already implemented provider/bridge contracts is needed for this slice.

## Reassessment

The smallest complete design is a setup-owned, digest-bound configuration publisher composed only after protected environment and route readiness:

1. Build one deterministic configuration from accepted local setup facts. Use every accepted queue, the authenticated local identity as the initial task-author allowlist, unique repository owners, installation-owned state/workspace roots, repository-default Git baselines, controller plans enabled, coding-model adapters disabled, host fallback disabled, dynamic onboarding disabled, publication conservative, and execution enabled only at the verified setup frontier.
2. Validate the complete candidate through the normal config validator before any write.
3. Persist a bounded planned transition containing the exact previous digest (or absence), target digest, and target bytes before replacing the config.
4. On entry or restart, compare the actual config digest with both recorded subjects. Finalize an already-realized target, continue only from the unchanged predecessor, and fail closed on any third state.
5. Preserve an unmanaged pre-existing config. Exact candidate equivalence may be adopted without rewriting bytes; any other unowned config requires explicit future reconfiguration rather than implicit overwrite.
6. Verify the installed config by loading it through the production validator and require execution enabled with model adapters disabled before setup reports operational readiness.

This publisher owns no repository discovery, GitHub request, daemon, provider, VM, route, bridge, or process implementation. Its inputs are local configuration values; topology remains transient.

## Dependency-ordered plan

1. Define the closed operational-configuration request/result and durable transition record.
2. Implement deterministic config construction and normal-schema validation behind an injected validation stud.
3. Implement bounded no-follow config/record inspection, durable planned transition, exact replacement, postcondition verification, restart reconciliation, and drift refusal.
4. Compose publication after protected environment activation and before consent cleanup/success handoff.
5. Project only readiness, changed state, and execution state to the public setup result.
6. Replace the pending handoff with the normal CLI/status/doctor/re-entry instructions only after exact operational readiness.
7. Test fresh creation, no-op re-entry, accepted repository changes, unmanaged config preservation, managed drift, interruption before/after replacement, malformed/oversized/symlinked records, multi-repository projection, model-adapter opt-out, and no publication before route readiness.
8. Run focused tests, LEGO boundary checks, candidate preflight, the full suite, and installed `doctor`/runtime qualification. Physical C execution remains a separate evidence step after the pending UAC activation.

## Implementation checkpoint

The implementation now provides one setup-owned operational-configuration owner:

- its closed input uses only neutral accepted targets, submitter identities, and owner identities;
- it deterministically emits the normal multi-queue configuration beneath the selected installation home;
- repository-default branches remain authoritative unless a later local semantic-channel policy is explicitly configured;
- controller plans and VM-bound execution are enabled only at the post-route setup frontier;
- coding-model adapters, uncontained host execution, dynamic tool onboarding, coordination, and automatic publication remain disabled;
- a planned record binds predecessor absence/digest, target digest/content, and one exact staging leaf before the config effect;
- initial creation uses a same-directory exclusive hard-link publication, managed replacement uses ordered rename, and both paths re-read exact bytes through the production validator before final readiness;
- restart reconciles an already-realized target or continues only from the unchanged predecessor; unmanaged config, managed drift, malformed/oversized state, filesystem indirection, or a third observed subject fails closed;
- public setup projects only readiness/change/execution state and reports success only after this postcondition.

Verification from the exact working tree on 2026-08-28:

- focused setup/configuration/status/architecture tests: 38 total, 37 passed, zero failed, one Windows symlink-fixture skip;
- candidate preflight: 99 syntax files, two JSON files, and 95 targeted test files passed;
- complete repository suite: 1,514 total, 1,499 passed, zero failed, 15 platform-specific skips;
- installed physical qualification remains intentionally pending until the exact UAC-gated protected environment activation succeeds.
