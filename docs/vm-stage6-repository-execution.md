# VM Stage 6 repository execution restoration

Status: implemented restoration contract for DB-020 / issue #114. The physical ownership topology is corrected by issue #138: execution profiles own persistent VMs and repository/profile pairs own isolated workspace routes. Real-provider security and host/guest matrix qualification remain Stage 7 work.

## Outcome

Repository-controlled operations attach to the unchanged Stage-1 `RepositoryExecution` request, transfer, result, and evidence studs. Production composition resolves each admitted repository route to a deterministic workspace target backed by one compatible execution-profile VM whose Stage-2 foundation, Stage-5 preparation, and Stage-4 bridge observations are ready.

Multiple repository workspace targets may therefore resolve to the same physical persistent profile environment without collapsing their repository identities or guest paths. A repository route is not a physical VM ownership record.

There is no direct-host or legacy sandbox fallback. Missing routes, an unavailable foundation, an absent/incompatible profile environment, bridge failure, ambiguous identity, or an active workspace session leaves execution unavailable or fails the request closed.

## LEGO ownership

- `src/runtime/repository-execution.js` owns the closed provider-neutral request/result stud.
- `src/runtime/repository-environment-execution.js` owns only neutral session sequencing, cancellation checks, result classification, and evidence binding.
- `src/runtime/file-tree-transfer.js` owns portable content-addressed tree and delta validation.
- `src/guest/workspace-agent.mjs` owns only guest-local source preparation, local baseline Git, logical operation execution, and candidate collection.
- `src/app/repository-execution.js` is the execution topology edge. It composes foundation, preparation, bridge, route, transfer, and guest-work studs without knowing provider-specific VM details.
- `src/app/execution-profile-routing.js` is the profile/workspace topology edge. It maps stable repository subjects to deterministic workspace targets, maps those targets to profile-owned physical environments, and scopes bridge locations beneath the workspace identity.
- `src/app/runtime-execution.js` maps trusted host worktree identity and locally registered logical tools at the application edge.
- Controller, worker, Git, verification, and publication modules retain their prior contracts and contain no provider or bridge topology.

Connections are transient. A session is opened for one exact source/operation/candidate exchange and owns the selected workspace target for that session. It does not imply ownership of the entire shared physical profile VM. No consumer retains a provider, transport, guest path, or physical environment object.

## Local route policy

Routes are stored under the control-owned state directory at:

`environment-foundation/execution-routes.json`

Example shape:

```json
{
  "protocol": "devbridge/environment-execution-routes-v1",
  "routes": [
    {
      "subject": "123456789",
      "profile": "linux-development",
      "preferred": true,
      "validation": true,
      "access": { "family": "linux" }
    }
  ]
}
```

`subject` is the stable numeric repository identity observed by the trusted host, never a mutable owner/name string. It identifies the repository side of the route; it is **not** the persistent VM owner. `profile` identifies the compatible execution profile. The profile router derives a repository-independent profile subject for physical VM lookup and a deterministic repository+profile workspace identity/target for execution.

A subject may have multiple profiles only when exactly one is preferred. At most one route may be the runtime-validation route. Routes sharing one profile must agree on that profile's guest-access configuration. Host attachment credentials remain route-local composition input and are never placed in an operation descriptor.

Legacy repository-owned persistent-environment records are not silently treated as profile environments merely because their old subject matches a repository route.

## Source synchronization

The trusted host enumerates tracked plus untracked/non-ignored paths with NUL-delimited Git output. `.git` and `.devbridge` are excluded. Files and internal relative symlinks are normalized, bounded, hashed, and represented by a deterministic manifest with content-addressed parts.

The guest receives only this admitted snapshot through input-transfer capabilities scoped to the active workspace. An identical manifest digest takes the fast path and transfers no source parts. A changed snapshot is materialized exactly, then committed to credential-free guest-local Git with no remotes and an empty credential helper. Guest Git is convenience state only.

`git reset --hard <saved-baseline>` plus `git clean -fd` removes prior proposal state before each operation while deliberately preserving ignored dependency/build caches within that repository workspace. The host snapshots again after synchronization and rejects host source drift.

## Candidate return and host authority

After an observed non-timeout/non-abort completion, the guest compares its working state to the saved local baseline and emits a bounded delta. Guest commits do not change the comparison basis.

The host:

1. rechecks the authoritative source digest;
2. validates every portable path, type, size, part digest, whole-file digest, and symlink target;
3. stages returned bytes outside the worktree;
4. rechecks source identity and the active control signal;
5. applies the staged delta without accepting `.git`, `.devbridge`, directories, devices, or traversal;
6. leaves existing host Git validation, sealing, commit, hard-gate, publication, and CAS authority unchanged.

Runtime-validation and tool-documentation probes never import a candidate delta.

## Execution classes

Production runtime wiring routes registered repository-code operations and proposal workers through the repository execution stud. Direct logical tools include Node, CMake, CTest, npm, and npx. Local profiles contribute only a bounded logical tool name; host executable paths are reduced to a safe program basename at the composition edge and are never sent as host paths.

Shipped diagnostic helpers are also selected only by logical identity. Composition reads their trusted runtime resources, binds a digest, stages the bounded bundle through input capabilities, and invokes its environment-local entry location. Neither profile data nor the runner contains a host checkout path.

Dynamic tool documentation probes require an exact task scope and execute through the same stud. Existing control-owned manifests can still be registered without probing.

Static operations independently classified as trusted control-plane/static inspection remain host-side. Provider or profile absence never changes an operation from repository-code to host execution.

## Runtime candidate validation

The trusted supervisor verifies release and artifact identity before execution. It then selects the single local validation route and runs the candidate preflight and full test suite through the same repository execution stud. Validation derives repository identity from the trusted managed checkout rather than embedding a repository/provider name in the validator.

Only bounded result/evidence digests return. The host recomputes the complete runtime artifact digest after the checks; activation is refused if it differs. Daemon drain, post-activation health, and last-known-good rollback remain DB-011 responsibilities.

## Secrets, cancellation, concurrency, and resources

- Credential-shaped and transport-control environment names are rejected by the public request stud.
- Known host control credential values are rejected if embedded in any otherwise admitted operation environment value.
- Guest bridge commands receive no GitHub, SSH, coordination, release, or model/API credentials from the host.
- Adapter modes that require a host secret remain unsupported; Stage 6 does not invent a credential relay.
- Cancellation/fence state is checked before preparation, every transfer boundary, operation start, output collection, staging, and host apply.
- Timeout, guest abort, indeterminate completion, or host abort never imports output/candidate state as success.
- One cross-process exclusive session lock protects each routed workspace target. A conflicting session for that workspace fails closed; a stale lock also fails closed for later explicit recovery rather than guessing ownership.
- Workspace session locking is not a substitute for profile-level resource scheduling or Stage-7 shared-guest qualification.
- Physical profile provisioning performs memory/storage resource admission before allocation, and starting a stopped profile VM performs memory admission before provider startup. Typed shortage failures use `PROFILE_RESOURCES_UNAVAILABLE`.
- Evidence identity binds preparation identity, operation, scope, invocation, routed environment/workspace identity, transfers, limits, and stdin digest.

## Verification and deferred qualification

Stage 6 plus issue #138 tests cover provider-neutral request shape, fail-closed absence, stable route identity, profile identity independent of repository identity, multiple repository routes mapping to one physical profile environment, distinct profiles mapping to distinct physical environments, stable routing across repository add/remove and composition restart, workspace-scoped bridge locations, exact workspace cleanup/reset/reseed targeting, legacy repository-owned environment rejection, startup/provision resource admission, secret rejection, exclusive workspace sessions, source drift, persistent ignored state, bounded candidate staging, cancellation after guest completion, Node/CMake/CTest flows, proposal-worker logical transfers, dynamic tool probing, runtime-candidate isolation, and LEGO vocabulary/dependency boundaries.

These tests prove restoration composition through bridge-shaped fakes and real local tool processes. Stage 7 still owns real Hyper-V and KVM/libvirt provider execution, hostile admin/root shared-guest testing, workspace path/link escape qualification at the claimed boundary, process/result/cache isolation under real provider conditions, host/guest matrix evidence, recovery/resource qualification, and the final security/replaceability acceptance gate.
