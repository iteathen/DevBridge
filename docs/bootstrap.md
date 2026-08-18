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
5. on later runs, executes `doctor` and becomes the long-lived supervisor for the mutable PATCH-POLLER daemon child.

The first-run config keeps execution disabled. Review its coding-tool profile and sandbox behavior before enabling execution. GitHub authentication defaults to local `auto` mode: PATCH-POLLER checks `PATCH_POLLER_GITHUB_TOKEN`, `GH_TOKEN`, then `GITHUB_TOKEN`; if none is present it can reuse the active GitHub CLI credential for `github.com`. The selected source is reported by `doctor` without printing the token, and the token is never inherited by the coding tool. Existing configs that still contain `github.tokenEnv` remain compatible and use that variable first, followed by the standard fallbacks.

## Zero-touch runtime supervision

After initial setup, the intended operating model is start once and leave it running.

The bootstrap process is a small supervisor. The PATCH-POLLER daemon is a child process. Every 60 seconds the supervisor re-resolves the configured trusted channel and checks its exact Git head.

When a newer trusted runtime appears, the supervisor does not overwrite files beneath a live daemon. It:

1. detects the new exact trusted head;
2. sends the daemon's token-bound local stop request;
3. lets any active task/coding-tool cycle reach its normal safe boundary;
4. waits for the daemon child to exit;
5. fetches/checks out the new runtime;
6. runs `doctor` against the new runtime;
7. relaunches the daemon automatically.

If the updated runtime fails `doctor`, the supervisor attempts to restore the previous exact SHA and relaunch that known prior runtime. An unexpected nonzero daemon exit is restarted on the same runtime after local backoff. A clean daemon stop makes the supervisor exit instead of respawning it.

This means ordinary PATCH-POLLER fixes on the trusted testing channel do **not** require an operator restart. Jobs and feedback continue to arrive through GitHub while the supervisor owns local runtime lifecycle.

The one exception is a bootstrap compatibility migration: an already-running pre-supervisor launcher cannot retroactively gain supervision logic that was not loaded into its Node process. That is a one-time bootstrap migration, not the normal operating model. PP-011 defines this boundary.

## Controlled one-shot commands

For a single controlled cycle instead of the daemon/supervisor:

```text
node patch-poller.mjs run-once
```

`doctor`, `poll-once`, `run-once`, `status`, and `stop` inspect/control the currently installed runtime and do not replace runtime files underneath an active daemon. The long-lived supervisor is the ordinary owner of runtime updates.

## Daemon control

A supervised daemon can be controlled without access to its original console:

```text
node patch-poller.mjs status
node patch-poller.mjs stop
node patch-poller.mjs restart
```

`stop` does not kill a PID or delete `daemon.lock`. It creates a local token-bound stop request tied to the exact current daemon lock. The daemon consumes that request, exits its normal loop, and releases only its own lock. The supervisor sees the clean child exit and exits too. If the daemon is busy inside an active task, the stop request is honored when that cycle returns; no forced cleanup is used merely for convenience.

`restart` remains an explicit local maintenance command, but it is not required for ordinary trusted-channel updates.

`--no-update` disables automatic trusted-channel updates for that supervised run. `--home <path>` and `--config <path>` are local operator overrides. `--channel stable` follows `main`; the default `testing` channel follows the current v0.1 integration branch while it exists and falls back to `main` after that branch is removed.

## Trust boundary

This launcher is an alpha-testing convenience, not the final release-integrity mechanism.

- The source repository is fixed to `https://github.com/iteathen/PATCH-POLLER.git` in the launcher. There is intentionally no remote-repository or arbitrary-ref argument.
- Remote tasks and repository content cannot select the update channel, local runtime root, operator config, executable, environment authority, or GitHub credential source.
- Bootstrap Git operations suppress system/global Git configuration, hooks, credential helpers, interactive prompting, SSH-agent variables, and `file`/`ext` transports.
- The managed runtime must have the expected origin and a clean worktree before it is updated. The supervisor refuses to overwrite a modified runtime automatically.
- Runtime mutation occurs only after the daemon child exits; the supervisor never hot-overwrites code under a live daemon.
- The operator config is stored outside the managed runtime and is never replaced by an update.
- Child PATCH-POLLER CLI execution uses the current Node executable with `shell: false`.
- PATCH-POLLER GitHub credentials stay in the control plane and are not copied into coding-tool environments or context capsules.
- Daemon control uses the random token already bound to the local daemon lock; remote task content cannot manufacture or authorize daemon-control requests.
- Remote jobs and feedback can drive work, but they cannot grant runtime-update authority. Update authority remains local and limited to the compiled-in trusted PATCH-POLLER channels.

The `testing` and `stable` channels are mutable Git branches. Following them means deliberately accepting newer code from the trusted PATCH-POLLER repository. That is appropriate for the present v0.1 test loop, but unattended production deployment should move to an immutable, digest-bound/signature-verified release channel before being represented as production-safe.
