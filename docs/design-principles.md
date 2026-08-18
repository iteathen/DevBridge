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
- status sink;
- authentication provider;
- API client and budget policy;
- state store;
- workspace manager;
- sandbox/containment provider;
- coding-tool runner;
- context capsule builder;
- clock/logger.

A new task transport or local CLI should normally be an adapter, not a rewrite of orchestration logic.

## SOLID

- Single responsibility: polling, policy, persistence, execution, and reporting do not own each other's details.
- Open/closed: add a CLI or task transport by implementing a contract rather than branching throughout the core.
- Liskov: adapters must honor the same safety and lifecycle semantics, not merely the same method names.
- Interface segregation: do not hand an adapter a broad capability when it needs a narrow one.
- Dependency inversion: application flow depends on ports; GitHub and process APIs sit at the edge.

## CUPID

- Composable: outputs become explicit inputs to the next stage.
- Unix-like: favor transparent data and exit semantics, but do not use shell strings as an integration shortcut.
- Predictable: state transitions, retries, and task revisions are inspectable and deterministic.
- Idiomatic: use Node primitives where they are sufficient.
- Domain-based: name concepts after the product domain: task revision, run, context capsule, capability policy, status report.

## KISS

Simple does not mean permissive. Prefer one serial request queue over a clever rate scheduler; one structured task envelope over multiple ambiguous formats; one managed workspace root over arbitrary local paths; one durable status comment over chatty comment streams.

Do not build distributed worker coordination until there is a real need. Version 1 assumes one active PATCH-POLLER worker per queue.

## Domain-appropriate foundations

Avoid accidental limits that become architecture. Byte caps, output tails, context budgets, polling intervals, and retry bounds must be explicit configuration with safe defaults and hard safety ceilings where needed.

## Accountability without log spam

Keep useful state transitions, request-budget observations, run identity, tool identity, Git HEAD, tests, and errors. Do not dump secrets, complete environments, or unbounded process output. Remote progress should be coalesced; local diagnostics may be more detailed but remain bounded.
