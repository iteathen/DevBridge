# DB-008 — Git and Supply-Chain Safety

Status: active

Implementation status: current main already keeps authoritative Git/publication under DevBridge control and suppresses inherited Git/SSH authority. Repository-controlled execution is still routed through the transitional Linux/Bubblewrap host sandbox. DB-020 is normative for the target execution boundary: persistent untrusted repository VMs with normal guest networking and no host credentials.

## Goal

Prevent repository content, dependencies, guest tooling, model output, or remote task text from turning Git, package management, build/test execution, or publication into host authority.

Read this specification with DB-003 and DB-020. Where earlier host-sandbox phase/network assumptions conflict with DB-020's persistent-VM model, DB-020 governs.

## Authoritative Git is host-owned

DevBridge owns the Git state used for provenance, baseline resolution, candidate sealing, recovery, and publication.

Repository guests may have ordinary Git installed and may create or mutate any guest-local Git state. Guest Git is untrusted development state only. It cannot grant or satisfy:

- task/baseline authority;
- authoritative index/worktree/ref state;
- candidate identity;
- publication CAS/predecessor state;
- merge/release authority;
- GitHub authentication.

A guest commit or push is not a DevBridge publication effect.

The host never exposes authoritative `.git` or linked-worktree administrative state as an arbitrary writable guest mount.

## Repository and baseline identity

Remote tasks identify a repository through the trusted task protocol. Local/control-owned policy decides whether that repository is allowed and which semantic baseline channel/ref is valid.

`owner/name` remains useful routing/display metadata. DB-020 Stage 1 owns the durable VM-environment identity and should prefer a verified immutable GitHub numeric repository ID when available so rename/transfer does not silently create or reuse the wrong persistent environment.

For each run, DevBridge resolves an exact host-side baseline commit and records it as authoritative evidence. DB-017 remains normative for later publication-baseline movement, drift, reverification, and explicit expected-head publication CAS.

Repository/controller/guest content cannot choose an arbitrary host local repository path, raw Git ref, remote URL, predecessor SHA, or publication destination as authority.

## Host Git execution rules

Control-plane Git uses locally resolved executables and fixed structured argv with `shell: false`.

Host Git operations must suppress or explicitly control inherited behavior that can execute or redirect through untrusted configuration, including as applicable:

- interactive credential prompting;
- `GIT_ASKPASS` / `SSH_ASKPASS` and inherited SSH-agent authority when not explicitly needed by the control adapter;
- repository/global hooks for control-owned bootstrap/publication operations;
- external diff/textconv/filter/merge helpers where repository configuration could cause execution;
- unsafe protocol/ext transports;
- arbitrary repository-provided aliases or shell commands;
- credential helpers/config selected by repository content rather than local authority.

DevBridge should prefer fixed repository identities/remotes and HTTPS/API flows whose credentials are supplied only to the trusted host adapter that needs them.

A host Git command must never run repository-controlled hooks merely because the repository contains them.

## Source transfer into persistent guests

The target DB-020 workflow separates authoritative host Git from guest development bytes.

Conceptually:

1. the host resolves the trusted repository/baseline/run identity;
2. the host prepares the exact source subject to expose to the repository environment;
3. source/file data crosses the narrow bridge without exposing authoritative host Git administration or host credentials;
4. repository-controlled build/test/tool/model work occurs in the guest;
5. the guest returns candidate files/results/evidence as untrusted data;
6. the host validates the returned subject against the expected run/baseline/source identity;
7. accepted bytes are applied/imported to host-authoritative project state;
8. the host independently verifies/seals the exact candidate and performs any permitted publication.

The exact incremental synchronization, deletion, rename, conflict, and source-drift protocol is owned by VM Stage 6. It must preserve DB-017 identity and fail closed on unexplained divergence rather than allowing a guest to overwrite host Git state through a shared mount.

## Guest Git and remotes

Guest Git is allowed because the entire guest is already untrusted. It may support ordinary developer tooling, local history, diffing, or source workflows.

However:

- guest refs/remotes/config/hooks are never host publication authority;
- the guest does not receive DevBridge's GitHub publication token, host SSH agent, coordination key, or release credential;
- a guest remote URL cannot redirect host Git;
- host sealing never trusts a guest commit SHA without reconstructing/validating the candidate in authoritative host state;
- reset/reseed may discard all guest Git state without losing authoritative repository evidence.

## Dependencies, package managers, builds, and tests

Repository dependency and build/test execution belongs inside the repository VM.

DB-020 intentionally enables normal guest networking by default. Package managers, SDK installers, source fetches, documentation tools, browser/integration tests, coding clients, and build systems may therefore access the network as ordinary guest software when local workload policy allows it.

The security consequence is explicit: anything present in the guest can be exfiltrated by compromised repository code. DevBridge therefore protects host authority by not injecting host secrets into the guest rather than by depending on a default network-denied process sandbox.

Fetched packages, install scripts, compilers, build plugins, generated code, tests, and package lifecycle hooks are all part of the untrusted guest trust domain. A malicious dependency may compromise the persistent repository environment; it must still not gain host Git/publication/control authority.

Persistent dependency/tool/build caches are allowed guest state. They are not trusted merely because they survived earlier successful runs. A host-owned reset/reseed must be able to discard contaminated state and rebuild from a trusted base image plus authoritative source input.

## Private dependencies and authenticated external services

Private-source or authenticated-service support must not be implemented by copying broad host GitHub/SSH/release credentials into a persistent guest.

VM Stage 6 owns the exact mechanism for private repositories, coding/model services, package registries, or other authenticated guest workflows. Any credential relay/scoped token design must be explicit, narrowly bound, revocable where practical, and must not convert guest compromise into host publication/coordination/VM-management authority.

Until such a mechanism exists, a workflow that requires unavailable guest credentials fails closed or reports the missing capability rather than borrowing host control-plane credentials.

## Publication

Publication is a trusted host effect.

Before any task-branch push or later promotion effect, DevBridge rechecks as applicable:

- exact run/task/revision identity;
- host-authoritative repository and baseline identity;
- exact candidate/sealed/verified commit identity;
- DB-017 publication baseline and remote predecessor state;
- DB-016 lease/fence validity;
- DB-007 hard-gate subject/approval when required;
- DB-019 verification evidence validity;
- local publication policy.

Pushes use explicit expected remote state and effect-specific reconciliation under DB-009. Symbolic `HEAD`, blind force, guest remote state, or a model's statement that publication succeeded is not authority.

Remote task text cannot turn ordinary completion into default-branch merge, release, deployment, package publication, tag creation, or another privileged promotion effect unless a separate local policy/contract already grants that class and its hard gates are satisfied.

## DevBridge bootstrap and runtime source

DevBridge's own bootstrap/update Git path is distinct from repository guest execution.

Stage 0/secure bootstrap fixes the DevBridge source repository identity and suppresses inherited Git/SSH authority. DB-011 owns candidate release identity, signed production subjects, artifact digests, activation, and rollback.

Candidate-controlled code must not execute with supervisor authority. The current implementation uses the transitional host sandbox; the DB-020 target routes candidate-controlled validation through a VM isolation boundary while retaining exact host-side release/artifact/activation authority.

## Recovery and ambiguous Git effects

DB-009's observe-and-reconcile-before-repeat rule applies to Git/publication effects.

- Do not delete Git locks or reset worktrees merely because an operation was interrupted.
- Do not adopt guest Git state as the recovery source of truth.
- Re-observe exact host local/remote predecessor state before retrying a publication.
- Preserve failed/uncertain candidate state needed for repair/reconciliation.
- If a guest/source-transfer operation is interrupted, reconcile exact environment/run/source identities before retransmitting or importing candidate bytes.

## Required verification

The VM migration must retain or add evidence for at least:

- repository/controller/guest content cannot select arbitrary host Git executable/config/remote/ref authority;
- authoritative `.git` state is not writable through the guest boundary;
- guest Git commits/remotes are ignored as publication authority;
- source transfer is bound to exact repository/baseline/run identity;
- candidate import detects source/baseline drift and cannot overwrite unrelated host paths;
- host GitHub/SSH/control credentials are absent from the guest even with normal guest network access;
- malicious dependencies/install scripts remain confined to the guest trust domain;
- reset/reseed can discard contaminated guest dependency/Git/build state without losing authoritative host evidence;
- publication still uses exact verified host candidate plus explicit expected remote state and reconciliation;
- runtime candidate validation preserves DB-011 artifact/release authority after it moves to VM execution.

DB-019 governs cost and evidence reuse. VM/security/Git/supply-chain boundary changes remain legitimate qualification triggers even when the required acceptance suite is expensive.
