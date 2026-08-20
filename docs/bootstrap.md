# DevBridge bootstrap launcher

`devbridge.mjs` is the canonical stage-0 launcher for DevBridge on a machine with Node.js 22.16.0+ and Git.

Stage 0 is intentionally small. It establishes the fixed managed DevBridge checkout needed to reach the secure bootstrap; it does not replace the supervisor's candidate-validation, activation, rollback, or VM-provider authority.

For the shortest installation path, see `docs/setup.md`.

## Stage-0 boundary

The downloaded launcher uses only Node.js built-ins plus the local `git` executable. It:

1. enforces the supported Node.js version;
2. parses only local bootstrap arguments needed to resolve the DevBridge home;
3. defaults the home to `~/.devbridge`;
4. creates private bootstrap Git HOME/hooks directories;
5. suppresses inherited Git/SSH authority and interactive credential prompting;
6. on a fresh home, shallow-clones fixed `https://github.com/iteathen/DevBridge.git` `main` into the managed runtime;
7. verifies origin and clean checkout shape;
8. verifies `package.json` identifies `devbridge` and the managed secure-bootstrap module exists; and
9. transfers control to managed secure bootstrap.

If a managed runtime already exists, stage 0 verifies it and transfers control without replacing it. Ordinary runtime updates remain behind DB-011's candidate-validation boundary.

`--no-update` requires an existing managed runtime; it cannot bootstrap an empty home.

## What stage 0 does not authorize

The standalone launcher does not:

- enable repository execution;
- choose trusted task actors;
- enable model adapters;
- choose repository VM environments;
- install/configure Hyper-V, KVM, QEMU, or libvirt;
- create provider-managed VMs/domains/images/networks;
- expose host credentials to repository code;
- create publication authority;
- activate an unverified runtime candidate.

Those remain secure-bootstrap/supervisor/local-policy concerns.

## Current execution-provider transition

DB-020 defines the target repository-code boundary: persistent untrusted VMs with two required initial host providers:

- Windows -> Hyper-V;
- Linux -> KVM/QEMU managed through libvirt.

That target is not yet implemented in current main.

- Current Linux repository-code/candidate-controlled execution uses the transitional verified Bubblewrap provider when available.
- Current Windows repository-code/candidate-controlled execution remains fail-closed on main.
- Draft PR #106's ProcessContainer/AppContainer work is superseded by the VM program.

The stage-0 launcher must not grow provider provisioning logic merely because execution architecture changed. VM Stage 8 owns supported Windows/Linux provider setup/reconfiguration after lower provider/image/environment/bridge stages exist.

## Managed secure bootstrap

Managed bootstrap owns local initialization/update preparation, including:

- private DevBridge home/runtime/state/config locations;
- canonical config-example materialization on first install;
- repository/origin/runtime-shape verification;
- update-policy selection from local configuration;
- handoff to supervisor/CLI after local prerequisites are checked.

Existing operator configuration is not silently rewritten during self-update.

When VM support lands, bootstrap/setup may invoke separately owned provider setup/provisioning adapters, but repository/controller text never becomes Hyper-V/libvirt/QEMU/image/host-path authority.

## Runtime update authority

DB-011 remains normative.

The supervisor, not the standalone launcher, owns:

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

Current main verifies a host Bubblewrap sandbox and executes candidate preflight/tests there. That is transitional behavior.

The DB-020 target is provider-native VM validation:

- Hyper-V validation environment on Windows hosts;
- KVM/QEMU/libvirt validation environment on Linux hosts.

Target sequence:

1. host/supervisor resolves and hashes exact candidate artifact;
2. production signature/repository/head/version/digest checks occur on the trusted host before candidate code executes;
3. supervisor verifies the host's provider + validation environment;
4. exact candidate subject is transferred into the untrusted VM without arbitrary host mounts or control credentials;
5. candidate-controlled preflight/tests execute there;
6. bounded evidence returns through the host-controlled bridge;
7. host rechecks exact candidate artifact identity;
8. only then may the supervisor drain/activate the candidate;
9. post-activation health/`doctor` remains separate acceptance evidence;
10. rollback keeps previous exact runtime available until candidate is healthy.

The candidate validation VM may be dedicated/reseedable instead of a persistent project VM as long as DB-020's trust partition is preserved.

## Provider setup ownership

Stage 8 must keep provider setup separate from the minimal downloaded launcher.

Windows setup may discover/prepare DevBridge-owned Hyper-V images/environments without casually changing operator-owned Hyper-V infrastructure.

Linux setup may discover/prepare KVM/QEMU/libvirt images/environments without casually removing/changing shared libvirt services, domains, storage pools, networks, or system virtualization policy.

Provider readiness is observed, not inferred from installation/presence.

## Development/testing versus production

Development mode may follow the locally selected mutable testing channel as explicit alpha behavior.

Production requires an independently signed immutable release subject binding fixed repository identity, exact Git head, package version, and exact runtime artifact digest.

VM execution does not change those release-integrity rules. A guest test pass does not sign or approve a candidate.

## Daemon control

`status`, `pause`, `resume`, `stop`, and `restart` remain host control operations.

Pause is cooperative admission control, not OS thread/process/VM suspension. Stop has precedence over pause.

A provider/environment may persist while the daemon is paused/stopped; persistent repository disks are not cleanup side effects of daemon control.

## Trust-boundary summary

- Runtime repository identity is fixed in launcher/control code.
- Remote content cannot select release mode, update channel, signing material, runtime root, host provider, base image path, VM/domain name, libvirt XML, QEMU argv, PowerShell management snippet, operator config, executable, environment authority, or credential source.
- Bootstrap Git suppresses inherited Git/SSH authority, hooks, interactive prompting, and dangerous transports.
- Operator config/activation/provider-management state remains outside untrusted candidate visibility.
- Last-known-good is not drained until candidate passes pre-activation integrity + verified execution-environment checks.
- Development mutable-channel following remains explicitly alpha.
- Production unattended deployment requires an independently signed immutable release subject plus verified candidate VM isolation.

## Related docs/specs

- `docs/setup.md`: installation/current-vs-target behavior.
- `docs/architecture.md`: provider/VM/bridge/control-plane model.
- `docs/vm-migration.md`: legacy-removal inventory and hard gates.
- DB-003: local capability/security authority.
- DB-008: Git/supply-chain boundary.
- DB-009: durable effects/recovery.
- DB-011: runtime supervision/release integrity.
- DB-013: deterministic controller plans.
- DB-018: workstation governance/pause.
- DB-020: persistent VM execution boundary.
