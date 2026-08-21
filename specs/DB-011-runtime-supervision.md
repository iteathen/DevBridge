# DB-011 — Runtime Supervision and Zero-Touch Updates

Status: active

Implementation status: v0.1 separates alpha mutable-channel development updates from signed immutable production release subjects and preserves exact runtime artifact identity/rollback state. Stage 1 removed candidate-controlled host execution. Stage 6 restores candidate preflight/tests through the DB-020 repository/VM execution boundary, rechecks the exact artifact afterward, and still fails closed before drain/activation when no validation route is ready.

## Goal

A locally started DevBridge instance must remain useful as a durable bridge without requiring the operator to restart it after ordinary DevBridge runtime fixes or test-build updates, while never confusing convenient self-hosting with production release integrity.

## Ownership split

The bootstrap is a deliberately small supervisor boundary around the mutable daemon runtime.

- Stage 0 owns only fixed DevBridge source bootstrap, managed-checkout shape verification, and transfer to the managed secure bootstrap.
- The secure supervisor owns local release policy, trusted update discovery, static release-integrity verification, candidate execution admission, daemon lifecycle, runtime activation evidence, rollback, and unexpected-child restart.
- The daemon owns task polling, durable run coordination, feedback/decisions, managed workspaces, coding-tool invocation, candidate sealing, and GitHub status reporting.
- Coding tools and runtime candidates remain untrusted proposal/code inputs before activation acceptance and cannot update DevBridge supervisor/control state.
- Remote task/feedback/decision text cannot select a runtime repository, update ref, release mode, signing key/manifest, executable, local runtime path, execution provider, or update policy.

## Release-integrity modes

### Development / testing

The default development mode follows the locally compiled-in mutable testing channel. This is an explicit alpha/self-hosting convenience, not production release integrity.

Even in development, a **new update candidate's** own preflight/tests MUST NOT execute directly with supervisor authority. Candidate-controlled validation requires an admitted repository/VM execution boundary under DB-020. During Stages 1–5 that boundary is intentionally unavailable, so automatic candidate activation fails closed and the current accepted runtime remains running.

### Production

Production mode MUST be explicit local operator policy. v0.1 requires:

- the stable channel only;
- a local bounded `devbridge/release-manifest-v1`;
- a local trusted Ed25519 public key;
- a signature over the canonical release subject;
- fixed repository identity `iteathen/DevBridge`;
- exact 40-hex Git head;
- exact package version;
- exact platform-neutral runtime artifact SHA-256.

The mutable stable branch is transport, not production authority. It may yield a candidate only while its observed head equals the independently signed release head. Branch movement without a matching valid signed subject MUST NOT activate new code.

Missing/inaccessible signing material, invalid signature, wrong repository/head/version, runtime digest mismatch, or unavailable/unverified candidate execution MUST fail closed. Production mode MUST NOT silently degrade to development mode or direct host execution.

## Runtime artifact identity

DevBridge computes a control-owned SHA-256 over the exact runtime artifact using deterministic sorted relative paths and object types/content. The root `.git` administration directory is excluded; runtime directories, file paths+bytes, and symlink path+target participate. Host timestamps and platform-specific permission bits do not.

The artifact digest is computed before candidate-controlled validation and again afterward when candidate execution is available. Any mutation caused by candidate preflight/tests invalidates the candidate even if those commands report success.

Activation evidence records the candidate head, artifact SHA-256, release-integrity mode/status, manifest digest/key identifier when applicable, and repository-execution validation evidence. The exact artifact accepted after validation is the exact artifact activated.

## Candidate validation boundary

Release-integrity verification is separate from candidate execution.

Supervisor-authority work before candidate execution is limited to fixed/control-owned parsing, signature verification, Git/origin/head checks, expected runtime-shape checks, and artifact digest computation. Candidate modules are not imported to prove their own trustworthiness.

Candidate-controlled preflight/tests MUST execute only through the DB-020 repository-execution boundary. The execution environment for a runtime candidate may be dedicated/reseedable rather than long-lived per repository, but it MUST expose at most the candidate/source inputs and bounded scratch/tooling required by the admitted operations. It MUST NOT receive:

- DevBridge operator config and activation/control state;
- current/last-known-good runtime siblings except bounded control-supplied comparison data where explicitly required;
- daemon lock/stop authority;
- GitHub CLI/SSH/control credentials and token variables;
- authoritative Git administration or publication authority;
- VM/provider-management authority;
- arbitrary host paths or writable host mounts.

Normal DB-020 guest networking may be available after VM restoration. Confidentiality therefore comes from keeping host secrets and authority out of the guest, not from relying on a network-denied host process.

Candidate-validation timing follows DB-019's locally controlled per-operation policy. Cheap preflight may retain a short bounded hard timeout, while full-regression validation MUST have its own bounded hard ceiling appropriate to its observed cost and liveness expectations. Exceeding an expected duration, including a legitimate run longer than 30 minutes, is not by itself candidate failure; only the locally defined hard timeout or another authoritative execution failure may reject it on timing grounds. Remote/controller content cannot extend these ceilings.

During Stages 1–5 the production repository executor reports unavailable. `src/bootstrap/candidate-validator.mjs` still checks the exact artifact digest before the execution boundary, then fails closed without executing candidate code. A failed/unavailable candidate validation MUST NOT drain the healthy current daemon.

Candidate `doctor` is a **post-acceptance health check**, not pre-acceptance release-integrity evidence. The supervisor may execute accepted candidate control-plane code only after the exact release subject has passed static integrity and candidate-controlled validation through the admitted execution boundary.

## Safe update sequence

The supervisor MUST keep the last-known-good runtime available while a candidate is untrusted. The full post-Stage-6 sequence is:

1. observe the local update policy and current exact runtime identity;
2. resolve a candidate subject (mutable testing head in development; signed immutable subject in production);
3. materialize candidate bytes in a separate runtime-candidate location without draining the current daemon;
4. verify managed origin/ref/head and clean runtime shape using supervisor-owned logic;
5. compute candidate artifact SHA-256;
6. in production verify the local manifest signature and require signed head/version/digest equality before candidate code executes;
7. require the admitted DB-020 candidate/repository execution environment;
8. transfer the exact candidate subject and run the required candidate preflight/tests through that boundary;
9. recompute artifact/candidate identity under the owning transfer protocol and reject any unexplained mutation or subject mismatch;
10. persist bounded candidate-validation evidence while the current daemon remains available;
11. only then send the current daemon's token-bound cooperative stop request;
12. wait for the active cycle to reach its normal safe boundary and child to exit;
13. activate the exact tested candidate artifact;
14. launch candidate daemon and require the health window plus `doctor`;
15. record healthy only after health checks pass;
16. on activation/health failure restore or retain the previous exact runtime and preserve evidence;
17. if both candidate and rollback/runtime recovery are uncertain, stop rather than widening authority.

During Stages 1–5 the sequence stops after static integrity at the first step requiring candidate-controlled execution. The candidate is not activated and the current runtime is not drained.

The supervisor MUST NOT overwrite files beneath a live daemon.

If an existing daemon does not stop through the verified token-bound cooperative control path after the bounded grace window, the supervisor MUST fail closed. It MUST NOT force-kill an unverified process or delete ownership state as a shortcut.

## Crash behavior

A clean daemon exit without a pending supervisor-driven update is treated as an intentional stop and the supervisor exits.

An unexpected nonzero child exit is infrastructure failure. The supervisor may restart the same exact accepted runtime after bounded local backoff. It MUST NOT interpret a crash as permission to switch channels, accept an unsigned release, broaden capabilities, delete state, discard worktrees, or bypass unavailable repository execution.

## Control commands

`status` and `stop` are inspection/control operations and MUST NOT update the managed runtime underneath an active daemon.

`stop` uses the daemon's token-bound stop contract. `restart` remains an explicit operator maintenance command.

Production invocations still require the installed runtime to satisfy the local signed release subject before candidate runtime code is treated as accepted.

## Operator experience invariant

The start-once workflow is a product goal, not permission to weaken the execution boundary. During the intentional no-provider migration interval, automatic candidate updates that require candidate code execution are unavailable while the current accepted runtime remains serviceable. After Stage 6, development/testing may resume zero-touch candidate validation through the VM execution boundary. Production retains its independently signed immutable release subject.

The live bootstrap and runtime identity are DevBridge-only. Product-rename compatibility, old launcher/config namespaces, and pre-supervisor rename takeover behavior are outside the active contract.

## Required tests

Tests MUST cover at least:

- development mode is explicit/observable as mutable-channel alpha behavior;
- production requires stable channel plus local manifest/public key;
- valid Ed25519 manifest binds exact repository/head/version/artifact SHA-256;
- manifest/signature/head/version/artifact tampering fails closed before candidate execution;
- unsigned mutable stable-branch movement does not become a production candidate;
- Stage-1-to-Stage-5 candidate validation fails closed when repository execution is unavailable and never executes candidate code on the host;
- failed/unavailable candidate validation never drains the healthy current daemon;
- after Stage 6, malicious candidate validation cannot read host control secrets, mutate activation/current-runtime state, inherit GitHub credentials, write authoritative Git administration, or gain provider-management authority;
- candidate validation mutation/subject mismatch changes the accepted identity and prevents activation;
- candidate validation uses distinct locally controlled timing policy for cheap preflight and full regression, with a full-regression hard ceiling that permits legitimate runs longer than 30 minutes;
- exact tested artifact/candidate identity is recorded with validation and healthy activation evidence;
- trusted head change requests daemon drain only after candidate validation succeeds;
- successful activation runs post-acceptance health/doctor;
- failed activation/health restores last-known-good exact runtime;
- unexpected daemon crash restarts the same runtime with backoff;
- clean daemon stop exits the supervisor;
- operator stop outranks pending update/restart behavior;
- remote task/feedback content cannot alter update source/channel/release policy or execution provider;
- an unresponsive/unverified existing daemon fails closed rather than being force-terminated.