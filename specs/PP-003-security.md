# PP-003 — Local Security and Capability Policy

Status: active

## Fundamental rule

Remote content can request work; it cannot grant machine authority.

## Filesystem

- Project writes are confined to a poller-managed project/worktree root.
- A remote task never supplies a local path.
- Containment checks must account for `..`, absolute paths, and symlink/junction escape where the platform exposes realpath information.
- PATCH-POLLER itself does not write outside managed state/workspace roots.
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

## Network

Network access is a capability because it can fetch executable content and exfiltrate data. The policy model distinguishes denied, restricted/sandbox-enforced, and explicitly unrestricted profiles. Playwright/browser-capable profiles should be separately identifiable from ordinary local coding profiles.

## Secrets and reporting

Before data leaves the machine through GitHub status or handoff comments:

- redact configured secret values;
- redact recognizable credential-token forms;
- strip unsafe control characters;
- bound output size;
- never include a complete process environment.

## Resource containment

Timeout, output limits, task concurrency, and context size are mandatory. Strong process-tree, CPU, memory, disk-growth, and network containment may require platform adapters beyond portable Node APIs; those gaps must be reported honestly rather than represented as enforced.
