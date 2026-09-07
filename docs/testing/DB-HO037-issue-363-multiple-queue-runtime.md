# DB-HO037 — issue #363 multiple-queue runtime

Status: implemented and qualified from exact predecessor `56a322667bdc394c041cc8c6adf4d9311c98dbf1` on `stage8/362-protected-activity-channel`.

## Assessment

Setup already discovers, verifies, and durably accepts multiple stable repository subjects. The operational config and runtime still own exactly one `github.queueRepository`. `poll-once`, `run-once`, the daemon, runtime state, leases, status delivery, handoffs, doctor defaults, and error reconciliation therefore cannot truthfully activate all setup-selected queues.

Generating a normal config from only the first selected repository would be a false setup-completion claim. Starting one complete independent daemon per repository would duplicate credential/rate-limit authority, admission, provider execution composition, inventory work, and resource usage. It would also make cross-queue serialization accidental rather than enforced.

The current repository-specific owners are otherwise correctly scoped. Run state keys, lease subjects, issue sources, status reporters, decision sources, handoff projections, and task-branch publication all bind one exact queue repository. They should remain unchanged behind one per-queue composition edge rather than be taught about sibling queues.

## Primary-source research

GitHub's [REST API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api) requires efficient authenticated polling, server poll-interval compliance, authenticated conditional requests, serial rather than concurrent requests to avoid secondary limits, mutation pacing, and evidence-driven rate-limit backoff.

GitHub's [REST API rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) confirms that the authenticated identity's primary budget is shared and that secondary limits cover concurrent requests and content-generating activity. Multiple locally configured queues therefore must not receive independent fictional budgets.

## Reassessment

The correct topology is one host-owned ordered runtime collection with:

- one authenticated credential context;
- one GitHub client and conditional-validator store;
- one shared `RateBudget` and mutation pacer;
- one exact queue-scoped runtime/coordinator per configured queue;
- one serial collection cycle under the existing daemon/task admission;
- bounded queue-bound failure evidence;
- one aggregate next-poll decision derived from every queue and the shared budget.

The configuration contract moves directly from singular `queueRepository` to bounded, unique `queueRepositories`. There is no singular compatibility alias, migration fallback, or silent first-entry selection in runtime behavior. A CLI command that semantically targets one queue may use the first locally configured queue only as its documented local default; explicit `--repository` still selects another configured queue and must not grant an unconfigured subject.

One queue's ordinary polling/runtime failure should not suppress later healthy queues. A shared rate-limit stop is different: it is evidence about the common authenticated budget and must stop the collection until the derived retry frontier.

## LEGO boundaries

- The plural config validator owns only normalized queue subjects and uniqueness/bounds.
- The shared GitHub context owns credential resolution, one conditional-state port, one client, and one rate budget; it knows no queue topology.
- The existing repository runtime remains a one-queue composition and receives its exact subject as local input.
- The runtime collection owns ordered serial invocation and aggregate evidence; it does not learn run, lease, Git, status, provider, guest, or publication internals.
- Queue-specific owners continue to receive exactly one queue subject and cannot inspect siblings.

## Dependency-ordered implementation plan

1. Replace the singular config field with a 1–4,096 entry unique plural queue list and update checked-in config/docs/tests without a legacy alias.
2. Make the one-queue runtime receive its exact queue subject explicitly and remove internal reads of singular config state.
3. Extract one shared authenticated GitHub/rate-budget context and allow queue runtimes to consume it transiently.
4. Add an ordered runtime collection and serial collection-cycle adapter with queue-bound result/error projection.
5. Stop the collection globally on shared rate-limit evidence; continue after ordinary per-queue failures.
6. Cut `run-once` and daemon composition to the collection while retaining the existing single-cycle admission.
7. Cut `poll-once`, doctor admission, handoff defaults, and explicit repository validation to the plural contract.
8. Test schema rejection/uniqueness/bounds, shared client/budget identity, serial order, failure isolation, rate-limit stop, queue-state separation, and unchanged one-queue behavior.
9. Run focused, preflight, full-suite, and diff gates; document and push before operational setup config publication consumes the contract.

## Explicit exclusions

This slice does not write or enable the setup-generated operational configuration, grant task-author authority, invoke UAC, mutate a VM/network/service, execute a physical canary, enable coding models, implement webhooks, or implement GPU/CUDA behavior.

## Implementation

- `github.queueRepositories` is now the only operational queue schema. It accepts 1–4,096 unique, case-insensitively distinct `owner/name` subjects and rejects the former singular field instead of retaining a compatibility alias.
- The shared GitHub runtime context receives only authentication, API-version, rate-policy, state-root, environment, and transport inputs. It receives no queue collection or repository identity and owns one serialized client, conditional-validator store, credential provider, mutation pacer, and rate budget.
- Each existing runtime is explicitly composed for one configured queue. Its run state, task source, feedback/decision source, status and handoff projections, lease store/manager, gates, and coordinators remain unaware of sibling queues.
- The runtime collection constructs members in configured order over the exact shared context. `run-once` and daemon mode traverse that collection serially under the existing one-cycle admission boundary.
- Aggregate results overwrite any member-supplied queue field with the host-selected subject. Ordinary member failures are bounded and reported against that member's active run when available; a shared `RateLimitError` halts later polling.
- `poll-once` uses the same shared authority and serial order without constructing execution runtimes. Doctor checks every configured queue by default, while handoff commands default locally to the first queue and accept only explicit configured subjects.
- The shared rate-budget projection now accounts for the configured collection's estimated request count rather than treating every queue as a separate two-request account.

No VM, provider, repository-execution, publication, task-author, or model authority was added by this slice.

## Verification

- Focused normal/failure/boundary coverage proves plural schema rejection and bounds, queue-selection denial, shared-context topology isolation, exact context identity, stable serial order, ordinary failure isolation, host-bound aggregate subjects, global rate-limit stop, and daemon singleton/admission behavior.
- Candidate preflight passes all syntax, JSON, and targeted gates.
- The complete repository suite passes with the platform-declared Windows skips only; exact final counts are recorded in the issue update and commit evidence.
- `git diff --check` passes, and production source contains no operational read of the removed singular configuration field.
