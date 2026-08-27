# DB-HO016 — issue #293 Linux protected-tree installation

Status: implementation and local qualification complete from exact `cuda-target` baseline `f9d410f5399bb2def945179ae93dfc8c47fdacfa` on isolated branch `security/293-linux-generation-staging`; remote Linux qualification is pending isolated publication.

## Assessment

DB-HO012, DB-HO013, and DB-HO015 now provide exact protected directories, durable small records, lifecycle claim/transaction records, and descriptor-bound streamed file transfer. The next dependency is not yet account, service-manager, provider, VM, or setup composition. It is the atomic installation of one complete immutable directory tree.

The measured runtime candidate already provides a bounded package-file snapshot plus one bounded executable. The lifecycle plan already projects content-addressed working and installed roots. Embedding those identities in the tree mechanic would leak lifecycle topology into a reusable filesystem component. Conversely, placing recursive filesystem mutation in the lifecycle controller would duplicate the lower storage authority and make interruption recovery ad hoc.

## Primary-source research

Linux `rename(2)` permits a directory to move between directories on the same mounted filesystem and makes the name change atomic. Ordinary `rename` may replace an existing empty destination directory; `RENAME_NOREPLACE` exists only through `renameat2`, which Node does not expose through its documented filesystem API. Therefore the tree mechanic must prove the installed name absent immediately before rename, and both parent directories must already be root-owned/non-writable so an untrusted actor cannot race a replacement into that name. Any existing installed name is verified read-only or rejected; it is never overwritten.

The `rename(2)` `EXDEV` contract also means working and installed roots must share a mounted filesystem. The plan keeps both below one protected root; the operation still treats an `EXDEV` result as failure rather than inventing a copy fallback.

Linux pathname resolution follows symbolic links in non-final components unless a descriptor-relative/openat2 boundary prevents it. Node's documented high-level directory APIs do not expose the complete `openat2(2)` resolution controls. The mechanic therefore relies on the already-proved protected parent chain, validates every immediate directory/file entry through no-follow lower operations, and never accepts arbitrary writable ancestors.

Node documents that `readdir` returns directory names and that `withFileTypes` is optional. As in DB-HO013, directory enumeration is used only for a bounded exact-name-set check; entry type and policy always come from the injected no-follow observation operation.

Primary sources:

- [Linux `rename(2)`](https://man7.org/linux/man-pages/man2/rename.2.html)
- [Linux path resolution](https://man7.org/linux/man-pages/man7/path_resolution.7.html)
- [Node.js v22 filesystem API](https://nodejs.org/download/release/latest-v22.x/docs/api/fs.html)
- [Linux `fsync(2)`](https://man7.org/linux/man-pages/man2/fsync.2.html)

## Reassessment and selected boundary

One generic protected-tree module will own only a closed working-tree-to-installed-tree transaction. It receives:

- exact working and installed roots plus their immediate protected-parent contracts;
- one numeric owner/group and directory mode;
- normalized relative directory names;
- bounded file entries containing either exact in-memory bytes or an exact path/size/digest input;
- neutral injected observe, ensure-directory, write, transfer, verify, enumerate, rename, and directory-sync operations.

The module does not import a lifecycle plan, record store, runtime candidate, reconciler, service manager, identity manager, provider, repository, or VM component. A later lifecycle composition will project its local measured candidate into this generic contract.

## Plan

1. Add a read-only exact digest/size/policy verifier beside the streamed transfer primitive so an installed immutable file can be verified without granting replacement authority.
2. Implement strict closed-schema tree normalization with normalized relative paths, declared parents, unique paths, bounded counts/bytes, no deterministic-pending-name collisions, and distinct working/installed roots.
3. Before mutation, prove both parents, reject an ambiguous working-plus-installed state, verify an exact installed tree as a durable no-op, and reject an invalid installed collision without cleanup or overwrite.
4. For a new or interrupted working tree, enumerate its complete declared topology and reject unknown entries before resuming. Create only declared directories, then write/transfer only declared files through injected lower operations.
5. Verify the complete working tree—exact names, kinds, owner/group/modes, sizes, and digests—before rename. Re-observe the installed name as absent, rename without a copy fallback, sync both parents, and reverify the complete installed tree.
6. Make a post-rename directory-sync interruption recover as an exact no-op on retry. Leave incomplete admitted working state for exact replay; never recursively remove uncertain state.
7. Prove fresh, no-op, incomplete-resume, hostile-name/type/ownership, invalid installed collision, source drift delegation, partial transfer delegation, rename/sync interruption, strict-contract, and real Linux filesystem behavior.
8. Run preflight, LEGO/execution architecture gates, and the full suite before isolated publication. Keep issue #293 open.

This slice performs no account, service, provider, VM, repository, or current Windows-host mutation. UAC is neither requested nor required. Immutable runtime-generation projection and lifecycle record updates remain the next composition layer.

## Implementation

`linux-protected-tree.js` implements the generic transaction without importing any neighboring owner. Its closed contract normalizes two protected roots, numeric ownership, directory mode, creator identity, declared relative directories, and bounded content/transfer entries. It rejects traversal, undeclared parents, duplicate or colliding paths, deterministic pending-name collisions, managed-state inputs, overlapping roots, oversized segments/counts/entries/tree bytes, and unknown fields before invoking a port.

The transaction:

- proves both immediate parents before observing or mutating a tree;
- treats simultaneous working and installed roots as ambiguous;
- fully verifies an existing installed tree and syncs both parents as a no-op, while an invalid installed collision is read-only rejected;
- enumerates an interrupted working tree before mutation, allows only declared incomplete entries and their deterministic lower-operation pending names, and rejects unknown state;
- creates declared directories in parent-first order and delegates file bytes only to neutral bounded write/transfer ports;
- verifies the exact working name set, directory policies, and every file's size/digest/policy through a read-only verifier before publication;
- re-observes the installed name as absent, performs one directory rename with no copy fallback, syncs both parents, and reverifies the entire installed tree;
- reconciles both an ambiguous successful rename and a post-rename directory-sync interruption as exact no-ops on retry.

The streamed-storage owner now also exports a read-only exact file verifier. It grants no replacement operation and reuses the same no-follow descriptor, stable identity, single-link, owner/group/mode, size, and digest checks as final transfer verification.

No recursive deletion exists. Incomplete admitted working state is retained for exact replay; uncertain or foreign state is never cleaned automatically.

## Local qualification

Exact Windows-host evidence before publication:

- focused storage/transfer/tree suite: 23 tests, 20 passed, 3 Linux-only skips, 0 failed;
- LEGO/execution boundary selection: 33 tests, 30 passed, 3 Linux-only skips, 0 failed;
- repository preflight: 43 syntax files, 2 JSON files, 39 targeted test files, passed;
- full suite: 1,217 tests, 1,206 passed, 11 platform skips, 0 failed.

The new tree suite covers fresh installation, exact no-op, incomplete replay, undeclared state, immutable installed collision, ambiguous working/installed roots, ambiguous successful rename, parent-sync interruption, topology/schema rejection, source-module isolation, and a real Linux filesystem composition over the lower storage studs. Hosted Linux CI must pass that canary before integration.
