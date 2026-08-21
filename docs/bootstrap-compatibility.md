# Stage 0 compatibility and installation identity

DevBridge has two different kinds of identity that must not be confused:

- **installation identity** answers “which local DevBridge installation is this?”;
- **runtime identity** answers “which exact DevBridge code is this installation currently running?”

A persistent project bridge may update through many runtime Git heads while remaining the same installation. Disposable test installations may run the same runtime head while remaining distinct installations.

## Human-facing installation tag

Stage 0 projects the existing canonical installation identity as a short path-free tag:

```text
DB-12HEXDIGITS
```

The tag is derived from the canonical installation-home identity using the same `devbridge/installation-v1` hash contract used by installation-wide supervisor ownership. It is stable for one installation and contains no filesystem path.

Consequences:

- the normal persistent project bridge keeps the same tag across runtime updates;
- a disposable test installation with a different home receives a different tag;
- Stage-0 status/output includes the tag;
- Stage 0 and supervised runtime processes use `DevBridge[DB-…]` as their process title when the platform exposes it;
- two processes showing the same tag intentionally refer to the same installation identity and are subject to the same singleton-owner rules.

The tag is an observability identifier, not authority. It does not replace the full installation identity, owner token/generation, runtime Git head, release signature, or activation evidence.

## Stage 0 compatibility protocol

The standalone launcher exposes a small integer compatibility protocol. Runtime packages declare the minimum Stage-0 protocol they require in package metadata.

Stage 0 checks the requirement before importing a managed runtime. Candidate validation checks it again before any candidate-controlled VM execution.

A runtime requiring a newer protocol fails closed with an operator-facing launcher-refresh diagnostic. Remote task/model/repository content cannot change the installed Stage-0 protocol or satisfy this gate.

Protocol changes should be rare. Ordinary runtime updates that remain compatible with the installed Stage-0 protocol do not require launcher replacement.

## Accepted-runtime selection

Stage 0 no longer assumes that the original `runtime` checkout is forever authoritative.

When `runtime-activation.json` records a terminal accepted state (`healthy`, `rolled-back`, or `candidate-failed`), Stage 0 verifies and imports that exact recorded current runtime. The runtime directory must remain inside the installation home and its exact Git head must match the journal.

An incomplete activation state such as `candidate-validated`, `drain-requested`, or `activating` is not silently resolved by falling back to an older checkout. Stage 0 fails closed so the interrupted transition can be reconciled explicitly.

## Status

After a protocol-1 launcher is installed, local status is available with:

```text
node <stage0-launcher> bootstrap-status
```

`--home` may be supplied when the installation does not use the default home.

The bounded projection includes:

- installation tag;
- Stage-0 protocol;
- activation state;
- exact accepted runtime head and package version;
- runtime minimum Stage-0 protocol;
- whether the selected runtime predates the compatibility protocol;
- any automatic rollback performed for a dead interrupted legacy migration.

It does not expose the installation path, credentials, owner token, signing material, VM/provider internals, or guest topology.

## One-time migration for pre-protocol development installations

A launcher/runtime installed before this compatibility mechanism cannot gain the mechanism retroactively. Such an installation may therefore need one explicit local Stage-0 refresh.

The migration command is intentionally limited to pre-protocol **development/testing** installations. Production recovery remains governed by the signed immutable release path.

Before migration, the replacement head must already have exact independent validation evidence appropriate to the migration. For the current development workflow that means exact source identity plus successful VM-isolated candidate/qualification evidence and hosted cross-platform regression evidence. The migration command does not manufacture or weaken candidate-validation evidence.

The operator then runs the refreshed local Stage-0 launcher with both exact identities:

```text
node <stage0-launcher> migrate-legacy-runtime \
  --expected-runtime-head <EXACT_CURRENT_40_HEX_HEAD> \
  --validated-candidate-head <EXACT_VALIDATED_CURRENT_MAIN_40_HEX_HEAD>
```

On PowerShell the command may be written on one line or with PowerShell continuation syntax.

The transition:

1. verifies the currently accepted legacy runtime exact head;
2. re-observes the fixed DevBridge repository `main` head and requires exact equality with the operator-supplied validated head;
3. creates a bounded Stage-0 transition journal;
4. materializes the exact replacement checkout into a separate Stage-0 candidate directory while the accepted bridge is still running;
5. verifies origin, clean checkout, exact head, expected runtime shape, and Stage-0 compatibility without importing candidate code;
6. requests cooperative stop through the accepted legacy runtime;
7. moves the exact legacy runtime aside as last-known-good rollback state;
8. moves the already-staged exact candidate into the canonical runtime location;
9. runs the new runtime `doctor` with updates disabled;
10. starts the new runtime with updates disabled for the migration launch;
11. restores the exact saved legacy runtime if migration health/start fails.

No repository-controlled code receives host execution authority from this path.

## Interrupted migration recovery

The Stage-0 migration journal binds the exact previous and candidate heads plus the local migration process.

- A second launcher does not take over a migration while its owning process is still live.
- If the migration process dies before acceptance, the next Stage-0 entry rolls back to the exact saved legacy runtime when a backup exists.
- If the interruption occurred before the old runtime moved, the staged candidate and stale journal are removed and the still-present accepted runtime remains authoritative.
- Missing/contradictory backup state fails closed rather than guessing.

The migration journal is not a second runtime authority store. Normal accepted-runtime authority remains `runtime-activation.json`; the Stage-0 journal exists only to make the pre-protocol compatibility crossing recoverable.

## Security boundary

Stage 0 remains repository-workflow and provider agnostic. It does not contain model adapters, GitHub task logic, repository execution, VM/provider management, guest bridge behavior, publication authority, or arbitrary executable selection.

Its compatibility duties are limited to fixed-repository Git materialization/shape checks, local protocol/version checks, exact runtime selection, explicit legacy transition bookkeeping, and transfer to the secure bootstrap.

Related contracts: DB-011 runtime supervision, DB-019 verification cost/evidence, DB-020 VM-only repository/candidate execution, and issue #153.
