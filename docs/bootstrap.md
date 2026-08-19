# DevBridge bootstrap launcher

`devbridge.mjs` is the canonical stage-0 launcher for DevBridge on a machine with Node.js 22.16.0+ and Git.

Stage 0 is intentionally small. It establishes the fixed managed DevBridge checkout needed to reach the secure bootstrap; it does not replace the supervisor's candidate-validation, activation, or rollback authority.

For the shortest installation path, see `docs/setup.md`.

## Stage-0 boundary

The downloaded launcher uses only Node.js built-ins plus the local `git` executable. It:

1. enforces the supported Node.js version;
2. parses only the local bootstrap arguments needed to resolve the DevBridge home;
3. defaults the home to `~/.devbridge`;
4. creates private bootstrap Git HOME/hooks directories;
5. suppresses inherited Git/SSH authority and interactive credential prompting;
6. on a fresh home, shallow-clones the fixed `https://github.com/iteathen/DevBridge.git` `main` branch into the managed runtime;
7. verifies the managed checkout origin is the fixed DevBridge repository and the checkout is clean;
8. verifies `package.json` identifies `devbridge` and the managed secure-bootstrap module exists; and
9. dynamically imports/calls that managed secure bootstrap with the original user arguments.

If a managed runtime already exists, stage 0 verifies it and transfers control without replacing it. Ordinary runtime updates therefore remain behind the supervisor's candidate-validation boundary.

`--no-update` requires an existing managed runtime; it cannot be used to bootstrap an empty home.

## Release-integrity modes

### Development / testing

Development mode is the default alpha/self-hosting mode. The locally compiled-in testing channel currently resolves to `main`.

A new update candidate's own preflight/tests never execute directly with supervisor authority. Candidate-controlled validation requires the verified repository-code sandbox. If the required sandbox is unavailable, automatic candidate activation fails closed and the current runtime remains running.

### Production

Production mode is explicit and stable-only:

```text
node ~/.devbridge/bin/devbridge.mjs \
  --channel stable \
  --release-mode production \
  --release-manifest /etc/devbridge/release.json \
  --release-public-key /etc/devbridge/release-ed25519.pub.pem
```

Both release files are local operator authority. Remote tasks, feedback, decisions, repository content, model output, and candidate code cannot select or modify them through DevBridge protocols.

The release manifest uses the DevBridge namespace and repository identity:

```json
{
  "protocol": "devbridge/release-manifest-v1",
  "release": {
    "repository": "iteathen/DevBridge",
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

`artifactSha256` is the platform-neutral `devbridge/runtime-artifact-v1` digest over sorted runtime directories, file paths+bytes, and symlink paths+targets, excluding only the checkout root `.git` administration directory.

Production acceptance requires the manifest signature, fixed repository identity, exact Git head, stable transport head, package version, and supervisor-computed artifact SHA-256 to agree before candidate code executes. Production never silently degrades to development mode.

## Candidate validation boundary

After static release-integrity checks and before activation, candidate-controlled preflight/tests run through the verified outer OS isolation architecture used for untrusted repository-code execution.

The candidate receives at most:

- its own candidate runtime tree;
- bounded scratch/TMP;
- locally approved system/toolchain reads; and
- a minimal fixed environment.

It does not receive DevBridge operator config, activation/control state, current/last-known-good runtime siblings, daemon authority, GitHub CLI/SSH/control credentials, token variables, writable Git administration, or network egress in the v0.1 validation profile.

The supervisor recomputes runtime artifact SHA-256 after validation. Any candidate mutation invalidates the candidate even when validation commands report success. The exact artifact identity is checked again at activation.

Candidate `doctor` is a post-acceptance health check, not pre-acceptance trust evidence.

The current verified candidate-validation provider is Bubblewrap on Linux. Candidate validation fails closed on unsupported hosts until an equivalent verified provider exists.

## First run and local configuration

On first run, the secure bootstrap creates `~/.devbridge/config.json` from `config/devbridge.example.json` only when no local config exists, reports that the file must be reviewed, and exits. Execution remains disabled in the reference config.

GitHub authentication defaults to local `auto` mode. The runtime checks configured bounded environment-variable names, including `DEVBRIDGE_GITHUB_TOKEN`, and may fall back to the active GitHub CLI credential for the configured host. `doctor` may report the provider/source but never token contents.

Control-plane GitHub credentials are not inherited by runtime-candidate validation or proposal-worker processes.

## Supervised update sequence

After initial setup, the secure supervisor owns updates:

1. observe local update/release policy and current exact runtime identity;
2. resolve the candidate subject;
3. materialize candidate bytes separately without draining the current daemon;
4. verify origin/ref/head and clean runtime shape;
5. compute candidate artifact SHA-256;
6. in production, verify the signed immutable release subject;
7. verify the OS candidate-validation provider;
8. run candidate preflight/tests inside the sandbox;
9. recompute artifact SHA-256 and reject mutation;
10. persist bounded validation evidence;
11. request the current daemon's token-bound cooperative stop;
12. wait for the active cycle to reach its safe boundary and exit;
13. activate the exact tested candidate;
14. launch it and require the health window plus `doctor`;
15. record healthy only after checks pass; and
16. restore/retain last-known-good on activation or health failure.

The supervisor never overwrites files beneath a live daemon. If an existing daemon does not stop through the verified cooperative control path, DevBridge fails closed rather than force-killing an unverified process.

An unexpected nonzero daemon exit may restart the same exact accepted runtime after bounded local backoff. A clean daemon exit without a pending update is treated as an intentional stop.

## Daemon pause/resume interaction

DB-018 defines cooperative runtime `pause`/`resume`.

Pause is an admission pause, not an OS process/thread freeze. It binds to the exact daemon control token, is acknowledged at a safe task-cycle boundary, prevents new polling/admission, and preserves durable run/worktree/IPC/checkpoint/lease evidence. `stop` takes precedence over pause.

The stage-0/bootstrap command parser currently handles:

```text
doctor
poll-once
run-once
daemon
status
stop
restart
```

The installed `devbridge` runtime CLI additionally exposes DB-014 handoff commands and DB-018 `pause`/`resume`.

## Trust-boundary summary

- Runtime repository identity is fixed in launcher/control code; remote content cannot select another source.
- Remote content cannot select release mode, update channel, release manifest/key, runtime root, operator config, executable, environment authority, or credential source.
- Bootstrap Git operations suppress inherited Git/SSH authority, hooks, interactive prompting, and dangerous local/ext transports.
- Operator config and activation state remain outside candidate-validation visibility.
- Last-known-good is not drained until the candidate passes the pre-activation integrity+sandbox boundary.
- Development mutable-channel following remains explicitly alpha.
- Production unattended deployment requires an independently signed immutable release subject plus verified candidate-execution containment.

## Related docs/specs

- `docs/setup.md`: minimal installation and operation.
- DB-003: local capability/sandbox authority.
- DB-008: Git/supply-chain execution boundaries.
- DB-009: durable effects/recovery.
- DB-010: provenance/control channels.
- DB-011: runtime supervision and zero-touch updates.
- DB-013: deterministic controller-plan infrastructure.
- DB-018: workstation governance and cooperative pause.
