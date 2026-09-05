# DB-HO034 — issue #360 protected image adoption

Status: assessed, researched, and planned from exact branch head `a6a47ef1f5fa7bbfe51316906380a0b57ad61390` on `stage8/362-protected-activity-channel`. Implementation and physical evidence will be appended without rewriting this pre-change record.

## Trigger and assessment

The first supported setup re-entry from the protected-activity head stopped before UAC or service mutation. `inspectWindowsLifecycleAuthorityMigrationSafety()` found the accepted Ubuntu image in the ordinary installation's image library and returned `provider-aware-image-migration-required`.

That stop is correct. `BaseImageLibrary` binds a published object to both content identity and local filesystem identity. Generic recursive copying would create a different file while copying a catalog that still describes the old file. The protected library would then reject the copied VHDX as `image file identity changed`.

The exact current source is one active, parent-free VHDX:

- profile: `linux-development`;
- generation: `ubuntu-2604-production-v5`;
- image identity: `img-dd12f7d5088dc62281a89a887be9dc1b`;
- SHA-256: `c3fde8830056262b9466a9c6c4fed979402306ba9cacff93aa9e7c3eeb933bf6`;
- byte size: `9667870720`;
- virtual size: `34359738368`;
- VHDX disk identifier: `EF4C2560-607C-4642-8946-238158AE4C8C`;
- parent: absent.

The protected service is running from the earlier generation `d7e616d...` and has no activity endpoint. Its read endpoint reports `setup-reentry-required`, zero declarations, and zero environments. The new service generation cannot pass activity health until the protected image library is ready, because protected activity composes through the exact protected foundation.

The generic state migration also has a second unsafe edge: its state-path allowlist currently includes the complete image directory. That path must be removed from generic copying before image migration is allowed to proceed. Persistent provider records and active recovery state remain hard blockers; provider-aware image adoption must not accidentally authorize either.

Review also exposed a fresh-host circularity in the new activity generation. Protected activity construction and service-generation health required the complete foundation to be workload-ready, including an image, while setup requires the protected service to become structurally ready before it can advance image setup. Endpoint health must instead prove that the exact activity capability is reachable and returns a bounded status. Its own `ready: false` remains the fail-closed workload result until image/network/storage prerequisites exist.

No UAC prompt, service mutation, VM mutation, image mutation, or route publication occurred during this failed re-entry.

## Primary-source research

Microsoft documents that [`CopyFile`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-copyfile) copies an existing file to a **new file**. Microsoft separately documents that the file identifier plus volume serial identifies one file, and that on NTFS the identifier remains with that file until deletion ([`BY_HANDLE_FILE_INFORMATION`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/ns-fileapi-by_handle_file_information)). A copied destination therefore must be measured and registered as a new protected filesystem object; the ordinary catalog's file identity cannot be transplanted.

Microsoft's [`Get-VHD`](https://learn.microsoft.com/en-us/powershell/module/hyper-v/get-vhd?view=windowsserver2025-ps) returns the virtual hard disk object for an exact path. [`Test-VHD`](https://learn.microsoft.com/en-us/powershell/module/hyper-v/test-vhd?view=windowsserver2025-ps) tests whether a virtual hard disk or chain has problems that make it unusable. DevBridge's existing media adapter already combines these operations and projects format, disk identifier, parent presence, and virtual size.

Microsoft's [`Set-VHD`](https://learn.microsoft.com/en-us/powershell/module/hyper-v/set-vhd?view=windowsserver2025-ps) documentation warns that bypassing parent-ID mismatch is dangerous and can cause data loss unless block contents are certainly identical. Adoption must never reparent, reset disk identity, or use an ignore-mismatch mechanism. A base image is accepted only when it remains parent-free and preserves its recorded media identity after protected publication.

## Reassessment

This is adoption by logical identity, not a filesystem move and not catalog copying:

1. Reconcile the source image library through its own public recovery contract.
2. Observe and verify each active source entry through the library contract, including exact content digest and current source file identity.
3. Reconcile the protected destination library before deciding whether work remains.
4. If the exact profile/generation already exists, require the same deterministic image identity, digest, byte size, recorded media identity, and successful provider-native verification.
5. Otherwise publish from the fixed, locally derived source object into the protected library with `expectedDigest`; let the destination library create durable planned/attempted/reconciled publication evidence and record the destination's new filesystem identity.
6. Verify the protected object again through the provider-native media inspector and require exact format, disk identifier, parent-free state, and virtual size.
7. Retry by observation. A crash can leave a destination publication operation, but it cannot authorize blind recopy or catalog transplantation.

The adapter never accepts a path, provider object, VM name, command, credential, or capability from a remote task. Both roots are derived by the protected setup composition from the installation state and protected authority plan.

The ordinary source is retained through the immediate #360 setup cutover because the current setup status gate still observes construction completion there. It is not execution authority. Once protected setup/status owns the image and profile declaration, the exact redundant ordinary image state can be retired through an explicit owned cleanup transaction instead of becoming permanent compatibility behavior.

## LEGO boundary

- A neutral adoption coordinator consumes transient source and destination contracts: reconcile, list, observe, verify, and publish. It knows no platform, provider, service, VM, path layout, or foreign object type.
- The Windows setup composition derives the two fixed image-library roots and attaches the existing protected foundation as the destination adapter.
- The image library remains the sole owner of staging, catalog operations, immutable generation checks, file identity, digest verification, and interrupted-publication reconciliation.
- The media/provider adapter remains the sole owner of VHDX inspection. The coordinator compares neutral media facts only.
- Generic protected-state copying explicitly excludes image-library state.
- Migration safety permits only the provider-aware image classification to reach this adapter. Path-bound writable storage and active recovery state still fail before service/provider mutation.

## Dependency-ordered implementation plan

1. Add a neutral, idempotent image-adoption coordinator with strict entry/media comparison and no raw paths in its public result.
2. Add the narrow Windows protected-setup composition that binds an ordinary source library to the protected foundation.
3. Expose image-only reconciliation on the neutral foundation contract so adoption recovery does not reconcile unrelated network, storage, or environments.
4. Remove `environment-foundation/images` from generic protected-state copy paths and attach provider-aware adoption after generic state initialization but before runtime generation health.
5. Rework migration-safety classification so image adoption is permitted only when no path-bound persistent storage or active recovery blocker also exists.
6. Rework readiness so the image-adoption classification reaches the existing one-shot elevation/service reconciliation path; every other unsafe classification remains an early fail-closed result.
7. Separate structural activity-endpoint health from workload readiness so a fresh protected installation can report bounded unavailability without failing service installation.
8. Test normal adoption, exact idempotent re-entry, interrupted destination reconciliation, immutable-generation conflict, source identity/digest failure, media mismatch, generic-copy exclusion, combined image/storage precedence, fresh-host structural activity, and ordinary no-elevation behavior when the exact protected service is already healthy.
9. Run focused tests, the full suite, preflight, diff checks, and push the documented implementation before another physical setup attempt.
10. Retry the installed exact branch selector. Only then request UAC, verify the refreshed service/activity endpoint, and continue protected declaration/profile creation.

## Deferred cleanup and exclusions

This change does not create declarations, environments, routes, workspaces, Windows installation media, or guest toolchains. It does not delete the accepted ordinary image during this checkpoint. It adds no generic privileged file-copy API, no host execution fallback, no service mutation endpoint, and no compatibility mode for malformed or path-bound provider state.

GPU/CUDA image profiles and device handling remain deferred.

## Implementation checkpoint

The branch now implements the planned primitive without expanding setup authority:

- `image-library-adoption.js` coordinates only transient reconcile/list/observe/verify/publish ports, bounds each inventory to 256 entries, normalizes semantic media/provenance identity, rejects ambiguous or conflicting immutable generations before publication, and returns no paths or provider detail;
- `windows-lifecycle-authority-image-adoption.js` is the topology edge that derives the fixed ordinary/protected roots, refuses source indirection/overlap, leaves non-Windows composition unattached, and connects the existing image library to the protected foundation;
- `EnvironmentFoundation.reconcileImages()` provides image-only restart reconciliation without touching network, storage, or environment lifecycle state;
- generic protected-state migration no longer copies `environment-foundation/images`;
- every Windows service-generation materialization reconciles image adoption before accepting an existing or new runtime generation, so a crash or later runtime refresh observes the destination before repeating work;
- migration safety now inspects image state without returning early, ensuring path-bound persistent storage and active recovery state retain blocker precedence;
- readiness permits only the provider-aware image classification to enter the existing one-shot elevated service transaction; all other unsafe classifications still stop before service/provider mutation;
- protected activity can start with a bounded `ready: false` foundation status, and service-generation health verifies the exact endpoint/status contract rather than falsely requiring workload readiness. Repository execution still consumes `ready: false` as unavailable.

The source and destination libraries own their respective operation journals. Source reconciliation completes or rejects an interrupted source publication first. Destination reconciliation completes or rejects an interrupted protected publication before inventory comparison. A new destination uses the normal planned/attempted/reconciled publication transaction and records its own filesystem identity. An already exact destination is verified and causes no publication.

## Verification checkpoint

Focused verification passed 79 relevant tests covering:

- normal and idempotent adoption;
- source verification failure;
- immutable-generation conflict;
- provider-observed media mismatch;
- source indirection and absent/non-Windows topology;
- image-only reconciliation isolation;
- generic-copy exclusion;
- image/storage blocker precedence;
- already-healthy ordinary re-entry without elevation;
- fresh-host structural activity with fail-closed workload status;
- existing one-command elevation/refusal/recovery behavior.

Repository-wide verification then passed:

- full suite: 1,454 tests, 1,441 passed, 13 platform skips, 0 failures;
- initial preflight: passed with its prior curated set of 78 syntax files, 2 JSON files, and 75 targeted test files;
- `git diff --check`: no whitespace errors (only the repository's existing Windows line-ending notices).

Review found that preflight uses an explicit security-critical inventory rather than tracked-file enumeration. The changed activity/foundation/service files, both new adoption modules, and their seven focused suites were therefore added to that inventory. Preflight must be repeated with the expanded inventory before commit. No live protected state, service, VM, image, network, declaration, or route was mutated by this implementation checkpoint.

The expanded preflight passed with 85 syntax files, 2 JSON files, and 82 targeted test files.
