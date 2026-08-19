# DevBridge setup

DevBridge is installed from one standalone stage-0 launcher and then keeps its managed runtime current through the secure supervisor.

## Requirements

- Node.js 22.16.0 or newer, including npm
- Git
- a GitHub account with access to the configured task queue and target repositories
- Linux with Bubblewrap for untrusted proposal-worker or repository-code execution
- Windows 11/Windows Server hosts able to run the verified ProcessContainer backend; the pinned helper runtime is provisioned automatically

Repository-code/model-worker execution always remains fail-closed until the live DevBridge sandbox probe succeeds on the actual host.

## Fresh install

### Linux

```sh
mkdir -p "$HOME/.devbridge/bin" && curl -fsSL https://raw.githubusercontent.com/iteathen/DevBridge/main/devbridge.mjs -o "$HOME/.devbridge/bin/devbridge.mjs" && node "$HOME/.devbridge/bin/devbridge.mjs"
```

### Windows PowerShell

```powershell
New-Item -ItemType Directory -Force "$HOME\.devbridge\bin" | Out-Null; Invoke-WebRequest "https://raw.githubusercontent.com/iteathen/DevBridge/main/devbridge.mjs" -OutFile "$HOME\.devbridge\bin\devbridge.mjs"; node "$HOME\.devbridge\bin\devbridge.mjs"
```

The launcher defaults to `~/.devbridge` / `$HOME\.devbridge`. On first run it:

1. enforces the supported Node.js version;
2. uses a tightly controlled Git environment to materialize the fixed `https://github.com/iteathen/DevBridge.git` `main` checkout under the managed home;
3. verifies the checkout origin and DevBridge package/bootstrap shape;
4. on Windows, ensures the pinned Microsoft MXC ProcessContainer executable is present under the DevBridge-owned home without adding dependencies to the managed source checkout;
5. transfers control to the managed secure bootstrap;
6. creates `config.json` from `config/devbridge.example.json` when no local config exists; and
7. exits so the operator can review local authority before execution is enabled.

No old product state or namespace is migrated. A clean DevBridge home is the supported cutover path.

Windows prerequisite installation is automatic and non-interactive. If it cannot be provisioned, stage 0 prints an actionable warning and continues in fail-closed mode: configuration/static/control-plane work remains available, while proposal workers and repository-code operations remain disabled until provisioning and live verification succeed.

## Review local authority

Review `~/.devbridge/config.json` (Windows: `$HOME\.devbridge\config.json`) before starting the daemon. In particular:

- set `github.queueRepository` deliberately;
- keep `github.trustedActorIds` limited to actors allowed to submit development jobs to this workstation;
- review `workspace.allowedOwners` and `workspace.externalReadRoots`;
- keep `execution.enabled` false until `doctor` reports the expected local capability and sandbox state;
- leave model adapters, dynamic tool onboarding, coordination, and automatic task-branch publication disabled unless deliberately required.

Run the health check:

### Linux

```sh
node "$HOME/.devbridge/bin/devbridge.mjs" doctor
```

### Windows PowerShell

```powershell
node "$HOME\.devbridge\bin\devbridge.mjs" doctor
```

For untrusted execution, `doctor` must show a verified provider and `repositoryCodeExecution: true`. On Windows the provider is `windows-processcontainer`. The helper executable's own `--probe` is only a prerequisite check; DevBridge separately runs an adversarial containment probe before enabling execution.

Then start the supervised daemon by running the launcher without a command.

## Authentication

The reference configuration uses local GitHub authentication in `auto` mode. It checks configured token environment-variable names such as `DEVBRIDGE_GITHUB_TOKEN` and standard GitHub variables, and may use the active GitHub CLI credential where configured.

Credentials are control-plane state. Do not put tokens in task issues, repository files, model prompts, or checked-in configuration, and do not intentionally inherit them into untrusted workers.

## Linux sandbox prerequisite

Repository-controlled code and proposal workers require the live OS boundary probe to pass. Install Bubblewrap using the operating-system package manager, then run `doctor` and require the relevant sandbox capability to report verified before enabling untrusted execution.

On Ubuntu systems that restrict unprivileged user namespaces, use a narrowly scoped Bubblewrap/AppArmor policy rather than globally disabling the host restriction. See `docs/bootstrap.md`.

## Windows sandbox prerequisite

The stage-0 launcher installs the pinned `@microsoft/mxc-sdk` helper runtime into a versioned directory under `$HOME\.devbridge\sandbox\mxc\` and persists only the required `wxc-exec.exe` helper there. The managed DevBridge Git checkout remains clean.

The Windows provider applies ProcessContainer/AppContainer policy behind the same execution-provider interface used on Linux. Its default untrusted boundary grants project/sandbox scratch writes, explicitly configured/toolchain reads, one exact read-only worker-context endpoint, and one non-authoritative staging-result endpoint. It denies arbitrary external reads/writes, control state, authoritative worker results, Git administrative mutation, and network egress. ProcessContainer/Job Object lifecycle containment plus the parent runner's tree cleanup bound descendants.

The writable Windows staging result is intentionally not authoritative. DevBridge validates its original file identity and size only after the contained process tree exits, then imports the bytes into the still-unexposed control-owned result mailbox. This avoids granting Windows delete authority to the authoritative IPC object.

If Windows `doctor` reports the provider unavailable or unverified, do not bypass it. Repair the prerequisite/host condition and rerun the launcher/doctor; repository-code execution remains disabled by design.

## Updating

Once a managed runtime exists, stage 0 does not activate fetched replacement runtime bytes. Runtime updates remain owned by the supervisor:

1. observe the locally selected update policy;
2. materialize an isolated candidate;
3. verify release/runtime identity;
4. run candidate-controlled validation only behind the required OS sandbox;
5. recheck the candidate artifact identity;
6. drain the current daemon only after candidate acceptance;
7. activate and health-check the exact tested candidate; and
8. roll back to last-known-good on activation failure.

The launcher itself is intentionally small. If `devbridge.mjs` changes materially, replace the local launcher with the current repository copy.

## Stopping and maintenance

The installed runtime supports:

```text
devbridge status
devbridge pause
devbridge resume
devbridge stop
devbridge restart
```

`pause` is cooperative admission control at a safe task-cycle boundary; it does not freeze an active worker. `stop` takes precedence over pause.

For the full security model and production signed-release mode, read `README.md`, `docs/bootstrap.md`, and the active DB specifications.
