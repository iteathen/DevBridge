# DB-HO024 — issue #293 Linux service-definition composition

Status: planned from exact `cuda-target` baseline `d91fbeec0274fcd8ab4fe5c526c6ab7931d39b26` on isolated branch `security/293-linux-service-definition`.

## Assessment

DB-HO022 supplies fixed Linux service-manager actions and DB-HO023 corrected the neutral definition owner so stored bytes, manager-loaded state, and startup persistence remain independent target-relative facts. The existing Linux lifecycle inspector already reads unit bytes and selected `systemctl show` fields, but its system-manager parser is private, inherits a caller environment, and does not observe either `NeedDaemonReload` or loaded drop-ins.

Consequently, mapping its current `unitExact` flag directly to the neutral `current` fact would be false: exact bytes on disk do not prove that the manager has reloaded them, and a loaded drop-in can alter the effective definition. Repeating the same parser in a mutation module would create two observation authorities.

## Primary research

Systemd exposes `NeedDaemonReload` as a read-only unit D-Bus property and `DropInPaths` as the set of loaded drop-in fragments. The unit manual documents that drop-ins are merged after the main fragment and can exist at name-specific, dash-prefix, type-wide, and multiple unit-load-path locations. It also states that `daemon-reload` flushes and replaces loaded configuration while preserving runtime state. The `systemctl` manual keeps enabling separate from starting.

Primary sources:

- [systemd unit D-Bus property implementation](https://github.com/systemd/systemd/blob/main/src/core/dbus-unit.c)
- [systemd unit loading and drop-in rules](https://github.com/systemd/systemd/blob/main/man/systemd.unit.xml)
- [systemd `systemctl` command semantics](https://github.com/systemd/systemd/blob/main/man/systemctl.xml)

One upstream-reported edge case shows `NeedDaemonReload` may not notice a newly created drop-in directory until the first reload. DevBridge therefore also requires `DropInPaths` to be empty after reload and treats all unit/drop-in mutation locations as root-owned host control state. This does not make the property a boundary against a concurrently hostile root; root is already the local machine authority. It prevents adopting pre-existing or manager-loaded overrides and provides exact evidence for DevBridge's own bounded root transaction.

## Reassessment and ownership boundaries

This slice needs two bricks and one refactor:

1. A read-only Linux service observer owns fixed `/usr/bin/systemctl show` invocation, a minimal locale environment, bounded output/time, strict property parsing, and path-free failure evidence. It reports only local service facts, including whether the loaded definition needs reload and whether any drop-ins are active. It performs no mutation.
2. A Linux service-definition composition owns one root-owned `0644` unit file and maps exact file, loaded-manager, and enablement evidence onto the neutral definition reconciler. It admits only the target bytes plus a bounded explicit set of prior exact definitions. Foreign bytes, indirection, wrong policy, drop-ins, stale manager state, or inexact action effects fail closed.
3. The broad lifecycle inspector consumes the new observer instead of retaining a second system-manager parser. Its existing public evidence is preserved and gains one explicit loaded-definition fact.

The definition composition knows only its local name/path/bytes/identity contract. It does not know lifecycle generations, ownership records, refresh journals, providers, repositories, VMs, elevation, or setup topology. Higher lifecycle mechanics will supply the target and admitted prior definition derived from exact generation manifests.

## Plan

1. Add the fixed read-only observer with strict service names, non-Linux inapplicability, cancellation, no inherited environment, exact twelve-property parsing, bounded errors, and no raw command/output exposure.
2. Refactor Linux lifecycle inspection to consume that observer through one injected stud; delete the former parser/invocation implementation instead of retaining compatibility code.
3. Add the service-definition composition over existing protected storage, the fixed manager actions, and the neutral definition reconciler.
4. Require exact root/root `0644` file policy, exact immediate root-owned parent, bounded target/prior bytes, no unadmitted replacement, exact fragment/identity/groups/type, no loaded drop-ins, no pending manager reload, and independent enablement evidence.
5. Prove fresh install, enabled prior-generation upgrade, loaded-but-missing recovery, exact no-op, stale reload, drop-in rejection/repair boundary, foreign bytes/policy, failed observation/action, interruption recovery, non-Linux no effects, and source isolation.
6. Add both suites to preflight; run focused Linux authority tests, repository preflight, repository-execution architecture gates, and the full suite before isolated publication.

No real system-manager, filesystem, account, sudo/UAC, provider, VM, or physical-host mutation belongs to hosted qualification.
