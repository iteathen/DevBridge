# PATCH-POLLER Security Boundaries and Runner Inventory

Status: authoritative operator guidance for the execution-boundary, decision-gate, and local-capability controls implemented by PATCH-POLLER.

## Control plane versus proposal workers

`PatchPoller` owns Git administrative state, GitHub credentials, persisted run state, decision authority, sealing, commits, and publication. Coding CLIs and repository test/build processes are subordinate proposal engines.

Repository-code execution is not considered contained because a local profile says `sandbox.enforcement = "os"`. PATCH-POLLER requires a provider whose boundary probe has actually passed. The current verified provider is Bubblewrap on Linux. On platforms without a verified provider, repository-code execution fails closed unless the operator has explicitly enabled the unsafe local override `execution.allowUncontainedTools`.

The verified Linux boundary probes all of the following before repository code is eligible to run:

- project files can be read;
- project writes are denied for a read-only verification launch;
- paths outside the project are not readable by default;
- paths outside the project are not writable by default;
- authoritative `.git` administrative state is hidden;
- loopback/network access is denied by namespace isolation.

Proposal workers receive only the environment variables named by the local profile plus PATCH-POLLER's non-interactive/run identifiers. GitHub credentials are not inherited implicitly.

## Worker mailboxes

Worker control data is not stored in the proposal worktree. PATCH-POLLER creates a private control-owned mailbox tree outside the repository:

- `input/context.json` is created once and exposed read-only to the worker;
- `output/result.json` is the only worker-writable control result path;
- mailbox identifiers contain a random nonce;
- result reads require a bounded regular non-link file and use no-follow semantics where the OS provides them;
- cleanup refuses to cross outside the owned mailbox root.

The proposal worker may write ordinary project files, but it must not stage, commit, reset, clean, push, or otherwise manipulate Git administrative state. PATCH-POLLER independently validates and seals accepted project bytes.

## Explicit read allowlists

The Linux sandbox exposes only conventional system runtime/library roots and PATCH-POLLER's currently running Node installation automatically. Optional tool installations under locations such as `/opt`, Nix stores, or user-local directories are not broadly exposed.

A local tool profile that needs an additional runtime directory must declare:

```json
{
  "sandbox": {
    "enforcement": "os",
    "outsideProjectRead": "allowlist",
    "readOnlyRoots": ["/absolute/local/tool/runtime"],
    "outsideProjectWrite": false,
    "network": "deny"
  }
}
```

`readOnlyRoots` are local absolute directories. They never appear in the GitHub runner inventory; only their count is projected.

## Immutable GitHub authority

Machine-authoritative task, feedback, and decision input is accepted only from an exact fenced GitHub issue comment created by an actor whose immutable numeric GitHub user ID is authorized by local policy.

Authoritative comments must be append-only: `created_at` must equal `updated_at`. Edited comments are rejected. Issue bodies, quoted control blocks, prose surrounding a control block, untrusted comments, and malformed blocks are discussion rather than authority.

Task revision identity is bound to both the validated task envelope and the immutable authority source (issue/comment/actor/timestamp/body digest). A changed authority comment therefore cannot silently retain the old task identity.

## PP-007 hard decision gates

PATCH-POLLER proceeds autonomously until a sensitive effect reaches the seal/publish frontier. It then persists a restart-safe checkpoint and stops only that gated effect. Silence is never approval.

Local decision classes are:

- `control-plane` — changes to PATCH-POLLER authority/security/runtime/bootstrap/GitHub/Git/workflow/config surfaces;
- `contract` — specification/schema/contract changes;
- `architecture` — broad cross-owner changes that meet the local architecture-risk classifier;
- `destructive` — deletion/destructive candidate effects.

The GitHub decision envelope is `patch-poller/decision-v1`. It binds exactly to `runId`, `taskRevision`, `checkpointId`, and `subjectDigest`. The comment cannot choose its own decision class; that class and its authorized actor IDs come from local configuration.

Binding modes:

- **artifact-exact** for control-plane and destructive changes. Any approved-byte change invalidates the approval and requires a new matching decision.
- **decision-scope** for contract and architecture changes. Bytes may evolve only while the approved baseline/risk/path scope remains identical.

Decision comments created before the checkpoint are not replayable. Expired or superseded checkpoints keep a comment high-water mark so an old approval cannot authorize a renewed gate.

## Controller-owned persistent bytes

A deterministic controller plan materializes project bytes before executable operations run. After all operations, assertions, scratch cleanup, and ephemeral cleanup, PATCH-POLLER re-hashes every controller-owned persistent path.

Create/replace files must still equal the exact planned SHA-256; deleted paths must remain absent. Only then is the expected changed-path set validated and the candidate eligible for sealing. A test/build process that mutates a planned file therefore cannot smuggle different bytes into the final candidate.

## Self-update trust boundary

The supported bootstrap entry point is `patch-poller.mjs`, which routes through `src/bootstrap/secure-bootstrap.mjs`. `transactional-bootstrap.mjs` is an internal supervisor library and is not the supported trust-establishing entry point.

Stable-channel runtime installation/update requires a trusted local `patch-poller/release-policy-v1` file (by default under the PATCH-POLLER bootstrap home). Production policy specifies an absolute local Ed25519 public-key file, key ID, and candidate-relative release manifest path.

A production candidate must contain `patch-poller/release-manifest-v1` binding its exact Git commit and Git tree to that key. The currently trusted runtime verifies the Ed25519 signature before candidate code is executed.

After integrity verification, candidate tests and candidate `doctor` execute only through the currently trusted runtime's verified OS sandbox. If that sandbox is unavailable or its boundary probe fails, candidate execution and activation fail closed. The testing channel may use an explicit development release policy; that exception is not valid for stable.

## Tool discovery and adaptive routing

Local discovery has two deliberately separate phases:

1. **Hot discovery** scans bounded PATH directories for known executable names. It does not spawn version subprocesses and has a 45 ms budget by default.
2. **Health/version probing** invokes bounded `--version` probes separately, outside a repository working directory. Broken preferred tools are skipped by adaptive fallback selection.

The discovery catalog includes runtime/package managers, search/code-intelligence tools, filesystem/diff utilities, Git/platform CLIs, container/Kubernetes tools (including `kubectl`, `helm`, and `k9s`), infrastructure tools, HTTP tools, security tools, and local agent runtimes.

Examples of fallback routing include `rg -> grep`, `uv -> pip`, `pnpm -> npm`, and `podman -> docker -> nerdctl`.

## `patch-poller/tool-inventory-v1`

The GitHub-visible runner inventory is a sanitized projection, never the internal executable registry. It reports:

- PATCH-POLLER runtime identity;
- platform/architecture;
- configured sandbox provider and measured verification state;
- core deterministic operations and whether required enforcement is satisfied;
- local toolchain availability/health/version when safe to expose;
- model-adapter declared policy separately from verified enforcement;
- sanitized discovered-tool availability/version/health.

It does **not** publish executable paths, home directories, environment values, credentials, arguments, sandbox read/write roots, or internal file identity metadata. Strings containing machine-absolute paths are removed from projected version/source fields.

The inventory has a stable SHA-256 digest and short generation ID computed without volatile timestamps/timings. GitHub projection is coalesced by digest, so unchanged capability state does not churn comments. If normal secret redaction would alter the inventory payload, PATCH-POLLER refuses to publish that divergent authority data.

Model workers and ordinary status capsules receive only the inventory protocol/digest/generation reference, not the internal executable registry.
