# DevBridge application management decisions

This file records the architectural decisions that constrain installation, bootstrap, update, setup, and recovery work.

## Decision 1: permanent entry is not the application

The permanent entry is a small, durable host-installed launcher/manager boundary. It is intentionally not the DevBridge runtime itself.

Consequences:

- ordinary DevBridge releases replace managed runtime generations, not the permanent entry;
- permanent-entry changes are rare compatibility/trust changes;
- the permanent entry may survive deletion of the managed runtime;
- the permanent entry cannot depend on the managed runtime to recover that runtime.

Owner: #159.

## Decision 2: runner and runtime are distinct generations

The permanent entry resolves and verifies a runner/bootstrap-manager subject. The runner then establishes the accepted DevBridge runtime.

Consequences:

- runner cache can be deleted and reconstructed independently;
- accepted runtime can be deleted and reconstructed independently;
- stale accepted runtime cannot block access to the compatibility/recovery mechanism that replaces it;
- a moving branch/ref is a selector, never the durable executable identity after resolution.

Owners: #159, #153, DB-011.

## Decision 3: configuration and installation identity are separate from executable payloads

Installation identity and operator-approved configuration are durable local control state, not files owned by one runtime checkout.

Consequences:

- replacing runner/runtime generations preserves installation identity;
- self-update never silently rewrites operator authority;
- uninstall and purge must distinguish executable removal from authority/state destruction;
- full loss of authority/configuration becomes setup re-entry/fresh setup, not automatic guessing.

Owners: #103, #116, DB-003, DB-011.

## Decision 4: accepted runtime owns setup and services

The permanent entry/runner establish application software. The accepted runtime owns guided setup, re-entry, services, and normal DevBridge behavior.

Consequences:

- permanent entry does not grow provider/repository/setup business logic;
- runner does not become a second configuration system;
- setup progress is durable/versioned independently of executable runtime generation;
- ordinary runtime commands do not silently re-enter authority-changing setup.

Owners: #103, #116.

## Decision 5: accepted runtime owns execution-environment reconstruction through lifecycle contracts

The runtime manages VMs/images/guest/bootstrap/workspaces through the environment lifecycle program. It does not require those environments to exist in order to reconstruct them.

Consequences:

- VM/domain and guest system disk are replaceable implementation state;
- local base-image cache is a verified cache, not the only reconstruction source;
- `create`, `rebuild`, `reset`, and `recreate` share one construction pipeline;
- environment failure never falls back to repository-code execution on the host.

Owners: #169–#178, DB-020.

## Decision 6: replacement flows are transactional rather than in-place mutation

Runtime and environment replacement should preserve the current known-good generation until the replacement is verified whenever resource/provider semantics allow it.

Consequences:

- materialize candidate/replacement separately;
- persist intent before consequential mutation;
- switch authority explicitly;
- verify health after the switch;
- retain last-known-good or old implementation until truthful retirement conditions are met;
- if destructive replacement cannot preserve rollback, say so explicitly before the boundary.

Owners: DB-009, DB-011, #169 lifecycle issues.

## Decision 7: whole-stack recovery is an integration requirement

Individual layer recovery is not sufficient evidence.

A configured installation must be able to recover from loss of all replaceable layers beneath the permanent entry while durable local authority remains.

Required composition:

```text
Permanent Entry
  -> Runner
  -> Accepted Runtime
  -> Services
  -> Base Image
  -> Execution Environment
  -> Guest/Bridge/Bootstrap
  -> Workspace Reconstruction
  -> DB-020 Repository Execution
```

A true fresh host with no retained operator authority must instead reconstruct application software and stop at guided setup until the operator re-establishes authority.

Owner: #180, coordinating #159, #153, #116, and #169–#178.

## Decision 8: no recovery layer may absorb neighboring identities

Strict LEGO rules apply to application management as strongly as to VM/provider work.

- Permanent-entry code must not name provider/repository/business identities.
- Runner code must not name VM/provider/setup implementation identities.
- Setup must consume lifecycle interfaces instead of implementing raw provider operations.
- Environment lifecycle must not name permanent-entry/runner implementation identities.
- Provider adapters must not read repository/task/application-management internals.

Composition owns temporary topology.

## Decision 9: JetBrains Toolbox is the primary application-management reference, not an implementation dependency

For installation/update/setup-management ergonomics and ownership separation, **JetBrains Toolbox is the primary external design reference**: a manager/entry experience distinct from managed application versions, version/channel management, side-by-side application preparation, and user state/configuration separate from replaceable application payloads.

For recovery semantics, transactional/last-known-good updater designs such as Chromium-style alternate-generation activation are the secondary reference: prepare replacement away from the active generation, switch authority explicitly, verify health, and retain a truthful known-good recovery path when possible.

Consequences:

- DevBridge should feel like a manager of its replaceable runtime rather than a monolithic checkout that mutates itself in place;
- configuration and installation identity stay outside the managed runtime payload;
- new runtime generations are prepared before activation;
- rollback/LKG claims must be backed by exact durable evidence rather than UI convention;
- the permanent entry remains much smaller and more stable than the managed application runtime;
- DevBridge security, DB-009/DB-011 recovery, and LEGO contracts override any external product behavior that conflicts with them.

These products are design references only. DevBridge must not depend on their software, file layouts, update services, APIs, or trust models, and no external product is normative authority for DevBridge behavior.
