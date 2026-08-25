# DB-HO009 issue #177 Windows protection-readiness gate

**Date:** 2026-08-24 PDT  
**Continuation start:** 20:29 PDT  
**Repository:** `iteathen/DevBridge`  
**Parent issue:** #177  
**Focused issue:** #288  
**Draft PR:** #289  
**Physically qualified predecessor head:** `b947d7812b15d34ff7eb4b803fe7f58ab50722e1`

## CI blocker classification

The first hosted Windows run on verifier-only head `3971099...` failed outside the new protection-verifier LEGO. Three pre-existing PowerShell integration probes ended at their existing 20-second child-process boundary, and Windows smoke failed a work-runner composition test that passed later in the full suite on the same SHA.

No code was changed before falsification. Exact-head reruns then passed:

- Windows full suite, including all three previously failing PowerShell probes and doctor;
- Windows preflight, identity audit, and standalone-installer smoke;
- Ubuntu smoke/full remained green.

The load-sensitive Windows CI concern is separated as #290. #288 does not widen product timeouts or add a speculative test-harness workaround.

## Protection-readiness LEGO

The standalone protection verifier remains read-only. Setup composition injects verification through the protected service reconciler's existing `probe` dependency rather than adding another service-management path.

This preserves one service/provisioning owner:

`setup readiness composition -> service reconciler -> service-owned stop/provision paths`

The composed Windows readiness probe now requires independent evidence in this order:

1. exact SCM service identity/state/command proof;
2. read-endpoint inspection through the neutral lifecycle-authority client;
3. token-appropriate protection proof.

The SCM proof is observation-only. A same-named read pipe is not accepted as authority identity by itself.

If an elevated protection proof fails after provisioning, the failure is still observed as a service health failure and the existing service reconciler stops the service. Neither verifier gains SCM or ACL mutation authority.

## Two-phase physical proof on predecessor head

Exact predecessor head `b947d7812b15d34ff7eb4b803fe7f58ab50722e1` passed hosted CI run `32807095893` across Ubuntu/Windows smoke, full suites, architecture gates, installer regression, and doctor before physical qualification.

The physical Windows host then proved the intended two-phase contract under `WDRFJK6T\josho`:

1. **Ordinary preflight** — non-elevated setup stopped at the explicit elevation boundary. The migration-safety preflight did not report path-bound legacy state. No service/ACL/Hyper-V/VM/image mutation occurred.
2. **Elevated structural pass** — the same operator identity established/reconciled the protected lifecycle service and state boundary. Setup reported structural verification and deliberately refused to publish final readiness from the elevated token.
3. **Fresh ordinary re-entry** — a fresh non-elevated PowerShell passed protected-state write denial and mutation-pipe denial, exited `0`, and reached `DevBridge setup reached the construction gate`. Output reported `Windows lifecycle authority: protected service/state ready` and explicitly stated that no image or VM construction had occurred.

`--construct` was never invoked during this security qualification.

This is real evidence for the selected Windows authority mechanism and the two-phase ordinary/elevated readiness model. It is not claimed as physical qualification of later service-host hardening commits described below.

## Post-physical off-host hardening

After the physical two-phase proof, review found additional adapter-level hardening that can be qualified without repeatedly touching the workstation.

### Persistent first-instance named pipes

The C# SCM host now:

- creates exactly one server instance per read/mutation capability;
- uses `PipeOptions.FirstPipeInstance`;
- keeps that instance alive across client connections with `Disconnect()` instead of disposing/recreating the named pipe after every request;
- fails the service process closed on fatal endpoint failure so the SCM failure policy owns restart rather than permitting an insecure replacement window.

The existing .NET `PipeAccessRights.ReadWrite` client ACE remains narrower than generic Win32 write and does not add `CreateNewInstance` to ordinary clients.

### Worker credential scrubbing

Before spawning the protected Node worker, the SCM host removes ambient operator credential channels including:

- `NODE_OPTIONS`, `NODE_PATH`;
- `GH_TOKEN`, `GITHUB_TOKEN`, `DEVBRIDGE_GITHUB_TOKEN`;
- `GIT_ASKPASS`, `SSH_ASKPASS`, `SSH_AUTH_SOCK`;
- DevBridge coordination/release/signing private-key environment variables.

The worker therefore receives fixed protected runtime arguments without inheriting common operator/model credential channels from the service environment.

### Independent SCM identity proof

Readiness now observes `Win32_Service` before trusting the read pipe and requires:

- exact deterministic service name;
- exact `NT SERVICE\<service-name>` virtual account;
- `Running` state;
- automatic start mode;
- exact protected service command line.

The deterministic Windows authority plan is the single owner of that command formula. Provisioning and verification consume the same `serviceCommand` value rather than reconstructing it separately.

An existing protected installation also rejects a different operator SID before protected-root initialization, preventing setup re-entry from silently rebinding read capability to another Windows identity.

## Legacy migration stop condition

Pre-host review found that generic byte-for-byte copying is not safe for every existing deployment:

- `BaseImageLibrary` binds published objects to filesystem identity, which changes under ordinary copy;
- the Hyper-V persistent adapter stores absolute `diskPath`, `parentPath`, and `configPath` values inside provider records;
- leaving those old files in the user-owned tree would leave the real legacy backing store directly writable even if a new ProgramData copy looked protected.

Therefore setup performs a read-only migration-safety preflight **before** SCM, ACL, service, or provider mutation. It fails closed when it observes:

- a non-empty published/staged image library;
- path-bound persistent Hyper-V provider records or backing objects;
- active image-recovery working state;
- malformed migration evidence.

Empty/path-independent authority state may still cross the existing generic copy seam. Path-bound state must go through a separate provider-aware migration LEGO. A future Hyper-V migration adapter must bind supported provider movement to exact DevBridge ownership rather than expose arbitrary storage paths.

This stop condition exists to prevent setup from claiming protection while the actual legacy VHDX or provider configuration remains in the ordinary-user tree.

## Scope exclusions

This LEGO does not:

- cut ordinary lifecycle CLI commands over to the protected client;
- expose a persistent mutation credential;
- add a generic privileged shell;
- change `EnvironmentOperator` lifecycle semantics;
- perform provider-aware migration of existing path-bound legacy state;
- implement the broader application uninstall policy owned by setup/uninstall work (#116/#177);
- alter #197 VM, image, network, media, or cache state;
- touch the operator's existing checkout/worktree.

## Remaining acceptance and host-conservation policy

No further ad-hoc host commands should be used while PR #289 is changing. Hosted Windows/Ubuntu qualification owns compiler, protocol, unit, architecture, and regression evidence for the current code.

The physically unavoidable provider proof is deferred until an exact disposable **protected** environment/backing disk exists. It should be bundled into one final canary rather than creating a fake privileged test surface or repeatedly exercising the workstation:

1. qualify the final exact PR head in hosted Ubuntu + Windows smoke/full CI;
2. if merge policy requires the newly hardened service binary itself to be requalified physically, reconcile that exact head once through the existing setup owner;
3. with an exact disposable protected DevBridge environment, prove the ordinary identity cannot delete/replace its backing disk;
4. prove the same exact-owned lifecycle effect succeeds through the protected authority after normal impact/fence/ownership checks;
5. prove foreign/operator Hyper-V state remains untouched and service restart/re-entry preserves the exact authority identity;
6. only then claim the Windows real-provider portion of #288 complete and proceed to the separate ordinary client-cutover LEGO.

The earlier two-phase physical proof remains durable evidence, but it is intentionally not relabeled as exact-head qualification for later hardening commits.
