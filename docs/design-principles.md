# Design Principles

## Purpose first

PATCH-POLLER bridges a remote coordination channel and a local development environment. That makes it both an automation tool and a security boundary. Architectural decisions should be weighted in this order for the control path:

1. correctness and containment;
2. recoverability and provenance;
3. GitHub/API responsibility;
4. operator trust and observability;
5. portability and CLI flexibility;
6. throughput and convenience.

This ordering is contextual, not universal. Hot-path implementation details can weight performance differently after the control boundary is safe.

## LEGO

Build capabilities as small replaceable pieces with explicit studs:

- task source;
- status/checkpoint sink;
- feedback/decision source;
- authentication provider;
- API client and budget policy;
- state store;
- run coordinator;
- workspace manager;
- sandbox/containment provider;
- coding-tool/proposal runner;
- validator/evidence collector;
- context capsule builder;
- clock/logger.

A new task transport, local CLI, decision transport, or sandbox provider should normally be an adapter, not a rewrite of orchestration logic.

## SOLID

- Single responsibility: polling, policy, persistence, execution, validation, decision state, and reporting do not own each other's details.
- Open/closed: add a CLI or task transport by implementing a contract rather than branching throughout the core.
- Liskov: adapters must honor the same safety and lifecycle semantics, not merely the same method names.
- Interface segregation: do not hand an adapter a broad capability when it needs a narrow one.
- Dependency inversion: application flow depends on ports; GitHub, Git, filesystem, sandbox, and process APIs sit at the edge.

## CUPID

- Composable: outputs become explicit inputs to the next stage.
- Unix-like: favor transparent data and exit semantics, but do not use shell strings as an integration shortcut.
- Predictable: state transitions, retries, task revisions, checkpoints, and approvals are inspectable and deterministic.
- Idiomatic: use Node primitives where they are sufficient.
- Domain-based: name concepts after the product domain: task revision, run, proposal, checkpoint, decision surface, context capsule, capability policy, status report.

## KISS

Simple does not mean permissive. Prefer one serial request queue over a clever rate scheduler; one structured task envelope over multiple ambiguous formats; one managed workspace root over arbitrary local paths; one durable status comment over chatty comment streams; one authoritative run coordinator over implicit state spread across event listeners.

Do not build distributed worker coordination until there is a real need. Version 1 assumes one active PATCH-POLLER worker per queue.

## Agents propose; PATCH-POLLER decides

Remote and local LLMs are subordinate proposal engines. They can be creative about solutions without being authoritative about machine capability, Git state, publication state, or whether a consequential boundary may be crossed.

This separation allows PATCH-POLLER to use multiple tools or agents without letting disagreement between them become disagreement about control-plane truth.

## Human judgment is leverage, not a mutex

Human attention should be used where judgment has unusually high leverage: architectural commitments, irreversible effects, trust-policy changes, and decisions whose cost of being wrong is much larger than the cost of pausing that specific boundary.

The default pattern is:

`work -> validate -> checkpoint if warranted -> continue reversible work -> incorporate decision -> proceed`

not:

`work -> uncertainty -> stop everything -> wait`.

A checkpoint is therefore distinct from a hard gate. Human review should prevent refactor hell without making ordinary development depend on continuous synchronous approval.

When a broad refactor is proposed for a narrow task, checkpoint the architectural decision and spend a bounded amount of effort searching for a solution that preserves the existing architecture. If those alternatives fail, present the failures as evidence for the refactor rather than asking a human to trust the first proposal.

Human attention itself has a budget: deduplicate equivalent questions, bundle closely related decisions, avoid repeated pings, and never turn silence into approval.

## Domain-appropriate foundations

Avoid accidental limits that become architecture. Byte caps, output tails, context budgets, polling intervals, retry bounds, refactor/churn thresholds, checkpoint retention, and decision expiry must be explicit configuration with safe defaults and hard safety ceilings where needed.

Thresholds detect where review may help; they do not substitute for domain reasoning. A large diff is not automatically wrong and a small diff is not automatically safe.

## Accountability without log spam

Keep useful state transitions, request-budget observations, run identity, tool identity, Git HEAD, proposal/checkpoint digests, tests, accepted decisions, and errors. Do not dump secrets, complete environments, or unbounded process output.

Remote progress should be coalesced; local diagnostics may be more detailed but remain bounded. Decision requests should be evidence-rich enough to answer once rather than forcing a human to reconstruct the run from transcript noise.
