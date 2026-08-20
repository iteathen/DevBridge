# DevBridge setup

DevBridge is installed from one standalone stage-0 launcher and then keeps its managed runtime current through the secure supervisor.

## Current implementation versus VM target

DB-020 defines the target repository-execution architecture: a trusted DevBridge controller on the host plus persistent, networked repository VMs. The first target deployment is a Windows host using Hyper-V with persistent Windows and Linux guest environments.

That VM path is **not implemented yet**. The VM program is staged by issues #107 through #117.

Current main still behaves as follows:

- Linux can execute supported untrusted proposal-worker/repository-code workloads only when the legacy Bubblewrap provider is installed and verified.
- Windows can run installation/configuration/static/control-plane operations, but current-main repository-code execution remains fail-closed.
- Draft PR #106's Windows ProcessContainer/AppContainer work is superseded migration evidence and is not the supported target.

Do not install or configure Hyper-V expecting current main to use it yet. VM Stage 8 (#116), coordinated with setup/reconfiguration issue #103, will add the supported Hyper-V discovery/provisioning/migration flow after the lower VM stages are implemented and qualified.

## Current requirements

- Node.js 22.16.0 or newer
- Git
- a GitHub account with access to the configured task queue and target repositories
- Linux + Bubblewrap only when using the current transitional untrusted-execution path

Future Hyper-V requirements will be documented by Stage 8 after the provider/image/environment/bridge contracts are real. Setup must not infer VM readiness merely from the presence of Hyper-V.

## Fresh install

### Linux

```sh
mkdir -p "$HOME/.devbridge/bin" && curl -fsSL https://raw.githubusercontent.com/iteathen/DevBridge/main/devbridge.mjs -o "$HOME/.devbridge/bin/devbridge.mjs" && node "$HOME/.devbridge/bin/devbridge.mjs"
```

### Windows PowerShell

```powershell
New-Item -ItemType Directory -Force "$HOME\.devbridge\bin" | Out-Null; Invoke-WebRequest "https://raw.githubusercontent.com/iteathen/DevBridge/main/devbridge.mjs" -OutFile "$HOME\.devbridge\bin\devbridge.mjs"; node "$HOME\.devbridge\bin\devbridge.mjs"
```

The launcher uses only Node.js built-ins and local Git to establish/verify the fixed managed DevBridge runtime. It does not silently enable repository execution.

On a fresh home, the managed secure bootstrap creates the safe example configuration and exits. Review local authority before enabling anything.

Then use:

```text
node ~/.devbridge/bin/devbridge.mjs doctor
node ~/.devbridge/bin/devbridge.mjs
```

PowerShell users can use `$HOME\.devbridge\bin\devbridge.mjs` in the same commands.

## Current Linux Bubblewrap prerequisite

This section describes **transitional current-main behavior**, not the DB-020 target architecture.

Linux hosts that enable current repository-code/proposal-worker execution need a working Bubblewrap installation whose user-namespace/AppArmor policy permits DevBridge's verification probe.

Distribution packaging varies. Install Bubblewrap/AppArmor through the operator's normal system administration mechanism; do not let repository tasks install or weaken the host isolation provider.

`doctor` must report the observed provider state. A configured provider name or installed `bwrap` executable alone is not proof of enforcement.

After VM Stage 9 removes the legacy sandbox path, this prerequisite will disappear from the target repository-execution setup.

## Configuration authority

The canonical checked-in example is:

```text
config/devbridge.example.json
```

Fresh configuration keeps execution, model adapters, coordination, dynamic tool onboarding, and automatic task-branch publication conservative/off by default.

Review at least:

- `github.queueRepository`
- `github.trustedActorIds`
- `workspace.allowedOwners`
- `workspace.baselineChannels`
- `execution.*`
- `execution.decisionAuthorities`
- `coordination.*`
- `publication.*`
- local tool profiles/credentials

`workspace.externalReadRoots`, proposal profile `sandbox.*`, and `execution.allowUncontainedTools` are part of the current host-sandbox-era configuration surface. They remain for migration compatibility until VM Stage 8 defines exact config migration and Stage 9 removes/deprecates obsolete semantics. They are not the DB-020 target mechanism for giving repository tools access to host files.

Existing operator configuration is never silently rewritten during self-update.

## Execution remains opt-in

Setting `execution.enabled` is local machine authority. Task text cannot enable it.

Current main must still fail closed if a requested repository-code execution class lacks the provider it actually implements and verifies.

Future VM-backed execution will similarly require observed provider/base-image/repository-environment/bridge readiness before DevBridge reports repository execution usable. A Hyper-V feature flag, image path, or VM name will not be enough.

## GitHub authentication

GitHub credentials are host control-plane authority under DB-003/DB-008.

DevBridge may use configured environment-variable providers or the current GitHub CLI credential for the configured hostname. Token values are not serialized into config/status/run state and are not forwarded to repository execution.

Under DB-020 the repository guest normally has network access, so host GitHub/SSH/publication credentials must remain absent from the guest. Private dependency/coding-service support will require explicit later scoped mechanisms rather than copying the host token into a persistent VM.

## Persistent VM setup target

When VM Stage 8 lands, setup/reconfiguration must support a discover-before-prompt flow rather than asking the operator for facts DevBridge can safely determine itself.

The target flow should:

1. inspect the local platform/Hyper-V capability and current DevBridge state;
2. discover/suggest repositories already authorized through local/GitHub context where possible;
3. propose Windows/Linux guest profiles and required immutable base images;
4. show what capabilities will become available and what local host changes are required;
5. require explicit operator approval before enabling or provisioning authority-bearing changes;
6. verify provider/image/environment/bridge readiness;
7. allow re-entering setup later to add/remove/change repositories, guest OS profiles, images, or capability policy.

Do not blindly prompt for repository names, paths, or provider details that can be safely discovered and verified. Do not auto-enable discovered capabilities merely because they exist.

## Runtime updates

Stage 0 establishes only the fixed managed checkout needed to reach the secure supervisor.

DB-011 owns update policy, signed production release subjects, exact runtime artifact identity, candidate validation, daemon drain, activation health, and rollback.

Current main runs candidate-controlled validation behind the transitional verified host sandbox. DB-020 targets VM-isolated candidate execution. Until that migration lands, Windows current-main cannot pretend candidate VM validation exists.

## Operator control

Canonical commands include:

```text
devbridge doctor
devbridge poll-once
devbridge run-once
devbridge daemon
devbridge status
devbridge pause
devbridge resume
devbridge stop
devbridge restart
devbridge handoff-status
devbridge handoff-seed
devbridge handoff-project
```

`pause` is cooperative task-admission pause at a safe cycle boundary, not an unsafe process/VM freeze. `stop` takes precedence.

Future VM lifecycle commands/setup surfaces must preserve persistent repository disk state unless an explicit reset/reseed/delete action is authorized.

## Troubleshooting principle

`doctor` reports observed capabilities, not aspirations.

- On current main, expect Bubblewrap verification for supported Linux repository execution and fail-closed Windows repository execution.
- During the VM program, do not interpret partial Hyper-V/image files as completed DB-020 support.
- After Stage 7/8, expect exact VM provider/image/environment/bridge readiness evidence.

See `docs/roadmap.md` for staging and `docs/vm-migration.md` for legacy-removal blockers.
