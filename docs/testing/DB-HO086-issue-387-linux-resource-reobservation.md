# DB-HO086 — issue #387 Linux protected resource re-observation

Status: planned on `stage8/362-protected-activity-channel`. This slice is software-only and authorizes no authentication, elevation, protected mutation, provider operation, VM/guest action, repository execution, or model invocation.

## Required preflight and assessment

The governing inputs were re-read before implementation: AGENTS.md; DB-003, DB-009, DB-019, and DB-020; `docs/vm-migration.md`; `docs/vm-lego-studs.md`; `docs/environment-lifecycle-authority.md`; the accepted Linux configuration/activity records DB-HO069 and DB-HO070; and the accepted setup attachment record DB-HO085.

The current Linux setup composition reaches the protected lifecycle, configuration, and activity endpoints. Its ordinary configuration adapter nevertheless supplies only declaration observation to the generic configuration proxy. The Windows composition supplies the same proxy with a neutral resource observer. The generic proxy already has the correct policy: when accepted declarations exist, both exact declaration state and `resources.ready === true` are required before inspection may no-op.

The missing Linux stud has a real recovery consequence. When declarations remain exact but management, image, storage, or networking readiness degrades, Linux inspection currently returns ready. Setup therefore skips the protected configuration reconciler that owns locally derived resource repair. Later environment activation can report failure, but the normal re-entry path has already bypassed its one bounded repair owner.

## Primary-source research

Libvirt documents `qemu:///system` as the system-mode QEMU/KVM daemon connection, distinct from the per-user `qemu:///session` connection. Its `virsh` documentation identifies `uri` as canonical connection-identity evidence and `capabilities` as the extensible host/hypervisor capability report. These observations belong inside DevBridge's protected provider-local foundation, not in ordinary setup.

Sources:

- [libvirt connection URIs](https://libvirt.org/uri.html)
- [virsh command reference](https://www.libvirt.org/manpages/virsh.html)

No new external mechanism is needed. `createProtectedEnvironmentActivity` already owns the protected foundation and its `inspect()` method returns a neutral aggregate `{ ready, identity, reason }` through the bounded activity protocol. The protocol projection removes provider-specific detail.

## Reassessment and selected ownership

Do not add another provider probe, resource endpoint, repair algorithm, or configuration protocol. Attach the existing configured activity client only in the Linux configuration composition root, using the same fixed local state, platform, run-directory, and timeout inputs already used by the Linux configuration client. Pass it to the generic proxy through the existing neutral `createResourceObserver` port.

This preserves the boundaries:

- provider and hypervisor identities remain inside the protected activity/foundation composition;
- the Linux setup adapter owns only local topology wiring;
- the generic proxy consumes only declaration and aggregate resource-readiness contracts;
- the protected configuration endpoint remains the sole resource repair owner; and
- endpoint absence or malformed/unready evidence makes inspection unready and causes bounded protected reconciliation rather than a host/provider fallback.

An empty accepted configuration remains a no-op before resource observation, because there is no desired resource subject to reconcile.

## Scoped implementation plan

1. Add the existing configured protected resource client as a replaceable Linux adapter port.
2. Attach that port to the generic configuration proxy's existing neutral observer stud.
3. Extend Linux adapter tests for ready, unready, malformed/throwing, and empty-configuration behavior plus exact fixed client construction.
4. Add source-isolation assertions that ordinary Linux configuration contains no provider, VM/domain, image/storage path, command, executable, argv, environment, or credential logic.
5. Run focused Linux/Windows configuration and setup tests, repository preflight, architecture gates, the complete serialized suite on exact Node 22.16.0, doctor, diff hygiene, and exact-head hosted Ubuntu/Windows CI.

Close only #387 after the documentation acceptance head is green. Keep #293, #372, #373, #374, #360, #116, and the physical Windows/Linux canary gates open.
