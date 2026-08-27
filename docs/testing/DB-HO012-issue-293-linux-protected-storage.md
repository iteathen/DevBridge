# DB-HO012 — issue #293 Linux protected storage primitive

Status: integrated through PR #313 at squash commit `bcfae330cb223ed7705feff888bd9c9690c137e4`. All four exact-head CI jobs passed in run `33118076373`, including the Ubuntu real-filesystem canary. This isolated slice began at recovery commit `5a24dc633ae6ff1acf43b3fecefad2b6011593bf` and implements DB-HO011 plan step 3 only.

## Assessment and ownership boundary

Linux lifecycle mechanics need durable root-owned records and protected directory/file construction before they can safely create an ownership claim, refresh journal, immutable generation, or unit. Putting those operations directly inside the lifecycle adapter would duplicate containment, atomic-replacement, and recovery reasoning across every record type.

The selected owner is therefore a topology-neutral Linux protected-storage brick. It knows only normalized absolute paths, immediate parent authority, entry kind, numeric owner/group, access mode, bounded bytes, and injected filesystem ports. It contains no lifecycle, account, systemd, provider, repository, VM, or reconciler identity.

## Primary-source findings

Node 22 documents that `fsPromises.writeFile()` with `flush: true` uses `filehandle.sync()` after successful writes, and that `filehandle.sync()` requests that file data reach the storage device. Linux `rename(2)` documents that replacing an existing destination is atomic: observers do not see the destination missing. Linux `fsync(2)` separately warns that syncing a file does not necessarily persist its directory entry; the containing directory must also be synced.

The primitive consequently writes only a same-directory pending file with exclusive creation, flushes its bytes, verifies exact owner/group/mode/content, renames it over the destination, and syncs the parent directory. Directory creation and repair also sync the parent. A rename alone is not reported as durable evidence.

Primary sources:

- [Node.js 22 filesystem API](https://nodejs.org/docs/latest-v22.x/api/fs.html)
- [Linux `rename(2)`](https://man7.org/linux/man-pages/man2/rename.2.html)
- [Linux `fsync(2)`](https://man7.org/linux/man-pages/man2/fsync.2.html)

## Implemented contract

- Every target and parent is a normalized absolute Linux path; `/`, traversal normalization, NUL/newline input, and non-immediate parent claims are rejected.
- Parent evidence is a real non-symlink directory with exact numeric owner/group and either exact mode or no group/other write. Mutation never begins through a writable or indeterminate parent.
- Directory creation uses one immediate child at a time. Existing indirection or foreign ownership blocks. Ownership adoption is possible only for exact numeric IDs explicitly admitted by the caller, supporting a root-created interrupted service-owned directory without a generic `chown` repair path.
- File replacement rejects destination indirection and foreign owner/group. Exact bytes and mode are a true no-op.
- The only recoverable temporary name is the deterministic same-parent `.devbridge-pending` child. It may be removed only when it is a real file with the exact destination owner/group; foreign or linked pending state blocks.
- New pending bytes use exclusive create and `flush: true`, then exact policy/content verification, atomic rename, parent directory sync, and final byte/policy re-observation.
- Bounded reads re-observe file identity, size, and modification evidence and reject a changed read.
- No recursive deletion, recursive creation, source copy, runtime staging, ownership-record schema, service lifecycle, or provider behavior belongs to this primitive.

## Verification evidence

Local Windows-host evidence:

- protected-storage focused suite: 5 passed, 0 failed, 1 real-Linux canary skipped by platform;
- `npm run preflight`: passed (`syntaxFiles: 43`, `jsonFiles: 2`, `targetedTests: 36`);
- repository-execution architecture gates: 33 passed, 0 failed, 1 expected Windows symlink-capability skip;
- full `npm test`: 1,179 passed, 0 failed, 9 platform-capability skips; 1,188 total.

The Ubuntu CI job executed the real-filesystem canary using actual `lstat`, exclusive write with flush, ownership/mode observation, rename, directory sync, and cleanup inside a disposable owned root. Windows and Ubuntu smoke/test jobs all passed on the exact reviewed head.

DB-HO013 composes this primitive into lifecycle-owned claim and ownership/transaction persistence. Linux production setup and provider authority remain unattached and fail closed.
