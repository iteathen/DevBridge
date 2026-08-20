# VM Stage 1 connection map and sandbox-removal evidence

Status: Stage-1 implementation record for DB-020 / issue #109.

## Governing LEGO rule

A LEGO owns its vocabulary. Public inputs, outputs, dependency roles, and status objects describe that LEGO's domain, not the implementation or neighboring LEGO currently attached to it.

For repository execution this means the stable concept is **repository execution**. Hyper-V, libvirt/QEMU, a fake, or any other future implementation attaches behind that contract. Generic callers do not name those implementations, their transport, their disk format, or their environment-local paths.

## Stage-1 attachment surface

`src/runtime/repository-execution.js` is the bounded attachment surface for later stages.

A production implementation must provide only:

- `inspect()` -> `devbridge/repository-execution-status-v1`;
- `execute(request)` -> `devbridge/repository-execution-result-v1`.

The request owns these execution-domain concepts:

- exact repository identity (`repository`, optional immutable `repositoryId`) and `runId`;
- a logical operation identity;
- a logical tool identity rather than a host executable path;
- environment-relative working directory;
- bounded literal/input/output argument references;
- explicit environment values, never inherited host environment selection;
- input/output transfer **ports** (`read()` / `write()`), not host paths, guest paths, mounts, sockets, or mailbox objects;
- timeout/output bounds;
- stdin, cancellation signal, and activity callback.

The result owns only normalized command/result semantics plus an execution identity and the exact scope. It does not carry Hyper-V, libvirt, QEMU, Bubblewrap, AppContainer, filesystem-layout, or bridge-transport vocabulary.

Stage 2 may add provider/image/lifecycle implementation behind this surface, but must not require controller/Git/recovery/verification modules to name provider details.

## Exact current dependency classification

| Current symbol/file | Classification | Stage-1 disposition |
| --- | --- | --- |
| `src/runtime/bubblewrap-sandbox.js` | provider-local detail | deleted from active tree |
| `src/runtime/bubblewrap-probe.js` | provider-local detail | deleted from active tree |
| `src/runtime/deterministic-sandbox.js` | provider-selection leak | deleted from active tree |
| `src/runtime/sandbox-status.js` | provider/status leak | deleted from active tree |
| `DeterministicProcessRunner` host capture/timeout/cancel/process-tree behavior | generic retained behavior | retained for control/static host work |
| `DeterministicProcessRunner` repository-code -> host prepared spawn | implementation leak | replaced by repository-execution delegation |
| `ProcessRunner` result parsing/recovery | generic retained behavior | retained |
| `ProcessRunner` sandbox provider/read roots/prepared host spawn | implementation leak | removed; worker execution delegates to repository execution |
| `WorkerExchange` exact run/turn identity, digest, replacement/TOCTOU checks | valid input/result stud | retained |
| guest/sandbox fixed IPC paths and `sandboxIpc()` | transport leak | replaced by input/output transfer ports |
| deterministic operation classification | valid execution-request stud | retained with repository-execution vocabulary |
| sandbox-shaped operation readiness | implementation leak | replaced by `repositoryExecutionRequired` / `executionRequirement` |
| tool inventory / doctor capability projection | generic retained behavior | consumes repository-execution status only |
| legacy profile `sandbox.*` declarations | deferred config compatibility | still parseable but no longer grant execution authority; Stage 8/9 owns migration/removal |
| `workspace.externalReadRoots` repository semantics | deferred config compatibility | no active repository execution effect in Stage 1 |
| `execution.allowUncontainedTools` | unsafe legacy capability if used as fallback | cannot bypass unavailable repository execution; Stage 8/9 owns key removal |
| authoritative Git/workspace manager | generic retained authority | unchanged and host-only |
| worker/result protocol meaning | generic retained behavior | retained; transport detached from host-sandbox paths |
| candidate static release/artifact verification | generic retained authority | retained |
| candidate-controlled host-sandbox execution | implementation leak | explicitly unavailable until Stage 6 |
| Bubblewrap/AppArmor CI provisioning | provider-local qualification | removed; replaced by no-provider/fake/LEGO gates |

## No-provider behavior

`src/app/runtime.js` composes `UnavailableRepositoryExecution` as the only production repository-execution implementation during Stages 1–5.

Consequences:

- repository-class deterministic operations fail before host process creation;
- proposal/coding workers fail before worker mailbox creation or host process creation;
- `allowUncontainedTools` cannot turn absence into host execution;
- host PATH/profile executable discovery is not treated as repository-environment readiness;
- candidate-controlled self-update tests do not run on the host;
- host-static/control operations remain usable when independently classified safe;
- doctor and inventory report repository execution `unavailable`, not a degraded/absent sandbox;
- existing control-owned result recovery remains available without executing code.

## Fake-provider proof

Stage-1 tests attach a fake through only `inspect()` and `execute()` and exercise:

- a deterministic repository operation;
- a worker execution with control-owned input/output transfer ports;
- normalized status/result evidence;
- rejection of provider/transport/path-shaped fields at the execution contract.

The fake is test infrastructure only. Production composition never selects it.

## Retained host authority

The following stay outside repository execution and remain authoritative:

- GitHub task/provenance/credential adapters;
- coordination keys and lease/fence state;
- authoritative Git/worktrees/baselines/candidate sealing/publication;
- hard-gate and human-decision state;
- durable run/recovery/checkpoint state;
- release/signature/artifact identity and activation journal;
- VM/provider management authority added by later stages.

No repository-execution implementation may absorb those responsibilities.

## Stage-2 gate

Stage 2 may begin only from a Stage-1 head where:

1. the active Bubblewrap/provider-selection runtime is absent;
2. production composition has no repository-execution implementation other than explicit unavailable state;
3. repository-class work cannot fall through to host `spawn()`;
4. fake-provider tests pass through the same public execution surface;
5. generic controller/Git/recovery/verification tests remain coherent;
6. doctor/CI truthfully report the no-provider interval.

Hyper-V and KVM/libvirt must attach behind `repository-execution.js`; adding either must not introduce provider-named inputs or outputs into unrelated LEGO contracts.
