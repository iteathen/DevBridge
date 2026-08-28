# DB-HO067: setup-authority mutation serialization

Date: 2026-08-28

Issue: #371

Status: assessed, researched, and planned. This document authorizes no setup invocation, UAC/elevation request or bypass, protected service/provider/image/environment/VM/guest operation, repository execution, or product publication. Those operations remain deferred through at least 2026-08-31.

## Assessment

`SetupAuthorityManager` owns authority-record decisions, while `createSetupAuthorityStateStore()` owns their durable file representation. The intended durable value contains one accepted generation and at most one working generation. Operation identity and accepted `baseRevision` checks protect later transitions only if each decision observes the latest durable record.

That condition is currently false. Every manager method performs `load()` followed by a separate decision and `save()`. Each state-store instance wraps its own `JsonStateStore`, whose cache and Promise write chain are private to that object. Two instances therefore read the same predecessor and publish unrelated successors.

The defect was reproduced on commit `d3ae0db` with two independently composed managers targeting the same file. Of 50 concurrent `begin()` trials, 49 returned different working operation identities and one failed when both stores selected the same PID-and-millisecond temporary path. A per-instance queue or a lock around `save()` cannot repair this: either approach still allows both decisions to use the same stale predecessor.

The ownership boundary is:

- the transaction manager owns normalization, working-operation checks, accepted-revision checks, edits, validation, commit, discard, and returned semantic results;
- the setup-authority state adapter owns one installation-local exclusive mutation, fresh file observation while exclusive, collision-proof replacement, publication re-observation, and release;
- nested storage mechanics know only neutral target/value/transform contracts and receive no setup component, profile, provider, repository, VM, or remote identity; and
- callers retain their current component-specific interrupted-operation checks. A caller that loses a concurrent `begin()` race must re-check the returned working identity before it may continue a component-owned sequence.

The current JSON envelope (`setup:authority`) and all setup-authority v1 values remain unchanged. The generic `JsonStateStore` remains available to its other owners; this issue does not turn it into a cross-process transaction system.

## Primary-source research

- Node 22.16 documents that `node:net` supports named-pipe IPC on Windows and Unix-domain IPC elsewhere. Windows pipes are removed when their last reference closes and when the owning process exits. Linux abstract sockets, selected with a leading null byte, are not filesystem entries and disappear when all open references close. This supports a short-lived OS-owned lease without stale lock-file deletion or age guessing: <https://nodejs.org/download/release/v22.16.0/docs/api/net.html#ipc-support>
- The same `net.Server.listen()` documentation identifies `EADDRINUSE` when another server already owns the requested path and shows bounded delayed retry as the handling model: <https://nodejs.org/download/release/v22.16.0/docs/api/net.html#serverlisten>
- Node 22.16 explicitly warns that promise-based filesystem operations are not synchronized or thread-safe and concurrent modifications can corrupt data. This confirms that independent `JsonStateStore` instances cannot provide the required serialization: <https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#promises-api>
- `FileHandle.sync()` requests that file data be flushed to the storage device; the implementation remains OS/device-specific: <https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#filehandlesync>
- `fsPromises.rename()` replaces one pathname with another, while `fsPromises.realpath()` resolves the actual local path. These are the required publication and canonical local-identity primitives, but the adapter must still re-observe exact JSON after an attempted rename instead of declaring an ambiguous effect successful: <https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#fspromisesrenameoldpath-newpath> and <https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#fspromisesrealpathpath-options>
- `crypto.randomUUID()` produces a cryptographically generated version-4 UUID, removing the current PID/millisecond temporary-name collision: <https://nodejs.org/download/release/v22.16.0/docs/api/crypto.html#cryptorandomuuidoptions>

## Reassessment

A persistent exclusive-create lock file is rejected. The repository's existing guard files are appropriate only where an owner can prove/reconcile their lifecycle; blindly deleting an apparently stale setup lock would violate DB-009, while never deleting it would strand setup after a crash.

An append-only compare-and-swap journal is also unnecessary at this layer. It would add retained history, compaction, and recovery contracts to a state value whose accepted/working generations already provide the required interrupted-operation evidence.

The smallest complete design is a short-lived, OS-owned IPC lease keyed by a SHA-256 digest of the canonical local target identity:

- Windows uses a named pipe under the flat `\\.\pipe\` namespace;
- Linux uses an abstract Unix-domain socket;
- a competing bind receives `EADDRINUSE` and retries only within a fixed short bound;
- connections carry no protocol and are immediately closed; the endpoint grants no authority and exposes no path;
- process exit releases the OS object, so recovery requires no stale-lock inference; and
- unsupported host platforms fail explicitly rather than silently using a weaker mechanism.

While holding the lease, the adapter freshly reads the JSON envelope, invokes one locally supplied neutral transform, publishes through an exclusive UUID temporary file, syncs it, renames it into place, and re-reads the exact envelope. A failed/ambiguous rename is reconciled against the expected value before returning. Temporary cleanup targets only the exact UUID path created by that attempt.

## Implementation plan

1. Add two import-isolated children beneath the setup-authority state adapter:
   - a neutral OS-owned exclusive-mutation mechanism that canonicalizes and hashes its target identity, bounds contention, rejects unsupported platforms, and releases after success or failure;
   - a neutral JSON-record file mechanism that always reads fresh, publishes through `open(..., 'wx')` plus UUID, syncs, replaces, re-observes, and cleans only its own temporary path.
2. Make `createSetupAuthorityStateStore()` the sole composition edge. Its public port becomes `load()` plus `mutate(transform)`. `mutate` supplies the current cloned authority value to a local transform and requires an explicit frozen-style outcome of either no write plus result or next value plus result. It preserves unrelated envelope keys.
3. Change the transaction manager to require that port and express every state-changing method as one synchronous authority transform inside the exclusive mutation. Delete the separate `#working`/`#saveEdit` load-save path and do not accept legacy `save()` ports.
4. Re-check a resumed `begin()` result in profile-selection, image-distribution-policy, and Windows-activation-policy callers before allowing their component-specific continuation. This closes the observation-to-begin race without teaching the neutral transaction manager external component identities.
5. Update memory ports to the one current contract. Add direct boundary tests for same-process independent managers, same-operation edit/validation/commit interleavings, exact working-owner preservation, publication cleanup/readback, contention timeout, and release after thrown transforms.
6. Add a child-process fixture and cross-process test that races independent managers against the exact adapter and proves one created working generation plus one resume of the same identity. Add a crash-owner fixture that exits while holding the IPC endpoint and prove the next process can mutate without stale cleanup. Run these on hosted Windows and Ubuntu.
7. Retain all profile/template/distribution/activation/restart tests; run repeated concurrency tests, repository preflight, the complete suite, topology checks, and `git diff --check` locally. Commit/push the exact implementation, require hosted Windows/Ubuntu qualification, then document evidence and close #371 only if every acceptance condition passes.

## Acceptance boundary

No test may invoke setup, protected access, service/provider/image/environment/VM/guest changes, repository-controlled execution, or elevation. A green mock-only result is insufficient for cross-process serialization; the exact filesystem adapter and real OS IPC implementation must run on both hosted Windows and Ubuntu.
