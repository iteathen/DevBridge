# Accelerator broker protocol

Status: Phase-3 protocol contract for issue #395. This document defines the narrow provider-neutral message/evidence semantics that a later VM-to-host accelerator broker must implement. It does **not** select a transport, start a host broker, expose CUDA to a repository VM, or qualify an accelerator capability.

This slice is stacked on the read-only backend inventory. The physical Windows host has established a native Windows CUDA driver substrate as a `candidate`; the WSL candidate is independently blocked. The Linux native adapter is repository-qualified but physical Linux GPU-host evidence is currently unavailable. Those facts do not change DB-020 and do not authorize direct-host repository execution.

## Governing contracts

DB-003, DB-009, DB-019, and DB-020 remain normative.

In particular:

- repository-controlled CPU/control execution remains inside an admitted execution-profile VM;
- a compromised guest administrator/root is expected hostile input;
- the host owns provider authority, credentials, durable effect state, authoritative Git, and capability policy;
- repository/guest input cannot grant host executable, filesystem, device, provider-management, service, or transport authority;
- ambiguous effects are observed/reconciled before repeat;
- verification binds exact identity/generation inputs actually used;
- accelerator failure never authorizes a direct-host repository-execution fallback.

Issue #395 additionally requires normal CUDA execution to preserve host-retained physical accelerator ownership.

## Why this is a separate LEGO stud

The existing repository VM bridge and the accelerator broker have different trust and effect semantics.

The repository bridge moves bounded repository execution frames into a VM whose whole contents are untrusted. The accelerator broker receives hostile requests **from** that VM and mediates one narrow host-retained compute capability. Reusing the repository bridge as the accelerator API would couple unrelated ownership and risks turning a file/command bridge into host execution authority.

The common pattern is the stud shape, not the implementation:

```text
untrusted guest request
    -> neutral bounded accelerator protocol
    -> host-local admission/effect ledger
    -> replaceable transport adapter
    -> replaceable accelerator backend adapter
```

Transport/backend identities stop below the neutral protocol.

## Protocol family

The first slice defines:

- `devbridge/accelerator-broker-execute-v1`
- `devbridge/accelerator-broker-cancel-v1`
- `devbridge/accelerator-broker-observation-v1`
- `devbridge/accelerator-broker-binding-match-v1`

These are Phase-3 canary contracts, not a general CUDA remoting API.

## Sealed first operation

V1 admits exactly one operation:

`cuda.canary.u32-add-v1`

Input is two equal-length vectors of unsigned 32-bit integers, each containing 1 through 4096 elements.

The semantic result is one vector of the same length where:

```text
result[i] = (left[i] + right[i]) modulo 2^32
```

A later real backend must satisfy this operation through actual CUDA allocation, transfer, kernel execution, synchronization, and result transfer before #395 may use it as execution evidence.

The protocol deliberately accepts no arbitrary kernel text, module image, executable, argument vector, host file, device identity, provider object, or backend command. Expanding semantic coverage requires an explicit later protocol/operation change backed by qualification evidence.

## Exact binding

Every execute request carries an exact neutral binding:

```text
profile

environment:
  identity
  generation

backend:
  subject
  generation

session:
  identity
  generation
```

The values are identifiers/evidence, not authority grants.

The host control plane supplies the expected binding from already-authorized local state. The broker compares the guest-carried binding against that exact expected binding before beginning an effect. A guest cannot authorize itself by inventing a syntactically valid profile, backend, environment, or session value.

The match helper reports only closed mismatch dimensions:

- profile;
- environment identity/generation;
- backend subject/generation;
- session identity/generation.

A stale mismatch is rejected before execution with the closed neutral `binding-stale` reason.

## Execute identity and digest

An execute request carries:

- `requestId` — logical request identity within the exact session;
- `executionId` — exact attempted execution identity;
- exact binding;
- `api = cuda`;
- `topology = host-retained`;
- the sealed operation;
- bounded input.

The protocol computes a domain-separated SHA-256 digest over the normalized request.

The digest binds the payload and every exact generation carried by the request. Changing the backend generation, environment generation, session generation, execution identity, or input changes the digest.

`requestId` and `executionId` are correlation identities only. They do not grant an effect.

## Replay and DB-009

Within the same exact session, `requestId` is an idempotency/reconciliation key.

For a request identity already known to the broker:

- same normalized request digest -> exact replay; return/reconcile the existing execution rather than start a second effect;
- different digest -> `request-conflict`; do not start another effect;
- after an ambiguous transport/backend outcome -> observe durable broker/backend state before deciding whether the effect started;
- `unknown` execution state does **not** authorize blind repeat.

The protocol provides deterministic replay classification. The later broker implementation owns the durable effect ledger and DB-009 observe/reconcile loop.

## Execution observations

Execution state is closed:

- `rejected`
- `accepted`
- `running`
- `succeeded`
- `failed`
- `cancelled`
- `unknown`

`rejected` means no accelerator effect was admitted.

`unknown` means the broker cannot currently prove the effect state. It is an explicit recovery state, not failure and not permission to retry.

Closed reasons are state-bound:

### Rejected

- `binding-stale`
- `backend-unavailable`
- `operation-unavailable`
- `request-conflict`

### Failed

- `execution-failed`
- `execution-timeout`
- `backend-lost`

### Cancelled

- `execution-cancelled`

### Unknown

- `state-unknown`

`accepted`, `running`, and `succeeded` carry no reason.

Provider/driver-native error strings stay below the adapter. They may be recorded in appropriately protected local diagnostics, but they do not widen the neutral response vocabulary.

## Terminal-state immutability

`succeeded`, `failed`, `cancelled`, and `rejected` are terminal.

Once exact terminal evidence exists, later observations for that same execution must be identical. A terminal result cannot silently become another terminal result or return to a non-terminal state.

Non-terminal/ambiguous progression allows:

```text
accepted -> running | terminal | unknown
running  -> terminal | unknown
unknown  -> accepted | running | terminal | unknown
```

This permits restart/recovery reconciliation without permitting terminal-history rewrite.

## Result evidence

Only `succeeded` may contain a result.

The result is the bounded unsigned-32-bit output vector. Its domain-separated SHA-256 digest is broker-computed and validated by the protocol object.

The observation also carries the exact request digest and complete neutral binding. This makes a successful result evidence for one exact request/backend/environment/session generation rather than an unscoped claim that “CUDA worked.”

The later Phase-3 canary must independently verify the vector result against the requested semantic operation before it can contribute qualification evidence.

No partial result is projected for failed/cancelled/unknown executions in V1.

## Cancellation

Cancellation is a separate bounded message containing:

- `cancelId`;
- exact `requestId` and `executionId`;
- exact request digest;
- exact binding.

It carries no signal name, process identifier, provider operation, or arbitrary reason.

Cancellation is a request, not proof that work stopped. The broker must observe a terminal `cancelled`, `failed`, or `succeeded` execution state (or retain `unknown`) according to what the backend can actually prove.

Duplicate cancellation uses its exact identity/digest as an idempotent effect rather than widening into repeated provider operations.

## Authority boundary

Protocol normalization answers only “is this message structurally valid?”

It does **not** answer:

- whether this guest/session is authorized;
- whether the profile/environment is currently admitted;
- whether the backend generation is still current;
- whether any transport peer is trusted;
- whether resource policy admits the work;
- whether a compute capability is qualified.

Those decisions come from host-local state and exact binding checks.

A message that guesses every identifier correctly still gains no authority unless it arrived through an admitted local broker session whose host-side policy matches the exact binding.

## Transport independence

This branch selects no VM-to-host transport.

A later transport slice may evaluate provider-appropriate mechanisms for the first-class host families, but every adapter must deliver the same normalized execute/cancel/observation semantics and must not leak transport addresses or provider identities into the request schema.

Likewise, the backend adapter may differ by host family while the protocol remains unchanged.

## Phase-3 implementation sequence

After this protocol slice is repository-qualified:

1. implement a host-local broker core around an injected effect ledger/backend port, without a network/provider transport;
2. prove exact admission, replay, cancellation, stale-generation rejection, restart/reconciliation, and terminal immutability with a deterministic fake backend;
3. add replaceable Windows and Linux transport adapters beneath the same broker port;
4. qualify hostile-guest framing/input limits independently on both provider families;
5. add native Windows and native Linux CUDA backend adapters beneath the same semantic execution port;
6. on the physically available Windows host, run the first real canary and prove the display GPU remains host-owned/usable;
7. run the matching Linux physical canary only when a real Linux GPU host becomes available;
8. promote to a qualified `devbridge/compute-capability-v1` only after the required physical execution/security evidence exists.

Linux physical qualification being unavailable does not permit Linux to be removed from the contract or treated as a fallback port.

## Explicit non-goals of this branch

- starting a host broker process;
- opening/listening on a transport;
- selecting a Windows or Linux transport technology;
- calling the CUDA Driver API;
- allocating accelerator memory;
- launching a real kernel;
- accepting arbitrary CUDA modules/kernels;
- setup/installer integration;
- `doctor` integration;
- repository routing;
- capability qualification;
- direct-host repository-controlled execution;
- WSL installation;
- GPU detach, assignment, partitioning, reset, or driver mutation.

The branch freezes only the bounded protocol/evidence/recovery stud needed by those later layers.
