# Local Tool Profiles

PATCH-POLLER does not hard-code one coding CLI. Local configuration defines tool profiles; GitHub task text may select only a profile name that already exists in that configuration.

A profile is **local authority** about what the operator requested. It is not proof that the requested containment exists. Do not let a task or repository synthesize one.

## Profile fields

A v0.1 profile contains:

- `executable` — absolute path or executable name resolved from the PATCH-POLLER service account's `PATH`;
- `args` — static argv strings with optional structural placeholders;
- `inputMode` — `stdin-json`, `stdin-text`, `context-file`, or `none`;
- `timeoutMs` — bounded wall-clock runtime;
- `maxOutputBytes` — bounded stdout/stderr tail;
- `environment.pass` — explicit environment names inherited from PATCH-POLLER, subject to mandatory control-credential stripping;
- `environment.set` — explicit static local values, subject to mandatory control-credential stripping;
- `sandbox.enforcement` — the profile's declared/expected `tool`, `os`, or `none` containment;
- `sandbox.outsideProjectRead` — requested `deny`, `allowlist`, or `readonly` behavior;
- `sandbox.outsideProjectWrite` — must normally be `false`;
- `sandbox.network` — requested `deny`, `restricted`, or `unrestricted` behavior.

The declared `sandbox` object is not the enforcement result. Proposal-worker execution additionally requires PATCH-POLLER to attach and verify its own OS isolation provider. The provider's observed status is the security boundary.

Allowed argv placeholders are only:

- `{projectDir}`
- `{contextFile}`
- `{resultFile}`
- `{runId}`

Other braces in locally configured arguments are literal. A token such as `{instructions}` is rejected because remote free-form instructions must never become argv.

`{contextFile}` and `{resultFile}` are stable **worker-visible sandbox endpoints**. Their host files live in control-owned state outside the proposal tree. A tool must overwrite the pre-created `resultFile` in place; unlinking, renaming over, symlinking, junctioning, or otherwise replacing that file is rejected by the control plane.

## Shell rule

PATCH-POLLER invokes workers with `shell: false`.

Do not configure `cmd.exe`, PowerShell, Bash, or another shell merely to make a package-manager shim work. Shell-like executables require an explicit unsafe local exception and should not be the normal bridge.

On Windows, many npm global commands expose a `.cmd` shim. Prefer the real executable or launch the package's JavaScript entry point with `node.exe` rather than inserting `cmd.exe /c` into the trust path.

## Current worker-isolation platform boundary

The verified outer proposal-worker provider is currently Bubblewrap on Linux. PATCH-POLLER probes that provider before repository-code or proposal-worker execution and fails closed when the boundary cannot be verified.

Windows remains useful for configuration, static/control-plane work, and tests that do not require untrusted execution, but a profile declaration does not enable proposal-worker execution there. A future Windows provider must pass an equivalent filesystem/network/control-state boundary probe before this changes.

For Linux Bubblewrap proposal workers:

- `network: "deny"` is enforced by the isolated network namespace;
- `network: "unrestricted"` is explicit and shares the host network namespace while retaining the filesystem/control-state boundary;
- `network: "restricted"` currently fails closed because Bubblewrap alone does not implement PATCH-POLLER's restricted-network contract;
- project bytes are writable, while `.git` administrative state is read-only or unreachable;
- the operator home, PATCH-POLLER state, daemon authority, and GitHub CLI credentials are not exposed;
- configured external read roots are projected read-only only for profiles that request an external-read mode.

## Codex profile pattern

A networked coding CLI should be installed in a dedicated tool/runtime root that can be exposed read-only without exposing the operator home or credential stores. For example, a Linux Codex installation can use an absolute Node executable plus a read-only package/runtime root configured in `workspace.externalReadRoots`.

Representative shape:

```json
{
  "workspace": {
    "root": "/srv/patch-poller/workspace",
    "externalReadRoots": [
      "/opt/patch-poller-tools/codex-runtime"
    ]
  },
  "execution": {
    "enabled": true,
    "defaultTool": "codex",
    "maxConcurrentTasks": 1,
    "maxTurns": 8,
    "allowUncontainedTools": false
  },
  "tools": {
    "codex": {
      "executable": "/usr/bin/node",
      "args": [
        "/opt/patch-poller-tools/codex-runtime/node_modules/@openai/codex/bin/codex.js",
        "exec",
        "--sandbox",
        "workspace-write",
        "-"
      ],
      "inputMode": "stdin-json",
      "timeoutMs": 2700000,
      "maxOutputBytes": 4194304,
      "environment": {
        "pass": ["OPENAI_API_KEY"],
        "set": {}
      },
      "sandbox": {
        "enforcement": "tool",
        "outsideProjectRead": "allowlist",
        "outsideProjectWrite": false,
        "network": "unrestricted"
      }
    }
  }
}
```

The outer verified Bubblewrap boundary is still mandatory even when Codex also supplies its own workspace sandbox. `sandbox.enforcement: "tool"` records that tool-side defense-in-depth expectation; it does not replace PATCH-POLLER's verified provider.

`codex exec` is headless/non-interactive; PATCH-POLLER supplies the full context capsule on stdin. The capsule also tells compatible tools where they may write an optional `patch-poller/result-v1` envelope.

## Authentication and the dedicated service account

GitHub control-plane authentication never belongs in the coding-tool profile. PATCH-POLLER strips its GitHub token variables and SSH/askpass control channels from worker environments even when a profile asks to inherit them, and the worker namespace does not expose GitHub CLI credential storage.

A coding service may still require its own credential. Grant only the narrow credential needed by that coding service through local configuration, and assume any secret deliberately inherited by the worker can be read by that worker and its descendants. Do not expose a broad operator home merely to make a CLI find cached authentication.

Where possible, use a dedicated service credential with limited scope and keep the coding runtime separate from credential storage. Redaction is not a confidentiality boundary.

## Declaration versus verified enforcement

Three concepts must remain distinct:

1. **declared policy** — the local tool-profile `sandbox` object;
2. **configured provider** — the OS/tool isolation implementation PATCH-POLLER intends to use;
3. **verified enforcement** — the result of the provider's boundary probe and the evidence attached to the actual launch.

A declaration alone never upgrades a profile to enforced. `ProcessRunner` refuses proposal-worker execution without a verified provider, and the provider independently applies the filesystem/network/IPC boundary. Unsupported requested modes fail closed rather than silently degrading.

The coding tool's own sandbox remains useful defense in depth, especially for restricting what the agent chooses to execute, but PATCH-POLLER does not treat a self-declared tool profile as proof that host control state is safe.

## Structured result protocol

A compatible worker may overwrite the existing `resultFile` supplied in the context capsule with JSON:

```json
{
  "protocol": "patch-poller/result-v1",
  "status": "complete",
  "summary": "Implemented and tested the requested change.",
  "progress": ["Updated parser", "Added regression tests"],
  "tests": [
    { "command": "npm test", "status": "pass" }
  ],
  "nextStep": null
}
```

`status` may be `complete`, `continue`, `blocked`, or `failed`.

A legacy CLI that exits successfully without a result envelope is accepted as an inferred completion in v0.1; PATCH-POLLER still independently inspects/seals the resulting Git candidate. Structured output is strongly preferred because it preserves progress, tests, blockers, and multi-turn intent across context resets.

Malformed structured output is a protocol failure rather than being silently ignored. A mailbox that was replaced, redirected, oversized, or whose control-owned context identity/digest changed is a security/policy failure before result parsing.
