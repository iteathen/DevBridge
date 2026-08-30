# DB-HO085 — issue #385 Linux setup authentication attachment

Status: assessment, primary research, reassessment, and implementation plan recorded before code changes.

This is a no-elevation software integration under #293. Development and qualification must not invoke `sudo`, `pkexec`, UAC, the authenticated child, protected service/provider/storage mutation, a VM or guest, repository execution, or a coding model.

## Required preflight and assessment

The VM-program planning gate was repeated before design. DB-003, DB-007, DB-009, DB-019, DB-020, `docs/vm-migration.md`, `docs/vm-lego-studs.md`, `docs/vm-stage6-repository-execution.md`, and `docs/environment-lifecycle-authority.md` were read with parent #293 and accepted #382/#384. The exact implementation being extended was inspected through setup's current lifecycle-authority default and result projection, Linux plan selection/readiness, the neutral one-attempt reconciler, the fixed CLI authentication adapter/entry, and the existing Linux protected configuration proxy.

The accepted bricks are complete but disconnected from setup:

- Linux ordinary readiness alone decides whether installed evidence is ready and emits the unchanged frozen protected-child subject only when a repair is admissible;
- the import-free protected-readiness policy alone permits at most one opaque attempt and accepts success only after complete fresh observation;
- the fixed CLI adapter alone owns `/usr/bin/sudo -- <current Node> <fixed entry>`, strips caller environment, exposes no password channel or fallback, and returns non-authoritative status; and
- the protected configuration proxy alone binds the accepted revision/digest, publishes the fixed handoff, invokes the distinct protected endpoint, and re-observes exact configuration.

`runDevBridgeSetup()` still defaults every platform to `reconcileWindowsLifecycleAuthorityReadiness`. Its identity is the authenticated GitHub account, which is remote provenance and cannot become the local Linux principal. No setup owner selects the Linux path, observes the current local principal independently, attaches the accepted one-attempt policy, or continues through protected configuration after readiness.

## Primary-source research

Node.js 22.16.0 documents `os.userInfo()` as information about the currently effective user. On POSIX it returns `username`, `uid`, and `gid` together with home and shell data, and throws when the OS supplies no username or home directory. This is suitable only as an OS observation: setup must project the three needed neutral fields, validate them, and cross-check the numeric values against real/effective process credentials. Environment variables and the GitHub identity are not substitutes.

Primary source, accessed 2026-08-29:

- [Node.js 22.16.0 `os.userInfo()`](https://nodejs.org/download/release/v22.16.0/docs/api/os.html#osuserinfooptions)

The fixed `sudo` command, terminal-authentication behavior, descriptor-bound executable identity, minimal environment, and no-fallback decision remain governed by the already accepted primary research in `DB-HO084` and are not reimplemented here.

## Reassessment and selected ownership

The missing design is one application composition edge and one independent local observation leaf, not another refresh state machine or authentication mechanism.

A self-contained current-principal observer owns only a neutral `{ name, identityId, primaryCapabilityId }` record. It reads the effective OS record and real/effective numeric credentials through narrow local ports, requires one exact non-root identity and primary capability, rejects unknown/widened/malformed evidence, and emits no platform topology, environment, path, credential, or authority grant. Linux readiness still independently re-resolves NSS identity and current group state.

A setup lifecycle-authority composition root is the sole topology edge. Windows delegates to the existing Windows reconciler. Linux observes the current principal, attaches `observeLinuxLifecycleAuthorityReadiness` and `attemptLinuxCliAuthentication` through `reconcileProtectedReadiness`, and never interprets the authentication result. Only the policy's fresh second observation can establish readiness. Unsupported platforms return a bounded fail-closed result without attaching a foreign adapter.

After Linux readiness, the same root uses setup's existing configuration contract: inspect through the neutral lifecycle client, reconcile through the existing protected configuration proxy only when needed, then inspect again. This does not add provider knowledge, a second configuration algorithm, or direct protected-state access.

The setup-local result remains bounded and path-free. It may report readiness, whether one bounded attempt or configuration reconciliation occurred, a neutral state, and a fixed diagnostic. It never exposes principal data, executable identity, child output, authentication output, paths, provider/service objects, or protected subjects.

## Scoped implementation plan

1. Add the import-free current-principal value/validation owner and a tiny Node/OS composition adapter that supplies only effective username/UID/GID plus real/effective numeric credentials.
2. Add the setup lifecycle-authority composition root with exact platform selection, Windows delegation, Linux readiness/one-attempt attachment, unsupported-platform denial, and bounded result projection.
3. Compose the existing configuration contract after Linux readiness: inspect, reconcile if required, and re-inspect before returning ready.
4. Replace setup's Windows-only default with the new root. Delete the direct default import; add no compatibility route or alternate setup path.
5. Test exact-current/no-attempt, one repair attempt, thrown/failed attempt, invalid fresh observation, principal drift/root/malformed evidence, configuration no-op/reconcile/re-observation/failure, Windows-only delegation, unsupported-platform denial, bounded output, and source isolation.
6. Add new sources/tests to repository preflight. Hosted Ubuntu must execute the production current-principal observation canary but must never invoke authentication.
7. Run focused current and exact Node 22.16.0 tests, wider Linux/setup boundaries, preflight, repository-execution architecture gates, complete serialized suite, doctor, generated-artifact identity, and diff hygiene.
8. Commit and push the isolated implementation, require exact-head Ubuntu/Windows smoke/full CI, document acceptance, and close only #385 after the documentation head is green. Keep #293/#372/#373 open for physical gates.

## Explicit nonclaims

This slice cannot prove an installed Linux systemd service, real authentication success, protected libvirt/qcow2 access, provider/storage separation, VM/guest operation, repository execution, or the Linux C canary. Physical Linux and Windows acceptance remain separate Stage 7/8 gates. No fallback to host repository execution or model execution is introduced.
