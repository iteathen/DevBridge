# Accelerator broker core

Status: transportless Phase-3 broker-core slice for issue #395. This layer consumes the already-qualified `devbridge/accelerator-broker-*-v1` protocol and defines host-local admission, durable execution intent, replay/reconciliation, cancellation intent, and semantic result verification. It does **not** select or open a VM transport, call CUDA, start a host service, or qualify a compute capability.

## Governing model

The broker core is a host-control-plane component. Guest messages are hostile data. Structural protocol validity is never treated as authority.

The core composes three injected ports:

```text
binding authority
  resolveExpectedBinding({ profile, session })

execution ledger
  load(key)
  create(key, record)
  compareAndSwap(key, expectedRevision, record)

semantic backend
  ensureExecution({ request, requestDigest })
  observeExecution({ request, requestDigest })
  ensureCancellation({ request, requestDigest, cancel, cancelDigest })
```

None of those ports accepts an executable path, command line, device identity, transport endpoint, provider object, or credential from the guest.

## Why `ensure*`, not `start` / `kill`

DB-009 requires intent -> attempt -> observe -> reconcile semantics for effects that can become ambiguous.

A process can fail after a request is durably recorded but before the caller learns whether the backend effect began. A transport can also lose the response after an effect actually starts. Therefore a raw `start()` method would create an unsafe retry boundary.

The backend port instead exposes **idempotent ensure semantics**:

- `ensureExecution` observes the exact execution identity before creating work and must not create a second effect when that exact execution already exists or remains ambiguous;
- `ensureCancellation` observes the exact execution/cancel identity before issuing cancellation and must not widen a replay into repeated provider cancellation effects;
- `observeExecution` is read-only and never creates or cancels work.

Concrete Windows/Linux CUDA adapters must prove those semantics before being attached to this core.

## Ledger record

`devbridge/accelerator-broker-ledger-record-v1` owns durable host-side effect state for one exact session/request key.

The key is:

```text
session identity
session generation
request identity
```

Each record contains:

- monotonic revision;
- normalized execute request;
- broker-computed request digest;
- latest normalized execution observation;
- zero or one exact cancellation intent.

The ledger port must implement create-if-absent plus revision compare-and-swap. This gives the core a neutral concurrency/restart primitive without choosing a file/database implementation in this slice.

The record validator proves that request digest, execution observation, cancellation target, exact binding, and execution identity all belong together. Terminal observation transitions remain governed by the protocol's immutability rules.

## New execution flow

For a new request:

1. normalize the hostile request;
2. derive its exact ledger key/digest;
3. check for an existing request/replay first;
4. resolve the expected binding from host-local authority;
5. reject unavailable/stale binding **before backend effects**;
6. durably create the request with `accepted` observation;
7. only after persistence, call backend `ensureExecution`;
8. validate returned observation identity/state/result;
9. update the ledger with compare-and-swap;
10. if the backend call throws or returns no proof, reconcile through `observeExecution`; if no exact state can be proven, persist `unknown/state-unknown`.

A lost response therefore does not trigger a blind second execution.

## Replay and conflicts

For an already-known exact session/request:

- same normalized request digest -> reconcile that record;
- different digest -> return `rejected/request-conflict` without touching the recorded effect;
- terminal record -> return immutable terminal evidence;
- nonterminal exact replay -> call the idempotent ensure port, not a raw start primitive;
- read-only `observe()` -> call only `observeExecution`, never `ensureExecution`.

This permits recovery after a crash before/after an ambiguous backend call while keeping effect creation below an idempotent boundary.

## Binding drift

The initial admission binding is not a permanent grant.

Before continuing a nonterminal ensure/cancel operation, the core re-resolves the expected binding from host-local authority and requires exact profile/environment/backend/session generations to remain current.

If the binding becomes unavailable/stale, the core does not call the stale backend. It records/returns `unknown/state-unknown` because the old effect state is no longer safely attributable through the current authority generation. It does not falsely claim success/failure and does not silently migrate the request to another backend.

Terminal evidence remains immutable and remains explicitly bound to the generation that produced it.

## Independent canary verification

A backend-provided `succeeded` observation is not trusted merely because its digest is structurally valid.

The broker core independently verifies the sealed Phase-3 semantic operation:

```text
result[i] == (left[i] + right[i]) modulo 2^32
```

It also requires the exact output length.

A backend that returns a validly encoded but incorrect result is converted to `failed/execution-failed`; no result is projected as success.

This check is intentionally tiny and deterministic. Later semantic operations require their own explicit verification contracts.

## Cancellation flow

Cancellation must also satisfy intent-before-effect:

1. locate the exact durable execution from cancel session/request identity;
2. require exact execution ID, request digest, and binding match;
3. return existing terminal evidence without another cancel effect;
4. atomically persist the single cancellation intent before calling the backend;
5. call idempotent `ensureCancellation`;
6. reconcile a thrown/lost response with read-only `observeExecution`;
7. preserve `unknown` when terminal state cannot be proven.

The first cancellation intent is immutable. A conflicting later cancellation identity cannot create another backend cancellation effect.

## CAS contention

Every observation/cancel-intent update uses a bounded compare-and-swap loop.

If another actor advances the same durable record first, the core reloads it and:

- preserves terminal evidence;
- refuses invalid/regressive transitions;
- only writes a transition still valid from the current durable observation;
- fails rather than spin indefinitely if reconciliation cannot converge.

This protects exact request identity without assuming a particular database or filesystem lock implementation.

## LEGO boundaries

`accelerator-broker-core.js` and `accelerator-broker-ledger.js` are provider/transport neutral.

They contain no:

- Hyper-V/libvirt/WSL/VSOCK/socket/SSH mechanics;
- NVIDIA/CUDA Driver API calls;
- process spawning;
- filesystem/network access;
- device identifiers;
- repository execution fallback;
- setup/doctor/routing integration.

The binding-authority, ledger-persistence, generation-lifecycle, transport, and CUDA backend implementations are separate studs.

## Next slices

The original core plan has been superseded by the post-integration #395 recovery review. The repository-side dependency order is now:

1. durable local broker ledger persistence behind the existing CAS port — completed by #400;
2. read-only exact-generation ledger catalog that can prove quiescence without widening broker-core authority — completed by #411;
3. durable generation retirement/admission gate that fences and drains new execute work, keeps observe/cancel reconciliation available, and promotes only while exact quiescence is proven — #412;
4. only after #412 qualifies, define the transport exchange stud and independent Windows/Linux provider adapters without changing the broker/core protocol or generation-lifecycle authority;
5. qualify hostile-guest framing, peer identity, bounded message sizes, disconnect/reconnect, duplicate delivery, and response loss;
6. implement native Windows and native Linux CUDA semantic backend adapters behind `ensureExecution / observeExecution / ensureCancellation`;
7. perform the first real Windows canary only after transport/security and generation-lifecycle composition are qualified;
8. perform Linux physical qualification when a physical Linux GPU host becomes available.

A stale generation must never be made unreachable merely to advance this sequence. The #412 controller remains the pre-transport promotion authority; `AcceleratorBrokerCore` is not widened with stale-backend or generation-retirement mechanics.

No local physical-host action is required for this transportless fake-backed core slice.
