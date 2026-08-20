# DB-011 — Runtime Supervision and Zero-Touch Updates

Status: active

Implementation status: v0.1 separates alpha mutable-channel development updates from signed immutable production release subjects. Current main executes candidate-controlled validation through the transitional verified Linux/Bubblewrap host sandbox. DB-020 is normative for the target boundary: candidate-controlled code executes through VM isolation while release, artifact, activation, rollback, and daemon authority remain on the trusted host.

## Goal

A locally started DevBridge instance must remain useful as a durable bridge without requiring the operator to restart it after ordinary runtime fixes or test-build updates, while never confusing convenient self-hosting with production release integrity or allowing an untrusted candidate to inherit supervisor authority.

## Ownership split

The bootstrap is a deliberately small trusted boundary around a mutable daemon runtime.

- Stage 0 owns only fixed DevBridge source bootstrap, managed-checkout shape verification, and transfer to the managed secure bootstrap.
- The secure supervisor owns local release policy, trusted update discovery, static release-integrity verification, candidate execution-environment admission, daemon lifecycle, runtime activation evidence, rollback, and unexpected-child restart.
- The daemon owns task polling, durable run coordination, feedback/decisions, managed repositories/environments, candidate sealing, and GitHub status reporting.
- Runtime candidates remain untrusted executable inputs before acceptance and cannot update DevBridge supervisor/control state merely because they are the next version.
- Remote task/feedback/decision text cannot select the runtime repository, update ref, release mode, signing key/manifest, executable, local runtime path, VM-management target, or update policy.

## Release-integrity modes

### Development / testing

The default development mode follows the locally compiled-in mutable testing channel. This is explicit alpha/self-hosting convenience, not production release integrity.

Even in development, a **new candidate's own code** must not execute directly with supervisor authority. Candidate-controlled preflight/tests require the verified untrusted-code execution boundary.

Current implementation uses the legacy host sandbox where supported. The DB-020 target uses a VM validation environment. Until either the currently supported transitional provider or the future VM provider is actually verified for the running implementation, automatic candidate activation fails closed and the current runtime remains available.

### Production

Production mode must be explicit local operator policy. v0.1 requires:

- the stable channel only;
- a local bounded `devbridge/release-manifest-v1`;
- a local trusted Ed25519 public key;
- a signature over the canonical release subject;
- fixed repository identity `iteathen/DevBridge`;
- exact 40-hex Git head;
- exact package version;
- exact platform-neutral runtime artifact SHA-256.

The mutable stable branch is transport, not production authority. It may yield a candidate only while its observed head equals the independently signed release head. Branch movement without a matching valid signed subject must not activate new code.

Missing/inaccessible signing material, invalid signature, wrong repository/head/version, runtime digest mismatch, or unavailable/unverified candidate execution isolation fails closed. Production never silently degrades to development mode.

## Runtime artifact identity

DevBridge computes a control-owned SHA-256 over the exact runtime artifact using deterministic sorted relative paths and object types/content. The root `.git` administration directory is excluded; runtime directories, file paths+bytes, and symlink path+target participate. Host timestamps and platform-specific permission bits do not.

The candidate artifact identity is host authority. A validation VM receives an exact candidate subject/copy bound to that digest; guest output does not redefine it.

Immediately before activation, the host recomputes the candidate artifact digest and requires equality with the accepted subject. If validation architecture ever permits candidate code to mutate host candidate bytes, the digest must also be recomputed after validation and any mutation rejects the candidate. The simpler VM design should avoid giving the guest a writable host candidate mount at all.

Activation evidence records the exact candidate head, artifact SHA-256, release-integrity mode/status, manifest digest/key identifier when applicable, and execution-environment verification identity. The exact artifact accepted is the exact artifact activated.

## Candidate validation boundary

Release-integrity verification is separate from candidate execution.

Supervisor-authority work before candidate execution is limited to fixed/control-owned parsing, signature verification, Git/origin/head checks, expected runtime-shape checks, artifact digest computation, and provisioning/admission of the locally owned execution environment. Candidate modules are not imported on the trusted host to prove their own trustworthiness.

The target DB-020 candidate-validation flow executes candidate-controlled preflight/tests in a VM trust domain. That VM may be dedicated/reseedable rather than the long-lived per-project environment, but it must preserve the same security partition:

- candidate bytes and bounded validation inputs may enter the guest;
- GitHub/SSH/coordination/release/signing/daemon/hypervisor-management credentials and control state stay host-only;
- current/last-known-good runtime siblings are not arbitrary guest mounts;
- the guest cannot name arbitrary host paths or mutate activation state through the bridge;
- guest networking may be available by default under DB-020, so confidentiality depends on secret absence rather than an assumed network-denied namespace;
- result/test evidence returns as untrusted data bound to the exact candidate/environment subject.

The current Bubblewrap candidate path remains transitional implementation until VM Stages 6-8 replace and qualify it. Presence of Hyper-V, a VM name, or a configured image is not sufficient evidence.

Candidate `doctor` remains a **post-acceptance health check**, not pre-acceptance release-integrity evidence.

## Safe update sequence

The supervisor must keep last-known-good available while a candidate is untrusted. The target sequence is:

1. observe local update/release policy and current exact runtime identity;
2. resolve the candidate subject: mutable testing head in development, or signed immutable subject plus matching stable transport in production;
3. materialize candidate bytes separately without draining the current daemon;
4. verify origin/ref/head and clean runtime shape with supervisor-owned logic;
5. compute exact candidate artifact SHA-256;
6. in production verify the local manifest signature and require signed repository/head/version/digest equality before candidate code executes;
7. verify/admit the required candidate execution environment (legacy sandbox during migration; DB-020 VM after cutover);
8. transfer/execute the exact candidate validation subject inside that untrusted environment without host control credentials/state;
9. collect bounded validation evidence and require success for the exact candidate/environment identity;
10. recompute/reconfirm host candidate artifact identity and reject unexplained mutation/drift;
11. persist bounded candidate-validation evidence while the current daemon remains available;
12. only then send the current daemon's token-bound cooperative stop request;
13. wait for the active cycle to reach its normal safe boundary and exit;
14. immediately before spawn, recheck the runtime artifact digest still equals the accepted digest;
15. activate and launch the exact accepted candidate;
16. require the health window plus post-acceptance `doctor`;
17. mark healthy only after those checks pass;
18. on activation/health failure restore or retain the previous exact runtime and preserve evidence;
19. if both candidate and rollback/runtime recovery are uncertain, stop rather than widening authority.

The supervisor must not overwrite files beneath a live daemon.

If an existing daemon does not stop through the verified token-bound cooperative path after the bounded grace window, the supervisor fails closed. It must not force-kill an unverified process or delete ownership state as a shortcut.

## Candidate networking

The earlier v0.1 host-sandbox design used a network-denied validation profile. DB-020 changes the target repository/candidate isolation model: an untrusted VM may have ordinary network access.

This is safe only because candidate validation receives no host secrets or host publication/control authority. A malicious candidate may contact the network and exfiltrate anything placed in its guest environment, so validation inputs must be chosen accordingly.

If production policy requires offline/restricted validation for a particular release class, that may be an additional local policy, not the foundational containment claim and not permission to inject credentials when networking is disabled.

## Crash behavior

A clean daemon exit without a pending supervisor-driven update is treated as intentional stop and the supervisor exits.

An unexpected nonzero child exit is infrastructure failure. The supervisor may restart the same exact accepted runtime after bounded local backoff. It must not interpret a crash as permission to switch channels, accept an unsigned release, broaden capabilities, delete VM/runtime state, or discard worktrees.

Interrupted VM validation is reconciled under DB-009 using exact candidate, validation-environment, and operation identities before repeating expensive work. DB-019 exact valid evidence should be reused when its identity remains applicable.

## Control commands

`status` and `stop` are inspection/control operations and must not update the managed runtime underneath an active daemon.

`stop` uses the daemon's token-bound stop contract. `restart` remains an explicit operator maintenance command.

Production invocations still require the installed runtime to satisfy the local signed release subject before candidate runtime code is treated as accepted.

## Operator experience invariant

Development/testing should retain a start-once workflow once the required local execution provider is installed and verified. Production trades release-pipeline ceremony for independently signed immutable subjects; ordinary remote tasks do not participate in release authority.

VM Stage 8 owns Hyper-V/setup/reconfiguration UX. Until that lands, documentation must distinguish the DB-020 target from current Bubblewrap-only candidate execution rather than implying Windows VM validation already works.

## Required tests

Tests/qualification must cover at least:

- development mode is explicit/observable mutable-channel alpha behavior;
- production requires stable channel plus local manifest/public key;
- valid Ed25519 manifest binds exact repository/head/version/artifact SHA-256;
- manifest/signature/head/version/artifact tampering fails closed before candidate execution;
- unsigned mutable stable movement does not become a production candidate;
- candidate validation is denied when no verified execution provider/environment exists;
- a malicious candidate cannot obtain host control secrets, activation/current-runtime authority, GitHub/SSH/coordination/release credentials, authoritative Git state, or VM-management authority;
- VM validation binds exact candidate digest plus provider/image/environment/operation identity;
- guest networking does not imply host credential or publication authority;
- exact accepted/tested artifact SHA-256 is recorded and is the exact artifact activated;
- trusted head change drains the daemon only after candidate validation succeeds;
- failed candidate validation never drains the healthy current daemon;
- successful activation runs post-acceptance health/doctor;
- failed activation/health restores last-known-good exact runtime;
- interrupted validation can recover/reconcile without rerunning expensive tests when exact DB-019 evidence remains valid;
- unexpected daemon crash restarts the same runtime with backoff;
- clean daemon stop exits the supervisor;
- operator stop outranks pending update/restart behavior;
- remote task/feedback content cannot alter update source/channel/release policy;
- an unresponsive/unverified existing daemon fails closed rather than being force-terminated.
