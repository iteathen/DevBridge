# Accelerator broker generation retirement

Status: repository-side pre-transport recovery and lifecycle gate for issue #412 under #395. Depends on the read-only generation catalog qualified by #411.

This component answers one authority question:

> How can an accelerator broker session generation stop accepting new execution, drain/reconcile every already-admitted effect, and promote the next generation without making an old effect unreachable?

It does **not** select a VM transport, start a broker service, call CUDA, select a GPU, mutate a physical host, or grant stale backend authority to `AcceleratorBrokerCore`.

## Governing decision

DevBridge uses **drain before promotion**.

`AcceleratorBrokerCore` keeps its existing fail-closed rule: a nonterminal effect whose expected binding is no longer current must not cause the core to invoke a stale backend.

Generation lifecycle therefore must not make the old generation stale until its durable effect ledger proves quiescent.

The retirement controller composes four neutral ports around the unchanged broker core:

```text
broker core
  execute(request)
  observe(request)
  cancel(cancel)

generation state
  load(key)
  create(key, record)
  compareAndSwap(key, expectedRevision, record)

generation catalog
  observeGeneration({ sessionIdentity, sessionGeneration })

execute admission
  acquire({ mode: shared | exclusive })
```

## Single service owner

One authoritative accelerator broker service/controller instance owns one session identity at a time.

That service ownership is a composition requirement. It is what makes the in-memory execute admission gate the serialization point for live calls. The durable generation state is not a distributed mutex and must not be used to legitimize two independent controller processes concurrently serving the same session identity.

A later concrete broker-service composition must prove this single-owner condition before transport qualification.

## Why execute admission is in memory

High-frequency execute admission must not append durable lifecycle state for every request.

Every successful execute already has a DB-009 durable effect boundary in the broker ledger: revision 1 is published before backend `ensureExecution` is invoked. Adding a second durable per-request admission log would duplicate authority, increase contention, and make generation-state history grow on the data-plane hot path.

Instead:

- execute takes a shared in-memory admission lease before reading generation state;
- it keeps that lease through the complete `AcceleratorBrokerCore.execute()` call;
- retirement takes an exclusive admission lease;
- writer fairness prevents later execute calls from overtaking a queued retirement;
- exclusive acquisition therefore proves every execute call that entered before retirement has either published/reconciled its broker ledger intent or exited without an admitted effect.

Once that frontier is drained, the durable broker ledger and #411 catalog are authoritative for remaining effects.

## Durable generation state

Protocol:

```text
devbridge/accelerator-broker-generation-state-v1
```

One record belongs to one exact session identity and contains:

```text
revision
session identity
current session generation
phase: active | retiring
retirement intent, when retiring
last exact promotion evidence, when available
```

Retirement intent contains only:

```text
operationId
nextGeneration
```

The only legal state transitions are:

```text
active(generation N)
  -> retiring(generation N, operationId, nextGeneration N+1)

retiring(generation N, operationId, nextGeneration N+1)
  -> active(generation N+1, lastPromotion = N -> N+1)
```

Session identity is immutable. Revisions are contiguous. A promotion operation must exactly match the durable retirement intent.

`lastPromotion` is retained so a caller that lost the response after the promotion CAS can retry the same exact operation and receive replay evidence without another lifecycle effect.

## Immutable generation-state file store

`accelerator-broker-file-generation-state.js` is the current concrete persistence adapter.

It mirrors the already-qualified broker file-ledger CAS mechanics but uses a separate key domain and lifecycle-sized record bound.

Logical key:

```text
sessionIdentity
```

Physical identity:

```text
sha256(
  "devbridge/accelerator-broker-generation-state-key-v1\\0" ||
  normalized-key-json
)
```

Storage layout:

```text
<host-owned-root>/
  <first-two-hex>/
    <full-64-hex-digest>/
      0000000000000001.json
      0000000000000002.json
      ...
```

The adapter:

- requires an existing canonical absolute host-owned root;
- never uses the session identity as a path component;
- validates owned directories/revisions as non-symlink canonical objects;
- validates contiguous immutable history and every semantic state transition;
- publishes a prepared synced revision by atomic no-overwrite hard link;
- uses create-if-absent and compare-and-swap semantics;
- ignores only invocation-owned unpublished temporary-file residue;
- fails closed on malformed, gapped, substituted, oversized, or unexpected state.

Generation state changes only at lifecycle frequency, so validating immutable history on load/CAS does not impose an O(history) write/read path on each accelerator request.

## Execute flow

For an incoming execute request:

1. normalize the closed broker execute protocol;
2. require the controller-owned session identity;
3. acquire shared execute admission;
4. load/initialize exact durable generation state;
5. require `phase == active`;
6. require the request's session generation to equal the durable current generation;
7. otherwise return `rejected/binding-stale` without calling `AcceleratorBrokerCore`;
8. if current, delegate the request to `AcceleratorBrokerCore.execute()` while the shared lease remains held;
9. release shared admission after the core call completes.

Holding admission through the whole core call is intentionally conservative. If the core returns a nonterminal observation while the backend effect continues, that effect is already represented by the durable broker ledger and therefore appears in #411 quiescence evidence.

## Retirement and promotion flow

Retirement request protocol:

```text
devbridge/accelerator-broker-generation-retire-v1
```

The request carries only:

```text
operationId
sessionIdentity
retiringGeneration
nextGeneration
```

No backend handle, host path, process command, transport endpoint, provider identity, device identifier, or credential is accepted.

Flow:

1. acquire **exclusive** execute admission;
2. wait for all earlier shared execute calls to drain;
3. load/initialize durable generation state;
4. if the exact operation was already promoted, return replay evidence;
5. otherwise require exact active retiring generation or the same already-durable retiring intent;
6. CAS `active -> retiring` before consulting quiescence;
7. while exclusive admission remains held, query #411 for the exact retiring generation;
8. malformed, unavailable, ambiguous, or other-generation catalog evidence fails closed and leaves durable state `retiring`;
9. any nonterminal count returns `blocked` and leaves durable state `retiring`;
10. only exact `quiescent: true` permits CAS `retiring -> active(nextGeneration)`;
11. release exclusive admission after the promotion decision completes.

The exclusive lease remains held across **both** the quiescence proof and promotion CAS. Therefore no old-generation execute can linearize between zero nonterminal evidence and promotion.

## Observe and cancel during retirement

`observe()` and `cancel()` deliberately do **not** take the execute-admission gate.

They remain delegated to `AcceleratorBrokerCore` for the controller-owned session identity while generation state is `retiring`.

This is required recovery authority, not new execution authority:

- `observe()` uses the core's read-only backend observation path;
- `cancel()` first persists the exact immutable cancellation intent and then uses idempotent cancellation semantics;
- neither path creates a new execute request;
- retirement remains blocked until #411 reports every ledger effect terminal.

After promotion, the retiring generation is guaranteed quiescent. Terminal evidence remains immutable and can still be observed without stale backend effects.

## Crash and restart semantics

### Crash before retirement intent

Generation state remains `active`. No lifecycle transition was committed.

### Crash after `active -> retiring`

Restart loads durable `retiring`. New execute calls remain fenced even though the in-memory exclusive lease disappeared with the process. Observe/cancel reconciliation remains available. A retry of the same exact retirement operation re-observes #411 before promotion.

### Crash after quiescence observation but before promotion CAS

Durable state remains `retiring`. Restart does not reopen execute. The quiescence observation is not itself durable promotion authority; the retry re-observes the current ledger state.

### Response loss after promotion CAS

Durable state is `active(nextGeneration)` with exact `lastPromotion` evidence. Retrying the same operation returns replayed promotion without another state transition.

## Binding composition requirement

A later concrete broker-service composition must derive session-generation authority from this controller's durable current state.

While state is `retiring`, the retiring generation remains the current reconciliation generation even though **new execute** is fenced. The binding authority presented to `AcceleratorBrokerCore` therefore must not switch to `nextGeneration` before the controller's promotion CAS succeeds.

After promotion, the binding authority and controller state must agree on the exact new session generation. Any disagreement fails closed.

This is the point that prevents #399's stale-binding safeguard from accidentally stranding an effect during normal generation replacement.

## LEGO boundaries

### Neutral generation state

Owns only lifecycle state schema and legal transitions.

No filesystem, process, transport, provider, CUDA, backend, setup, or routing authority.

### Generation admission

Owns only an in-memory writer-fair shared/exclusive lease queue.

No persistence, process, transport, backend, ledger, catalog, or provider authority.

### Generation controller

Owns composition and lifecycle ordering only.

It knows closed broker request protocols and neutral ports. It does not know file paths, executables, provider types, transport addresses, CUDA calls, device IDs, or physical-host configuration.

### File generation-state adapter

Owns only host-local immutable persistence/CAS mechanics behind the neutral state port.

### Broker core

Remains unchanged. It is not taught how to retire/promote generations and is never allowed to invoke a stale backend merely to help lifecycle replacement.

## Required repository falsifiers

Repository qualification must demonstrate:

- exact state transition invariants;
- restart/reopen persistence;
- concurrent create/CAS one-winner semantics;
- stale CAS rejection;
- malformed/gapped/substituted persistence rejection;
- session identities never become path components;
- shared execute concurrency;
- exclusive retirement waits for all active shared calls;
- queued retirement is not overtaken by later execute;
- active current-generation execute delegates;
- retiring/stale-generation execute is rejected before core execution;
- nonterminal catalog evidence blocks promotion;
- observe/cancel remain available during drain;
- restart after retirement intent cannot reopen execute;
- interruption after quiescence but before promotion leaves the durable retiring fence;
- wrong/malformed quiescence evidence cannot promote;
- exact lost-response promotion retry is idempotent;
- next-generation execute is admitted only after promotion;
- conflicting retirement intent fails closed;
- LEGO source boundaries remain free of transport/backend/provider/CUDA authority.

## Qualification nonclaims

Passing repository tests proves only the neutral lifecycle/control semantics and current local file persistence behavior on CI filesystems.

It does not prove:

- a production broker service owns exactly one controller instance;
- Windows/Linux VM transport peer identity;
- hostile transport framing;
- real backend reconciliation/cancellation;
- CUDA correctness on hardware;
- display continuity;
- physical-host generation replacement;
- sudden-power-loss filesystem durability.

Those require later explicit gates.

## Next gate

Only after #412 is repository-qualified may #395 proceed to a concrete transport/service-composition slice.

That next slice must preserve this controller as the generation authority and prove the single-owner service condition, bounded hostile framing, peer identity, disconnect/reconnect, duplicate delivery, and response-loss behavior before native CUDA backend qualification or physical GPU canaries are authorized.
