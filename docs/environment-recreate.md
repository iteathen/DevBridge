# Provider-instance recreate

Issue #175 defines `recreate` as complete replacement of the provider implementation for one existing logical execution-profile environment. The logical environment identity and approved declaration remain authoritative; the VM/domain instance, guest system storage, guest/bridge identity, bootstrap materialization, and workspace materialization are replaceable implementation state.

`recreate` is intentionally broader than `rebuild` and `reset`:

- `repair` preserves the current implementation generation and corrects only bounded in-place defects;
- `rebuild` replaces a generation because replaceable system storage is missing or invalid while the exact provider instance is still identifiable and owned;
- `reset` intentionally returns an existing profile to its declared clean baseline;
- `recreate` replaces the complete provider implementation from the same declaration and may proceed when the registered provider object itself is already missing.

Operator command syntax and confirmation UX belong to #176. This document describes the lifecycle contract that those surfaces consume.

## Authority and identity

Generic recreate code addresses only:

- stable logical environment identity;
- declaration revision;
- current and superseded implementation generations;
- neutral materialization/health evidence;
- bounded lifecycle operation identity;
- content-derived destructive authorization subject.

Provider-native VM/domain identifiers, storage paths, Hyper-V objects, libvirt XML, commands, bridge implementation details, and guest filesystem paths remain adapter-local. Recreate does not derive mutation targets from repository content, model output, guest output, or arbitrary provider names.

The desired declaration is not modified by recreate. Changing profile, image, bootstrap, resource, network, or other desired policy is a separate setup/reconfiguration decision.

## Impact preview and destructive authorization

`planRecreate` is read-only. Its deterministic impact includes:

- logical environment identity and declaration revision;
- exact current implementation generation;
- current materialization/system-storage/transition state;
- whether the previous provider is present, missing, or unavailable;
- all affected registered workspace identities and count;
- preserved, replaced, reseeded, and discarded state classes;
- protected-state blockers;
- image/bootstrap/boot/network/enrollment/resource prerequisites;
- whether staged side-by-side provider replacement is available;
- rollback semantics;
- a SHA-256-derived authorization subject over the complete bounded impact.

Execution has no default destructive authority. A local authorization contract must verify an opaque approval receipt against the exact impact subject, declaration revision, and current implementation generation before a new recreate journal is opened.

The approved impact subject is persisted as lifecycle evidence, not the approval receipt. Immediately before the provider effect, recreate re-observes the current generation. If that generation has not already advanced through reconciliation, any material impact drift changes the digest and invalidates the prior approval.

Protected state, ambiguous provider selection, a non-clear transition, missing implementation-generation identity, or unavailable resource prerequisites fail closed before construction. Resource pressure does not silently authorize a delete-first fallback. The impact contract states that automatic destructive fallback is unavailable and that rollback would be unavailable after old-provider retirement if a future explicitly authorized destructive strategy is introduced.

## Shared construction path

Recreate uses the shared #171 construction stages:

`image -> resources -> materialization -> preparation -> workspaces -> readiness`

The existing declaration is passed through the pipeline. Recreate does not clone provider provisioning, bootstrap, enrollment, workspace reseed, or readiness logic.

For a present exact owned provider implementation, the low-level persistent owner:

1. re-observes exact ownership;
2. stops the old implementation when needed without retiring it;
3. resolves the same approved source/settings;
4. provisions or reconciles one deterministic next implementation generation;
5. switches the logical registry to that generation while retaining the exact superseded generation;
6. lets shared preparation/workspace/readiness stages complete;
7. independently verifies the new generation;
8. retires only the exact superseded owned history generation.

This is replacement-before-retirement. The old provider implementation remains non-authoritative but available for rollback until the new generation has passed verification.

## Missing old provider

A registered logical environment may retain an exact implementation generation even when its provider object no longer exists. That is a first-class recreate condition rather than an instruction to invent provider identity.

When the old provider is already missing:

- the exact registry generation remains the superseded identity;
- foreign or ambiguous provider objects are not adopted as substitutes;
- the same approved declaration/source/settings produce one deterministic next generation;
- the old history generation is marked already absent;
- rollback is reported as unavailable because there is no old provider object to restore;
- post-verification retirement reconciles the already-absent generation without issuing a blind provider delete.

## Ownership and retirement

Recreate may tolerate incompatible health evidence from an owned provider because complete replacement is the purpose of the operation. It may not tolerate foreign ownership.

If the old provider exists and `owned` is false, provisioning stops before a replacement effect is authorized. Exact old ownership is checked again after any required stop. Superseded retirement accepts only the exact history generation belonging to the still-current logical environment and requires it to be stopped and owned before deletion.

The composition adapter adds another guard: retirement must still be executing the same outer `recreate` lifecycle at `verification`, with matching declaration revision, previous/current generations, and destructive authorization subject. Authorization drift therefore cannot widen cleanup authority.

## Fencing and interruption recovery

Recreate uses the same exclusive logical lifecycle fence and durable stages as other environment mutations:

`intent -> pre-observation -> fenced-attempt -> post-observation -> verification -> cleanup-reconciliation -> terminal`

Provider replacement is request-bound to the outer lifecycle operation ID and exact previous generation. The low-level persistent registry deliberately does not replay pending `recreate` effects during generic startup reconciliation. A resumed outer lifecycle must reacquire the current fence and re-present the same request/previous-generation pair.

This provides deterministic recovery for the important interruption cases:

- interruption before provisioning: resume the planned next generation;
- provider effect completed but response lost: observe/reconcile the same deterministic generation rather than allocate another;
- registry switched but shared preparation/readiness incomplete: continue the same construction operation;
- verification completed but retirement response lost: reconcile exact superseded retirement idempotently;
- old provider already absent: keep that fact explicit in recovery evidence and do not fabricate rollback.

Old and new generations never both become logical authority. Generic daemon reconciliation is intentionally insufficient to perform the destructive request-bound effect without the outer fence.

## Workspace and guest reconstruction

Registered workspaces are reseeded through the existing host-authoritative workspace owner. Guest-only dependency state, caches, build products, scratch state, and workspace materialization are replaceable and may be lost. The guest/bootstrap/enrollment path runs again for the new implementation generation, so guest and bridge identity are reconstructed rather than copied from a broken provider instance.

## Qualification boundary

Automated qualification covers:

- missing-provider recreate;
- present but incompatible owned-provider replacement;
- foreign ownership refusal before provisioning/deletion;
- deterministic generation/request replay after interruption;
- generic-reconciliation refusal to replay request-bound recreate effects;
- exact destructive authorization and impact-drift invalidation;
- exact post-verification retirement and authorization-evidence binding;
- protected-state and resource blockers;
- production composition exposure;
- lifecycle LEGO isolation.

Final acceptance still requires real Hyper-V and KVM/libvirt canaries that intentionally break/remove an owned provider instance, run the authorized recreate lifecycle, verify regenerated guest/bootstrap/bridge/workspace readiness, and prove return to VM-only repository execution. Hosted mocks are not a substitute for that provider evidence.

The separate #177 security track must additionally prove that an ordinary coding-model process cannot bypass this lifecycle by directly deleting DevBridge VM backing storage, while the authorized lifecycle authority can still perform exact owned recreate/rebuild/reset operations.
