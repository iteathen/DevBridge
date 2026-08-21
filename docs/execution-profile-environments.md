# Execution-profile VM architecture

Status: active architecture correction for the VM execution program.

This document corrects the earlier repository-owned persistent-VM model. Where active VM documentation describes one persistent VM per repository or per repository/guest profile, that ownership model is superseded by this decision and must be migrated deliberately.

## Governing rule

**Execution profiles own persistent VMs. Repositories own isolated workspaces inside compatible execution-profile VMs.**

A repository is not, by itself, a reason to provision another virtual machine.

Examples of materially distinct execution profiles include:

- `windows`;
- `linux`;
- `windows+cuda`;
- `linux+cuda`;
- another specialized platform/toolchain profile only when its isolation, driver, kernel, licensing, hardware, or compatibility requirements materially require a separate VM.

Profiles are created on demand. Merely discovering or approving another repository must not create or start another VM.

## Why the ownership boundary changes

The repository-per-VM model scales VM count with repository count and duplicates OS state, toolchains, caches, memory reservations, update work, and lifecycle state. Selecting many repositories can therefore turn a harmless repository-management choice into a large resource-allocation event.

The observed setup failure that triggered this correction attempted to start another Hyper-V guest with a 4096 MB reservation while selecting all discovered repositories and failed with host resource exhaustion (`0x800705AA`). The failure is useful evidence that repository selection and VM provisioning were coupled at the wrong architectural boundary.

Adding a RAM preflight alone would make the old design fail more gracefully; it would not fix the ownership error.

## Layered state model

DevBridge separates three kinds of state.

### Execution-profile state

Owned by the profile VM and its provider attachment:

- guest OS and profile identity;
- provider and hardware compatibility;
- VM lifecycle and writable system disk;
- shared installed runtimes/SDKs/toolchains appropriate to the profile;
- shared download caches where safe;
- GPU drivers/runtime where applicable;
- DevBridge guest/bootstrap components;
- profile-level resource policy.

### Repository-workspace state

Owned by one repository workspace inside a compatible profile:

- stable authoritative repository identity and workspace identity;
- source working state delivered by the host;
- repository-local dependency state such as `node_modules`, Python virtual environments, build trees, package-local configuration, and generated output;
- repository-local environment overlay;
- repository-local temporary/build/cache state where sharing would create correctness or trust coupling;
- workspace reset/reseed/cleanup state.

### Task state

Owned by one execution attempt:

- task/run identity;
- process group and cancellation state;
- temporary files;
- bounded inputs/results/evidence;
- task-specific environment overlay;
- operation authority and cleanup state.

A profile VM may survive many repository and task lifetimes. A repository workspace may survive many tasks. Task state remains independently disposable.

## Repository workspace isolation

Sharing a VM does not make repositories one trust domain for writable project state.

Every admitted repository receives a distinct workspace identity and bounded workspace root. Normal repository-controlled execution must be scoped so one repository cannot casually read, write, delete, adopt, or execute through another repository's writable workspace state.

The implementation must define and qualify the workspace boundary explicitly, including:

- canonical workspace-root derivation from stable repository identity;
- write/delete confinement to the active workspace and approved task/profile-owned locations;
- repository-local HOME/TMP/config overlays where needed to prevent accidental cross-project state coupling;
- process ownership/cancellation by task/workspace;
- no cross-workspace relative-path escape or symlink/junction/reparse-point substitution;
- no repository-controlled selection of another workspace identity;
- cleanup/reset targeted to exact owned workspace state;
- cross-repository adversarial qualification.

The VM remains the host-security boundary. Workspace isolation is the correctness and cross-repository boundary inside that untrusted guest and must be strong enough that persistent state from one project does not silently contaminate another.

## Shared versus repository-local state

Share only state whose ownership and compatibility are intentionally profile-level.

Good profile-level candidates include immutable/read-mostly SDKs, compilers, GPU runtime/driver state, and content-addressed download caches that cannot grant one repository authority over another.

Keep mutable project semantics repository-local, including package installs that can execute project hooks, build trees, generated source, repo configuration, local dependency environments, and project-specific credentials or service state.

A global install performed for one repository must not silently become a dependency or mutation surface for every repository in the profile.

## Profile compatibility and routing

Repositories declare or derive compatibility requirements; they do not own a VM.

A repository may be compatible with more than one profile. Routing should use local policy and task requirements, for example:

- compatible profiles: `[windows, linux]`;
- preferred profile: `windows`;
- required capabilities: `cuda`;
- explicit task requirement: `linux+cuda`.

The routing contract must use neutral capability/profile data rather than hard-coding repository names into profile internals.

If no compatible ready profile exists, execution fails/degrades or setup offers to provision one. It must not synthesize a repository-specific VM as an implicit fallback.

## Setup and discovery semantics

Repository discovery and execution-profile provisioning are separate workflows.

`all` in repository selection means **approve/register all selected repositories**, not "create/start one VM for each repository."

Setup should first discover execution-platform capability and existing profile environments, then map approved repositories to compatible profiles. A typical result should be expressible as:

```text
Repositories approved: 15
Ready execution profiles: 1
Additional profiles required now: 0
```

Profile provisioning must be explicit and resource-aware. Before creating or materially resizing a profile VM, setup should show the profile requirement and resource implications.

Profiles that are merely possible but not needed should not be created.

## Resource governance

Resource policy belongs primarily to execution profiles, not repositories.

DevBridge should account for:

- maximum concurrently running profile VMs;
- profile memory and vCPU policy;
- host available memory/storage;
- idle shutdown/suspend policy without discarding persistent profile/workspace state;
- GPU/device exclusivity where relevant;
- per-task/process resource limits inside a running profile where supported.

Repository/task scheduling must not assume that every approved repository has a dedicated RAM reservation.

## Migration from repository-owned VMs

Existing repository-owned environments are migration inputs, not the final architecture.

Migration must be explicit and recoverable:

1. inventory existing environment identity, repository identity, provider/profile, writable state, and readiness;
2. create/select the compatible execution-profile VM;
3. create an isolated repository workspace;
4. migrate only repository-owned state that is safe and useful to preserve;
5. reinstall/reconstruct profile-level system/tool state when that is safer than copying opaque machine state;
6. verify repository workspace/tool/build readiness;
7. retain the old environment until the new workspace is proven usable or the operator elects to discard it;
8. retire only exact DevBridge-owned obsolete VM artifacts.

Do not merge several old writable VM disks into a shared profile disk blindly.

## Provider and LEGO boundaries

Hyper-V and libvirt/QEMU remain provider attachments. They manage execution-profile VM lifecycle and provider-native disk/machine details, not repository identity semantics.

Generic modules should communicate using neutral concepts such as:

- profile identity;
- capability requirements;
- workspace identity;
- workspace root handle;
- task identity;
- lifecycle/resource status.

Provider adapters must not need repository names. Workspace modules must not need Hyper-V/libvirt identities. Repository modules must not assume a particular profile implementation.

## Qualification requirements

The corrected architecture is not complete until tests prove:

- many repositories can use one compatible profile without one VM per repository;
- repository selection `all` does not fan out into VM creation/start operations;
- distinct workspaces cannot mutate each other's writable project state through normal DevBridge execution;
- workspace reset/reseed/cleanup targets only the exact workspace;
- profile restart preserves intended repository workspace state;
- repository addition/removal does not recreate the profile VM unnecessarily;
- material profile requirement changes route to another compatible profile or explicit reprovisioning;
- host resource exhaustion is preflighted for profile creation/start and reported as a profile resource problem, not a repository failure;
- provider failure remains fail-closed with no direct-host fallback;
- authoritative Git/credentials/publication remain host-owned as required by DB-020.

## Migration impact on existing VM program

The following earlier concepts require revision rather than reinterpretation:

- DB-020 references to a repository-centric guest model and a persistent environment per repository/profile;
- issue #107 program language describing persistent per-repository environments;
- completed Stage 3 issue #111 and its repository-owned VM identity/lifecycle assumptions;
- Stage 7 cross-repository qualification, which must now qualify workspace isolation inside a shared profile VM;
- Stage 8 setup language that offers repository VM selection/provisioning;
- setup UX that lists repositories as VM instances.

Implementation should preserve the existing provider/image/bridge/host-authority LEGO work wherever those components remain neutral. The correction should move ownership and routing boundaries rather than rewrite unrelated provider mechanics.
