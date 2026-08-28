# DB-HO025 — issue #340 Linux volatile endpoint topology

Status: planned from exact `cuda-target` baseline `58570958ca4e8ebd3c6fd979265a62624e8360de` on isolated branch `security/340-linux-endpoint-topology`.

## Assessment

DB-HO024 made unit bytes, loaded-manager state, and startup persistence exact, but the broader Linux lifecycle plan still describes endpoint inode evidence that its service cannot physically produce. The unit has one `UMask=0007`, while the plan expects the read socket to be service/read `0770` and the mutation socket to be service/root `0700`. Both sockets are created by the same Node process with the same effective primary group and umask. Hosted inspection tests manufactured the desired inode facts and therefore did not exercise this physical contradiction.

The endpoint parent directories are also beneath `/run`, so they disappear on reboot. Setup can create them for the current boot, but the enabled service needs a boot-persistent declaration that restores the exact split directory policy before it starts. No current module owns such a declaration.

The higher lifecycle composer must not hide either problem with a post-bind `chmod`, a second service process, a broad root pre-start command, or an assumption that setup runs after every reboot.

## Primary research

Linux documents that a pathname socket receives the usual owner and group and is created with all permission bits except those removed by the process umask. Connecting also requires directory search permission, while creating or replacing the socket path requires write plus search permission on its parent. The service's two sockets therefore naturally share service/read `0770` inode policy under `UMask=0007`; the service-owned `0700` mutation parent is the enforceable capability split.

Systemd's tmpfiles contract provides `d` entries that create directories and adjust the declared mode and ownership. `systemd-tmpfiles --create` accepts selected configuration files, and the normal boot setup applies installed `tmpfiles.d` definitions. The existing unit's `PrivateTmp=true` adds an automatic ordering dependency after `systemd-tmpfiles-setup.service`; no neighboring boot-unit name needs to be copied into the rendered DevBridge unit.

Systemd `RuntimeDirectory=` is not selected because one service-level `RuntimeDirectoryMode=` and service user/group do not express the required read and mutation parent policies independently. Post-bind socket mutation is not selected because it creates an avoidable interval with the wrong evidence, and socket-activation would widen this prerequisite into a new transport/process topology.

Primary sources:

- [Linux pathname socket ownership and permissions](https://man7.org/linux/man-pages/man7/unix.7.html)
- [systemd tmpfiles definitions](https://github.com/systemd/systemd/blob/main/man/tmpfiles.d.xml)
- [systemd-tmpfiles invocation and boot behavior](https://www.freedesktop.org/software/systemd/man/systemd-tmpfiles.html)
- [systemd execution dependencies and directory behavior](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml)
- [systemd service default dependency ordering](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml)
- [Node.js pathname IPC behavior](https://nodejs.org/download/release/latest-v22.x/docs/api/net.html)

## Reassessment and ownership boundary

This is a lower Linux topology prerequisite, not yet the shared lifecycle mechanic:

1. The Linux plan owns one exact root-owned `0644` volatile-directory definition and separately describes directory versus socket policy. The read socket and mutation socket both use the process-realistic service/read `0770` policy. The mutation parent remains service/root `0700`, so read-group members cannot search, connect through, create, remove, or substitute its endpoint name.
2. A fixed Linux definition applicator owns only `/usr/bin/systemd-tmpfiles --create <exact-local-definition>`, bounded invocation, cancellation, minimal locale, and path-free failure evidence. It does not accept rule bytes, directory paths, users, groups, or commands.
3. A lifecycle-local endpoint composition owns the mapping from the exact plan and immutable numeric identity into protected definition storage and four exact directory observations. It publishes only the target bytes, refuses foreign existing definitions or directory policy, invokes the applicator only when an admitted directory is absent, and re-observes every postcondition.

The composition receives neutral state, inspect, load, save, and apply studs. It performs no account, service, provider, VM, elevation, repository, transport, or lifecycle-refresh sequencing. The later mechanic will call it after numeric identity binding and before service activation.

## Plan

1. Correct the Linux plan and inspection schema so endpoint directories and socket inodes have separate exact owner/group/mode facts; remove the impossible mutation socket expectation instead of retaining compatibility fields.
2. Render one bounded deterministic `tmpfiles.d` definition for the shared runtime parent, authority runtime root, read parent, and mutation parent. Restrict its path vocabulary so no tmpfiles specifier or field escape is possible.
3. Add the fixed noninteractive definition applicator with strict request/port schemas, fixed executable and arguments, bounded time/output, cancellation, no inherited environment, and bounded errors.
4. Add the endpoint-topology composition over the existing protected storage contract. Require an established lifecycle ownership claim and immutable numeric identity before any definition or directory effect.
5. Prove fresh publication/application, exact no-op, publication-interruption recovery, already-published reboot recovery, foreign definition/directory refusal, inexact lower evidence, non-Linux detachment, physically realistic socket inspection, and source isolation.
6. Add focused suites to repository preflight; run related Linux authority tests, repository preflight, repository-execution architecture gates, and the full suite before isolated publication.

No real filesystem, account, system manager, tmpfiles, service, provider, VM, sudo, or UAC action belongs to hosted qualification. Issue #293 remains open after this prerequisite for lifecycle mechanics, one-command elevation, provider authorization, state migration, ordinary-negative/protected-positive evidence, and physical KVM/libvirt/qcow2 qualification.
