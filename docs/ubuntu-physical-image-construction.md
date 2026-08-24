# Ubuntu physical image construction gate

The supported Ubuntu production-image workflow keeps observation and mutation separate even though both are composed behind the public setup owner.

## Read-only setup gate

`devbridge setup` remains the ordinary setup/re-entry command. It derives and verifies the setup-owned Ubuntu source, package, payload, signing, provider, storage, memory, and tooling authority, then invokes only the physical canary `status()` surface.

A successful read-only gate reports:

```text
DevBridge setup reached the construction gate.
```

That result authorizes construction but does not construct an image or VM.

## Development runner tracking

A development or qualification installation may explicitly persist a moving local runner branch once through the setup surface:

```text
devbridge setup --track-ref <branch>
```

The tracked branch remains local installation authority. The stable entry resolves it to one exact runner subject on each refresh, verifies the runner bytes before launch, records accepted current/previous development subjects, and can fall back to previously accepted development evidence when a refresh fails. An explicit exact-head installation remains exact-pinned instead of becoming a moving channel.

`--track-ref` changes only the installed control-plane runner selection. It does not grant VM/image construction authority. Setup continues through the same read-only physical status gate, and construction still requires the separate `--construct` option and a fresh unblocked status result.

An older exact-pinned qualification installation can adopt a tracked branch without repeating zero-state bootstrap. The existing permanent entry may use one explicit outer `--ref <branch>` to reach a runner that supports `--track-ref`; that same setup invocation persists the branch for subsequent ordinary `devbridge` commands.

## Explicit construction

After the read-only gate has been qualified on the physical host, the locally explicit construction surface is:

```text
devbridge setup --construct
```

The operator does not provide a canary JSON file, keyring path, snapshot, package pins, payload generation, provider object identity, or internal `src/entry/...` path. Setup re-derives the same accepted local authority and performs a fresh read-only canary status check first.

The construction boundary is crossed only when that status is neither blocked nor already complete. Setup then invokes the physical canary `run()` contract. The canary retains its own run lock, exact authority checks, bounded advancement, fail-closed provider checks, and durable journal.

Plain `devbridge setup` never crosses this boundary. Remote task content, repository issues, model output, or a pre-existing internal config file cannot turn a read-only setup invocation into construction authority.

## Re-entry and blockers

The physical canary is restartable. A construction invocation can finish, return a durable waiting frontier, or report a blocker.

- On completion, the canonical image has passed the canary's internal qualification boundary.
- On a waiting frontier, preserve the existing DevBridge-owned state, re-run plain `devbridge setup`, require the explicit construction-gate message, and only then re-run `devbridge setup --construct`; do not start a second independent construction path.
- On a blocker, stop at that boundary, fix only the owning blocker, re-run plain `devbridge setup`, and cross the mutation boundary again only after the explicit construction-gate message.
- Do not delete `run.lock` merely to force progress. Remove it only after independently confirming no physical canary operation is active and diagnosing stale-lock ownership.

The public setup surface deliberately does not expose the internal physical-canary `--config` entrypoint. That entry remains an implementation/testing boundary rather than a normal operator prerequisite.

## Scope

This command authorizes only the Ubuntu production-image canary owned by the current accepted setup authority. It does not by itself authorize unrelated VM lifecycle changes, repository execution, Windows image construction, artifact publication policy changes, or bypasses of later publication/reacquisition and environment-readiness gates.
