# DB-003 — Local Security and Capability Policy

Status: active

Implementation status: Stage 1 has removed active host-sandbox repository execution. Production composition intentionally has no repository execution provider; repository-controlled operations, proposal workers, repository-class onboarding probes, and candidate-controlled execution fail closed before host execution. `src/runtime/repository-execution.js` is the provider-neutral attachment surface for later VM providers. DB-020 is normative for persistent untrusted VMs, with the trusted DevBridge controller and all host authority outside the guest.

## Fundamental rule

Remote content can request work; it cannot grant machine authority.

DevBridge is the control-plane authority. Remote and local models are proposal engines. Human remote input is authoritative only for task authorship or decision classes that local operator policy explicitly delegates; it is not a general capability override.

For repository-controlled execution, read this specification with DB-020. Where older host-sandbox concepts conflict with DB-020, DB-020 governs.

## Task authorship is real remote job-submission authority

A runner's local `github.trustedActorIds` determines which numeric GitHub actors may author trusted tasks for that runner's configured queue under DB-002.

When local execution is enabled, a trusted task actor can cause development work to execute on that machine **inside the machine authority already granted by local policy**. The actor cannot grant arbitrary shell, executable, host-filesystem, environment, credential, network, VM-management, peer-trust, daemon-control, or publication capability through task text, but the actor is still a remote development-job submitter.

Do not derive `trustedActorIds` mechanically from repository collaborator/team membership. Repository collaboration, DB-016 coordination peer trust, DB-007 decision authority, and task-submission authority are separate permissions.

Current task envelopes are not cryptographically addressed to one destination installation. DB-016 leases prevent conflicting compliant task ownership; they do not decide which human may dispatch work to which workstation. If developer A must not dispatch work to developer B's runner, B's local queue/`trustedActorIds` policy must enforce that boundary until a dedicated addressed-dispatch contract exists.

## Trusted host and untrusted repository guests

DB-020 makes the security partition explicit:

- the DevBridge controller, daemon/control state, GitHub API client, coordination keys, release/signing state, VM-management adapter, authoritative Git state, candidate sealing, publication, and human-decision authority remain on the trusted host;
- each repository execution environment is an untrusted VM and may be fully compromised, including administrator/root compromise;
- repository content, package scripts, tests, build systems, tool plugins, coding-worker subprocesses, and guest-local Git are all untrusted guest state;
- the guest receives no host credential broker, arbitrary writable host mount, host control-state path, authoritative Git administration, or hypervisor-management authority;
- a guest process escaping only to guest root has not crossed the DevBridge trust boundary.

The security claim does not depend on a second Bubblewrap/AppContainer/ProcessContainer layer inside the VM.

During the Stage-1-to-Stage-5 migration interval there is no production repository execution provider. This intentional capability gap is safer than retaining or recreating host-process isolation as a fallback.

## Filesystem authority

### Host filesystem

Remote tasks never supply host local paths.

DevBridge host-side code may access only the managed state/workspace/runtime roots and explicit operator-owned integration boundaries required by its control functions. Host path handling must still defend against traversal, symlink/junction/reparse escape, unsafe deletion, and unowned cleanup.

An arbitrary existing user checkout is never auto-cleaned or reset.

Repository guests must not receive arbitrary host filesystem visibility. In the DB-020 target:

- repository source/candidate bytes cross through the narrow bridge as bounded transfer objects or guest-relative paths;
- guests do not name host paths;
- authoritative host `.git` / linked-worktree administration is not a guest mount;
- operator home, DevBridge state, credential stores, release keys, coordination keys, and VM-management state are not guest-visible;
- ordinary toolchains/SDKs/package caches needed by repository work belong in the guest environment rather than being exposed from arbitrary host read roots.

`workspace.externalReadRoots` and similar host-read allowances are legacy migration concepts for repository execution. Stage 8/9 decide their config migration/removal; they do not authorize repository-code host execution during the no-provider interval.

### Guest filesystem

A repository VM owns a persistent guest filesystem for ordinary development state. Guest root may read or mutate it completely.

Persistence is not authority: build outputs, package caches, installed tools, guest configuration, and guest Git remain untrusted. Reset/reseed must be an explicit host-owned lifecycle operation under DB-020/DB-009.

## Process execution

Host control-plane child processes use `shell: false` unless an explicitly separate local adapter owns shell semantics. Free-form task text is never interpolated into host argv.

Executable identity and authority-bearing/static argv fragments for host control/static work come only from built-in DevBridge code or local control configuration. Environment inheritance is allowlist-based and control credentials are not passed to untrusted execution.

Repository-controlled executable work is classified separately from trusted/static host work:

- **host control/static operations** may remain on the host only when their implementation cannot be redirected into repository-controlled code through plugins, hooks, config, filesystem indirection, shell expansion, or equivalent mechanisms;
- **repository-controlled operations** require the DB-020 repository execution boundary;
- **unknown future operations** default to the repository-controlled class until deliberately classified;
- repository/controller/model content cannot reclassify an operation as trusted host execution.

`cwd` is not containment. A declaration that an operation is isolated is not evidence. Admission must verify the actual environment/provider required by its execution class.

Stage 1 makes the separation structural: host control/static work may use the host deterministic process runner, while repository-code work delegates through the provider-neutral repository-execution contract. If that contract reports unavailable, repository code is not spawned on the host.

The Stage-1 execution contract owns logical repository/run/operation/tool identities, environment-relative locations, bounded transfer capabilities, timeout/cancellation/activity, and normalized result evidence. It does not accept host executable paths, host process-runner objects, sandbox/VM implementation names, mailbox paths, mounts, or provider transports.

## Dynamic local-operation onboarding

DB-015 permits a narrow local extension mechanism without changing the authority model.

- Operator-authored operation manifests live in an explicitly configured local directory and are validated before registration.
- Automatic unfamiliar-tool onboarding is off by default and requires local configuration to pre-authorize the exact command name plus fixed help-probe arguments.
- Merely finding a binary, seeing its name in repository content, or receiving a GitHub request cannot trigger execution or registration.
- Help/man/spec output is untrusted data and can populate only a bounded closed parameter schema after local probe authority already exists.
- Authority-shaped parameter names, arbitrary argv, shell text, credential values, host paths, and capability grants are rejected.
- Generated `tool.*` operations remain repository-controlled execution by default.
- Generated manifests are persisted in a control-owned manifest root before activation and are reconciled on restart.

Repository-class unfamiliar-tool probes and generated operations ultimately run inside the appropriate repository VM, not in a host process. During the Stage-1-to-Stage-5 no-provider interval, probes requiring repository execution are reported unavailable rather than resolved/executed through host PATH. Existing control-owned manifests may still be parsed/registered, but registration creates no execution readiness.

Host-side discovery remains appropriate for DevBridge control-plane prerequisites such as Node, Git, Hyper-V management, and bridge/bootstrap tools.

## Host secrets and credentials

The trusted host owns all credentials that create DevBridge control authority.

Guests never receive, directly or through a broker:

- `DEVBRIDGE_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, enterprise GitHub token variables, Git/SSH askpass variables, or `SSH_AUTH_SOCK` carrying host authority;
- GitHub CLI credential storage;
- coordination private keys;
- release/signing keys or release-manifest selection authority;
- daemon-control tokens/locks;
- hypervisor-management credentials/capability;
- arbitrary operator-home credentials.

Because DB-020 guests have network access by default, any secret present in a guest must be treated as exfiltratable.

Private-source, coding-service, or other authenticated workflows therefore require explicit later designs that preserve the host-only authority rule. Stage 6 owns the exact coding/model-adapter topology and any narrowly scoped relay mechanism. Copying a host token into a persistent guest for convenience is not authorized.

## GitHub control-plane authentication

GitHub authentication is local host authority. Repository content, issue text, model output, guest state, and coding-tool configuration cannot select a credential source or cause a credential to be copied into a guest.

The current control plane supports:

1. an explicit bounded list of environment-variable names, with reference precedence `DEVBRIDGE_GITHUB_TOKEN`, `GH_TOKEN`, then `GITHUB_TOKEN`;
2. when local policy uses `auto` or `github-cli`, the credential already stored for the configured host by GitHub CLI, retrieved with a fixed `gh auth token --hostname <host>` call using `shell: false`.

Rules:

- do not scan arbitrary environment names or arbitrary files for token-like values;
- environment-variable names are configuration; their values are secrets and never serialized into config, run state, context, diagnostics, inventory, VM metadata, or GitHub status;
- GitHub CLI is a local credential broker only; token output remains inside the trusted host control plane;
- resolved credentials are shared only with host adapters that explicitly require that authority;
- secret values enter the local redaction set before outbound reporting;
- `doctor` may report provider/source identity such as `GH_TOKEN` or `github-cli:github.com`, but never token contents;
- remote tasks cannot reorder providers, add credential variables, select another account, or enable a broader auth mechanism.

Future GitHub App authentication belongs behind the same local credential-provider boundary.

## Narrow host↔guest bridge

The DB-020 bridge is an authority boundary, not a shared-filesystem convenience layer.

It may carry only bounded, locally admitted operations such as structured context, source/file transfer, guest command requests, command exit/output/liveness, and result/candidate retrieval.

Guest-controlled input must not be able to name arbitrary host paths, host executables, Git refs, credentials, VM-management targets, daemon state, or publication effects. Bridge messages should use logical environment/run/operation identities, guest-relative paths, and opaque host transfer IDs.

The exact transport is intentionally deferred to VM Stage 4. Transport selection must not change this authority partition.

## Worker/result ownership

The semantic worker protocol remains control-owned even when its transport changes.

Stage 1 retains a private control-owned worker-exchange root with filesystem-identity/hard-link checks for durable run/turn context and result recovery. The repository-execution LEGO receives only input/output transfer capabilities backed by that exchange; it does not receive the host paths, mailbox object, or filesystem transport. Later VM bridge stages may implement those transfer capabilities differently without changing worker/result meaning.

The durable invariants are:

- exact run/turn/environment identity;
- control-generated context digest;
- bounded result size and strict result protocol parsing;
- no result becomes authority merely because the guest produced it;
- ambiguous/interrupted result recovery revalidates exact identities before consumption;
- guest output cannot overwrite host control state directly.

VM Stage 4/6 reconnects these semantics to real guest transport through the same execution/transfer studs.

## Network

Repository guests have normal network connectivity by default under DB-020.

This changes the repository-execution confidentiality model from the removed host sandbox. DevBridge does not rely on default network denial to protect host secrets; it protects them by keeping them out of the guest trust domain entirely.

Consequences:

- package managers, SDK installers, documentation, source downloads, test endpoints, browser workflows, and similar guest tools may use normal networking;
- repository code may exfiltrate anything present in the guest, so host secrets must not be present;
- guest networking does not grant GitHub publication, coordination, release, daemon, or hypervisor authority;
- optional offline/restricted guest modes may exist for workload reasons, but they are not the required security foundation;
- publication remains a host control-plane operation with host credentials.

Network behavior for trusted host control-plane operations remains capability-scoped and minimal.

## Authoritative Git and publication

Authoritative Git is host-only under DB-008 and DB-020.

The guest may have ordinary Git installed and may create arbitrary guest-local commits/branches/remotes. Those objects are untrusted development state and cannot satisfy DevBridge's candidate or publication authority.

Source enters the guest through the host-controlled synchronization path. Candidate bytes return through the bridge. The host then validates the expected repository/baseline/run subject, applies/imports accepted changes into authoritative Git state, verifies/seals the exact candidate, and performs any permitted publication.

Guests do not receive GitHub publication credentials or a writable mount of authoritative `.git` state.

## Human decisions and hard gates

DB-007 defines checkpoints, decision boundaries, and hard gates. These mechanisms do not weaken this security policy.

A trusted human decision may authorize only effects whose decision class is already enabled by local policy. A remote approval cannot add a host filesystem root, executable, environment secret, credential, guest secret injection, VM-management capability, trusted task actor, trusted coordination peer, or execution-boundary exception.

Approval cannot convert an unverified VM/provider/environment claim into verified enforcement. Payload-sensitive approval remains artifact-exact and expires/stales under DB-007.

Human attention is not a mutex: while a checkpoint is pending, DevBridge may continue reversible work inside the existing capability envelope without crossing the gated boundary.

## Multi-agent coordination is not capability authority

DB-016 persistent keys, peer trust, leases, heartbeat/TTL, and fencing coordinate ownership among installations already locally authorized to participate.

A task lease does not grant task authorship trust, repository permission, executable/tool authority, host/guest filesystem authority, credentials, VM-management authority, human approval, addressed-dispatch permission, or publication authority.

Coordination private keys remain host-only and never enter repository guests. Lease loss/expiry fences later DevBridge-authorized effects and aborts/cancels managed execution where supported.

## Secrets and reporting

Before data leaves the machine through GitHub status, checkpoint, decision request, inventory projection, lease/status projection, or handoff comments:

- redact configured secret values and recognizable credential forms;
- redact additional locally configured sensitive patterns;
- strip unsafe control/terminal escapes;
- bound output size;
- never include a complete process or guest environment;
- avoid publishing machine-specific host paths when a relative/logical form is sufficient;
- never publish private identity/release keys, host credentials, or sensitive VM-management details.

Raw local evidence may be retained under bounded control-owned policy, but credentials/private keys are recorded only in their explicit protected authority stores where required.

## Resource containment and workstation governance

Timeouts, output limits, effective task concurrency, context size, lease timing, and resource policy are bounded local authority.

DB-018 currently provides serialized task admission, below-normal priority for trusted host child processes, and cooperative token-bound pause/resume. Process priority is QoS, not containment and is not applied to repository execution through the provider-neutral boundary.

In the VM architecture, CPU/memory/disk/lifecycle constraints belong to the VM/provider/resource layer where the platform can actually enforce and report them. Stage 7 must avoid claiming quotas or cleanup guarantees the provider does not prove.

Timeout/cancellation must stop the intended guest operation/process tree through the bridge/provider without deleting persistent repository disk state. Daemon pause remains admission control and must not break DB-016 lease heartbeat/fencing.

## Recovery safety

Recovery code must not become a privileged bypass.

- Do not blindly delete Git locks or VM/disk objects because they appear stale.
- Do not destructively clean/reset an unmanaged checkout or unowned VM/disk.
- Observe exact host Git, VM, disk, environment, bridge, lease, candidate, and approval state before repeating effects.
- A crashed/unreachable guest is infrastructure uncertainty, not permission to broaden host authority or discard persistent state.
- Reset/reseed/delete require proven DevBridge ownership and the DB-020 lifecycle contract.
- Imported guest results/candidates remain proposals and must re-enter normal validation/sealing.
- Persisted verifying/publishing state rechecks current local candidate/baseline/lease/gate/environment identity before later effects; stale verification or approval is never trusted merely because it was previously recorded.

## Verification requirements

Security enforcement claims require observed evidence.

During the Stage-1-to-Stage-5 no-provider interval, capability reporting must explicitly show repository execution unavailable. The absence of a repository executor is not an enforcement claim and never authorizes host fallback.

After VM restoration, repository-code readiness must bind to observed VM/provider/base-image/repository-environment/bridge evidence defined by DB-020 and Stage 7.

At minimum later VM qualification must prove a hostile/administrator guest cannot obtain host credentials, authoritative Git/publication state, DevBridge control state, coordination/release keys, arbitrary host mounts/paths, or VM-management authority; normal guest network access must remain compatible with those confidentiality claims.

DB-019 governs verification cost/evidence identity. Security/provider changes may require expensive qualification; valid exact evidence should still be reused when its candidate/environment/policy identity has not changed.
