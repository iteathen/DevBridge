# DB-HO069 — issue #373 Linux protected configuration channel

Status: assessment, primary research, reassessment, dependency-ordered implementation plan, implementation, and local qualification complete on `stage8/362-protected-activity-channel` from exact baseline `22d7cbee1fd4f6fa06c94da349e14477ba5e1024`. Exact-head hosted qualification and real Linux elevation/systemd/provider gates remain pending. No setup, elevation, service, provider, VM, guest, or repository-controlled execution was performed.

## Assessment

Issue #372 added a closed `inspect`/`reconcile` configuration protocol, bounded named-pipe/Unix-socket transports, an independently attachable configuration port on the neutral lifecycle host, and the Windows protected composition. The protocol deliberately carries only an integer accepted-record revision and SHA-256 subject. The protected side derives physical topology locally and rereads the accepted record before and after effects.

The Linux protected service does not attach that port. Its exact systemd/tmpfiles plan provisions only lifecycle read, lifecycle mutation, and the activity-governance gate. The service runs as a dedicated non-root identity with `ProtectSystem=strict`; it must not gain traversal of the operator home or the wider ordinary DevBridge state tree merely to reread one accepted record. Conversely, increasing the wire request to carry the full record would expand every transport, including the Windows protected service, from the current 16 KiB digest-bound request to the profile-record maximum of 2 MiB.

The accepted profile state already has a dedicated file at `environment-profile-configuration/state.json`; it is not a mixed secret store. Linux also already has a descriptor-bound transfer primitive with no-follow opens, single-link checks, exact size/digest verification, exclusive pending creation, atomic rename, and directory synchronization. The missing work is therefore a topology and composition seam, not a new profile or lifecycle algorithm.

## Ownership boundary

The selected capability has four owners:

1. the ordinary setup owner publishes the one dedicated accepted-record file to a fixed installation-scoped handoff;
2. the configuration transport carries only the exact revision/digest request and bounded result;
3. the protected service reads and normalizes the fixed handoff, then performs locally derived resource/declaration reconciliation; and
4. the Linux service/tmpfiles owner provisions the endpoint and handoff policy and proves it before activation.

The handoff is accepted local intent, not provider authority. It contains no GitHub token, host executable, command, provider object, VM/domain name, image path, protected path, bridge credential, or arbitrary caller-selected location. The protected service remains the only process with provider-management membership and remains responsible for exact image/resource/declaration validation.

## Primary research

Linux `unix(7)` states that pathname-socket creation requires write and search permission on the containing directory, that Linux requires write permission on a stream socket to connect, and that a new socket receives the usual owner/group and `umask`-filtered permissions. This supports a service-owned endpoint directory plus a group-authorized socket while keeping ordinary clients unable to replace the socket path. It also means the implementation must qualify Linux behavior explicitly rather than claim portable socket-file enforcement on every Unix.

The current systemd `tmpfiles.d` source defines `d` entries as creating directories and adjusting exact mode/ownership, warns that implicit leading directories otherwise become root `0755`, and preserves directory SGID/sticky bits in configured mode. This supports explicit parents for both the service-created endpoint and the owner-separated handoff; no recursive cleanup entry is needed.

The current systemd execution documentation states that `ProtectSystem=strict` makes the filesystem read-only to the service except explicit exceptions and that `ReadWritePaths=` restores only namespace-level write access while ordinary filesystem permissions still apply. Therefore only the service-owned configuration socket directory belongs in `ReadWritePaths`. The ordinary-writable handoff stays read-only to the service namespace.

The existing DB-HO029 research remains applicable: SGID directories inherit group identity, sticky directories prevent one unprivileged participant from removing another participant's entry, and exact post-create observation remains required because `umask` filters creation modes.

Primary sources:

- [Linux `unix(7)` pathname socket permissions](https://man7.org/linux/man-pages/man7/unix.7.html)
- [systemd `tmpfiles.d` source documentation](https://github.com/systemd/systemd/blob/main/man/tmpfiles.d.xml)
- [systemd execution sandbox and `ReadWritePaths=` source documentation](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml)
- [Linux inode ownership, SGID, and sticky semantics](https://man7.org/linux/man-pages/man7/inode.7.html)
- [Linux path resolution permissions](https://man7.org/linux/man-pages/man7/path_resolution.7.html)

## Reassessment and selected design

Keep the digest-only configuration protocol unchanged. Add a fixed volatile handoff instead of granting the protected process the ordinary state tree or carrying a multi-megabyte record over the socket.

Derive the configuration authority identity from the canonical ordinary state root through the existing neutral transport identity function. Under `/run/devbridge/<configuration-authority-id>` provision:

- a root-owned `0755` capability root;
- a service-owned, coordination-group `02750` endpoint directory whose SGID bit gives the socket the admitted group;
- the existing fixed `configuration/environment-v1.sock` endpoint with service ownership and `0770` mode after the service `UMask=0007`; and
- a root-owned, coordination-group `03770` handoff directory containing only fixed `state.json`, owned by the ordinary publisher, grouped to the coordination capability, and mode `0640`.

The coordination group is reused only as local principal policy: its exact members are already the dedicated service and exact operator, and the ordinary user still lacks provider-management membership. Configuration remains a distinct endpoint, transport, operation protocol, source file, and host port. Creating a fourth group would not separate the two current principals, would expand immutable identity and recovery records, and would add another login-session membership transition without changing authority.

Ordinary publication derives both source and destination locally. It measures the dedicated source with a no-follow descriptor, transfers exact bytes through the existing bounded transfer primitive, verifies output policy/digest, and rereads the ordinary accepted record before invoking reconciliation. It cannot select another file or destination.

Protected reading derives the handoff locally, requires a real root-owned handoff directory, rejects root/service-owned or foreign-group records, and performs a descriptor-bound, single-link, stable read. It extracts only the dedicated profile-state key and normalizes the record. The requested revision/digest must match before any effect and again after all effects.

The Linux protected configuration composition reuses the existing profile configuration reconciler, declaration registry, image verification, and Linux foundation resource studs. It does not adopt arbitrary ordinary image paths. Missing protected images, unavailable management, foreign declarations, storage/network failure, handoff drift, or endpoint absence fail closed.

The Linux service entry creates the configuration port and passes it to the neutral host. The host retains independent startup rollback and reverse-order close behavior. Lifecycle read/mutation and configuration do not import or call each other.

## Dependency-ordered plan

1. Extend the neutral Linux transfer owner with a descriptor-bound content read needed to parse an already transferred bounded file; do not add a second transfer algorithm.
2. Add a Linux handoff owner that derives fixed topology, publishes only the dedicated accepted-state file, and reads/normalizes only that fixed result.
3. Extend the Linux plan and tmpfiles/endpoint topology with the configuration identity/root/endpoint/handoff, exact modes/owners/groups, and the single additional service write exception.
4. Attach a Linux protected configuration composition using the current foundation, lifecycle declaration, image verification, and profile reconciliation owners. Do not add image adoption, provider commands, or raw paths to the protocol.
5. Attach the configuration port in the Linux service entry and generalize the ordinary setup profile client so Windows keeps its current record reread while Linux publishes the fixed handoff before the same digest-bound request.
6. Prove fresh publication/reconcile, no-op replay, interruption recovery, source/output drift, symlink/hard-link/owner/group/mode/size/digest rejection, missing endpoint, resource failure, foreign declaration, server-start rollback, and service close ordering.
7. Add LEGO source tests: protocol, transfer, and ordinary client modules must contain no provider, repository, VM/domain, image path, command, credential, systemd, libvirt, or topology identity.
8. Register the complete slice in preflight, run focused and full local qualification, update this record and issue #373, push the isolated branch, and require exact-head Ubuntu/Windows hosted CI.

## Explicit nonclaims and later gates

This slice does not implement the bounded Linux sudo/elevation transaction, mutate a real systemd service, grant libvirt access, construct/adopt a Linux image, create a domain/qcow2 overlay, attach the protected activity endpoint, transfer the separate activity-routing policy, execute guest code, or establish Linux readiness. Those remain dependency-ordered #293/#362/#116 gates. Hosted Ubuntu tests can prove filesystem and protocol mechanics but cannot replace real KVM/libvirt/qcow2 and negative-capability qualification.

## Implementation checkpoint

The Linux protected storage owner now exposes one descriptor-bound read built from the same no-follow, exact-policy, single-link, stable-file measurement used by protected transfer verification. It returns bounded copied content plus exact digest evidence; no second file-reading algorithm or path-selection capability was added.

A new Linux configuration handoff owner derives its source, volatile authority root, endpoint directory, handoff directory, and fixed record from the accepted state root and neutral configuration-authority identity. Ordinary publication verifies the accepted record, source owner/link/size policy, descriptor-bound bytes, transfer evidence, and accepted record again. Protected reading verifies the root/handoff/record policy and parses exactly one dedicated state key from a descriptor-bound read.

The Linux lifecycle plan now provisions a distinct configuration-authority root, service-owned SGID endpoint directory, root-owned sticky/SGID handoff, and fixed record policy through its existing exact tmpfiles definition. The systemd unit receives the locally derived run root, adds only the configuration endpoint directory to `ReadWritePaths`, and does not add the handoff. Inspection exposes the four new filesystem facts independently. Health requires both the lifecycle operator endpoint and the configuration endpoint.

Protected reconciliation is now a neutral platform-independent brick. The Windows and Linux platform edges supply only their local accepted-record, preparation, foundation, lifecycle, conflict, and consent contracts. Windows keeps exact image adoption and conflict consent; Linux reads only the fixed volatile handoff, uses the protected foundation/image catalog, and has no ordinary image-adoption path. Moved reconciliation logic was removed from the Windows edge rather than retained as a compatibility implementation.

The Linux service composes the protected configuration port into the existing neutral host, whose independent startup rollback and reverse-order close behavior remain unchanged. The ordinary setup side likewise uses a neutral proxy: the Linux edge publishes/rechecks the fixed handoff before sending only revision/digest to the shared configuration client, then rechecks accepted state after the response. The Windows edge remains a thin active adapter, not a legacy fallback. The setup composition root selects exactly one platform edge.

## Local qualification

- Focused handoff and descriptor-transfer tests: 15 total, 14 passed, 1 expected non-Linux filesystem skip, zero failures.
- Linux plan, tmpfiles topology, inspection, service composition, protected configuration, ordinary proxy, refresh-health, and retained Windows configuration suites passed.
- Repository preflight passed: 178 syntax files, 2 JSON files, 149 targeted test files.
- Complete local suite passed: 1,772 total, 1,757 passed, 15 expected platform skips, zero failures.
- `git diff --check` passed; only the repository's normal Windows line-ending notices were emitted.

Exact implementation commit `abbdb31242d02ab2725094da7d44006bee6fa1ef` passed all four jobs in [GitHub Actions run 33226235422](https://github.com/iteathen/DevBridge/actions/runs/33226235422): Windows serialized complete-suite/doctor, Windows bounded preflight/identity/installer, Ubuntu complete-suite/doctor, and Ubuntu bounded preflight/identity/installer.

Real tmpfiles/systemd socket ownership and connectivity, service refresh/elevation, libvirt management denial/positive capability, image/domain/overlay state, and dual-guest C execution remain explicitly unclaimed. Issue #373 therefore remains open for the real Linux gates rather than treating hosted mechanics as physical readiness.
