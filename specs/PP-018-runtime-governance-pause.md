# PP-018 — Workstation Resource Governance and Cooperative Pause

Status: active

Implementation status: implemented on current main: serialized task admission, below-normal child-process QoS, and token-bound cooperative daemon pause/resume at safe task-cycle boundaries.

## Goal

PATCH-POLLER is background automation. It must not monopolize an operator workstation, and an operator must be able to stop new background work quickly without destroying candidate worktrees, durable run state, lease evidence, or IPC recovery artifacts.

This contract specializes PP-004, PP-009, PP-011, and PP-016. It does not create a second scheduler, lease system, effect journal, or update lifecycle.

## Authority

Workstation governance is local control-plane policy.

Repository content, GitHub task/comment text, controller plans, tool output, and model output cannot pause/resume the daemon, select daemon control tokens, raise process priority, expand concurrency, or weaken PP-016 fencing.

## Serialized task admission

The current daemon/run-cycle architecture admits work serially. PATCH-POLLER executes at most one task/run continuation at a time in a daemon cycle.

`execution.maxConcurrentTasks` does not grant parallel execution authority. Until a future durable scheduler explicitly implements concurrent admission with independent lease/effect/liveness accounting, the effective task concurrency is one. Implementations must not create an ad-hoc worker pool merely to honor a larger configured number.

## Child-process priority

Model worker processes and deterministic operation processes use a lower workstation priority by default.

- The default child priority is `below-normal`.
- Supported internal policy levels are `normal`, `below-normal`, and `low`; elevated priority classes are deliberately unsupported.
- The priority is applied to the spawned child PID through the operating-system process-priority API before PATCH-POLLER writes operation input to the child.
- If a requested non-normal priority cannot be applied, PATCH-POLLER terminates that child/process tree and fails the operation rather than silently running it at normal priority.
- Result evidence records the requested priority level and whether it was applied.

Process priority is workstation QoS, not a security sandbox or a CPU quota. Node exposes the child PID only after process creation, so priority application is start-time enforcement rather than a portable pre-exec guarantee. PP-003/PP-012 sandbox requirements remain independent and authoritative.

PATCH-POLLER does not claim to cap arbitrary native thread counts, CPU percentages, or descendant memory through Node Worker `resourceLimits`. Those controls do not apply to arbitrary external child processes and require a separate verified OS resource-provider contract if added later.

## Cooperative pause semantics

`patch-poller pause` is an admission pause, not an unsafe operating-system process freeze.

A pause request:

1. binds to the exact current daemon lock token and PID;
2. may be written while a task cycle is active;
3. is acknowledged only after the active cycle reaches the existing daemon safe boundary;
4. prevents the next GitHub poll/task admission cycle from starting;
5. leaves the daemon process alive so local status, resume, stop, and PP-011 update-drain control continue to work;
6. preserves managed worktrees, run journals, worker IPC mailboxes, checkpoint state, and other PP-009 recovery evidence in place.

PATCH-POLLER does not use `SIGSTOP`, platform-specific thread suspension, or force-kill as the normal pause mechanism. Cross-platform process suspension would interfere with lease heartbeat/fencing and cannot safely preserve the distributed ownership guarantees in PP-016.

## Pause control records

The existing daemon singleton lock remains lifecycle authority. Pause/resume reuse its random lock token rather than introducing a second daemon identity.

For lock `<lockPath>` and token `<token>`:

- `<lockPath>.pause-<token>` is the operator's desired-pause request.
- `<lockPath>.paused-<token>` is the owning daemon's acknowledgement that it is currently at the paused safe boundary.

Both records include the exact lock token, owner PID, protocol identifier, and timestamp. A stale record for a prior token cannot control a replacement daemon.

`status` distinguishes:

- `pauseRequested: true, paused: false` — a request exists but the current cycle has not yet reached its safe boundary;
- `pauseRequested: true, paused: true` — the daemon has acknowledged the pause and will not start another cycle;
- both false — normal admission is allowed.

## Resume and stop precedence

`patch-poller resume` removes the desired-pause record only for the exact current lock token and waits for the owning daemon to clear its acknowledgement. If daemon ownership changes during the wait, the command fails closed instead of affecting the replacement owner.

`stop` has precedence over pause. A stop request observed while paused exits the pause wait, clears the pause acknowledgement during owner cleanup, follows PP-011 shutdown semantics, and releases only the current owner's lock/control files.

A signal-driven daemon shutdown also leaves the paused state through owner cleanup. Resume is not required before stop/update activation.

## GitHub and lease interaction

A fully paused daemon performs no routine GitHub polling or new task claiming. This preserves PP-004 rate-limit discipline.

A pause request arriving during an already-active task does not suspend that task's child process or lease heartbeat. The active bounded cycle reaches its existing safe boundary first, so PP-016 ownership and fencing remain valid. Lease loss during that cycle continues to abort/fence effects exactly as PP-016 requires.

Pause does not turn a retained `waiting-feedback`/`waiting-decision` worktree into disposable state. PP-009 cleanup/recovery rules continue to apply.

## Required tests

Tests must cover at least:

- pause request and acknowledgement bind to the exact current daemon lock token;
- status distinguishes requested versus acknowledged pause;
- a pause requested during daemon delay is acknowledged before another run cycle starts;
- no additional cycle occurs while the daemon remains paused;
- resume clears the pause and allows the next cycle;
- stop wins while paused and releases the lock without requiring resume;
- stale-token pause/resume state cannot control a replacement daemon;
- daemon lock release cleans only matching-token stop/pause/acknowledgement state;
- both model and deterministic child runners apply the requested below-normal/low OS priority to the actual spawned child PID;
- a failed requested priority change fails the child operation rather than silently degrading to normal priority;
- elevated/unknown process priorities are rejected;
- existing PP-011 supervisor stop/drain behavior and PP-016 lease fencing remain unchanged.
