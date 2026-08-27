# DB-HO011 — issue #293 Linux protected mechanics plan

Status: numeric-identity foundation implemented and hosted-qualified; filesystem/runtime/unit mechanics remain active. This checkpoint begins at exact recovery head `db5ea279862dae8a566045ea28bd6c3e81b48ebc` on isolated branch `security/293-linux-protected-mechanics`. It extends DB-HO010 bricks 1–3; it does not attach setup elevation, provider authorization, or Linux readiness.

## Assessment of the preserved draft

Historical draft PR #295 did not contain protected mutation mechanics or shared-reconciler attachment. Its final protection verifier assumed a broad provider group, consumed an obsolete inspection shape, and tested path access rather than the exact running process and provider topology. The draft is preserved as historical evidence but is not a code source for this brick.

The current recovery head already provides the correct connection studs:

- one bound Linux plan with neutral local identities and content-addressed runtime paths;
- NSS-aware identity observation;
- read-only systemd/process/filesystem/runtime inspection;
- one platform-neutral refresh contract around the durable protected-authority reconciler.

The missing owner is a Linux-local mechanics adapter. It may create and reconcile only the service account, local capability groups, protected runtime/state, systemd unit, and service lifecycle. Libvirt socket/polkit/domain/storage authorization remains a separate later adapter.

## Primary-source findings

Shadow-utils documents two deliberately different supplementary-group operations:

- `usermod -G` replaces a user's supplementary groups, removing membership not listed;
- `usermod -a -G` appends groups without removing existing memberships.

The dedicated service account is installation-owned, so its supplementary set can and must be reconciled exactly to coordination plus management, with read as its primary group. The ordinary operator is not installation-owned; setup may append only the read and coordination groups and must never replace unrelated memberships or add management authority. If the operator is already a management-group member, setup fails closed instead of treating that authority as acceptable.

Shadow-utils also documents system accounts/groups, explicit primary and supplementary groups, no-home creation, and explicit login shell selection. The adapter will invoke fixed absolute shadow-utils binaries with structural argument arrays and no shell.

Systemd documents that enabling a unit creates the links encoded by `[Install]`, reloads manager configuration, and does not start the unit. Promotion and start therefore remain separate reconciler effects. Readiness must observe both the exact unit bytes and its enabled state; `daemon-reload` or `enable` success alone is not evidence.

Primary sources:

- [shadow-utils `usermod`](https://github.com/shadow-maint/shadow/blob/master/man/usermod.8.xml)
- [shadow-utils `useradd`](https://github.com/shadow-maint/shadow/blob/master/man/useradd.8.xml)
- [shadow-utils `groupadd`](https://github.com/shadow-maint/shadow/blob/master/man/groupadd.8.xml)
- [systemd `systemctl`](https://github.com/systemd/systemd/blob/main/man/systemctl.xml)

## Reassessment and invariants

1. **No name-only adoption.** Deterministic names reduce collision probability but do not prove ownership. Before the root-owned installation record exists, any matching account or group makes the installation foreign. After creation, the record binds the exact service UID and three GIDs; later name reuse or numeric aliasing blocks.
2. **Claim before mutation.** The shared refresh journal's first durable save initializes the exact root-owned installation record before account, runtime, unit, or service mutation. An absent exact root may be adopted only when it is a root-owned empty interrupted claim below the fixed protected parent; unexpected entries block.
3. **Atomic records and files.** Ownership, refresh, generation, and unit bytes are written through same-directory temporary files, re-observed, ownership/mode-set, and atomically renamed. Exact destination indirection, wrong ownership, or unsupported objects block.
4. **Immutable generations.** A generation is built under its exact staging child, measured and access-verified completely, and renamed into the immutable generation directory. An existing exact generation is reused only after full verification; an invalid colliding generation is never overwritten or cleaned automatically.
5. **Observation before replay.** Every shared stage/quiesce/promote/start/restore effect is followed by the shared reconciler's observation. Each local mechanic is idempotent and re-observes its narrower filesystem/identity/systemd effects before repeating after interruption.
6. **Ownership update last.** Staging sets `stagedGeneration` only after identity/runtime/state evidence is exact. Promotion/restoration replace and reload/enable the exact unit before moving `activeGeneration`; the ownership record is the last mutation in those effects.
7. **Provider separation.** The management group is only a neutral local capability stud. This brick does not inspect or change libvirt sockets, daemon mode, polkit, domains, pools, volumes, qcow2, or provider configuration.
8. **No readiness shortcut.** Health requires exact identities, numeric ownership binding, enabled/running `Type=exec` service, actual process token/executable, unit bytes, filesystem/endpoints, and complete runtime evidence. Until setup composition and provider proof exist, Linux remains unavailable in production.

## Dependency-scoped implementation plan

1. Extend Linux ownership/runtime projection so exact historical generations can be reconstructed and verified for rollback without filename inference.
2. Extend read-only inspection with numeric UID/GID binding and systemd unit enablement evidence.
3. Add a root-owned atomic record store and exact protected-path/file operations behind injected filesystem ports.
4. Add bounded fixed-command identity reconciliation with fresh, resumed, foreign, alias, exact-service-group, append-only-operator, and management-denial tests.
5. Add generation stage/verify mechanics using the accepted package snapshot and executable evidence; reject indirection, collisions, widening, source drift, and incomplete copies.
6. Add unit quiesce/promote/start/restore/health mechanics and map them to the neutral Linux refresh facade. Prove fresh, no-op, interruption, ambiguity, failed health, and exact rollback behavior with fakes.
7. Run focused Linux/neutral/Windows authority tests, repository preflight, repository-execution architecture gates, and the full suite. Publish only an isolated PR; keep #293 open.

The immediate frontier is steps 1–4, then generation/service mechanics. No command in this plan is executed against the current Windows host.

## Implemented numeric-identity sub-brick

This isolated checkpoint completes the identity prerequisites without filesystem or service mutation:

- Linux runtime projection can reconstruct exact historical generation paths and unit bytes from the generation record's package and executable digests. Rollback does not infer lineage from a filename.
- The ownership schema binds the exact non-root service UID and distinct non-root read, coordination, and management GIDs. A same-name numeric replacement invalidates ownership evidence.
- Read-only systemd evidence now includes `UnitFileState`; readiness can distinguish an exact loaded/running unit from an enabled installation.
- `linux-local-identity-reconciliation.js` owns only the fixed shadow-utils contract. A caller must present an established protected claim. Fresh creation uses fixed absolute `groupadd`/`useradd`; service supplementary groups are replaced exactly with `usermod -G`; ordinary read/coordination membership is append-only with `usermod -a -G`; ordinary management membership and numeric drift block before mutation.
- The identity brick imports no plan, filesystem, systemd, provider, or protected-reconciler type. Linux lifecycle composition will project its local contract into this neutral interface later.

No Linux command ran on the Windows development host. Executable tests used injected NSS and process adapters.

## Hosted evidence for this sub-brick

- focused Linux/neutral/Windows authority tests: 52 passed, 0 failed;
- `npm run preflight`: passed (`syntaxFiles: 43`, `jsonFiles: 2`, `targetedTests: 36`);
- repository-execution architecture gates: 33 passed, 0 failed, 1 expected Windows symlink-capability skip;
- full `npm test`: 1,174 passed, 0 failed, 8 platform-capability skips; 1,182 total.

This evidence completes plan steps 1, 2, and 4's identity portion. Atomic protected-file operations, generation staging, ownership/journal persistence, unit lifecycle mechanics, shared refresh composition, setup/elevation, provider authorization, and physical qualification remain unfinished and fail closed.
