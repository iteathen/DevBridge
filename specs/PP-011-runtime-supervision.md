# PP-011 — Runtime Supervision and Zero-Touch Updates

Status: active

## Goal

A locally started PATCH-POLLER instance must remain useful as a durable bridge without requiring the operator to restart it after ordinary PATCH-POLLER runtime fixes or test-build updates.

The operator starts the trusted local bootstrap/supervisor. After initial local configuration, ordinary task delivery, feedback, runtime updates, crash recovery, and continued polling are control-plane responsibilities rather than an operator restart loop.

## Ownership split

The bootstrap is a deliberately small supervisor. The mutable PATCH-POLLER daemon is its child process.

- The supervisor owns trusted-channel update discovery, daemon lifecycle, runtime checkout replacement, update validation, rollback, and unexpected-child restart.
- The daemon owns task polling, durable run coordination, feedback, managed workspaces, coding-tool invocation, candidate sealing, and GitHub status reporting.
- Coding tools remain proposal engines and cannot update PATCH-POLLER's managed runtime or supervisor.
- Remote task/feedback text cannot select a runtime repository, arbitrary update ref, executable, local runtime path, or update policy.

## Safe update sequence

The supervisor must not modify runtime files beneath a live daemon.

When the trusted channel head changes:

1. record the currently running exact runtime SHA;
2. send the daemon's existing token-bound local stop request;
3. allow the active cycle/tool turn to reach its normal safe boundary; do not force-kill an ordinarily supervised daemon merely to update;
4. wait for the daemon child to exit;
5. fetch and check out the newly resolved trusted channel head;
6. validate the managed runtime origin and clean state;
7. run `doctor` against the new runtime;
8. launch a new daemon child only if validation succeeds;
9. if validation fails, attempt to restore the previous exact runtime SHA, run `doctor` on the rollback, and resume the prior daemon version;
10. if both update and rollback fail, stop rather than widening authority or continuing with uncertain runtime state.

The supervisor re-resolves the logical channel on every update check so a temporary integration branch can disappear and fall back to `main` without operator intervention.

### Legacy pre-supervisor adoption exception

A daemon created before PP-011 supervision is not a normal supervised child. It may be unable to reach the newer cooperative takeover boundary, and an unbounded wait would permanently prevent migration.

For this one compatibility case, the supervisor may escalate after a bounded number of cooperative stop attempts only when all of the following hold:

1. the local daemon lock still exists and has a valid PATCH-POLLER daemon-lock protocol, PID, and random ownership token;
2. the operating system confirms that exact PID is still present;
3. the process identity is verified as the expected local Node executable invocation of the exact managed PATCH-POLLER `src/cli.js daemon` using the exact local config path;
4. the forced termination targets that verified PID/process tree only;
5. after termination, the supervisor waits for the PID to disappear;
6. stale lock/stop files are removed only if their PID and random token still exactly match the record observed before termination;
7. any PID reuse, changed lock token, malformed identity, or unverifiable process causes refusal rather than termination.

This is a migration mechanism for a pre-supervisor daemon, not a general timeout policy. Once the supervisor owns the daemon child, ordinary updates remain cooperative and preserve the safe-boundary rule above.

## Crash behavior

A clean daemon exit without a pending supervisor-driven update is treated as an intentional stop and the supervisor exits.

An unexpected nonzero child exit is infrastructure failure. The supervisor may restart the same exact runtime after bounded local backoff. It must not interpret a crash as permission to switch channels, broaden capabilities, delete state, or discard worktrees.

## Control commands

`status` and `stop` are inspection/control operations and must not update the managed runtime underneath an active daemon.

`stop` continues to use the daemon's token-bound stop contract. The supervisor treats the resulting clean child exit as terminal and exits as well.

`restart` is an explicit operator maintenance command, not the normal update path. Ordinary trusted-channel updates are automatic while the supervisor is running.

## Update source and trust

The v0.1 testing supervisor follows only locally compiled-in trusted PATCH-POLLER channels:

- `testing`: current integration branch, with `main` as fallback;
- `stable`: `main`.

The source repository remains fixed to `iteathen/PATCH-POLLER`. Remote tasks cannot override it.

Mutable branch following is acceptable for the explicit alpha/testing channel. Production release hardening should move stable unattended deployment to immutable digest/signature-bound release subjects without changing the supervisor/daemon ownership split.

## Operator experience invariant

After initial bootstrap/configuration, ordinary PATCH-POLLER development/testing must support this flow:

1. operator starts PATCH-POLLER once;
2. remote trusted actors create/update task or feedback envelopes on GitHub;
3. PATCH-POLLER polls and executes them;
4. maintainers may publish PATCH-POLLER runtime fixes to the trusted testing channel;
5. the local supervisor rolls the daemon forward automatically at a safe cycle boundary;
6. no operator restart is required for ordinary runtime updates.

A bootstrap/supervisor protocol change may require an explicit migration only when the existing supervisor lacks the mechanism needed to update itself. Such a migration is a bootstrap compatibility event, not the normal operating model, and must be called out explicitly rather than represented as zero-touch.

## Required tests

Tests must cover at least:

- trusted head change requests a daemon stop before runtime mutation;
- update occurs only after child exit;
- successful update runs `doctor` before relaunch;
- failed update attempts rollback to the exact previous SHA;
- unexpected daemon crash restarts the same runtime with backoff;
- clean daemon stop makes the supervisor exit rather than respawning it;
- operator stop outranks pending update/restart behavior;
- channel re-resolution handles integration-branch removal/fallback;
- `status`/`stop` do not mutate the active runtime;
- remote task/feedback content cannot alter update source/channel/local runtime authority;
- pre-supervisor takeover does not wait forever when the legacy daemon never exits;
- legacy forced termination occurs only after bounded cooperative attempts and exact process/lock identity verification;
- PID reuse or changed lock ownership refuses forced takeover.
