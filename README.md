# DevBridge

**Safely connect remote coding controllers to a local development environment.**

DevBridge is a local Node.js control plane that accepts narrowly trusted GitHub development tasks, runs them under local machine policy, preserves durable context and Git state, verifies the resulting work, and publishes only through explicitly authorized boundaries.

The project was previously named **PATCH-POLLER**. The old name described one transport mechanism; DevBridge describes the actual purpose of the application.

## What DevBridge does

DevBridge lets a remote coding controller request development work on a machine without making the remote controller the security authority for that machine.

Current mainline capabilities include:

- exact trusted GitHub task, feedback, and decision provenance using numeric actor IDs plus edit-history verification;
- managed Git repositories and isolated task worktrees;
- deterministic controller plans and locally registered build/test/tool operations;
- optional coding-model adapters, disabled by default;
- verified Linux/Bubblewrap containment for untrusted proposal workers and repository-code execution;
- durable run state, context handoffs, restart recovery, and bounded reconciliation;
- PP-007 human checkpoint-and-proceed gates for sensitive work;
- candidate sealing and exact-head task-branch publication;
- persistent Ed25519 installation identity, signed multi-agent task leases, heartbeat/TTL recovery, and fencing;
- fast-forward baseline reconciliation with mandatory post-drift reverification;
- supervised self-update with candidate validation, safe daemon drain, health checking, and rollback;
- cooperative `pause` / `resume` and below-normal child-process priority;
- serialized task admission: effective task concurrency is currently one.

## Security model

**DevBridge owns machine authority. Remote content requests work; it does not grant capability.**

Remote task text, repository content, dependencies, model output, tool documentation, and process output cannot create executable paths, shell authority, arbitrary local paths, environment secrets, credentials, network capability, sandbox exceptions, trusted actors, peer keys, Git-ref authority, or decision authority.

`github.trustedActorIds` is a **remote development-job submission allowlist**, not a generic collaborator list. If execution is enabled and a runner trusts an actor, that actor may submit development work to that runner within its existing local capability and sandbox policy.

PP-016 peer identity and leases coordinate ownership only. Current v1 task envelopes are not yet cryptographically addressed to a destination workstation. If developer A must not be able to dispatch work to developer B's machine, enforce that today through B's runner-local queue and trusted-actor policy.

Untrusted proposal-worker and repository-code execution requires a verified outer OS sandbox. The built-in provider is Linux/Bubblewrap. Unsupported hosts fail closed for those execution classes rather than silently running with host authority.

## Install

DevBridge is intentionally bootstrap-first. New installs need Node.js 22.16.0+ and Git; Linux machines that execute untrusted project code also need Bubblewrap.

Download the single `devbridge.mjs` launcher and run it with a dedicated DevBridge home:

### Linux / macOS

```sh
mkdir -p ~/devbridge
cd ~/devbridge
curl -fsSLO https://raw.githubusercontent.com/iteathen/DevBridge/main/devbridge.mjs
node devbridge.mjs --home ~/.devbridge
```

### Windows PowerShell

```powershell
New-Item -ItemType Directory -Force "$HOME\devbridge" | Out-Null
Set-Location "$HOME\devbridge"
Invoke-WebRequest "https://raw.githubusercontent.com/iteathen/DevBridge/main/devbridge.mjs" -OutFile "devbridge.mjs"
node .\devbridge.mjs --home "$HOME\.devbridge"
```

The first run fetches the managed runtime and creates a safe local config, with execution disabled. Review the config, run `doctor`, then start DevBridge again.

See **[`docs/setup.md`](docs/setup.md)** for the complete setup and migration path.

## Self-update

The bootstrap launcher is deliberately small. Normal operation starts DevBridge through `devbridge.mjs`; the supervisor periodically observes its configured update channel, validates an acceptable candidate in isolation, drains the current daemon only after validation succeeds, activates the exact tested runtime, performs health checks, and retains or restores the last-known-good runtime on failure.

Development update mode follows a mutable testing channel and is explicitly alpha. Production mode uses a locally trusted Ed25519-signed immutable release subject binding repository identity, exact Git commit, version, and runtime artifact SHA-256.

Existing `patch-poller.mjs` installations remain a supported compatibility path during the rename. GitHub redirects Git operations from a renamed repository, so an old managed remote can continue reaching the renamed repository; new installs should use the DevBridge URL and launcher.

## CLI

The canonical CLI name is now `devbridge`:

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

The legacy `patch-poller` binary alias remains available during the compatibility window.

`pause` is cooperative admission control at a safe task-cycle boundary. It does not freeze an active child process or bypass lease heartbeat/fencing. `stop` takes precedence over pause.

## Task protocol

The v1 wire protocol keeps its existing compatibility namespace:

````markdown
```patch-poller-task
{
  "protocol": "patch-poller/task-v1",
  "target": { "repository": "iteathen/example" },
  "instructions": "Implement the requested change, follow project specs, build, and test.",
  "requestedCapabilities": ["project.write", "process.execute"]
}
```
````

The `patch-poller/*` strings are durable protocol identifiers, not current product branding. They are intentionally not renamed in place because existing task records, run state, leases, handoffs, and signed release subjects depend on stable identifiers. See [`docs/naming-and-compatibility.md`](docs/naming-and-compatibility.md).

## Configuration

The canonical example is:

```text
config/devbridge.example.json
```

Fresh configuration keeps execution, model adapters, multi-agent coordination, dynamic tool onboarding, and automatic task-branch publication conservative by default.

Important local authorities to review before enabling execution:

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

Coordination is disabled by default. When enabled, each installation owns a persistent local Ed25519 identity. Signed task leases are stored behind DevBridge-owned Git refs and use exact expected-value Git compare-and-swap behavior.

Lease ownership is not task authority, machine capability, human approval, or publication authority. Those remain independent local policy boundaries.

Per-installation human-to-workstation dispatch authorization remains an open roadmap item.

## Human checkpoints

DevBridge uses **checkpoint and proceed**, not blanket stop-and-wait.

Safe reversible work may continue while a consequential decision is pending. Hard-gated effects remain blocked until an exact, still-valid decision subject has been authorized by an actor locally delegated for the relevant decision class.

Remote decisions cannot expand filesystem, executable, credential, network, sandbox, peer-trust, or other machine capability.

## Support DevBridge

DevBridge is developed with real recurring infrastructure costs. Sponsorship helps pay for **AI model/API tokens, GitHub tooling, and the compute/infrastructure needed to develop and test the project**.

If DevBridge is useful to you, use the repository's **Sponsor** button to support development through the existing `iteathen` GitHub identity.

The repository intentionally does not add third-party donation platforms by default. Funding metadata lives in `.github/FUNDING.yml`.

## Current limitations

The following remain explicit roadmap boundaries:

- per-installation task destination/dispatch authorization for shared team queues;
- verified untrusted-code sandbox providers for Windows and other non-Linux hosts;
- first-class dependency-fetch/install/browser phases and package lifecycle-script isolation;
- complete generic effect journaling for every possible remote mutation;
- numeric GitHub repository-ID pinning and complete tool/profile identity evidence;
- GitHub App installation authentication;
- hard OS CPU/memory/disk/process/thread quotas beyond current process-priority QoS;
- parallel task admission/scheduling;
- remaining operator CLI surfaces such as `whoami`, peer/lease administration, manual claim/recovery, local issue dry-run, and local patch verification;
- automatic default-branch merge/release/deployment as ordinary task effects.

## Documentation

- [`docs/setup.md`](docs/setup.md) — minimal install, update, and migration instructions.
- [`docs/architecture.md`](docs/architecture.md) — control-plane architecture and trust model.
- [`docs/bootstrap.md`](docs/bootstrap.md) — detailed self-update and release-integrity behavior.
- [`docs/design-principles.md`](docs/design-principles.md) — engineering principles.
- [`docs/tool-profiles.md`](docs/tool-profiles.md) — local worker/tool profile policy.
- [`docs/roadmap.md`](docs/roadmap.md) — implemented state and remaining work.
- [`docs/naming-and-compatibility.md`](docs/naming-and-compatibility.md) — DevBridge rename compatibility rules.
- `specs/PP-001` through `PP-018` — normative contracts. The `PP` identifiers and `patch-poller/*` wire strings are retained v1 compatibility names.

Historical checksum-bound handoffs under `docs/handoffs/` and point-in-time audits under `docs/testing/` remain historical evidence rather than live status documents.

## Tests

```text
npm test
```

CI runs the broad suite on Ubuntu and Windows plus focused security, sandbox, coordination, baseline-reverification, and runtime-governance gates. Linux CI exercises the real Bubblewrap boundary; unsupported-platform behavior is tested fail-closed.

## License

AGPL-3.0-only. See `LICENSE`.
