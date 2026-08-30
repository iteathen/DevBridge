# DB-HO077 — issue #377 Linux principal capability-separation plan

Status: implementation and local qualification complete from exact baseline `6f0ec04d248a47b015bab6024ec5aa000b9f9ba6`; exact-head hosted qualification is pending.

This checkpoint owns one read-only pre-setup proof. It does not create or refresh a protected service, elevate, edit accounts or groups, change systemd or polkit policy, connect to the provider, inspect protected storage, run a VM or guest, execute repository code, or claim Linux readiness.

## Dependency assessment

Issue #376 established one exact provider-local classifier for the active management topology. For an accepted group-only topology it returns the selected neutral capability and every active full-management capability, including a compatibility surface when one exists.

The existing NSS-aware local-identity observer separately reports an account's configured numeric group set. The existing protected identity reconciler rejects configured ordinary membership in the selected management group, but it is a mutation owner used only after a protected claim exists. It neither proves the identity of the current ordinary process nor observes capabilities inherited by that already-running process.

That distinction is security relevant. Removing an account from a group does not rewrite the credentials of an existing process. Conversely, a configured membership that is not present in the current process is still an authority defect for a future session. A safe pre-setup decision must reject either condition across every management capability reported by the exact topology, not only the primary selected capability.

The protected service's later running-process proof remains a separate owner. It verifies the installed service process after reconciliation; it cannot substitute for the ordinary caller's negative proof before elevation.

Focused baseline tests for the existing topology and NSS observation pass 15/15 on baseline `6f0ec04d248a47b015bab6024ec5aa000b9f9ba6`.

## Primary-source research

Node documents `process.getuid()`, `process.geteuid()`, `process.getgid()`, `process.getegid()`, and `process.getgroups()` as POSIX credential observations. Its `getgroups()` result includes the effective group ID even where the platform's underlying list would omit it.

Linux `getgroups(2)` reports the supplementary group IDs of the calling process. Those are process credentials, not a live view of a named account's current NSS record. They are inherited through process creation and preserved across `execve()` unless an authorized credential transition changes them.

Linux pathname UNIX-domain socket access checks directory permissions and requires write permission on the socket inode for a connecting stream/datagram process. Therefore provider access must be evaluated against the current process credentials as well as configured membership.

Systemd initializes service supplementary groups from the user/group database and then extends them with `SupplementaryGroups=`. This reinforces the existing later requirement to prove the protected service's real running token independently; it does not authorize using the service definition as ordinary-process evidence.

Primary sources:

- [Node process credential APIs](https://nodejs.org/api/process.html#processgetgroups)
- [Linux `getgroups(2)`](https://man7.org/linux/man-pages/man2/getgroups.2.html)
- [Linux UNIX-domain socket permissions](https://man7.org/linux/man-pages/man7/unix.7.html)
- [systemd execution identity and supplementary groups](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml)

## Reassessment and selected boundary

Do not add another check to the identity mutator and do not merge current-process observation into the provider-topology classifier. Those modules own different facts and run at different authority points.

Implement three closed bricks:

1. A native current-principal adapter reads only fixed local process credential APIs and returns neutral numeric real/effective identity, primary-capability, and active-capability evidence. It performs no process or filesystem action and is explicitly unattached off Linux.
2. A pure provider-agnostic policy owner accepts only neutral numeric principal and restricted-capability values. It requires one non-privileged real/effective identity, one exact configured/current primary capability, bounded unique capability sets, and absence of every restricted capability from both configured and active sets.
3. One Linux composition root observes the accepted #376 topology, re-binds every returned capability name/ID through the existing NSS-aware observer, binds the named principal to the current process, and calls the pure policy. It returns a selected neutral capability only after the complete separation proof succeeds.

Configured-only membership and active-only inherited membership both fail closed. A compatibility capability is just as restrictive as the primary capability. Root, set-ID, missing, aliased, malformed, non-group-only, or observation-failure evidence produces no selection.

## LEGO boundaries

- The native credential adapter imports only the Node process API and knows no provider, lifecycle, setup, repository, VM, or caller topology.
- The pure policy imports no module. Its interface uses only `principal`, `identityId`, `primaryCapabilityId`, `configuredCapabilityIds`, `activeIdentityIds`, `activePrimaryCapabilityIds`, `activeCapabilityIds`, and `restrictedCapabilityIds`.
- The Linux composition root is the only module that composes the current topology, NSS records, native credentials, and policy result.
- The composition request carries only a neutral principal name plus platform applicability. It accepts no executable, argv, environment, path, unit, socket, provider object, service identity, lifecycle plan, or mutation port.
- The result carries only applicability, exactness, bounded separation state/reason, capabilities, and an optional selected capability. It carries no path, command, raw error, provider object, or foreign record type.
- No compatibility reader, legacy first-socket rule, or configured-membership-only shortcut is retained.

## Implementation and qualification plan

1. Implement and directly test the isolated native credential adapter, including real/effective mismatch, privileged identity, malformed/duplicate/unbounded group evidence, non-Linux behavior, and exact interface shape.
2. Implement and directly test the pure separation owner, including configured-only, active-only, primary, compatibility, alias, mismatch, and widened-contract cases.
3. Implement and test the Linux composition root against exact group-only topology, NSS name/ID binding, multiple active capabilities, observation failures, and non-group-only fail-closed behavior.
4. Add one focused test file and only the parent source to preflight; the focused test must import and exercise both children so Windows smoke does not pay redundant process-launch cost.
5. Run focused tests, repository preflight, Linux authority selection, repository-execution architecture gates, the full suite, doctor, generated/diff hygiene, and exact-head Windows/Ubuntu CI.
6. Close only #377 after exact-head hosted acceptance. Keep #293 open for plan composition, protected identity reconciliation, bounded elevation, positive noninteractive provider access, protected storage, and physical libvirt/qcow2/guest qualification.

No privileged or physical effect is authorized by this plan.

## Implementation

`current-principal-capabilities.js` is a leaf native adapter. On Linux it reads the calling process's real/effective identity IDs, real/effective primary capability IDs, and active capability IDs through the fixed Node process APIs. It requires bounded unique active evidence and the documented effective-primary inclusion. Off Linux it is explicitly unattached and invokes no port.

`capability-separation.js` is an import-free pure policy owner. Its strict neutral value contract rejects privileged identity, real/effective identity drift, configured/current primary-capability drift, missing primary evidence, aliased or invalid restricted capabilities, configured restricted membership, and active restricted membership. It knows no Linux, provider, lifecycle, setup, repository, VM, command, or path topology.

`linux-provider-authority-preflight.js` is the sole composition root. It accepts only a neutral principal name and platform applicability, obtains the exact group-only topology, re-binds every capability name/ID through NSS, binds the configured non-root principal to the current process, and delegates the set decision to the pure policy. It returns the selected neutral capability only when the complete proof succeeds. Every child/result boundary has an exact schema; raw or unbounded child reasons are replaced with bounded local reason codes.

Configured-only and inherited-active-only management membership are independently rejected. The restricted set includes every active topology capability rather than only the primary selection, so a compatibility surface cannot be ignored. No configured-membership-only shortcut or compatibility implementation was retained.

Repository preflight launches only the one focused test file and syntax-checks the composition root. That test imports and exercises both children directly, preserving coverage without adding redundant Windows smoke processes.

## Local qualification

Qualification completed in dependency order:

- focused new capability-preflight tests: 10 passed, 0 failed;
- topology plus NSS plus new preflight selection: 25 passed, 0 failed;
- repository preflight: 2 standalone artifacts, 204 syntax files, 2 JSON files, and 168 targeted test files passed;
- Linux/authority selection: 238 total, 231 passed, 7 expected Windows platform skips, 0 failed;
- repository-execution architecture gates: 34 total, 33 passed, 1 expected Windows symlink-capability skip, 0 failed;
- complete serialized repository suite: 1,840 total, 1,824 passed, 16 expected platform skips, 0 failed;
- doctor: `ok: true`, coding adapters disabled, and repository execution unavailable/fail-closed because no local persistent-environment route is configured;
- standalone artifact regeneration check: exact; and
- `git diff --check`: passed apart from informational Windows working-copy line-ending warnings.

No setup, elevation, account/group mutation, service/systemd/polkit action, provider connection, protected-storage/VM/guest action, repository execution, or model invocation occurred. Exact-head Ubuntu and Windows CI remain required before issue #377 can close. Parent #293 remains open afterward.
