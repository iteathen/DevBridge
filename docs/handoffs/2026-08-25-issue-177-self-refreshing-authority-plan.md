# Issue #177 self-refreshing authority handoff — 2026-08-25

## Purpose

Realign protected lifecycle-authority delivery so DevBridge becomes usable on Windows soon while minimizing physical-host interaction.

The host is a final integration target, not the place where ordinary setup/reconciliation bugs are developed.

## Exact starting point

Branch: `security/177-authority-refresh`

Base: Windows authority exact green head `864d62bf931306138ad2baf2d09b4755ed6747f5` from PR #289 / issue #288.

Repository evidence for that base: CI run `32885285146`, all four Ubuntu/Windows smoke/full jobs green, including the Windows PowerShell 5.1 service-host compile proof and named-pipe one-instance exclusivity proof.

Issue #292 is the new critical path.

Linux work in #293 / PR #295 is preserved and intentionally paused. Its qualified checkpoints remain:

- `2f8a38360708203d359128056e5782aba4d2838d` / CI `32888196771` — Linux plan/service-entry slice, four jobs green;
- `ad605f126442b5f79e4a52057e22655d5f3e5bf0` / CI `32889385139` — Linux read-only host/account/systemd/libvirt inspection slice, four jobs green.

Do not continue Linux-specific refresh orchestration until it can plug into the shared #292 reconciler.

## Operator contract

The supported installation, refresh, interruption recovery, and re-verification command must converge to:

```text
devbridge setup
```

A rerun after interruption uses the same command. Do not require the operator to paste a new host repair script for each frontier.

The ordinary setup process should remain alive while a bounded elevated child performs exact privileged reconciliation, then automatically return to ordinary-identity negative/positive proofs and the existing read-only readiness gate.

## Shared reconciliation LEGO

Implement one platform-neutral Node state machine with these local ports:

1. observe current protected installation;
2. compare exact candidate/current generation;
3. stage exact protected runtime generation;
4. verify staged generation;
5. quiesce exact owned authority service if required;
6. promote exact staged generation;
7. start/restart exact owned service;
8. prove health;
9. checkpoint exact observed frontier;
10. recover/rollback from observed evidence.

Every effect is durable-intent/observe-before-repeat per DB-009. The shared core does not know SCM, systemd, Hyper-V, libvirt, ACL, group, provider, VHDX, or qcow2 identities.

## Platform adapters

Windows owns only:

- bounded UAC/elevation transaction;
- SCM service identity/lifecycle;
- protected filesystem/ACL policy;
- named-pipe security mechanics;
- exact Hyper-V/provider-management authority required by the protected service.

Linux later owns only:

- bounded sudo/elevation transaction;
- system account/group and systemd lifecycle;
- protected filesystem/socket policy;
- exact libvirt/qemu provider capability required by the protected service.

The service identity must not be able to rewrite its protected Node/package/native runtime. Setup/reconciliation owns runtime refresh transactionally under administrator/root ownership.

## Hosted qualification before physical host use

Do not move to a physical authority run until exact-head CI covers:

- fresh install;
- exact-current no-op;
- stale refresh;
- interruption before/after every durable mutation frontier;
- effect completed but checkpoint lost;
- failed replacement and prior-generation recovery;
- runtime/candidate drift during refresh;
- missing/damaged ownership evidence;
- missing/stopped/stale/unhealthy service;
- ordinary negative-capability proof behavior;
- arbitrary path/command/provider-object rejection;
- rerun through the same setup command.

## Windows usability closure

After hosted qualification, the next real Windows interaction should be one ordinary `devbridge setup` run that maximizes evidence:

1. observe/reconcile protected authority through at most one bounded UAC transaction;
2. return to the original ordinary identity;
3. prove protected state and mutation capability are inaccessible directly;
4. create/reconcile a dedicated disposable DevBridge-owned VHDX acceptance fixture, separate from #197;
5. prove ordinary direct delete/replace is denied;
6. prove the corresponding exact-owned lifecycle mutation succeeds through the protected authority;
7. reconcile/clean only the exact test fixture;
8. continue to the existing read-only readiness gate.

If interrupted, rerun `devbridge setup`; do not invent a new recovery command.

Windows may become platform-ready/usable after this gate even if Linux remains unqualified. Linux must remain explicitly fail-closed until #293 completes its own physical proof. Parent #177 remains open until both platform acceptances are complete.

## Stop conditions

Stop rather than broaden authority if implementation requires:

- ordinary Administrator/root/Hyper-V/libvirt membership;
- a generic privileged shell or file service;
- caller-selected privileged paths/provider objects;
- the privileged service modifying its own executable/runtime supply;
- a second lifecycle semantic owner;
- use of #197 production-image state merely as an authority test fixture;
- ad-hoc host debugging when the same condition can first be modeled/fault-injected in hosted tests.

## Immediate next code slice

Create the shared reconciliation state machine and fake adapter tests only. Do not add platform mutation in the first code commit.

The first code slice should prove deterministic phase progression, no-op current state, observe-before-repeat after ambiguous effects, and rollback/recovery decisions through injected local ports. Only after that exact head is green should the existing Windows service reconciler be adapted to those ports.
