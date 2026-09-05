# DB-HO081 — issue #381 Linux protected-refresh child

Status: accepted on exact implementation `06fbc494cca82e741adf9c3d9bddf43792339231` from baseline `8aac871906b68a6c03c03bbef042236b3b9166ad`.

This checkpoint is one no-elevation prerequisite under #293. It does not make the Linux lifecycle authority reachable from setup, select an elevation program, install or refresh a service, authorize a provider, touch protected storage physically, run a VM or guest, execute repository code, or claim Linux readiness.

## Required preflight and assessment

The mandatory VM-program gate was repeated before design: DB-003, DB-009, DB-018, DB-020, `docs/environment-lifecycle-authority.md`, `docs/vm-migration.md`, and `docs/vm-lego-studs.md` were read with parent #177/#293 and the accepted #292 Windows lifecycle path. The exact Linux implementation being extended was inspected through plan selection, numeric required-group binding, ownership records, immutable generation staging/verification, endpoint topology, service definition/observation/actions, concrete refresh composition, the shared refresh adapter, setup, hidden child parsing, and CLI dispatch.

The lower Linux stack is complete enough to perform a protected refresh, but no production owner currently supplies its final inputs. `createLinuxLifecycleAuthorityRefreshComposition()` requires a base plan, runtime-bound candidate plan, measured candidate, local package/executable sources, first-claim admission, invocation, and cancellation. `reconcileLinuxLifecycleAuthorityRefresh()` then projects those Linux mechanics into the shared platform-neutral reconciler. Neither is attached to setup.

The current setup topology is Windows-specific at three seams:

- `runDevBridgeSetup()` defaults to the Windows readiness owner and only offers its elevation port on `win32`;
- the hidden `--lifecycle-authority-child` route always invokes the Windows child; and
- the Windows broker owns UAC, exact runner selection, result transfer, and automatic return to the ordinary parent.

Calling the Linux refresh composition directly from setup would collapse ordinary-principal selection, privileged invocation, local topology re-observation, runtime identity, and refresh mechanics into one component. It would also make the eventual authentication tool part of the refresh engine. That violates the temporary-topology requirement and makes a later `sudo`/polkit replacement invasive.

## Primary-source research

Polkit documents `pkexec` as an authentication broker, not an argument validator: it deliberately does not validate the target program's arguments. It runs with a minimal environment, exposes the invoking UID as `PKEXEC_UID`, uses a registered session authentication agent when available, and can fall back to a textual agent. A future pkexec adapter must therefore invoke one fixed local child contract and may not treat successful authentication as validation of request fields.

Sudo's current source and manuals distinguish interactive execution from `--non-interactive`, reset the command environment by policy, support a command boundary without a shell, and provide submitter identity to the policy/command environment. A future sudo adapter must not preserve the caller environment wholesale, pass passwords over DevBridge pipes, accept a caller-selected executable/argv, or interpret authentication as proof that a requested local capability is the one DevBridge observed.

The research does not justify selecting either broker inside the child. Authentication-agent availability, terminal behavior, distribution policy, and installed executable ownership are platform/setup facts. They belong to a later discovery and elevation adapter. The protected child needs one broker-independent request and result contract first.

Primary sources:

- [polkit `pkexec(1)`](https://polkit.pages.freedesktop.org/polkit/pkexec.1.html)
- [polkit architecture and authentication agents](https://polkit.pages.freedesktop.org/polkit/polkit.8.html)
- [sudo argument implementation](https://github.com/sudo-project/sudo/blob/main/src/parse_args.c)
- [sudo environment and policy defaults](https://github.com/sudo-project/sudo/blob/main/plugins/sudoers/def_data.c)

## Reassessment and selected boundary

Implement the protected child before implementing its broker or setup route.

The child request is data, not an elevated command language. Its exact versioned schema carries only:

- one normalized local state-directory identity;
- one ordinary principal name and numeric UID/GID;
- one neutral required-group name/numeric ID pair selected by the ordinary preflight; and
- one exact package/Node candidate digest pair measured by the ordinary parent.

It accepts no setup home, profile, provider, service/unit, endpoint, socket, image, VM/domain, storage path, source path, executable, argv, environment, credential, or generic effect. Package root, Node executable, topology observer, candidate measurer, plan projector, refresh composition, and refresh reconciler are local construction ports. The production defaults are fixed by the installed child module rather than request data.

Before effects, the child must:

1. prove `linux` plus an effective root identity through a narrow local invocation-evidence port;
2. require that the broker-reported ordinary principal exactly matches the request name/UID/GID and is non-root;
3. re-observe the complete fixed management topology and require the same exact group-only selected capability pair;
4. re-observe the principal and every active management group through NSS, require the same numeric identities, and prove the principal is not configured in any of those groups;
5. re-observe the local state identity as one real, canonical, non-group/world-writable directory owned by that exact principal, so request data cannot select a foreign path as protected identity authority;
6. remeasure the fixed local package and Node sources and require the exact request digests;
7. reconstruct the deterministic base plan from only state identity, principal name, and the selected primary group pair, then bind the measured runtime; and
8. attach the existing Linux refresh composition and shared reconciler with a local first-claim admission decision.

The result is bounded protocol evidence only. Raw exceptions, paths, subprocess output, topology objects, plans, candidates, mechanics, or provider details do not cross back to the broker. Unknown request or dependency fields fail before observation/effects. There is no compatibility request or fallback.

This contract deliberately does not attempt the final ordinary readiness proof. The later parent composition must re-run ordinary plan selection after the child returns, inspect the installed authority through ordinary-readable evidence, prove negative direct capability/storage access, connect through the read capability, reconcile the separately accepted profile configuration, and allow at most one broker invocation.

## Scoped implementation plan

1. Add one self-contained request/result normalization child with exact schemas and bounded reasons.
2. Add one Linux-local child composition root that validates invocation identity, topology, NSS identity, and candidate identity before constructing any refresh port.
3. Reuse the accepted deterministic plan, runtime candidate, Linux refresh composition, and shared adapter; do not copy their algorithms or leak their objects through the child API.
4. Add tests for exact success/no-op projection, non-Linux/non-root denial, principal and group drift, topology drift, configured management membership, candidate drift, unknown/widened fields, dependency widening, and bounded sanitized failures.
5. Add source-isolation assertions and focused qualification to repository preflight.
6. Run current and exact Node 22 focused tests, preflight, architecture gates, the full serialized suite, doctor, generated-artifact identity, and diff hygiene.
7. Publish the isolated branch and require exact-head Ubuntu/Windows smoke/full CI. Close only #381 after acceptance; keep #293 open.

## Implementation checkpoint

The new platform-neutral `devbridge/protected-refresh-child-request-v1` contract has no imports and accepts only exact local state identity, ordinary principal name/UID/GID, one selected capability name/ID pair, and package/Node SHA-256 identities. Its result is only bounded readiness/change/generation/reason evidence. Unknown fields, old protocol shapes, root principals, invalid identifiers, unbounded reasons, and inconsistent result states are rejected; there is no compatibility reader.

One Linux-local composition root now proves Linux plus effective root execution, binds broker-origin evidence to the exact non-root principal, and re-observes the complete active group-only management topology. A distinct compatibility group remains temporary topology: the child verifies it and rechecks the ordinary principal's non-membership, but the deterministic plan receives only the selected primary pair. NSS name/numeric drift, membership, aliases, incomplete topology, route drift, or a primary selection change blocks before effects.

The state request is not accepted as path authority. Before candidate measurement, the production observer requires the exact canonical directory, no final or parent filesystem indirection through canonical mismatch, stable inode/device observation, the exact ordinary UID, and no group/world write bits. The fixed installed package root and current Node executable are then remeasured locally and must match both the request digest pair and their self-consistent candidate evidence. Only after those gates does the child reconstruct the existing plan, bind its generation, and attach the accepted Linux refresh composition and shared reconciler. Pre-effect failures report `changed: false`; once refresh construction can have effects, uncertainty reports `changed: null`. Raw errors, paths, topology, plans, candidates, and mechanics never cross the result.

Direct child qualification passes 10 total / 9 passed / 1 expected Windows skip. The wider focused Linux boundary passes 140 total / 138 passed / 2 expected Windows skips on both current Node and exact Node 22.16.0. Current and exact preflight each pass 2 standalone artifacts / 207 syntax files / 2 JSON files / 169 targeted tests. Exact-Node repository-execution architecture gates pass 34 total / 33 passed / 1 expected Windows capability skip; the product/standalone set passes 5/5. The complete exact-Node serialized suite passes 1,861 total / 1,843 passed / 18 expected platform skips / zero failures in 196 seconds. Exact-Node doctor reports `ok: true`, coding adapters disabled, and repository execution unavailable/fail-closed because no persistent-environment routes are configured. Generated-artifact and diff hygiene are clean. Hosted exact-head acceptance remains pending.

No CLI/setup route imports the child. No broker, elevation, service, provider, protected storage, VM, guest, repository execution, model, or UAC effect was invoked.

## Explicit next gates

After #381, a separate issue may implement broker discovery plus one closed `sudo` or `pkexec` adapter, a platform-neutral child dispatcher, and ordinary-parent automatic re-observation. That later work must use the #381 request/result unchanged and must not add a generic privileged helper. Positive protected provider access, protected qcow2 storage, physical libvirt/systemd permission evidence, and the Linux guest C canary remain later #293/#115/#116 gates.

## Hosted acceptance

[GitHub Actions run 33293225945](https://github.com/iteathen/DevBridge/actions/runs/33293225945) passed Ubuntu smoke/full and Windows bounded-smoke/serialized-full plus doctor on exact implementation `06fbc494cca82e741adf9c3d9bddf43792339231`. The Ubuntu full job executed—not skipped—the real-filesystem state observer canary and rejected filesystem indirection and group-writable state while accepting the exact ordinary-owned directory. This accepts only the broker-independent child software boundary; it does not establish a broker route, invoke elevation, install or refresh a service, prove provider/storage access, run a VM/guest, or enable repository execution. Close #381 and keep parent #293 open.
