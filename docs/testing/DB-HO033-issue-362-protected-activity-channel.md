# DB-HO033 — issue #362 protected environment activity channel

Status: assessed, researched, and planned from exact `cuda-target` baseline `3deb41c61482d76bd0af3a789ccbfbcd229265ce` on isolated branch `stage8/362-protected-activity-channel`. Implementation and qualification evidence will be appended without rewriting this pre-change record.

## Assessment

The Windows protected lifecycle authority is installed and physically qualified. Its service identity owns the provider lifecycle, backing storage, declaration registry, guest preparation material, and provider adapters below a protected authority root. The ordinary operator can use its bounded read capability but cannot access the mutation capability or protected state directly.

Repository execution still predates that authority split. `src/app/repository-execution.js` composes the environment foundation, guest preparation, and provider bridge in the ordinary process. Its route schema persists resolved access material:

- a Windows guest route names a password-bearing environment variable;
- a Linux guest route names the SSH user, private-key path, and known-hosts path;
- the construction pipeline resolves those values inside the protected authority and publishes its route file below protected state;
- an ordinary projection of the same route would either point at unreadable protected files or require copying guest-control credentials into ordinary state.

The latter is not an acceptable repair. A same-identity coding process with the SSH key or Windows guest credential could bypass DevBridge's accepted route, workspace prefix, locally registered operation, cancellation, and result contracts. The VM would still protect the host kernel, but DevBridge would no longer own workspace or operation admission as required by DB-020.

There is a second correctness defect in route construction: `EnvironmentConstructionWorkspaces.ensure()` publishes a changed route before it verifies the workspace roots through the bridge. A later verification failure therefore leaves an accepted-looking route for an unusable workspace. Issue #360 retains ownership of transactional route projection; this issue supplies the credential-free activity capability that makes such a projection usable.

No live service, VM, image, route, network, or credential state was changed during this assessment.

## Primary research

Microsoft's [Named Pipe Security and Access Rights](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights) documents that a named pipe security descriptor controls both server and client ends and that client connection performs an access check against the caller token. It also shows why the default descriptor is not a sufficient production policy: it grants read access to Everyone and anonymous callers. DevBridge must use an explicit DACL for each capability.

Microsoft's [Named Pipes](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipes) guidance notes that named pipes can be remotely accessible through the server service and recommends denying `NT AUTHORITY\\NETWORK` for a local-only pipe or selecting local RPC. The existing service host remains a local named-pipe adapter, so the new capability must preserve local-only policy rather than relying on pipe naming for isolation.

Microsoft's [Service Security and Access Rights](https://learn.microsoft.com/en-us/windows/win32/services/service-security-and-access-rights) keeps service configuration authority administrator-only because changing a service configuration controls the executable that runs. Adding an ordinary activity capability must not grant service configuration, restart, executable replacement, or lifecycle mutation authority.

The existing `EnvironmentBridge` contract already supplies the data-plane primitives required here. It normalizes logical executables and portable relative locations, limits request frames, splits transfers into 16 KiB digest-bound chunks, preserves offsets, reconciles interrupted puts, observes before replaying ambiguous execution starts, and bounds output. A second file-transfer or command protocol would duplicate these semantics and create inconsistent recovery behavior.

## Reassessment

The protected lifecycle protocol must remain lifecycle-only. Expanding its mutation endpoint into a generic command or setup API would collapse distinct capabilities and contradict issue #177.

The selected topology is:

`ordinary control plane -> neutral activity client -> protected activity capability -> accepted route mapping -> existing preparation/bridge adapters -> guest`

The ordinary side retains authoritative source snapshots, stable repository identity, local tool registration, candidate validation/import, Git, verification, and publication. The protected side retains physical environment lookup, provider management, guest access material, bridge attachment, and workspace-prefix derivation.

Public route policy carries only neutral selection data: stable subject, profile, preferred flag, and validation flag. It does not carry a provider, VM/domain name, host path, username/password source, SSH identity, known-hosts file, address, or transport selection.

The client addresses deterministic synthetic environment targets derived from accepted subject/profile routes. For every activity frame, the protected composition:

1. reloads or otherwise revalidates accepted route state;
2. proves the synthetic target maps to exactly one compatible physical environment;
3. derives the workspace prefix locally;
4. normalizes and rewrites the existing bridge frame to the exact physical target and derived prefix;
5. invokes the existing protected provider attachment;
6. validates and rebinds the response to the caller's synthetic target without exposing physical/provider/access detail.

The activity endpoint is intentionally available to the ordinary DevBridge controller, unlike lifecycle mutation. That does not make it a raw guest shell: the existing bridge accepts only logical guest program names and portable classified locations, while the protected wrapper fixes the route and workspace prefix. Provider and service authority remain unaddressable. Later daemon/session authorization may narrow which ordinary process can obtain activity admission, but this issue must not pretend an OS identity can distinguish two arbitrary processes running as the same user.

## LEGO boundary

- The bridge owner normalizes bridge frames and owns neutral target/path-prefix rebinding. It does not learn route, profile, repository, provider, service, or credential identities.
- The activity protocol owns only bounded request/result framing around an injected activity port. It does not compose a provider or inspect neighboring module types.
- The profile-routing edge maps accepted synthetic targets to physical targets and neutral workspace prefixes. Provider-native lookup remains behind the existing adapter.
- Platform transports own named-pipe or Unix-socket endpoints and their OS policy. They do not own activity semantics.
- Repository execution consumes the activity client through the same foundation/preparation/channel-shaped studs and retains no provider or credential fallback.
- Setup owns accepted route projection and endpoint installation. It does not execute repository work.

All property and event names describe local data or actions. Connections are transient and replaceable: the same activity client can attach to a test fake, a Windows named pipe, or a Linux Unix socket without changing repository execution internals.

## Dependency-ordered plan

1. Add exported canonical request/response normalization to the existing bridge owner and prove malformed, oversized, credential/path-shaped, and identity-mismatched frames fail before exchange.
2. Add neutral target/path-prefix rebinding for each bridge operation while preserving request identity, transfer offsets/digests, cancellation, and response identity.
3. Define the bounded activity request/result protocol and a client/handler around injected observation, preparation, and exchange ports.
4. Compose a protected activity runtime from protected state, accepted routes, existing preparation, and existing bridge adapters. Revalidate one synthetic route for every action.
5. Add a distinct ordinary-access platform endpoint. Preserve separate read, mutation, setup/configuration, acceptance, and activity capabilities.
6. Remove access material from the public route schema and provide a migration failure that requires setup re-entry rather than silently copying legacy values.
7. Cut production repository execution to the activity client. Protected endpoint absence or incompatible state remains unavailable with no ordinary provider, direct credential, host process, or coding-model fallback.
8. Test normal, failure, interruption, restart, forged result, route drift, target/workspace escape, cross-route isolation, endpoint absence, credential non-exposure, and exact session recovery.
9. Run focused protocol/bridge/routing/repository tests, LEGO/architecture gates, the full suite, preflight, and exact diff checks.
10. After merge, issue #360 can register the protected image/declaration, create the environment, verify workspaces, and project public routes last. Physical Linux and Windows C canaries then qualify the same client contract.

## Deferred work

Issue #142 may replace per-frame local and guest transport mechanics with persistent authenticated sessions and improve content-addressed reuse. That optimization must preserve this activity contract and its exact route/workspace authority. It is not a reason to expose credentials or block the first correct end-to-end C proof.

GPU/CUDA profiles, passthrough, DMA containment, and GPU execution remain deferred.

## Implementation checkpoint

The branch now implements the dependency-ordered channel through the installed-service boundary:

- canonical bridge request/response validation and neutral target/location rebinding live with the bridge contract;
- a closed activity request/result protocol exposes only inspect, list, observe, prepare, and existing bridge exchange actions;
- Windows named-pipe and Linux Unix-socket transports have deterministic, capability-specific endpoints and bounded framing;
- public policy moved to credential-free `environment-activity/policy.json`;
- workspace setup verifies scoped roots before atomically publishing changed admission;
- preparation binds the exact `env-...` persistent identity instead of a derived profile subject;
- the protected activity composition resolves exact declarations, preparation, access, and physical bridge attachment locally;
- ordinary runtime, doctor, CLI environment commands, and candidate validation consume protected clients and contain no default provider/access/process fallback;
- the Windows protected service has a distinct local-only activity pipe, denies `NT AUTHORITY\\NETWORK`, preserves administrator-only lifecycle mutation, uses separate activity wire bounds, and requires both lifecycle and activity health before a generation is accepted.

The existing acceptance-only host command generation remains readable solely so an installed exact previous generation can be observed and restored during the content-addressed refresh transaction. It is not an execution fallback and cannot serve the new activity client.

## Verification checkpoint

Verification on Windows from exact branch baseline plus this working change:

- focused protected activity, bridge, construction, routing, repository, candidate, and service tests passed;
- the Windows PowerShell 5.1 compiler produced the service host executable from the changed C# source;
- repository preflight passed with 78 syntax files, 2 JSON files, and 75 targeted tests;
- the first full run exposed seven stale assertions that still named the deleted credential-bearing policy or ordinary provider composition; after correcting those assertions, the complete suite passed: 1,441 tests, 1,428 passed, 13 platform skips, 0 failures;
- `git diff --check` reports no whitespace errors after removing the routing-module formatting residue found during audit.

No live service, VM, image, declaration, route, or network state had been changed at this checkpoint. The next external effect is the content-addressed protected-service refresh, followed by ordinary read/activity re-observation before any environment declaration or route publication.
