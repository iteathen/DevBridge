# PP-011 — Runtime Supervision and Zero-Touch Updates

Status: active

Implementation status: v0.1 separates alpha mutable-channel development updates from signed immutable production release subjects. Candidate-controlled preflight/tests run only behind the verified untrusted-code sandbox; the exact tested artifact digest is journaled and rechecked before activation.

## Goal

A locally started PATCH-POLLER instance must remain useful as a durable bridge without requiring the operator to restart it after ordinary PATCH-POLLER runtime fixes or test-build updates, while never confusing convenient self-hosting with production release integrity.

## Ownership split

The bootstrap is a deliberately small supervisor. The mutable PATCH-POLLER daemon is its child process.

- The supervisor owns local release policy, trusted update discovery, static release-integrity verification, candidate sandbox verification, daemon lifecycle, runtime checkout replacement, activation evidence, rollback, and unexpected-child restart.
- The daemon owns task polling, durable run coordination, feedback/decisions, managed workspaces, coding-tool invocation, candidate sealing, and GitHub status reporting.
- Coding tools and runtime candidates remain untrusted proposal/code inputs before activation acceptance and cannot update PATCH-POLLER's supervisor/control state.
- Remote task/feedback/decision text cannot select a runtime repository, update ref, release mode, signing key/manifest, executable, local runtime path, or update policy.

## Release-integrity modes

### Development / testing

The default development mode follows the locally compiled-in mutable testing channel. This is an explicit alpha/self-hosting convenience, not production release integrity.

Even in development, a **new update candidate's** own preflight/tests MUST NOT execute directly with supervisor authority. Candidate-controlled validation uses the verified repository-code sandbox. If that sandbox is unavailable, automatic candidate activation fails closed and the current runtime remains running.

### Production

Production mode MUST be explicit local operator policy. v0.1 requires:

- the stable channel only;
- a local bounded `patch-poller/release-manifest-v1`;
- a local trusted Ed25519 public key;
- a signature over the canonical release subject;
- fixed repository identity `iteathen/PATCH-POLLER`;
- exact 40-hex Git head;
- exact package version;
- exact platform-neutral runtime artifact SHA-256.

The mutable stable branch is transport, not production authority. It may yield a candidate only while its observed head equals the independently signed release head. Branch movement without a matching valid signed subject MUST NOT activate new code.

Missing/inaccessible signing material, invalid signature, wrong repository/head/version, runtime digest mismatch, or unverified candidate sandbox MUST fail closed. Production mode MUST NOT silently degrade to development mode.

## Runtime artifact identity

PATCH-POLLER computes a control-owned SHA-256 over the exact runtime artifact using deterministic sorted relative paths and object types/content. The root `.git` administration directory is excluded; runtime directories, file paths+bytes, and symlink path+target participate. Host timestamps and platform-specific permission bits do not.

The artifact digest is computed before candidate-controlled validation and again afterward. Any mutation caused by candidate preflight/tests invalidates the candidate even if those commands report success.

Activation evidence records the candidate head, artifact SHA-256, release-integrity mode/status, manifest digest/key identifier when applicable, and sandbox evidence. The exact artifact accepted after validation is the exact artifact activated.

## Candidate validation boundary

Release-integrity verification is separate from candidate execution.

Supervisor-authority work before candidate execution is limited to fixed/control-owned parsing, signature verification, Git/origin/head checks, expected runtime-shape checks, and artifact digest computation. Candidate modules are not imported to prove their own trustworthiness.

Candidate-controlled preflight/tests MUST run behind the same verified outer OS isolation architecture used for repository code. The validation sandbox MUST provide at most:

- candidate runtime project bytes;
- bounded scratch/TMP;
- locally approved system/toolchain reads;
- a minimal fixed environment.

It MUST deny/unexpose:

- PATCH-POLLER operator config and activation/control state;
- current/last-known-good runtime siblings except the candidate itself;
- daemon lock/stop authority;
- GitHub CLI/SSH/control credentials and token variables;
- Git administrative writes;
- network egress in the v0.1 validation profile.

Provider verification is mandatory. Unsupported hosts fail closed for candidate-controlled validation. The current v0.1 provider is Bubblewrap on Linux.

Candidate `doctor` is a **post-acceptance health check**, not pre-acceptance release-integrity evidence. The supervisor may execute accepted candidate control-plane code only after the exact release subject has passed static integrity and sandboxed validation.

## Safe update sequence

The supervisor MUST keep the last-known-good runtime available while a candidate is untrusted. The sequence is:

1. observe the local update policy and current exact runtime identity;
2. resolve a candidate subject (mutable testing head in development; signed immutable subject in production);
3. materialize candidate bytes in a separate runtime-candidate location without draining the current daemon;
4. verify managed origin/ref/head and clean runtime shape using supervisor-owned logic;
5. compute candidate artifact SHA-256;
6. in production verify the local manifest signature and require signed head/version/digest equality before candidate code executes;
7. verify the OS candidate-validation provider;
8. run candidate preflight/tests inside the sandbox with network denied and control state/credentials absent;
9. recompute artifact SHA-256 and reject any changed artifact;
10. persist bounded candidate-validation evidence while the current daemon remains available;
11. only then send the current daemon's token-bound cooperative stop request;
12. wait for the active cycle to reach its normal safe boundary and child to exit;
13. activate the exact tested candidate artifact;
14. launch candidate daemon and require the health window plus `doctor`;
15. record healthy only after health checks pass;
16. on activation/health failure restore or retain the previous exact runtime and preserve evidence;
17. if both candidate and rollback/runtime recovery are uncertain, stop rather than widening authority.

The supervisor MUST NOT overwrite files beneath a live daemon.

### Legacy pre-supervisor adoption exception

A daemon created before PP-011 supervision is not a normal supervised child. The existing bounded, exact-identity Windows legacy takeover mechanism remains a compatibility migration only. It does not relax candidate release-integrity or validation rules and is not a general update timeout policy.

## Crash behavior

A clean daemon exit without a pending supervisor-driven update is treated as an intentional stop and the supervisor exits.

An unexpected nonzero child exit is infrastructure failure. The supervisor may restart the same exact accepted runtime after bounded local backoff. It MUST NOT interpret a crash as permission to switch channels, accept an unsigned release, broaden capabilities, delete state, or discard worktrees.

## Control commands

`status` and `stop` are inspection/control operations and MUST NOT update the managed runtime underneath an active daemon.

`stop` continues to use the daemon's token-bound stop contract. `restart` remains an explicit operator maintenance command.

Production invocations still require the installed runtime to satisfy the local signed release subject before candidate runtime code is treated as accepted.

## Operator experience invariant

Development/testing should retain the start-once workflow when the local sandbox provider is available. Production trades some release-pipeline ceremony for an independently signed immutable subject; ordinary remote tasks do not participate in that release authority.

A bootstrap/supervisor protocol change may still require an explicit compatibility migration when the already-running supervisor lacks the new mechanism. Such a migration MUST be named explicitly rather than represented as zero-touch.

## Required tests

Tests MUST cover at least:

- development mode is explicit/observable as mutable-channel alpha behavior;
- production requires stable channel plus local manifest/public key;
- valid Ed25519 manifest binds exact repository/head/version/artifact SHA-256;
- manifest/signature/head/version/artifact tampering fails closed before candidate execution;
- unsigned mutable stable-branch movement does not become a production candidate;
- candidate validation is denied when no verified sandbox provider exists;
- malicious candidate validation cannot read a control secret, mutate activation/current-runtime state, inherit GitHub credentials, write Git administration, or reach forbidden network targets;
- candidate validation mutation changes the artifact digest and prevents activation;
- exact tested artifact SHA-256 is recorded with candidate validation and healthy activation evidence;
- trusted head change requests daemon drain only after candidate validation succeeds;
- failed candidate validation never drains the healthy current daemon;
- successful activation runs post-acceptance health/doctor;
- failed activation/health restores last-known-good exact runtime;
- unexpected daemon crash restarts the same runtime with backoff;
- clean daemon stop exits the supervisor;
- operator stop outranks pending update/restart behavior;
- remote task/feedback content cannot alter update source/channel/release policy;
- legacy takeover retains its exact identity/ownership protections.
