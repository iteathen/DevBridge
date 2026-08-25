# DB-HO007 issue #177 Windows protected lifecycle authority checkpoint

**Checkpoint:** 2026-08-24 PDT  
**Repository:** `iteathen/DevBridge`  
**Base branch:** `cuda-target`  
**Exact base:** `4bea25e4358ad43ae9166f224235244b19eb8500`  
**Parent issue:** #177  
**Focused issue:** #288

## Work session

- resumed: **2026-08-24 17:06 PDT**
- continued: **2026-08-24 18:42 PDT** after exact-head CI failure classification
- branch: `security/177-windows-authority`
- draft PR: #289
- physical #197 state: frozen; no VM/cache/operator-worktree mutation authorized by this branch

## Why this brick precedes client cutover

Stopped #286 / PR #287 proved the neutral lifecycle authority protocol/client/transport/host foundation exists but production setup/runtime does not provision or start a protected authority process. Ordinary CLI/doctor still constructs the local operator directly.

A client-only cutover would make lifecycle unavailable. Retaining the local provider authority as fallback would preserve the original destructive authority and violate #177.

Therefore the active Windows/Hyper-V usability path must first establish the real OS authority boundary.

## Fixed LEGO boundary

There remains one semantic lifecycle owner:

`protected Windows authority identity/process -> existing EnvironmentOperator/recovery composition -> existing foundation/provider adapters`

This brick owns Windows process identity, bounded service/process hosting, endpoint security, exact DevBridge-owned storage/provider access, setup/re-entry/uninstall ownership, and permission evidence. It must not duplicate create/repair/rebuild/reset/recreate semantics or expose lower provider operations.

## Primary-source research before source inspection

Microsoft documentation confirms these constraints:

1. A real SCM service process must connect to the Service Control Manager through `StartServiceCtrlDispatcher` and dispatch `ServiceMain`; a normal console Node process is not itself a valid Windows service merely because `sc.exe` points at it.
2. A service SID can be added to the service token and used to ACL exact objects to `NT SERVICE\<service>` rather than granting the caller the same rights.
3. Named-pipe default security is not sufficient for the mutation capability. Default descriptors may grant broader access than required, and generic pipe write rights can imply `FILE_CREATE_PIPE_INSTANCE`; the final DACL must use explicit least-privilege rights and must not reduce authentication to a guessable pipe name.
4. File/backing-store protection must use real Windows access-control enforcement; inherited/default ACLs are not sufficient evidence of denial.
5. UAC filtered tokens are a real authority boundary: ordinary non-elevated processes do not automatically carry the full administrator token merely because the interactive account is an administrator.
6. Task Scheduler S4U can avoid a stored password and deliberately has no network/EFS access, but that does not itself solve endpoint authorization or protected storage ownership. It remains a possible local-only host mechanism, not the authority model.

Primary Microsoft references reviewed:

- `StartServiceCtrlDispatcherW` / Windows service process requirements;
- `ServiceMain` requirements;
- `SERVICE_SID_INFO` / `SERVICE_SID_TYPE_UNRESTRICTED` and service SID naming;
- Named Pipe Security and Access Rights;
- File Security and Access Rights;
- UAC administrator approval / filtered-token behavior;
- Task Scheduler S4U logon and task settings.

## Pre-source gate — completed

This branch was intentionally documentation-only before implementation-source inspection.

Initial exact candidate: `59e1d1c7cdd07bc8c2c25ed1b1074b434fd3b63f`.

Hosted CI run `32790191468` passed all four Ubuntu/Windows smoke/test jobs, including repository preflight on both operating systems, full applicable tests, architecture gates and doctor smoke. Only after both preflights passed were #288 implementation surfaces inspected.

## Source/state findings

The existing lifecycle authority boundary is already correctly separated from lifecycle semantics:

- `src/runtime/environment-lifecycle-authority.js` owns the neutral protocol/client;
- `src/runtime/environment-lifecycle-authority-transport.js` owns bounded local transport and separate read/mutation endpoints;
- `src/app/environment-lifecycle-authority-host.js` composes the existing high-level `EnvironmentOperator` behind that boundary;
- `src/app/environment-operator-runtime.js` remains the one semantic lifecycle/recovery owner.

The state layout also exposes a useful existing LEGO boundary:

- `src/app/environment-foundation.js` keeps image/provider/persistent-environment authority below one `environment-foundation` subtree;
- `src/app/environment-lifecycle.js` keeps durable declarations/journal under one `environment-lifecycle` subtree;
- `src/app/environment-image-availability.js` owns image transfer/quarantine state;
- `src/app/environment-construction.js` owns the durable `environment-construction/state.json` resume checkpoint;
- `src/app/environment-lifecycle-fence.js`, preparation/workspace state, daemon coordination and run state are different responsibilities and should not be moved merely because the protected authority needs a different storage root.

The construction checkpoint is authority state, not ordinary coordination. `EnvironmentConstructionPipeline` loads its completed-stage list and resumes from that position; an ordinary caller able to rewrite that file could otherwise influence which destructive preparation/materialization stages the protected owner skips. Therefore the checkpoint must move with the lifecycle authority state.

A protected child directory below an ordinary-user-owned parent is not enough: parent directory deletion/ownership rights can defeat the intended deny boundary. Windows therefore needs a separate protected ProgramData-class authority root rather than trying to ACL selected children under ordinary `~/.devbridge` state.

## Frozen first implementation brick: neutral authority-directory split

Before selecting/implementing the final Windows service host, add one provider-neutral composition seam:

`stateDirectory` — ordinary DevBridge coordination/workspace/daemon/fence state  
`authorityDirectory` — environment declaration/foundation/image authority and lifecycle construction checkpoint state that may later live under protected OS ownership

Rules:

- `authorityDirectory` defaults exactly to `stateDirectory`, so existing installations and #197 behavior are byte/semantic compatible until setup explicitly opts into a protected root;
- `EnvironmentFoundation`, `EnvironmentLifecycle`, `EnvironmentImageAvailability`, and `EnvironmentConstructionPipeline` checkpoint state consume `authorityDirectory`;
- lifecycle fencing, daemon/run coordination, preparation/workspace state and bridge coordination remain on `stateDirectory`;
- no Windows/ProgramData/ACL/service identity enters these neutral modules;
- no provider-native path/identity is added to the public lifecycle contract;
- the later Windows setup adapter owns migration/admission of the exact authority subtree into protected storage.

This is a LEGO seam, not security completion by itself. It creates one truthful place for the Windows authority adapter to protect without broad-locking unrelated user-owned DevBridge state.

### Focused falsifiers for the split

- default `authorityDirectory` omitted -> all existing state resolves exactly as before;
- explicit authority directory -> foundation/lifecycle/image-transfer/construction-checkpoint state moves only to that root;
- daemon/run lifecycle fence remains bound to ordinary `stateDirectory`;
- preparation/workspace/bridge state remains bound to ordinary `stateDirectory`;
- no Windows/provider identity appears in neutral APIs;
- fake/substituted foundations continue to work without knowing the current caller/topology.

## Windows host direction after the split

The likely smallest production mechanism remains a dedicated Windows service identity with a service SID, explicit least-privilege named-pipe DACLs, and exact ACLs on a protected authority/runtime root. A native/service-aware shim may own only SCM/process/IPC mechanics while invoking one exact protected DevBridge authority entry; it must never become a second lifecycle owner or arbitrary privileged command/file service.

The protected process must not execute mutable code or a mutable Node runtime from an ordinary-user-writable installation root. Any service-host implementation therefore also needs exact protected executable/runtime materialization and admission before client cutover.

Do not grant ordinary coding/model processes administrator or Hyper-V management authority to make lifecycle work.

## #197 separation

Issue #197 physical Ubuntu construction remains independently preserved at its v4 public read-only gate. This Windows authority branch must not modify Ubuntu construction/canary/media code or mutate the physical VM/cache state.

## 18:42 PDT exact-head failure classification and correction

Hosted run `32793619497` checked out exact head `78b4f1265da07ae7bce0eb5ce85f83e17cebdfe6`. Both Ubuntu and Windows smoke/preflight jobs passed, but both full test jobs failed on the same focused authority tests. The failures were classified before any setup/service-installation effect was added.

Three assertions failed for two causes:

1. `environment-authority-state-separation.test.js` proved `createEnvironmentBridge` recreated `environment-foundation/identity.json` below ordinary `stateDirectory` even though bootstrap had already loaded the same foundation identity from protected authority state. The bridge needs the identity to derive its provider-neutral location proof, but it does not own protected storage. Correction: `createEnvironmentBootstrap` now injects the already-owned 32-hex foundation identity as data into `createEnvironmentBridge`; the bridge retains its legacy local-identity fallback only for callers that do not inject an identity. It does not learn `authorityDirectory`.
2. The Windows plan and protected worker used `path.win32.isAbsolute()` as if it implied a fully qualified Windows volume path. Node correctly treats `/tmp/...` as a rooted Windows path using the current drive, so the fail-closed tests did not throw. Correction: both independent trust boundaries now require a drive-qualified root or a complete UNC root and reject Win32 device namespaces before normalization is accepted. This keeps validation local to each authority boundary rather than creating a cross-layer setup/entry dependency.

Correction commit: `7f418c6670f751dd38cef555b25479246140b032` (`fix: preserve protected lifecycle authority boundaries`).

The correction changes no lifecycle semantics, no provider command vocabulary, no endpoint access class, and no setup/service installation behavior. Exact-head hosted Ubuntu/Windows CI is required again before the next Windows authority brick may begin.

## Current evidence status

- Exact base observed and branch created cleanly from `4bea25e4358ad43ae9166f224235244b19eb8500`; `cuda-target` was re-observed at the same exact head at the 17:06 PDT work-session start.
- `AGENTS.md`, #177, stopped #286/#287 evidence, `docs/environment-lifecycle-authority.md`, DB-003/009/018/020, `docs/vm-migration.md`, and `docs/vm-lego-studs.md` were reviewed before implementation inspection.
- Microsoft primary documentation was reviewed before implementation inspection.
- Clean-checkout hosted preflight/full CI is green on both host families for the docs-only checkpoint.
- The neutral authority-directory split is the first authorized production-code brick.
- The complete `stateDirectory` consumer trace refined the authority-state classification to include the construction resume checkpoint before production code was edited.
- Exact head `78b4f1265da07ae7bce0eb5ce85f83e17cebdfe6` failed only the three focused authority tests described above; smoke/preflight remained green on both host families.
- The two classified causes are corrected at `7f418c6670f751dd38cef555b25479246140b032`; clean-checkout CI on the resulting documented head is pending.
- No setup/service installation effect has been added after the failed gate.
- No #197 physical state has been changed by this work.
