# DB-HO024 — issue #293 Linux service-definition composition

Status: implemented, hosted-qualified, and integrated into `cuda-target` as exact squash commit `b306de2023dc616f27ee9a9e2628c9291baea9ea`.

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

## Implementation

The service observation adapter now owns the one fixed, read-only `/usr/bin/systemctl --system --no-pager --no-ask-password show` call. It requests exactly twelve locally selected properties, uses only a fixed C locale, accepts a bounded cancellation signal, limits time and output, and converts spawn, exit, timeout, truncation, or parse failure into path-free evidence. `NeedDaemonReload=no` and an empty `DropInPaths` are independently required before it reports the loaded definition current. Non-Linux hosts remain explicitly unattached without invoking the adapter.

The service-definition composition connects six neutral studs: inspect, load, save, observe, actions, and reconcile. It accepts one exact target plus at most two explicit prior definitions; verifies a real root-owned, root-group, `0644` file under an immediate root-owned non-writable parent; rejects unadmitted bytes rather than overwriting them; and verifies the loaded fragment, local identity, exact supplementary-group set, service type, absence of drop-ins, manager reload state, and enablement. The generic reconciler alone sequences publish, refresh, and persist, so an interrupted effect is recovered from fresh observation and an exact ready definition is mutation-free.

Lifecycle inspection now consumes the observer through one replaceable read-only stud. Its former system-manager invocation and parser were deleted, and a source-isolation test prevents that command authority from drifting back into the broader inspector. The new modules do not name lifecycle generations, ownership records, journals, repositories, providers, virtual machines, elevation mechanisms, or neighboring topology.

Review found and closed two injected-evidence ambiguity paths before publication: duplicate supplementary groups can no longer masquerade as an expected set, and every protected-file observation must carry typed presence, policy, and observed-mode evidence. Both fail before a publication, reload, or enable action.

## Local qualification

All qualification below ran without elevation and without touching a real system manager, account database, protected filesystem, provider, or VM:

- focused definition/manager/observer/lifecycle boundary selection: 38 passed, 0 failed;
- broader Linux authority selection: 111 total, 108 passed, 3 expected real-Linux filesystem skips, 0 failed;
- repository preflight: 43 syntax files, 2 JSON files, 45 targeted test files, passed;
- repository-execution architecture gates: 34 total, 33 passed, 1 expected Windows symlink-capability skip, 0 failed;
- complete Windows suite: 1,267 total, 1,256 passed, 11 platform skips, 0 failed.

## Hosted qualification and integration

Isolated PR [#338](https://github.com/iteathen/DevBridge/pull/338) qualified exact head `5c8e99c6704743d4f479da7fc12a67d92b120ac8` in CI run [`33132044369`](https://github.com/iteathen/DevBridge/actions/runs/33132044369):

- Ubuntu smoke/preflight passed in 17 seconds;
- Ubuntu architecture gates, full suite, and doctor passed in 38 seconds;
- Windows smoke/preflight passed in 51 seconds;
- Windows architecture gates, full suite, and doctor passed in 2 minutes 1 second.

The PR was squash-integrated as `b306de2023dc616f27ee9a9e2628c9291baea9ea`. The reviewed head and integrated commit both resolve to exact tree `d8fa6b25262e1f5cdd53e63eb68eceede0dd8610`; the integration therefore added no unreviewed tree content.

Issue #293 remains open because higher lifecycle composition, bounded one-command elevation, libvirt/qcow2 provider authorization, and physical Linux qualification are not part of this slice.
