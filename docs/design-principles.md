# Design Principles

## Purpose first

DevBridge bridges a remote coordination channel and a local development environment. That makes it both an automation tool and a security boundary. Architectural decisions should be weighted in this order for the control path:

1. correctness and containment;
2. recoverability and provenance;
3. GitHub/API responsibility;
4. operator trust and observability;
5. portability and CLI flexibility;
6. throughput and convenience.

This ordering is contextual, not universal. Hot-path implementation details can weight performance differently after the control boundary is safe.

## LEGO

Build capabilities as small replaceable pieces with explicit studs:

- task source and exact-provenance gate;
- status/checkpoint/handoff sink;
- feedback/decision source;
- authentication provider;
- API client and budget policy;
- state store and effect-specific reconciliation;
- run coordinator;
- workspace/Git manager;
- sandbox/containment provider;
- deterministic operation registry;
- coding-tool/proposal runner;
- validator/evidence collector;
- context capsule/handoff builder;
- tool inventory/onboarding boundary;
- agent identity/lease coordinator;
- runtime supervisor/update validator;
- daemon governance/control boundary;
- clock/logger.

A new task transport, local CLI surface, deterministic tool, decision transport, sandbox provider, release transport, or coordination projection should normally be an adapter behind an existing authority boundary, not a rewrite of orchestration logic.

## SOLID

- Single responsibility: polling, provenance, policy, persistence, execution, validation, decision state, leases, runtime supervision, and reporting do not own each other's details.
- Open/closed: add a CLI/tool/task transport/provider by implementing a contract rather than branching throughout the core.
- Liskov: adapters must honor the same safety and lifecycle semantics, not merely the same method names.
- Interface segregation: do not hand an adapter a broad capability when it needs a narrow one.
- Dependency inversion: application flow depends on ports/contracts; GitHub, Git, filesystem, sandbox, process, OS priority, and credential APIs sit at the edge.

## CUPID

- Composable: outputs become explicit validated inputs to the next stage.
- Unix-like: favor transparent data and exit semantics, but do not use shell strings as an integration shortcut.
- Predictable: state transitions, retries, task revisions, checkpoints, approvals, lease epochs, verification identities, and daemon-control ownership are inspectable/deterministic.
- Idiomatic: use Node primitives where they are sufficient; use platform adapters where Node cannot honestly enforce the required boundary.
- Domain-based: name concepts after the product domain: task revision, run, proposal, controller plan, checkpoint, decision subject, lease/fence, publication baseline, context capsule, capability policy, status projection.

## KISS

Simple does not mean permissive. Prefer one serial request queue over a clever rate scheduler; one structured task envelope over ambiguous command formats; one managed workspace root over arbitrary local paths; one owned/coalesced status projection over chatty streams; one authoritative run coordinator over implicit state spread across event listeners.

Current multi-agent coordination is deliberately narrow: DB-016 lets multiple authorized installations share a queue through signed exact-task leases and fencing, while each daemon still admits work serially. **Do not infer a parallel scheduler, per-workstation task-routing ACL, or new capability authority merely because distributed lease coordination exists.** Add those only behind explicit contracts when a real workload requires them.

Likewise, DB-018 below-normal child priority is a simple workstation QoS mechanism. Do not represent it as hard CPU/memory/thread containment or build a fake portable quota layer around APIs that cannot enforce one.

## Agents propose; DevBridge decides

Remote and local LLMs are subordinate proposal engines. They can be creative about solutions without being authoritative about machine capability, Git state, publication state, lease ownership, runtime activation, or whether a consequential boundary may be crossed.

This separation allows DevBridge to use multiple tools/agents without letting disagreement between them become disagreement about control-plane truth.

The same principle applies to tool documentation and repository code: observation may inform a proposal or bounded schema, but does not create executable authority.

## Trust is dimensional, not one boolean

Do not collapse distinct permissions into a generic concept of a “trusted developer” or “trusted agent.” Current important dimensions include:

- trusted task author (`github.trustedActorIds`): may submit remote development jobs to that runner's configured queue;
- trusted decision actor for one or more DB-007 classes;
- trusted DB-016 peer public key: may produce coordination lease evidence the runner recognizes;
- locally enabled tool/operation authority;
- local repository/workspace/baseline authority;
- publication/release authority.

One dimension does not imply another.

In particular, DB-016 coordination identity is not current per-workstation task addressing. If one developer must not dispatch work to another developer's workstation, enforce that today through the target runner's local queue/task-author policy until a dedicated addressed-dispatch contract exists.

## Human judgment is leverage, not a mutex

Human attention should be used where judgment has unusually high leverage: architectural commitments, irreversible effects, trust-policy changes, and decisions whose cost of being wrong is much larger than the cost of pausing that specific boundary.

The default pattern is:

`work -> validate -> checkpoint if warranted -> continue reversible work -> incorporate decision -> proceed`

not:

`work -> uncertainty -> stop everything -> wait`.

A checkpoint is distinct from a hard gate. Human review should prevent refactor hell without making ordinary development depend on continuous synchronous approval.

When a broad refactor is proposed for a narrow task, checkpoint the architectural decision and spend bounded effort searching for a solution that preserves the existing architecture. If those alternatives fail, present failures as evidence for the refactor rather than asking a human to trust the first proposal.

Human attention itself has a budget: deduplicate equivalent questions, bundle closely related decisions, avoid repeated pings, and never turn silence into approval.

## Domain-appropriate foundations

Avoid accidental limits that become architecture. Byte caps, output tails, context budgets, polling intervals, retry bounds, refactor/churn thresholds, checkpoint retention, decision expiry, lease TTL/skew, and process-priority policy must be explicit where they materially affect behavior, with safe defaults and hard safety ceilings where needed.

Thresholds detect where review may help; they do not substitute for domain reasoning. A large diff is not automatically wrong and a small diff is not automatically safe.

One is currently the truthful effective task-concurrency limit. Do not accept a larger configuration value as proof of a parallel scheduler until durable independent admission, lease, effect, liveness, and resource accounting are implemented.

## Enforcement claims require evidence

Do not confuse requested policy, declared behavior, and observed enforcement.

Examples:

- a tool profile's `sandbox.enforcement` string is a declaration, not proof;
- Bubblewrap package presence is not enough; the actual boundary probe must pass;
- a lease signature proves coordination identity/subject, not task/capability authority;
- a successful prior test run is not current verification after candidate/baseline drift;
- a priority request is not applied QoS until OS application succeeds;
- a remote comment that looks like a DevBridge protocol object is not authoritative without the typed source/provenance path.

When an enforcement layer cannot prove the requested semantics, fail closed or report the limitation honestly rather than translating aspiration into `true`.

## Recovery before repetition

An ambiguous external effect is an observation problem before it is a retry problem.

Persist intent/evidence, observe exact current state, reconcile idempotently when possible, and refuse unexplained divergence. This applies to task-branch publication, lease CAS, runtime activation, owned projections, daemon-control ownership, and future remote effects.

A generic retry loop is never a substitute for effect-specific identity and reconciliation.

## Accountability without log spam

Keep useful state transitions, request-budget observations, run/task identity, tool/provider identity, Git baseline/HEAD/verified candidate identity, lease epoch/ref identity, proposal/checkpoint digests, tests, accepted decisions, runtime activation evidence, and errors. Do not dump secrets, private keys, complete environments, or unbounded process output.

Remote progress should be coalesced; local diagnostics may be more detailed but remain bounded. Decision requests should be evidence-rich enough to answer once rather than forcing a human to reconstruct the run from transcript noise.

Historical handoffs/audits are evidence of what was true at their checkpoint. They must not be silently rewritten to look current or allowed to override the active specs/roadmap.
