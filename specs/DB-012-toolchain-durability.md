# DB-012 — Toolchain Durability and Error Recovery

Status: active

## Goal

Make DevBridge reliable under ordinary tool, model, compiler, build, test, and presentation failures without weakening authority boundaries or requiring human intervention for recoverable conditions.

DB-009 remains authoritative for durable effects and restart reconciliation. DB-003 and DB-008 remain authoritative for capability and supply-chain boundaries. This specification defines the local toolchain recovery behavior inside those constraints.

## Governing rule

**Be tolerant of representation, strict about meaning and authority. Preserve evidence, reconcile before repeating, and repair before escalating.**

A recoverable toolchain failure is not permission to broaden filesystem, process, credential, network, Git, or human-approval authority.

## Presentation-only result normalization

DevBridge may canonicalize a result only when the transformation is deterministic and preserves exactly one unambiguous JSON payload.

Allowed v0.1 presentation normalization is limited to:

- one leading UTF-8 BOM;
- surrounding JSON whitespace and ordinary LF/CRLF line endings;
- exactly one Markdown code fence containing exactly one JSON value, with an optional `json` fence label.

DevBridge must not guess through prose plus JSON, multiple candidate payloads, comments, trailing commas, single-quoted pseudo-JSON, conflicting objects, missing authority identifiers, or any transformation that changes meaning.

Ambiguous or semantic defects remain `PROTOCOL` failures.

## Structured result versus wrapper process outcome

A valid `devbridge/result-v1` written before the wrapper process exits is durable evidence and must not be discarded merely because the wrapper later exits nonzero.

- `blocked` and `failed` structured results remain conservative outcomes, with wrapper-exit evidence attached.
- `continue` remains a continuation outcome, with wrapper-exit evidence attached.
- `complete` remains candidate intent, not completion authority. DevBridge must still independently validate/seal the workspace before completion.
- a timeout or nonzero wrapper exit is recorded as evidence even when a valid structured result exists.

If there is no valid structured result, normal timeout/exit classification applies.

## Transient model/tool availability

Known, narrowly identified provider/tool availability failures may be classified `TRANSIENT`.

The initial v0.1 recognized condition is the observed local tool diagnostic equivalent to:

`Selected model is at capacity. Please try a different model.`

When no valid structured result exists, this condition may produce an automatic continuation from durable context. Retry remains bounded by the current local turn window and must not:

- switch tool/model/profile automatically;
- expand capabilities;
- discard workspace evidence;
- change the immutable baseline;
- duplicate already reconciled external effects.

### Persisted retry backoff

A retryable transient condition is state, not an in-memory sleep hint. Before another tool invocation DevBridge durably records at least:

- failure classification/kind;
- attempt count;
- chosen delay;
- absolute `notBefore` time;
- whether the current bounded turn window is exhausted.

For the initial model-capacity class, v0.1 uses exponential delays of 5 seconds, 10 seconds, 20 seconds, 40 seconds, then a 60-second cap. The absolute turn window remains the hard attempt bound.

If DevBridge or the host restarts during backoff, recovery must honor the remaining persisted delay before another invocation. It must not forget prior attempts, retry immediately merely because memory was lost, or sleep again for the full original interval after the deadline has partially elapsed.

The final allowed attempt does not schedule a useless delay after the window is already exhausted. Persistent transient failure reaches `waiting-feedback` rather than retrying forever. A matching trusted continuation may grant another bounded turn window under DB-006 without changing capabilities or resetting absolute turn identity.

### Deterministic transient diagnostic

DevBridge exposes a reserved built-in profile `devbridge-transient-recovery` for black-box validation of this behavior without consuming a coding-model/provider budget.

The diagnostic is fixed control-plane code. It:

1. emits the exact recognized capacity diagnostic and exits nonzero without a structured result for its first two invocations;
2. persists only its bounded synthetic attempt marker inside the reserved run directory;
3. writes a valid completion result on the third invocation;
4. removes its synthetic state marker on success;
5. accepts no remote executable path, command, delay, failure count, or capability grant.

The live run therefore proves the real coordinator classification/backoff/multi-turn path while remaining independent of actual provider capacity.

## Compiler/build/test failures

Compiler, linker, build-system, and test failures caused by the proposal are ordinary `CODE` evidence when the local toolchain itself remains healthy.

The normal recovery sequence is:

1. preserve source/workspace state;
2. capture bounded stdout, stderr, exit status, and relevant diagnostics;
3. classify proposal error versus toolchain/infrastructure error;
4. return proposal diagnostics for repair when appropriate;
5. rebuild/retest in the same managed workspace;
6. require a fresh workspace only when contamination is proven or cleanup cannot be trusted.

An intentional failure injected by a durability test is successful test evidence, not a task failure.

Missing/broken compiler or linker installation, inaccessible locally configured toolchain, corrupt build infrastructure, or policy-denied compilation/linking is `INFRASTRUCTURE` or `POLICY_SECURITY` as appropriate, not proposal `CODE`.

## Toolchain discovery

Machine-specific compiler/build paths are local authority.

Remote task text may request a compiler/build test but may not grant or choose arbitrary executable paths. Toolchain paths come from trusted local configuration or locally constrained discovery owned by DevBridge.

No durability test may install a compiler, linker, SDK, or build system, mutate PATH globally, or weaken sandboxing merely to make the test pass.

### Built-in native toolchain diagnostic

DevBridge exposes an enumerated built-in local profile named `devbridge-native-compiler`. The historical profile name is retained, but the profile validates the native compile/link/execute chain and is part of the trusted control plane, not a coding/model profile.

Selecting that exact profile requests a fixed diagnostic only. Remote content cannot supply or alter:

- compiler or linker executable paths;
- compiler or linker arguments;
- SDK/library paths;
- environment-variable values;
- shell commands;
- discovery roots;
- output paths outside DevBridge's reserved run directory.

The diagnostic locally discovers only constrained native C toolchain candidates, runs with `shell:false`, performs no network access, and operates only on DevBridge-generated temporary source, objects, executables, and runtime files in the reserved run directory.

It must execute these stateful recovery sequences in one probe workspace:

1. valid compile -> intentional syntax failure -> repair -> valid compile;
2. valid link -> execute and verify a fixed stdout marker plus process exit code;
3. intentional unresolved-symbol link failure -> repair -> valid relink -> execute and verify the same marker/exit code.

On Windows, locally constrained discovery may use the standard Visual Studio Installer `vswhere.exe` location derived from local environment, the VC toolset layout returned by that trusted local discovery, and a locally discovered Windows SDK import library. A custom no-CRT test entry point may be linked using fixed `/ENTRY`, `/SUBSYSTEM`, and `/NODEFAULTLIB` controls so the probe does not depend on a mutable developer-shell environment. On POSIX systems, discovery may use bounded compiler names resolved from the locally supplied PATH and the compiler driver for linking. The remote task never supplies those paths or flags.

The built-in profile name is reserved and cannot be shadowed by local JSON tool configuration.

## Evidence and cleanup

Every recovery attempt should retain enough bounded evidence to distinguish:

- original proposal failure;
- repair attempt;
- compiler failure versus linker failure;
- executable/runtime failure;
- tool/wrapper failure;
- transient availability failure;
- retry/backoff attempt and deadline;
- final verification result.

Temporary probes and compiler/build artifacts created solely for a non-destructive smoke must be removed, and final Git state must be independently checked. Failed, uncertain, or interrupted managed worktrees remain recovery evidence under DB-009.

## Required tests

Tests must cover at least:

- BOM, surrounding whitespace, LF/CRLF, and one JSON fence are accepted when the payload is unique;
- prose around JSON and multiple fenced payloads remain protocol failures;
- a valid conservative structured result survives a later nonzero wrapper exit;
- a structured completion with wrapper-exit mismatch still passes through independent candidate verification;
- the observed model-capacity condition without a structured result is classified transient;
- transient retries use persisted exponential backoff, honor remaining delay after restart, and do not delay after the final bounded attempt;
- trusted continuation at an exhausted turn-window frontier grants another bounded window without resetting absolute turn identity;
- the built-in transient diagnostic completes only after exercising the real multi-turn retry path and does not invoke a coding model;
- unrelated nonzero tool exits remain terminal/tool failures;
- compiler success -> intentional syntax failure -> diagnostic capture -> repair -> successful rebuild in one workspace;
- linker success -> executable marker/exit verification -> intentional unresolved-symbol failure -> repair -> relink -> re-execute in one workspace;
- the built-in native toolchain diagnostic uses only its fixed local profile and does not invoke a coding model;
- compiler/linker/build/test failures are distinguishable from toolchain infrastructure failure;
- interrupted build/retest leaves bounded evidence and recoverable workspace state;
- all non-destructive durability probes finish with their temporary artifacts removed and expected Git state restored.
