# DB-HO068 — issue #360 no-elevation operational frontier

Status: live state assessed, primary-source constraints rechecked, the safe continuation planned from exact branch head `0ace83bd47323c43602ef8e31fe08883d7740830`, and the distinct configuration-channel implementation locally qualified on `stage8/362-protected-activity-channel`. This checkpoint authorizes no setup invocation, elevation request or bypass, protected mutation, provider/VM/guest operation, or repository-controlled execution.

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

## Implementation checkpoint — 2026-08-28

The implemented boundary follows the dependency order above:

1. `environment-configuration-authority.js` owns one closed protocol with only `inspect` and `reconcile`. Reconciliation carries exactly an integer revision and SHA-256 subject. Requests/results are request-identity-bound, strictly shaped, and limited to 16 KiB; failures are path-free.
2. `environment-configuration-authority-transport.js` owns only deterministic path-free endpoint identity, one framed exchange, wire bounds, and Windows named-pipe/Linux Unix-socket mechanics. It imports no setup, application, provider, repository, or guest topology.
3. `environment-profile-configuration-record.js` owns bounded, canonical, symlink-refusing observation of the accepted ordinary record.
4. `windows-environment-profile-configuration.js` is now an ordinary-side proxy. It can inspect lifecycle/activity evidence and submit the exact accepted revision/digest, but it cannot construct a provider, select a VM/image/path, reconcile resources, or write protected state.
5. `windows-environment-configuration-host.js` is the protected topology edge. It re-reads and binds the exact accepted record, adopts exact image generations, observes and reconciles protected resources, consumes only exact local conflict consent, applies declaration CAS through the existing neutral registry, and re-reads the accepted record before returning bounded readiness/change/revision evidence.
6. The Windows service plan, C# host, and worker own a fifth, separately named and separately dispatched configuration pipe. Its DACL admits only the exact ordinary operator and Administrators as read/write clients, retains the service/System server principals, denies network access, and does not widen the lifecycle mutation pipe. The service command and runtime protocol bind the endpoint to the exact protected generation. The immediately preceding activity-capable generation is recognized only as refresh evidence; it cannot claim current health because it lacks the configuration endpoint.
7. Service health now proves the exact SCM/runtime identity, lifecycle read capability, configuration capability, and negative-capability boundary before setup consumes the endpoint. An already-current service reconciles pending accepted state from the ordinary parent with zero elevation. Endpoint absence is classified as a stale structural generation and permits at most the existing single explicit elevation transaction. The elevated child now refreshes only service structure; all dead desired-state wiring was removed, and final configuration/acceptance remains in the ordinary parent.
8. The generic lifecycle host can attach the same neutral configuration port through its independent Unix-socket server and rolls back already-started endpoints if that attachment fails. With no Linux configuration port composed, the endpoint remains absent and fail-closed. This proves the replaceable Linux system-service stud without claiming the still-open Linux provider/profile mechanics or physical KVM/libvirt acceptance from issue #293.

Replay of the same revision/digest is idempotent. Record drift before or after protected effects, changed foundation identity, unavailable management, unaccepted resource conflict, foreign declaration state, malformed/oversized frames, forged request/result identities, endpoint absence, and startup interruption all remain closed. The ordinary contract and transport have explicit LEGO source-boundary tests; physical/provider names occur only at the protected composition edge.

Exact local qualification after the final hardening pass:

- `git diff --check`: passed (only the repository's existing Git line-ending notices were emitted);
- `npm run preflight`: passed, 173 syntax files, 2 JSON files, and 146 targeted test files;
- `npm test`: passed, 1,757 tests total, 1,742 passed, 15 platform-capability skips, 0 failed; and
- Windows PowerShell 5.1 compiled the updated C# service host and proved its one-instance named-pipe behavior inside the test suite.

No installed setup command, elevation broker, SCM mutation, Hyper-V mutation, VM/guest operation, or repository-controlled execution was invoked. Hosted qualification and the later one-time installed service refresh/physical canaries remain separate evidence gates.
