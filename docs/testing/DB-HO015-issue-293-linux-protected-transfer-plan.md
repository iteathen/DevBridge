# DB-HO015 — issue #293 Linux protected transfer primitive

Status: implementation and local qualification complete from exact `cuda-target` baseline `8b3697643984a72b1b6796d0fcd130e14f60a253` on isolated branch `security/293-linux-protected-transfer`; remote Linux qualification is pending isolated publication.

## Assessment

DB-HO013 established lifecycle claim and record persistence. Immutable generation staging next requires copying the measured Node executable and measured package files into a protected staging tree. The DB-HO012 record writer intentionally buffers and caps content at 1 MiB; widening it to hold a runtime executable would mix record and bulk-transfer responsibilities and could allocate hundreds of MiB.

The missing lower dependency is a topology-neutral protected-file transfer. It must know only one bounded digest-bound input file, one policy-bound output file, its exact parent, creator identity, and injected filesystem operations. Lifecycle generations, runtimes, accounts, services, providers, repositories, VMs, and reconciliation effects remain outside it.

## Primary-source research and reassessment

Linux `open(2)` documents that `O_CREAT|O_EXCL` makes creation exclusive and does not follow a final symbolic link, while `O_NOFOLLOW` rejects a final symlink on ordinary opens. It also explicitly warns that `O_NOFOLLOW` does not protect earlier path components. The transfer therefore continues to require the caller's already-proved real, non-writable immediate parent; descriptor checks protect the final input/output entries.

Node exposes numeric open flags plus descriptor-relative `read`, `write`, `stat`, `chown`, `chmod`, and `sync`. The transfer can therefore keep both source and pending output pinned to open descriptors, compare stable before/after source evidence, stream through a bounded buffer, flush the pending descriptor, close it, re-open and hash it, then atomically rename and sync the parent directory. DB-HO012's `rename` and directory-`fsync` findings remain normative.

Primary sources:

- [Linux `open(2)`](https://man7.org/linux/man-pages/man2/open.2.html)
- [Node.js filesystem API](https://nodejs.org/docs/latest-v22.x/api/fs.html)
- [Linux `rename(2)`](https://man7.org/linux/man-pages/man2/rename.2.html)
- [Linux `fsync(2)`](https://man7.org/linux/man-pages/man2/fsync.2.html)

## Plan

1. Extend the neutral Linux protected-storage owner with one streamed transfer operation; do not widen the buffered record limit.
2. Validate normalized paths, immediate parent authority, exact digest/size, bounded maximum, output owner/group/mode, and creator identity before mutation.
3. Open source and output with no-follow flags, create only the deterministic exclusive pending name, stream/hash with partial-read/write handling, and verify stable source descriptor evidence.
4. Flush and verify exact pending bytes/policy through a new descriptor, atomically rename, sync the parent, and re-open/reverify final bytes/policy.
5. Treat an exact final file as a durable no-op, recover only an exact creator/output-owned pending file, and block linked, foreign, unsupported, colliding, or over-bound state.
6. Prove fake-port failure/recovery cases plus a real Linux filesystem canary; run preflight, architecture gates, and the full suite before isolated publication.

Generation-tree topology and lifecycle ownership updates remain a later composition. No account, service, provider, VM, or current Windows-host mutation belongs to this slice.

## Implementation

`linux-protected-storage.js` now owns one neutral streamed-transfer contract in addition to its existing small-record contract. The record boundary remains 1 MiB. The transfer boundary is separately capped at 256 MiB and allocates no more than one 64 KiB transfer buffer.

The implementation:

- accepts only normalized, distinct input/output/pending paths and closed input, output, parent, and creator contracts;
- proves the exact immediate parent before mutation and blocks linked, hard-linked, foreign-owned, over-bound, or unsupported final/pending state;
- opens the input and deterministic exclusive pending file with numeric no-follow flags;
- pins reads and writes to descriptors, handles partial operations, hashes exact input bytes, and rejects input identity or metadata drift;
- admits recovery only for a single-link pending file in the exact creator-owned `0600` or final-owner `0600`/declared-mode state;
- changes ownership and mode through the still-open pending descriptor, flushes it, closes and reopens it for exact digest/policy verification, atomically renames it, syncs the parent, and then reopens/reverifies the installed file;
- syncs the parent even for an exact no-op, so a restart can reconcile a rename that completed immediately before directory durability failed.

The implementation contains no generation, lifecycle, service, account, provider, repository, VM, or downstream consumer identity. Generation staging will consume only this local file contract.

## Local qualification

Exact Windows-host evidence before publication:

- focused storage/transfer suite: 14 tests, 12 passed, 2 Linux-only skips, 0 failed;
- execution and LEGO boundary selection: 24 tests, 22 passed, 2 Linux-only skips, 0 failed;
- repository preflight: 43 syntax files, 2 JSON files, 38 targeted test files, passed;
- full suite: 1,208 tests, 1,198 passed, 10 platform skips, 0 failed.

The new suite proves fresh transfer, exact no-op, digest-failure recovery, post-rename directory-sync recovery, source descriptor drift, partial reads and writes, path/schema bounds, hostile output/pending authority, and a real Linux filesystem canary. Hosted Linux CI must pass that canary before this slice is integrated.
