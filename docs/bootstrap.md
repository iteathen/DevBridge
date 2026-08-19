# Bootstrap launcher

`patch-poller.mjs` is the supported self-updating launcher for PATCH-POLLER on a machine that already has Node.js 22.16.0+ and Git.

The bootstrap is intentionally a smaller authority boundary than the mutable daemon runtime. It owns trusted runtime-source policy, release-integrity policy, candidate staging/validation, activation/rollback, and supervisor lifecycle. The installed runtime owns task polling, execution, leases, workspaces, verification, status, pause/resume state, and task publication.

## Release-integrity modes

The bootstrap has two deliberately different local modes.

### Development mode (default; alpha)

```text
node patch-poller.mjs
```

Development mode follows the mutable locally compiled-in `testing` channel. This preserves a fast self-hosting loop, but **it is not a production release-integrity guarantee**. A maintainer with authority over an accepted testing-channel branch can replace that branch head.

The exact selected head and runtime artifact digest are still recorded, and candidate-controlled preflight/tests execute only inside the verified untrusted-code sandbox rather than under supervisor authority.

On a platform without a verified candidate-validation sandbox, an already accepted development runtime may continue to operate, but the supervisor refuses to execute a newly fetched candidate's preflight/tests and therefore cannot automatically activate that candidate. There is no direct unsandboxed candidate-validation fallback.

### Production mode (signed immutable release subject)

Production mode is explicit and stable-only:

```text
node patch-poller.mjs \
  --channel stable \
  --release-mode production \
  --release-manifest /etc/patch-poller/release.json \
  --release-public-key /etc/patch-poller/release-ed25519.pub.pem
```

Both release files are local operator authority. Tasks, feedback, decisions, repository content, model output, and candidate code cannot choose or modify them through PATCH-POLLER's remote protocols.

The release manifest has this closed shape:

```json
{
  "protocol": "patch-poller/release-manifest-v1",
  "release": {
    "repository": "iteathen/PATCH-POLLER",
    "head": "40-hex-git-commit-sha",
    "artifactSha256": "64-hex-runtime-artifact-sha256",
    "version": "0.1.0"
  },
  "signature": {
    "algorithm": "ed25519",
    "keyId": "operator-release-key-id",
    "value": "base64-ed25519-signature"
  }
}
```

The Ed25519 signature covers the canonical UTF-8 JSON release subject:

```json
{"protocol":"patch-poller/release-subject-v1","repository":"iteathen/PATCH-POLLER","head":"40-hex-git-commit-sha","artifactSha256":"64-hex-runtime-artifact-sha256","version":"0.1.0"}
```

`artifactSha256` is PATCH-POLLER's platform-neutral `patch-poller/runtime-artifact-v1` digest over sorted runtime directories, file paths+bytes, and symlink paths+targets, excluding only the checkout root `.git` administrative directory. Host timestamps and permission bits are not signed.

Production update acceptance requires all of these to agree before candidate code executes:

1. the local release-manifest signature verifies under the local Ed25519 public key;
2. the signed repository identity is exactly `iteathen/PATCH-POLLER`;
3. the signed head is an exact 40-hex commit identity;
4. the mutable `stable` transport currently resolves to that signed head;
5. the fetched runtime version matches the signed version;
6. the supervisor-computed runtime artifact SHA-256 matches the signed artifact SHA-256.

A compromised or merely advanced mutable branch does not become a production update by itself. If transport and independently signed subject do not match, the supervisor leaves the current accepted runtime running.

## Candidate validation boundary

After static release-integrity checks and before activation, candidate-controlled preflight/tests run through the verified outer OS isolation architecture used for untrusted repository-code execution.

The candidate receives:

- its own candidate runtime tree as writable project state;
- `.git` administration read-only or unreachable for writes;
- synthetic private HOME/TMP locations;
- only the required minimal toolchain environment;
- no PATCH-POLLER config, activation journal, daemon/control state, current-runtime sibling authority, GitHub CLI credentials, SSH agent, or GitHub token variables;
- denied network egress.

The supervisor recomputes the runtime artifact SHA-256 after preflight/tests. Any candidate-created, deleted, or modified runtime artifact causes validation to fail even when tests exit successfully. The exact artifact is checked again synchronously at the daemon spawn/activation boundary.

Candidate `doctor` is not used to establish pre-activation trust. It remains a post-acceptance/post-activation health check. Rollback is therefore an operational health/recovery mechanism, not a substitute for pre-activation containment.

The current verified candidate-validation provider is Bubblewrap on Linux. Candidate validation fails closed on unsupported hosts such as Windows until an equivalent verified provider exists.

## First run and local configuration

On first run the launcher:

1. resolves the selected trusted channel;
2. materializes the exact runtime under the PATCH-POLLER home;
3. prints/records the exact runtime identity;
4. creates local config from `config/patch-poller.example.json` only when no config exists;
5. never overwrites an existing operator config;
6. keeps execution disabled in the initial config so authority can be reviewed before use.

GitHub authentication defaults to local `auto` mode. The runtime checks the configured bounded environment-variable names (reference order: `PATCH_POLLER_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`) and may fall back to the active GitHub CLI credential for the configured host. `doctor` may report the provider/source name but never token contents.

Control-plane GitHub credentials are not inherited by runtime-candidate validation or proposal-worker processes.

## Zero-touch runtime supervision

After initial setup, the intended operating model is start once and leave the supervisor running.

Every bounded update-check interval, the supervisor evaluates the selected release policy without replacing runtime files underneath an active daemon.

When an acceptable candidate appears, the supervisor:

1. records the currently running exact runtime SHA;
2. materializes the candidate in a separate runtime-candidate directory while the current daemon continues;
3. verifies static release integrity (signed immutable subject in production; explicit mutable-channel risk in development);
4. verifies the candidate sandbox provider;
5. runs candidate preflight/tests inside that sandbox with network denied and control state absent;
6. recomputes the exact runtime artifact digest and rejects mutation;
7. persists candidate-validation evidence while last-known-good remains available;
8. sends the current daemon's token-bound stop request only after candidate acceptance;
9. waits for the active task cycle to return to the daemon's normal safe boundary;
10. activates the exact tested candidate;
11. runs the health window and `doctor` against that accepted candidate;
12. records the candidate healthy only after health checks pass, otherwise rolls back to the previous accepted runtime.

An unexpected nonzero daemon exit is restarted on the same accepted runtime after local backoff. A clean daemon stop makes the supervisor exit instead of respawning it.

## Daemon pause/resume interaction

PP-018 added cooperative runtime `pause`/`resume` to the installed PATCH-POLLER CLI.

Pause is an admission pause, not an OS process/thread freeze. It binds to the exact current daemon lock token, is acknowledged at a safe task-cycle boundary, prevents the next polling/admission cycle, leaves the daemon alive, and preserves run/worktree/IPC/checkpoint/lease evidence.

`stop` has precedence over pause. A supervisor update drain therefore does not require an operator to resume a paused daemon first.

The **current bootstrap argument parser does not yet forward `pause` or `resume` as bootstrap commands**. Use the installed runtime's `patch-poller` CLI (or its `src/cli.js` entry point with the same local config) for those two controls. Do not document `node patch-poller.mjs pause` / `resume` as supported until the bootstrap command set actually includes them.

## Bootstrap command surface

The current bootstrap accepts these runtime commands:

```text
node patch-poller.mjs doctor
node patch-poller.mjs poll-once
node patch-poller.mjs run-once
node patch-poller.mjs daemon
node patch-poller.mjs status
node patch-poller.mjs stop
node patch-poller.mjs restart
```

The installed `patch-poller` runtime CLI additionally exposes current PP-014 handoff commands and PP-018 `pause`/`resume`; see `README.md` or `src/cli.js` for the exact current runtime command list.

`stop` does not kill an arbitrary PID or delete `daemon.lock`. It writes a local token-bound stop request for the exact current daemon owner. The daemon consumes that request at its normal control boundary and releases only its own lock/control state.

`restart` remains an explicit local maintenance command. `--no-update` disables automatic update checks for that supervised run. `--home <path>` and `--config <path>` are local operator overrides.

## Workstation resource governance

PP-018 applies below-normal OS priority by default to model-worker and deterministic-operation child processes. This policy is implemented by the daemon/runtime, not by the bootstrap supervisor's release-integrity logic.

Priority is background-workstation QoS only. It does not claim hard CPU, memory, disk, process-count, or native-thread quotas.

Task admission is currently serialized. A larger configured `execution.maxConcurrentTasks` value does not create a parallel worker pool.

## Trust boundary summary

- The runtime source repository is fixed in bootstrap code; remote task content cannot select another runtime repository.
- Remote tasks/repository content cannot select release mode, update channel, release manifest/key, runtime root, operator config, bootstrap executable, environment authority, or GitHub credential source.
- Bootstrap Git operations suppress system/global Git configuration, hooks, inherited credential helpers, interactive prompting, SSH-agent variables, and dangerous local/ext transports.
- Operator config and activation state remain outside candidate-validation visibility.
- Last-known-good is not drained until the candidate passes the pre-activation integrity+sandbox boundary.
- Development mutable-channel following remains explicitly alpha.
- Production unattended deployment requires the independent signed immutable release subject and a verified candidate-execution sandbox; missing signature/digest/transport/provider evidence fails closed rather than degrading to development behavior.

## Related specs

- PP-003: local capability/sandbox authority.
- PP-008: Git/supply-chain execution boundaries.
- PP-009: durable effects/recovery.
- PP-010: provenance/control channels.
- PP-011: runtime supervision and zero-touch updates.
- PP-013: deterministic controller-plan infrastructure.
- PP-018: workstation governance and cooperative pause.
