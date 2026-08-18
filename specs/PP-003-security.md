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
- Executable and static argv templates come only from local configuration.
- Allowed placeholders are structural values created by PATCH-POLLER (`projectDir`, `contextFile`, `resultFile`, `runId`).
- Free-form task text is never interpolated into argv.
- Shell-like executable profiles require an explicit unsafe/operator exception and are not provided by default.
- Environment inheritance is allowlist-based.
- GitHub credentials are not inherited by child tools automatically.
- stdout/stderr collection is bounded.
- Timeouts are mandatory.

`cwd` is not a sandbox. A coding-tool profile is executable only when local configuration identifies a real containment mechanism supplied by the tool or operating system, unless the operator explicitly enables an unsafe development override.

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
