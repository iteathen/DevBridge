# Environment lifecycle authority isolation

Status: active implementation design for issue #177. This document complements DB-020, `docs/vm-migration.md`, and `docs/vm-lego-studs.md`; it does not supersede them.

## Problem

DevBridge already has lifecycle owners that validate logical identity, desired declaration, current generation, impact, fencing, ownership, verification, retirement, and durable reconciliation. However, the Hyper-V/libvirt provider adapters and their backing-store mutations still execute under the ordinary DevBridge Node/OS identity.

An ordinary coding-model process with that same host authority can bypass the lifecycle owners and mutate provider state or backing files directly. Recovery from #169 is necessary but is not prevention.

## Security invariant

Production provider VM/domain/backing-store mutation must be owned by a protected local authority identity that ordinary repository/model/agent execution does not possess.

The intended composition is:

`operator-authorized local control plane -> neutral EnvironmentOperator client -> protected lifecycle authority -> existing EnvironmentOperator/recovery owners -> foundation/provider adapters -> Hyper-V or libvirt`

There is still one lifecycle semantic owner. The protected boundary does not create a second reset/rebuild/delete implementation.

## Lifecycle authority protocol

`src/runtime/environment-lifecycle-authority.js` defines the bounded provider-neutral request/result stud used across the process/OS boundary.

The remotely addressable vocabulary is intentionally the existing `EnvironmentOperator` surface only:

- `inspect`, `list`, `status`, `plan`, and `setup-reentry` on the read/plan capability;
- `run` and `resume` on the mutation capability.

Supported lifecycle actions remain `create`, `repair`, `rebuild`, `reset`, and `recreate`.

Lower `PersistentEnvironments` and provider operations are deliberately **not** RPC operations. A caller cannot remotely address `remove`, `replace`, `reseed`, provider start/stop, provider reconciliation, exact backing-store retirement, or provider-native mutation methods directly. Those remain internal bricks used by the existing higher lifecycle owners.

Each request accepts only bounded neutral operation/identity/approval fields. Unknown fields are rejected before dispatch.

The protocol has no representation for:

- arbitrary filesystem paths or media locations;
- executable paths, shell, PowerShell, scripts, argv, or commands;
- raw Hyper-V/libvirt provider names, XML, or objects;
- VM/domain/disk names;
- provider identity values supplied by the caller;
- unrestricted file operations.

Authority results are request-ID bound, size bounded, JSON-only, and reject provider-authority-shaped fields and obvious host-path/command leakage. Raw provider exceptions do not cross the boundary. Transport errors, ownership mismatch, malformed envelopes, unknown operations, and oversized/authority-shaped results fail closed.

## Capability separation

Read/plan and mutation are separate local endpoint capabilities even though they terminate in the same protected `EnvironmentOperator` owner.

The read endpoint accepts only bounded observation/planning operations. It rejects `run` and `resume`.

The mutation endpoint accepts only `run` and `resume`. It rejects even read/plan operations so possession of one endpoint does not silently imply possession of the other.

This split is deliberate. Bounded lifecycle status and impact planning may be useful to an ordinary local control/model-visible process. That does not justify automatically granting the same process the capability that can mutate provider infrastructure. The platform-specific setup may therefore apply different OS access policy to the two endpoint classes without duplicating lifecycle semantics.

The exact destructive approval subject produced by the lifecycle owner remains defense in depth and operator-intent binding. It is **not** endpoint authentication and must not be treated as a bearer credential for the mutation endpoint.

## Local transport

`src/runtime/environment-lifecycle-authority-transport.js` provides a bounded local-only transport for Windows and Linux.

The endpoint namespace is derived from the lifecycle state owner, not from caller-supplied request data. DevBridge computes a 128-bit path-free authority identity as a one-way hash of the normalized absolute lifecycle `state.directory` under a fixed protocol domain. Windows normalization is case-folded after platform path resolution. The raw state path is not present in the wire protocol or endpoint label.

The two endpoints are deterministic from that authority identity and capability class:

- Windows: separate local named pipes for read and mutation;
- Linux: separate `read/` and `mutation/` runtime directories under the authority identity, each containing its own UNIX-domain socket.

The separate Linux parent directories are intentional. Setup can establish different ownership/mode policy **before** either socket is bound; the authority process does not have to expose a mutation socket under a directory that was created with read-side permissions.

The client receives the configured state directory from local DevBridge configuration and derives both endpoints internally. Request payloads cannot choose an arbitrary socket, pipe, filesystem path, provider object, or privileged target.

The wire is one bounded JSON request and one bounded JSON response per connection. Oversized data, malformed JSON, buffered multiple frames, ambiguous close, response ownership mismatch, or unavailable endpoints fail closed. Incomplete clients are closed after a bounded pre-request timeout so local processes cannot indefinitely occupy the authority connection budget without dispatching a request.

The client timeout is a **connect timeout only**. Once a complete request has reached the authority, the transport removes the pre-request timeout and does not impose an arbitrary short lifecycle-operation timeout. Long reconstruction remains owned by the existing durable lifecycle journal/resume/reconciliation semantics.

The transport does not create Linux `/run` authority directories itself. Production setup/service ownership must provision the authority, read, and mutation directories and their permissions. This prevents an ordinary application process from silently claiming a parent directory that is supposed to represent OS authority.

## Safety ownership

The protected process must compose `createLocalEnvironmentOperator` or an equivalent existing higher-level owner. `src/app/environment-lifecycle-authority-host.js` is the process-composition brick: by default it constructs the existing local environment operator inside the authority process, binds both capability endpoints around that one owner, and rolls back the read listener if the mutation listener cannot start.

That existing operator composition owns the declaration registry/journal, observation, lifecycle fence, construction/recovery pipelines, reset/recreate authorization, exact impact re-checks, verification, and superseded-generation retirement.

The broker must not dispatch destructive operations directly to `PersistentEnvironments` or provider adapters. Doing so would bypass the lifecycle safety owners even if the RPC itself were narrow.

The existing `EnvironmentOperator` destructive authorization subject is carried through the boundary; #177 does not invent another confirmation token. Possession of a plan string must not grant an ordinary model process access to the protected mutation endpoint. Endpoint access is a separate OS/local-policy authority.

## Platform authority model

The protocol/transport/host are necessary but not sufficient for #177. The authority process, mutation endpoint, provider-management capability, and protected storage must be separated by the OS/provider identity model.

### Windows / Hyper-V

Production setup must use a dedicated protected local identity that can run the Node authority host without granting the ordinary coding-model identity the same NTFS/Hyper-V authority. Per-service SIDs are a preferred primitive because Windows can ACL exact resources to `NT SERVICE\<service>` without granting the caller the same access. A hardened scheduled-task identity remains a candidate only if real canaries prove an equivalent process and resource boundary.

The selected identity must receive only the exact DevBridge-owned backing-store/provider rights required by the lifecycle authority, while preserving VMMS/platform service access. Ordinary coding/model processes must not inherit those rights.

Named-pipe policy must also preserve the capability split. Node IPC defaults must not be widened with all-user read/write flags for the mutation endpoint. Final setup must prove that an ordinary filtered/unelevated coding-model token cannot connect to the mutation capability. If the local operator needs mutation access, use a bounded OS-authorized/elevated client path rather than placing a persistent mutation credential in the ordinary model-visible process. The exact Windows mechanism remains subject to real positive/negative canaries.

Windows named-pipe DACL design must avoid granting clients rights that permit creation of another pipe instance; mutation authority cannot be reduced to a guessable pipe name.

### Linux / libvirt

Production setup should host the authority under a dedicated local identity. That identity receives only the required protected storage access and local libvirt authorization. Fine-grained libvirt/polkit authorization should be used where available so the ordinary user/model identity does not inherit broad libvirt read-write authority.

The setup/service owner must pre-provision `/run/devbridge/<authority-id>/read` and `/run/devbridge/<authority-id>/mutation` with the intended distinct access policy. Repository/model/guest processes must not receive the mutation socket, credentials, group membership, or provider-management capability as a side effect of normal execution. A bounded polkit-authorized local mutation client is preferable to granting the ordinary model-visible identity persistent write access to the mutation socket.

## Composition rule

The ordinary installed process ultimately composes only the neutral authority client for protected lifecycle work. The protected authority process composes the existing `EnvironmentOperator` runtime, which in turn owns foundation/provider state and the lower lifecycle bricks.

Provider adapters remain replaceable Hyper-V/libvirt bricks behind neutral lifecycle/foundation studs. Provider-specific details must not be copied into controllers, CLI commands, repository routes, generalized operation manifests, or the authority wire contract.

Provider mutation reachable through lower foundation/control methods must also be moved behind the protected process before #177 is considered complete; protecting only backing-file deletion while leaving a parallel provider-control path would be an incomplete authority split.

The current ordinary CLI still constructs the local environment operator directly. That is a known migration point, not an accepted final fallback. Production composition must switch the environment CLI and relevant doctor/lifecycle inspection paths to the authority client once setup can provision and verify the protected authority. Protected mode must fail closed rather than silently recreating provider authority in the ordinary process.

## Self-refreshing reconciliation and host-use rule

The protected authority must be installed, refreshed, recovered, and re-verified through one portable reconciliation contract rather than platform-specific sequences of ad-hoc setup commands.

The operator-facing recovery command is:

```text
devbridge setup
```

A normal invocation follows this order:

1. observe the current protected installation without mutation;
2. compare the observed runtime/service/state generation with the exact local candidate;
3. if already current and healthy, perform no privileged mutation;
4. if reconciliation is required, invoke at most one bounded platform elevation transaction with closed local arguments;
5. stage exact content-addressed runtime bytes under protected ownership;
6. verify the staged bytes before replacing executable authority;
7. quiesce only the exact owned service/process when necessary;
8. promote one exact staged generation, start/restart it, and prove health;
9. durably checkpoint the observed frontier only after the corresponding effect is verified;
10. return automatically to the original ordinary identity;
11. prove the ordinary identity cannot write protected state, reach the mutation capability directly, or hold provider-management authority;
12. prove the corresponding exact-owned positive lifecycle capability through the protected authority;
13. continue to the existing read-only setup/readiness gate.

If any step is interrupted, the recovery instruction remains the same `devbridge setup` command. The reconciler must observe the durable and real host state before repeating an effect. A new hand-authored host repair command is a design failure unless the platform is in a genuinely unrecoverable/foreign state that DevBridge must refuse to seize.

The portable observe/stage/verify/quiesce/promote/start/health/checkpoint/reconcile sequencing is Node-owned. Windows SCM/ACL/elevation and Linux systemd/account/socket/provider-capability mechanics are adapters beneath that state machine.

### Protected runtime immutability

"Self-refreshing" does **not** mean the privileged authority service is self-modifying.

The service identity may write only the authority state, coordination, socket, and provider-owned data surfaces explicitly required by its local contract. Its Node executable, package/runtime tree, service entry, native host/shim, unit/service definition, and runtime ownership evidence are protected from service-identity modification after activation.

Setup/reconciliation owns runtime replacement transactionally:

- stage a new exact generation under administrator/root ownership;
- verify every staged byte/digest before activation;
- retain the prior verified generation until the replacement is healthy and checkpointed;
- roll back or resume from observed evidence without granting the service write access to its own executable supply.

### GitHub-first qualification

The physical host is a final integration target, not the primary implementation/debugging environment.

Before another physical authority run, hosted tests must cover at least:

- fresh installation;
- exact-current no-op re-entry;
- stale protected runtime refresh;
- interruption before and after every durable mutation frontier;
- a real host effect whose checkpoint update was lost;
- replacement health failure and prior-generation recovery;
- candidate/runtime drift while refresh is in progress;
- missing or damaged ownership/reconciliation evidence;
- missing/stopped/stale/unhealthy service observation;
- ordinary negative-capability verification;
- arbitrary path/command/provider-object rejection;
- rerun after interruption through the same setup contract.

Physical execution should concentrate those remaining OS/provider proofs into one resumable run rather than require interactive host repair steps.

### Platform-scoped readiness

Windows and Linux authority qualification are independent platform readiness gates.

Windows may become usable first when its shared reconciler, Windows adapter, ordinary negative proof, dedicated exact-owned VHDX positive canary, and read-only readiness gate are all proven on the real host. Linux may remain fail-closed/not-ready until its own libvirt/qcow2 authority proof is complete.

Platform-scoped readiness is not cross-platform completion: Windows readiness does not imply Linux readiness, and #177 remains open until both required platform acceptance sets are satisfied.

## #176 coordination

The exact destructive impact/confirmation stud already exists in `EnvironmentOperator` and the reset/recreate lifecycle owners. #176 remains the operator UX owner. #177 reuses that subject and keeps its validation inside the protected lifecycle composition; it does not duplicate impact logic or accept an unbound `reset by name` request.

## Migration / rollout gates

Implementation is now staged to minimize host interaction and maximize reusable shared behavior:

1. **Protocol/transport/host foundation:** closed operator-level request/result protocol; split read/mutation local capabilities; state-owned path-free endpoint namespace; bounded pre-request connections; protected host composition; adversarial tests proving lower provider/lifecycle mutation is not remotely addressable.
2. **Windows protected-authority foundation:** dedicated Windows service/state boundary and hosted permission/service/transport qualification from PR #289 remain the current platform baseline.
3. **Shared self-refreshing reconciler (#292):** extract the portable observe/stage/verify/quiesce/promote/start/health/checkpoint/reconcile state machine, exact generation/rollback evidence, interruption recovery, and one-command setup contract. Platform adapters supply only irreducible authority operations.
4. **Windows usability closure (#288):** plug the Windows authority into the shared reconciler, cross at most one bounded elevation transaction, return to the ordinary identity, run a dedicated disposable VHDX negative/positive authority canary, and reach the read-only setup readiness gate. Windows may become platform-ready here with no unprotected fallback.
5. **Linux authority closure (#293):** resume the already-qualified Linux plan/read-only inspection work on top of the shared reconciler, add Linux-only protected provisioning and libvirt/qcow2 physical negative/positive canaries, then enable Linux platform readiness.
6. **Protected client/doctor completion:** ordinary protected lifecycle composition uses only the neutral authority client for each platform whose authority is qualified; unqualified platforms fail closed. Setup/doctor report provider readiness separately from protection/readiness and never seize foreign legacy state.

#197 production-image construction/media is not an authority-test fixture and remains separate from these gates.

These are implementation seams, not permission to claim application-convention-only protection between stages. Final parent acceptance still requires the real OS/provider negative and positive canaries in #177.

## Required final evidence

Repository tests must prove protocol bounds, forbidden-field rejection, explicit operator routing, lower-mutation unaddressability, split-capability enforcement, request/result ownership, fail-closed transport behavior, bounded idle connections, long-operation transport behavior, preservation of the existing lifecycle safety owners, exact-generation refresh, interruption reconciliation, and no privileged no-op work when the exact protected generation is already current.

Real provider qualification must additionally prove:

- ordinary Windows agent identity cannot directly delete/replace the exact DevBridge test VHDX or invoke provider-control mutation authority, while the authorized lifecycle can replace it;
- ordinary Linux agent identity cannot directly delete/replace the exact DevBridge qcow2/domain or invoke provider-control mutation authority, while the authorized lifecycle can replace it;
- protected authority restart/ambiguous effects reconcile through the lifecycle/reconciliation journals rather than widening privileges;
- foreign/operator VM/storage/network objects remain untouched;
- no coding model or repository guest needs elevation, root, sudo, Hyper-V management membership, libvirt management authority, or automatic protected-IPC credentials.

Until those OS/provider gates pass for a platform, that platform must not describe the protocol/transport/host alone as backing-store protection or readiness.
