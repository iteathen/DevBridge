# Ubuntu physical image construction gate

The supported Ubuntu production-image workflow keeps observation and mutation separate even though both are composed behind the public setup owner.

## Read-only setup gate

`devbridge setup` remains the ordinary setup/re-entry command. It derives and verifies the setup-owned Ubuntu source, package, payload, signing, provider, storage, memory, and tooling authority, then invokes only the physical canary `status()` surface.

A successful read-only gate reports:

```text
DevBridge setup reached the construction gate.
```

That result authorizes construction but does not construct an image or VM.

On supported Windows workstations, the construction-only adapter does not create a switch, gateway, or WinNAT object. It read-only verifies Hyper-V's exact Windows-managed Default Switch identity and compatible internal-switch type, then reports automatic guest addressing. The setup handoff makes that limited dependency visible as:

```text
Physical construction connectivity: verified host-managed DHCP; not claimed as DevBridge-owned network state
```

This path requires the operator to have the bounded Hyper-V VM-management authority already granted by local workstation policy, but it does not require an Administrator token merely to create custom NAT state. DevBridge must not rename, modify, remove, or claim ownership of the Windows-managed switch. If its exact identity or type is unavailable, the gate fails closed instead of selecting a similarly named switch or falling back to host networking mutation.

This is a construction-only topology. It does not satisfy or replace the persistent DevBridge-owned network readiness required for repository environments. That separate provider-foundation boundary remains responsible for owned object identity, collision policy, reconciliation, and cleanup.

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

## Address discovery and connectivity authority

The Ubuntu installer requests IPv4 through DHCP on the construction-only network. After installed boot, the Hyper-V adapter re-observes the exact owned disposable VM, exact attached system-switch identity, and one unambiguous private IPv4 address reported through Hyper-V integration services. The image therefore includes the snapshot-pinned `linux-cloud-tools-virtual` package and qualifies `hv_kvp_daemon`; SSH still requires the separately pinned host-key evidence before guest qualification begins.

No address is inferred from a mutable switch name, a guessed subnet, or unrelated VM state. No address yet reported is a durable waiting frontier. Multiple private addresses, changed VM ownership, changed provider identity, or changed switch binding fail closed.

## Distribution authority

Installing additional packages and preconfiguring the resulting VHDX makes it a modified Ubuntu image under Canonical's published examples. Canonical's policy permits personal/internal modification but places additional conditions on redistribution of modified Ubuntu associated with Ubuntu trademarks. Consequently, local construction and qualification do not authorize public artifact publication.

Do not upload or publish the constructed VHDX, its compressed bundle, or its chunks until the project has documented an applicable redistribution basis. The current fail-closed options are explicit Canonical approval/certification/provision under an appropriate agreement, or a separately approved unbranded rebuild that satisfies every component license and trademark requirement. Shipping unmodified Canonical installation media plus local reconstruction is a distinct architecture and does not silently satisfy issue #197's current exact canonical-image publication/reacquisition acceptance.

Primary references:

- [Microsoft: Set up a NAT network](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/setup-nat-network)
- [Microsoft: Hyper-V integration services](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/integration-services)
- [Microsoft: Hyper-V data exchange](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/integration-services-data-exchange)
- [Canonical intellectual property rights policy](https://canonical.com/legal/intellectual-property-policy)
- [Canonical embedding and redistribution FAQ](https://canonical.com/embedding/faqs)

## Scope

This command authorizes only the Ubuntu production-image canary owned by the current accepted setup authority. It does not by itself authorize unrelated VM lifecycle changes, repository execution, Windows image construction, artifact publication, publication policy changes, or bypasses of later publication/reacquisition and environment-readiness gates.
