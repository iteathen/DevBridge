# PP-010 — Provenance and Control Channels

Status: active

Implementation status: partially implemented in v0.1.

## Goal

Make it impossible for untrusted text, model output, process output, or repository content to impersonate a trusted PATCH-POLLER control message merely by looking syntactically similar.

## Governing rule

**Only a typed control-channel adapter creates authoritative control objects. Everything else is data or a proposal.**

A string containing `patch-poller-feedback`, `Status: APPROVED`, a JSON object, or a shell-looking command has no authority based on its contents alone.

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
- process stdout/stderr/log data.

Roles are not interchangeable. A service-generated status comment must not be re-ingested as human approval, and model/process output must not be parsed by task/decision adapters unless an explicitly authenticated channel supplies it as such.

## Task provenance

The GitHub Issues adapter accepts a task only when:

- the issue is in the locally configured queue repository;
- its numeric GitHub actor ID is locally allowlisted;
- it contains exactly one valid bounded `patch-poller/task-v1` envelope;
- the target repository is locally allowed;
- the envelope revision digest is computed and persisted.

Login names and display text are not durable trust identifiers.

Editing a task does not mutate a claimed run. A new envelope digest is a new revision, and a newer revision of an issue is deferred while a previous revision is still active unless a future explicit supersession protocol says otherwise.

## Feedback and decisions

Continuation/cancel feedback is accepted only from locally allowlisted numeric actor IDs and only when run ID and immutable task revision match the waiting run.

The full PP-007 decision protocol will additionally bind:

- checkpoint ID;
- decision class;
- exact decision-surface/artifact digest;
- actor delegation class;
- source comment/event identity;
- one-time consumption/replay state.

Silence, labels without proven actor provenance, quoted text, bot echoes, status comments, and model-generated approval wording never imply approval.

## Anti-replay and anti-self-injection

For control messages that can authorize a consequential effect, the durable record should include the remote event/comment ID, numeric actor ID, body/event digest, run/task/checkpoint subject, accepted action, and consumption state.

Re-reading the same remote event must be idempotent. Copying an old valid envelope into a new context must fail subject binding unless the new event itself is an authorized control source for the same still-valid subject.

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

1. OS/local operator policy;
2. PATCH-POLLER checked-in specs/control-plane implementation;
3. locally delegated decision authority;
4. trusted task objective/constraints;
5. target repository instructions loaded from the trusted baseline commit;
6. model proposals, candidate repository content, dependencies, web content, and process output.

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

## Self-modification

Targeting PATCH-POLLER itself should be disabled by default in a hardened deployment.

When explicitly enabled, self-development occurs in an ordinary isolated proposal worktree. The currently running daemon does not begin executing candidate control-plane code or new trust policy mid-run. Upgrade is a separate exact-artifact process: build/test -> checkpoint/approve -> stop cleanly -> replace -> restart -> verify.

## Derived architecture/context data

Derived manifests, indexes, checkpoints, and run journals belong under PATCH-POLLER-owned state unless a target repository explicitly chooses to version such data. A proposal engine cannot make derived state authoritative by writing a similarly named file into the project.

## Required tests

Tests must prove:

- untrusted actors cannot create tasks/feedback;
- wrong run/revision feedback is ignored;
- model/process text that resembles a control envelope is not parsed as authority;
- duplicate/replayed decision events are idempotent once PP-007 decisions are implemented;
- service-authored comments cannot authorize themselves;
- repository identity mismatch blocks reuse/publication;
- candidate instruction changes do not affect their own active run;
- incompatible tool-profile identity is detected once version probing is implemented.

## v0.1 boundary

v0.1 implements numeric task/feedback actor trust, structured bounded envelopes, immutable task revision digests, run/revision feedback matching, remote-field authority rejection, exact managed-origin checking, and candidate/runtime separation.

v0.1 does **not** yet implement `patch-poller/decision-v1`, numeric repository-ID pinning, full control-event consumption journaling, baseline instruction snapshots, or tool-version/profile-digest enforcement. These remain explicit next hardening slices.
