# DB-HO078 — issue #378 Linux authority-plan selection

Status: accepted on exact implementation commit `ddda1fc4248db505d8be2941fb83f13f8e4c8697` after complete local and hosted qualification.

This checkpoint owns one read-only pre-setup composition boundary. It does not create or refresh an account, group, service, policy, provider, image, disk, environment, VM, or guest. It performs no elevation, provider connection, repository execution, publication, or model invocation.

## Dependency assessment

Issues #376 and #377 established two facts through one Linux-local authority boundary:

- every active full-management subject is observed from fixed local service-manager and identity sources and is classified as exact group-only authority; and
- the exact ordinary principal lacks every observed management capability in both configured NSS membership and the current process credential set.

The accepted result contains one selected neutral capability plus the complete unique capability set. It contains no provider object, socket, unit, path, command, environment, or mutation port.

The deterministic lifecycle-authority plan already projects the dedicated service account, read and coordination capabilities, fixed protected paths, service policy, and access membership. Its `managementGroup` input is currently supplied directly by its caller. No production setup-local owner composes the accepted observation into that plan. If later setup code supplies the value independently, it becomes a second provider-capability authority and can bypass the exact topology and ordinary-principal separation proofs.

The existing running-service activity admission reconstructs a plan from a root-owned installed ownership record. That is a later protected-state verification boundary. It cannot select the initial capability or substitute for pre-setup observation.

## Primary-source research

Libvirt documents that its UNIX sockets can use a configured group for access control and distinguishes that mechanism from polkit authorization. The full-management read-write socket grants substantial authority, so the selected group is a local capability decision rather than ordinary application configuration.

Libvirt also documents that modular and monolithic daemon deployments expose different sockets and that systemd socket activation owns socket creation and admission policy when enabled. A caller-provided group name therefore cannot be assumed to represent the complete active provider surface.

Systemd documents that service supplementary groups are initialized from account databases and extended by `SupplementaryGroups=`. Mapping the selected capability into the service plan is necessary, but the service definition remains a proposal until later protected reconciliation and running-token observation prove it.

Primary sources:

- [libvirt authentication and authorization](https://libvirt.org/auth.html)
- [libvirt daemon architecture and socket activation](https://www.libvirt.org/daemons.html)
- [libvirt compatibility proxy behavior](https://www.libvirt.org/manpages/virtproxyd.html)
- [systemd execution identity and supplementary groups](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml)

## Reassessment and selected boundary

Do not add provider observation to the deterministic plan factory and do not let a setup controller select a group. Keep both accepted modules unchanged and add one setup-local composition root between them.

The root request carries only `stateDirectory` and `principal`. Platform is read through a local fixed port rather than accepted from caller data. On Linux, the root obtains the exact #377 eligibility evidence, validates its complete schema and unique capability membership, maps only `selectedCapability.name` into the existing plan factory, and validates the returned plan against the exact request and selection before returning it.

Off Linux, the root is explicitly unattached and invokes neither eligibility observation nor plan projection. Unavailable, unverified, widened, malformed, aliased, or internally inconsistent child evidence returns no plan with a bounded local reason. A throwing or widened projector likewise returns no plan. Child reasons and raw errors are not forwarded.

The root accepts no management group, provider identity, endpoint, unit, path override, executable, argv, environment, service identity, or mutation function. Fixed protected topology remains owned by the deterministic plan factory. This is composition of established facts, not a second implementation or compatibility path.

## LEGO boundaries

- The #377 preflight remains the sole owner of topology, NSS, current-process, and capability-separation observation.
- The lifecycle plan remains a pure deterministic projector and knows nothing about how an eligible capability was discovered.
- The new root alone translates one neutral selected capability into the plan's local management-capability field.
- Ports use neutral action names and value contracts. The root has no concrete provider, socket, system path, command, account-mutation, service-manager, VM, guest, repository, or model mechanics.
- Exact schemas and identity binding prevent foreign objects or extra authority-bearing fields from crossing the boundary.
- There is no raw-group caller input, fallback selection, legacy reader, default provider assumption, or host-execution escape.

## Implementation and qualification plan

1. Add the isolated setup-local selection root with exact request, port, eligibility, capability-set, result, and projected-plan validation.
2. Extend the existing #377 focused test process rather than create a redundant Windows smoke process. Prove exact selection, off-Linux non-invocation, request widening rejection, unavailable/unverified evidence, capability alias and membership forgery, projector failure/widening, and source isolation.
3. Add only the new source file to syntax preflight; the existing targeted test already covers the complete composition path.
4. Run focused current-Node and exact Node 22.16.0 tests, repository preflight, relevant Linux authority selection, architecture gates, the complete suite, doctor, generated-artifact verification, and diff hygiene.
5. Commit and push the exact implementation, then require exact-head hosted Windows and Ubuntu smoke/full acceptance before closing #378.
6. Keep #293 open for protected Linux identity/service reconciliation, bounded setup/elevation, positive provider access, protected storage, and physical libvirt/qcow2/guest proof.

No protected or physical effect is authorized by this plan.

## Implementation

`linux-lifecycle-authority-plan-selection.js` is the single new setup-local composition owner. Its exact request contains only `stateDirectory` and `principal`. It reads platform through a local port and stops without invoking eligibility or projection off Linux. On Linux it calls the accepted preflight with the exact principal and locally selected platform, validates the complete result schema, requires a nonempty bounded unique capability set, and requires the selected name/ID pair to be an exact member.

The projection port receives only `stateDirectory`, `principal`, and the neutral selected `capability`. The root's private topology adapter maps that capability name into the existing deterministic plan factory. Before returning, the root creates the canonical projection independently and requires deep exact equality plus the expected plan protocol. The returned value is the canonical immutable plan, so an injected projector cannot add a field, change an identity, retain a mutable clone, or substitute a different capability.

Unavailable and unverified evidence are distinct. Every failure is collapsed into a bounded root-owned reason; child errors and child reason text are never forwarded. There is no fallback selection, caller-selected capability, protected-topology override, compatibility reader, or second plan implementation.

The existing #377 focused test process now owns the new boundary cases, avoiding another Node test-file process in Windows smoke. Repository preflight syntax-checks the new source and retains the same targeted-test file set.

## Local qualification

Qualification completed in dependency order:

- focused selection/preflight/policy tests on current Node 24.15.0: 15 passed, 0 failed;
- the same focused tests on exact Node 22.16.0: 15 passed, 0 failed;
- exact Node 22.16.0 bounded repository preflight: 2 standalone artifacts, 205 syntax files, 2 JSON files, and 168 targeted test files passed;
- current-Node default repository preflight: the same 2/205/2/168 inventory passed;
- Linux-focused selection: 212 total, 206 passed, 6 expected Windows platform skips, 0 failed;
- repository-execution architecture gates: 34 total, 33 passed, 1 expected Windows symlink-capability skip, 0 failed;
- complete serialized repository suite: 1,845 total, 1,829 passed, 16 expected platform skips, 0 failed in 204.8 seconds;
- doctor: `ok: true`, coding adapters disabled, and repository execution unavailable/fail-closed because no local persistent-environment route is configured;
- standalone generated-artifact contract: 2 passed, 0 failed; and
- `git diff --check`: passed apart from informational Windows working-copy line-ending warnings.

One initial `npx node@22.16.0` preflight probe reproduced the documented npm-wrapper environment alteration in `environment-bootstrap-agent.test.js`: two unrelated child-runtime checks failed while the new focused selection tests passed. Running the same materialized exact Node executable directly removed the wrapper environment and passed the complete preflight inventory. The wrapper run is diagnostic context only and is not candidate evidence; no product code or test was changed to accommodate it.

No setup, elevation, account/group/service/policy mutation, provider connection, protected-storage/VM/guest action, repository execution, or model invocation occurred. Commit and push the exact implementation, then require hosted Windows and Ubuntu smoke/full acceptance before closing #378. Parent #293 remains open afterward.

## Accepted hosted checkpoint

[GitHub Actions run 33289229145](https://github.com/iteathen/DevBridge/actions/runs/33289229145) passed all four jobs on exact implementation commit `ddda1fc4248db505d8be2941fb83f13f8e4c8697`: Ubuntu smoke in 26 seconds, Ubuntu full-suite/doctor in 40 seconds, Windows bounded smoke in 1 minute 27 seconds, and Windows serialized full-suite/doctor in 2 minutes 17 seconds.

Close #378. This accepts only the read-only capability-to-plan selection boundary. Parent #293 remains open for protected Linux identity/service reconciliation, bounded setup/elevation, positive provider access, protected storage, and real libvirt/qcow2/guest qualification. No protected or physical effect occurred.
