# DB-HO014 — issue #315 bounded preflight failure evidence

Status: hosted candidate complete; exact-head CI pending. Implementation starts from exact `cuda-target` baseline `f1f0400f7087a9ea81f69bb68b0d16c1af9b2524` on isolated branch `infra/315-preflight-failure-evidence`.

## Assessment

PR #314 CI run `33119131428` attempt 1 produced one Windows targeted-preflight failure among 147 tests. The exact full Windows suite passed, and the targeted suite passed locally before and after the run. The preflight wrapper retained only the last 4,000 output characters, beginning midway through passing test 129, so the failing test identity and assertion were irretrievable. Attempt 2 passed.

This is an evidence-boundary defect independent of the lifecycle-record change. DB-019 requires a candidate failure to remain distinguishable from an infrastructure failure and requires bounded exact evidence suitable for assessment rather than blind repetition.

## Primary-source research and reassessment

Node documents that `spawnSync` returns captured stdout/stderr and bounds each with `maxBuffer`. Node's test runner uses TAP by default when stdout is not a TTY, but explicitly warns that reporter text may change and should not be treated as a programmatic result API.

The preflight wrapper therefore must not promote reporter parsing into pass/fail authority. The child exit status remains authoritative. Reporter/error markers are only bounded diagnostic hints used to retain the relevant neighborhood; if no recognized hint exists, a deterministic head/tail projection still preserves both initial and terminal evidence.

Primary sources:

- [Node.js 22 child-process API](https://nodejs.org/download/release/v22.12.0/docs/api/child_process.html)
- [Node.js 22 test-runner reporters](https://nodejs.org/download/release/v22.15.0/docs/api/test.html)

## Plan

1. Add one neutral bounded-failure projection over process error, stderr, and stdout.
2. Prefer a bounded neighborhood around the first recognized failure hint and always retain the terminal summary; fall back to deterministic head/tail evidence.
3. Keep the child exit/error status as the only verdict and preserve existing shell-free invocation, timeout, and maximum capture bounds.
4. Test long early TAP failure, non-TAP failure, simultaneous stderr/stdout, small output, and strict output bounds.
5. Add the focused diagnostic test to cheap preflight, then run preflight and the full suite before isolated publication.

This change does not modify test selection, retry policy, repository execution, VM behavior, or lifecycle code.

## Implemented candidate

- `boundedProcessFailureEvidence` combines process error, stderr, and stdout instead of allowing one stream to discard another.
- Evidence at or below the bound is preserved exactly with local stream labels.
- Larger evidence retains a bounded character prefix immediately before the first recognized diagnostic hint, the hint and its following neighborhood, and the terminal summary. If no hint is recognizable, it uses a deterministic head/tail projection.
- The output bound is locally fixed at 4,000 characters for preflight errors and accepts only a tested 256–65,536 range when called directly.
- Child exit/error status remains the verdict. The projection neither decides whether a test failed nor changes timeout, `maxBuffer`, shell-free invocation, selection, or retry behavior.
- Cheap preflight now includes the focused diagnostic contract so later changes cannot restore tail-only evidence.

## Local verification evidence

1. Focused diagnostic tests: 4 passed, 0 failed.
2. `npm run preflight`: passed (`syntaxFiles: 43`, `jsonFiles: 2`, `targetedTests: 37`).
3. Full `npm test`: 1,191 passed, 0 failed, 9 platform-capability skips; 1,200 total.

Ubuntu and Windows exact-head CI remains required before integration. The underlying one-off test miss from run `33119131428` cannot be classified further because attempt 1 permanently lost its identity; a future recurrence will now preserve enough bounded evidence to open or update the correct owning issue.
