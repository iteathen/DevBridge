# DevBridge bootstrap launcher

`devbridge.mjs` is the canonical stage-0 launcher for DevBridge on a machine with Node.js 22.16.0+ and Git.

Stage 0 is intentionally small. It establishes the fixed managed DevBridge checkout needed to reach the secure bootstrap; the managed bootstrap provides the full operator CLI. Stage 0 does not replace the supervisor's candidate-validation, activation, rollback, or VM-provider authority.

For the shortest installation path, see `docs/setup.md`.

## Stage-0 boundary

The downloaded launcher uses only Node.js built-ins plus the local `git` executable. It:

1. enforces the supported Node.js version;
2. parses the bounded local command/channel/home/config switches needed to reach the managed bootstrap;
3. defaults the home to `~/.devbridge`;
4. creates private bootstrap Git HOME/hooks directories;
5. suppresses inherited Git/SSH authority and interactive credential prompting;
6. on this disposable fast branch, shallow-clones fixed `https://github.com/iteathen/DevBridge.git` branch `codex/temp-fast-functional` into the managed runtime;
7. verifies origin and clean checkout shape;
8. verifies `package.json` identifies `devbridge`, verifies the declared stage-0 protocol, and verifies the managed secure-bootstrap module exists;
9. performs a one-time, clean, exact fast-forward compatibility transition for an older pre-protocol managed checkout, with a lock, durable intent, and rollback ref; and
10. transfers control to managed secure bootstrap.

The compatibility transition exists because older disposable installs cannot reach the current secure updater. It accepts only the fixed repository/branch, exact remote head, clean checkout, required stage-0 protocol, and fast-forward ancestry. Ordinary runtime updates remain behind DB-011's candidate-validation boundary. The accepted managed runtime refreshes only the canonical installed launcher at `~/.devbridge/bin/devbridge.mjs`, so the loader follows a validated activation instead of remaining stale.

`--no-update` requires an existing managed runtime; it cannot bootstrap an empty home.

## What stage 0 does not authorize

The standalone stage-0 layer does not:

- enable repository execution;
- infer trusted task actors from collaborators;
- enable model adapters;
- provision repository environments by itself;
- silently install/configure Hyper-V, KVM, QEMU, or libvirt;
- create provider-managed VMs/domains/images/networks;
- expose host credentials to repository code;
- create publication authority;
- activate an unverified runtime candidate.

Those remain secure-bootstrap/supervisor/local-policy concerns.

## Current execution-provider transition

DB-020 defines the target repository-code boundary: persistent untrusted VMs with two required initial host providers:

- Windows -> Hyper-V;
- Linux -> KVM/QEMU managed through libvirt.

Stages 0–6 are implemented on the VM migration stack.

- Stage 1 removed active host-sandbox repository execution on every host.
- Stage 2 implements the host management, immutable base-image, owned network, and owned storage foundation for both required provider families.
- Repository-code/candidate-controlled execution routes only through an admitted ready persistent environment; absence remains fail-closed on both Windows and Linux.
- Draft PR #106's ProcessContainer/AppContainer work is superseded by the VM program.

The completed Stage-1-through-Stage-5 interval kept untrusted execution unavailable/fail-closed. Stage 6 restores it through VM providers only; `docs/vm-stage6-repository-execution.md` defines the route and transfer contract.

The stage-0 launcher does not contain direct-host execution or provider provisioning logic. The disposable managed setup currently exposes the already-proved Windows/Hyper-V fast path; VM Stage 8 still owns the supported, provider-complete Windows/Linux setup/reconfiguration design for `main`.

## Managed secure bootstrap

Managed bootstrap owns local initialization/update preparation, including:

- private DevBridge home/runtime/state/config locations;
- canonical config-example materialization on first install;
- home-relative state/workspace defaults so a custom `--home` cannot accidentally share the default installation's mutable roots;
- discover-before-select repository and candidate task-author setup;
- explicit channel selection (`testing` or `stable`);
- explicit persistent-environment selection and execution opt-in;
- a completion record that prevents normal launches from re-entering setup;
- headless background start plus explicit foreground daemon mode and bounded logs;
- `doctor` update availability and an explicit `update` path;
- an install manifest covering created/adopted local and provider artifacts;
- manifest-driven app-only and purge uninstall modes protected by exact `REMOVE` confirmation;
- repository/origin/runtime-shape verification;
- update-policy selection from local configuration;
- handoff to supervisor/CLI after local prerequisites are checked.

Self-update does not rewrite ordinary operator policy. The disposable bootstrap performs one explicit, bounded configuration migration from the former singular queue key to `github.queueRepositories`, preserving an exact backup. Setup changes local policy only when explicitly invoked or when no completed setup record exists.

Managed setup invokes separately owned provider setup/provisioning adapters. Repository/controller text never becomes Hyper-V/libvirt/QEMU/image/host-path authority.

## CLI workflow

Running the launcher with no command defaults to CLI-driven, windowless `start`. A fresh install enters setup first; after setup completes, normal commands cannot re-enter it unless `setup` or `--setup` is supplied.

```text
node ~/.devbridge/bin/devbridge.mjs setup
node ~/.devbridge/bin/devbridge.mjs doctor
node ~/.devbridge/bin/devbridge.mjs update
node ~/.devbridge/bin/devbridge.mjs                 # headless start
node ~/.devbridge/bin/devbridge.mjs daemon          # foreground supervisor
node ~/.devbridge/bin/devbridge.mjs status
node ~/.devbridge/bin/devbridge.mjs logs
node ~/.devbridge/bin/devbridge.mjs stop
```

Noninteractive setup uses repeated `--repository`, repeated `--trusted-author`, repository-discovery selection, explicit environment/execution switches, and exact `--confirm APPLY` for repository/task-author authority changes. Repository discovery happens before choices are displayed. Interactive selection supports whitespace/comma multi-select, `all` repositories, `self`, discovered or custom GitHub logins, and custom `owner/name` repositories. Custom entries are accepted only after authenticated GitHub lookup returns the same canonical identity; invalid input returns to the prompt. GitHub collaborator results are candidates only, and the warning/confirmation screen binds the final grant to canonical repository identities and immutable numeric actor IDs.

The current automatic VM provisioning shortcut is Windows/Hyper-V-only and requires an already published `linux-development` base plus validation route. Unsupported or unready providers remain poll-only/fail-closed; setup does not redirect work to the host. `daemon` is the explicit foreground/show-output mode. VM consoles remain hidden unless an operator separately invokes the diagnostic `Show` action.

## Uninstall and manifest

Setup records exact paths, repository-environment identities/subjects, state roots, and referenced image identities in `install-manifest.json`. Uninstall refuses to act without that manifest.

```text
node ~/.devbridge/bin/devbridge.mjs uninstall --app-only --confirm REMOVE
node ~/.devbridge/bin/devbridge.mjs uninstall --purge --confirm REMOVE
```

App-only removal preserves configuration, state, setup policy, and VMs. Purge re-observes exact provider ownership/compatibility before deleting a VM. Referenced base images are retained unless the manifest proves the installer created them, images still referenced by retained environments are protected, and external state/workspace roots are reported for separate cleanup rather than recursively deleted. After exact targets are gone, canonical parent directories are pruned only when empty; unknown contents prevent pruning.

## Runtime update authority

DB-011 remains normative.

The supervisor, not stage 0, owns:

- development/testing versus production release policy;
- signed production release manifests/public keys;
- candidate repository/head/version/artifact identity;
- untrusted candidate execution admission;
- daemon drain;
- activation/health checking;
- last-known-good rollback.

A mutable branch is transport, not production release authority.

## Candidate-controlled validation

Before acceptance, candidate code is untrusted executable input.

The former host Bubblewrap candidate-validation path was removed in Stage 1 with the rest of the sandbox architecture.

Stage 6 restores candidate execution through the single locally admitted provider-native VM validation route. Missing route/provider/environment readiness remains unavailable/fail-closed. This does **not** weaken DB-011 release integrity: exact candidate identity, signature/digest checks, last-known-good, activation gates, and rollback remain authoritative.

- Hyper-V validation environment on Windows hosts;
- KVM/QEMU/libvirt validation environment on Linux hosts.

VM validation sequence:

1. host/supervisor resolves and hashes exact candidate artifact;
2. production signature/repository/head/version/digest checks occur on the trusted host before candidate code executes;
3. the accepted daemon enters its token-bound cooperative safe-boundary pause, releasing active VM lifecycle/session ownership while remaining the last-known-good process;
4. supervisor verifies the host provider + validation environment;
5. exact candidate subject is transferred into the untrusted VM without arbitrary host mounts or control credentials;
6. candidate-controlled preflight/tests execute there;
7. bounded evidence returns through the host-controlled bridge;
8. host rechecks exact candidate artifact identity;
9. rejection resumes the accepted daemon; success alone requests its cooperative stop and activates the candidate;
10. post-activation health/`doctor` remains separate acceptance evidence;
11. rollback keeps previous exact runtime available until candidate is healthy.

The candidate validation VM may be dedicated/reseedable instead of a persistent project VM as long as DB-020's trust partition is preserved.

Provider absence never authorizes direct/uncontained candidate execution on the host.

## Provider setup ownership

Stage 8 must keep provider setup separate from the minimal downloaded launcher.

Windows setup may discover/prepare DevBridge-owned Hyper-V images/environments without casually changing operator-owned Hyper-V infrastructure.

Linux setup may discover/prepare KVM/QEMU/libvirt images/environments without casually removing/changing shared libvirt services, domains, storage pools, networks, or system virtualization policy.

Provider readiness is observed, not inferred from installation/presence.

## Development/testing versus production

Development mode follows `codex/temp-fast-functional` as the explicit disposable testing channel on this branch. Stable production transport remains `main`.

Production requires an independently signed immutable release subject binding fixed repository identity, exact Git head, package version, and exact runtime artifact digest.

VM execution does not change those release-integrity rules. A guest test pass does not sign or approve a candidate.

During the no-provider interval, an executable candidate that cannot satisfy required validation remains unaccepted rather than being tested directly on the host.

## Daemon control

`status`, `pause`, `resume`, `stop`, and `restart` remain host control operations.

Pause is cooperative admission control, not OS thread/process/VM suspension. Stop has precedence over pause.

A provider/environment may persist while the daemon is paused/stopped; persistent repository disks are not cleanup side effects of daemon control.

## Trust-boundary summary

- Runtime repository identity is fixed in launcher/control code.
- Remote content cannot select release mode, update channel, signing material, runtime root, host provider, base image path, VM/domain name, libvirt XML, QEMU argv, PowerShell management snippet, operator config, executable, environment authority, or credential source.
- Bootstrap Git suppresses inherited Git/SSH authority, hooks, interactive prompting, and dangerous transports.
- Operator config/activation/provider-management state remains outside untrusted candidate visibility.
- No production execution provider means untrusted executable candidate/repository work is unavailable; it does not authorize direct host execution.
- Last-known-good is not drained until candidate passes pre-activation integrity + required verified execution-environment checks.
- Development mutable-channel following remains explicitly alpha.
- Production unattended deployment requires an independently signed immutable release subject plus verified candidate VM isolation where executable candidate validation is required.

## Related docs/specs

- `docs/setup.md`: installation/current-vs-target behavior.
- `docs/architecture.md`: provider/VM/bridge/control-plane model.
- `docs/vm-migration.md`: sandbox-first removal/retention inventory.
- `docs/vm-lego-studs.md`: connection-stud/replaceability plan.
- DB-003: local capability/security authority.
- DB-008: Git/supply-chain boundary.
- DB-009: durable effects/recovery.
- DB-011: runtime supervision/release integrity.
- DB-013: deterministic controller plans.
- DB-018: workstation governance/pause.
- DB-020: persistent VM execution boundary.
