# DB-HO101 — Receipt generation CAS before production producers

Date: 2026-08-30

Parent work: Stage 8 #116 and application removal #391.

Coordinates with: #159, #391, DB-003, DB-009, DB-011, DB-020, DB-HO095, DB-HO098, DB-HO099, and DB-HO100.

## Scope and safety boundary

This checkpoint owns the missing conditional-generation operation on the accepted neutral exact-artifact receipt journal. It may change that journal, its isolated tests, preflight registration, and documentation.

It does not wire a live installation producer, inspect or mutate the canonical installation, adopt an existing artifact, change the installer public contract, expose uninstall CLI, retire a receipt, remove an artifact, run setup/elevation, refresh protected services, mutate a provider/image/environment/VM/guest, execute repository code, invoke a model, or implement GPU/CUDA work.

## Assessment

DB-HO100 accepted an append-only immutable receipt journal with exact canonical revision bytes, an epoch, strict revision and previous-digest chaining, a generation identity, separate caller-owned scratch, create-if-absent publication, exact reread, and corrupt/aliased history rejection. Its `accept(items)` operation is intentionally a convergent setter: if another writer publishes the next revision first, it rereads and keeps trying to make the requested complete item list current.

That behavior is safe for one owner supplying the entire list. It is not a safe production merge stud. Two independent producers can both read generation A, derive A+their-own-item, and call `accept`. Both calls can succeed in sequence, leaving the later complete list without the earlier producer's item. Every journal revision is valid, yet application ownership evidence is lost.

The current Permanent Entry installation lock serializes only Permanent Entry installation mutation. Later accepted-runtime, service, PATH/configuration, and lifecycle producers retain their own ownership and activity boundaries. Stretching one installer-specific lock across those owners would leak topology and would still not protect future independent processes that write the same receipt journal.

The exact production surface also remains more complicated than one component directory:

- content-addressed component directories may be created or exactly adopted and older verified generations are intentionally retained;
- wrapper files are a sparse owned subset of a shared `bin` directory, which the existing exact-artifact set can represent with `exclusive: false` and `removeRoot: false` once fixed file membership/digests are supplied;
- staging names must be reserved before creation if crash residue is to have durable ownership evidence;
- quarantine moves preserve corrupt or otherwise untrusted evidence and cannot be promoted into removable exact-tree authority merely from a generated name;
- the installer mutation lease must project activity without becoming uninstall policy;
- receipt files cannot recursively authorize their own deletion, and removal-operation rotation cannot reuse a pre-removal generation after a fresh reinstall.

Changing the synchronous installer surface to async merely to call the accepted journal would not solve any of those ownership questions. The first missing dependency is a truthful compare-and-accept operation.

## Primary-source research

- Node.js documents that promise filesystem operations use the thread pool and are not synchronized or threadsafe; callers must explicitly order operations. Node also exposes both synchronous and promise APIs, so changing an established public function to async is an interface decision, not a durability requirement. The journal must supply its own coordination contract rather than assuming event-loop ordering: https://nodejs.org/api/fs.html
- Node.js documents that `writeFile`/`writeFileSync` with `flush: true` flushes the underlying descriptor after successful writes, while `rename` is a distinct operation. The accepted journal's write/sync, create-if-absent publication, and exact reread remain necessary; conditional generation must not be inferred from a successful write alone: https://nodejs.org/api/fs.html
- Linux `rename(2)` documents atomic name replacement but also calls out ambiguous retry behavior for networked filesystems. A name operation is not a cross-process expected-value comparison, so the journal continues to use a create-if-absent numbered revision and observation rather than replacing a current file blindly: https://man7.org/linux/man-pages/man2/rename.2.html
- Linux `fsync(2)` states that flushing a file does not necessarily flush the directory entry and that an explicit directory-descriptor flush is needed for that metadata guarantee. DevBridge therefore continues to report the narrower evidence it actually implements: flushed record bytes, immutable publication, and exact reread, not universal power-loss durability on every filesystem: https://man7.org/linux/man-pages/man2/fsync.2.html
- Microsoft documents `MOVEFILE_REPLACE_EXISTING` and `MOVEFILE_WRITE_THROUGH` as separate behavior, with write-through specifically described for copy/delete moves. Node's generic rename API does not expose that as an expected-value CAS. Windows correctness therefore remains based on create-if-absent publication, exact link/file identity checks, and reread rather than an unsupported atomic-replace claim: https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexa

## Reassessment and ownership boundary

The receipt journal remains one self-contained local record component. It must not learn installer, wrapper, component, service, setup, provider, repository, VM, path-role, application-removal, or uninstall identities.

Add one neutral conditional operation that accepts only:

- the exact expected current generation, where `null` means an empty journal; and
- one complete normalized item list.

It returns the exact current record and whether the requested revision was accepted. Generation mismatch or loss of the next numbered create-if-absent race is an observed conflict, not an exception and not permission to overwrite the winner. Corrupt/ambiguous history remains an exception and fails closed.

The operation performs no merge and invokes no caller callback. A later composition owner may reread, deterministically merge its local receipts into the newly observed list, and retry within its own bound. Keeping the journal free of callbacks prevents retry from repeating hidden caller side effects.

The existing unconditional `accept(items)` remains the explicit complete-list convergence operation used by a sole owner. It does not become the production multi-owner merge surface. Tests and documentation must distinguish the two contracts.

## Primitive-to-high-level plan

1. Extend the neutral journal with exact expected-generation validation and one bounded `compareAndAccept({ generation, items })` attempt.
2. Refactor publication only enough to share normalization/record creation/exact verification without duplicating journal mechanics.
3. Prove empty-journal CAS, exact-current idempotence, stale generation rejection, same-revision contention, winner preservation, corruption rejection, and restart behavior on current Node and exact Node 22.16.
4. Re-run preflight, import-isolation/architecture gates, standalone integrity, the complete serialized suite, doctor, diff hygiene, and hosted Ubuntu/Windows qualification.
5. Only after acceptance, plan and implement the production installation producer under the installer mutation activity boundary:
   - reserve exact temporary/staging locations before creation;
   - have local mutation leaves return neutral created/adopted/retained observations;
   - record exact component trees and sparse wrapper files without claiming unrelated siblings;
   - preserve unverified quarantine evidence instead of manufacturing removal authority;
   - retain older generation receipts intentionally;
   - use conditional generation merge so another producer's receipt cannot disappear.
6. Add the receipt-backed read-only contributor and exact action binding only after receipt provenance, installer activity, component verification, sparse wrapper verification, and required coverage are complete.
7. Keep the receipt/control store protected until a separately journaled terminal self-removal/rotation design can preserve recovery. Do not expose application removal or purge CLI before producer completeness is proven.

## Acceptance

- [ ] Conditional acceptance requires exact current generation or explicit empty state.
- [ ] A stale writer cannot publish a later revision that erases the observed winner.
- [ ] Same-list conditional acceptance is idempotent only when the expected generation is current.
- [ ] Corrupt, gapped, aliased, noncanonical, or otherwise ambiguous history still fails closed.
- [ ] The journal source remains import-isolated and contains no topology identities.
- [ ] No production producer, CLI, live adoption, deletion, setup/elevation, protected/provider/VM/guest, repository-code, model, or GPU/CUDA effect occurs.

