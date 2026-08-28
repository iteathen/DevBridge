# DB-HO025 — issue #340 Linux volatile endpoint topology

Status: implemented, locally qualified, clean-checkout qualified, and integrated into `cuda-target` as `3691a40c9ae9a58596f8fdac94081e2c0fbc2c2a` through isolated PR #341.

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

## Implementation

The Linux lifecycle plan now owns a deterministic root-owned `0644` definition beneath `/etc/tmpfiles.d`. Its pathname vocabulary is normalized, specifier-free, whitespace-free, and restricted to an exact descendant of `/run`. The definition declares only the shared runtime parent, the authority-specific root, the read parent, and the mutation parent. Directory policy and process-created socket policy are separate facts; no compatibility `owner`/`group` fields remain.

The mutation endpoint now records the physically producible service/read-group `0770` socket inode created under the unit's single `UMask=0007`. Its service/root `0700` parent is the mutation capability boundary. Read access can traverse the service/read `0750` read parent but cannot search the mutation parent.

`linux-directory-definition-applicator.js` owns one fixed operation: apply one safe basename directly beneath `/etc/tmpfiles.d` with `/usr/bin/systemd-tmpfiles --create`. The executable, argument prefix, locale, input, timeout, output bound, and failure text are local constants. The caller cannot supply rule bytes, target directories, identities, commands, environment, or executable selection.

`linux-lifecycle-authority-endpoint-topology.js` owns only the lifecycle-local composition. It requires the already-established ownership record and immutable numeric identity, observes the definition parent and every target before an effect, admits only the exact rendered bytes, publishes through protected storage, invokes the neutral `apply` stud only for absent volatile directories, and re-observes all postconditions. Existing wrong policy or foreign bytes fail before mutation. A lost response after definition publication resumes by observing the installed bytes; a reboot with an exact persistent definition but absent `/run` directories applies without rewriting it.

The broad read-only lifecycle inspection now includes independent definition-file policy, exact definition bytes, the shared runtime parent, and realistic socket inode evidence. A stopped endpoint remains distinct from runtime identity readiness.

## Local qualification

No elevated command, UAC prompt, system-manager mutation, tmpfiles mutation, account change, service change, or VM/provider effect was executed.

- Focused and related Linux boundary selection: 104 total, 101 passed, 3 expected non-Linux skips, 0 failed.
- Repository preflight: 45 syntax files, 2 JSON files, 47 targeted test files, passed.
- Repository-execution architecture gates: 34 total, 33 passed, 1 expected Windows symlink-capability skip, 0 failed.
- Full suite: 1,283 total, 1,272 passed, 11 expected platform skips, 0 failed, with a normal TAP exit in 53.2 seconds.
- Doctor smoke: `ok: true`; repository execution remained explicitly unavailable/fail-closed because no persistent-environment route is configured.

Hosted CI and physical Linux qualification remain distinct gates. This slice can prove the deterministic contracts on Windows and later through clean Ubuntu CI, but it cannot claim real tmpfiles creation, boot recreation, ordinary-user denial, or protected-service access until the bounded elevated Linux setup and dedicated physical qualification are implemented.

## Hosted integration evidence

PR [#341](https://github.com/iteathen/DevBridge/pull/341) qualified exact implementation head `57b96f89b499c800ddcb6313a3c4d77a578f9e04` in CI run [33133508439](https://github.com/iteathen/DevBridge/actions/runs/33133508439):

- Ubuntu smoke/preflight passed in 19 seconds;
- Ubuntu architecture gates, full suite, and doctor passed in 31 seconds;
- Windows smoke/preflight passed in 45 seconds;
- Windows architecture gates, full suite, and doctor passed in 3 minutes 2 seconds.

The PR was squash-integrated as `3691a40c9ae9a58596f8fdac94081e2c0fbc2c2a`. The reviewed head and integrated commit have the same Git tree, `055c92439a9be1009d77ed63c2729d7cff9892a6`, so integration changed commit history but not qualified source, tests, or documentation bytes.
