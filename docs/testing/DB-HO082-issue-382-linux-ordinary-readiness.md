# DB-HO082 — issue #382 Linux ordinary readiness and re-observation

Status: accepted on exact implementation `70635a51ad208f71dee25a7d3d852b1fcf5c7904`, with documentation head `ca8ee61875d5429066d48777be896468677f91ae` accepted by [GitHub Actions run 33294600094](https://github.com/iteathen/DevBridge/actions/runs/33294600094).

This is a no-elevation prerequisite under #293. It must not invoke `sudo`, `pkexec`, UAC, a protected setup child, a service mutation, a provider, protected storage mutation, a VM or guest, repository execution, or a coding model.

## Required preflight and assessment

The VM-program planning gate was repeated before design: DB-003, DB-009, DB-020, `docs/vm-migration.md`, `docs/vm-lego-studs.md`, and `docs/vm-stage6-repository-execution.md` were read with parent #293 and accepted issues #378, #380, and #381. The exact implementation being extended was inspected through Linux capability preflight, canonical plan selection, NSS identity observation, runtime measurement/binding, lifecycle inspection, health probing, the protected child contract, setup, and CLI dispatch.

The accepted Linux stack has two disconnected ends:

- the ordinary process can select one exact canonical plan only after proving complete group-only management topology and configured/effective denial; and
- the protected #381 child can independently re-observe one exact principal/capability/candidate request and perform one refresh.

There is no ordinary-process owner between them. `runDevBridgeSetup()` and the hidden lifecycle child route remain Windows-specific. Attaching an authentication program at that seam would force `sudo`/polkit mechanics to decide whether installed Linux evidence is already ready, which exact candidate is current, whether ordinary storage access is actually denied, and whether a successful child claim may be trusted. Those are readiness-policy responsibilities, not broker responsibilities.

## Primary-source research

Linux `open(2)` documents that `O_RDONLY` performs the actual read-permission check, `O_DIRECTORY` rejects non-directories, `O_NOFOLLOW` rejects a symbolic link only in the final path component, and `O_CLOEXEC` prevents descriptor inheritance races. A successful open returns a live descriptor; `EACCES` means the requested access or path search was denied. This supports a read-only negative boundary proof against the exact protected authority directory. It also rules out `O_PATH`, because `O_PATH` deliberately requires no permission on the object itself and therefore cannot prove read denial.

Node 22's `fsPromises.open(path, flags)` accepts numeric POSIX flags and returns a `FileHandle` that must be closed. The probe can therefore use the fixed locally constructed `O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC` flags, accept only `EACCES` or `EPERM` as proof of denial, and close any unexpectedly acquired descriptor before reporting failure.

Primary sources:

- [Linux `open(2)` manual](https://man7.org/linux/man-pages/man2/open.2.html)
- [Node.js 22 `fsPromises.open()`](https://nodejs.org/docs/latest-v22.x/api/fs.html#fspromisesopenpath-flags-mode)

## Reassessment and selected boundary

Implement ordinary readiness before broker discovery or setup wiring.

The negative access probe is a self-contained Linux leaf. Its public request carries only one local directory identity and the expected real non-root principal ID. Production identity and descriptor ports are fixed locally. It performs no mutation, does not predict access with `access()`, never accepts executable/argv/environment data, and returns only bounded neutral evidence. Exact lifecycle inspection remains responsible for path topology and ownership; the descriptor probe is deliberately only the current-process access proof.

One Linux-local readiness root owns composition. It accepts only state identity and principal name, then:

1. selects the canonical base plan through #378;
2. re-observes the ordinary account and every local identity required by that exact plan;
3. measures the fixed installed package and current Node executable, validates the complete candidate evidence, and binds the exact runtime generation;
4. constructs the unchanged #381 child request from only the selected state, observed ordinary UID/GID, selected required capability name/ID, and measured package/Node digests;
5. evaluates the existing read-only lifecycle inspection against a closed complete-ready projection;
6. proves actual ordinary read denial against the exact authority directory;
7. probes the three protected read interfaces only after the structural and negative access gates pass; and
8. returns either exact ready evidence or the unchanged protected-child request as an opaque local subject.

Malformed, widened, foreign, stale, incomplete, or unavailable installed evidence never becomes ready. A missing/incomplete installation may produce the bounded child subject because the protected child independently revalidates all authority before effects. No child result can make readiness true.

A separate import-free orchestration brick receives only replaceable `observe` and `attempt` ports. It observes once, forwards at most one opaque subject unchanged, ignores all claims made by the attempt result, and then observes from scratch. Its result is ready only when that second observation is independently ready. This brick knows no Linux, setup, broker, child, service, provider, storage, VM, or repository identity.

## Scoped implementation plan

1. Add the import-free one-attempt/re-observation policy with exact bounded observation/result contracts.
2. Add the Linux descriptor-access leaf and a real-filesystem Ubuntu canary that proves ordinary denial without mutation.
3. Add the Linux readiness composition root using existing plan selection, identity observation, candidate measurement/binding, lifecycle inspection, and health probe owners.
4. Add tests for already-ready, refresh-required, malformed/widened evidence, principal/candidate/topology drift, unexpected direct access, descriptor cleanup, one-attempt limit, attempt failure, post-attempt full re-observation, opaque-subject identity, and module/source isolation.
5. Add the new sources/tests to repository preflight; do not edit setup or CLI in this issue.
6. Run current and exact Node 22.16.0 focused tests, preflight, architecture gates, the complete serialized suite, doctor, generated-artifact identity, and diff hygiene.
7. Commit/push the isolated branch and require exact-head Ubuntu/Windows smoke/full CI. Ubuntu must execute the real descriptor-boundary canary. Close only #382 after durable acceptance and keep #293 open.

## Explicit downstream gates

After #382, a distinct issue may discover and qualify locally installed authentication brokers, attach one fixed broker adapter to the unchanged #381 child contract, and compose it with the one-attempt policy. CLI/setup routing remains later. Protected positive provider access, protected qcow2 storage, physical libvirt/systemd authority evidence, the Linux guest C canary, Stage 8 setup integration, and real Hyper-V/KVM qualification remain separate gates.

## Implementation checkpoint

The accepted state-identity observer previously embedded in the #381 child is now one Linux-local leaf with the same exact protocol and behavior. Both protected-child and ordinary-readiness compositions attach it through narrow replaceable ports. It proves one canonical, stable, real, ordinary-owned, non-group/world-writable directory; neither composition duplicates that policy.

The new access-boundary leaf uses fixed local Node/Linux mechanics only. It binds a read-only descriptor attempt to the same canonical directory device/inode/mode/owner/group evidence before and after the attempt, requires the real and effective non-root UID to match the selected principal, closes any acquired descriptor, and accepts only `EACCES`/`EPERM` as negative access evidence. Missing, linked, substituted, malformed, directly readable, or release-indeterminate state remains not ready. It exposes no broker, executable, argv, environment, service, provider, repository, or mutation authority.

The Linux-local readiness root accepts only state identity and principal name. It selects the exact #378 plan; measures and binds the fixed local package/current Node candidate; re-observes NSS, active numeric credentials, and state identity; constructs the unchanged deeply immutable #381 request; strictly projects complete installed identity/ownership/generation/topology/service/process/filesystem/runtime evidence; requires the descriptor-denial proof; and finally probes the three protected read interfaces. Missing or repairable installed evidence yields the unchanged child request. Principal/candidate/state drift and unexpected direct access yield no protected subject.

The import-free `devbridge/protected-readiness-observation-v1` / `devbridge/protected-readiness-reconciliation-v1` policy knows no platform or topology. It forwards at most one frozen opaque subject unchanged, ignores the attempt's claimed result, and always re-observes from scratch after an attempted effect—even when the attempt throws. Only the second complete observation can report readiness. There is no compatibility reader or retry loop.

Current and exact Node 22.16.0 focused qualification each passes 45 total / 43 passed / 2 expected Windows skips. The wider Linux authority boundary passes 240 total / 232 passed / 8 expected Windows skips on both runtimes. Current and exact preflight pass the same 2 standalone artifacts / 211 syntax files / 2 JSON files / 172 targeted tests. Exact-Node repository-execution architecture tests pass 28/28, product/standalone integrity passes 5/5, and the complete exact-Node serialized suite passes 1,877 total / 1,858 passed / 19 expected platform skips / zero failures in 192 seconds. Exact-Node doctor reports `ok: true` and repository execution unavailable/fail-closed because no persistent-environment route is configured; the configured model adapter is unusable and ineligible for automatic selection. Generated-artifact identity and diff hygiene are clean.

[GitHub Actions run 33294423593](https://github.com/iteathen/DevBridge/actions/runs/33294423593) accepted exact implementation commit `70635a51ad208f71dee25a7d3d852b1fcf5c7904` across Ubuntu smoke/full and Windows bounded-smoke/serialized-full plus doctor. The Ubuntu full job ran the production state observer as test 793 and the production Linux descriptor-denial canary as test 831; both passed against real filesystem subjects. Its complete suite reported 1,877 tests / 1,841 passed / 36 expected platform skips / zero failures. This proves the implementation path executed on Linux; it does not prove an installed protected service or provider. The documentation-only acceptance head must pass the same four-job matrix before #382 closes.

No setup/CLI route imports the readiness or reconciliation owner. No authentication broker, elevation, protected child, service mutation, provider operation, protected storage mutation, VM, guest, repository execution, model, or UAC effect was invoked.
