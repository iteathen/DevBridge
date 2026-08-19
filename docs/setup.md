# DevBridge setup

DevBridge is designed to be installed from one small bootstrap file and then keep itself current.

## Requirements

- Node.js 22.16.0 or newer
- Git
- a GitHub account with access to the task queue and target repositories
- Linux with Bubblewrap for any untrusted proposal-worker or repository-code execution

Windows and other hosts can run configuration, static, and control-plane operations, but untrusted execution remains fail-closed until a verified OS sandbox provider exists for that platform.

## New install

Create a directory for the launcher and download the single bootstrap file from the DevBridge repository.

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

On the first run DevBridge fetches its managed runtime, creates a safe local configuration if one does not already exist, and exits rather than enabling execution automatically.

Review `~/.devbridge/config.json` (Windows: `$HOME\.devbridge\config.json`) before starting the daemon. In particular:

- set `github.queueRepository`;
- keep `github.trustedActorIds` limited to people who are actually allowed to submit development jobs to this workstation;
- review `workspace.allowedOwners`;
- keep `execution.enabled` false until `doctor` reports the expected local capability and sandbox state;
- leave model adapters, dynamic tool onboarding, coordination, and automatic task-branch publication disabled unless they are deliberately needed.

Run the local health check:

```sh
node devbridge.mjs doctor --home ~/.devbridge
```

Then start DevBridge:

```sh
node devbridge.mjs --home ~/.devbridge
```

The default bootstrap command is the supervised daemon. The launcher periodically checks its configured update channel, validates an acceptable candidate, drains the running daemon at a safe boundary, activates the exact tested runtime, and rolls back to the last-known-good runtime if activation or health validation fails.

## Authentication

The reference configuration uses local GitHub authentication in `auto` mode. It checks the configured token environment variables and can use the active GitHub CLI credential where configured. Credentials remain control-plane state and are not intentionally inherited by untrusted workers.

Do not put tokens into task issues, repository files, model prompts, or checked-in configuration.

## Linux sandbox prerequisite

Repository-controlled code and proposal workers require the live OS boundary probe to pass. Install Bubblewrap using the operating-system package manager, then run `doctor` and require the relevant sandbox capability to report verified before enabling untrusted execution.

On Ubuntu systems that restrict unprivileged user namespaces, use a narrowly scoped Bubblewrap/AppArmor policy rather than globally disabling the host restriction. See `docs/bootstrap.md` for the detailed deployment notes.

## Updating

Normal updates require no reinstall. Keep the small `devbridge.mjs` launcher and start DevBridge through it; the supervisor owns runtime update discovery, candidate validation, activation, health checking, and rollback.

The launcher itself is intentionally small. If the checked-in launcher changes materially, replace your local `devbridge.mjs` with the current repository copy. Existing `devbridge.mjs` launchers are retained as a compatibility path during the DevBridge rename.

## Existing DevBridge installations

The product is now named **DevBridge**. Existing installations do not need to discard their state.

The v1 wire protocols, durable record protocol strings, signed-release protocol identifiers, and legacy `~/.devbridge` state path remain compatibility identities. GitHub repository renames redirect existing Git fetch/push URLs, so old managed runtimes can continue following the repository during the transition. New installations should use `devbridge.mjs` and `~/.devbridge`.

Local operator configuration is never silently rewritten by self-update. If an existing config names the old repository explicitly, update that machine-owned setting deliberately when migrating it to the DevBridge repository name.

## Stopping and maintenance

The installed runtime supports:

```text
devbridge status
devbridge pause
devbridge resume
devbridge stop
devbridge restart
```

`pause` is cooperative admission control at a safe task-cycle boundary; it does not freeze an active worker process. `stop` takes precedence over pause.

For the full security model and production signed-release mode, read `README.md`, `docs/bootstrap.md`, and the active specifications.
