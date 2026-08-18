# PP-008 — Git and Supply-Chain Execution Boundary

Status: active

Implementation status: partially implemented in v0.1; the managed Git boundary is implemented, while package-manager phase isolation remains a hardening requirement.

## Goal

Treat Git, package managers, build systems, repository configuration, dependency hooks, and caches as executable trust boundaries rather than harmless plumbing.

A coding model is not the only thing capable of executing code. A repository can cause execution through hooks, filters, dependency lifecycle scripts, compiler/build plugins, test configuration, browser tooling, submodules, credential helpers, or other tool integrations.

## Governing rule

**No tool becomes trusted merely because it is conventional development infrastructure.**

Remote repository content may describe desired development behavior, but only locally configured PATCH-POLLER policy grants filesystem, credential, network, or execution authority.

## Managed Git boundary

PATCH-POLLER-owned Git operations must use a dedicated Git adapter rather than inheriting the operator's interactive Git environment.

The adapter must, where supported:

- use a synthetic PATCH-POLLER home/config root;
- disable system/global Git configuration inheritance;
- disable Git hooks for control-plane Git operations;
- disable inherited credential helpers;
- disable interactive credential prompting;
- avoid inheriting SSH agents, signing keys, or interactive terminal state unless a local policy explicitly requires them;
- deny `ext` and other arbitrary-command transport mechanisms;
- keep `file` transport disabled in production and enable it only for deliberate local fixtures or a locally trusted use case;
- prefer explicitly configured HTTPS remotes for the reference GitHub adapter;
- pass credentials through a narrow Git adapter boundary rather than model-visible argv or environment inheritance;
- verify the managed repository's expected remote identity before reuse;
- serialize Git operations for a managed repository/worktree.

The v0.1 `GitClient` implements the synthetic home, system-config suppression, hook suppression, credential-helper suppression, non-interactive behavior, protocol restrictions, bounded execution, and token-scoped HTTP header path.

## Repository-controlled Git features

The following are disabled or unsupported by default until an explicit capability is implemented and tested:

- recursive submodule initialization/update;
- Git LFS downloads/uploads;
- arbitrary custom Git transports;
- repository-specific credential helpers;
- custom hooks;
- locally configured clean/smudge/process filters that execute commands;
- automatic signing with host/user keys.

A repository may contain `.gitmodules`, `.gitattributes`, or other metadata. Their presence is data, not a capability grant.

## Checkout and candidate integrity

PATCH-POLLER runtime exchange data is not project source. The reserved `.patch-poller/` runtime directory must be excluded from ordinary candidate changes, and a candidate that force-adds reserved runtime files must be rejected.

Before publication, candidate changes must be sealed into a deterministic task-branch commit owned by PATCH-POLLER. Publication must not rely on uncommitted working-tree state.

The persisted run baseline SHA is immutable for the run. A later fetch may update remote-tracking refs but must not redefine what commit the active task started from.

## Dependency and build phases

Future package-manager integration must distinguish at least these capability phases:

1. dependency discovery/fetch;
2. dependency installation/materialization;
3. build/compile;
4. test/verification;
5. browser/loopback integration testing;
6. publication.

Each phase may have a different network, filesystem, credential, cache, and process policy. `npm install`, `npm ci`, package lifecycle scripts, compiler plugins, test runners, Playwright configuration, and analogous tools are arbitrary-code execution from the control plane's perspective.

## Network policy

Dependency download and model access may require network access; ordinary build/test code should not receive unrestricted egress merely because provisioning did.

Where platform containment supports it, PATCH-POLLER should use phase-scoped network profiles such as:

- model/control traffic: only endpoints needed by the configured coding tool;
- dependency fetch: configured registries and source hosts;
- build/test: denied by default;
- browser integration: loopback plus explicitly required test endpoints;
- publication: GitHub only.

A declaration in configuration is not enforcement. PP-003 remains authoritative about honest sandbox claims.

## Cache policy

Writable caches can become persistence and cross-project contamination channels.

When caches are introduced they must be:

- scoped by trust domain and tool/package-manager identity;
- writable only where local policy permits;
- disposable/rebuildable where practical;
- excluded from candidate commits;
- never treated as an authority source;
- invalidated when a compatibility/security boundary changes.

High-risk caches may need per-run isolation rather than sharing.

## Lockfiles and reproducibility

Where the target ecosystem provides lockfiles, PATCH-POLLER should prefer locked/reproducible installation modes for verification. An agent may propose a lockfile change, but that change is project code and is reviewed/validated like any other candidate modification.

## Required tests

Before a feature is claimed as enforced, tests must cover relevant bypasses, including:

- inherited Git config/credential helper does not execute;
- hooks do not execute during control-plane Git operations;
- forbidden Git transport is rejected;
- runtime exchange files cannot enter a sealed candidate;
- immutable run baseline survives a later upstream fetch;
- uncommitted candidate edits are sealed before publication;
- package/build phases cannot silently inherit broader network or credential authority than configured.

## v0.1 boundary

v0.1 implements the managed Git portion of this contract and validates it with local Git fixtures. It does **not** yet provide a first-class package-manager phase controller. A coding CLI may invoke package/build/test tools inside its declared sandbox; that does not mean PATCH-POLLER has independently verified those commands or isolated dependency phases yet.
