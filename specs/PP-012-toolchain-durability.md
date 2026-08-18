# PP-012 — Toolchain Durability and Error Recovery

Status: active

## Goal

Make PATCH-POLLER reliable under ordinary tool, model, compiler, build, test, and presentation failures without weakening authority boundaries or requiring human intervention for recoverable conditions.

PP-009 remains authoritative for durable effects and restart reconciliation. PP-003 and PP-008 remain authoritative for capability and supply-chain boundaries. This specification defines the local toolchain recovery behavior inside those constraints.

## Governing rule

**Be tolerant of representation, strict about meaning and authority. Preserve evidence, reconcile before repeating, and repair before escalating.**

A recoverable toolchain failure is not permission to broaden filesystem, process, credential, network, Git, or human-approval authority.

## Presentation-only result normalization

PATCH-POLLER may canonicalize a result only when the transformation is deterministic and preserves exactly one unambiguous JSON payload.

Allowed v0.1 presentation normalization is limited to:

- one leading UTF-8 BOM;
- surrounding JSON whitespace and ordinary LF/CRLF line endings;
- exactly one Markdown code fence containing exactly one JSON value, with an optional `json` fence label.

PATCH-POLLER must not guess through prose plus JSON, multiple candidate payloads, comments, trailing commas, single-quoted pseudo-JSON, conflicting objects, missing authority identifiers, or any transformation that changes meaning.

Ambiguous or semantic defects remain `PROTOCOL` failures.

## Structured result versus wrapper process outcome

A valid `patch-poller/result-v1` written before the wrapper process exits is durable evidence and must not be discarded merely because the wrapper later exits nonzero.

- `blocked` and `failed` structured results remain conservative outcomes, with wrapper-exit evidence attached.
- `continue` remains a continuation outcome, with wrapper-exit evidence attached.
- `complete` remains candidate intent, not completion authority. PATCH-POLLER must still independently validate/seal the workspace before completion.
- a timeout or nonzero wrapper exit is recorded as evidence even when a valid structured result exists.

If there is no valid structured result, normal timeout/exit classification applies.

## Transient model/tool availability

Known, narrowly identified provider/tool availability failures may be classified `TRANSIENT`.

The initial v0.1 recognized condition is the observed local tool diagnostic equivalent to:

`Selected model is at capacity. Please try a different model.`

When no valid structured result exists, this condition may produce an automatic continuation from durable context. Retry remains bounded by the existing run turn budget and must not:

- switch tool/model/profile automatically;
- expand capabilities;
- discard workspace evidence;
- change the immutable baseline;
- duplicate already reconciled external effects.

Persistent transient failure eventually reaches the normal bounded waiting/failure frontier rather than retrying forever.

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

Missing/broken compiler installation, inaccessible locally configured toolchain, corrupt build infrastructure, or policy-denied compilation is `INFRASTRUCTURE` or `POLICY_SECURITY` as appropriate, not proposal `CODE`.

## Toolchain discovery

Machine-specific compiler/build paths are local authority.

Remote task text may request a compiler/build test but may not grant or choose arbitrary executable paths. Toolchain paths come from trusted local configuration or locally constrained discovery owned by PATCH-POLLER.

No durability test may install a compiler, mutate PATH globally, or weaken sandboxing merely to make the test pass.

## Evidence and cleanup

Every recovery attempt should retain enough bounded evidence to distinguish:

- original proposal failure;
- repair attempt;
- tool/wrapper failure;
- transient availability failure;
- final verification result.

Temporary probes and compiler/build artifacts created solely for a non-destructive smoke must be removed, and final Git state must be independently checked. Failed, uncertain, or interrupted managed worktrees remain recovery evidence under PP-009.

## Required tests

Tests must cover at least:

- BOM, surrounding whitespace, LF/CRLF, and one JSON fence are accepted when the payload is unique;
- prose around JSON and multiple fenced payloads remain protocol failures;
- a valid conservative structured result survives a later nonzero wrapper exit;
- a structured completion with wrapper-exit mismatch still passes through independent candidate verification;
- the observed model-capacity condition without a structured result is classified transient and retried only within bounded run budget;
- unrelated nonzero tool exits remain terminal/tool failures;
- compiler success -> intentional syntax failure -> diagnostic capture -> repair -> successful rebuild in one workspace;
- compiler/linker/build/test failures are distinguishable from toolchain infrastructure failure;
- interrupted build/retest leaves bounded evidence and recoverable workspace state;
- all non-destructive durability probes finish with their temporary artifacts removed and expected Git state restored.
