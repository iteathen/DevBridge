# DB-HO029 — issue #352 exact Linux lifecycle/daemon activity gate

Status: implemented and locally qualified from exact `cuda-target` baseline `69f6f80b317fe916cccaed47f040419893083e2e` on isolated branch `security/352-linux-activity-gate`; the first exact-head CI attempt exposed two portability defects, corrected locally, and the corrected exact head still requires Ubuntu/Windows CI before integration.

## Assessment

The protected Linux authority now composes the shared refresh mechanic, but its internal environment lifecycle fence still derives `<stateDirectory>/daemon.lock`. The service cannot traverse the ordinary state root under the intended filesystem policy. The lifecycle plan also labels the ordinary `environment-foundation` subtree as a coordination directory even though that subtree owns unrelated ordinary routing/control data.

Granting the service either the state root or the ordinary foundation subtree would be an ownership leak. Moving the existing pause files into a shared directory is also insufficient. DB-018 deliberately preserves a pre-existing operator pause; another process using the ordinary identity can release that pause. A peer-authored acknowledgement file proves only bytes and ownership available to that ordinary identity, not exclusive absence of an active daemon cycle.

The required local invariant is narrower:

> A lifecycle effect starts only while no ordinary daemon cycle is active, and no new cycle starts until that exact lifecycle effect releases its gate.

The daemon lock, DB-018 operator pause, lifecycle journals, and environment ownership remain separate owners. This gate must not become another daemon identity, scheduler, environment journal, provider lock, or remote capability.

The first reassessment considered one protected-effect intent plus the kernel lease. A second crash-order review rejected that design before implementation: if the helper holding a shared lease died while its caller was still completing an admitted activity, the protected side could acquire the now-released kernel lock and overlap that activity. An intent only on the protected side prevents new shared admission after protected-holder loss, but it does not preserve evidence of shared-holder loss. Correct crash closure therefore requires owner-separated participation intent on both sides.

## Primary research

Linux `flock(2)` supplies shared and exclusive advisory locks associated with an open file description. Conflicting modes block or return `EWOULDBLOCK`; locks survive `execve(2)` and are released when the last associated descriptor closes. This makes a fixed helper process a crash-releasing lease holder without requiring a Node native extension.

Linux directory rules provide the remaining filesystem boundary:

- a set-group-ID directory makes newly created files inherit its group;
- a sticky directory allows rename/delete only by the entry owner, directory owner, or a privileged process;
- path traversal requires search permission on every directory;
- `open(2)` creation modes are filtered by `umask`, so post-create policy observation is mandatory; and
- systemd tmpfiles `d` and `f` entries establish and reapply an exact volatile path type, mode, owner, and group. Directory special bits are valid mode state.

The util-linux `flock(1)` wrapper can acquire the kernel lock and execute one fixed command without a shell. `--no-fork` replaces the wrapper with the fixed holder after acquisition, so the spawned PID and its standard-input lifetime remain the local lease handle.

Primary sources:

- [Linux `flock(2)`](https://man7.org/linux/man-pages/man2/flock.2.html)
- [Linux inode ownership and SGID/sticky semantics](https://man7.org/linux/man-pages/man7/inode.7.html)
- [Linux `open(2)` creation and `umask` semantics](https://man7.org/linux/man-pages/man2/open.2.html)
- [Linux `unlink(2)` sticky-directory enforcement](https://man7.org/linux/man-pages/man2/unlink.2.html)
- [Linux path resolution permissions](https://man7.org/linux/man-pages/man7/path_resolution.7.html)
- [util-linux `flock(1)`](https://man7.org/linux/man-pages/man1/flock.1.html)
- [systemd `tmpfiles.d`](https://github.com/systemd/systemd/blob/main/man/tmpfiles.d.xml)

## Reassessment and selected design

Use owner-separated participation intents plus a kernel lease. Neither mechanism is sufficient alone; together they close both race orders and either lease-holder's loss.

The Linux lifecycle topology receives a dedicated volatile governance directory below the already installation-scoped `/run/devbridge/<authority-id>` root:

- directory: root-owned, coordination-group, mode `03770` (setgid + sticky + owner/group access);
- lock subject: root-owned, coordination-group, mode `0660`;
- exclusive intent: created only by the protected identity, mode `0640`, inheriting the coordination group;
- shared intent: created only by the ordinary identity, mode `0640`, inheriting the coordination group.

Root owns the shared directory. The ordinary and protected participants can create their own entries but cannot delete or replace the other identity's entry. The lock subject is pre-provisioned by root and cannot be replaced by either participant. Each intent path is fixed and carries only the neutral subject and operation ID; it accepts no caller-selected path, provider object, command, or topology value.

The neutral gate has two independently composable sides:

1. **shared admission** observes no exclusive intent, publishes its exact shared intent, acquires a shared lease, then re-observes both records before returning the lease;
2. **exclusive admission** publishes or resumes its exact exclusive intent, acquires the exclusive lease, re-observes both records, and returns the lease only when no shared intent remains.

The observations make every ordering safe. If shared admission wins the lease first, exclusive admission waits for release. If exclusive intent publishes first, shared admission does not enter. If either intent appears between the peer's first observation and lease acquisition, the post-acquisition observations release the kernel lease and refuse admission. The peer that acquires during the release-to-clear gap still observes the retained intent and also refuses admission.

Normal release starts only after the admitted activity has completed. It clears only that side's exact intent while the kernel lease still serializes the handoff, then releases the lease last. A clear failure therefore retains the kernel exclusion; a lease-release failure occurs only after the activity is complete. Unexpected holder death during active work releases the kernel lock but leaves its owner-separated intent, so the peer remains blocked. The ordinary daemon may reconcile only its own stale shared intent after it has acquired the existing exclusive DB-018 daemon lock, which proves the prior daemon session is no longer active; the protected identity cannot clear that record. Protected stale intent remains tied to durable lifecycle reconciliation. Host reboot clears `/run` after both processes have ceased; durable environment journals remain the owners of incomplete provider effects.

## LEGO boundaries

- The neutral mechanic knows only local and peer `intent.observe/ensure/clear` ports and `lease.acquire/release` contracts plus neutral `subject` and `operationId` values.
- The fixed holder entrypoint knows only that it must emit one readiness protocol and remain alive until standard input closes.
- The Linux lease adapter alone knows `flock`, the fixed absolute executable, modes, timeout, child lifecycle, and holder location.
- The Linux intent adapter alone knows the fixed local record path and filesystem policy.
- The Linux lifecycle topology owner alone derives the governance directory/subjects and tmpfiles definition.
- The daemon receives only a shared-admission port. It does not learn lifecycle, Linux, systemd, path, provider, or service identities.
- The lifecycle fence receives only an exclusive-admission port. It no longer derives daemon topology internally.

## Plan

1. Implement and fault-test the closed neutral shared/exclusive gate mechanic with owner-separated local/peer intents and no imports or topology names.
2. Add a path-free holder entrypoint and a Linux `flock` lease adapter using fixed executable/argv/environment, bounded acquisition/readiness/output/release/cancellation, and `shell: false`.
3. Add strict Linux intent stores with atomic exclusive publication, exact owner/group/mode/content re-observation, exact-only owner-side clearing, symlink/foreign/substitution rejection, and bounded bytes.
4. Move the Linux plan's coordination stud from ordinary persistent state to a dedicated volatile governance directory; extend its tmpfiles definition and endpoint-topology verifier with the exact directory and lock subject.
5. Remove ordinary-state coordination preparation from the refresh composition; endpoint topology remains the sole owner of volatile governance paths.
6. Refactor the environment lifecycle fence to consume an injected exclusive-admission contract instead of a state path, then compose the Linux protected host with the Linux gate.
7. Let the daemon optionally consume one neutral shared-admission contract around each `runCycle`; compose the Linux CLI with the Linux gate while leaving DB-018 pause/status/stop ownership unchanged.
8. Prove each intent-before-peer, each intent-between-observations, shared-before-exclusive, normal release ordering, either holder's death, stale exact intent, daemon-lock-bound shared recovery, timeout/cancellation, malformed/foreign state, absent topology/tool, no-shell/fixed-argv, and interface/source isolation.
9. Run preflight, architecture gates, Linux/shared selections, the full repository suite, and doctor. Require exact-head Ubuntu/Windows CI before integration.

## Implementation checkpoint

The implementation follows the selected owner split:

- `activity-gate.js` owns only the closed shared/exclusive intent-and-lease state machine. It rejects widened requests/evidence and has no OS, process, path, lifecycle, daemon, provider, or repository vocabulary.
- `activity-lease-holder.mjs` is a path-free fixed child. `linux-file-lease.js` alone owns `/usr/bin/flock`, the fixed no-shell argv/environment, acquisition/release time bounds, output bounds, cancellation, and unexpected-holder-death evidence.
- `linux-intent-store.js` alone owns canonical bounded intent bytes and exact no-follow owner/group/mode/link/inode/directory observations, atomic exclusive publication, sync, and exact-only removal.
- The Linux lifecycle plan and tmpfiles owner now establish `/run/devbridge/<authority>/governance`, its root-owned lock subject, and owner-separated intent paths. Inspection and topology reconciliation independently prove the governance directory and lock. Ordinary persistent foundation state is no longer projected as lifecycle coordination.
- The Linux composition binds its fixed volatile paths to exact process and filesystem identity. The ordinary side obtains only shared admission; the protected side additionally proves the root-owned canonical ownership record and receives only exclusive admission.
- The protected Linux service constructs the exclusive admission before its host/operator. The generic lifecycle fence receives only that neutral admission. Its former daemon-lock knowledge moved into a separate explicit DB-018 pause adapter used by the existing ordinary/Windows composition.
- The daemon receives only an optional neutral shared-admission port. After acquiring its existing singleton lock it reconciles only its own stale shared intent, holds one exact admission around `runCycle`, and emits a deferred result without running a cycle when admission is refused. DB-018 pause, resume, stop, and singleton ownership remain unchanged.
- Environment lifecycle callers now use neutral `subject`/`operationId` fence inputs rather than a caller-specific identity property.

## Local qualification

Qualification on Windows from the isolated worktree completed with:

- focused gate, adapter, composition, daemon, lifecycle, Linux topology/inspection, and Windows regression selection: 88 tests total, 86 passed, 2 expected real-Linux skips, 0 failed;
- repository preflight: passed with 50 syntax files, 2 JSON files, and 50 targeted tests;
- repository-execution architecture gates: 34 total, 33 passed, 1 expected Windows symlink-capability skip, 0 failed;
- full repository suite: 1,343 total, 1,330 passed, 13 expected platform skips, 0 failed; and
- doctor: exited successfully and truthfully reported repository execution unavailable because no local persistent-environment route is configured.

These results prove the neutral mechanics, composition, fault closure, source isolation, and Windows regression boundary. They do not substitute for the skipped real Linux filesystem/process canaries or exact-head Ubuntu CI. No real Linux service installation, elevation, libvirt/qcow2 effect, or VM execution readiness is claimed by this checkpoint.

## First exact-head CI fault discovery

PR #353 at exact head `c9947ffe2c988c9c6fa7b64189fa51b443666d7f` produced useful cross-platform evidence rather than an integration result:

- Ubuntu reached the real intent-store canary and rejected the default `node:fs` constants object because the adapter passed the entire platform constant namespace into its own exact five-flag contract. The corrected composition projects only `O_RDONLY`, `O_WRONLY`, `O_CREAT`, `O_EXCL`, and `O_NOFOLLOW`; unrelated platform constants never enter the port.
- Both CI platforms found that acquisition/release deadline timers had been detached from the event loop. A real child normally kept the process alive, while a deliberately unobservable fake child did not, so the test promise could remain pending after the event loop drained. These timers are authoritative completion bounds, not background conveniences; the correction keeps them referenced until the operation settles and clears them on observed completion.
- The Windows preflight timeout was the same pending-promise defect surfacing through the targeted suite, not a reason to widen its one-minute cost bound.

This is a reusable Stage-7 lesson: real-platform canaries must exercise the default adapter composition, and any timer that owns an operation's terminal evidence must itself keep the process live until that evidence is produced.

## Explicitly deferred

This slice does not implement sudo/elevation, accounts or systemd installation, provider/libvirt authorization, qcow2 mutation, VM execution, ordinary production client cutover, Windows topology changes, GPU/CUDA behavior, or arbitrary stale-state cleanup. It creates the exact coordination stud those later owners may use.
