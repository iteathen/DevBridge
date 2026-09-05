# DB-HO090 — Exact construction-artifact retirement

Date: 2026-08-30

Issue: [#388](https://github.com/iteathen/DevBridge/issues/388)

Parent work: #197 and VM Stage 8 #116. Coordinates with #115, #178, #360, DB-009, DB-019, and DB-020.

GPU/CUDA work is outside this checkpoint.

## Assessment

The exact Windows protected-image construction preflight was run twice from the current accepted branch implementation with an ordinary token. Provider capability, system-managed connectivity, 4 GiB memory admission, and the fixed Windows 11 protected-boot resource shape all passed. Storage failed closed both times:

- peak writable request: `94,489,280,512` bytes;
- reserve: `23,622,320,128` bytes;
- observed free space: approximately `103,262,910,000` bytes;
- shortfall: approximately 14.85 GB.

The policy is not inflated accidentally. The Windows profile declares the Microsoft minimum 4 GiB memory, two processors, and a 64 GiB virtual disk, while construction separately budgets bounded sparse allocation and local media. Reducing those values to make one workstation pass would make the declaration untruthful.

A read-only manifest-root inventory attributes about 106 GB to the user DevBridge installation. The Ubuntu production-image construction topology contains:

- twelve immutable authority subjects and twelve outer canary journals;
- nine subject-local preparation records and nine provider-construction records;
- nine subject-local prepared installer copies and their bounded seed media;
- nine output disks;
- one shared signed-release cache object;
- one separately published and verified immutable image-library object.

The accepted published source is subject `subject-8a7a9afe109534b2c128f272ab586bcf`, whose admitted image is `img-dd12f7d5088dc62281a89a887be9dc1b`. The newer subject `subject-f7fc5e9be52e957f1b08dff05431a0b3` is retained at the pre-publication frontier and remains recovery evidence. Those identities are protected.

Seven older provider records currently re-observe as exact-name, exact-marker, exact-provider-identity, powered-off DevBridge-owned VMs. Two retained records have no provider object, as expected after the provider retention effect. This read-only observation proves that supported cleanup is feasible without first stopping an active VM; it does not authorize deletion by itself.

### Existing ownership gap

The current owners are intentionally separate:

- immutable construction authority catalog;
- canonical canary journal;
- subject preparation receipts;
- provider construction ledger;
- subject-local prepared media and access material;
- output disks/provider objects;
- shared source cache;
- admitted immutable image library.

No current parent joins those records into one exact retirement decision. The provider adapter's old `discard()` method removes the provider object and disk, deletes its own ledger entry, and then performs a best-effort recursive directory removal. It does not retire the outer authority, canary journal, preparation receipt, subject-local media, or access material and does not implement an intent/attempt/observe/reconcile journal for the complete subject. Calling it directly would therefore create a partial cleanup path and leave the authoritative topology inconsistent.

Manual deletion is not admissible. Filenames do not prove ownership, `Remove-VM` does not remove a virtual hard disk, the accepted image is a distinct protected copy, and subject-local media can remain necessary for an incomplete recoverable construction.

## Primary-source research

### Node filesystem behavior

The current [Node filesystem documentation](https://nodejs.org/api/fs.html) establishes the implementation constraints:

- promise filesystem operations are asynchronous and are not synchronized with each other, so destructive operations must be explicitly awaited and ordered;
- `lstat()` observes a symbolic link itself instead of following it;
- `Stats` exposes stable observation fields including device, inode, size, modification time, and link count;
- timestamp precision is platform-specific, so separately obtained path and open-handle observations are not guaranteed to expose identical timestamp representations;
- `rm({ recursive: true })` is deliberately recursive and has retry behavior only in recursive mode;
- `unlink()` and non-recursive directory removal provide the narrower effects needed for an enumerated plan.

Reassessment: use explicit one-file unlink and empty-directory removal ports. Do not use recursive removal as the retirement primitive. Hold/read and re-observe exact file identity immediately before each unlink because a prior path check is not atomic authority. Compare path timestamps only between the before/after `lstat()` observations made through the same API. Bind the open handle to the path through device/inode, size, regular-file shape, and single-link evidence, then hash through that held handle when a digest is authoritative. This preserves the replacement/race fence without incorrectly requiring cross-API timestamp representation equality.

### Windows links and reparse points

Microsoft documents that [more than one hard-link path can reference the same NTFS file](https://learn.microsoft.com/en-us/windows/win32/fileio/hard-links-and-junctions), while junctions are implemented as reparse points. Microsoft also documents that [reparse points can redirect ordinary file behavior](https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-points-and-file-operations) and that `FILE_ATTRIBUTE_REPARSE_POINT` is the required detection signal in native Windows interfaces.

Reassessment: a cleanup candidate must be a real regular file with exactly one link and no reparse/symbolic-link observation, below a re-observed real owned directory. Any ambiguous indirection, replacement, extra link, unexpected entry, or identity drift leaves the object untouched and blocks the subject.

### Hyper-V lifecycle and storage

Microsoft's [`Remove-VM` documentation](https://learn.microsoft.com/en-us/powershell/module/hyper-v/remove-vm) states that VM configuration is deleted but virtual hard drives are not. Hyper-V's provider operation and backing-file retirement are therefore separate effects. Microsoft also documents dynamic VHD growth as a condition that requires active free-space monitoring; a virtual size is not current allocated-byte truth.

Reassessment: the parent must first re-observe the exact provider object and remove only an unchanged, powered-off, owned subject. It must then separately re-observe and unlink the exact ledger-bound disk. The final capacity claim comes from rerunning the Windows preflight, not from summing planned byte counts.

### Windows profile requirements

Microsoft's [Windows 11 VM requirements](https://learn.microsoft.com/en-us/windows/whats-new/windows-11-requirements) require generation 2, at least 4 GiB memory, 64 GiB storage, two virtual processors, Secure Boot, and virtual TPM. The [Generation 2 security documentation](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/generation-2-virtual-machine-security-features) confirms the protected-boot topology.

Reassessment: keep the present resource policy. Reclaim exact obsolete owned state instead of weakening the target.

## Boundary reassessment

The cleanup owner is not a provider feature and not a generic filesystem utility. It is a durable local retention decision that composes several independently owned observations and effects.

The design boundary is:

`concrete construction topology -> normalized retention records -> neutral retention owner -> narrow effect ports -> concrete topology`

The neutral owner may know only opaque subject IDs, local stages, normalized references, artifact identities/bytes, plan digests, authorization subjects, and durable effect phases. It must not name Ubuntu, Windows, Hyper-V, VHDX, ISO, repositories, GitHub, setup, local directories, provider types, or sibling modules. The concrete parent alone maps current platform topology to those records.

The current accepted source, every admitted image source/backing reference, the exact current construction authority, a live mutation lease, a retained/ambiguous subject, and any incomplete subject selected for supported recovery remain protected. Only an exact superseded subject whose complete reference graph is observed and unchanged can become `obsolete`.

## Primitive-to-high-level plan

### 1. Neutral record and plan owner

Add one import-free or standard-library-only child that:

- strictly normalizes a bounded set of opaque subject/reference/artifact records;
- classifies `current`, `accepted`, `recoverable`, `retained`, `ambiguous`, and `obsolete` without knowing topology names;
- produces deterministic path-free inventory and one SHA-256 plan digest;
- rejects duplicate subjects/artifacts, contradictory stages, incomplete references, or an active mutation lease;
- binds destructive entry to exact subject plus exact current plan digest;
- persists `planned -> attempted -> observed -> reconciled` state through an injected durable journal;
- never receives a filesystem path, executable, argv, environment, provider object, or deletion callback supplied by a remote/repository source.

### 2. Exact subject inventory parent

Add one production-image retention parent that owns all topology:

- derive the currently selected immutable authority from the same setup authority owner;
- enumerate and normalize authority, journal, preparation, provider-ledger, access, subject-local media/output, active lease, and image-library references;
- derive artifact membership from durable records and fixed layout, never from a filename search;
- re-observe provider state read-only for records that claim provider effects;
- enumerate every expected subject-local file and directory, reject unexpected entries, and measure exact regular-file identity, bytes, digest where authoritative, link count, and containment;
- treat the shared release cache as a separate protected class in the first implementation.

The first complete implementation may reclaim subject-local/provider/output state without collecting the shared cache. Shared-cache collection is additive only after an independently complete reference/reacquisition proof.

### 3. Narrow destructive adapters

Repair the provider construction boundary so retirement exposes separate, reconcilable operations:

- observe exact provider state;
- remove the exact unchanged powered-off owned provider object;
- observe exact disk absence/presence independently;
- remove one exact unchanged regular output file;
- remove only explicitly enumerated subject-local files;
- remove only empty explicitly owned directories.

Delete the old recursive best-effort cleanup behavior. Do not add a second compatibility path.

### 4. Durable parent transaction

Persist the complete subject retirement intent before effects. On restart:

- recompute/rebind the current plan and protection graph;
- observe whether each intended effect is present or absent;
- continue only the next unobserved exact effect;
- never blind-retry an ambiguous provider or filesystem mutation;
- retire authority/journal/preparation/provider-ledger records only after every external artifact is observed absent;
- retain the retirement receipt as bounded evidence rather than erasing the only completion proof.

### 5. Explicit local CLI

Expose a dedicated local construction-retention command rather than making ordinary setup or doctor destructive:

- read-only inventory/plan is the default action;
- destructive action requires exact opaque subject and exact plan digest from the current observation;
- output is bounded and path-free, with class, phase, artifact count, and estimated reclaim bytes;
- no UAC, protected-service bypass, guest action, repository execution, model adapter, or GPU path is involved.

### 6. Verification order

Run cheap/high-signal checks first:

1. direct neutral-owner classification/digest/authorization/recovery tests;
2. filesystem adapter containment/link/replacement/unexpected-entry tests;
3. provider exact-ownership/absent/interrupted-effect tests;
4. parent integration and CLI read-only/mutation separation tests;
5. existing Ubuntu construction/provider/image-library regressions;
6. repository preflight, LEGO/source-isolation gates, full serialized suite, standalone artifact identity, doctor, and hosted Ubuntu/Windows matrix;
7. only then run the real read-only plan, retire selected exact obsolete subjects through the accepted product surface, and rerun the exact Windows storage preflight.

No real cleanup occurs before the implementation and its failure/recovery tests pass.

## Current decision

Proceed with issue #388 before Windows media construction. Preserve the accepted source, retained current frontier, shared cache, dirty retired fast-track checkout, protected service state, and every object that the exact plan cannot prove obsolete. No UAC or GPU/CUDA work is required for this slice.

## Implementation checkpoint

The complete retirement boundary is implemented without a compatibility path:

- `devbridge/construction-retention-v1` is a standard-library-only neutral owner. It accepts bounded opaque subjects, references, protection facts, and effects; emits one deterministic path-free plan; requires exact subject plus plan digest; and persists `planned -> attempted -> observed -> reconciled -> completed` evidence. An attempted effect is observed before at most one exact retry, while ambiguous observation fails closed.
- `devbridge/exact-artifact-set-v1` binds real-directory and regular-file identity, byte and optional digest authority, single-link shape, reparse/symbolic-link denial, exact expected membership, and explicit file/empty-directory effects. It performs no recursive removal.
- the Windows filesystem observer uses one fixed encoded PowerShell attribute query to prove `FILE_ATTRIBUTE_REPARSE_POINT` without admitting caller commands or environment;
- Hyper-V construction now separates exact powered-off owned-provider retirement, independent disk observation, and terminal construction-record retirement. The old combined provider/disk/recursive-directory `discard()` path is removed rather than retained as legacy behavior;
- the concrete production-image parent alone composes authority, journal, preparation, provider ledger/status, exact artifacts, active lease, admitted image references, and the neutral owner. Provider, configuration, output, source, access, and terminal record effects remain separately observable;
- `devbridge construction-retention` is read-only by default. Mutation accepts only `retire --subject <opaque-subject> --confirm <current-plan-digest>` and does not pass through setup, doctor, a repository task, a guest, a model adapter, or elevation.

The current setup authority is derived locally without network access. The resolver combines the persisted exact setup snapshot and the one unambiguous durable package-pin set with the current local recipe/payload/output policy. The derived current subject remains protected even before its first construction registration. Conflicting package-pin histories fail closed. This avoids incorrectly treating "not yet built from this code" as permission to select an older subject.

### Recovery-selection reassessment

The first real read-only plan safely exposed an over-retention error: treating every unfinished canonical phase as `recoverable` made every historical attempt ineligible. Durable `planned`, `running`, or `active` phase records describe where work stopped; they do not select that superseded authority for supported recovery. The documented protection rule is selection-based.

The concrete mapping now protects recovery only when exact provider observation shows a non-off provider. It independently protects the derived current subject, every admitted image reference, `retained` state, active mutation lease, finalization-attempt ambiguity, malformed/incomplete topology, and any changed artifact. Superseded early-phase subjects may become obsolete only after the exact provider and artifact plan succeeds. The neutral owner and its classification order did not change.

### Hosted portability reassessment

The first hosted implementation run, [33303340630](https://github.com/iteathen/DevBridge/actions/runs/33303340630), caught a test-fixture portability error: a reparse-point fixture forced Windows path semantics while running on Ubuntu. The fixture now selects the native host path contract. That run did not expose a production behavior failure.

The next run, [33303554286](https://github.com/iteathen/DevBridge/actions/runs/33303554286), passed Ubuntu smoke/full and Windows smoke, but its Windows full job exposed a production portability error. On hosted Windows, `lstat(path)` and `open(path).stat()` agreed on device/inode identity but reported timestamp fields at different precision. The implementation had compared the open-handle timestamp record directly with the later path record and therefore rejected an unchanged file as `artifact set file changed during observation`.

The correction keeps each observation inside its owning contract: before/after path records must match completely; path and held-handle records must match filesystem identity, byte size, regular-file shape, and single-link count; authoritative bytes are read only through the held handle. A focused precision-mismatch test proves that an unchanged object is accepted, while an independently injected before/after path timestamp change still fails closed. This is a portability correction, not a relaxation of containment, replacement, hard-link, digest, or exact-membership checks.

### Qualification and real read-only evidence

Final local qualification after the hosted portability correction passes:

- repository preflight: 2 standalone artifacts, 219 syntax files, 2 JSON files, and 178 targeted tests;
- complete serialized suite: 1,946 total, 1,925 passed, 21 expected platform skips, zero failures;
- focused normal/failure/boundary coverage includes deterministic classification, plan drift, active lease, ambiguous observation, bounded retry, durable restart, path escape, unexpected entry, replacement, hard-link, digest drift, symlink/reparse denial, partial deletion, shared-root preservation, exact Hyper-V ownership, absent-provider reconciliation, CLI mutation separation, derived-current pre-registration, and concrete provider/artifact/record ordering;
- the artifact boundary additionally covers cross-API timestamp-precision variance and fails closed on same-observation path drift;
- diff hygiene passes; only line-ending notices remain for existing Windows checkout policy.

The final real ordinary-token read-only product invocation reports no active lease and plan digest `73ffa049ac5c4eee9036d4993352b56792757de14c0a171e38832a14e91aba9e`. It protects:

- derived current subject `subject-72966b2f91318dd756cf932aba63b87a`;
- admitted source `subject-8a7a9afe109534b2c128f272ab586bcf`;
- retained frontier `subject-f7fc5e9be52e957f1b08dff05431a0b3`.

Ten superseded subjects are exact-plan eligible. Seven have external artifacts and the path-free plan estimates `67,500,791,071` reclaimable bytes; three contain terminal records only. No retirement, provider removal, file deletion, record deletion, UAC, protected-service call, VM start, guest action, repository execution, model invocation, or GPU/CUDA action has occurred.

The two earlier hosted runs are diagnostic evidence only. Corrected implementation head `4c994a80a06159fcdb6f146a8ad146cf4a76197f` then passed Ubuntu smoke/full and Windows bounded-smoke/serialized-full plus doctor in [GitHub Actions run 33304058711](https://github.com/iteathen/DevBridge/actions/runs/33304058711). The previously failing Windows serialized job passed on the exact correction.

## Live retirement and capacity result

After exact-head hosted acceptance, a new ordinary-token read-only invocation reproduced plan digest `73ffa049ac5c4eee9036d4993352b56792757de14c0a171e38832a14e91aba9e`, the same three protected subjects, ten eligible obsolete subjects, and no active lease. Each retirement was invoked separately through `devbridge construction-retention retire` with its exact current subject and current plan digest. A new read-only plan followed every completion; no digest was reused for another subject.

Seven data-bearing transactions completed all six effects at durable revision 25:

- `subject-7d53b430cc49c26753d9eb090be633f0`: `15,610,866,729` reconciled bytes;
- `subject-1a3e4a19173f0f6c75fd0758e287bcaf`: `12,993,621,033` reconciled bytes;
- `subject-fe14f9b653441f6b383bc45fe38754e5`: `12,255,423,529` reconciled bytes;
- `subject-a527ba4de198188473c3f22c7f4778af`: `11,852,770,345` reconciled bytes;
- `subject-b75a87f28715720d2e51d6547f868753`: `7,859,792,937` reconciled bytes;
- `subject-d0e6aff6b40f76e5c30da4bb7fc9588b`: `4,001,033,257` reconciled bytes; and
- `subject-99742e1c94397011d72b6c08523c09c5`: `2,927,283,241` reconciled bytes.

The exact total is `67,500,791,071` bytes. Three terminal-record-only transactions (`subject-71742489ee3651210994274965b2b408`, `subject-e4d1e03ebb5b42081f75cb84ed51f021`, and `subject-f2dea2d4d98423b96aa7949ba7fc60e8`) each completed their one effect at durable revision 5.

Final read-only plan digest `ccf36efc59e4011d9c965e84a80408596aa0737477c57fe0fb6a4d67814ef15b` reports no active lease and no eligible obsolete subject. It contains only:

- current `subject-72966b2f91318dd756cf932aba63b87a`;
- accepted `subject-8a7a9afe109534b2c128f272ab586bcf`; and
- retained recovery frontier `subject-f7fc5e9be52e957f1b08dff05431a0b3`.

Two consecutive real ordinary-token invocations of `devbridge/windows-protected-image-construction-preflight-v1` then passed provider, system-managed automatic connectivity, 4 GiB memory, and exact Windows storage admission. Both used the fixed 64 GiB disk, 40 GiB allocation, and 8 GiB source bound. They required `118,111,600,640` bytes including reserve and observed respectively `169,682,202,624` and `169,682,096,128` bytes available. Capacity is therefore proven by the owning preflight, not inferred from the retirement estimate.

The live data-bearing commands were I/O-bound and returned only a terminal JSON result after several minutes. Durable phase/effect state remained observable through their final receipts, but the local CLI did not emit bounded path-free liveness while running. Issue [#389](https://github.com/iteathen/DevBridge/issues/389) separately tracks that DB-019 operator-observability gap; do not weaken exact hashing or effect ordering to make the command appear faster.

No UAC, protected-service mutation, provider bypass, VM start, guest action, repository execution, model invocation, or GPU/CUDA action occurred. Issue #388 is complete once this exact implementation record passes the hosted matrix.
