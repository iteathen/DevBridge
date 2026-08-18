# Bootstrap launcher

`patch-poller.mjs` is the smallest supported way to start the v0.1 test build from a machine that already has Node.js 22.16.0+ and Git.

## Normal use

```text
node patch-poller.mjs
```

The launcher:

1. fetches the current trusted PATCH-POLLER testing channel into `~/.patch-poller/runtime`;
2. prints the exact fetched Git commit SHA;
3. creates `~/.patch-poller/config.json` from the safe example on the first run and exits;
4. never overwrites an existing operator config;
5. on later runs, executes `doctor` first and then starts `daemon`.

The first-run config keeps execution disabled. Review its coding-tool profile and sandbox behavior, set `PATCH_POLLER_GITHUB_TOKEN`, and enable execution only when the local policy is ready. Then run the same command again.

For a single controlled cycle instead of the daemon:

```text
node patch-poller.mjs run-once
```

## Daemon control

A daemon started by the current v0.1 testing build can be controlled without access to its original console:

```text
node patch-poller.mjs status
node patch-poller.mjs stop
node patch-poller.mjs restart
```

`stop` does not kill a PID or delete `daemon.lock`. It creates a local token-bound stop request tied to the exact current daemon lock. The daemon consumes that request, exits its normal loop, and releases only its own lock. If the daemon is busy inside an active task, the stop request is honored when that cycle returns; a timeout reports that the request is still pending rather than forcing cleanup.

`status` and `stop` bypass `doctor` so they remain usable for recovering or controlling an already-running daemon even when an unrelated runtime prerequisite is unhealthy. `restart` performs the normal `doctor` gate and then requests a clean daemon replacement.

Other supported commands are `doctor` and `poll-once`. `--no-update` uses the already-managed runtime without fetching. `--home <path>` and `--config <path>` are local operator overrides. `--channel stable` follows `main`; the default `testing` channel follows the current v0.1 integration branch while PR #3 is open and falls back to `main` after that branch is removed.

## Trust boundary

This launcher is an alpha-testing convenience, not the final release-integrity mechanism.

- The source repository is fixed to `https://github.com/iteathen/PATCH-POLLER.git` in the launcher. There is intentionally no remote-repository or arbitrary-ref argument.
- Remote tasks and repository content cannot select the update channel, local runtime root, operator config, executable, or environment authority.
- Bootstrap Git operations suppress system/global Git configuration, hooks, credential helpers, interactive prompting, SSH-agent variables, and `file`/`ext` transports.
- The managed runtime must have the expected origin and a clean worktree before it is updated. The launcher refuses to overwrite a modified runtime automatically.
- The operator config is stored outside the managed runtime and is never replaced by an update.
- Child PATCH-POLLER CLI execution uses the current Node executable with `shell: false`.
- Daemon control uses the random token already bound to the local daemon lock; remote task content cannot manufacture or authorize daemon-control requests.

The `testing` and `stable` channels are mutable Git branches. Following them means deliberately accepting newer code from the trusted PATCH-POLLER repository. That is appropriate for the present v0.1 test loop, but unattended production deployment should move to an immutable, digest-bound/signature-verified release channel before being represented as production-safe.
