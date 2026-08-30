# DB-HO076 — issue #293 Linux provider-authority topology plan

Status: issue #376 implementation and local qualification complete from exact baseline `e00d2ae6281fa6b67a8734bc2389c2c470d1eb84`; exact-head hosted qualification is pending.

This checkpoint owns one read-only Linux/provider primitive. It does not install or refresh the protected service, elevate, edit accounts or groups, change systemd or polkit policy, connect to libvirt, inspect or mutate qcow2 state, run a VM, or claim Linux readiness.

## Dependency assessment

The Linux protected-authority stack already has isolated bricks for its deterministic plan, numeric identities, protected records and trees, runtime generations, endpoint topology, unit and service mechanics, shared refresh reconciliation, local lifecycle/configuration/activity channels, and daemon activity admission. Those bricks intentionally leave the production setup path unattached.

The next setup/elevation step cannot safely select the plan's neutral management group yet. Current production code has no current Linux provider-authority classifier. The historical PR #295 observer selected the first existing path from `virtqemud-sock` or `libvirt-sock` and treated a group-writable inode as the whole authority proof. That is insufficient because:

- modular and monolithic daemons can exist across upgrades, and the active service/socket units determine the current mode;
- modular QEMU management can coexist with the compatibility proxy, creating more than one full-management surface relevant to the ordinary-user negative proof;
- systemd socket activation makes the effective socket unit, rather than only the daemon configuration file, authoritative for listener path, group, and mode;
- a world-connectable endpoint can still be guarded by polkit, so inode mode alone cannot prove either authority or lack of authority; and
- a group-connectable endpoint proves only admission to the socket. A later positive operation probe must still prove that the protected identity can use the exact `qemu:///system` path without an interactive authorization step.

The dependency-correct next brick is therefore observation and classification, not elevation or mutation.

## Primary-source research

Libvirt documents modular `virtqemud` and monolithic `libvirtd` as distinct system-mode topologies. It instructs operators to determine the active mode from the corresponding `.socket` and `.service` units. It also documents `virtproxyd` as the compatibility surface and says a full-management socket can be equivalent to root authority.

On systemd hosts, libvirt normally uses socket activation. In that mode, socket group, mode, and listener location are controlled by the socket unit, and the corresponding daemon configuration settings are not authoritative.

Libvirt documents two different access mechanisms that must not be conflated:

- a restricted UNIX socket may grant access through its owning group and mode; and
- a broadly connectable socket may defer authentication/authorization to polkit.

The polkit access-control driver can additionally authorize individual API permissions and object identities. A broad socket is therefore not automatically unsafe, but it cannot be accepted as a group-only capability. It requires a separately designed and physically qualified policy adapter.

Systemd permits more than one `ListenStream=` entry and permits prior entries to be reset. The effective listener set must be observed rather than inferred from a conventional filename.

Primary sources:

- [libvirt daemon topology and systemd integration](https://libvirt.org/daemons.html)
- [virtqemud socket-activation behavior](https://libvirt.org/manpages/virtqemud.html)
- [libvirt connection authentication](https://libvirt.org/auth.html)
- [libvirt polkit access control](https://libvirt.org/aclpolkit.html)
- [systemd socket-unit listener and mode semantics](https://github.com/systemd/systemd/blob/main/man/systemd.socket.xml)

## Reassessment and selected boundary

Add one Linux/provider-local read-only classifier. It owns the fixed system-mode daemon/socket candidates and their conventional local endpoints. Its public evidence uses only neutral fields for classification, route, capabilities, and subjects; it does not expose a lifecycle plan, service account, repository, VM/domain, storage path, command, argv, environment, or caller-selectable provider object.

The classifier will:

1. observe the fixed modular, monolithic, and compatibility service/socket units with bounded `systemctl show` calls;
2. require exact current unit evidence and reject stale definition state;
3. require each active socket unit's effective listener set to contain only its one fixed local stream subject;
4. classify simultaneous modular and monolithic activity as ambiguous;
5. inspect both possible full-management socket inodes without following indirection;
6. reject a present surface that is not explained by the active topology;
7. resolve each numeric group through NSS with a fixed `getent group <gid>` lookup;
8. distinguish bounded group-only surfaces from root-only, policy-backed/wide, malformed, ambiguous, and unavailable state; and
9. return no raw host error or raw path-bearing diagnostic.

This brick does not decide that Linux is ready. A later policy composer must bind its selected neutral capability into the protected-authority plan, prove the ordinary identity lacks every observed management capability, create/reconcile the protected identity under bounded elevation, and prove positive noninteractive `qemu:///system` access from that identity. Policy-backed/polkit topology remains fail-closed until it has its own exact local policy design and proof.

## LEGO boundaries

- The local classifier alone knows the provider daemon/socket identities and fixed local endpoint paths.
- Its caller receives neutral classification and capability identities, not paths or system-manager objects.
- The existing Linux lifecycle plan continues to receive only a neutral management-group name; it does not learn how that capability was discovered.
- The generic command invoker remains the process boundary. Every child has a fixed executable, fixed bounded argv, `shell: false`, bounded time/output, and a minimal locale.
- No compatibility reader or old first-socket selection path will be retained.

## Qualification plan

Focused tests will cover modular, monolithic, compatibility-proxy, absent, simultaneous/ambiguous, stale surface, unexpected listener, reload-pending, symlink/non-socket, root-only, group-only, policy-backed/wide, unknown NSS group, malformed/failed/truncated command evidence, cancellation, non-Linux no-op, exact interface shape, and source isolation from mutation/setup/lifecycle/repository/VM authority.

Then run repository preflight, repository-execution architecture gates, the complete focused Linux protected-authority corpus, the full suite, and doctor. Exact-head Ubuntu and Windows CI are required before this checkpoint is accepted. Hosted evidence will not close #293 or substitute for physical systemd/libvirt/qcow2 qualification.

## Implementation

`linux-provider-management-topology.js` is one provider-local read-only owner. Its caller may select only platform applicability and cancellation; it cannot supply a unit, endpoint, path, executable, arguments, environment, provider object, service identity, or policy. The adapter owns six fixed bounded unit observations, two fixed local subjects, and NSS lookup by an inode's numeric group.

The public result is deliberately path-free. It carries only `classification`, `route`, neutral capability name/ID pairs, neutral subject roles/policies, and one bounded reason code. A selected capability is returned only when every active full-management subject is group-only. Root-only, policy-backed, and mixed topologies remain observable but do not produce a selected capability.

The implementation additionally accepts only current socket-activated topology in this initial policy. A service-only/traditional daemon is observed but classified `unsupported-activation` because its effective listener configuration is not owned by the systemd socket evidence. Simultaneous modular/monolithic activity, an orphaned compatibility route, missing or unexplained subjects, pending daemon reload, extra/non-stream listeners, links, non-sockets, non-root ownership, unknown NSS groups, malformed subprocess evidence, timeouts, and truncation all return bounded non-exact evidence.

No compatibility implementation from PR #295 was copied. No mutation or provider-connection operation exists in this module.

## Local qualification

Qualification completed in dependency order:

- focused topology tests: 10 passed, 0 failed;
- repository preflight: 2 standalone artifacts, 203 syntax files, 2 JSON files, and 167 targeted test files passed;
- Linux-focused selection: 197 total, 191 passed, 6 expected non-Linux platform skips, 0 failed;
- repository-execution architecture gates: 34 total, 33 passed, 1 expected Windows symlink-capability skip, 0 failed;
- complete repository suite: 1,830 total, 1,814 passed, 16 expected platform skips, 0 failed;
- doctor: `ok: true`, with repository execution still unavailable/fail-closed because no local persistent-environment route is configured; and
- `git diff --check`: passed apart from Git's informational line-ending warning for the pre-existing Windows working-copy policy.

No setup, elevation, account/group mutation, systemd action, polkit change, provider connection, qcow2/VM/guest action, repository execution, or model invocation occurred. Exact-head Ubuntu and Windows CI remain required before issue #376 can close.
