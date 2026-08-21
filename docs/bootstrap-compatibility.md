# Stage 0 compatibility and installation identity

DevBridge has multiple independent identities. Two are especially important during runtime updates and testing:

- **installation identity** answers “which local DevBridge installation is this?”;
- **runtime identity** answers “which exact DevBridge code is this installation currently running?”

A persistent project bridge may update through many runtime Git heads while remaining the same installation. Disposable test installations may run the same runtime head while remaining distinct installations.

Do not use runtime version/head as a substitute for installation identity, and do not use installation identity as proof of runtime version.

## Human-facing installation tag

Stage 0 projects the canonical installation identity as a short path-free tag:

```text
DB-12HEXDIGITS
```

For example:

```text
DB-7A41C0E25F19
```

The tag is derived from the canonical installation-home identity using the same `devbridge/installation-v1` hash contract used by installation-wide supervisor ownership.

Consequences:

- the normal persistent project bridge keeps the same tag across runtime updates;
- a disposable test installation with a different home receives a different tag;
- Stage-0 status/output includes the tag;
- Stage 0 and supported supervised processes use `DevBridge[DB-…]` as process title metadata where the platform exposes it;
- two processes showing the same tag intentionally refer to the same installation identity and are subject to the same singleton-owner rules.

The tag is observability only. It does not replace:

- the full installation identity;
- owner token/generation;
- exact runtime Git head;
- release signature/artifact digest;
- runtime activation evidence;
- execution-profile or task identity.

## Persistent versus disposable installations

The expected workstation pattern is commonly:

- one persistent DevBridge installation for normal project work;
- temporary/disposable DevBridge installations used for migration or qualification.

Each disposable installation must have its own installation home. Using another config file with the same home does not create another installation; it creates another contender for the same installation identity.

This distinction matters when several DevBridge processes are visible at once:

- **same `DB-…` tag** -> same installation ownership domain;
- **different `DB-…` tags** -> different installations;
- **same runtime head** does not imply same installation;
- **different runtime heads** may still belong to the same installation before/after update.

See [`operations.md`](operations.md) for the operator runbook.

## Stage 0 compatibility protocol

The standalone launcher exposes a small integer compatibility protocol. Runtime packages declare the minimum Stage-0 protocol they require in package metadata.

Current launcher protocol:

```text
1
```

Stage 0 checks the runtime requirement before importing a managed runtime. Candidate validation checks compatibility again before candidate-controlled VM execution.

A runtime requiring a newer protocol fails closed with an operator-facing launcher-refresh diagnostic. Remote task/model/repository content cannot change the installed Stage-0 protocol or satisfy this gate.

Protocol changes should be rare. Ordinary runtime updates that remain compatible with the installed Stage-0 protocol do not require launcher replacement.

## Accepted-runtime selection

Stage 0 does not assume the original canonical `runtime` checkout is forever authoritative.

When `runtime-activation.json` records a terminal accepted state such as:

- `healthy`;
- `rolled-back`;
- `candidate-failed`;

Stage 0 verifies and imports the exact recorded current runtime. The runtime must remain inside the installation home and its exact Git head must match the journal.

An incomplete activation state such as:

- `candidate-planned`;
- `candidate-validated`;
- `drain-requested`;
- `activating`;

is not silently resolved by falling back to an older checkout. Stage 0 fails closed so the interrupted transition can be reconciled explicitly.

## `bootstrap-status`

After a protocol-1 launcher is installed, local status is available with:

```text
node <stage0-launcher> bootstrap-status
```

Supply `--home <installation-home>` for a non-default installation.

The final JSON line uses:

```text
devbridge/stage0-status-v1
```

and includes bounded fields for:

- `installationTag`;
- `stage0Protocol`;
- any `migrationRecovery` performed during entry;
- `activationState`;
- exact accepted runtime `head`;
- package `version`;
- runtime `minimumStage0Protocol`;
- whether the selected runtime is a pre-protocol legacy runtime.

It intentionally does not expose installation paths, credentials, owner tokens, signing material, VM/provider internals, or guest topology.

For update/recovery questions, capture this projection before mutating the installation.

## Why a pre-protocol installation may need one explicit launcher refresh

An immutable launcher/runtime already deployed before this compatibility mechanism cannot acquire code it never shipped.

Therefore an old development/testing installation may require **one explicit local Stage-0 refresh** to cross from the pre-protocol runtime into protocol-1 runtime supervision.

After that crossing, ordinary compatible runtime updates should not require repeated manual launcher replacement merely because the accepted runtime changes.

Production recovery remains governed by the signed immutable release path and must not use the development legacy-migration command as a trust bypass.

## Preconditions for one-time legacy migration

The replacement exact head must already have independent validation evidence appropriate to the migration.

For the current development workflow that means, as applicable:

- exact candidate/source identity;
- successful VM-isolated candidate/qualification evidence;
- hosted Windows/Linux regression evidence;
- any additional real-provider/security evidence required by the changed boundary.

The migration command does not create, substitute for, or weaken candidate-validation evidence.

Record both exact 40-hex heads before migration:

1. the currently accepted legacy runtime head;
2. the independently validated replacement head.

Then run the refreshed launcher with both exact identities:

```text
node <stage0-launcher> migrate-legacy-runtime \
  --expected-runtime-head <EXACT_CURRENT_40_HEX_HEAD> \
  --validated-candidate-head <EXACT_VALIDATED_CURRENT_MAIN_40_HEX_HEAD>
```

PowerShell may use one line or PowerShell continuation syntax.

## Actual legacy-migration sequence

The merged protocol-1 implementation performs this sequence:

1. verifies the selected accepted runtime is a pre-protocol runtime in the canonical legacy location;
2. requires its exact head to equal `--expected-runtime-head`;
3. re-observes the fixed DevBridge repository `main` head and requires exact equality with `--validated-candidate-head`;
4. creates an exclusive bounded `devbridge/stage0-migration-v1` transition record;
5. clones/materializes the replacement into a separate Stage-0 candidate directory while the accepted bridge is still live;
6. verifies fixed origin, clean checkout, exact head, expected runtime shape, and Stage-0 compatibility **without importing candidate runtime code**;
7. imports the already-accepted legacy bootstrap only to request cooperative stop of the current installation owner;
8. refuses migration if the legacy runtime does not stop cooperatively;
9. moves the exact accepted legacy runtime aside as last-known-good rollback state;
10. moves the already-staged exact candidate into the canonical runtime location;
11. verifies the migrated checkout still has the exact validated head and expected shape;
12. imports the migrated runtime's narrow compatibility activation adapter;
13. delegates actual activation to that adapter, which reuses the secure supervisor `initialActivation` path;
14. the secure supervisor owns installation-wide ownership, health window, `doctor`, runtime-activation journal, rollback, and supervised-child behavior;
15. the temporary Stage-0 migration record remains until the managed activation path durably records the exact migrated runtime as `healthy`;
16. if managed activation fails before healthy acceptance, Stage 0 restores the exact saved legacy runtime.

The important ownership split is:

- **Stage 0** owns compatibility detection, exact staging/switching, and crash-recoverable transition bookkeeping;
- **secure managed bootstrap/supervisor** owns runtime health acceptance and normal activation authority.

Stage 0 does not create a parallel health authority.

## Successful migration evidence

Do not call migration complete merely because the candidate process started.

Require at least:

- the installation tag is unchanged;
- exact accepted runtime head equals the validated replacement head;
- `activationState` is `healthy`;
- runtime minimum Stage-0 protocol is compatible;
- the Stage-0 migration marker is absent;
- last-known-good legacy runtime was retained through the health transition;
- the original failing product path is rerun and passes.

For a stale result-channel installation, for example, a deterministic VM canary may prove supervisor migration mechanics but the model-result acceptance must still be rerun through the actual model adapter path.

## Interrupted migration recovery

The Stage-0 migration record binds the exact previous and candidate heads plus the local migration process.

### Recorded process still live

A second launcher does not take over the migration. A live PID is treated as live/ambiguous ownership and fails closed, including PID-reuse ambiguity.

### Recorded process dead

On the next Stage-0 entry:

- if the exact legacy runtime had already moved and a valid backup exists, restore it;
- if the old runtime never moved, keep the still-present accepted runtime and remove exact staged candidate residue;
- remove only exact migration-owned retry residue;
- contradictory/incomplete backup state fails closed rather than guessing.

The temporary migration record is not a second accepted-runtime authority store. Normal accepted-runtime authority remains `runtime-activation.json`.

## Security boundary

Stage 0 remains repository-workflow and provider agnostic. It does not contain:

- coding/model adapters;
- GitHub task workflow logic;
- repository execution;
- VM/provider management;
- guest bridge behavior;
- publication authority;
- arbitrary executable selection.

Its compatibility duties are limited to:

- fixed-repository Git materialization/shape checks;
- local protocol/version checks;
- exact accepted-runtime selection;
- explicit legacy-transition bookkeeping/recovery;
- transfer to the secure managed bootstrap.

Remote task/model/repository content cannot select migration heads, installation home, update repository, signing key, runtime path, executable, provider, or recovery policy.

Related contracts:

- DB-011 — runtime supervision/update/rollback;
- DB-019 — verification cost, liveness, timing, evidence reuse;
- DB-020 — VM-only repository/candidate execution;
- issue #153 — stale installed-runtime compatibility escape path.
