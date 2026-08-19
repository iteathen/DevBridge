# Verification governance

DevBridge treats verification as a control-plane responsibility, not as an unbounded instruction to run whatever test command an agent happens to request.

The normative contract is `specs/DB-019-verification-cost-evidence.md`. This document is the practical engineering guide for applying that contract.

## The problem is not simply long tests

A 30-minute or 60-minute test can be completely appropriate when it provides unique qualification evidence. The undesirable behavior is paying that cost accidentally or repeatedly, losing the result after a restart, hiding progress for long periods, or killing a legitimate suite because every process shares one arbitrary global timeout.

The target property is:

> No expensive test runs accidentally, redundantly, silently, or without a defined reason for being on the candidate's verification path.

## Default verification ladder

Use explicit layers rather than treating `run all tests` as the default safe action:

| Tier | Typical purpose | Typical cost |
| --- | --- | --- |
| immediate | syntax, schema/config parsing, static invariants, cheap focused checks | seconds |
| affected-area | changed ownership boundary plus direct contracts | seconds to a few minutes |
| integration | meaningful subsystem combinations | minutes |
| full-regression | broad repository regression | potentially expensive |
| qualification | platform, installer, sandbox, sanitizer, soak, hardware, release, adversarial | intentionally expensive |

The durations are descriptive, not hard limits. Repositories may have different cost profiles.

## Selection rule

Start from the changed ownership boundary and the risk being introduced.

Run the cheapest checks capable of rejecting a bad candidate first. Escalate to broader tiers when dependencies, contracts, or explicit qualification triggers require them.

Do not skip a required qualification suite merely because it is expensive. Do not run one merely because it exists.

Examples of changes that should normally have explicit qualification triggers include security/sandbox boundaries, installer/bootstrap/runtime activation, Git/GitHub control behavior, persistence/recovery, public protocols/schemas, tool authority/discovery, and platform execution providers.

## Runtime knowledge

Verification planning should know enough about test cost to avoid surprises. Stable suite identities should accumulate bounded historical timing and carry local metadata such as tier, ownership tags, resource class, timeout policy, environment requirements, and whether the suite is decomposable.

A plan containing a historically expensive suite should be able to explain why it is required before launching it.

Historical timing is guidance, not a correctness claim.

## Evidence is an asset

A passing expensive test is valuable durable evidence. Do not throw it away just because the daemon restarted or a chat context rolled over.

Reusable evidence must be bound to the exact subject that was verified, including the candidate/head, publication baseline, test identity, relevant policy version, platform/sandbox identity, and relevant toolchain/configuration identity.

When those identities still match, reuse the evidence. When they do not, invalidate the affected evidence. Prefer selective invalidation over discarding every unrelated passing result.

A model saying "tests passed" is not evidence by itself.

## Resume long suites where semantics permit

A monolithic 40-minute command is operationally worse than independently identified cases totaling 40 minutes when the test semantics permit decomposition.

Independent cases allow progress reporting, selective reruns, failure localization, restart recovery, and future safe scheduling.

Do not split a suite when shared state, ordering, timing, or isolation is part of what the suite is proving.

## Timeouts

Do not use one global test timeout as the governing model.

A registered suite should have timing policy appropriate to that suite:

- expected/historical runtime;
- a soft slow-test/liveness threshold;
- a hard timeout/deadline;
- a locally controlled hard safety ceiling.

Crossing the expected runtime is a reason to surface liveness, not automatically to fail. Crossing the hard timeout is a bounded runaway/hang condition.

Remote task text and model output cannot increase timeouts or remove safety ceilings.

## Liveness

Long verification must never look indistinguishable from a frozen DevBridge process.

Useful bounded local status includes current suite/case, elapsed duration, historical expectation, last meaningful progress, process aliveness/ownership, soft-slow state, hard deadline, and completed/remaining counts when available.

GitHub status remains coalesced and rate-budgeted. Do not turn progress into heartbeat-comment spam.

## Failure ordering

If a cheap prerequisite already proves a candidate invalid, stop launching expensive downstream checks that cannot change that verdict.

Distinguish candidate failures from infrastructure failures. A compiler/test assertion failure is different from a sandbox/provider outage, timeout, lease loss, host interruption, or control-plane error.

## Agent behavior

Agents may recommend tests, but DevBridge owns the verification plan and evidence store.

An agent request such as `run all tests` is intent, not unlimited cost authority. DevBridge resolves it through repository/local policy.

If exact valid evidence already exists, reference/reuse it rather than paying for the same expensive suite again merely because another agent or context requested it.

## Parallelism

Do not optimize long testing by simply increasing a concurrency number.

Future parallel verification must account for resources such as CPU, RAM, disk, fixed ports, mutable caches, installer state, sandbox providers, and exclusive GPU/hardware. DB-018 still governs task-level admission and workstation resource policy.

## Review checklist

When adding or changing an expensive test, answer these questions in the same change:

- What unique risk/evidence does this test cover?
- Which verification tier does it belong to?
- What changes should trigger it?
- Can cheaper checks reject bad candidates first?
- What is its expected/historical runtime?
- What is its soft-slow and hard-timeout policy?
- Is it decomposable without changing test semantics?
- What exact identities make its passing evidence reusable?
- What changes invalidate that evidence?
- Does it require an exclusive/shared resource class?
- How will a human/operator distinguish healthy long execution from a hang?

If those questions have no answers, the expensive test is not yet integrated into DevBridge's verification model even if the command itself works.
