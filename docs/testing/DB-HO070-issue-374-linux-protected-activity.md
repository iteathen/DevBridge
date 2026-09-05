# DB-HO070 — issue #374 Linux protected activity policy and endpoint

Status: assessment, primary research, reassessment, and dependency-ordered implementation plan complete on `stage8/362-protected-activity-channel` from exact baseline `47ffad158daa39ece8ae9620ced4e2151612c6a3`. Implementation and qualification evidence will be appended without rewriting this pre-change record. No setup, elevation, service, provider, VM, guest, or repository-controlled execution was performed.

## Assessment

The Linux protected lifecycle service now attaches lifecycle read/mutation and the bounded configuration channel. It also acquires the exclusive side of the neutral activity-governance gate used to fence lifecycle changes. That governance gate is not the repository activity capability: the service still does not create or serve the neutral `inspect`/`list`/`observe`/`prepare`/`exchange` activity port.

The existing protected activity composition and workspace-route owner both default to `environment-activity/policy.json` below the ordinary state root. That works for the current Windows service identity, but it is not an acceptable Linux topology. The dedicated Linux account must not receive traversal of the operator home or general ordinary state merely to consume one credential-free route policy. The activity request protocol also must not be widened to carry policy bytes, paths, provider objects, guest access material, or commands.

The configuration handoff added by issue #373 cannot be reused as activity state. Configuration is operator intent consumed by a protected reconciler; the route policy becomes accepted only after the protected environment owner verifies each exact workspace root through the narrow guest bridge. Combining the files, endpoint, or protocol would let unverified selection state cross the activity boundary and would collapse two independently replaceable capabilities.

The existing lifecycle host owns startup rollback and reverse-order close for lifecycle and configuration servers, but has no optional activity port. The Linux plan/tmpfiles/inspection/health owners likewise have no activity authority root, endpoint directory, socket, or export handoff.

Finally, all three Linux pathname-socket transports bind directly with `server.listen(path)`. They close cleanly through Node, but there is no exact stale-path admission before a service restart following a crash. A crash can therefore leave a socket inode that causes the next systemd attempt to fail before any protocol health check.

## Ownership boundary

The selected design keeps five owners separate:

1. a neutral route-state port owns only normalized route-policy load/publication;
2. the Linux protected route-state adapter persists policy below service-owned protected state and exports the same normalized bytes through one fixed volatile handoff;
3. the protected activity composition resolves physical environment, workspace prefix, provider attachment, and access material transiently from protected state;
4. the neutral authority host attaches independent lifecycle, configuration, and activity server ports and owns only ordered startup/rollback/close; and
5. the Linux endpoint owner provisions and observes socket/handoff policy and removes only exact stale service-owned socket inodes before rebinding.

The ordinary setup/runtime side may import the credential-free exported policy into its own state. It cannot select a protected source/destination path, publish an unverified route into protected state, obtain provider credentials, or invoke lifecycle mutation through the activity endpoint.

## Primary research

The current Node `net` documentation states that a Unix-domain socket created by Node is unlinked when the server closes through the Node abstraction, but that the socket persists when the program crashes. Therefore ordinary `server.close()` is sufficient for clean shutdown, while crash recovery needs an explicit exact-path reconciliation before `listen()`.

Linux `unix(7)` states that pathname-socket creation requires write and search permission on the containing directory, connecting to a stream socket requires write permission on the socket inode on Linux, and newly created socket ownership/mode follow the usual filesystem and umask rules. This supports a service-owned, non-group-writable SGID endpoint directory plus a group-connectable socket. It also requires real Linux qualification because POSIX does not require every Unix implementation to enforce socket-file permissions identically.

The current systemd tmpfiles documentation defines `d` entries as exact directory creation/mode/ownership reconciliation. The systemd execution documentation states that `ProtectSystem=strict` makes the filesystem read-only to the service except explicit `ReadWritePaths=` exceptions, while normal filesystem permissions remain effective. The activity endpoint directory and fixed export handoff therefore need separate explicit write exceptions; the wider activity authority root and ordinary state tree do not.

The existing DB-HO029 and DB-HO069 research remains applicable: SGID directories inherit the admitted group, sticky directories prevent one unprivileged participant from replacing another participant's entry, path traversal requires search permission at every component, and every created/transferred file still needs exact postcondition observation because umask filters creation modes.

Primary sources:

- [Node.js `net` IPC path lifecycle](https://nodejs.org/api/net.html#identifying-paths-for-ipc-connections)
- [Linux `unix(7)` pathname socket permissions](https://man7.org/linux/man-pages/man7/unix.7.html)
- [Linux `connect(2)` pathname permission errors](https://man7.org/linux/man-pages/man2/connect.2.html)
- [systemd `tmpfiles.d` source documentation](https://github.com/systemd/systemd/blob/main/man/tmpfiles.d.xml)
- [systemd execution sandbox and `ReadWritePaths=` source documentation](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml)

## Reassessment and selected design

Do not copy the ordinary policy into the service on every activity request and do not grant the service ordinary-state traversal. Persist the accepted route policy below the existing protected authority directory, owned and writable only by the dedicated service. The workspace owner loads this port, verifies exact roots through its existing protected direct channel, and publishes through the port after verification. It invokes publication even for an unchanged policy so an interrupted or volatile export can be reconciled without changing the durable subject.

The protected activity runtime loads only that protected route state. The ordinary policy remains a projection used for local repository selection; it is not the protected activity authority. A forged or stale ordinary route therefore cannot create a protected route or make an absent target executable.

Derive a separate activity authority identity from the canonical ordinary state root through the existing neutral transport identity. Under `/run/devbridge/<activity-authority-id>` provision:

- a root-owned `0755` authority root;
- a service-owned, read-group `02750` endpoint directory;
- the fixed `activity/environment-v1.sock`, service/read-group `0770` after service `UMask=0007`;
- a root-owned, read-group `03770` export handoff; and
- fixed `policy.json`, service/read-group `0640`, created only by the service.

The read group already contains exactly the service and operator and already grants the operator the lifecycle read capability. Reusing it for the ordinary activity connection/export does not add a principal. Configuration continues to use the coordination group because its operator-to-service publication has different direction and purpose. Endpoint paths, files, protocols, and ports remain distinct.

The systemd unit adds only the activity endpoint and export handoff directories to `ReadWritePaths`. The service already owns its protected state write boundary. No operator home, general ordinary state, provider path, image path, or backing store is added.

Before any server binds, a small Linux socket-preparation brick examines each exact endpoint below a service-owned, non-group-writable directory. Absence is accepted. A present entry is removed only when it is a real single-link socket with exact service owner, parent group, and socket mode; symlink, regular file, foreign owner/group/mode, wide parent, or unstable replacement fails closed. This is crash reconciliation, not blind cleanup.

The service constructs the protected route-state port, reconciles any existing durable policy to the volatile export, constructs the local lifecycle operator with that injected neutral port, constructs protected activity with the same port's load method, and passes operator/configuration/activity to the neutral host. No child names or imports a sibling.

After protected environment activation, ordinary setup imports the fixed service-owned export, normalizes it, publishes it through the ordinary route-state port, and rereads both sides before enabling operational execution. On a restart, protected activity uses its durable protected policy immediately; ordinary runtime continues to use the matching durable ordinary projection. Missing or mismatched policy remains unavailable rather than falling back to a provider or host process.

## Dependency-ordered plan

1. Extract a neutral route-state port at the current policy load/publication seam and inject it through workspace construction, construction runtime, and local operator composition. Keep the filesystem-backed ordinary adapter as the default active implementation and delete direct calls from the workspace owner.
2. Add a Linux protected route-state/export adapter using the existing descriptor-bound transfer/read primitives. Prove durable normal/no-op publication, export recovery, stable rereads, and symlink/hard-link/type/owner/group/mode/size/digest rejection.
3. Add the exact-owned stale pathname-socket preparation brick and prove absence, exact recovery, substitution refusal, and post-unlink absence on a real Linux filesystem.
4. Extend the Linux plan, tmpfiles definition, service write allowlist, endpoint topology, and inspection with the distinct activity root/endpoint/export contract.
5. Extend the neutral lifecycle host with an optional activity port and generic ordered server rollback/close. Preserve independent protocols and factories.
6. Compose protected route state, local operator, protected activity, socket preparation, and the neutral host in the Linux service entry. Add activity to Linux generation health.
7. Add the ordinary post-activation import adapter and attach it only at the setup composition root before operational configuration becomes enabled.
8. Test missing policy/endpoint, route drift, startup rollback, close ordering, crash restart, cross-route isolation, credential/path absence, and denial of provider/direct-host fallback. Add strict LEGO source checks for every new child.
9. Register all files in preflight; run focused tests, repeated race/restart tests where useful, preflight, complete local suite, doctor, and exact diff checks.
10. Append implementation/evidence, push the isolated branch, require exact-head Windows/Ubuntu CI, and update #374/#362/#360. Keep physical Linux systemd/tmpfiles/libvirt/qcow2/guest and Windows UAC/guest gates open.

## Explicit nonclaims

This slice does not invoke sudo/UAC, install or restart a real service, change local group membership, grant libvirt authority, mutate Hyper-V, create or start a VM/domain, construct or adopt an image, transfer repository source, execute guest code, or establish either provider's physical readiness. It does not implement GPU/CUDA behavior. Those effects remain behind their existing protected and physical gates.

## Implementation checkpoint — 2026-08-29

The workspace construction owner now depends on a neutral `load`/`publish` route-state port. Its ordinary filesystem adapter remains the default at the application composition root, while the Linux service injects a protected adapter. Route publication occurs only after every exact workspace root passes the existing scoped guest-bridge verification. Publication is intentionally repeated for an unchanged normalized policy so a lost volatile export can be repaired without changing the durable route subject.

The Linux protected adapter persists `environment-activity/policy.json` below the service-owned authority state and exports the exact normalized bytes through a distinct fixed activity handoff. The descriptor-bound publisher verifies the protected file before and after transfer and checks root, endpoint, handoff, file type, owner, group, mode, link count, size, normalized content, and digest evidence. The ordinary reader needs only the canonical ordinary state identity and `/run` root; it neither accepts nor learns the protected authority path. The setup projection imports the service-owned export through the ordinary route-state port and rereads both sides before operational configuration can enable execution.

The Linux lifecycle plan now derives a separate activity authority identity, root, endpoint, socket, handoff, and policy-export contract. Its exact tmpfiles definition adds root `0755`, endpoint `02750`, and sticky/SGID handoff `03770`. The systemd unit adds only the activity endpoint and handoff directories to `ReadWritePaths`; it does not add the authority root, operator home, ordinary state, provider storage, or generation tree. Exact endpoint topology and read-only inspection now cover the activity directories and socket independently from lifecycle and configuration.

The neutral authority host accepts activity as another optional local contract. It starts attached servers in a fixed sequence and rolls back or closes only the successfully started servers in reverse sequence. Lifecycle, configuration, and activity keep independent protocols and server factories. Linux generation health now requires a syntactically exact activity inspection response but does not misclassify unavailable workload prerequisites as a failed service endpoint.

The Linux service composes one protected route state, injects it into its local lifecycle operator, supplies the same load port to protected activity, and attaches the resulting activity contract to the host. It reconciles any durable route export before serving. Before binding, the new neutral pathname-socket preparation owner inspects each fixed parent and removes a present path only when it is a real, single-link, exact-owner/group/mode socket below an exact service-owned non-group-writable directory. Absence is a no-op; symlink, regular file, link-count, identity, permission, or replacement drift fails closed. No recursive or caller-selected cleanup exists.

Windows-hosted testing exposed one implementation defect during this work: the Linux handoff topology initially called a host-native path helper and produced a Windows path during cross-platform plan validation. The Linux adapter now derives its protected source with `path.posix`, while the neutral ordinary filesystem adapter remains host-native. No compatibility branch was retained.

Qualification evidence on the uncommitted exact working tree:

- focused route-state, handoff, projection, socket, construction, host, topology, inspection, health, and setup integration: 117 passed, zero failed;
- repository preflight: 183 syntax files, 2 JSON files, and 154 targeted test files passed;
- complete local suite: 1,793 total, 1,777 passed, 16 expected platform skips, zero failed; the added real crash-retained pathname-socket proof is one Windows-side skip and will execute on hosted Ubuntu;
- `git diff --check`: passed;
- source isolation searches found no provider, repository, guest identity, credential, direct-host fallback, sudo, or UAC mechanics in the new neutral children.

No setup, sudo/UAC request or bypass, service/systemd mutation, libvirt/Hyper-V operation, image/environment/VM/guest action, or repository-controlled execution occurred. Real Linux tmpfiles/systemd/socket permissions, libvirt/qcow2 execution, the installed Windows service refresh, and dual-guest C acceptance remain physical gates and are not claimed here.

## Hosted acceptance checkpoint — 2026-08-29

[GitHub Actions run 33228024953](https://github.com/iteathen/DevBridge/actions/runs/33228024953) completed successfully on exact implementation commit `28bbb55184310fc44c92a7f41610158c90b3c894`. Windows serialized complete-suite/doctor, Windows bounded preflight/identity/installer, Ubuntu complete-suite/doctor, and Ubuntu bounded preflight/identity/installer all passed. The Ubuntu complete-suite job executed and passed the real crash-retained Unix-domain-socket restart proof that is intentionally skipped on Windows.

This hosted result qualifies the cross-platform software boundary and Linux socket-recovery behavior available to an unprivileged CI process. It does not prove a real tmpfiles/systemd installation, service/socket ownership under the dedicated principals, libvirt/qcow2 provider readiness, repository execution in a guest, the installed Windows service refresh, or either physical guest C canary. Keep those gates open.
