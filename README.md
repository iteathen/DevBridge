# DevBridge

**Safely bridge remote coding controllers and agents to a locally controlled development environment.**

DevBridge is a local Node.js control plane. Remote content may request development work, but DevBridge retains machine authority: provenance, capability policy, workspace state, execution admission, verification, leases/fencing, publication, runtime activation, and recovery remain locally controlled.

## What DevBridge does

Current mainline capabilities include:

- exact trusted GitHub task, feedback, and decision provenance using numeric actor IDs plus edit-history verification;
- managed Git repositories and isolated task worktrees;
- deterministic controller plans and locally registered build/test/tool operations;
- optional coding-model adapters, disabled by default;
- verified Linux/Bubblewrap and Windows/ProcessContainer containment for untrusted proposal workers and repository-code execution;
- durable run state, bounded context handoffs, restart recovery, and reconciliation;
- DB-007 checkpoint-and-proceed human gates for consequential decisions;
- candidate sealing and exact-head task-branch publication;
- persistent Ed25519 installation identity, signed multi-agent leases, TTL recovery, and fencing;
- fast-forward baseline reconciliation with mandatory post-drift reverification;
- supervised self-update with isolated candidate validation, safe daemon drain, health checking, and rollback;
- cooperative `pause` / `resume` and below-normal child-process priority;
- serialized task admission: effective task concurrency is currently one.

## Security model

**Remote content requests work; it does not create machine authority.**

Remote task text, repository content, dependencies, model output, tool documentation, and process output cannot grant executable paths, shell authority, arbitrary local paths, environment secrets, credentials, network capability, sandbox exceptions, trusted actors, peer keys, Git-ref authority, or decision authority.

`github.trustedActorIds` is a runner-local **remote development-job submission allowlist**, not a generic collaborator list. Task-author trust, decision authority, and coordination-peer trust are separate local policies.

Untrusted proposal-worker and repository-code execution requires a verified outer OS sandbox. Linux uses Bubblewrap. Windows uses a ProcessContainer provider through a pinned Microsoft MXC runtime. A provider is not trusted merely because it is installed: DevBridge enables repository-code execution only after its own live filesystem/control-state/Git/network/process-tree boundary probe passes on that host.

## Install

Requirements: Node.js 22.16.0 or newer and Git. Linux machines that execute untrusted project code also need Bubblewrap. Windows sandbox prerequisites are provisioned automatically by the stage-0 launcher into the DevBridge-owned home.

### Linux

Copy/paste this command:

```sh
mkdir -p "$HOME/.devbridge/bin" && curl -fsSL https://raw.githubusercontent.com/iteathen/DevBridge/main/devbridge.mjs -o "$HOME/.devbridge/bin/devbridge.mjs" && node "$HOME/.devbridge/bin/devbridge.mjs"
```

### Windows PowerShell

Copy/paste this command:

```powershell
New-Item -ItemType Directory -Force "$HOME\.devbridge\bin" | Out-Null; Invoke-WebRequest "https://raw.githubusercontent.com/iteathen/DevBridge/main/devbridge.mjs" -OutFile "$HOME\.devbridge\bin\devbridge.mjs"; node "$HOME\.devbridge\bin\devbridge.mjs"
```

`devbridge.mjs` is a standalone stage-0 launcher. It uses only Node.js built-ins and the local `git` executable, materializes the fixed `iteathen/DevBridge` runtime under `~/.devbridge`, verifies the managed checkout/package shape, and then transfers control to the managed secure bootstrap. On Windows it also ensures the pinned ProcessContainer helper runtime is present under the DevBridge home; it does not add dependencies or generated files to the managed source checkout.

On a fresh install, the managed bootstrap creates `~/.devbridge/config.json` from the safe example and exits. It does **not** silently enable execution. Review the local authorities first, then run:

```text
node ~/.devbridge/bin/devbridge.mjs doctor
node ~/.devbridge/bin/devbridge.mjs
```

PowerShell users can use `$HOME\.devbridge\bin\devbridge.mjs` in the same commands. On Windows, `doctor` must report `windows-processcontainer`, `verified: true`, and repository-code execution available before untrusted repository/model work is admitted. If provisioning or the live canary fails, DevBridge remains fail-closed for those execution classes and reports the reason.

See [`docs/setup.md`](docs/setup.md) for setup details.

## Self-update

Stage 0 establishes only the fixed managed checkout needed to reach the secure bootstrap. Once a runtime exists, ordinary updates remain inside the supervised candidate-validation boundary rather than being activated by the stage-0 launcher.

The supervisor observes the locally selected update policy, materializes candidates separately, verifies release/runtime identity, runs candidate-controlled validation only behind the required OS sandbox, rechecks exact artifact identity, drains the current daemon only after acceptance, health-checks activation, and keeps last-known-good rollback available.

Development mode follows the mutable `main` testing channel and is explicitly alpha. Production mode requires a locally trusted Ed25519-signed immutable release subject binding `iteathen/DevBridge`, exact Git head, package version, and runtime artifact SHA-256.

## CLI

The canonical CLI is `devbridge`:

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

`pause` is cooperative admission control at a safe task-cycle boundary. It does not suspend an active child process or bypass lease heartbeat/fencing. `stop` takes precedence over pause.

## Task protocol

DevBridge task envelopes use the DevBridge namespace only:

````markdown
```devbridge-task
{
  "protocol": "devbridge/task-v1",
  "target": { "repository": "iteathen/example" },
  "instructions": "Implement the requested change, follow project specs, build, and test.",
  "requestedCapabilities": ["project.write", "process.execute"]
}
```
````

Old product names and namespaces are not accepted as live compatibility aliases.

## Configuration

The canonical checked-in example is:

```text
config/devbridge.example.json
```

Fresh configuration keeps execution, model adapters, coordination, dynamic tool onboarding, and automatic task-branch publication conservative/off by default.

Review these local authorities before enabling execution:

- `github.queueRepository`
- `github.trustedActorIds`
- `workspace.allowedOwners`
- `workspace.externalReadRoots`
- `execution.*`
- `execution.decisionAuthorities`
- `coordination.*`
- `publication.*`
- local tool profiles and credentials

DevBridge never silently rewrites an existing operator configuration during self-update.

## Multi-agent coordination

Coordination is disabled by default. When enabled, each installation owns a persistent local Ed25519 identity. Signed task leases are stored behind DevBridge-owned Git refs and changed with exact expected-value compare-and-swap behavior.

Lease ownership is not task authority, machine capability, human approval, or publication authority. Per-installation human-to-workstation dispatch authorization remains roadmap work.

## Human checkpoints

DevBridge uses **checkpoint and proceed**, not blanket stop-and-wait. Safe reversible work may continue while a consequential decision is pending. Hard-gated effects remain blocked until an exact, still-valid decision subject has been authorized by an actor locally delegated for that decision class.

Remote decisions cannot expand filesystem, executable, credential, network, sandbox, peer-trust, or other machine capability.

## Support DevBridge

Repository funding metadata is in `.github/FUNDING.yml`. Sponsorship helps cover AI model/API tokens, GitHub tooling, compute, and project infrastructure.

## Current limitations

Important explicit boundaries include:

- per-installation task destination/dispatch authorization for shared team queues;
- verified untrusted-code sandbox providers for non-Linux/non-Windows hosts;
- Windows ProcessContainer support remains gated by the host's live DevBridge containment probe; install/probe success alone is not treated as security evidence;
- first-class dependency-fetch/install/browser phases and package lifecycle-script isolation;
- complete generic effect journaling for every possible remote mutation;
- numeric GitHub repository-ID pinning and complete tool/profile identity evidence;
- GitHub App installation authentication;
- hard OS CPU/memory/disk/process/thread quotas beyond current process-priority QoS;
- parallel task admission/scheduling;
- automatic default-branch merge/release/deployment as ordinary task effects.

## Documentation

- [`docs/setup.md`](docs/setup.md) — minimal installation and operation.
- [`docs/architecture.md`](docs/architecture.md) — control-plane architecture and trust model.
- [`docs/bootstrap.md`](docs/bootstrap.md) — stage-0, self-update, and release-integrity behavior.
- [`docs/design-principles.md`](docs/design-principles.md) — engineering principles.
- [`docs/tool-profiles.md`](docs/tool-profiles.md) — local worker/tool profile policy.
- [`docs/roadmap.md`](docs/roadmap.md) — implemented state and remaining work.
- `specs/DB-001` through `DB-018` — live normative contracts.

Checksum-bound handoffs under `docs/handoffs/` and point-in-time audits under `docs/testing/` remain historical evidence. Their historical bytes are not live compatibility behavior.

## Tests

```text
npm run preflight
npm test
node src/cli.js doctor --config config/devbridge.example.json
```

CI runs the suite on Ubuntu and Windows, including the standalone-launcher regression and the DevBridge-only live-identity audit. Linux CI exercises the real Bubblewrap boundary. Windows CI provisions the pinned ProcessContainer runtime and requires the real deterministic and proposal-worker containment canaries to pass.

## License

AGPL-3.0-only. See `LICENSE`.
