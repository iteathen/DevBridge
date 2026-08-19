# DB-016 — Agent Identity, Task Leases, and Fencing

Status: active

Implementation status: implemented first multi-agent coordination boundary. Current main provides persistent Ed25519 installation identity, signed exact-task leases, expected-SHA Git-ref CAS, heartbeat/TTL recovery, lease-loss fencing, same-identity daemon-lock-qualified recovery, and coordination-enabled task-branch namespacing.

## Goal

Allow multiple locally authorized DevBridge daemons to share a GitHub task queue without treating remote text, mutable labels, or race-prone local observation as exclusive execution authority.

A task lease is **coordination authority only**. It does not grant task trust, repository access, executable authority, credentials, sandbox capability, human-decision authority, human-to-workstation dispatch authority, or publication permission. DB-002/DB-003/DB-007/DB-010 continue to govern those boundaries.

## Identity

Each installation that enables multi-agent coordination owns a persistent local Ed25519 keypair under DevBridge control state.

- The private key is local control material and is never written to a task repository, worker context, GitHub status, process environment, model prompt, or lease subject.
- The public identity fingerprint is lowercase SHA-256 over the exact DER/SPKI public-key bytes.
- The human-readable address is `<local-handle>#<64-hex-fingerprint>`.
- The handle is display/routing metadata. The fingerprint is cryptographic installation identity.
- Hardware serials, MAC addresses, machine names, project-root paths, usernames, or similar host characteristics are not secret key material and are not required to derive identity.
- Key creation must be exclusive/atomic enough that concurrent local initializers cannot silently produce two accepted identities for the same state file.
- Existing identity files must be regular non-symlink control files with a validated protocol and matching public/private keypair.

A daemon session additionally owns a fresh random session ID. The persistent key identifies the installation; session ID distinguishes concurrent/restarted processes in signed lease evidence.

## Identity is not task addressing

The existence of an installation identity does not imply that current `devbridge/task-v1` tasks are addressed to that identity.

Current task intake remains DB-002 GitHub authority:

- each runner locally configures its queue and trusted numeric task actors;
- the current task envelope has no destination-agent fingerprint/address field;
- DB-016 lease ownership determines which already-authorized compliant daemon owns the task revision, not whether the human author was permitted to dispatch to a specific workstation.

Therefore, when multiple workstations observe one queue and trust the same task actor, any eligible installation may claim that trusted task according to this lease protocol.

If a deployment requires developer A to be unable to cause work to run on developer B's workstation, B's runner MUST currently enforce that with local queue/`trustedActorIds` policy. A trusted peer key MUST NOT be interpreted as permission for that peer's human/operator to submit tasks to the workstation.

A future per-installation task-addressing/dispatch mechanism may use the public identity as routing evidence, but it MUST:

- preserve DB-002 exact issue-body/edit provenance;
- require local operator authorization of which human/task sources may address the installation;
- not let repository/task text add trusted destinations/peers;
- not turn an agent signature into arbitrary executable/capability authority;
- fail closed on ambiguous/mismatched destination identity.

## Trusted peers

Peer trust is local operator policy.

- A peer public key may be configured locally and its fingerprint is derived locally.
- Peer trust authorizes verification/coordination of that installation's lease evidence only.
- A remote lease signed by an unknown/untrusted key is not executable authority and is not silently overwritten as though absent.
- Unknown, malformed, unverifiable, or cross-task lease subjects fail closed for automatic acquisition.
- An operator recovery command may provide a separate explicit mechanism for handling poisoned/unknown lease refs in the future; automatic task execution must not invent that authority.

The local daemon always trusts its own persisted public key for self-recovery.

## Lease subject

The signed lease subject uses a bounded `devbridge/task-lease-v1` structure that binds at least:

- queue repository;
- issue number;
- exact DB-002 task revision digest;
- owner fingerprint/address;
- daemon session ID;
- monotonically increasing fencing epoch;
- state (`active` or `released`);
- issuance time;
- expiry time for active state;
- prior lease commit SHA when one exists.

The signature is Ed25519 over canonical JSON constructed by DevBridge from validated fields. Arbitrary object key order or extra fields are not signed/accepted implicitly.

Lease content is public coordination evidence. It must not contain private keys, credentials, local filesystem paths, environment values, raw task text, or worker output.

## Authoritative remote primitive

GitHub labels/comments may mirror lease status for humans, but they are not the exclusive-claim primitive because ordinary issue metadata mutation does not provide the exact expected-value compare-and-swap contract required here.

The authoritative lease is a dedicated queue-repository Git ref under the fixed/local lease namespace. A lease transition is committed locally and pushed with Git's explicit expected-value form:

`--force-with-lease=<ref>:<expected-sha>`

For first creation the expected value is empty, meaning the ref must not already exist. For later transitions the exact previously observed lease commit SHA is supplied. If another writer advanced the ref, the update fails and DevBridge must re-observe rather than overwrite it.

DevBridge must never use unqualified `--force`, force-with-lease without an explicit expected SHA, or a label/comment race as equivalent authority.

The queue repository and lease-ref namespace are local configuration/control-plane choices. Task text cannot redirect the lease to another repository/ref.

## Acquisition and renewal

A daemon may acquire a task revision only when one of these is true:

1. the lease ref does not exist and creation succeeds with an explicit empty expected value;
2. the current verified lease is `released` and replacement succeeds against its exact commit SHA;
3. the current verified active lease is owned by the same persistent identity and either signed session ID is current or the caller already holds DevBridge's exclusive local daemon lock for that identity/state root, and replacement succeeds against exact commit SHA;
4. the current verified active lease is owned by a trusted peer and is expired beyond configured clock-skew margin, and replacement succeeds against exact commit SHA.

An unexpired active lease owned by another trusted peer defers the task. An unexpired active lease owned by the same persistent key but a different session also defers unless the current control path has already proved local singleton ownership with the daemon lock. A shared private key alone is never sufficient proof that the previous local process is gone. Deferral is normal coordination, not task failure.

Each successful acquisition/renewal advances fencing epoch and records exact predecessor SHA. The currently observed lease commit SHA plus epoch are the fencing identity for the local claim.

## Heartbeat, expiry, and fencing

- Active execution renews the lease on a bounded heartbeat interval shorter than its TTL.
- Waiting-for-feedback runs do not need a continuously running timer, but each normal daemon cycle must renew ownership before resuming/polling the run; TTL must comfortably exceed configured poll cadence.
- A crash naturally stops renewal. Another trusted peer may reclaim only after signed expiry plus configured skew margin.
- A definite CAS loss immediately fences the old local claim.
- A transient renewal/network failure does not claim ownership moved, but local claim becomes unusable once signed expiry is reached.
- Before starting a new worker/operation or crossing sealing/publication effects, coordinator confirms local claim is not fenced/expired.
- Long-running child execution is connected to lease-loss abort where runtime can terminate it. A stale process must not continue into later DevBridge-controlled effects after lease loss.
- Even if an external child ignores/delays termination, sealing/publication remain fenced.

This is a lease/fencing system, not a claim of perfect exactly-once computation under arbitrary partitions. Required invariant: two compliant daemons cannot both successfully hold the same authoritative lease ref state, and a stale holder cannot continue DevBridge-authorized effects after fence is observed/expired.

## DB-018 pause interaction

A daemon pause request does not freeze an active leased child/process.

DB-018 acknowledges pause only after the current bounded task cycle reaches its existing safe boundary. During the active cycle, lease heartbeat/fencing remains authoritative. A fully paused daemon performs no normal task polling/claiming, so it does not acquire new leases until resumed.

Stop has precedence over pause and follows normal lease/run recovery semantics.

## Release and recovery

Terminal completion, cancellation, or handled failure transitions an owned lease to signed `released` state with CAS rather than deleting the ref. Keeping a final transition avoids ABA-style absent/ref-recreated ambiguity and preserves bounded forensic ancestry for that task revision.

If daemon crashes before release, TTL expiry is the general recovery path. A replacement daemon using the same persistent identity may reconcile the unexpired lease immediately only after it has acquired DevBridge's exclusive local daemon lock, proving a second compliant daemon using that state root is not concurrently active. Non-exclusive one-shot execution does not receive this shortcut and respects existing session lease until expiry/release.

If release loses a CAS race, DevBridge must not overwrite successor. Terminal local run remains terminal; remote lease evidence is reported as reconciled/lost rather than force-corrected.

## Candidate branch namespace

When coordination is enabled, task candidate branches include full persistent agent fingerprint beneath the locally configured DevBridge branch prefix before issue/revision segment.

This prevents two authorized agents working same/adjacent tasks from publishing to same candidate ref. Fingerprint namespace does not itself grant publication authority.

Single-agent deployments with coordination disabled retain existing branch naming behavior for compatibility.

## Interaction with existing protocols

- DB-002 exact task provenance remains required before lease acquisition and is the authority for trusted human task authors.
- DB-003 capability/sandbox rules are unchanged.
- DB-004 API budget rules still apply; lease transport uses Git ref operations rather than converting issue polling into high-frequency REST writes.
- DB-005/DB-009 durable run state remains local; a lease is not a substitute for run journal or handoff.
- DB-007 human checkpoints remain separate; peer lease ownership cannot approve hard gate.
- DB-008 Git publication rules remain separate from lease-ref control updates.
- DB-010 provenance remains authoritative for GitHub task/feedback/decision input. Agent signatures authenticate coordination peers only; they do not create a second remote task-command authority.
- DB-014 context rollover does not transfer private identity key or mutate lease authority.
- DB-015 tool inventory/onboarding cannot alter peer keys or lease configuration.
- DB-017 preserves lease fencing while rebasing/reverifying/publishing exact candidate identity.
- DB-018 pause/resource governance does not suspend/override lease heartbeat or fencing.

## Configuration

Multi-agent coordination is disabled by default.

When enabled, local configuration provides bounded handle, lease TTL, heartbeat interval, clock-skew margin, and optional trusted peer public keys. Current implementation uses the configured queue repository as coordination repository. Lease ref prefix is DevBridge-owned and not task-controlled.

Configuration validation requires:

- heartbeat interval < lease TTL;
- enough TTL headroom above normal poll cadence for waiting runs;
- bounded TTL/skew values;
- bounded safe handle;
- bounded valid peer public-key encodings without duplicate fingerprints.

Same-identity takeover permission is not configuration and cannot be set by task/repository/model input. It is an in-process control fact supplied only by daemon path after local singleton lock has been acquired.

Task-author trust is also not derived from `trustedPeers`; it remains separate local `github.trustedActorIds` policy under DB-002.

## Required tests

Tests must prove at minimum:

- identity generation persists one stable keypair/fingerprint across reload;
- identity file symlink/malformed/key-mismatch cases fail closed;
- private key material never appears in public identity/lease projections;
- signatures verify only against expected trusted public key and exact canonical subject;
- unknown peer, invalid signature, wrong queue/issue/revision, invalid time window, or malformed epoch blocks automatic acquisition;
- first acquisition uses explicit empty expected-value force-with-lease;
- renewal/reclaim uses exact observed predecessor SHA;
- simulated competing updates cause one contender to lose CAS and re-observe rather than overwrite;
- unexpired peer lease defers; expired trusted peer lease may be reclaimed after skew;
- same persistent identity under different session defers without singleton proof and may reconcile immediately only under daemon's already-held exclusive local lock;
- heartbeat advances lease and definite lost CAS fences/aborts local claim;
- expiry fences local claim even when renewal failed ambiguously;
- terminal release is signed/CAS-updated rather than blind deletion;
- coordination-enabled candidate branches include full agent fingerprint while disabled mode retains legacy names;
- lease loss prevents subsequent worker invocation, sealing, and publication effects;
- DB-018 pause during active work does not bypass heartbeat/fencing, and fully paused daemon admits/claims no new task;
- no task/model/repository field can select peer key, lease repository/ref, expected SHA, force mode, same-identity takeover permission, or create dispatch authority;
- task-author trust and peer trust remain independent configuration dimensions;
- until a destination-address protocol exists, tests/docs do not claim lease identity alone prevents one trusted task author from dispatching work to another runner that also trusts that author.
