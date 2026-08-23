# Nested LEGO restructuring plan

## Purpose

DevBridge's LEGO rule is an ownership rule, not a file-size rule.

A domain may legitimately be large. A large LEGO can itself be a collection of smaller nested LEGOs. The architecture problem appears when a large parent domain is implemented as one indivisible piece with enough independent mechanics, state machines, or recovery paths that an agent can complete one local task while losing attention on obligations elsewhere in the same implementation surface.

The restructuring goal is therefore:

> **Keep the existing parent LEGO intact, but construct its internals from smaller nested LEGOs whose boundaries follow real ownership and reasoning seams.**

This is an agent-reliability and maintainability program. It is not a line-count cleanup and not permission to redesign working authority boundaries.

Umbrella issue: #244.

## Governing doctrine

### Force LEGO invariants, not LEGO geometry

Do not prescribe a universal directory template such as `index.js`, `ports.js`, `state.js`, and `service.js` for every module.

Different domains have different natural structures:

- a lifecycle parent may naturally contain catalog, transition, generation, and reconciliation pieces;
- a protocol endpoint may naturally contain framing, containment, operation-ledger, execution, and transfer pieces;
- a provider adapter may naturally contain identity, storage, observation, provisioning, and lifecycle pieces;
- a composition root may remain primarily topology wiring and need only a few local mechanics extracted.

The structure follows the domain. The rules governing each connection remain consistent.

### A parent LEGO may be a collection

A parent LEGO keeps its externally meaningful identity and responsibility even when its implementation becomes a directory or tree of nested LEGOs.

For example, a possible internal shape for the persistent-environment domain is:

```text
persistent-environments/
    parent/facade
    catalog/
    guard/
    provisioning/
    transition/
    generation/
    retirement/
    reconciliation/
```

This example is illustrative, not a required final shape.

Callers should still address the **Persistent Environments** parent contract. They should not learn that a particular reconciliation child, catalog child, or transition child currently exists.

### Recursive nesting is valid

A nested LEGO may itself become a parent collection if its own internal reasoning surface later becomes too large.

Do not flatten a domain simply because nesting already exists. Apply the same ownership test recursively.

## What must not change accidentally

Nested restructuring is behavior-preserving by default.

For each target, preserve wherever practical:

- parent identity and responsibility;
- caller-facing studs/contracts;
- authority ownership;
- durable protocols and state identity;
- recovery semantics;
- security/capability boundaries;
- provider/repository/model isolation;
- externally visible behavior.

If restructuring reveals a real defect, track/fix the defect explicitly. Do not hide a semantic change inside a mechanical split.

## Rules for nested children

Every child LEGO must satisfy the same LEGO principles as a top-level LEGO.

1. **Local responsibility** — own one coherent mechanic, state machine, value model, or bounded subdomain.
2. **Local naming** — studs describe local data/action rather than sibling identities.
3. **Sibling independence** — a child does not know another child exists merely because the parent wires both.
4. **Parent-owned topology** — the parent/facade/composition layer connects nested pieces.
5. **Authority containment** — extracting mechanics must not duplicate or distribute the parent's authority.
6. **No helper dumping ground** — shared behavior becomes a separate nested LEGO only when it has a real independent contract.
7. **No size theater** — do not split cohesive code solely to reach a line/file target.
8. **No public-surface explosion** — nested children do not automatically become new application-wide services.
9. **Tests follow responsibility** — focused child tests supplement, not replace, parent/integration proofs.

## How to decide that a piece needs nesting

File size is a useful warning signal, not a rule.

Stronger signals are:

- multiple durable effect types in one piece;
- multiple independent recovery/reconciliation paths;
- multiple state machines with different failure semantics;
- unrelated policy, persistence, transport, and execution mechanics in one reasoning surface;
- test suites already dividing naturally into several behavioral families;
- a bounded change requiring an agent to inspect most of a large file to avoid violating distant invariants;
- repeated defects caused by concentrating on one local path while overlooking another path in the same parent implementation.

The practical success test is:

> **Can an agent enter one nested piece, understand its local contract and invariants, complete a bounded task, and know what must remain true without loading the entire parent implementation into active attention?**

## Restructuring method

Each issue should use this sequence, adjusted to the domain rather than applied mechanically.

### 1. Freeze the parent contract

Before moving code, identify:

- the parent responsibility;
- current public studs;
- authority owned by the parent;
- durable protocol/state identities;
- security/recovery invariants;
- parent-level tests that prove the whole LEGO.

The restructuring plan must state what remains parent-owned.

### 2. Map internal ownership seams

Group behavior by actual responsibility/state/effect ownership.

Prefer seams that already have different invariants or tests. Do not group by arbitrary line ranges.

Candidate seams are hypotheses until implementation inspection confirms them.

### 3. Define local child studs

For each proposed nested child, define the smallest local input/output needed by the parent.

Names must remain intrinsic to that child's responsibility. Do not name another nested child in the child's contract unless that identity is actually part of the child's own domain.

### 4. Extract one coherent nested boundary at a time

Move a complete responsibility, including its invariant enforcement and focused tests.

Do not leave half of one state machine in the parent and half in a child simply to keep a diff small.

### 5. Keep parent composition obvious

The parent should make the internal topology understandable without reimplementing child business rules.

A large parent directory is acceptable. A thin or moderately sized facade is desirable when it follows naturally, but it is not a numeric acceptance criterion.

### 6. Prove child and parent behavior

Add focused contract tests for nested pieces where they reduce reasoning scope.

Retain parent-level/integration/boundary tests so the collection is still proved as one LEGO.

### 7. Stop when the reasoning boundary is healthy

Do not continue splitting after the local pieces are coherent merely because further extraction is possible.

## Target program

### #245 — Persistent Environments — highest priority

Parent remains the environment lifecycle authority.

Initial seam hypotheses:

- catalog/persistence;
- mutation guard;
- provisioning;
- ordinary lifecycle transitions;
- generation-changing operations;
- retirement/removal;
- pending-effect reconciliation.

This is the strongest current candidate because one piece owns several durable effect/recovery state machines.

### #246 — Guest Bridge Agent — highest priority

Parent remains one guest bridge protocol endpoint.

Initial seam hypotheses:

- frame/protocol normalization;
- logical-location containment;
- operation ledger;
- execute claim/fencing;
- child-process lifecycle;
- observation/cancellation;
- transfer channel;
- thin dispatch/exchange entry.

Coordinate semantic defects such as the Windows fencing flake with their defect issue rather than hiding them in restructuring.

### #247 — Run Coordinator — high priority

`RunCoordinator` remains the one authoritative run coordinator.

Initial seam hypotheses:

- state/projection mechanics;
- retry/backoff;
- candidate rejection recovery;
- baseline/reverification handling;
- trusted feedback continuation;
- deterministic bounded replay;
- finalization/publication.

Nested children may assist transitions, but they do not become competing stage authorities.

### #248 — Repository Execution — high priority

Parent remains the repository-execution composition surface.

Initial seam hypotheses:

- route value/loading/selection;
- access resolution;
- exclusive execution session;
- transfer adapters;
- resource staging;
- operation descriptor/materialization;
- workspace source/candidate transfer;
- execution composition.

Keep VM-only fail-closed execution and provider neutrality unchanged.

### #249 — Git Workspace Manager — high priority

`GitWorkspaceManager` remains the managed Git/workspace authority.

Initial seam hypotheses:

- repository admission;
- baseline authority;
- worktree lifecycle;
- workspace observation;
- candidate validation;
- sealing;
- baseline reconciliation;
- publication transaction.

Do not expose extracted raw-Git mechanics broadly to higher layers.

### #250 — Provider-local internals — medium/high priority

Targets include Hyper-V image construction and Hyper-V/libvirt persistent-environment cores.

Each provider remains an independent parent adapter. Let provider-specific structure differ when the underlying platforms differ.

Do not create a branch-heavy `hyperv-or-libvirt` helper merely to make the nested shapes symmetrical.

### #251 — Chat Handoff — medium priority

Parent remains the chat-handoff protocol/domain.

Initial seam hypotheses:

- handoff value/schema;
- canonical digest identity;
- durable handoff record;
- current/previous pointer;
- retention;
- store transaction/facade.

### #252 — Setup Authority — medium priority

Setup Authority remains the accepted-authority owner.

Initial seam hypotheses:

- authority value primitives;
- snapshot;
- blocker/evaluation logic;
- accepted/working durable record;
- import/export template;
- transaction manager.

Templates and evaluators cannot independently accept authority.

### #253 — Installer / Stage 0 — lower priority, coordinate with #238

Installer and Stage 0 remain security-sensitive parent entry/authority LEGOs.

Expected seams include selector/exact-subject identity, source acquisition, integrity verification, install transaction/publication, setup continuation, activation state, and migration reconciliation.

This restructuring must not displace the active zero-state bootstrap gate. New #238 work should avoid making the monolithic surfaces worse when a natural nested boundary is already clear.

### #254 — Physical canary composition — secondary/light treatment

The physical canary is legitimately a concrete composition root, so topology wiring is allowed to remain there.

Extract only substantial local mechanics with their own invariants, such as preparation evidence verification, run guarding, and completed-state cleanup. Do not wrap simple composition merely to reduce file size.

## Scheduling

This program is not a big-bang prerequisite chain.

Current functional/recovery gates remain meaningful. In particular:

- #238 remains ahead of installer/Stage-0 cleanup;
- no structural issue authorizes a live-host installer or physical construction run;
- a target may be restructured before significant new work inside that same parent when doing so materially reduces agent-attention risk;
- otherwise the restructuring issues can be completed as bounded architecture-maintenance work without blocking unrelated domains.

Prefer completing one parent LEGO coherently rather than opening broad simultaneous moves across several parents.

## Definition of done for one parent

A parent restructuring issue is complete when:

- the parent identity/authority/public studs remain clear;
- internally distinct responsibilities have bounded nested homes where justified;
- nested studs use local neutral vocabulary;
- siblings do not encode one another's identities/topology;
- durable protocols/state/recovery semantics remain compatible unless separately changed;
- focused nested contract tests exist where useful;
- parent/integration tests still prove the whole LEGO;
- agents no longer need most of the parent implementation in active attention for a typical bounded child task;
- further splitting would be ceremony rather than a meaningful reduction in reasoning complexity.

## Non-goals

This program does **not** establish:

- a maximum file length;
- a maximum directory size;
- a required number of nested pieces;
- a universal folder template;
- one class per file;
- mandatory interface wrappers around simple internal calls;
- a shared provider implementation for abstraction symmetry;
- new public services for every nested child;
- behavior changes disguised as refactoring.

A 100 KB parent LEGO composed from well-bounded nested LEGOs can be healthier than a 10 KB indivisible piece with several unrelated authorities.

The objective is **smaller reasoning surfaces inside intact ownership boundaries**.