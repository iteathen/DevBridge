# Accelerator broker generation catalog

Status: repository-side pre-transport recovery LEGO for issue #411 under #395.

This component exists to answer one narrow lifecycle question from durable accelerator broker evidence:

> Does this exact broker session generation have any admitted effect that is not terminal?

It does **not** execute, observe, cancel, retire, promote, or select a backend. It does not create transport authority and it is not CUDA qualification.

## Why this exists

The accelerator broker request ledger is deliberately point-addressed by:

```text
sessionIdentity
sessionGeneration
requestId
```

That is the correct execution port for `AcceleratorBrokerCore`: a request may load/create/CAS only its own exact durable record.

Generation lifecycle has a different read-only need. Before a backend/session generation can be retired, a lifecycle owner must be able to prove that the retiring generation has no remaining `accepted`, `running`, or `unknown` effects. Making the old generation stale first would cause #399 to fence it and persist `unknown/state-unknown`, which is safe for an individual stale request but insufficient as a generation-replacement policy under DB-009.

The generation catalog therefore forms a separate read-only stud over the same immutable ledger evidence.

## Neutral logical contract

`accelerator-broker-generation-catalog.js` owns only bounded logical selector/observation semantics.

Selector:

```json
{
  "sessionIdentity": "...",
  "sessionGeneration": "..."
}
```

Observation protocol:

```text
devbridge/accelerator-broker-generation-observation-v1
```

Observation fields are limited to:

- exact session identity and generation;
- exact record count for that generation;
- terminal record count;
- nonterminal record count;
- `quiescent`, which is true exactly when `nonterminalCount == 0`.

Terminal classification is delegated to the existing accelerator broker protocol owner through `isAcceleratorBrokerTerminalState()`. The catalog does not invent a second state machine.

The observation projects no request payload, request/execution ID, backend subject, environment identity, host path, filename, transport address, credential, process command, or provider-native identity.

## File-backed catalog adapter

`accelerator-broker-file-ledger-catalog.js` is the concrete read-only adapter for the current immutable file ledger.

It:

1. requires the same existing canonical host-owned root and record-size bound as the file ledger store;
2. enumerates only the closed two-hex fanout / 64-hex key-directory namespace;
3. rejects non-directory, symlink, noncanonical, or unexpected namespace entries;
4. reads only bounded revision-1 evidence to recover each logical ledger key;
5. delegates full immutable-history validation to `FileAcceleratorBrokerLedgerStore.load(key)` rather than duplicating the ledger transition/CAS state machine;
6. rejects a candidate directory when the store cannot load that derived logical key from its own digest-owned layout;
7. rejects duplicate logical keys rather than counting substituted/copy evidence twice;
8. passes the fully validated current records to the neutral logical catalog reducer and returns only the bounded generation observation.

An empty key directory or one containing only unpublished invocation temporary files is not durable effect evidence and may be ignored. Published revision gaps, malformed history, unexpected entries, or layout substitution fail closed.

## LEGO / capability boundary

The execution ledger and the generation catalog remain separate capabilities.

`AcceleratorBrokerCore` continues to receive only:

```text
load
create
compareAndSwap
```

It does not receive generation enumeration or promotion authority.

A lifecycle composition may receive only:

```text
observeGeneration(exact session generation)
```

The file catalog has filesystem read authority to its host-owned ledger root, but no write, process, network, provider, transport, CUDA, setup, VM, or repository-routing authority.

A future database-backed ledger can replace the concrete file adapter while preserving the same neutral generation observation contract.

## Critical race boundary

A quiescent catalog observation by itself is **not authorization to promote a new generation**.

Without an admission fence, this sequence is unsafe:

```text
catalog says nonterminalCount = 0
new execute is admitted to old generation
new generation becomes current
```

Issue #412 therefore owns the next LEGO: a durable serialized retirement/admission owner must first fence **new execute** admission for the retiring generation while preserving already-admitted observe/cancel reconciliation. Only while that fence is held may it consume a quiescent catalog observation and promote the next exact generation.

This catalog intentionally does not attempt to solve that race itself.

## Recovery behavior

Because the catalog derives its result entirely from immutable durable ledger records, reopening it after a process/service restart reconstructs the same logical observation when the ledger has not changed.

Suspicious persistence state never becomes a false `quiescent: true` result. The adapter fails closed and leaves generation promotion blocked for #412 to reconcile.

## Qualification scope

Repository qualification must cover:

- zero-record quiescence;
- terminal/nonterminal classification;
- exact generation filtering;
- multiple request keys;
- reopen/restart reconstruction;
- gapped/malformed history rejection;
- digest-layout substitution rejection;
- unexpected namespace rejection;
- absence of backend/transport/process/provider authority;
- absence of host/path/request/backend projection from the neutral observation.

Passing those tests proves only repository-side catalog semantics on the CI filesystems. It does not qualify a VM transport, broker service security, CUDA execution, cancellation on real hardware, backend restart, display continuity, or a physical GPU host.

## Next gate

#412 must implement and qualify durable serialized retirement admission/promotion gating. Transport work remains blocked until that gate can prove that no new old-generation execution can linearize between the quiescence observation and generation promotion.
