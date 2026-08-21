# DevBridge troubleshooting guide

This guide maps symptoms to the DevBridge boundary that owns them. The objective is not merely to make the error disappear; it is to identify **which authority/state is wrong, what evidence proves that, and what the next safe action is**.

Start with [`operations.md`](operations.md) if you are not sure which local DevBridge installation or runtime you are observing.

## First response to any failure

Before changing configuration or restarting anything, capture bounded identity/state evidence:

1. installation tag (`DB-…`);
2. Stage-0 protocol;
3. accepted runtime exact Git head;
4. activation state;
5. relevant supervisor/daemon status;
6. repository-execution readiness/profile identity if the failure involved repository code;
7. exact task/run identity if one exists;
8. exact error class/message without secrets or unnecessary host paths.

For a protocol-1 launcher:

```text
node <stage0-launcher> bootstrap-status
node <stage0-launcher> doctor
```

Do not treat a current repository task baseline as proof that the installed outer runtime is current.

## Symptom map

| Symptom | Owning boundary | First safe action |
| --- | --- | --- |
| New runtime says Stage 0 is too old | Stage-0 compatibility | Refresh the minimal launcher; do not run candidate code directly |
| `activation` is incomplete (`candidate-validated`, `drain-requested`, `activating`) | Runtime supervision/reconciliation | Preserve journal and reconcile; do not fall back to an older checkout by guess |
| Task workspace is current but outer behavior is old | Installed-runtime adoption | Compare `bootstrap-status` runtime head with intended head |
| `/output/ports/result` missing on model task | Work-result channel / possibly stale installed runtime | Confirm runtime head first; do not teach the model guest bridge paths |
| Repository execution unavailable | VM route/profile readiness | Inspect provider/image/profile/workspace/bridge readiness; no host fallback |
| Hyper-V reports insufficient RAM/resources | Profile resource admission | Treat as physical profile capacity; stop/reduce unneeded profile use or adjust approved profile policy |
| Candidate validation appears hung/slow | Verification timing/liveness | Inspect operation-specific deadline/liveness; do not apply one global short timeout |
| `restart` says another supervisor owns installation | Supervisor/control routing | Do not launch a competing owner; observe exact owner and use supported control path |
| Migration journal exists after process death | Stage-0 migration recovery | Re-enter Stage 0 and let exact bounded recovery reconcile; do not delete the journal manually |
| Another live migration PID is recorded | Migration ownership | Fail closed; do not steal/take over the migration |
| Guest can reach network | Expected DB-020 model | Ensure host secrets are absent; network denial is not the primary confidentiality boundary |
| Guest build/test succeeds but publication fails | Host Git/publication authority | Inspect baseline/head/lease/gate/remote predecessor evidence; guest Git is not authority |
| Repeated GitHub/API failures | External-effect/rate-budget layer | Respect retry/reset/`Retry-After`, observe before retrying mutations |

## 1. Installed runtime is stale even though tasks use current `main`

### Typical evidence

- a task starts on a recent `main` baseline;
- the same installation continues showing behavior known to exist only in an older runtime;
- `bootstrap-status` reports an older accepted runtime head, or the pre-protocol launcher cannot report the new compatibility state.

### What this means

DevBridge has separate authorities for:

- repository/task baseline;
- installed Stage-0 launcher;
- accepted outer runtime.

A current task checkout proves only the first.

### Safe response

1. identify the installation tag/home you intend to repair;
2. observe the actual accepted runtime head;
3. determine whether the launcher/runtime compatibility protocol can perform ordinary update;
4. if it is a pre-protocol development installation, use the documented one-time compatibility transition only after the replacement exact head has independent validation evidence;
5. rerun the original failing path after activation.

Do **not** overwrite the managed runtime directory with current `main` while the accepted supervisor is live.

## 2. Model/task fails with missing `output/ports/result`

A failure such as:

```text
ENOENT ... output/ports/result
```

must not be "fixed" by instructing the model or repository guest to create DevBridge's physical bridge path.

The work/result protocol belongs above the generic repository-execution boundary. A model task that returns a valid bounded stdout result should not need to know a host/guest physical result mailbox path unless its profile explicitly declared a required output artifact contract.

### Diagnose

1. compare the installed outer runtime exact head with the head containing the result-channel fix;
2. determine whether the profile explicitly requested a result file or uses stdout result emission;
3. preserve fail-closed behavior for explicitly required output artifacts;
4. reject ambiguous dual result channels rather than picking one arbitrarily.

If the source fix is merged but the installed outer runtime is old, the problem is runtime adoption—not the guest task.

## 3. Repository execution is unavailable

### Expected rule

Repository-controlled code executes only through an admitted persistent VM route.

There is no safe automatic fallback to:

- direct host process execution;
- legacy Bubblewrap execution;
- AppContainer/ProcessContainer compatibility;
- `allowUncontainedTools`.

### Diagnose in layers

Check separately:

1. host provider foundation;
2. immutable base image identity/readiness;
3. execution-profile environment state;
4. bridge readiness;
5. repository workspace route/readiness;
6. requested operation/profile compatibility.

A failure in one layer should not be reported as a generic repository failure.

## 4. Hyper-V/KVM profile cannot start because of resources

Example Windows symptom:

```text
Unable to allocate 4096 MB of RAM: Insufficient system resources exist to complete the requested service.
```

This is a host/profile resource-admission problem.

It is **not** evidence that:

- the repository is corrupt;
- a new repository VM should be created;
- repository execution should fall back to the host.

### Safe response

- inspect which execution-profile VMs are already active;
- distinguish persistent project profile environments from disposable test environments by installation/profile identity;
- release/stop disposable or unnecessary environments when safe;
- verify approved memory/vCPU policy and host reserve;
- retry only after capacity is actually available.

Because physical VMs are profile-owned, selecting many repositories should not multiply VM RAM demand by repository count.

## 5. Candidate validation is slow

Long-running verification is not automatically a hang.

DB-019 requires operation-specific timing policy. Current candidate validation deliberately distinguishes cheap preflight from the full regression suite; the latter has a much larger bounded hard ceiling.

### Diagnose

Ask:

- Which verification operation is active?
- What is its operation-specific hard deadline?
- When was last output/activity observed?
- Is the owned process still alive?
- Has the exact same candidate/evidence already passed and remained valid?

### Do not

- impose a universal 10-minute policy because most tests are short;
- restart a healthy long operation solely because it exceeded an arbitrary human expectation;
- rerun expensive evidence after restart if exact still-valid evidence can be reused.

## 6. Runtime activation is incomplete

Stage 0 may report an activation state such as:

- `candidate-planned`;
- `candidate-validated`;
- `drain-requested`;
- `activating`.

These are not accepted terminal states.

Stage 0 intentionally refuses to guess that an older checkout should run instead.

### Safe response

- preserve `runtime-activation.json`;
- inspect the durable transition evidence;
- determine whether the old daemon is still live, drained, or ambiguous;
- let the owning supervisor/recovery path reconcile exact state;
- use last-known-good only through the documented rollback path.

Deleting the activation journal converts useful evidence into uncertainty and is not a repair.

## 7. Stage-0 migration is interrupted

The one-time legacy migration has its own temporary transition record.

### If the recorded migration process is live

Do not take over. A live PID is treated as ownership/ambiguity and fails closed.

### If the recorded process is dead

On next Stage-0 entry, bounded recovery examines exact backup/runtime state:

- if the legacy runtime had moved, restore the exact saved legacy runtime;
- if it had not moved, retain the still-present accepted runtime and remove exact staged residue;
- contradictory/missing backup state fails closed.

The temporary migration journal is not a second accepted-runtime authority store.

## 8. Restart is rejected as a competing supervisor

The intended contract is that installation-level restart addresses the existing proven owner.

A current tracked defect (#150) covers cases where `restart` is routed as if it were a competing supervisor.

Until the installed runtime contains the fix for that path:

- do not defeat the singleton check;
- do not launch another supervisor with a different config path for the same installation home;
- observe `status`/installation identity first;
- if an explicit manual stop/start is required, preserve exact home/config identity and confirm the old owner has actually exited before start.

The workaround must not become architecture: same installation tag means same singleton ownership domain.

## 9. Guest network access looks surprising

DB-020 assumes a persistent guest may be fully compromised and normally networked.

The security boundary is therefore primarily:

> Keep host secrets and control authority out of the guest.

Do not "fix" network access by assuming network denial makes it safe to inject host GitHub tokens, SSH agents, release keys, coordination private keys, or provider credentials into the VM.

## 10. Guest result/test looks valid but host rejects it

This is often correct behavior.

Guest output is untrusted data. Host authority must still verify:

- run/task identity;
- repository/workspace/profile identity;
- source/candidate identity;
- allowed changed paths/bytes;
- lease/fence state;
- human decision state when applicable;
- verification evidence;
- publication baseline/remote predecessor.

A guest commit SHA or `tests passed` string is not final authority.

## 11. GitHub/API retry problems

DevBridge external effects must distinguish definite failure from ambiguity.

For reads/polling:

- respect server pacing;
- use conditional requests where supported;
- preserve reserve floors.

For mutations:

- record intent/expected state;
- attempt once;
- re-observe after ambiguous transport failure;
- reconcile the observed remote state before retry.

Repeated blind retries can duplicate or conflict with effects and are not recovery.

## 12. What evidence belongs in a bug report

Useful bounded evidence includes:

- installation tag;
- Stage-0 protocol;
- runtime exact head/version;
- activation state;
- host OS/architecture and Node version;
- provider/profile/workspace readiness state where relevant;
- task/run identity and exact baseline head;
- error class and bounded sanitized message;
- whether the failure occurred before execution, during VM execution, result collection, host verification, publication, or runtime activation;
- whether cleanup/recovery completed.

Avoid posting:

- tokens/credentials;
- signing/private keys;
- absolute home/workspace paths when a logical identity is sufficient;
- raw environment dumps;
- arbitrary guest/system file contents;
- provider-management commands that contain local secrets.

## 13. Recovery completion checklist

Before declaring a failure fixed, verify the same layer that failed originally.

Examples:

- runtime-adoption failure -> prove exact installed runtime head and rerun original task path;
- result-channel failure -> rerun the model/result path, not only a deterministic controller plan;
- VM resource failure -> prove the intended profile VM starts with observed capacity;
- supervisor transition failure -> prove real process/generation/journal ordering;
- publication ambiguity -> prove exact remote predecessor/result state;
- cleanup failure -> prove owned residue is absent.

A different test passing is supporting evidence, not necessarily acceptance evidence.
