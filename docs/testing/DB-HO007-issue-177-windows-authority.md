# DB-HO007 issue #177 Windows protected lifecycle authority checkpoint

**Checkpoint:** 2026-08-24 PDT  
**Repository:** `iteathen/DevBridge`  
**Base branch:** `cuda-target`  
**Exact base:** `4bea25e4358ad43ae9166f224235244b19eb8500`  
**Parent issue:** #177  
**Focused issue:** #288

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

Primary Microsoft references reviewed:

- `StartServiceCtrlDispatcherW` / Windows service process requirements;
- `ServiceMain` requirements;
- `SERVICE_SID_INFO` / `SERVICE_SID_TYPE_UNRESTRICTED` and service SID naming;
- Named Pipe Security and Access Rights;
- File Security and Access Rights.

## Pre-source gate

This branch is intentionally documentation-only before implementation-source inspection. The draft PR must run repository clean-checkout preflight on Ubuntu and Windows first. Only after both preflights pass may Windows-specific setup/service/provider source surfaces be inspected.

After that gate, the implementation plan must select the smallest service-aware host arrangement already compatible with repository mechanisms. If the repository lacks such a host, the plan must add a bounded service-aware adapter rather than pretending a normal Node process is an SCM service or importing a generic third-party privilege wrapper.

## #197 separation

Issue #197 physical Ubuntu construction remains independently preserved at its v4 public read-only gate. This Windows authority branch must not modify Ubuntu construction/canary/media code or mutate the physical VM/cache state.

## Current evidence status

- Exact base observed and branch created cleanly from `4bea25e4358ad43ae9166f224235244b19eb8500`.
- `AGENTS.md`, #177, stopped #286/#287 evidence, `docs/environment-lifecycle-authority.md`, DB-003/009/018/020, `docs/vm-migration.md`, and `docs/vm-lego-studs.md` were reviewed before this checkpoint.
- Microsoft primary documentation was reviewed before source inspection.
- No #288 implementation source has been inspected or edited at this checkpoint.
- Clean-checkout hosted preflight is the next gate.
