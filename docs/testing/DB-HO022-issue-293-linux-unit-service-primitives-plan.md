# DB-HO022 — issue #293 Linux unit/service primitives

Status: planned from exact `cuda-target` baseline `843a0be7e45513f43c95cbe86e5841bb4550a3e7` on isolated branch `security/293-linux-unit-service-primitives`.

## Assessment

DB-HO010 through DB-HO018 established the Linux lifecycle plan, protected filesystem mechanics, durable ownership records, measured generation installation, and immutable numeric identity binding. The read-only lifecycle inspector already verifies exact root-owned unit bytes, system-manager state, service identity, process identity, and executable identity. The shared protected-authority reconciler already owns durable stage/quiesce/promote/start/restore ordering and recovery.

Two lower dependencies remain before that shared reconciler can be composed with Linux effects:

1. an isolated, restart-safe owner for publishing one exact activation definition, refreshing the manager's loaded definition, and establishing startup persistence; and
2. a Linux-local adapter that maps neutral lifecycle actions to fixed system-manager commands without accepting executable, argv, environment, timeout, path, provider, repository, or VM authority from its caller.

Putting this sequence into the Linux lifecycle controller would duplicate generic recovery logic. Putting Linux command names into the neutral reconciler would leak topology. Adding another lifecycle journal would compete with the shared refresh journal rather than supplying its lower action studs.

## Primary research

The upstream systemd manual defines the relevant effect boundaries:

- `enable` creates the symlinks described by a unit's `[Install]` section and reloads manager configuration, but does not start the unit;
- `start` and `stop` are distinct lifecycle operations;
- without `--no-block`, `systemctl` waits for requested jobs to finish;
- `daemon-reload` reloads unit definitions and the dependency tree, whereas `reload` asks a running unit to reload its own configuration.

Primary sources:

- [systemd `systemctl` manual source](https://github.com/systemd/systemd/blob/main/man/systemctl.xml)
- [systemd unit manual source](https://github.com/systemd/systemd/blob/main/man/systemd.unit.xml)
- [systemd service manual source](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml)

## Reassessment and ownership boundaries

The smallest complete design is two independent LEGO bricks.

The platform-neutral definition reconciler owns only the progression from exact observation to exact durable readiness. Its closed contract is one bounded definition and four neutral ports: `observe`, `publish`, `refresh`, and `persist`. Observation reports only whether the exact definition is stored, current, and persistent. It publishes only when bytes are absent, refreshes only when loaded state is stale, persists only when startup wiring is absent, and observes after every effect. A crash resumes from exact observation and performs only the missing idempotent action. An impossible state in which an absent definition is reported current or persistent fails closed. This brick has no Linux, systemd, service-name, path, process, provider, setup, or lifecycle topology.

The Linux-local command adapter owns only fixed system-manager invocation. It accepts one bounded local unit identifier and an injected command-invocation mechanism for testing. It selects `/usr/bin/systemctl`, a fixed minimal locale environment, bounded time/output, null input, and fixed arguments internally. Its four neutral methods refresh definitions, establish persistence, quiesce, and activate. It is unavailable without invocation on non-Linux platforms. It never exposes command output or raw paths through its result/error contract.

Definition-file publication remains owned by the existing protected filesystem boundary; this slice supplies the neutral reconciliation stud but does not duplicate file mutation. Exact manager/process observation remains owned by the existing read-only Linux lifecycle inspector. Higher-level Linux lifecycle composition will connect those owners in the next slice.

## Plan

1. Add a generic definition-reconciliation module with strict closed inputs, bounded UTF-8 definition bytes, strict observation/effect evidence protocols, fail-closed impossible-state handling, exact post-effect observation, true no-op behavior, and restart recovery by observation.
2. Add a Linux-local fixed system-manager adapter with a safe bounded `.service` identifier, fixed `/usr/bin/systemctl`, fixed arguments, minimal locale environment, 30-second timeout, 16-KiB output bound, null stdin, and bounded non-leaking errors.
3. Prove fresh progression, no-op behavior, interruption recovery after each effect, inexact post-effect evidence, impossible/unknown observation, and unknown input/port rejection for the neutral brick.
4. Prove exact Linux invocations, invalid identifiers, non-Linux no-effect behavior, timeout/abort/truncation/nonzero/spawn failure handling, and source isolation for the local adapter.
5. Add both suites to repository preflight and run focused tests, preflight, repository-execution architecture gates, and the full suite.
6. Publish only the isolated branch, require hosted Ubuntu and Windows qualification, integrate only after exact evidence, and update issue #293 while leaving it open for lifecycle composition, bounded elevation, provider authorization, and physical KVM/libvirt/qcow2 qualification.

No UAC, sudo, account mutation, real system-manager command, libvirt, VM, production-image, or #197 physical action belongs to this slice.
