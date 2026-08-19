# Local Tool Profiles

PATCH-POLLER does not hard-code one coding CLI. Local configuration defines proposal/model tool profiles; GitHub task text may select only a profile name that already exists in local policy.

A profile is **local requested behavior**, not proof that containment exists. Do not let a task/repository synthesize a proposal-worker profile, and do not treat a local declaration as observed enforcement.

Deterministic PP-013 operations are a separate preferred path. PP-015 dynamic `tool.*` onboarding also remains separate: it creates validated local deterministic-operation manifests, not arbitrary proposal-worker profiles.

## Profile fields

A current proposal-worker profile contains:

- `executable` — locally configured executable path/name resolved by PATCH-POLLER;
- `args` — locally configured static argv strings with only structural placeholders;
- `inputMode` — `stdin-json`, `stdin-text`, `context-file`, or `none`;
- `timeoutMs` — bounded wall-clock runtime;
- `maxOutputBytes` — bounded stdout/stderr capture;
- `environment.pass` — explicit environment names that may be inherited, still subject to mandatory control-credential stripping;
- `environment.set` — explicit static local values, still subject to mandatory control-credential stripping;
- `sandbox.enforcement` — a **tool-local declaration** (`tool`, `os`, or `none`) describing containment the profile/tool claims or expects to provide itself; it never verifies or supplies PATCH-POLLER's outer worker boundary;
- `sandbox.outsideProjectRead` — requested `deny`, `allowlist`, or `readonly` behavior;
- `sandbox.outsideProjectWrite` — outside-project write request; the current verified proposal-worker provider intentionally rejects this;
- `sandbox.network` — requested `deny`, `restricted`, or `unrestricted` behavior.

The declared `sandbox` object is not the enforcement result. Proposal-worker execution independently requires PATCH-POLLER to attach and verify its own outer OS isolation provider. Provider observations are the security boundary.

`sandbox.enforcement: "none"` is valid for a tool that does not self-sandbox. It does **not** authorize uncontained host execution: `ProcessRunner` still refuses proposal-worker launch without the verified outer provider.

PATCH-POLLER-owned built-in diagnostic profiles likewise do not become trusted merely from their own declaration. When a built-in profile executes through the proposal-worker path, the separately verified outer provider supplies containment.

## Allowed argv placeholders

Only these structural placeholders are accepted:

- `{projectDir}`
- `{contextFile}`
- `{resultFile}`
- `{runId}`

Other braces in local args are literal. A token such as `{instructions}` is rejected because remote free-form instructions must never become argv.

`{contextFile}` and `{resultFile}` are stable **worker-visible sandbox endpoints**, not host paths supplied by the task. Their host objects live in PATCH-POLLER control-owned state outside the proposal tree.

A tool must overwrite the pre-created result file in place. Unlinking, renaming over, symlinking, junctioning, or replacing the mailbox object is rejected. Before privileged result consumption PATCH-POLLER revalidates ownership/type/permissions/filesystem identity where available, unchanged context digest, no-follow/open identity, and result size.

## Shell rule

PATCH-POLLER invokes proposal workers with `shell: false`.

Do not configure `cmd.exe`, PowerShell, Bash, or another shell merely to make a package-manager shim work. Shell-like executables require an explicit unsafe local exception and are not part of the safe reference path.

On Windows, many npm global commands expose `.cmd` shims. Prefer the real executable or launch the package's JavaScript entry point with `node.exe` rather than inserting `cmd.exe /c` into the trust path.

## Current outer worker-isolation boundary

The verified built-in proposal-worker provider is Bubblewrap on Linux. PATCH-POLLER probes that provider before proposal-worker execution and fails closed when the boundary cannot be verified.

Windows remains useful for configuration, static/control-plane work, and tests that do not require untrusted execution, but a profile declaration does not enable proposal-worker execution there. A future Windows provider must pass an equivalent filesystem/network/control-state boundary probe before this changes.

For Linux Bubblewrap proposal workers:

- `network: "deny"` is enforced with an isolated network namespace;
- `network: "unrestricted"` is explicit and shares the host network namespace while retaining filesystem/control-state isolation;
- `network: "restricted"` currently fails closed because the built-in provider does not implement PATCH-POLLER's restricted-network contract;
- project proposal bytes are writable;
- authoritative `.git`/linked-worktree administration is read-only or unreachable from the worker;
- operator home, PATCH-POLLER control state, daemon authority, SSH/GitHub credential sources, and GitHub CLI credential storage are not exposed;
- configured external read roots are projected read-only only when the local profile/policy requests that external-read mode;
- outside-project writes are rejected before launch because the current provider has no such contract;
- worker HOME/TMP are synthetic/private.

The provider verification probe uses harmless PATCH-POLLER-created sentinels. It proves project/run-scratch writes work while arbitrary outside reads/writes, PATCH-POLLER control-state reads, Git-administrative writes, denied network egress, and retained effective capabilities do not. `doctor` reports sanitized boolean observations, never sentinel paths/contents.

## Control-plane credentials versus coding-service credentials

GitHub control-plane authentication never belongs in a proposal-worker profile.

PATCH-POLLER strips its GitHub token variables and Git/SSH askpass/agent control channels from worker environments even if a profile requests them, and the worker namespace does not expose GitHub CLI credential storage.

A coding service may still require its own credential. Grant only the narrow credential needed by that service through local configuration. Any secret deliberately inherited by the worker must be assumed readable by the worker and descendants. Do not expose broad operator-home credential stores for convenience.

Where possible, use a dedicated service credential with limited scope and keep the coding runtime separate from credential storage. Redaction is not a confidentiality boundary.

## Codex profile pattern

A networked coding CLI should be installed in a dedicated tool/runtime root that can be exposed read-only without exposing the operator home or unrelated credential stores.

Representative Linux shape:

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
    "modelAdaptersEnabled": true,
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

The outer verified Bubblewrap boundary is still mandatory even when Codex supplies a second inner workspace sandbox. `sandbox.enforcement: "tool"` records only that tool-side defense-in-depth expectation; PATCH-POLLER does not infer that the inner sandbox actually exists merely from this string.

`codex exec` is headless/non-interactive. PATCH-POLLER supplies the bounded context capsule through the configured transport and tells compatible tools where the optional structured result endpoint is projected.

Model adapters remain disabled by default in the reference configuration. Do not enable them when deterministic controller plans/operations are sufficient.

## Declaration, provider, and observed enforcement

Keep these concepts distinct in code, docs, inventory, and `doctor`:

1. **declared policy** — the local tool-profile `sandbox` object;
2. **configured enforcement provider** — the PATCH-POLLER-owned outer isolation implementation;
3. **verified observed enforcement** — provider admission result and boundary-probe observations.

A declaration alone never upgrades a profile to enforced or usable. Unsupported requested modes fail closed rather than silently degrading.

A tool's own sandbox remains useful defense in depth, especially for restricting what an agent chooses to execute, but it is not PATCH-POLLER's evidence that host control state is isolated.

## Workstation process priority

PP-018 applies below-normal OS priority by default to proposal/model child processes, using the actual spawned child PID before normal worker input proceeds.

The same priority policy is used for deterministic child operations. Supported internal levels are `normal`, `below-normal`, and `low`; elevated/unknown levels are rejected. If a requested non-normal priority cannot be applied, PATCH-POLLER terminates/fails the child instead of silently running it at normal priority.

Process priority is QoS, not a sandbox and not a hard CPU/memory/native-thread quota.

The current public profile schema does not make remote task text or repository content a priority selector. Resource governance remains local control-plane behavior.

## Structured result protocol

A compatible worker may overwrite the existing result endpoint with JSON such as:

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

A clean legacy worker exit without a result envelope may still be normalized by the current compatibility path, but structured output is strongly preferred because it preserves progress, tests, blockers, and bounded multi-turn intent across context resets.

Malformed structured output is a protocol failure rather than being silently ignored. A mailbox that was replaced, redirected, oversized, or whose control-owned context identity/digest changed is a security/policy failure before result parsing.

## Task authors do not configure tool authority

A trusted task actor may request an already locally configured `preferredTool`, but task trust is not tool/profile authority.

Do not add a profile, executable, credential, environment grant, filesystem root, or network mode merely because a trusted task author asks for it remotely. Those are local operator-policy changes. This remains true in multi-agent deployments: a PP-016 peer key/lease is coordination authority only.

## Dynamic `tool.*` operations are different

PP-015 can synthesize bounded deterministic operation wrappers only after local pre-authorization of an exact command/help probe and verified sandbox execution of that probe. Help/man/spec text is data; it cannot create executable/path/environment/network authority.

Generated manifests live under an operator-owned local manifest root, are persisted before registration, and execute as repository-code operations behind the verified sandbox.

Do not implement dynamic tool onboarding by mutating the proposal-worker profile set from repository/GitHub text.
