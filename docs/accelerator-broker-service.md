# Accelerator broker service framing

Status: repository service/wire contract for issue #418, child of #395.

This document defines the provider-neutral guest-facing service attachment around the already sealed accelerator broker protocol. It does **not** select or provision a VM transport, start a host service, call CUDA, mutate a profile VM, or qualify a physical security boundary.

## Governing contracts

DB-003, DB-009, DB-020, #398, and the generation recovery gates #411/#412 remain normative.

The service exists at a different trust boundary from the repository environment bridge. The repository bridge moves bounded command/file operations from the trusted host into an untrusted VM. This service receives hostile accelerator requests from that VM and can reach only the accelerator broker generation controller.

The repository bridge API is therefore not reused. Only the general design discipline is reused: closed schemas, strict byte bounds, one bounded exchange, fail-closed malformed input, and observation after ambiguous effects.

## Ownership

`src/runtime/accelerator-broker-service.js` owns exactly:

- a closed service envelope;
- request/response normalization;
- a bounded UTF-8 JSON frame representation;
- delegation to an injected broker port with `execute`, `observe`, and `cancel`;
- normalization of returned accelerator observations.

It owns no endpoint, provider, process, filesystem, VM lifecycle, backend, credential, or CUDA authority.

Generation retirement/promotion is deliberately absent from the guest-facing service. #412 owns that host-local lifecycle operation.

## Service envelope

The service protocol is:

`devbridge/accelerator-broker-service-v1`

A request is:

```text
{
  protocol,
  kind: execute | observe | cancel,
  body
}
```

`execute` and `observe` bodies are exact `devbridge/accelerator-broker-execute-v1` requests. `cancel` bodies are exact `devbridge/accelerator-broker-cancel-v1` requests.

No extension object or transport/provider field exists. Unknown fields and kinds fail normalization before controller invocation.

A response is:

```text
{
  protocol,
  kind,
  outcome: observation | absent,
  observation
}
```

`observation` contains one normalized `devbridge/accelerator-broker-observation-v1` value.

`absent` is permitted only for `observe` or `cancel`, and carries `observation: null`. It intentionally collapses unknown request, wrong session, and other no-exact-record outcomes exposed by the injected controller into one bounded non-authoritative result. It is not a new accelerator execution state.

`execute` may never return `absent`. A valid execute either yields a normalized #398 observation or the service exchange fails closed.

## Wire framing

The provider-neutral wire representation is one UTF-8 JSON value followed by one LF byte.

The maximum JSON payload is **128 KiB**. The terminator is outside that payload bound.

The bound is deliberate rather than copied from the repository environment bridge. The sealed #398 canary can carry two vectors of 4096 unsigned 32-bit integers plus maximum-width exact identities, which exceeds the unrelated repository bridge's 44 KiB request attachment limit. Tests construct the maximum valid v1 execute request and prove it remains within this service bound.

A decoder accepts exactly one complete frame. It rejects:

- missing termination;
- multiple frames;
- bytes after the terminating LF;
- invalid UTF-8;
- malformed JSON;
- oversized payloads;
- invalid service or #398 schemas.

The codec does not read a socket or choose when a stream is complete. Provider adapters under #419 own actual endpoint/stream mechanics and must supply one exact bounded frame to this decoder.

## Failure and DB-009 behavior

Expected accelerator outcomes such as stale binding or backend unavailability remain ordinary #398 observations produced by the broker core/controller and are returned normally.

Unexpected controller, ledger, or service failure is different. The service does not translate such a failure into `failed`, `rejected`, or any other invented terminal accelerator observation. The provider transport must close/fail the exchange conservatively. The caller then uses the existing exact request identity/digest and `observe` semantics to reconcile whether an effect began.

This preserves DB-009's observe-before-repeat rule across a future connection-loss window.

Likewise, malformed controller output is rejected rather than projected as evidence.

## Security consequences

Structural validity remains distinct from authority:

- a guest cannot gain authority by guessing valid profile/environment/backend/session identifiers;
- the broker core still resolves the expected binding from host-local authority;
- #412 still fences execution by the current exact service generation;
- the later provider endpoint must additionally be attached by trusted local composition to the admitted profile/session;
- no transport address or provider identity is accepted from the guest payload.

The service creates no direct-host repository execution path. The only host-side effect surface remains the sealed accelerator broker semantic port.

## Next ownership boundary

Issue #419 owns provider-native VM→host attachment beneath this framing:

- Windows/Hyper-V sockets;
- Linux/KVM+libvirt virtio-vsock;
- trusted endpoint identity/provisioning;
- exact profile/session attachment;
- physical hostile-guest transport qualification.

Provider provisioning and physical transport evidence remain required before any real CUDA canary is authorized.
