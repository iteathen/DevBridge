# PP-010 — Provenance and Control Channels

Status: active

Implementation status: v0.1 implements exact GitHub task/feedback/decision edit provenance, PP-007 decision binding, managed-origin checking, and a separate signed immutable production self-update channel. Numeric GitHub repository-ID pinning and full tool-profile identity remain future hardening items.

## Goal

Make it impossible for untrusted text, model output, process output, repository content, or mutable update pointers to impersonate a trusted PATCH-POLLER control message merely by looking syntactically similar.

## Governing rule

**Only a typed control-channel adapter creates authoritative control objects. Everything else is data or a proposal.**

A string containing `patch-poller-feedback`, `Status: APPROVED`, a JSON object, a shell-looking command, or a branch name has no authority based on its contents alone.

## Channel roles

PATCH-POLLER distinguishes at least these provenance roles:

- local operator configuration/policy;
- trusted task issuer;
- delegated human decision issuer;
- PATCH-POLLER service/status identity;
- local/remote proposal engine;
- target repository baseline instructions;
- candidate repository content;
- dependency/web content;
- process stdout/stderr/log data;
- mutable development update transport;
- locally trusted signed production release subject.

Roles are not interchangeable. A service-generated status comment must not be re-ingested as human approval, and model/process output must not be parsed by task/decision adapters unless an explicitly authenticated channel supplies it as such. A mutable branch may transport bytes without becoming the immutable production authority for those bytes.

## Task provenance

The GitHub Issues adapter accepts a task only when:

- the issue is in the locally configured queue repository;
- its numeric GitHub actor ID is locally allowlisted;
- its exact current body and retained edit provenance are verified;
- it contains exactly one valid bounded `patch-poller/task-v1` envelope;
- the target repository is locally allowed;
- the exact body/envelope revision digest is computed and persisted.

Login names and display text are not durable trust identifiers. A trusted original author plus an untrusted or unverifiable editor does not create authority.

Editing a task does not mutate a claimed run. A new exact-content digest is a new revision, and a newer revision of an issue is deferred while a previous revision is still active unless a future explicit supersession protocol says otherwise.

## Feedback and decisions

Continuation/cancel feedback is accepted only from locally allowlisted numeric actor IDs, only after exact comment-body/edit provenance verification, and only when run ID and immutable task revision match the waiting run.

PP-007 decisions additionally bind:

- checkpoint ID;
- decision class;
- exact decision-surface/artifact digest;
- actor delegation class;
- source comment/event identity and exact comment SHA-256;
- complete retained edit provenance;
- one-time consumption/replay state.

Silence, labels without proven actor provenance, quoted text, bot echoes, status comments, and model-generated approval wording never imply approval.

## Anti-replay and anti-self-injection

For control messages that can authorize a consequential effect, the durable record includes or is designed to include the remote event/comment ID, numeric actor ID, exact body/event digest, edit provenance, run/task/checkpoint subject, accepted action, and consumption state.

Re-reading the same remote event is idempotent. Copying an old valid envelope into a new context fails subject binding unless the new event itself is an authorized control source for the same still-valid subject.

Webhook support, if added, must verify the webhook signature and use delivery/event identity for replay protection.

## Repository identity

Human-facing tasks name repositories as `owner/name`. After first trusted resolution, the hardened repository identity should persist:

- GitHub numeric repository ID;
- expected GitHub host;
- canonical owner/name;
- expected origin/publication remote;
- visibility/ownership observations relevant to local policy;
- resolution time and policy version.

Repository rename/transfer must be detected and reconciled deliberately rather than silently treating a different owner/repository as the old one.

v0.1 verifies the exact configured `owner/name`-derived origin URL before reusing a managed checkout. Numeric repository-ID pinning is a future hardening item.

## Instruction precedence

The authority order is:

1. OS/local operator policy and release-signing key/manifest configuration;
2. PATCH-POLLER checked-in specs/control-plane implementation;
3. locally delegated decision authority;
4. trusted task objective/constraints;
5. target repository instructions loaded from the trusted baseline commit;
6. model proposals, candidate repository content, dependencies, web content, process output, and mutable development/update transport.

Repository instructions guide project work but cannot grant machine capability. Candidate changes to an instruction file do not rewrite the rules governing their own current run; such changes apply only after they become trusted baseline through the normal project process.

## Tool identity and compatibility

A tool profile is local authority and should eventually bind to more than a friendly name. Hardened profiles should record/probe:

- resolved executable real path;
- executable/package version;
- invocation/input/result protocol version;
- sandbox provider/mode;
- compatibility range tested by PATCH-POLLER;
- profile digest.

A materially incompatible tool upgrade should produce `TOOL_INCOMPATIBLE` or an equivalent explicit failure rather than silently changing command semantics.

## Self-modification and release provenance

Targeting PATCH-POLLER itself should remain disabled by default in a hardened deployment unless local policy explicitly permits the self-development path.

Self-development occurs in an ordinary isolated proposal worktree under PP-003/PP-007. The currently running daemon does not begin executing candidate control-plane code or new trust policy mid-run. Sensitive PATCH-POLLER candidates are hard-gated before sealing/publication.

Runtime activation is a separate control channel with two modes:

### Development/testing

The mutable locally configured testing branch is explicitly an **alpha development transport and authority** for the self-hosting loop. It is not presented as production release integrity. Even in this mode, a newly fetched candidate's preflight/tests execute only behind the verified untrusted-code sandbox; lack of a verified provider blocks automatic candidate activation.

### Production

Production update authority is a local signed immutable release subject, not the mutable stable branch.

The local `patch-poller/release-manifest-v1` and local Ed25519 public key bind:

- fixed repository identity `iteathen/PATCH-POLLER`;
- exact 40-hex Git head;
- exact package version;
- exact `patch-poller/runtime-artifact-v1` SHA-256.

The stable branch is transport only and can yield a production candidate only while it resolves to the signed head. Signature verification and supervisor-computed artifact hashing occur before candidate-controlled code executes. Candidate preflight/tests then run in the verified sandbox with control state/credentials unexposed and network denied. The runtime artifact digest is recomputed after tests and again immediately at the daemon-spawn boundary after the drain window.

A previous last-known-good signed runtime remains acceptable from the control-owned healthy activation journal plus a fresh artifact digest even when the local manifest has advanced to the next signed release. This lets release N remain the running/rollback subject while the operator has authorized release N+1 as the next update.

Missing signing material, invalid signature, wrong repository/head/version/digest, stable-transport mismatch, sandbox verification failure, test-time artifact mutation, or activation-boundary digest mismatch fails closed. Production mode never silently falls back to development semantics.

Candidate `doctor` is post-acceptance health evidence; it is not permitted to prove the candidate's own release integrity before acceptance.

## Derived architecture/context data

Derived manifests, indexes, checkpoints, activation journals, and run journals belong under PATCH-POLLER-owned state unless a target repository explicitly chooses to version such data. A proposal engine cannot make derived state authoritative by writing a similarly named file into the project.

## Required tests

Tests must prove:

- untrusted actors/editors cannot create tasks/feedback/decisions;
- wrong run/revision feedback is ignored;
- model/process text that resembles a control envelope is not parsed as authority;
- duplicate/replayed decision events are idempotent;
- service-authored comments cannot authorize themselves;
- repository identity mismatch blocks reuse/publication;
- candidate instruction changes do not affect their own active run;
- mutable production branch movement without the matching signed release subject cannot activate code;
- candidate validation cannot read/mutate supervisor control state or credentials and cannot use forbidden network access;
- exact tested production artifact identity is preserved through activation;
- incompatible tool-profile identity is detected once version probing is implemented.

## v0.1 boundary

v0.1 implements numeric task/feedback actor trust, exact GitHub edit provenance, structured bounded envelopes, immutable exact-content task revision digests, run/revision feedback matching, PP-007 decision matching/delegation, remote-field authority rejection, exact managed-origin checking, candidate/runtime separation, signed production self-update subjects, and sandboxed candidate validation.

v0.1 does **not** yet implement numeric repository-ID pinning, webhook delivery journaling, baseline instruction snapshots, or full tool-version/profile-digest enforcement. These remain explicit next hardening slices.
