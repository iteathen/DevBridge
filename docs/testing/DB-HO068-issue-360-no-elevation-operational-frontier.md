# DB-HO068 — issue #360 no-elevation operational frontier

Status: live state assessed, primary-source constraints rechecked, and the safe continuation planned from exact branch head `0ace83bd47323c43602ef8e31fe08883d7740830` on `stage8/362-protected-activity-channel`. This checkpoint authorizes no setup invocation, elevation request or bypass, protected mutation, provider/VM/guest operation, or repository-controlled execution.

## Question and exact live assessment

The operator asked whether the current installation can become operational during the declared three-day no-UAC interval. Read-only ordinary-user inspection on 2026-08-28 established:

- the installation entry exists and tracks `stage8/362-protected-activity-channel`;
- the ordinary account's Hyper-V Administrators membership is active, and Hyper-V inventory is readable without elevation;
- `DevBridgeLifecycle-679c2503003e57fbacccc9a2428da304` is installed, automatic, and running under its service identity;
- the service exposes distinct lifecycle-read, lifecycle-mutation, acceptance, and activity endpoints;
- setup discovery has retained sixteen accepted repository subjects and one accepted `linux-development` profile configuration;
- the completed Ubuntu image is `img-dd12f7d5088dc62281a89a887be9dc1b`, generation `ubuntu-2604-production-v5`, with its compiler/Node/CMake qualification and finalized VHDX evidence intact;
- the normal installation has no `config.json`, so daemon execution cannot be enabled;
- a direct read-client observation of the protected lifecycle authority returns `setup-reentry-required`, zero declarations, and zero environments; and
- the protected activity endpoint responds with bounded `ready: false` / `environment activity is unavailable` status.

The completed image is therefore not the blocker. The missing transition is admission of the accepted ordinary profile declaration and image into the protected lifecycle authority, followed by protected environment creation and route publication.

## Primary-source constraints

Microsoft's [Service Security and Access Rights](https://learn.microsoft.com/en-us/windows/win32/services/service-security-and-access-rights) distinguishes ordinary query access from administrator-only service creation/configuration and warns that `SERVICE_CHANGE_CONFIG` controls the executable run by the service. The protected runtime package or service command line cannot be refreshed safely by writing around the service boundary.

Microsoft's [Named Pipe Security and Access Rights](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights) confirms that a named-pipe DACL controls both client and server access and that Windows checks a connecting client's token. A future ordinary setup channel must therefore be a separately authorized, explicitly ACL-bound service capability; a default pipe descriptor or reuse of a broader lifecycle endpoint is insufficient.

DB-020 additionally prohibits direct ordinary-process provider mutation or a host fallback. Membership that makes `Get-VM` usable is not DevBridge authority to bypass the protected service.

## Reassessment

There is no safe route to **full** operation from the currently installed protected generation without one more administrator-authorized refresh/reconciliation:

1. the current service has no admitted declaration to create;
2. the activity capability correctly refuses work without that declaration;
3. the accepted profile reconciler currently performs privileged image/resource/declaration intake only inside the one-shot elevated setup child; and
4. the installed service protocol has no separate bounded setup/configuration mutation endpoint that can perform that intake under the existing service identity.

Creating only the ordinary `config.json` would start polling but would not make repository execution available. Calling Hyper-V directly from the ordinary process would make the product appear functional by violating the protected authority boundary. Replacing files under the protected service root, changing its command line, reusing the acceptance pipe for mutation, or weakening its ACL would be an elevation bypass rather than a solution.

The remaining no-elevation work is still useful: code, tests, installer/setup mechanics, status projection, and the exact restartable reconciliation can be completed and qualified without touching the live provider. When UAC becomes available, one explicitly announced exact-subject transaction should refresh the protected generation, reconcile the already accepted image/profile/resources, and return to the ordinary parent for the final negative-capability proof. Normal lifecycle and repository execution after that point remain non-elevated service-client operations.

## Product correction for later installations

Repeated setup re-entry should not require UAC merely to ask an already-current protected authority to reconcile a bounded local declaration. The architecture-compatible correction is a fifth, separate protected setup/configuration capability:

- the ordinary setup owner publishes one closed, revisioned accepted declaration artifact containing no provider object, VM name, host path, command, credential, transport detail, or executable identity;
- a distinct service endpoint accepts only the exact local installation/operator identity and a bounded expected record revision/digest;
- the service derives protected roots, image/provider objects, resources, and physical identities locally;
- the protected side performs image adoption, resource reconciliation, declaration CAS, and exact re-observation;
- the result exposes only neutral readiness/change/revision evidence;
- endpoint absence, stale service generation, record drift, malformed data, foreign declarations, or unavailable provider state fail closed; and
- lifecycle read/mutation, activity, acceptance, and setup/configuration remain separate capabilities.

Initial service installation and a service-code refresh still require administrator authority. Once a generation containing this capability is installed, routine setup/reconfiguration can remain non-elevated without giving the ordinary process direct provider or protected-filesystem authority.

## Dependency-ordered continuation

1. Keep the live installation untouched throughout the operator's no-UAC interval; do not invoke installed setup or any elevation entry.
2. Specify and implement the separate bounded setup/configuration request, result, endpoint, service-host dispatch, and protected composition using injected fixtures only.
3. Prove explicit Windows pipe ACL separation, exact operator/installation binding, closed schemas, size/time bounds, CAS/replay behavior, absence of arbitrary paths/provider identities/commands/credentials, and fail-closed endpoint absence.
4. Cut ordinary setup reconciliation to the new capability only when the installed service reports the exact supported generation. Preserve the current elevated child solely for initial install/service refresh, not routine desired-state intake.
5. Run focused, complete, preflight, LEGO/topology, and hosted Windows/Ubuntu qualification without live setup/provider effects.
6. During the next announced UAC window, perform the one exact service refresh. Then re-enter setup ordinarily, require one accepted Linux declaration/environment/route, publish normal configuration last, and run the fixed C canary twice with a service/VM restart between runs.
7. Repeat the same acceptance for the Windows profile after its image and activation-policy gates are satisfied.

GPU/CUDA remains deferred. No direct-host repository execution, model fallback, compatibility service, or legacy privileged setup path is authorized.
