# PP-016 — Agent Identity, Task Leases, and Fencing

Status: active

Implementation status: initial issue #49 multi-agent slice.

## Goal

Allow multiple locally authorized PATCH-POLLER daemons to share a GitHub task queue without treating remote text, mutable labels, or a race-prone local observation as exclusive execution authority.

A task lease is coordination authority only. It does not grant task trust, repository access, executable authority, credentials, sandbox capability, human-decision authority, or publication permission. PP-002/PP-003/PP-007/PP-010 continue to govern those boundaries.

## Identity

Each installation that enables multi-agent coordination owns a persistent local Ed25519 keypair under PATCH-POLLER control state.

- The private key is local control material and is never written to a task repository, worker context, GitHub status, process environment, model prompt, or lease subject.
- The public identity fingerprint is lowercase SHA-256 over the exact DER/SPKI public-key bytes.
- The human-readable address is `<local-handle>#<64-hex-fingerprint>`.
- The handle is display/routing metadata. The fingerprint is the cryptographic identity.
- Hardware serials, MAC addresses, machine names, project-root paths, usernames, or similar host characteristics are not secret key material and are not required to derive identity.
- Key creation must be exclusive/atomic enough that concurrent local initializers cannot silently produce two accepted identities for the same state file.
- Existing identity files must be regular non-symlink control files with a validated protocol and matching public/private keypair.

A daemon session additionally owns a fresh random session ID. The persistent key identifies the installation; the session ID distinguishes concurrent/restarted processes in signed lease evidence.

## Trusted peers

Peer trust is local operator policy.

- A peer public key may be configured locally and its fingerprint is derived locally.
- A remote lease signed by an unknown/untrusted key is not executable authority and is not silently overwritten as though absent.
- Unknown, malformed, unverifiable, or cross-task lease subjects fail closed for automatic acquisition.
- An operator recovery command may eventually provide a separate explicit mechanism for handling a poisoned/unknown lease ref; automatic task execution must not invent that authority.

The local daemon always trusts its own persisted public key for self-recovery.

## Lease subject

The signed lease subject uses a bounded `patch-poller/task-lease-v1` structure that binds at least:

- queue repository;
- issue number;
- exact PP-002 task revision digest;
- owner fingerprint/address;
- daemon session ID;
- monotonically increasing fencing epoch;
- state (`active` or `released`);
- issuance time;
- expiry time for active state;
- prior lease commit SHA when one exists.

The signature is Ed25519 over a canonical JSON encoding constructed by PATCH-POLLER from validated fields. Arbitrary object key order or extra fields are not signed/accepted implicitly.

Lease content is public coordination evidence. It must not contain private keys, credentials, local filesystem paths, environment values, raw task text, or worker output.

## Authoritative remote primitive

GitHub labels/comments may mirror lease status for humans, but they are not the exclusive-claim primitive because ordinary issue metadata mutation does not provide the exact expected-value compare-and-swap contract required here.

The authoritative lease is a dedicated queue-repository Git ref under the fixed/local lease namespace. A lease transition is committed locally and pushed with Git's explicit expected-value form:

`--force-with-lease=<ref>:<expected-sha>`

For first creation the expected value is empty, meaning the ref must not already exist. For later transitions the exact previously observed lease commit SHA is supplied. If another writer advanced the ref, the update fails and PATCH-POLLER must re-observe rather than overwrite it.

PATCH-POLLER must never use an unqualified `--force`, force-with-lease without an explicit expected SHA, or a label/comment race as equivalent authority.

The queue repository and lease-ref namespace are local configuration/control-plane choices. Task text cannot redirect the lease to another repository/ref.

## Acquisition and renewal

A daemon may acquire a task revision only when one of these is true:

1. the lease ref does not exist and creation succeeds with an explicit empty expected value;
2. the current verified lease is `released` and replacement succeeds against its exact commit SHA;
3. the current verified active lease is owned by the same persistent identity, allowing local restart/reconciliation, and replacement succeeds against its exact commit SHA;
4. the current verified active lease is owned by a trusted peer and is expired beyond the configured clock-skew margin, and replacement succeeds against its exact commit SHA.

An unexpired active lease owned by another trusted peer defers the task. Deferral is normal coordination, not a task failure.

Each successful acquisition/renewal advances the fencing epoch and records the exact predecessor SHA. The currently observed lease commit SHA plus epoch are the fencing identity for the local claim.

## Heartbeat, expiry, and fencing

- Active execution renews the lease on a bounded heartbeat interval shorter than its TTL.
- Waiting-for-feedback runs do not need a continuously running timer, but each normal daemon cycle must renew ownership before resuming/polling the run; TTL must comfortably exceed the configured poll cadence.
- A crash naturally stops renewal. Another trusted peer may reclaim only after signed expiry plus the configured skew margin.
- A definite CAS loss immediately fences the old local claim.
- A transient renewal/network failure does not claim that ownership moved, but the local claim becomes unusable once its signed expiry is reached.
- Before starting a new worker/operation or crossing sealing/publication effects, the coordinator must confirm the local claim is not fenced/expired.
- Long-running child execution must be connected to a lease-loss abort signal where the runtime can terminate it. A stale process must not be allowed to continue into later PATCH-POLLER-controlled effects after lease loss.
- Even if an external child ignores or delays termination, sealing/publication must remain fenced.

This is a lease/fencing system, not a claim of perfect exactly-once computation under arbitrary partitions. The required invariant is that two compliant daemons cannot both successfully hold the same authoritative lease ref state, and a stale holder cannot continue PATCH-POLLER-authorized effects after its fence is observed/expired.

## Release and recovery

Terminal completion, cancellation, or handled failure should transition an owned lease to a signed `released` state with CAS rather than deleting the ref. Keeping a final transition avoids an ABA-style absent/ref-recreated ambiguity and preserves bounded forensic ancestry for that task revision.

If the daemon crashes before release, TTL expiry is the recovery path.

If release loses a CAS race, PATCH-POLLER must not overwrite the successor. The terminal local run remains terminal; remote lease evidence is reported as reconciled/lost rather than force-corrected.

## Candidate branch namespace

When coordination is enabled, task candidate branches include the full persistent agent fingerprint beneath the locally configured PATCH-POLLER branch prefix before the issue/revision segment.

This prevents two authorized agents working the same or adjacent tasks from publishing to the same candidate ref. The fingerprint namespace does not itself grant publication authority.

Single-agent deployments with coordination disabled retain the existing branch naming behavior for compatibility.

## Interaction with existing protocols

- PP-002 exact task provenance remains required before lease acquisition.
- PP-003 capability/sandbox rules are unchanged.
- PP-004 API budget rules still apply; lease transport uses Git ref operations rather than converting issue polling into high-frequency REST writes.
- PP-005/PP-009 durable run state remains local; a lease is not a substitute for a run journal or handoff.
- PP-007 human checkpoints remain separate; peer lease ownership cannot approve a hard gate.
- PP-008 Git publication rules remain separate from lease-ref control updates.
- PP-010 provenance remains authoritative for GitHub task/feedback/decision input. Agent signatures authenticate coordination peers only; they do not create a second remote task-command authority.
- PP-014 context rollover does not transfer the private identity key or mutate lease authority.
- PP-015 tool inventory/onboarding cannot alter peer keys or lease configuration.

## Configuration

Multi-agent coordination is disabled by default.

When enabled, local configuration provides a bounded handle, lease TTL, heartbeat interval, clock-skew margin, and optional trusted peer public keys. The queue repository is the coordination repository in v0.1. The lease ref prefix is PATCH-POLLER-owned and not task-controlled.

Configuration validation must require:

- heartbeat interval < lease TTL;
- enough TTL headroom above normal poll cadence for waiting runs;
- bounded TTL/skew values;
- bounded safe handle;
- bounded valid peer public-key encodings without duplicate fingerprints.

## Required tests

Tests must prove at minimum:

- identity generation persists one stable keypair and fingerprint across reload;
- identity file symlink/malformed/key-mismatch cases fail closed;
- private key material never appears in public identity/lease projections;
- signatures verify only against the expected trusted public key and exact canonical subject;
- unknown peer, invalid signature, wrong queue/issue/revision, invalid time window, or malformed epoch blocks automatic acquisition;
- first acquisition uses explicit empty expected-value force-with-lease;
- renewal/reclaim uses the exact observed predecessor SHA;
- simulated competing updates cause one contender to lose CAS and re-observe rather than overwrite;
- unexpired peer lease defers; expired trusted peer lease may be reclaimed after skew;
- same persistent identity can reconcile after daemon restart without waiting for TTL;
- heartbeat advances the lease and a definite lost CAS fences/aborts the local claim;
- expiry fences a local claim even when renewal failed ambiguously;
- terminal release is signed/CAS-updated rather than blind deletion;
- coordination-enabled candidate branches include the full agent fingerprint while disabled mode retains legacy names;
- lease loss prevents subsequent worker invocation, sealing, and publication effects;
- no task/model/repository field can select a peer key, lease repository, lease ref, expected SHA, or force mode.