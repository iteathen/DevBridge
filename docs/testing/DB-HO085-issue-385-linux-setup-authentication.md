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

## Implementation checkpoint

The implementation preserves four independent ownership layers:

- `current-principal-observation.js` is import-free and owns only exact principal evidence. Its request is empty; its five neutral observation ports project one local name/UID/GID record plus real/effective numeric credentials. Root, credential drift, widened/hidden/symbolic/accessor evidence, invalid names/IDs, and observation failures return bounded unavailable evidence.
- `local-principal-observation.js` is the sole fixed Node/OS edge. It projects only `os.userInfo()` username/UID/GID and the current real/effective process UID/GID calls. It reads no environment or GitHub identity and grants no capability.
- `linux-setup-lifecycle-authority.js` is the sole Linux setup topology root. It accepts only state identity and the exact two-method configuration contract. It attaches principal observation, accepted #382 readiness, the neutral one-attempt policy, and accepted #384 authentication through narrow replaceable ports. The attempt receives only `{ subject }`; its result is ignored. Only the fresh policy observation can establish authority readiness. Protected configuration is inspected through a fresh neutral lifecycle client, reconciled only when inspection is not ready, and inspected again through a new client. Inspection cannot claim mutation.
- `setup-lifecycle-authority.js` is the application composition edge. It maps the complete existing setup request to the existing Windows adapter unchanged or projects only Linux-local state/configuration into the Linux root. Unsupported platforms return a fixed fail-closed result. `setup.js` now defaults to this root and no longer imports the Windows implementation directly.

All new public requests, result records, injected port bags, and adapter records reject unknown, hidden, accessor, or symbolic fields at their owning seam. Setup output contains no principal, subject, executable, authentication output, path, provider/service object, or child result. No broker discovery, `pkexec`, fallback, password channel, caller-selected command/argv/environment/path, compatibility route, or direct host execution was added.

## Local qualification evidence

The exact supported runtime was the official Node.js `v22.16.0` Windows x64 archive with SHA-256 `21c2d9735c80b8f86dab19305aa6a9f6f59bbc808f68de3eef09d5832e3bfbbd`, verified before each use.

- Final exact-Node focused setup/authentication/configuration boundary: 89 total, 87 passed, two expected Windows skips, zero failures.
- Current and final exact-Node repository preflight: two standalone artifacts, 219 syntax files, two JSON files, and 178 targeted test files passed.
- Current repository-execution/setup/product integrity gate: 31/31 passed.
- Final exact-Node complete serialized suite: 1,912 total, 1,891 passed, 21 expected platform skips, zero failures in 189 seconds.
- Final exact-Node doctor passed and truthfully reported repository execution unavailable because no persistent-environment route is configured; coding-model adapters remained disabled.
- Diff hygiene passed. Both uniquely named checksum-verified temporary Node trees were removed after qualification.

A final semantic review tightened configuration observation to require `changed: false`. That byte change invalidated the first complete-suite evidence, so focused, preflight, and the complete exact-runtime suite were rerun on the final candidate rather than reusing stale evidence.

No test or development command invoked `sudo`, `pkexec`, UAC, the authenticated entry, protected service/provider/storage mutation, a VM or guest, repository execution, or a coding model. Hosted Ubuntu must execute—not skip—the production read-only current-principal canary, while authentication remains mocked and uninvoked.

## Hosted implementation checkpoint

[GitHub Actions run 33297374805](https://github.com/iteathen/DevBridge/actions/runs/33297374805) passed the complete Ubuntu/Windows smoke and full-test matrix plus doctor on exact implementation commit `db5cc6a88a98efd34ff0b2bac7a0f0626ff45975`. The Ubuntu full suite executed the production current-principal observation canary as test 218 rather than skipping it and reported 1,912 tests with zero failures. Authentication remained mocked and uninvoked; this is software-boundary evidence, not proof of an installed protected service, successful authentication, provider/storage readiness, a VM, a guest, or repository execution.

## Remaining acceptance

Require this documentation-only acceptance head to pass the same Ubuntu/Windows smoke/full matrix plus doctor. Close only #385 after that exact head is green. Parent #293 and physical issues #372/#373 remain open.
