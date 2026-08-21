# DevBridge operator runbook

This guide is for operating an installed DevBridge. It focuses on **what to observe before acting**, how to distinguish multiple local installations, and how to preserve the control-plane boundaries while diagnosing or recovering a runtime.

For installation/configuration, see [`setup.md`](setup.md). For failure-specific diagnosis, see [`troubleshooting.md`](troubleshooting.md). For normative runtime-update behavior, see DB-011 and [`bootstrap-compatibility.md`](bootstrap-compatibility.md).

## 1. Know which DevBridge you are touching

A workstation may legitimately run more than one DevBridge installation at the same time. The common case is:

- one **persistent** installation used for ongoing project work;
- one or more **disposable/test** installations created for qualification, migration, or integration testing.

These are not two "versions" of the same live process. They are distinct installations with independent ownership and state.

### Installation tag

Protocol-1 Stage 0 exposes a stable human-facing installation tag:

```text
DB-<12 uppercase hex digits>
```

Example:

```text
DB-7A41C0E25F19
```

The tag answers:

> Which local DevBridge installation is this process/status referring to?

It does **not** answer which code version is running.

Properties:

- one installation keeps the same tag across runtime updates;
- another installation home receives another tag;
- Stage-0 status and supported process titles include the tag;
- the tag contains no installation path;
- the tag grants no authority.

If two observed processes show the same tag, treat them as participants/contenders for the **same installation identity**. Do not assume they are harmless parallel test instances.

## 2. Keep identities separate

Before recovery or update work, record the relevant identities separately.

| Evidence | Question it answers |
| --- | --- |
| `installationTag` | Which installation? |
| `stage0Protocol` | Which launcher compatibility contract can this installation speak? |
| runtime `head` | Which exact DevBridge source is accepted/running? |
| runtime `version` | Which package version string? |
| `activationState` | What is the durable runtime-activation state? |
| runtime `minimumStage0Protocol` | What launcher protocol does the accepted runtime require? |
| supervisor/daemon owner generation | Which live process generation owns the installation? |
| execution profile/environment identity | Which persistent VM platform is used? |
| repository workspace identity | Which workspace inside that profile VM? |
| run/task identity | Which bounded task transaction? |

A task workspace being based on current `main` does **not** prove the installed outer runtime is current. Repository baseline identity and installed-runtime identity are separate authorities.

## 3. Stage-0 status first for runtime/update questions

For a protocol-1 launcher:

```text
node <stage0-launcher> bootstrap-status
```

Use `--home <installation-home>` for a non-default installation.

The final JSON line is the bounded Stage-0 projection. Current fields include:

```json
{
  "protocol": "devbridge/stage0-status-v1",
  "installationTag": "DB-7A41C0E25F19",
  "stage0Protocol": 1,
  "migrationRecovery": null,
  "activationState": "healthy",
  "runtime": {
    "head": "<40-hex commit>",
    "version": "0.1.0",
    "minimumStage0Protocol": 1,
    "legacy": false
  }
}
```

The projection intentionally omits installation paths, credentials, owner tokens, signing material, provider internals, and guest topology.

For update/recovery questions, save this evidence **before** changing anything.

## 4. Use `doctor` for observed capability state

Run:

```text
node <stage0-launcher> doctor
```

`doctor` is observation, not a capability grant. Read its output as separate layers:

- host prerequisites/provider foundation;
- image/profile environment readiness;
- bridge/workspace-route readiness;
- repository-execution readiness;
- tool/profile readiness.

Do not collapse "installed", "configured", and "ready" into one state.

Examples:

- Hyper-V being installed does not prove a ready Hyper-V execution route;
- `/dev/kvm` existing does not prove usable KVM/libvirt execution;
- a VM/domain existing does not prove DevBridge ownership or correct image lineage;
- `execution.enabled: true` does not make an unready execution profile usable.

## 5. Persistent and disposable installation rules

### Persistent installation

The normal persistent installation owns long-lived control-plane state. Treat it as durable infrastructure:

- do not point tests at its home accidentally;
- do not delete its runtime/activation state as a repair shortcut;
- do not overwrite its accepted runtime in place;
- do not start a second supervisor for the same installation tag;
- preserve last-known-good state through update transitions.

### Disposable installation

A disposable test installation must use a distinct installation home and therefore a distinct `DB-…` tag.

A test should:

1. create its own installation home;
2. keep repository execution disabled inside an inner runtime when the outer repository VM is already the isolation boundary;
3. use exact runtime/candidate identities;
4. stop all processes it owns;
5. remove its own state at completion;
6. prove the outer project/workspace has no unintended diff.

Do not simulate a disposable installation by reusing the persistent home with another config file. Installation identity is home-scoped, not config-file-scoped.

## 6. Repository execution ownership

The active topology is:

> **Execution profiles own persistent VMs. Repositories own isolated workspaces inside compatible execution-profile VMs.**

This means:

- repository count does not determine physical VM count;
- selecting `all` repositories does not mean "start one VM per repository";
- a memory/resource error on the physical profile VM is a profile/host-capacity problem, not evidence that a particular repository is broken;
- provider adapters should not need repository names;
- workspace operations must not reset/delete sibling workspaces unless the operator explicitly selected a profile-wide destructive action.

The guest is untrusted, including root/administrator. Authoritative Git, GitHub credentials, publication authority, runtime-control state, provider management, and signing/coordination secrets remain host-only.

## 7. Normal control commands

Canonical runtime control includes:

```text
devbridge doctor
devbridge poll-once
devbridge run-once
devbridge daemon
devbridge status
devbridge pause
devbridge resume
devbridge stop
devbridge restart
```

Additional handoff/context commands are documented in the bootstrap/runtime guides.

### Pause

`pause` is cooperative admission control at a safe task-cycle boundary.

It is **not**:

- `SIGSTOP`;
- thread suspension;
- VM suspension;
- permission to abandon lease/fence handling.

### Stop

`stop` has precedence over pause. It targets the proven installation owner and should preserve exact ownership semantics.

Never react to a stop/control failure by starting a second competing supervisor for the same installation.

### Restart

Restart is intended to cooperatively target the existing installation owner. If a runtime rejects restart as a competing supervisor, do not bypass singleton ownership; see [`troubleshooting.md`](troubleshooting.md) and the current tracked restart defect before using a manual stop/start recovery.

## 8. Runtime update model

Ordinary compatible update is owned by the secure supervisor, not by replacing the runtime checkout manually.

Conceptually:

```text
accepted runtime remains live
        |
        v
materialize separate candidate
        |
        v
static/integrity/compatibility checks
        |
        v
candidate-controlled validation inside admitted VM
        |
        v
cooperative drain of accepted daemon
        |
        v
activate exact validated candidate
        |
        v
health window + doctor
        |
        +-- success -> durable healthy
        |
        +-- failure -> preserve/restore last-known-good
```

Important rules:

- mutable `main` is not itself activation authority;
- candidate-controlled validation remains VM-only;
- the accepted daemon stays available during candidate validation;
- activation happens only after validation;
- last-known-good remains available until the new candidate is proven healthy;
- one slow verification operation must use its own bounded timing policy rather than a generic short global timeout.

## 9. Stage-0 compatibility gap

A runtime may require a newer Stage-0 protocol than the installed launcher supports. This is intentionally fail-closed.

A protocol mismatch means:

> Refresh the minimal local launcher before attempting to run the newer managed runtime.

It does **not** mean:

- execute candidate code directly on the host;
- fetch arbitrary helper code from task text;
- disable candidate validation;
- overwrite the accepted runtime in place.

See [`bootstrap-compatibility.md`](bootstrap-compatibility.md).

## 10. One-time legacy migration

Pre-protocol development/testing installations may need one explicit compatibility crossing after the replacement candidate has already been independently validated.

The migration command requires both exact heads:

```text
node <refreshed-stage0-launcher> migrate-legacy-runtime \
  --expected-runtime-head <EXACT_ACCEPTED_40_HEX_HEAD> \
  --validated-candidate-head <EXACT_VALIDATED_40_HEX_HEAD>
```

Do not guess either head from branch names or issue text. Record them from authoritative evidence.

The current implementation:

1. verifies the accepted legacy runtime exact head;
2. re-observes trusted DevBridge `main` and requires it to equal the validated candidate head;
3. journals the transition;
4. stages/verifies the replacement separately while the old bridge is still live;
5. cooperatively stops the old runtime;
6. preserves the exact legacy runtime as rollback state;
7. installs the staged exact candidate;
8. delegates activation to the managed compatibility adapter;
9. reuses secure-supervisor `initialActivation`, ownership, health-window, doctor, activation-journal, and rollback behavior;
10. removes the Stage-0 migration marker only after the exact migrated runtime has been durably accepted as `healthy`.

Production recovery remains governed by signed immutable release policy.

## 11. Evidence before closing a recovery

A recovery/update is not complete just because a process started.

For a runtime migration, require at least:

- expected installation tag remained the same;
- exact new runtime head is the intended validated head;
- durable activation state is `healthy`;
- runtime minimum Stage-0 protocol is compatible;
- no migration transition marker remains;
- old runtime rollback evidence was preserved through the health transition;
- runtime/control process is healthy;
- the original user-visible failure is rerun through the same real path and passes.

For repository-execution changes, additionally require appropriate provider/image/profile/workspace/bridge evidence under DB-020 and DB-019.

## 12. What not to do

Do not use these as recovery shortcuts:

- direct host execution of repository-controlled code;
- deleting an ambiguous activation/migration journal and "trying again";
- force-replacing a live accepted runtime;
- using a different config path to evade installation singleton ownership;
- treating guest Git as authoritative publication state;
- copying host GitHub/SSH credentials into a persistent guest;
- increasing every timeout globally because one legitimate operation is slow;
- creating one VM per repository to work around shared-profile routing problems;
- repeatedly retrying an ambiguous external mutation without first observing/reconciling state.

When state is ambiguous, preserve evidence and fail closed. The troubleshooting guide maps common symptoms to the owning boundary and next safe action.
