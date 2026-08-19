# DB-003 — Local Security and Capability Policy

Status: active

Implementation status: current main enforces verified outer sandboxes for proposal workers/repository-code execution on Linux (Bubblewrap) and Windows (ProcessContainer through the pinned Microsoft MXC runtime), control-owned worker IPC, exact local execution authority, sanitized dynamic-operation onboarding, and current DB-007/DB-016/DB-018 capability/fencing/governance boundaries. Unsupported or unverified enforcement claims fail closed.

## Fundamental rule

Remote content can request work; it cannot grant machine authority.

DevBridge is the control-plane authority. Remote and local models are proposal engines. Human remote input is authoritative only for task authorship or decision classes that local operator policy explicitly delegates; it is not a general capability override.

### Task authorship is real remote job-submission authority

A runner's local `github.trustedActorIds` determines which numeric GitHub actors may author trusted tasks for that runner's configured queue under DB-002.

When local execution is enabled, a trusted task actor can cause development work to execute on that machine **inside the machine authority already granted by local policy**. The actor cannot grant arbitrary shell, executable, filesystem-root, environment, credential, network, sandbox, peer-trust, daemon-control, or publication capability through task text, but the actor is still a remote development-job submitter.

Do not derive `trustedActorIds` mechanically from repository collaborator/team membership. In a multi-developer deployment, repository collaboration, DB-016 coordination peer trust, DB-007 decision authority, and task-submission authority are separate permissions.

Current task envelopes are not cryptographically addressed to one destination installation. DB-016 leases prevent conflicting compliant task ownership; they do not decide which human may dispatch work to which workstation. If developer A must not dispatch work to developer B's runner, B's local queue/`trustedActorIds` policy must enforce that boundary today.

A future per-installation routing protocol must narrow dispatch without weakening DB-002 exact GitHub provenance or creating a second remote capability-grant channel.

## Filesystem

- Project writes are confined to a poller-managed project/worktree root.
- A remote task never supplies a local path.
- Containment checks account for `..`, absolute paths, and symlink/junction escape where the platform exposes realpath/filesystem identity information.
- Canonical-path checks are defense in depth, not a replacement for OS-level access controls where those are available.
- DevBridge itself does not write outside managed state/workspace roots except through an explicitly configured operator-owned integration boundary.
- A user's arbitrary existing checkout is not auto-cleaned or reset.

### External reads

Blanket read-only access to the rest of the machine is not the safe default: read access can expose SSH keys, cloud credentials, browser profiles, tokens, private documents, or other material that compromised code could exfiltrate through permitted output.

The default is therefore **deny arbitrary external reads**. Local configuration may add explicit read-only roots needed for toolchains, SDKs, package caches, or reference data. A verified OS/tool sandbox may expose additional system paths read-only when required.

## Process execution

- Child processes use `shell: false`.
- Executable identity and authority-bearing/static argv fragments come only from local configuration, built-in DevBridge code, or a control-owned validated local-operation manifest.
- Untrusted tool documentation may shape only closed non-authority parameter slots inside an already locally delegated tool envelope as defined by DB-015; it never grants executable, shell, environment, credential, network, path-root, or arbitrary argv capability.
- Allowed proposal-worker placeholders are structural values created by DevBridge (`projectDir`, `contextFile`, `resultFile`, `runId`).
- Free-form task text is never interpolated into argv.
- Shell-like executable profiles require an explicit unsafe/operator exception and are not provided by default.
- Environment inheritance is allowlist-based.
- GitHub control-plane credentials are not inherited by child tools.
- stdout/stderr collection is bounded.
- Timeouts are mandatory.

`cwd` is not a sandbox. A coding-tool profile is executable only when DevBridge can attach/verify the required outer containment mechanism. A profile declaration is not enough.

An explicit unsafe development override, where supported by local implementation, is operator authority and must be represented honestly as uncontained/unsafe rather than as equivalent to verified sandbox execution. The reference safe configuration keeps uncontained tools disabled.

### Deterministic operation classes

DevBridge distinguishes operations that can safely remain static/control-plane inspection from operations that execute repository-controlled code.

- Static inspection may execute without the repository-code sandbox only when its implementation itself cannot be redirected through filesystem indirection or repository-controlled execution.
- Trusted control operations run under DevBridge authority and must not be mislabeled as static/untrusted execution.
- Repository-code operations require the verified outer OS sandbox.
- Unknown future registered deterministic operations default to the repository-code class until deliberately classified.

Classification metadata is not enforcement; process admission must check observed provider capability before launch.

### Dynamic local-operation onboarding

DB-015 permits a narrow local extension mechanism without changing the fundamental authority model:

- operator-authored operation manifests live in an explicitly configured local directory and are validated before registration;
- automatic unfamiliar-tool onboarding is off by default and requires local configuration to pre-authorize the exact command name plus fixed help-probe arguments;
- merely finding a binary in `PATH`, seeing its name in repository content, or receiving a GitHub request cannot trigger execution or registration;
- when local auto-onboarding policy exists, the documentation probe itself is treated as untrusted repository-code execution and must run inside the verified OS sandbox with network denied, configured external read roots hidden, synthetic HOME/TMP, minimal environment, and no control-plane credentials/state;
- help/man/spec output is untrusted data. It may be parsed into a bounded closed schema only after local executable/probe authority already exists; authority-shaped parameter names and arbitrary raw argv are rejected;
- every generated `tool.*` operation remains in the fail-closed repository-code execution class and requires the verified OS sandbox for actual use;
- generated manifests are persisted under the configured local manifest root before activation so restart/reconciliation does not reconstruct a different wrapper silently;
- controller/GitHub/repository content cannot add or edit the local manifest root or auto-onboarding allowlist.

A synthesized wrapper reduces application-specific source edits; it does not turn tool documentation into a capability grant.

### Credentialed control plane versus proposal workers

Untrusted proposal/model workers, and any repository-controlled subprocesses they launch, are separated from the credentialed control plane by a **verified OS isolation boundary**. A profile declaration, installed binary, version banner, or provider-native capability probe is not sufficient evidence. If the active host has no provider that passes DevBridge's live adversarial boundary probe, proposal-worker and repository-code execution fail closed.

The built-in Linux provider uses Bubblewrap. The built-in Windows provider uses the ProcessContainer backend exposed by a pinned Microsoft MXC runtime. On Windows, the stage-0 bootstrap automatically provisions that pinned runtime into the DevBridge-owned home rather than modifying the managed source checkout. Provisioning failure leaves DevBridge available for non-repository-code control/static work but keeps repository-code execution disabled with an explicit diagnostic.

The provider is usable only after DevBridge itself demonstrates the required boundary on the running host. Windows verification exercises positive project/scratch writes and negative arbitrary outside read/write, control-state read, `.git` mutation, network egress, and escaped-descendant behavior. Provider presence or MXC `--probe` success alone never sets `repositoryCodeExecution: true`.

The worker boundary has these ownership rules:

- DevBridge control state, daemon lock/stop/pause authority, GitHub CLI credential storage, SSH/user credential state, identity private keys, release authority, and other operator-home credential sources stay outside the worker-visible filesystem policy;
- worker `HOME`, profile-data directories, and temporary directories are synthetic sandbox-owned locations rather than the operator home;
- control-plane GitHub token variables (`DEVBRIDGE_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, enterprise variants, Git/SSH askpass variables, and `SSH_AUTH_SOCK`) are stripped even when a local tool profile requests them;
- a non-control credential required by a coding service must be granted explicitly/narrowly by local tool configuration; stored operator-home coding-tool credentials are not made visible as a convenience;
- project/candidate bytes are writable proposal state, but authoritative `.git` / linked-worktree administrative state is read-only or unreachable from the worker;
- control-plane Git operations, state persistence, GitHub status/publication, lease transitions, hard-gate decisions, and daemon control execute outside this worker boundary;
- worker-visible candidate state is poller-owned disposable/reconstructable state. A worker never receives authority merely because it can edit those bytes.

#### Worker IPC ownership

Worker context/result exchange is **control-plane state**, not a reserved project directory.

For every run/turn DevBridge creates a private exchange root under the configured state directory with exclusive run/turn ownership. The control-only manifest binds the exact run/turn to context/result identities and SHA-256 of the context bytes. The manifest and authoritative result object are never writable by a worker.

Linux/Bubblewrap projects the pre-created context file read-only and the pre-created authoritative result file as an exact writable-in-place bind. The worker may not unlink, rename over, symlink, junction, or otherwise replace that mailbox object; DevBridge revalidates identity before consuming it.

Windows ProcessContainer has a different transport because MXC's writable-path fallback deliberately includes Windows delete authority. DevBridge therefore does **not** grant the worker writable access to the authoritative result object. Instead it exposes:

- the exact control-owned context file read-only;
- one exact, pre-created, non-authoritative worker staging-result file read/write;
- no write/create permission on the staging file's parent or siblings;
- an explicit deny on the authoritative result file.

After the contained process tree exits, DevBridge validates that the staging object is still the originally created regular file, enforces the result-size bound, then imports its bytes into the still-anchored authoritative result file under control-plane authority. A missing or replaced staging object is not accepted as a result. Recovery can repeat the same import from the control-owned manifest and recorded staging identity after interruption.

Before privileged result consumption DevBridge revalidates control-owned directory/file type, service ownership where the host exposes a UID, private permissions on POSIX, recorded filesystem identity, context digest, and bounded result size. Reads use no-follow semantics where available. This means `.devbridge/<run>/<turn>` inside the proposal tree is not an IPC security mechanism and need not exist. Project cleanup/Git exclusion is independent of control-plane mailbox ownership.

## GitHub control-plane authentication

GitHub authentication is local control-plane authority. Repository content, issue text, model output, and coding-tool configuration cannot select a credential source or cause a credential to be copied into the worker environment.

The current control plane supports these local credential sources:

1. an explicit bounded list of environment-variable names, with the reference precedence `DEVBRIDGE_GITHUB_TOKEN`, `GH_TOKEN`, then `GITHUB_TOKEN`;
2. when local policy uses `auto` or `github-cli`, the active credential already stored for the configured host by GitHub CLI, retrieved through `gh auth token --hostname <host>` with `shell: false`.

Rules:

- do not scan arbitrary environment-variable names looking for token-like values;
- do not read repository files, arbitrary home-directory files, shell history, or coding-tool state to discover GitHub credentials;
- environment-variable names are configuration; their values are secrets and are never serialized into config, run state, context capsules, diagnostics, or GitHub status;
- the GitHub CLI fallback is a local credential broker only; token stdout is consumed by DevBridge and never forwarded to the coding tool;
- one resolved credential is shared only by DevBridge adapters that explicitly require the same control-plane GitHub authority;
- resolved credential values are included only in the local redaction set before outbound reporting;
- `doctor` may report provider/source identity such as `GH_TOKEN` or `github-cli:github.com`, but never credential contents;
- remote tasks cannot reorder providers, add environment-variable names, select a GitHub CLI account, or enable a broader auth mechanism;
- future GitHub App authentication belongs behind this same local credential-provider boundary and must not weaken these rules.

## Network

Network access is a capability because it can fetch executable content and exfiltrate data. The policy distinguishes denied, restricted/sandbox-enforced, and explicitly unrestricted profiles.

Network policy should be phase-aware where practical. Provisioning, dependency fetch/install, build/test, loopback browser testing, proposal-model access, and publication do not require the same network authority. Arbitrary project/test code must not inherit publication credentials or broad network access merely because another phase needs them.

A worker network mode is usable only when the verified isolation provider can actually enforce the requested mode. Bubblewrap enforces `deny` by retaining the unshared network namespace and supports explicit `unrestricted` networking by sharing the host network namespace while retaining filesystem/control-state isolation. Windows ProcessContainer uses default-block networking with no AppContainer capabilities for `deny`; its provider must pass DevBridge's live egress canary before that mode is considered verified. A declared `restricted` mode fails closed until a provider can enforce a real restricted policy.

DB-008 remains authoritative for first-class package-manager/dependency/browser phase isolation, which is not yet complete.

## Human decisions and hard gates

DB-007 defines checkpoints, decision boundaries, and hard gates. These mechanisms do not weaken this security policy.

A trusted human decision may authorize only effects whose decision class is already enabled by local policy. In particular:

- a remote comment cannot add a filesystem root, executable, environment secret, network capability, credential, trusted task actor, trusted coordination peer, or sandbox exception;
- an approval cannot convert an unenforced sandbox claim into an enforced one;
- capability expansion beyond the active local policy requires the local operator-policy mechanism, even if a maintainer requests it remotely;
- approval for a payload-sensitive effect binds to the exact artifact subject under DB-007;
- expired, stale, mismatched, or superseded approval has no effect.

Human attention is not itself a reason to halt safe work. While a checkpoint or decision is pending, DevBridge may continue reversible work that stays within the current capability envelope and does not cross the gated decision boundary.

## Multi-agent coordination is not capability authority

DB-016 persistent keys, peer trust, leases, heartbeat/TTL, and fencing coordinate ownership among installations that are already locally authorized to participate.

A task lease does not grant:

- task authorship trust;
- target repository permission;
- executable/tool authority;
- filesystem/network access;
- credentials;
- hard-gate approval;
- per-human/per-workstation routing permission;
- publication authority beyond the separately configured Git boundary.

Unknown/unverifiable peer lease state fails closed for automatic acquisition. Lease loss/expiry fences subsequent DevBridge-authorized effects and aborts managed child execution where supported.

## Secrets and reporting

Before data leaves the machine through GitHub status, checkpoint, decision request, inventory projection, lease/status projection, or handoff comments:

- redact configured secret values;
- redact recognizable credential-token forms;
- redact additional locally configured sensitive patterns;
- strip unsafe control/terminal escape characters;
- bound output size;
- never include a complete process environment;
- avoid publishing machine-specific paths when a redacted/relative form is sufficient;
- never publish private identity/release keys or control-plane credentials.

Raw local evidence may be retained under bounded poller-owned state policy, but credentials/private keys must not be intentionally recorded there except in their explicit protected authority stores where required (for example the DB-016 local identity private key).

## Resource containment and workstation governance

Timeout, output limits, effective task concurrency, context size, lease timing, and child priority are bounded local policy/control behavior.

DB-018 currently provides:

- serialized task admission (effective concurrency one);
- below-normal child-process priority by default for model and deterministic children;
- cooperative token-bound pause/resume at safe daemon task-cycle boundaries.

Process priority is QoS, not a security sandbox or hard CPU quota. Strong CPU, memory, disk-growth, process-count, native-thread, or richer restricted-network containment requires verified platform adapters beyond portable Node APIs. Those gaps must be reported honestly rather than represented as enforced.

A timeout must attempt to terminate the whole managed process tree using the platform containment provider rather than assuming termination of the immediate child is sufficient. On Windows, ProcessContainer/Job Object lifecycle containment is primary and the parent runner's tree termination remains defense in depth.

`pause` must not be implemented as a process/thread freeze that breaks DB-016 lease heartbeat/fencing semantics. It is admission control at an existing safe boundary.

## Recovery safety

Recovery code must not become a privileged bypass around normal safety rules.

- Do not blindly delete Git lock files because they appear stale.
- Do not destructively clean/reset an unmanaged checkout.
- Prefer replacing a disposable poller-owned worktree over uncertain repair of Git administrative state.
- Local repair agents remain proposal engines; they do not receive implicit authority to bypass path, file-class, test, sandbox, lease, hard-gate, or publication policy.
- Cleanup may delete only state whose DevBridge ownership and containment can be established.
- Interrupted worker mailboxes are reopened only from control-owned run/turn state; manifest/file identities and unchanged context are revalidated before any result is treated as a proposal.
- Persisted verifying/publishing state must recheck current local candidate/baseline/lease/gate identity before later effects; stale verification or approval is never trusted merely because it was previously recorded.
