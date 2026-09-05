# DB-HO086 — issue #387 Linux protected resource re-observation

Status: implementation accepted locally and in exact-head hosted CI on `stage8/362-protected-activity-channel`; documentation-head acceptance remains. This slice is software-only and authorizes no authentication, elevation, protected mutation, provider operation, VM/guest action, repository execution, or model invocation.

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

## Implementation checkpoint

`linux-environment-profile-configuration.js` now supplies the generic configuration proxy's existing neutral `createResourceObserver` port with the already-configured protected activity client. The fixed client construction uses only the local state identity, Linux platform selection, fixed run-directory input, and a three-second connection bound. The adapter contains no provider, VM/domain, image/storage path, process, or credential logic.

The generic proxy and protected configuration owner were not changed. With accepted declarations, Linux inspection now requires both exact declaration evidence and aggregate protected resource readiness. Unready, malformed, or unavailable resource evidence returns the existing bounded unready result, so the setup-owned lifecycle root invokes the existing protected configuration reconciliation and fresh verification path. Empty configuration still returns ready before constructing either a lifecycle listing or resource observer.

Tests cover ready-to-no-op, unready-to-reconcile, null/forged/throwing evidence, path-free failure projection, exact fixed client construction, empty-configuration non-attachment, foreign-platform refusal, and source isolation. No compatibility reader, second endpoint, alternate repair owner, or fallback was added.

## Local qualification evidence

- Current focused activity/configuration/setup boundary: 81 total, 80 passed, one expected Windows symlink skip, zero failures.
- Exact Node 22.16.0 focused configuration/setup boundary: 82 total, 81 passed, one expected Windows symlink skip, zero failures.
- Current and exact-Node repository preflight: two standalone artifacts, 219 syntax files, two JSON files, and 178 targeted test files passed.
- Current and exact-Node repository-execution architecture gate: 34 total, 33 passed, one expected Windows symlink skip, zero failures.
- Exact-Node product/setup/standalone integrity set: 14/14 passed.
- Exact-Node complete serialized suite: 1,915 total, 1,894 passed, 21 expected platform skips, zero failures in 192 seconds.
- Exact-Node doctor passed and truthfully reported repository execution unavailable/fail-closed because no local persistent-environment route is configured; coding-model adapters remained disabled.
- `git diff --check` passed apart from Git's informational existing Windows line-ending policy warnings.

The exact Node archive SHA-256 was `21c2d9735c80b8f86dab19305aa6a9f6f59bbc808f68de3eef09d5832e3bfbbd`. The temporary exact-runtime tree was removed after the final local checks and its absence was verified before commit. No authentication, `sudo`, UAC, protected service/provider/storage mutation, VM/guest action, repository execution, or coding-model invocation occurred.

## Hosted implementation evidence

[GitHub Actions run 33298113471](https://github.com/iteathen/DevBridge/actions/runs/33298113471) passed all four jobs on exact implementation commit `3c0ae99809fcbd8780f90d135a59c4779f4e7f78`:

- Windows bounded smoke/preflight/identity/standalone-installer passed.
- Windows serialized complete suite, architecture gate, and doctor passed.
- Ubuntu smoke/preflight/identity/standalone-installer passed.
- Ubuntu complete suite reported 1,915 tests, 1,879 passed, 36 expected platform skips, and zero failures; its separate architecture gate passed 34/34.

Hosted runners exercised only the software contracts and test fakes in this slice. This evidence does not claim local protected service readiness, provider/storage readiness, a constructed environment, a real guest bridge, repository execution, or either physical C canary.

## Remaining acceptance

Require this documentation-only acceptance head to pass the same Ubuntu/Windows smoke/full matrix. Close only #387 after that exact head is green. The parent and physical issues remain open.
