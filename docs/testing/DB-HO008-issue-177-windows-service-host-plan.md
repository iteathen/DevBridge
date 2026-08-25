# DB-HO008 issue #177 Windows lifecycle service-host plan

**Date:** 2026-08-24 PDT  
**Work session start:** 17:06 PDT  
**Repository:** `iteathen/DevBridge`  
**Parent issue:** #177  
**Focused issue:** #288  
**Draft PR:** #289  
**Verified predecessor head:** `c4e3b91f4a4b9fa4c6aeb5b09f8fbe1c43e76f15`

## Predecessor gate

The neutral `authorityDirectory` state split is green on hosted CI run `32792578407` across Ubuntu and Windows smoke/test jobs, including full Windows tests and doctor smoke.

This plan begins after that verified seam. #197 physical Ubuntu construction remains frozen and out of scope.

## Selected Windows host mechanism

Use a **real Windows SCM service** with a Windows-managed virtual account:

`NT SERVICE\<DevBridge lifecycle service name>`

The service executable must participate in the SCM service protocol. A normal Node or PowerShell process must not be registered directly as a Windows service.

Reasons for selecting this mechanism:

- Windows virtual service accounts are OS-managed and do not require DevBridge to create, persist, rotate, or expose a password.
- The SCM can add a per-service SID to the service token so exact resources can be ACLed to this service rather than the ordinary interactive/model process.
- Windows PowerShell 5.1 provides the built-in `Add-Type` compiler path needed to materialize one small service-aware C# executable during elevated setup; DevBridge does not need a third-party service wrapper or a permanent compiler/toolchain dependency.
- A real service is restartable and reconcilable through the existing Windows service control plane.

Primary Microsoft authorities reviewed for this selection:

- virtual service accounts and `NT SERVICE\<SERVICENAME>` service identities;
- `CreateService` virtual-account support;
- `SERVICE_SID_INFO` / `SERVICE_SID_TYPE_UNRESTRICTED`;
- named-pipe `PipeSecurity` / `NamedPipeServerStream` access control;
- `PipeAccessRights` capability semantics;
- Windows PowerShell 5.1 `Add-Type -OutputAssembly -OutputType` support.

## LEGO ownership

There is still one lifecycle semantic owner:

`SCM service host -> exact protected Node worker -> existing EnvironmentOperator/recovery -> foundation/provider adapters`

The C# service host owns only:

- SCM start/stop/status participation;
- creation of the read and mutation named pipes with explicit Windows security descriptors;
- bounded framing and capability classification;
- bounded child-process invocation of the exact protected Node authority worker;
- orderly stop/child cancellation.

It must not implement create/repair/rebuild/reset/recreate semantics, inspect Hyper-V objects itself, accept paths/commands/provider names from clients, or expose a generic privileged execution surface.

The Node worker owns protocol validation and composes the existing high-level lifecycle owner. It is copied with an exact Node runtime into protected storage before service activation; the service must not execute JavaScript or Node binaries from an ordinary-user-writable checkout/home.

## Stable identity and storage plan

The authority identity remains the existing path-free hash derived from ordinary installed lifecycle state. That identity determines only DevBridge-owned local names; callers cannot select it.

Windows setup derives deterministic resources from the authority identity:

- service name: bounded `DevBridgeLifecycle-<identity-prefix>`;
- virtual service account: `NT SERVICE\<service-name>`;
- protected root: `%ProgramData%\DevBridge\lifecycle-authority\<authority-id>`;
- protected authority state: `<protected-root>\state`;
- protected runtime: `<protected-root>\runtime`;
- protected service binary: `<protected-root>\bin\devbridge-lifecycle-authority-host.exe`;
- protected Node binary: `<protected-root>\bin\node.exe`.

The ordinary `stateDirectory` remains the endpoint namespace and daemon/workspace/fence coordination root. The protected `authorityDirectory` is passed only to the authority-side `EnvironmentOperator` composition.

## Provider authority

The service virtual account is the only DevBridge runtime identity that may receive the host Hyper-V management capability required by the existing provider adapter. The ordinary interactive/model identity must not receive Hyper-V Administrators membership as a DevBridge side effect.

Windows exposes `BUILTIN\Hyper-V Administrators` as SID `S-1-5-32-578`. Setup must bind group membership by SID rather than localized group name and record exact membership ownership for repair/uninstall.

The provider authorization available from Windows is broader than per-VM ACLs, so foreign/provider-object protection still depends on the existing `EnvironmentOperator` ownership/identity checks and the fact that the service RPC cannot address lower provider operations. Real #288 canaries must prove foreign state remains untouched.

## Filesystem ACL policy

Protected storage must not inherit an ordinary-user-writable parent authority.

- SYSTEM and elevated Administrators: setup/repair ownership.
- service SID / virtual service account: only the runtime read/execute and authority-state modify rights required by the host.
- ordinary interactive/model identity: no write/delete/replace rights to protected runtime, authority state, or backing-store paths.

The final reconciler must inspect effective ownership/DACLs after mutation and fail closed if expected deny/separation evidence cannot be proved.

## Named-pipe capability policy

The existing deterministic pipe names remain unchanged so the neutral client contract does not learn Windows service details.

Read and mutation capabilities receive distinct DACLs.

Read pipe:

- exact installing/operator SID: read/write client access;
- Administrators and SYSTEM: administrative access;
- service identity: server ownership.

Mutation pipe:

- Administrators and SYSTEM: client access;
- service identity: server ownership;
- ordinary installing/operator SID is **not** granted access merely because it can read/plan.

Client ACEs must use exact pipe read/write rights, not FullControl/CreateNewInstance. A guessable pipe name is never authentication.

The later client-cutover/UX brick may use a bounded elevated mutation-client path for operator-authorized destructive operations. #288 must not put a persistent mutation credential in the ordinary model-visible process.

## Setup/re-entry order

Windows setup owns reconciliation in this order:

1. derive and validate exact deterministic resource plan;
2. require elevation before first mutation;
3. stage protected runtime/service material into a temporary protected candidate;
4. compile the small service-aware host from repository-owned C# source using Windows PowerShell 5.1;
5. create/reconcile the exact SCM service under its virtual account;
6. enable the service SID;
7. grant only the service identity the required Hyper-V group membership;
8. migrate only admitted DevBridge-owned authority state into the protected root;
9. apply/verify exact ACLs;
10. start/restart service and verify read capability plus negative ordinary-user mutation capability evidence;
11. publish protected-authority readiness only after all checks pass.

Re-entry must observe before mutating and must not seize a foreign service/root with a matching human-readable name but mismatched identity/evidence.

## Uninstall/repair ownership

Repair/uninstall may touch only the deterministic service, service-owned group membership, protected root, and ACLs whose DevBridge ownership can be proved. Unknown services, foreign ProgramData content, foreign Hyper-V objects, operator networks, and unrelated group memberships are never generalized cleanup targets.

## Falsifiers before client cutover

- service binary is not SCM-aware;
- service runs as the interactive user, LocalSystem, or another shared broad identity instead of the selected per-service virtual account;
- ordinary model process gains Hyper-V Administrators or Administrator rights;
- service executes Node/JS from user-writable state;
- mutation pipe grants the ordinary operator SID persistent access;
- client pipe rights include pipe-instance creation or generic FullControl unnecessarily;
- protected root remains deletable/replaceable by the ordinary identity;
- setup cannot distinguish its exact service/root/group membership from foreign state;
- service host implements or exposes lifecycle/provider semantics itself.

Any falsifier stops #288 rather than adding a fallback.
