# DevBridge handoff — Windows lifecycle authority qualification

**Cut:** 2026-08-25 ~07:00 PDT  
**Continuation start:** 2026-08-24 20:29 PDT  
**Repository:** `iteathen/DevBridge`  
**Base:** `cuda-target`  
**Working branch:** `security/177-windows-authority`  
**Parent issue:** #177  
**Focused issue:** #288  
**Draft PR:** #289  
**Last code/test head before this handoff document:** `1a7cff987deb3c619071f573af2afda3969ba3e2`

The handoff document itself is a docs-only descendant of that code/test head, so the next chat must read the live PR head before doing work. Do not expect the branch ref itself to remain exactly `1a7cff...` after this file was committed.

## Stop point

Stop with the Windows protected lifecycle-authority brick physically proven on an earlier exact head, then hardened further off-host. The branch is **not ready to merge yet** because the last code/test head has one unclassified Windows full-suite CI failure.

Do not begin another physical-host sequence until the current branch is final and a host canary is genuinely unavoidable.

The next chat should first recover and classify the exact Windows CI failure from run `32815703962`, job `97703398656`, before changing source.

## Operator constraint — host access is scarce

The operator explicitly requested:

> no more host commands unless it is absolutely necessary please

Honor this as a hard workflow constraint:

- prefer hosted CI, code audit, deterministic tests, and documentation evidence;
- do not use the physical workstation as a compiler or iterative test bench;
- do not ask for repeated setup/status commands while the branch is still changing;
- if a physical proof is eventually indispensable, consolidate it into the smallest final canary after the exact candidate is otherwise frozen and green;
- do not manufacture ad-hoc provider/destructive tests merely because host access exists.

## #197 physical state remains frozen

Do not touch #197 while completing #288/#177.

Relevant prior handoff: `docs/testing/DB-HO005-issue-197-handoff-2026-08-24.md`.

Preserve these facts:

- old physical Ubuntu canary state remains intact;
- public setup had reached the construction gate;
- no v4 `setup --construct` was run;
- #288 work made no Ubuntu image/VM/network/media/cache construction changes;
- do not run image or VM construction as part of Windows authority qualification.

## PATH / Codex discovery issue is separate — #291

A temporary concern that Codex could not resolve `devbridge` was diagnosed without changing permissions.

Physical evidence:

- Codex identity: `WDRFJK6T\josho` — the ordinary interactive user, not a sandbox/service identity;
- `%USERPROFILE%`: `C:\Users\josho`;
- Windows User PATH contains `C:\Users\josho\.devbridge\bin`;
- Machine PATH does not contain that user directory, which is expected;
- the Codex-hosted process PATH omitted the User-PATH addition;
- a fresh child PowerShell inherited that sanitized process PATH;
- process `PATHEXT` includes `.CMD`;
- `C:\Users\josho\.devbridge\bin\devbridge.cmd` exists and runs by exact path;
- bare `Get-Command devbridge` / `where.exe devbridge` fails only because the effective process PATH omits the launcher directory.

Classification: healthy DevBridge user installation + sanitized/stale agent process environment.

Issue #291 tracks making launcher discovery/handoff robust when an agent runtime sanitizes User PATH. Do **not** solve it by granting the model process Administrator/Hyper-V authority or weakening #177 ACLs.

## Physical #288 proof — exact old head only

All physical proof below was performed on exact PR head:

`b947d7812b15d34ff7eb4b803fe7f58ab50722e1`

Do not silently transfer this qualification claim to later binaries.

### 1. Ordinary non-elevated preflight

Identity: `WDRFJK6T\josho`  
Elevated: `false`  
Launcher: `C:\Users\josho\.devbridge\bin\devbridge.cmd`  
`--construct`: not invoked

Exact invocation selected the `b947...` ref and ran plain `setup`.

Result:

```text
DevBridge setup is blocked.

Reason: Windows protected lifecycle authority is not ready. Re-run devbridge setup from an elevated PowerShell so DevBridge can establish the protected service and state boundary.
```

Exit code: `3`.

Classification: `elevation-required`.

Important evidence:

- migration-safety preflight did **not** find path/file-identity-bound legacy image/storage/recovery state on this installation;
- no protected service/ACL/Hyper-V/VM/image mutation occurred in this pass.

### 2. Elevated structural establishment

Same operator identity: `WDRFJK6T\josho`  
Elevated: `true`  
Same exact `b947...` head  
`--construct`: not invoked

Result:

```text
DevBridge setup is blocked.

Reason: Windows protected lifecycle authority is structurally verified. Re-run devbridge setup from a non-elevated PowerShell to prove ordinary protected-state and mutation-endpoint denial before construction can continue.
```

This is the intended two-phase seam. The setup-owned path established/reconciled the protected service/runtime/state boundary and passed elevated structural proof, but correctly refused to publish final readiness from an elevated token.

### 3. Fresh ordinary re-entry / negative-capability proof

Same operator identity: `WDRFJK6T\josho`  
Elevated: `false`  
Same exact `b947...` head  
`--construct`: not invoked

Result:

```text
DevBridge setup reached the construction gate.

Linux execution profile: source/package/payload authority ready
Repositories: 16 configured
Physical image construction: authorized by status gate, not started
Windows lifecycle authority: protected service/state ready
Physical construction connectivity: verified host-managed DHCP; not claimed as DevBridge-owned network state

The setup path performed no image or VM construction.
The devbridge command is available on PATH.
```

Exit code: `0`.

This physically proved on `b947...`:

- elevated structural establishment;
- ordinary write denial against protected ownership state;
- ordinary mutation-pipe connection denial;
- ordinary read-side inspection remains usable;
- setup can release to the construction gate without constructing anything.

These observations were recorded on #288 and PR #289.

## Physical-proof caveat after hardening

After the successful `b947...` physical sequence, the branch changed materially in the service host and readiness proof.

Therefore:

- the physical sequence remains valid evidence for the architecture/two-phase contract;
- **do not claim the current hardened binary itself has been physically requalified**;
- do not repeatedly re-run the host while source is moving;
- if final merge policy requires current-binary physical evidence, perform one consolidated canary only after the exact candidate is otherwise frozen and green.

## Post-proof hardening — hosted/code evidence only

### Persistent first-instance named pipes

`src/setup/windows-lifecycle-authority-host.cs` was hardened so each read/mutation capability keeps a persistent first pipe instance rather than disposing and recreating the namespace after every request.

Purpose:

- close the endpoint-replacement window between requests;
- make fatal endpoint failure fail-stop and let the SCM restart policy own recovery;
- preserve the existing split read/mutation DACL model.

Research nuance: .NET `PipeAccessRights.ReadWrite` does not itself include `CreateNewInstance`; the larger practical gap was the server releasing/recreating the endpoint namespace.

### Worker credential-environment scrub

The protected worker launch now scrubs inherited variables including:

- `NODE_OPTIONS`
- `NODE_PATH`
- `GH_TOKEN`
- `GITHUB_TOKEN`
- `DEVBRIDGE_GITHUB_TOKEN`
- `GIT_ASKPASS`
- `SSH_AUTH_SOCK`
- `DEVBRIDGE_COORDINATION_PRIVATE_KEY`
- `DEVBRIDGE_RELEASE_PRIVATE_KEY`
- `DEVBRIDGE_SIGNING_KEY`

The worker remains bounded by the fixed protected Node/entrypoint and kill-on-close Job Object.

### Independent SCM identity proof before pipe trust

Added a read-only service proof (`src/setup/windows-lifecycle-authority-service-proof.js`) and readiness composition integration.

Ordinary readiness no longer treats a successful same-named read pipe as sufficient identity evidence. Before pipe evidence is accepted, Windows SCM observation must prove the deterministic service is:

- present;
- running;
- automatic start;
- running under the exact virtual service account;
- configured with the exact protected command line.

This closes the case where the real service is stopped and an ordinary process tries to spoof a same-named read server.

The proof is observation-only and receives no SCM mutation authority.

### One owner for the deterministic service command

The exact service command is owned by the Windows authority plan as `plan.serviceCommand`.

Both provisioning and independent SCM verification consume that plan value instead of rebuilding the command independently.

An existing protected installation also rejects a different operator SID before protected-root/service mutation rather than silently rebinding the read capability.

### Package-root correctness / cleanup

- protected service-host source now follows injected `packageRoot` rather than a stale module-level source constant;
- the nonsensical `changed: true || changed` expression was removed;
- restart/re-entry and timeout/recovery regression coverage was expanded.

### Client failure-latency bounds

Production authority-client retry/deadline behavior was bounded so setup/readiness failures cannot multiply into long hangs. Windows readiness/protection uses low retry ceilings, with focused recovery/timeout tests split to avoid unrelated hosted-runner test contention.

## Legacy migration safety

Generic byte-for-byte migration is unsafe for all deployments because:

- `BaseImageLibrary` catalogs bind objects to filesystem identity;
- persistent Hyper-V provider records retain absolute `diskPath`, `parentPath`, and `configPath` values;
- copying metadata into ProgramData while leaving the actual legacy VHDX in a user-writable tree would falsely claim protection.

The pre-provision migration-safety gate therefore stops before SCM/ACL/service mutation when it sees:

- non-empty published/staged image state;
- persistent provider records/backing objects;
- active image-recovery materialized state;
- malformed migration evidence;
- filesystem indirection or unsupported shapes.

Empty/path-independent authority state may use the generic copy seam.

The physical installation passed this gate on `b947...`, so no provider-aware migration was required for the current host at that time.

If a future deployment does require path-bound migration, use an exact-owned provider migration adapter (for Hyper-V, `Move-VMStorage` is the supported Windows primitive), not a generic privileged file-move API.

## Existing operator Hyper-V authority caveat

Do not conflate the DevBridge protected service boundary with the host's pre-existing operator policy.

The ordinary user may already be a member of **Hyper-V Administrators** from configuration that predates this authority brick. DevBridge setup grants provider authority only to the protected service identity and must not silently remove foreign/operator group membership without ownership proof.

Consequences:

- #288 can establish the DevBridge service/storage boundary without seizing unrelated host policy;
- parent #177 cannot honestly claim that the operator/model-visible identity lacks all direct Hyper-V provider authority if that host identity independently holds Hyper-V Administrators membership;
- do not auto-remove that membership as a "fix".

## Last code/test branch state before this handoff doc

Last code/test head:

`1a7cff987deb3c619071f573af2afda3969ba3e2`

Relevant recent commits include:

- `a10f77106ff0b3c5b9f3cab46a508eedba1a5588` — `test: bound Windows authority client failure latency` (includes production retry/deadline bounds);
- `030828e9de8ca67fdb251797d593fde802973860` — split Windows authority timeout coverage;
- `1a7cff987deb3c619071f573af2afda3969ba3e2` — isolate Windows authority client timeout recovery cases.

From `a10f...` to `1a7cff...`, the changes are test-only.

Committing this handoff moves the branch to a docs-only descendant. Always fetch PR #289's live head first in the next chat and distinguish documentation-only commits from the last code/test candidate.

## CI blocker on last code/test head — classify before editing

Workflow for `1a7cff...`:

- run: `32815703962`
- Ubuntu smoke: success
- Ubuntu full + doctor: success
- Windows smoke: success
- Windows full + doctor job: `97703398656`
- Windows full **Tests** step: failure

The exact failing test/error text was **not successfully recovered in the prior chat transcript** despite requesting the job logs.

Therefore the failure is **unclassified**.

Do not:

- invent the failing test;
- automatically call it #290's known load/concurrency flake;
- change product code or timeouts before inspecting evidence.

#290 exists because earlier Windows hosted-runner failures were falsified by exact-head reruns with no source changes, but that history is not sufficient to classify this failure.

## Remaining #288/#177 work

### Before #289 can honestly merge

1. Recover job `97703398656` logs from run `32815703962` and identify the exact Windows failure.
2. Fix only the owning defect, or rerun the exact code head without source changes if evidence supports a hosted-runner flake.
3. Obtain a fully green Ubuntu/Windows smoke + full/doctor matrix on one exact candidate.
4. Update PR #289 body/docs to the exact candidate and qualification state.
5. Decide whether a **single** final physical requalification of the hardened service binary is strictly necessary before merge. Do not request repeated host commands.

### Real provider security acceptance still outstanding in parent #177

A protected environment backing disk has not yet been created by this #288 sequence, so do not manufacture an ad-hoc destructive host test.

Final parent acceptance still needs a disposable exact-owned provider subject proving both sides together:

- **negative:** ordinary coding/model identity cannot directly delete or replace the exact protected test backing disk;
- **positive:** the authorized DevBridge lifecycle path can remove/replace the same exact owned infrastructure after impact/fence/ownership checks and return to verified readiness.

Also prove:

- foreign/operator Hyper-V state is untouched;
- Hyper-V/VMMS still functions with the protected service/storage ACL model;
- crash/restart/re-entry remains exact;
- no local-provider fallback is introduced.

Bundle these with the first suitable disposable protected lifecycle environment rather than consuming host commands one at a time.

### Client cutover remains a later LEGO

Do not assume ordinary lifecycle CLI/doctor has already been fully cut over merely because the protected authority exists.

Before claiming client cutover complete, inspect current composition and prove:

- ordinary lifecycle commands use the neutral authority client;
- no ordinary local `EnvironmentOperator`/provider fallback remains for provider mutation;
- coding/model processes do not receive persistent mutation credentials/capabilities;
- the existing `EnvironmentOperator` remains the single lifecycle semantics owner behind the authority boundary.

### Uninstall/repair and Linux equivalent

- exact uninstall/repair cleanup belongs to the broader setup/uninstall owner (#116/#177); do not expand #289 opportunistically after its authority-establishment seam;
- Linux/KVM-libvirt authority separation is still required later under parent #177.

## Scope / cleanliness

Throughout this continuation:

- operator checkout/worktree was not reset/cleaned/mutated;
- source changes were made through GitHub branch commits;
- no #197 image/VM construction was performed;
- no manual ACL/service/group/Hyper-V workaround was used for physical proof;
- PR #289 remains draft;
- no completion claim is warranted until exact-head CI and remaining acceptance gates are honestly satisfied.

## Resume sequence for the next chat

1. Read this file, #288, #289, and the relevant #177 acceptance criteria.
2. Fetch PR #289's live head. Expect a docs-only descendant of `1a7cff...` unless more work occurred after this handoff; do not treat a changed ref as a code change without comparing commits.
3. Fetch the exact failure details for CI run `32815703962`, Windows job `97703398656`.
4. Classify before editing: product defect, test defect, or hosted-runner flake with falsification evidence.
5. Resolve only that owner and get one exact head fully green.
6. Refresh PR #289 qualification text/current head.
7. Avoid physical host work unless the remaining acceptance cannot be proven otherwise; if needed, design one final consolidated host canary.
8. Do not run `setup --construct` or resume #197 construction during this #288 seam.
9. Only after #289 is honestly qualified should #177 advance to ordinary client cutover / final provider negative+positive acceptance.
