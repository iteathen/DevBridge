# DB-HO010 — issue #293 Linux protected-authority reassessment

Status: hosted implementation checkpoint complete for bricks 1–3. This record narrows the Linux continuation onto the shared protected-authority reconciler already integrated on `cuda-target`. It does not claim Linux host readiness or replace DB-020, `docs/environment-lifecycle-authority.md`, `docs/vm-migration.md`, or `docs/vm-lego-studs.md`.

## Exact starting evidence

The continuation starts from recovery head `a7fcd175a36f89ebaadd3ca95d67c7bd07d544a9` on isolated branch `security/293-linux-authority-recovery`.

Draft PR #295 is not mergeable as a unit. It is stacked on historical Windows authority work already integrated through the later shared-reconciler lineage. Only ten Linux commits after `864d62bf931306138ad2baf2d09b4755ed6747f5` are relevant design evidence. Their six files define a plan, service entry, read-only inspector, structural/ordinary-negative verifier, and tests; they do not attach Linux mechanics to `reconcileProtectedAuthority`, provision the host, perform a bounded elevation transaction, or prove a physical libvirt/qcow2 boundary.

The first two historical Linux checkpoints remain useful evidence:

- exact plan/service-entry head `2f8a38360708203d359128056e5782aba4d2838d` passed all four hosted jobs in CI `32888196771`;
- exact read-only inspection head `ad605f126442b5f79e4a52057e22655d5f3e5bf0` passed all four hosted jobs in CI `32889385139`.

That evidence is not reusable as current-candidate verification because the baseline, shared reconciler, and selected Linux design are changing.

## Primary-source findings

### systemd identity and service start

Systemd initializes a service's supplementary groups from the system user/group database. `SupplementaryGroups=` extends that set; it does not replace it. Exact authority proof must therefore use NSS-aware identity/group observation and must verify the running service process's effective group set. Reading `/etc/passwd` and `/etc/group` directly is insufficient because NSS may resolve identities and membership from other sources.

`Type=simple` may report a successful start before the service executable has completed `execve()`. `Type=exec` waits for that boundary and reports a missing executable or user as a start failure. The protected authority unit should use `Type=exec`.

`ProtectSystem=strict` makes the filesystem hierarchy read-only for the service except explicit writable locations. `ReadWritePaths=` and systemd-managed runtime/state directories create deliberate exceptions. The unit must expose only the authority state, coordination, and endpoint directories as writable; the content-addressed runtime remains root-owned and immutable to the service identity.

Sources:

- [systemd execution environment](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml)
- [systemd service start semantics](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml)
- [glibc Name Service Switch](https://sourceware.org/glibc/manual/latest/html_node/NSS-Basics.html)
- [glibc users and groups](https://sourceware.org/glibc/manual/latest/html_mono/libc.html#Users-and-Groups)

### local socket authority

The read capability requires group write permission on the socket inode to connect, but the ordinary read group does not need write permission on the parent directory. A group-writable socket parent permits ordinary readers to create, remove, or substitute endpoint names. The historical `0770` read parent is therefore rejected; the parent is `0750`, owned by the service identity and read group, while the service-created socket may be group-connectable under the unit umask. The mutation parent remains service/root-only.

### libvirt provider authority

A system-mode libvirt read-write connection is normally root-equivalent. On systemd hosts, modular `virtqemud` commonly receives its sockets from socket activation, so daemon configuration alone may not control socket ownership or mode. Libvirt explicitly documents how to detect modular versus monolithic mode with the active socket/service units.

Libvirt's polkit access-control driver can authorize individual API permissions and object identities, including domain UUID, pool UUID, and volume key. It is a preferable eventual mechanism where the installed libvirt build and distribution expose a complete usable policy. A service-only group/socket capability remains an admissible first supported policy only when the ordinary identity is proved absent, every effective provider endpoint used by `qemu:///system` is bounded, and the protected service's positive provider access is proved. A wide socket is not rejected solely by mode when polkit is authoritative, but it cannot be accepted without exact policy evidence.

The recovery slice will initially implement an explicit `service-group` capability adapter and fail closed on polkit/wide-socket topologies it cannot yet prove. It will not silently infer authorization from the first socket path that happens to exist.

Sources:

- [libvirt daemon modes and system sockets](https://libvirt.org/daemons.html)
- [virtqemud socket activation](https://libvirt.org/manpages/virtqemud.html)
- [libvirt connection authentication](https://libvirt.org/auth.html)
- [libvirt polkit access control](https://libvirt.org/aclpolkit.html)
- [libvirt QEMU security architecture](https://libvirt.org/drvqemu.html#security)

### qcow2 lineage and storage

The protected service identity does not replace libvirt/QEMU DAC, SELinux, or AppArmor ownership. Physical qualification must prove that the exact DevBridge storage root remains operable by libvirt/QEMU without making it world-writable or disabling security drivers.

QEMU's structured `qemu-img info --output=json --backing-chain` observation remains the lineage authority. `rebase -u` changes backing metadata without converting data and can corrupt the guest view when the parent is wrong; no Linux authority setup operation may infer or rewrite backing identity from a filename.

Sources:

- [QEMU disk image utility](https://www.qemu.org/docs/master/tools/qemu-img.html)
- [qcow2 format](https://www.qemu.org/docs/master/interop/qcow2.html)

## Reassessment of the preserved draft

The draft's neutral identity derivation, provider-free service entry, root-owned runtime intent, split endpoints, and read-only-first ordering remain valid. Four implementation choices require correction before adoption:

1. The read endpoint parent was group-writable (`0770`), allowing read-group members to mutate endpoint topology. It must be group-traversable but service-writable only (`0750`).
2. The unit used `Type=simple`; it must use `Type=exec` so service-start evidence includes successful executable/user transition.
3. Account and group proof parsed `/etc/passwd` and `/etc/group`, bypassing NSS and the actual group set systemd applies. Inspection must use a bounded NSS-aware adapter and verify the running process's numeric groups.
4. Runtime proof covered selected files in one fixed directory. The shared reconciler requires a content-addressed generation whose complete staged tree and executable digest are verified before promotion and whose active tree is immutable to the service identity.

Two further boundaries remain deliberately unresolved by the historical code:

- provider authority must classify the actual modular/monolithic/polkit topology rather than adopting the first matching socket;
- a real Linux positive/negative qcow2/domain canary is required before client cutover or readiness claims.

## Dependency-scoped implementation plan

The work proceeds as coherent LEGO bricks:

1. **Corrected plan and service entry.** Recreate the neutral Linux plan on the current head, with `Type=exec`, service-owned `0750` read parent, service/root-only mutation parent, a content-addressed runtime layout, and no provider identity in the service entry.
2. **Read-only observation.** Add NSS-aware account/group observation, exact systemd unit and running-process identity/group evidence, complete runtime/ownership inspection, and provider-topology classification. No account, filesystem, systemd, polkit, libvirt, qcow2, or service mutation occurs in this brick.
3. **Shared refresh adapter.** Map Linux-only mechanics to the existing `reconcileProtectedAuthority` ports. Linux code must not implement a second stage/verify/quiesce/promote/start/health/restore state machine.
4. **Protected mechanics.** Add bounded root-only account/group, generation staging/verification, unit promotion, endpoint-parent, service lifecycle, and recovery effects. Every external effect is journaled and observed before repeat; foreign/ambiguous state blocks.
5. **One-command setup composition.** Add at most one closed Linux elevation child and automatic return to ordinary inspection. The ordinary process never receives provider group membership, root, sudo credentials, or the mutation endpoint.
6. **Hosted qualification.** Cover fresh/no-op/stale/interrupted/ambiguous/rollback cases, NSS-only membership, endpoint substitution, full runtime mutation, unit indirection, provider topology mismatch, ordinary negative proof, and forbidden arbitrary paths/commands/provider objects. Run architecture gates and full Ubuntu/Windows suites.
7. **Physical Linux qualification.** On a capable KVM/libvirt host, prove ordinary denial, exact protected positive lifecycle mutation, qemu access to exact storage, backing lineage, cleanup, and re-entry. Until then Linux stays explicitly fail-closed/not-ready.

The immediate implementation frontier is bricks 1–3. It is independent of the pending UAC-required Hyper-V v6 construction and does not touch #197 VM/media/journal state.

## Implemented hosted slice

The recovery branch implements the immediate frontier without adding privileged Linux mutation:

- `linux-lifecycle-authority.js` owns deterministic local identity, endpoint, content-generation, access, and `Type=exec` unit planning. Its service entry receives only local authority/state directories and has no provider identity.
- `linux-local-identities.js` is the bounded NSS-aware observation adapter. It uses fixed absolute `getent` and `id` identities, returns numeric group evidence, and performs no mutation.
- `linux-lifecycle-authority-inspection.js` separately observes identity, ownership, exact systemd configuration, the running process's real UID/GID/group set and executable, protected filesystem policy, endpoints, and the complete exact runtime tree. Runtime identity remains observable while a service endpoint is stopped.
- `protected-authority-runtime-candidate.js` now owns the platform-neutral package/executable measurement and complete immutable-tree access proof. The Windows lifecycle owner delegates to the same brick; no second runtime identity mechanism was retained.
- `protected-authority-refresh-adapter.js` owns the platform-neutral observation/effect contract around the existing protected-authority reconciler. The Windows adapter is now a thin compatibility projection, and the Linux facade supplies only its diagnostic identity. Linux does not implement a parallel transition machine.

No setup composition, account/group mutation, unit installation, provider authorization, libvirt/qcow2 mutation, or Linux readiness claim is introduced by this checkpoint. Those effects remain in planned bricks 4–7 and fail closed because no Linux mechanics are attached to production setup.

## Hosted verification evidence

The working candidate passed, in dependency order:

1. `npm run preflight` — passed (`syntaxFiles: 43`, `jsonFiles: 2`, `targetedTests: 36`).
2. Repository-execution architecture gates from `.github/workflows/ci.yml` — 33 passed, 0 failed, 1 expected Windows symlink-capability skip.
3. Focused Linux/neutral/Windows authority tests — 80 passed, 0 failed, 1 expected Windows symlink-capability skip.
4. Full `npm test` — 1,167 passed, 0 failed, 8 platform-capability skips; 1,175 total.

Hosted evidence proves contract behavior and LEGO replaceability only. It does not substitute for a privileged Linux construction run or the physical KVM/libvirt qualification required by DB-020 and implementation-plan brick 7.
