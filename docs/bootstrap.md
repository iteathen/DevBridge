# Bootstrap launcher

`patch-poller.mjs` is the supported local launcher for PATCH-POLLER on a machine that already has Node.js 22.16.0+ and Git.

## Release-integrity modes

The bootstrap has two deliberately different local modes.

### Development mode (default; alpha)

```text
node patch-poller.mjs
```

Development mode follows the mutable locally compiled-in `testing` channel. This preserves the fast self-hosting loop, but **it is not a production release-integrity guarantee**. A maintainer with authority over the trusted branch can replace the branch head. The exact head is still recorded, and every *candidate update validation* now runs inside the verified untrusted-code sandbox instead of under supervisor authority, but mutable-branch provenance itself is accepted as an explicit development risk.

On a platform without a verified candidate-validation sandbox, an already installed development runtime can continue to operate, but the supervisor refuses to execute a newly fetched candidate's preflight/tests and therefore cannot automatically activate that candidate. There is no direct-execution fallback.

### Production mode (signed immutable release subject)

Production mode is explicit and stable-only:

```text
node patch-poller.mjs \
  --channel stable \
  --release-mode production \
  --release-manifest /etc/patch-poller/release.json \
  --release-public-key /etc/patch-poller/release-ed25519.pub.pem
```

Both release files are local operator authority; tasks, feedback, repository content, and candidate code cannot choose them.

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

`artifactSha256` is PATCH-POLLER's platform-neutral `patch-poller/runtime-artifact-v1` digest over sorted runtime directories, file paths+bytes, and symlink paths+targets, excluding only the checkout's root `.git` administrative directory. Host-specific timestamps and permission bits are not signed. The implementation is exported as `runtimeArtifactSha256()` from trusted bootstrap code so a trusted release pipeline can compute the identical subject for the reviewed exact checkout.

Production update acceptance requires all of these to agree before candidate code executes:

1. the local release manifest signature verifies under the local Ed25519 public key;
2. the signed repository identity is exactly `iteathen/PATCH-POLLER`;
3. the signed head is an exact 40-hex commit identity;
4. the mutable `stable` transport currently resolves to that signed head;
5. the fetched runtime version matches the signed version;
6. the supervisor-computed runtime artifact SHA-256 matches the signed artifact SHA-256.

A compromised or merely advanced `main` branch therefore does not become a production update by itself. If it does not equal the locally signed subject, the supervisor leaves the current runtime running.

## Candidate validation boundary

After static release-integrity checks and before activation, candidate-controlled preflight/tests run through the same verified outer OS isolation architecture used for repository-code execution. The candidate receives:

- its own candidate runtime tree as the writable project;
- `.git` administrative state read-only/unreachable for writes;
- a synthetic private HOME and TMP;
- only a minimal fixed toolchain environment;
- no PATCH-POLLER config, activation journal, current-runtime sibling files, daemon state, GitHub CLI credentials, SSH agent, or GitHub token variables;
- denied network egress.

The supervisor recomputes the runtime artifact SHA-256 after preflight/tests. Any candidate-created, deleted, or modified runtime artifact causes validation to fail even if the tests exit successfully.

Candidate `doctor` is **not** used to establish pre-activation trust. After the exact artifact passes release policy and sandboxed validation, `doctor` remains a post-acceptance/post-activation health check. Rollback therefore remains useful for operational health without pretending it can undo a security escape that happened during validation.

The current verified candidate-validation provider is Bubblewrap on Linux. Production candidate validation fails closed on unsupported hosts such as Windows until an equivalent verified provider exists.

## First run and normal development use

In development mode the launcher:

1. fetches the current trusted PATCH-POLLER testing channel into `~/.patch-poller/runtime`;
2. prints the exact fetched Git commit SHA and release mode;
3. creates `~/.patch-poller/config.json` from the safe example on the first run and exits;
4. never overwrites an existing operator config;
5. on later runs, executes `doctor` and becomes the long-lived supervisor for the mutable PATCH-POLLER daemon child.

The first-run config keeps execution disabled. Review its controller-plan/model-adapter/sandbox behavior before enabling execution. GitHub authentication defaults to local `auto` mode: PATCH-POLLER checks `PATCH_POLLER_GITHUB_TOKEN`, `GH_TOKEN`, then `GITHUB_TOKEN`; if none is present it can reuse the active GitHub CLI credential for `github.com`. The selected source is reported by `doctor` without printing the token, and control-plane GitHub credentials are not inherited by candidate-validation or coding-tool processes.

## Zero-touch runtime supervision

After initial setup, the intended operating model is start once and leave it running.

The bootstrap process is a small supervisor. The PATCH-POLLER daemon is its child process. Every 60 seconds the supervisor checks the locally selected update policy.

For development this means the mutable testing channel. For production it means the signed release head, with the stable branch used only as transport. When an acceptable candidate appears, the supervisor:

1. records the currently running exact runtime SHA;
2. materializes the candidate in a separate runtime-candidate directory while the current daemon keeps running;
3. verifies static release integrity (signed in production; exact artifact digest recorded in development);
4. verifies the candidate sandbox provider;
5. runs candidate preflight/tests inside that sandbox with network denied and control state absent;
6. recomputes the exact artifact digest and rejects any mutation;
7. persists candidate-validation evidence while the last-known-good runtime remains available;
8. sends the daemon's token-bound local stop request only after candidate validation succeeds;
9. waits for the current daemon to reach its normal safe boundary and exit;
10. activates the exact tested candidate;
11. runs the health window and `doctor` against the accepted candidate;
12. records the candidate healthy only after health checks pass, otherwise rolls back to the previous exact runtime.

An unexpected nonzero daemon exit is restarted on the same exact runtime after local backoff. A clean daemon stop makes the supervisor exit instead of respawning it.

## Controlled one-shot commands

For a single controlled cycle instead of the daemon/supervisor:

```text
node patch-poller.mjs run-once
```

`doctor`, `poll-once`, `run-once`, `status`, and `stop` inspect/control the currently installed runtime and do not replace runtime files underneath an active daemon. In production, the installed runtime must still satisfy the local signed release subject before candidate code is treated as accepted.

## Daemon control

A supervised daemon can be controlled without access to its original console:

```text
node patch-poller.mjs status
node patch-poller.mjs stop
node patch-poller.mjs restart
```

`stop` does not kill a PID or delete `daemon.lock`. It creates a local token-bound stop request tied to the exact current daemon lock. The daemon consumes that request, exits its normal loop, and releases only its own lock. The supervisor sees the clean child exit and exits too. If the daemon is busy inside an active task, the stop request is honored when that cycle returns; no forced cleanup is used merely for convenience.

`restart` remains an explicit local maintenance command. `--no-update` disables automatic updates for that supervised run. `--home <path>` and `--config <path>` are local operator overrides.

## Trust boundary summary

- The source repository is fixed to `https://github.com/iteathen/PATCH-POLLER.git`; there is no remote-repository or arbitrary-ref task field.
- Remote tasks and repository content cannot select release mode, update channel, release manifest/key, local runtime root, operator config, executable, environment authority, or GitHub credential source.
- Bootstrap Git operations suppress system/global Git configuration, hooks, credential helpers, interactive prompting, SSH-agent variables, and `file`/`ext` transports.
- The operator config and activation state are outside candidate validation visibility.
- The last-known-good runtime is not drained until the candidate passes the pre-activation integrity+sandbox boundary.
- Development mutable-channel following remains explicitly alpha.
- Production unattended deployment requires the independent signed immutable release subject and a verified candidate-execution sandbox; missing signature, digest mismatch, transport mismatch, provider failure, or unsupported platform fails closed rather than degrading to development behavior.
