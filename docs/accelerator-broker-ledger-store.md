# Accelerator broker ledger store

Status: concrete cross-platform durable persistence adapter for the Phase-3 accelerator broker core in issue #395. This slice implements only the broker core's `load / create / compareAndSwap` ledger port. It does **not** start a broker service, select a VM transport, call CUDA, modify a physical host, or qualify a compute capability.

## Governing boundaries

DB-003, DB-009, DB-019, and DB-020 remain unchanged.

The durable ledger is host control-plane state. Repository/guest input cannot choose its root path, filename, provider, device, executable, transport endpoint, or persistence mechanism. The caller supplies one existing canonical host-owned root from local configuration/composition.

The store does not create that root and does not derive a host path from guest-visible identity text.

## Storage key

The ledger core owns the normalized logical key:

```text
sessionIdentity
sessionGeneration
requestId
```

The file adapter serializes that normalized key only long enough to compute a domain-separated SHA-256 digest:

```text
sha256(
  "devbridge/accelerator-broker-file-ledger-key-v1\\0" ||
  normalized-key-json
)
```

Physical storage then uses only the digest:

```text
<host-owned-root>/
  <first-two-hex>/
    <full-64-hex-digest>/
      0000000000000001.json
      0000000000000002.json
      ...
```

Session/request identities never become path components.

The root and every owned directory/revision file are checked as non-symlink objects at the adapter boundary. Canonical-path mismatches fail closed.

## Why immutable revisions

The broker core requires exact create-if-absent and compare-and-swap semantics. Replacing one mutable JSON file would make a stale writer vulnerable to last-writer-wins overwrite and would erase useful restart/recovery history.

Instead, every broker ledger revision is immutable and published once.

A revision history is valid only when:

- revision filenames are fixed-width decimal values;
- the first revision is 1;
- revisions are contiguous with no gaps;
- every revision parses through `devbridge/accelerator-broker-ledger-record-v1`;
- each record revision matches its filename;
- every record belongs to the requested normalized ledger key;
- every adjacent pair satisfies the ledger owner's exact record-transition rules;
- an existing cancellation intent never changes or disappears.

Malformed, tampered, gapped, or inconsistent history fails closed rather than guessing the newest usable record.

## Prepared publication

A new immutable revision is prepared in the target key directory:

1. create an invocation-owned temporary file with exclusive `wx` creation;
2. write the complete normalized JSON snapshot;
3. `fsync` the file handle;
4. close it;
5. publish the exact prepared inode to the final revision name with a hard link;
6. remove only this invocation's temporary pathname.

The final revision path is never rename-replaced and never overwritten.

A hard-link publication is an atomic no-overwrite claim on the final revision pathname on the supported Windows/Unix filesystems used by DevBridge qualification. If another writer already published that exact revision, this writer observes/validates the winner and returns `false` from create/CAS rather than replacing it.

Relevant Node filesystem API reference:

- https://nodejs.org/api/fs.html

## CAS mapping

`create(key, revision1)`:

- requires exact record revision 1;
- creates/validates only digest-derived child directories beneath the trusted root;
- returns `true` only if this writer publishes revision 1;
- returns `false` if another valid revision 1 already won.

`compareAndSwap(key, expectedRevision, nextRecord)`:

- requires `nextRecord.revision == expectedRevision + 1`;
- loads and fully validates current immutable history;
- returns `false` if current revision is not the expected revision;
- verifies the ledger semantic transition;
- atomically competes to publish the exact next revision;
- returns `true` only to the winning writer.

The broker core remains unaware that the adapter uses files.

## Concurrent writers

The final revision pathname is the cross-process exclusion primitive.

Two writers may concurrently prepare temporary snapshots. Only one can create the previously absent hard-link name for a given revision. The loser cannot overwrite the winner and must reconcile from durable state.

This preserves the ledger's CAS contract without a provider lock, process-global mutex, or database-specific transaction API.

## Temporary crash residue

Temporary files are named only in the closed invocation-owned namespace:

```text
.tmp-<uuid>.json
```

Readers ignore regular files in that namespace because they are never published ledger evidence. A process removes only the temporary pathname it created itself.

It does not sweep another process's temporary file, so a crash cannot make a new process accidentally delete an active concurrent writer's prepared snapshot.

Any unexpected non-temporary/non-revision entry fails closed.

## Record size bound

The default maximum serialized revision is 512 KiB. The adapter validates both written payload size and opened persisted-file size.

This comfortably bounds the sealed Phase-3 u32 canary while preventing unbounded local persistence from a hostile message. Larger future accelerator semantics must deliberately revisit the contract rather than silently growing the host state surface.

## Why not SQLite in this slice

DevBridge currently supports Node `>=22.16.0`.

Node's built-in `node:sqlite` exists on that runtime line, but it remains an experimental API at the project minimum. A security/recovery foundation should not require an experimental runtime subsystem merely to obtain transactions when the ledger only needs append-only create/CAS semantics.

Primary runtime reference:

- https://nodejs.org/api/sqlite.html

This does not prohibit a future stable database-backed implementation of the same ledger port. The broker core intentionally depends only on the neutral `load/create/compareAndSwap` contract.

## Durability claim

This slice targets **process/service restart durability and cross-process CAS correctness**.

The prepared file contents are synced before publication. However, this branch does not claim survival across sudden power loss, storage-controller write-cache loss, filesystem corruption, or volume failure. Such claims require an explicit physical fault/power-loss qualification gate and may require directory/volume-specific durability primitives.

Do not infer stronger durability than was tested.

## Fail-closed local state

The adapter rejects:

- missing/non-directory/canonical-root violations;
- symlink revision/directory substitutions at owned boundaries;
- unknown directory entries;
- malformed revision filenames;
- gaps in immutable history;
- oversized records;
- malformed/tampered JSON;
- record/filename revision mismatch;
- record/key mismatch;
- inconsistent cross-revision transitions;
- invalid CAS revision numbers.

It does not attempt to repair suspicious state automatically.

## Cross-platform qualification

Hosted Windows and Ubuntu CI must both exercise:

- restart reload;
- concurrent create;
- concurrent CAS;
- stale CAS;
- orphan temporary files;
- malformed/tampered/gapped history;
- key-path privacy;
- record-size bounds.

Passing those tests proves repository-level adapter semantics on the CI filesystems. It is not physical GPU evidence and does not qualify the later VM transport or CUDA backend.

## LEGO boundary

`accelerator-broker-file-ledger.js` owns only host-local persistence mechanics behind the broker ledger port.

It contains no:

- Windows/Linux VM-provider logic;
- WSL/Hyper-V/libvirt/VSOCK/socket logic;
- child-process or shell execution;
- CUDA Driver API calls;
- GPU/device identities;
- repository routing;
- setup/doctor integration.

A future database or other storage adapter can replace it without changing the broker protocol/core.

## Next gate

The post-integration #395 review found that transport must **not** follow this persistence slice directly. Before any concrete broker transport/backend can qualify, generation retirement must remain recoverable under DB-009:

1. #411 adds a read-only exact-generation catalog over the immutable ledger so lifecycle composition can prove whether a retiring session generation has any nonterminal admitted effects;
2. #412 adds durable serialized retirement/admission gating so new execute admission is fenced before quiescence is observed and the next exact generation is promoted only after that proof.

A catalog result alone is not promotion authority because an unfenced execute could race between observation and promotion. Transport selection/qualification remains blocked until both ownership slices are repository-qualified.

No physical-host Codex action is required for this persistence or catalog work.
