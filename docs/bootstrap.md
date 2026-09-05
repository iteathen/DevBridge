# DevBridge bootstrap launcher

`devbridge.mjs` is the canonical stage-0 launcher for DevBridge on a machine with Node.js 22.16.0+ and Git.

Stage 0 is intentionally small. It establishes or selects the fixed managed DevBridge runtime needed to reach the secure bootstrap, enforces the Stage-0 compatibility boundary, and follows durable accepted-runtime identity. It does not replace the supervisor's candidate-validation, activation, rollback, or VM-provider authority.

For the shortest installation path, see `docs/setup.md`. For the compatibility protocol, installation tag, and one-time pre-protocol migration, see `docs/bootstrap-compatibility.md`.

## Stage-0 boundary

The downloaded launcher uses only Node.js built-ins plus the local `git` executable. It:

1. enforces the supported Node.js version;
2. parses only local bootstrap arguments needed to resolve the DevBridge home and Stage-0 compatibility/recovery commands;
3. defaults the home to `~/.devbridge`;
4. creates private bootstrap Git HOME/hooks directories;
5. suppresses inherited Git/SSH authority and interactive credential prompting;
6. on a fresh home, shallow-clones fixed `https://github.com/iteathen/DevBridge.git` `main` into the managed runtime;
7. on an existing home, reconciles any dead interrupted Stage-0 migration and selects the exact terminal accepted runtime from durable activation state when present;
8. verifies selected runtime origin, clean checkout shape, exact Git head, package identity, and Stage-0 compatibility requirement;
9. projects a path-free installation tag for operator/process observability; and
10. transfers control to the exact selected managed secure bootstrap.

Stage 0 does **not** update an existing accepted runtime merely because mutable `main` moved. Ordinary runtime updates remain behind DB-011's candidate-validation boundary. When the secure supervisor records a newer healthy accepted runtime, Stage 0 follows that exact durable runtime identity on later starts instead of reverting to the original checkout.

An incomplete activation journal is not silently resolved by loading older code. Stage 0 fails closed until the transition is reconciled.

`--no-update` requires an existing managed runtime; it cannot bootstrap an empty home.

### Exact installer repair for a blocked bootstrap selection

An interrupted zero-state installation normally resumes only through an argument-equivalent invocation. A different selector cannot replace the durable exact subject.

If the selected installer itself contains a proven defect that prevents its permanent-entry commit, a newer independently qualified exact installer may finish that existing selection through the explicit local repair form:

```text
<Node first-byte loader> \
  --ref <EXISTING_SELECTION> \
  --repair-selection-with <EXACT_INSTALLER_HEAD> \
  --install-only \
  --home <INSTALLATION_HOME>
```

This is not subject replacement. The existing selector and exact selected component remain authoritative. Only installer mechanics and the exact-source acquisition helper come from the separately named exact installer head; component bytes still come from the existing selected subject. Repair requires a pre-existing valid selection, refuses setup continuation, verifies the installed result committed that exact selected component, and clears the selection only after that commit. A missing, mismatched, failed, or differently committed selection remains durable and fail-closed.

After successful install-only repair, a separate ordinary bootstrap invocation may select another subject. Do not delete or edit `bootstrap/selection.json` manually.

## Stage-0 compatibility and installation tag

Stage 0 exposes a small integer compatibility protocol. Runtime packages declare the minimum Stage-0 protocol they require. Stage 0 checks the selected runtime before import, and candidate validation checks the same requirement before candidate-controlled VM execution.

A candidate/runtime requiring a newer launcher fails closed with an actionable local launcher-refresh diagnostic. Ordinary runtime heads that remain compatible with the installed Stage-0 protocol do not require repeated launcher replacement.

The canonical installation identity is also projected as a short path-free tag:

```text
DB-12HEXDIGITS
```

The tag identifies the **installation**, not the runtime version. A persistent project bridge therefore keeps one tag across runtime updates, while a disposable test installation using a distinct installation home receives a different tag. Stage-0 output/status and supported process titles include this tag so concurrently observed DevBridge processes can be distinguished without exposing their filesystem paths.

The tag is observability only. It does not replace installation ownership proof, runtime Git head, release signature/digest, or activation evidence.

Local Stage-0 status is available after protocol 1 with `bootstrap-status`. Pre-protocol development/testing installations may use the explicitly guarded one-time `migrate-legacy-runtime` transition described in `docs/bootstrap-compatibility.md`. Production recovery remains subordinate to signed immutable release policy.

## What stage 0 does not authorize

The standalone launcher does not:

- enable repository execution;
- choose trusted task actors;
- enable model adapters;
- choose repository VM environments;
- install/configure Hyper-V, KVM, QEMU, or libvirt;
- create provider-managed VMs/domains/images/networks;
- expose host credentials to repository code;
- create publication authority;
- treat an installation tag as authority;
- bypass candidate validation for ordinary runtime updates;
- activate an unverified production runtime candidate.

Those remain secure-bootstrap/supervisor/local-policy concerns.

## Current execution-provider transition

DB-020 defines the target repository-code boundary: persistent untrusted VMs with two required initial host providers:

- Windows -> Hyper-V;
- Linux -> KVM/QEMU managed through libvirt.

Stages 0–6 are implemented on the VM migration stack.

- Stage 1 removed active host-sandbox repository execution on every host.
- Stage 2 implements the host management, immutable base-image, owned network, and owned storage foundation for both required provider families.
- Repository-code/candidate-controlled execution routes only through an admitted ready persistent environment; absence remains fail-closed on both Windows and Linux.
- Draft PR #106's ProcessContainer/AppContainer work is superseded by the VM program.

The completed Stage-1-through-Stage-5 interval kept untrusted execution unavailable/fail-closed. Stage 6 restores it through VM providers only; `docs/vm-stage6-repository-execution.md` defines the route and transfer contract.

The stage-0 launcher must not grow direct-host execution or provider provisioning logic merely because Stage 2 can observe/manage provider-local primitives. VM Stage 8 owns supported Windows/Linux provider setup/reconfiguration after lower provider/image/environment/bridge stages exist.

## Managed secure bootstrap

Managed bootstrap owns local initialization/update preparation, including:

- private DevBridge home/runtime/state/config locations;
- canonical config-example materialization on first install;
- repository/origin/runtime-shape verification beyond the minimal Stage-0 selection gate;
- update-policy selection from local configuration;
- candidate validation/activation and last-known-good behavior under DB-011;
- handoff to supervisor/CLI after local prerequisites are checked.

Existing operator configuration is not silently rewritten during self-update.

When VM support lands, bootstrap/setup may invoke separately owned provider setup/provisioning adapters, but repository/controller text never becomes Hyper-V/libvirt/QEMU/image/host-path authority.

## Runtime update authority

DB-011 remains normative.

The supervisor, not the standalone launcher, owns ordinary runtime update acceptance:

- development/testing versus production release policy;
- signed production release manifests/public keys;
- candidate repository/head/version/artifact identity;
- untrusted candidate execution admission;
- daemon drain;
- activation/health checking;
- last-known-good rollback.

Stage 0 owns only compatibility with that mechanism and the narrowly scoped, explicit transition needed by pre-protocol installations. A mutable branch is transport, not production release authority.

## Candidate-controlled validation

Before acceptance, candidate code is untrusted executable input.

The former host Bubblewrap candidate-validation path was removed in Stage 1 with the rest of the sandbox architecture.

Stage 6 restores candidate execution through the single locally admitted provider-native VM validation route. Missing route/provider/environment readiness remains unavailable/fail-closed. This does **not** weaken DB-011 release integrity: exact candidate identity, Stage-0 compatibility, signature/digest checks, last-known-good, activation gates, and rollback remain authoritative.

- Hyper-V validation environment on Windows hosts;
- KVM/QEMU/libvirt validation environment on Linux hosts.

VM validation sequence:

1. host/supervisor resolves the exact candidate subject and checks its Stage-0 compatibility requirement;
2. host/supervisor hashes the exact candidate artifact;
3. production signature/repository/head/version/digest checks occur on the trusted host before candidate code executes;
4. supervisor verifies the host provider + validation environment;
5. exact candidate subject is transferred into the untrusted VM without arbitrary host mounts or control credentials;
6. candidate-controlled preflight/tests execute there;
7. bounded evidence returns through the host-controlled bridge;
8. host rechecks exact candidate artifact identity;
9. only then may the supervisor drain/activate the candidate;
10. post-activation health/`doctor` remains separate acceptance evidence;
11. rollback keeps previous exact runtime available until candidate is healthy.

The candidate validation VM may be dedicated/reseedable instead of a persistent project VM as long as DB-020's trust partition is preserved.

Provider absence never authorizes direct/uncontained candidate execution on the host.

## Provider setup ownership

Stage 8 must keep provider setup separate from the minimal downloaded launcher.

Windows setup may discover/prepare DevBridge-owned Hyper-V images/environments without casually changing operator-owned Hyper-V infrastructure.

Linux setup may discover/prepare KVM/QEMU/libvirt images/environments without casually removing/changing shared libvirt services, domains, storage pools, networks, or system virtualization policy.

Provider readiness is observed, not inferred from installation/presence.

## Development/testing versus production

Development mode may follow the locally selected mutable testing channel as explicit alpha behavior.

Production requires an independently signed immutable release subject binding fixed repository identity, exact Git head, package version, and exact runtime artifact digest.

VM execution does not change those release-integrity rules. A guest test pass does not sign or approve a candidate.

During the no-provider interval, an executable candidate that cannot satisfy required validation remains unaccepted rather than being tested directly on the host.

## Daemon control

`status`, `pause`, `resume`, `stop`, and `restart` remain host control operations.

Pause is cooperative admission control, not OS thread/process/VM suspension. Stop has precedence over pause.

A provider/environment may persist while the daemon is paused/stopped; persistent repository disks are not cleanup side effects of daemon control.

## Trust-boundary summary

- Runtime repository identity is fixed in launcher/control code.
- Remote content cannot select release mode, update channel, signing material, runtime root, Stage-0 protocol/migration subject, host provider, base image path, VM/domain name, libvirt XML, QEMU argv, PowerShell management snippet, operator config, executable, environment authority, or credential source.
- Bootstrap Git suppresses inherited Git/SSH authority, hooks, interactive prompting, and dangerous transports.
- Operator config/activation/provider-management state remains outside untrusted candidate visibility.
- Installation tags are path-free observability projections, not capability or ownership credentials.
- No production execution provider means untrusted executable candidate/repository work is unavailable; it does not authorize direct host execution.
- Last-known-good is not drained until candidate passes pre-activation integrity + required verified execution-environment checks, except for the explicitly operator-authorized pre-protocol development migration whose exact replacement must already have independent validation evidence and is locally staged before drain.
- Development mutable-channel following remains explicitly alpha.
- Production unattended deployment requires an independently signed immutable release subject plus verified candidate VM isolation where executable candidate validation is required.

## Related docs/specs

- `docs/setup.md`: installation/current-vs-target behavior.
- `docs/bootstrap-compatibility.md`: Stage-0 protocol, installation tags, accepted-runtime selection, and pre-protocol recovery.
- `docs/architecture.md`: provider/VM/bridge/control-plane model.
- `docs/vm-migration.md`: sandbox-first removal/retention inventory.
- `docs/vm-lego-studs.md`: connection-stud/replaceability plan.
- DB-003: local capability/security authority.
- DB-008: Git/supply-chain boundary.
- DB-009: durable effects/recovery.
- DB-011: runtime supervision/release integrity.
- DB-013: deterministic controller plans.
- DB-018: workstation governance/pause.
- DB-020: persistent VM execution boundary.
