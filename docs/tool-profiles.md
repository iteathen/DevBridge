# Local Tool Profiles

PATCH-POLLER does not hard-code one coding CLI. Local configuration defines tool profiles; GitHub task text may select only a profile name that already exists in that configuration.

A profile is **local authority**. Do not let a task or repository synthesize one.

## Profile fields

A v0.1 profile contains:

- `executable` — absolute path or executable name resolved from the PATCH-POLLER service account's `PATH`;
- `args` — static argv strings with optional structural placeholders;
- `inputMode` — `stdin-json`, `stdin-text`, `context-file`, or `none`;
- `timeoutMs` — bounded wall-clock runtime;
- `maxOutputBytes` — bounded stdout/stderr tail;
- `environment.pass` — explicit environment names inherited from PATCH-POLLER;
- `environment.set` — explicit static local values;
- `sandbox.enforcement` — `tool`, `os`, or `none`;
- `sandbox.outsideProjectRead` — declared `deny`, `allowlist`, or `readonly` behavior;
- `sandbox.outsideProjectWrite` — must normally be `false`;
- `sandbox.network` — declared `deny`, `restricted`, or `unrestricted` behavior.

Allowed argv placeholders are only:

- `{projectDir}`
- `{contextFile}`
- `{resultFile}`
- `{runId}`

Other braces in locally configured arguments are literal. A token such as `{instructions}` is rejected because remote free-form instructions must never become argv.

## Shell rule

PATCH-POLLER invokes workers with `shell: false`.

Do not configure `cmd.exe`, PowerShell, Bash, or another shell merely to make a package-manager shim work. Shell-like executables require an explicit unsafe local exception and should not be the normal bridge.

On Windows, many npm global commands expose a `.cmd` shim. Prefer the real executable or launch the package's JavaScript entry point with `node.exe` rather than inserting `cmd.exe /c` into the trust path.

## Codex profile pattern

The current OpenAI Codex npm package ships `@openai/codex/bin/codex.js`, which locates and launches the native Codex binary. Current `codex exec` supports a prompt from stdin; recent Codex versions require explicit `--sandbox workspace-write` rather than the removed legacy `--full-auto` behavior.

A Windows profile can therefore use the installed Node executable directly instead of `codex.cmd`:

```json
{
  "execution": {
    "enabled": true,
    "defaultTool": "codex",
    "maxConcurrentTasks": 1,
    "maxTurns": 8,
    "allowUncontainedTools": false
  },
  "tools": {
    "codex": {
      "executable": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "C:\\path\\to\\node_modules\\@openai\\codex\\bin\\codex.js",
        "exec",
        "--sandbox",
        "workspace-write",
        "-"
      ],
      "inputMode": "stdin-json",
      "timeoutMs": 2700000,
      "maxOutputBytes": 4194304,
      "environment": {
        "pass": ["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE", "CODEX_HOME"],
        "set": {}
      },
      "sandbox": {
        "enforcement": "tool",
        "outsideProjectRead": "readonly",
        "outsideProjectWrite": false,
        "network": "restricted"
      }
    }
  }
}
```

Replace paths with the installation owned by the PATCH-POLLER service account. On POSIX, the same pattern can use that account's absolute Node path and Codex package path.

`codex exec` is headless/non-interactive; PATCH-POLLER supplies the full context capsule on stdin. The capsule also tells compatible tools where they may write an optional `patch-poller/result-v1` envelope.

## Authentication and the dedicated service account

The safest practical v0.1 deployment runs PATCH-POLLER and the coding CLI as a dedicated unprivileged OS account whose home contains only the credentials/configuration needed for the coding tool.

Prefer the coding tool's normal authenticated service-account configuration over injecting a broad API key through `environment.pass`. Any secret deliberately inherited by the coding CLI must be assumed readable by that process; redaction is not a confidentiality boundary.

Do not pass the PATCH-POLLER GitHub token to the coding-tool profile. The GitHub/Git adapters own that credential separately.

## Sandbox declarations are not magic

In v0.1 a profile's sandbox object describes the enforcement expected from the configured tool/OS. PATCH-POLLER validates the declaration but does not yet create a universal OS filesystem/network sandbox around every CLI.

Therefore:

- run under a dedicated unprivileged account;
- use the coding tool's strongest suitable workspace sandbox;
- keep `outsideProjectWrite: false`;
- keep unrelated secrets/files out of that service account;
- treat network restrictions as real only when the tool or OS actually enforces them.

PP-003 and PP-008 define the stronger future sandbox/network phase requirements.

## Structured result protocol

A compatible worker may write JSON to the `resultFile` supplied in the context capsule:

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

Malformed structured output is a protocol failure rather than being silently ignored.
