# PP-010 — Provenance and Control Channels

Status: active

Implementation status: current main implements exact GitHub task/feedback/decision edit provenance, PP-007 decision binding, managed-origin checking, PP-016 signed coordination identity/lease provenance, and a separate signed immutable production self-update channel. Numeric GitHub repository-ID pinning and full tool-profile identity remain future hardening items.

## Goal

Make it impossible for untrusted text, model output, process output, repository content, mutable labels, lease-looking content, or update pointers to impersonate a trusted PATCH-POLLER control message merely by looking syntactically similar.

## Governing rule

**Only a typed control-channel adapter plus the required local delegation creates an authoritative control object. Everything else is data or a proposal.**

A string containing `patch-poller-feedback`, `Status: APPROVED`, a JSON object, a shell-looking command, a branch name, or a lease-looking signature block has no authority based on its contents alone.

## Channel roles

PATCH-POLLER distinguishes at least these provenance/authority roles:

- local operator configuration/policy;
- trusted task issuer for one runner/queue (`github.trustedActorIds`);
- delegated human decision issuer for specific PP-007 classes;
- trusted PP-016 coordination peer public key;
- PATCH-POLLER service/status/projection identity;
- local/remote proposal engine;
- target repository baseline instructions;
- candidate repository content;
- dependency/web/tool-documentation content;
- process stdout/stderr/log data;
- mutable development update transport;
- locally trusted signed production release subject.

Roles are not interchangeable.

- A repository collaborator is not automatically a trusted task issuer.
- A trusted task issuer is not automatically a decision authority.
- A PP-016 trusted peer key authenticates coordination lease evidence only; it does not authorize that peer's human/operator to submit tasks to this workstation.
- A service-generated status comment must not be re-ingested as human approval.
- Model/process/tool-documentation output must not be parsed by task/decision adapters unless an explicitly authenticated source supplies it as such.
- A mutable branch may transport bytes without becoming immutable production authority for those bytes.

## Task provenance and dispatch authority

The GitHub Issues adapter accepts a task only when:

- the issue is in the locally configured queue repository;
- its original numeric GitHub actor ID is locally allowlisted for that runner;
- its exact current body and retained edit provenance are verified;
- every retained editor is trusted for task authorship;
- it contains exactly one valid bounded `patch-poller/task-v1` envelope;
- the target repository is locally allowed;
- the exact body/envelope revision digest is computed and persisted.

Login names and display text are not durable trust identifiers. A trusted original author plus an untrusted or unverifiable editor does not create authority.

Editing a task does not mutate a claimed run. New exact-content digest is a new revision, and newer revision is deferred while previous revision remains active unless an explicit supersession protocol says otherwise.

A runner's `github.trustedActorIds` is remote development-job submission authority for that runner's configured queue. This is distinct from machine capability authority: task text still cannot supply executables, shell/argv, local paths, credentials, network grants, sandbox exceptions, peer keys, or publication force state.

Current task envelopes are not cryptographically addressed to a destination PP-016 installation. If multiple runners observe the same queue and trust the same task actor, PP-016 determines which eligible daemon owns the revision, not whether the human author was permitted to dispatch to a particular workstation. Per-workstation isolation currently remains local queue/task-author policy.

## Feedback and decisions

Continuation/cancel feedback is accepted only from locally allowlisted numeric actor IDs, only after exact comment-body/edit provenance verification, and only when run ID and immutable task revision match the waiting run.

PP-007 decisions additionally bind:

- checkpoint ID;
- decision class;
- exact decision-surface/artifact digest;
- actor delegation class;
- source comment/event identity and exact comment SHA-256;
- complete retained edit provenance;
- bounded validity/consumption state.

Silence, labels without proven actor provenance, quoted text, bot echoes, status comments, and model-generated approval wording never imply approval.

## Agent identity and lease provenance

PP-016 introduces a separate typed coordination channel.

Each coordination-enabled installation has a persistent local Ed25519 keypair. Public-key SHA-256 fingerprint identifies the installation; private key remains local control state.

A `patch-poller/task-lease-v1` subject is authoritative coordination evidence only when:

- it is parsed by the PP-016 lease adapter from the fixed local lease namespace;
- signature verifies under the expected local/trusted peer public key;
- queue repository, issue number, exact task revision, owner/session, epoch, state, time window, and predecessor identity are valid;
- lease ref transition satisfies exact expected-value Git CAS rules.

A copied lease JSON/signature in issue text, repository files, model output, or status comments has no lease authority. A valid lease signature still does not create task trust, decision authority, executable/capability authority, credentials, or publication permission.

## Anti-replay and anti-self-injection

For control messages that can authorize a consequential effect, durable record includes or is designed to include remote/control event identity, trusted actor/key identity, exact subject digest, provenance, run/task/checkpoint/lease binding, accepted action, and replay/consumption state appropriate to that protocol.

Re-reading same remote event/lease state is idempotent. Copying old valid envelope into a new context fails subject binding unless the new source itself is an authorized typed control source for the same still-valid subject.

Webhook support, if added, must verify webhook signature and use delivery/event identity for replay protection while retaining PP-002 exact task-author/content authority.

## Repository identity

Human-facing tasks name repositories as `owner/name`. After first trusted resolution, hardened repository identity should persist:

- GitHub numeric repository ID;
- expected GitHub host;
- canonical owner/name;
- expected origin/publication remote;
- visibility/ownership observations relevant to local policy;
- resolution time/policy version.

Repository rename/transfer must be detected and reconciled deliberately rather than silently treating a different owner/repository as the old one.

Current main verifies exact configured `owner/name`-derived origin identity before reusing a managed checkout. Numeric repository-ID pinning remains future hardening.

## Instruction precedence

The authority order is:

1. OS/local operator policy, local control-state keys, and release-signing key/manifest configuration;
2. PATCH-POLLER checked-in active specs/control-plane implementation;
3. locally delegated task-author, decision-class, and coordination-peer roles, each only for its own protocol/effects;
4. trusted task objective/constraints;
5. target repository instructions loaded from trusted baseline commit;
6. model proposals, candidate repository content, dependencies, tool docs, web content, process output, and mutable development/update transport.

Repository instructions guide project work but cannot grant machine capability. Candidate changes to an instruction file do not rewrite rules governing their own current run; such changes apply only after becoming trusted baseline through normal project process.

A lower role cannot upgrade itself to a higher role by embedding the syntax of that higher role.

## Tool identity and compatibility

A tool profile is local authority and should eventually bind to more than a friendly name. Hardened profiles should record/probe:

- resolved executable real path;
- executable/package version;
- invocation/input/result protocol version;
- sandbox provider/mode;
- compatibility range tested by PATCH-POLLER;
- profile digest.

A materially incompatible tool upgrade should produce `TOOL_INCOMPATIBLE` or equivalent explicit failure rather than silently changing command semantics.

PP-015 presence-only inventory and dynamic onboarding do not weaken this requirement: discovered binary name/help output is data and can create only bounded schema within already locally delegated command authority.

## Self-modification and release provenance

Targeting PATCH-POLLER itself should remain disabled by default in a hardened deployment unless local policy explicitly permits self-development path.

Self-development occurs in ordinary isolated proposal worktree under PP-003/PP-007. Current daemon does not begin executing candidate control-plane code or new trust policy mid-run. Sensitive PATCH-POLLER candidates are hard-gated before sealing/publication.

Runtime activation is a separate control channel with two modes:

### Development/testing

Mutable locally configured testing channel is explicitly an **alpha development transport/authority** for self-hosting loop. It is not presented as production release integrity. Even here, newly fetched candidate preflight/tests execute only behind verified untrusted-code sandbox; lack of verified provider blocks automatic candidate activation.

### Production

Production update authority is a local signed immutable release subject, not mutable stable branch.

Local `patch-poller/release-manifest-v1` and local Ed25519 public key bind:

- fixed repository identity `iteathen/PATCH-POLLER`;
- exact 40-hex Git head;
- exact package version;
- exact `patch-poller/runtime-artifact-v1` SHA-256.

Stable branch is transport only and can yield production candidate only while resolving to signed head. Signature verification and supervisor-computed artifact hashing occur before candidate-controlled code executes. Candidate preflight/tests then run in verified sandbox with control state/credentials unexposed and network denied. Runtime artifact digest is recomputed after tests and immediately at daemon-spawn boundary after drain.

A previous last-known-good signed runtime remains acceptable from control-owned healthy activation journal plus a fresh artifact digest even when local manifest advanced to next signed release. This lets release N remain running/rollback subject while operator authorized N+1 as next update.

Missing signing material, invalid signature, wrong repository/head/version/digest, stable-transport mismatch, sandbox verification failure, test-time artifact mutation, or activation-boundary digest mismatch fails closed. Production never silently falls back to development semantics.

Candidate `doctor` is post-acceptance health evidence; it does not prove candidate release integrity before acceptance.

## Derived architecture/context data

Derived manifests, indexes, checkpoints, activation journals, identity/lease journals, handoffs, and run journals belong under PATCH-POLLER-owned state unless target repository explicitly chooses to version non-authority data. A proposal engine cannot make derived state authoritative by writing similarly named project file.

## Required tests

Tests must prove:

- untrusted actors/editors cannot create tasks/feedback/decisions;
- task-author trust, decision authority, and coordination peer trust remain distinct;
- wrong run/revision feedback is ignored;
- model/process/repository text that resembles control envelope or lease is not parsed as authority;
- duplicate/replayed decision/lease events are idempotent or fail subject binding appropriately;
- service-authored comments cannot authorize themselves;
- current task protocol is not falsely represented as destination-agent addressed;
- repository identity mismatch blocks reuse/publication;
- candidate instruction changes do not affect own active run;
- mutable production branch movement without matching signed release subject cannot activate code;
- candidate validation cannot read/mutate supervisor control state or credentials and cannot use forbidden network access;
- exact tested production artifact identity is preserved through activation;
- incompatible tool-profile identity is detected once full version/profile probing is implemented.

## Current boundary

Current main implements numeric task/feedback actor trust, exact GitHub edit provenance, structured bounded envelopes, immutable exact-content task revision digests, run/revision feedback matching, PP-007 decision matching/delegation, PP-016 signed lease peer identity/subject verification, remote-field authority rejection, exact managed-origin checking, candidate/runtime separation, signed production self-update subjects, and sandboxed candidate validation.

Current main does **not** yet implement numeric repository-ID pinning, webhook delivery journaling, complete baseline instruction snapshots as an independent identity object, full tool-version/profile-digest enforcement, or per-installation human task destination addressing. These remain explicit hardening/feature boundaries rather than implied capabilities.
