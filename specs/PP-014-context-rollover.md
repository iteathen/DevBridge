# PP-014 — Durable Chat Context Rollover and Resume

Status: active

## 1. Goal

A chat/model context is a disposable controller process, not authoritative project memory.

PATCH-POLLER MUST make context rollover, model-session restart, UI freeze, or controller replacement recoverable from small durable state without requiring a model to reconstruct completed work from transcript history.

The design specializes PP-005 context rehydration and PP-009 effect reconciliation. It does not create a second effect journal and it does not store an unbounded transcript.

## 2. Governing model

The expected control flow is:

`controller context -> bounded checkpoint -> durable handoff -> verify -> reconcile -> fresh context -> exact next action`

PATCH-POLLER owns handoff persistence and verification. A model or coordinating chat may author summaries and intended next-action IDs, but it cannot use a handoff to grant machine authority, capability, local path, executable, environment, credential, or Git mutation authority.

A handoff says what a fresh controller must know. Existing control-plane contracts still decide what it may do.

## 3. `patch-poller/chat-handoff-v1`

A handoff is a closed, bounded data object containing:

- `handoffId`: safe stable identifier;
- monotonically increasing `sequence`;
- target `repository` in `owner/name` form;
- exact immutable `baselineSha` and observed `headSha`;
- task branch when applicable;
- issue, PR, and run identity when applicable;
- current lifecycle `phase`;
- set of stable `completedActionIds`;
- exactly one `nextActionId` or `null` when no resumable action is known;
- bounded decision summaries bound to SHA-256 decision digests;
- bounded blockers;
- bounded durable evidence references;
- governing repository documents and exact SHA-256 digests;
- prior verified handoff digest when performing a compare-and-swap replacement;
- normalized UTC creation timestamp.

The protocol does not carry raw command lines, executable paths, local paths, environment values, credentials, capability grants, cleanup roots, arbitrary Git refs, or remote-provided code-execution authority.

## 4. Canonical encoding and digest

The normalized handoff has deterministic object-key ordering and set-like collections use deterministic ordering. PATCH-POLLER computes the whole-handoff SHA-256 over canonical UTF-8 JSON.

The digest binds reconstruction facts; it is not authorization.

Default maximum serialized handoff size is 32 KiB. Local policy MAY configure another value within the 256 KiB protocol safety ceiling. Large logs, diffs, build output, and other evidence belong behind durable references/digests rather than inside the handoff.

A handoff that exceeds its configured byte ceiling is rejected rather than silently losing critical fields.

## 5. Durable references

`evidenceRefs` use bounded typed/opaque locators such as:

- `commit:<sha>`;
- `workflow:<id>`;
- `issue:<number>`;
- `pr:<number>`;
- `run:<id>`;
- `test:<id>`;
- `doc:<repository-relative-path>`;
- `repo:<owner/name>`;
- `github:<bounded-remote-identity>`.

They MUST NOT be local filesystem paths. Evidence retrieval remains subject to the adapter and trust boundary that owns the referenced resource.

## 6. Stable action identity

Every controller operation that must survive rollover SHOULD have a stable action ID before the effect is attempted.

Examples:

- `seal:issue-20:r1`;
- `publish:branch:<digest>`;
- `pr:create:pp014`;
- `pr:merge:<head-sha>`;
- `issue:close:20`;
- `ci:observe:<head-sha>`.

The exact naming scheme is local/controller-owned; remote input does not gain authority because it can name an action.

A handoff records completed action IDs plus the one exact next action the controller intended. On resume, PATCH-POLLER reconciles observed state before the caller may act.

If the recorded next action is already observed complete, resume MUST NOT execute it again and MUST NOT invent a replacement next action. It returns `checkpoint-required` so a fresh authoritative checkpoint can choose the subsequent action.

## 7. Context budget manager

Context rollover triggers are explicit control-plane policy, not model intuition.

A budget manager has:

- a locally selected unit: exact `tokens`, measured serialized `bytes`, or caller-defined `proxy` units;
- explicit capacity in that unit;
- soft checkpoint ratio;
- preferred rollover ratio;
- hard rollover ratio.

Default ratios are 0.55 / 0.65 / 0.75 and MUST satisfy:

`soft < preferred < hard < 1`

The capacity is an operational rollover proxy, not a claim about a provider/model's actual maximum context size. Exact-token accounting is optional. When it is unavailable, the controller uses a consistent byte/proxy mode rather than mixing incomparable units.

Threshold meanings:

- below soft: ordinary operation;
- soft: checkpoint requested;
- preferred: checkpoint and prefer a fresh context after the checkpoint is verified;
- hard: checkpoint and require rollover before accumulating more discretionary context.

A hard rollover boundary limits controller-context growth; it does not authorize cancellation of a local deterministic effect already in progress. Effects complete/reconcile under their owning timeout/recovery contract.

## 8. Checkpoint-and-proceed policy

PP-007 remains normative: context checkpointing is not a generic human hard gate.

Even below the soft budget threshold, PATCH-POLLER SHOULD checkpoint after durable boundaries including:

- candidate seal/commit;
- branch publication;
- PR mutation;
- issue mutation;
- terminal CI observation;
- consequential architecture decision;
- lifecycle phase transition.

It SHOULD checkpoint immediately before an operation expected to generate unusually large evidence.

After a verified checkpoint, safe work may continue until rollover is preferred/required or another contract requires waiting.

## 9. Two-phase handoff checkpoint

Publishing a new verified handoff is a transaction over durable local state:

1. normalize and digest the proposed handoff;
2. persist a versioned `planned` record;
3. read it back and verify exact payload digest;
4. persist that versioned record as `ready`;
5. read it back and verify again;
6. atomically advance the small latest-pointer record to the verified version;
7. only then report the new handoff as ready.

The previous verified pointer/record remains available until the replacement is ready. A failed planned/ready write cannot make a partial replacement the latest verified handoff.

The pointer retains a bounded previous reference so a corrupted newest record can be diagnosed and, where safe, the immediately prior verified handoff can still rehydrate the controller.

Retention is bounded by local policy.

## 10. Compare-and-swap sequencing

A replacement handoff sequence MUST advance beyond the current verified sequence. A supplied `previousHandoffDigest` MUST equal the current verified digest.

Replaying the exact currently verified digest is idempotent.

These constraints prevent an old context window from overwriting a newer durable controller checkpoint after a delayed tool/UI response.

## 11. Resume seed

For a human/UI-controlled chat, PATCH-POLLER may emit a compact local line:

`PATCH-POLLER-RESUME v1 repo=<owner/name> handoff=<id> sha256=<digest>`

The seed is an address/identity, not the handoff itself. A new controller must retrieve and verify the matching handoff before use.

When a verified handoff is deliberately projected to a GitHub issue for cross-chat recovery, PATCH-POLLER emits:

`PATCH-POLLER-RESUME-GITHUB v1 mailbox=<queue-owner/name> issue=<number> repo=<target-owner/name> handoff=<id> sha256=<digest>`

The mailbox repository identifies where the recovery comment lives; the target repository identifies the project/Git state to reconcile. They may be the same for self-hosting, but PP-014 MUST NOT assume they are identical.

Current chat UIs may require the human to open the new window and provide the seed. Future API/CLI session launchers SHOULD consume the same identity/digest contract so the rollover model does not change when automatic session creation becomes available.

## 12. Resume reconciliation

A fresh controller does not act immediately after parsing a handoff.

It observes current durable state and reconciles at least:

- repository identity;
- immutable baseline SHA;
- expected current/head SHA;
- bound issue/PR/run identity where present;
- completed action IDs;
- governing-document digests.

Repository/head/task mismatches return `stale` with no executable next action.

If a governing document digest changed, resume returns `reread-required` with the exact repository-relative paths. The controller must actually reread those inputs before acknowledging them and requesting reconciliation again.

If identity matches and governing inputs are current/acknowledged, resume exposes exactly the recorded `nextActionId` and no other inferred action.

## 13. Governing-document digests

A handoff SHOULD include the small set of documents that materially govern continuation, typically `AGENTS.md` and relevant specs/design documents.

A digest mismatch does not mean the new document is malicious or wrong. It means the old controller context is no longer sufficient evidence for continuation. Rereading is required because architecture/safety instructions may have changed.

## 14. Security invariants

PP-014 MUST preserve all existing trust boundaries:

- handoffs are data, never local capability grants;
- credentials are never serialized into handoffs;
- no arbitrary local path or executable field exists in the remote/model-visible schema;
- no environment block or shell fragment exists;
- evidence locators are durable references, not filesystem authority;
- Git mutation still belongs to PATCH-POLLER/Git adapters and existing approval policy;
- resume never treats silence, a stale handoff, or a digest mismatch as approval;
- a handoff digest authenticates equality to locally stored state, not the identity of an untrusted author.

## 15. Failure behavior

- Planned checkpoint write fails: prior verified handoff remains current.
- Ready-record verification fails: pointer does not advance.
- Pointer/current record is corrupt: fail closed or fall back only to the explicitly retained previous verified record; surface the recovery condition.
- Sequence is stale: reject replacement.
- Previous digest mismatches: reject replacement.
- Current Git/task identity mismatches: resume is stale and no next action is released.
- Recorded next action already happened: return `checkpoint-required`; do not replay or invent.
- Handoff too large: reject and require references/compaction before rollover.
- Remote projection would require redaction: retain the verified local handoff but refuse the projection, because changing a digest-bound payload would make the remote reconstruction unverifiable.

## 16. Acceptance tests

Implementation is not complete until tests cover at least:

1. stable canonical digest across object-key ordering;
2. closed-schema/authority/path/size rejection;
3. deterministic soft/preferred/hard budget thresholds in exact and proxy modes;
4. durable-boundary checkpoint policy below the soft threshold;
5. planned -> readback -> ready -> readback -> pointer ordering;
6. failed replacement leaves prior verified handoff usable;
7. corrupt newest record can surface bounded previous-record recovery;
8. stale sequence and wrong previous digest are rejected;
9. exact-current checkpoint replay is idempotent;
10. compact local and GitHub resume seed round trips;
11. repository/head/task mismatch returns stale before next-action release;
12. governing-document changes force reread;
13. already-completed next action is skipped without inventing another;
14. large evidence remains references rather than payload transcript;
15. configured handoffs above the 32 KiB default remain resumable within the protocol ceiling;
16. GitHub projection edits/coalesces one recovery comment and reconciles crash-after-create without duplicate comments;
17. a fresh controller verifies a projected digest before recovering the exact recorded phase/next action;
18. tampered or redaction-requiring projections fail closed;
19. GitHub recovery keeps mailbox and target repository identities distinct;
20. Windows/Ubuntu cheap preflight, full tests, and doctor pass at the exact PR head.

## 17. Runtime and dependency boundary

PP-014 uses Node.js standard-library facilities and the existing `StateStore`/GitHub ports. It adds no coding-model dependency, no new runtime dependency, and no Python.

## 18. Optional GitHub recovery projection

Local verified handoff state is authoritative for PATCH-POLLER itself. A GitHub projection is optional and exists specifically to bridge environments such as a mobile/new ChatGPT window that cannot directly read the local StateStore.

Projection rules:

- projection is an explicit local action, never automatic remote authority;
- the handoff must already be locally `ready` and verified;
- the mailbox issue is locally/operator selected or already bound by controller policy;
- the handoff target repository may differ from the mailbox repository;
- PATCH-POLLER uses one stable marker/comment slot per mailbox-repository+issue and edits/coalesces later checkpoints instead of appending heartbeat-style comments;
- after a crash between comment creation and local correlation persistence, the projector searches the stable marker before creating another comment;
- the projection embeds the exact normalized handoff plus its original local digest and GitHub resume seed;
- a fresh controller parses the bounded fence and recomputes the handoff digest before trusting reconstruction facts;
- the resume seed and stable marker bind the mailbox repository/issue separately from the handoff target repository;
- if redaction would alter any byte of the digest-bound projection, the remote publication is refused rather than emitting a mismatched digest;
- GitHub projection is evidence/reconstruction transport only. It does not make GitHub issue text a capability channel.

The CLI exposes local read-only `handoff-status` and `handoff-seed` commands without requiring GitHub credentials. `handoff-project` is the explicit authenticated mutation that projects the latest verified handoff to its bound or specified mailbox issue.
