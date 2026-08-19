# PP-003 — Local Security and Capability Policy

Status: active

## Fundamental rule

Remote content can request work; it cannot grant machine authority.

PATCH-POLLER is the control-plane authority. Remote and local models are proposal engines. Human remote input is authoritative only for decision classes that local operator policy explicitly delegates; it is not a general capability override.

## Filesystem

- Project writes are confined to a poller-managed project/worktree root.
- A remote task never supplies a local path.
- Containment checks must account for `..`, absolute paths, and symlink/junction escape where the platform exposes realpath information.
- Canonical-path checks are defense in depth, not a replacement for OS-level access controls where those are available.
- PATCH-POLLER itself does not write outside managed state/workspace roots except through an explicitly configured operator-owned integration boundary.
- A user's arbitrary existing checkout is not auto-cleaned or reset.

### External reads

Blanket read-only access to the rest of the machine is not the safe default: read access can expose SSH keys, cloud credentials, browser profiles, tokens, private documents, or other material that a compromised task could exfiltrate through permitted output.

The default is therefore **deny arbitrary external reads**. Local configuration may add explicit read-only roots needed for toolchains, SDKs, package caches, or reference data. A verified OS/tool sandbox may expose additional system paths read-only when required.

## Process execution

- Child processes use `shell: false`.
- Executable identity and authority-bearing/static argv fragments come only from local configuration, built-in PATCH-POLLER code, or a control-owned validated local-operation manifest.
- Untrusted tool documentation may shape only closed, non-authority parameter slots inside an already locally delegated tool envelope as defined by PP-015; it never grants an executable, shell, environment, credential, network, path-root, or arbitrary argv capability.
- Allowed placeholders are structural values created by PATCH-POLLER (`projectDir`, `contextFile`, `resultFile`, `runId`).
- Free-form task text is never interpolated into argv.
- Shell-like executable profiles require an explicit unsafe/operator exception and are not provided by default.
- Environment inheritance is allowlist-based.
- GitHub credentials are not inherited by child tools automatically.
- stdout/stderr collection is bounded.
- Timeouts are mandatory.

`cwd` is not a sandbox. A coding-tool profile is executable only when local configuration identifies a real containment mechanism supplied by the tool or operating system, unless the operator explicitly enables an unsafe development override.

### Dynamic local-operation onboarding

PP-015 permits a narrow local extension mechanism without changing the fundamental authority model:

- operator-authored operation manifests live in an explicitly configured local directory and are validated before registration;
- automatic unfamiliar-tool onboarding is off by default and requires local configuration to pre-authorize the exact command name plus fixed help-probe arguments;
- merely finding a binary in `PATH`, seeing its name in repository content, or receiving a GitHub request cannot trigger execution or registration;
- when local auto-onboarding policy exists, the documentation probe itself is treated as untrusted repository-code execution and must run inside the verified OS sandbox with network denied, configured external read roots hidden, synthetic HOME/TMP, minimal environment, and no control-plane credentials/state;
- help/man/spec output is untrusted data. It may be parsed into a bounded closed schema only after the local executable/probe authority already exists; authority-shaped parameter names and arbitrary raw argv are rejected;
- every generated `tool.*` operation remains in the fail-closed repository-code execution class and requires the verified OS sandbox for actual use;
- generated manifests are persisted under the configured local manifest root before activation so restart/reconciliation does not reconstruct a different wrapper silently;
- controller/GitHub/repository content cannot add or edit the local manifest root or auto-onboarding allowlist.

A synthesized wrapper therefore reduces application-specific source edits; it does not turn tool documentation into a capability grant.

### Credentialed control plane versus proposal workers

Untrusted proposal/model workers, and any repository-controlled subprocesses they launch, are separated from the credentialed control plane by a **verified OS isolation boundary**. A profile declaration is not sufficient evidence. If the active host has no verified worker-isolation provider, proposal-worker execution fails closed.

The current Linux provider uses the verified Bubblewrap boundary defined by the deterministic execution layer. Other platforms may inspect/configure PATCH-POLLER, but they do not gain proposal-worker execution merely because a tool profile says `sandbox.enforcement: os` or `tool`.

The worker boundary has these ownership rules:

- PATCH-POLLER control state, daemon lock/stop authority, GitHub CLI credential storage, SSH/user credential state, and other operator-home credential sources stay outside the worker mount namespace;
- worker `HOME` and temporary directories are synthetic sandbox-owned locations rather than the operator home;
- control-plane GitHub token variables (`PATCH_POLLER_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, enterprise variants, Git/SSH askpass variables, and `SSH_AUTH_SOCK`) are stripped even when a local tool profile requests them;
- a non-control credential required by a coding service must be granted explicitly and narrowly by local tool configuration; stored operator-home coding-tool credentials are not made visible as a convenience;
- project/candidate bytes are writable proposal state, but authoritative `.git` / linked-worktree administrative state is read-only or unreachable from the worker;
- control-plane Git operations, state persistence, GitHub status/publication, and daemon control execute outside this worker boundary;
- worker-visible candidate state is poller-owned disposable/reconstructable state. A worker never receives authority merely because it can edit those bytes.

#### Worker IPC ownership

Worker context/result exchange is **control-plane state**, not a reserved project directory.

For every run/turn PATCH-POLLER creates a private exchange root under the configured state directory with exclusive run/turn ownership. The control-only manifest binds the exact run/turn to the context/result file identities and the SHA-256 of the context bytes. That manifest and mailbox root are never exposed to the worker.

Only two exact endpoints are projected into the worker namespace:

- the pre-created context file, read-only;
- the pre-created result file, writable in place.

The worker is instructed to overwrite the existing result file in place. It may not unlink, rename over, symlink, junction, or otherwise replace the mailbox object. Before privileged result consumption PATCH-POLLER revalidates the control-owned directory/file type, service ownership where the host exposes a UID, private permissions on POSIX, recorded filesystem identity, context digest, and bounded result size. Reads use no-follow semantics where the platform exposes them and verify the opened file identity again.

This means `.patch-poller/<run>/<turn>` inside the proposal tree is not an IPC security mechanism and need not exist. Project cleanup/Git exclusion is independent of control-plane mailbox ownership.

## GitHub control-plane authentication

GitHub authentication is local control-plane authority. Repository content, issue text, model output, and coding-tool configuration cannot select a credential source or cause a credential to be copied into the worker environment.

The v0.1 control plane supports these local credential sources:

1. an explicit bounded list of environment-variable names, with the default precedence `PATCH_POLLER_GITHUB_TOKEN`, `GH_TOKEN`, then `GITHUB_TOKEN`;
2. when local policy uses `auto` or `github-cli`, the active credential already stored for the configured host by GitHub CLI, retrieved through `gh auth token --hostname <host>` with `shell: false`.

Rules:

- do not scan arbitrary environment-variable names looking for token-like values;
- do not read repository files, arbitrary home-directory files, shell history, or coding-tool state to discover GitHub credentials;
- environment-variable names are configuration; their values are secrets and are never serialized into config, run state, context capsules, diagnostics, or GitHub status;
- the GitHub CLI fallback is a local credential broker only; its token stdout is consumed by PATCH-POLLER and never forwarded to the coding tool;
- one resolved credential is shared by PATCH-POLLER's GitHub REST and controlled Git adapters for the process lifetime;
- resolved credential values are included only in the local redaction set before outbound reporting;
- `doctor` may report provider/source identity such as `GH_TOKEN` or `github-cli:github.com`, but never credential contents;
- remote tasks cannot reorder providers, add environment-variable names, select a GitHub CLI account, or enable a broader auth mechanism;
- future GitHub App authentication belongs behind this same local credential-provider boundary and must not weaken these rules.

## Network

Network access is a capability because it can fetch executable content and exfiltrate data. The policy model distinguishes denied, restricted/sandbox-enforced, and explicitly unrestricted profiles. Playwright/browser-capable profiles should be separately identifiable from ordinary local coding profiles.

Network policy should be phase-aware where practical. Provisioning, build/test, loopback browser testing, and publication do not require the same network authority. Arbitrary project/test code should not inherit publication credentials or broad network access merely because another phase needs them.

A worker network mode is usable only when the verified isolation provider can actually enforce the requested mode. The current Bubblewrap worker adapter enforces `deny` by retaining the unshared network namespace and supports explicitly `unrestricted` networking by sharing the host network namespace; a declared `restricted` mode fails closed until a provider can enforce a real restricted policy.

## Human decisions and hard gates

PP-007 defines checkpoints, decision boundaries, and hard gates. These mechanisms do not weaken this security policy.

A trusted human decision may authorize only effects whose decision class is already enabled by local policy. In particular:

- a remote comment cannot add a filesystem root, executable, environment secret, network capability, credential, or trusted actor;
- an approval cannot convert an unenforced sandbox claim into an enforced one;
- capability expansion beyond the active profile requires the local operator-policy mechanism, even if a maintainer requests it remotely;
- approval for a payload-sensitive effect must bind to the exact artifact/commit digest under PP-007;
- expired, stale, mismatched, or superseded approval has no effect.

Human attention is not itself a reason to halt safe work. While a checkpoint or decision is pending, PATCH-POLLER may continue reversible work that stays within the current capability envelope and does not cross the gated decision boundary.

## Secrets and reporting

Before data leaves the machine through GitHub status, checkpoint, decision request, or handoff comments:

- redact configured secret values;
- redact recognizable credential-token forms;
- redact additional locally configured sensitive patterns;
- strip unsafe control/terminal escape characters;
- bound output size;
- never include a complete process environment;
- avoid publishing machine-specific paths when a redacted/relative form is sufficient.

Raw local evidence may be retained under bounded poller-owned state policy, but credentials must not be intentionally recorded there either.

## Resource containment

Timeout, output limits, task concurrency, and context size are mandatory. Strong process-tree, CPU, memory, disk-growth, and network containment may require platform adapters beyond portable Node APIs; those gaps must be reported honestly rather than represented as enforced.

A timeout must attempt to terminate the whole managed process tree using the platform containment provider rather than assuming termination of the immediate child is sufficient.

## Recovery safety

Recovery code must not become a privileged bypass around normal safety rules.

- Do not blindly delete Git lock files because they appear stale.
- Do not destructively clean/reset an unmanaged checkout.
- Prefer replacing a disposable poller-owned worktree over uncertain repair of Git administrative state.
- Local repair agents remain proposal engines; they do not receive implicit authority to bypass path, file-class, test, or publication policy.
- Cleanup may delete only state whose PATCH-POLLER ownership and containment can be established.
- Interrupted worker mailboxes are reopened only from control-owned run/turn state; their manifest/file identities and unchanged context are revalidated before any result is treated as a proposal.
