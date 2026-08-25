# DB-HO009 issue #177 Windows protection-readiness gate

**Date:** 2026-08-24 PDT  
**Continuation start:** 20:29 PDT  
**Repository:** `iteathen/DevBridge`  
**Parent issue:** #177  
**Focused issue:** #288  
**Draft PR:** #289  
**Last verifier-only head:** `3971099138b5ae2fbaee2337a8a270a40a77cebe`

## CI blocker classification

The first hosted Windows run on verifier-only head `3971099...` failed outside the new protection-verifier LEGO. Three pre-existing PowerShell integration probes ended at their existing 20-second child-process boundary, and Windows smoke failed a work-runner composition test that passed later in the full suite on the same SHA.

No code was changed before falsification. Exact-head reruns then passed:

- Windows full suite, including all three previously failing PowerShell probes and doctor;
- Windows preflight, identity audit, and standalone-installer smoke;
- Ubuntu smoke/full remained green.

The load-sensitive Windows CI concern is separated as #290. #288 does not widen product timeouts or add a speculative test-harness workaround.

## Protection-readiness LEGO

The standalone protection verifier remains read-only. Final setup composition injects protection verification through the protected service reconciler's existing `probe` dependency rather than adding another service-management path.

This preserves one service/provisioning owner:

`setup readiness composition -> service reconciler -> service-owned stop/provision paths`

The composed probe performs:

1. read-endpoint inspection through the neutral lifecycle-authority client;
2. the protection verifier appropriate to the current token.

If an elevated structural proof fails after provisioning, the failure is still observed as a service health failure and the existing service reconciler stops the service. The verifier itself gains no SCM or ACL mutation authority.

## Two-phase readiness

A successful elevated setup is not sufficient to publish final readiness.

- **Elevated pass:** provision/reconcile the service, prove exact protected ACL/group structure, and prove the read endpoint. Even when successful, setup remains blocked and instructs a non-elevated re-entry.
- **Ordinary pass:** prove the read endpoint, prove the ordinary identity cannot open protected ownership state for write, and prove it cannot connect to the mutation pipe.

Only the ordinary negative-capability pass may return lifecycle-authority `ready: true` and release setup toward Ubuntu/physical status work.

This deliberately prevents an elevated token from being used as evidence that the ordinary/model-visible token is denied.

## Legacy migration stop condition

Pre-host review found that generic byte-for-byte copying is not safe for every existing deployment:

- `BaseImageLibrary` binds published objects to filesystem identity, which changes under ordinary copy;
- the Hyper-V persistent adapter stores absolute `diskPath`, `parentPath`, and `configPath` values inside provider records;
- leaving those old files in the user-owned tree would leave the real legacy backing store directly writable even if a new ProgramData copy looked protected.

Therefore setup now performs a read-only migration-safety preflight **before** SCM, ACL, service, or provider mutation. It fails closed when it observes:

- a non-empty published/staged image library;
- path-bound persistent Hyper-V provider records or backing objects;
- active image-recovery working state.

Empty/path-independent authority state may still cross the existing generic copy seam. Path-bound state must go through a separate provider-aware migration LEGO. Microsoft `Move-VMStorage` is the supported Hyper-V primitive for explicitly moving VM configuration and individual VHD source/destination paths; the future migration adapter must bind that primitive to exact DevBridge ownership rather than expose it generically.

This stop condition exists to prevent setup from claiming protection while the actual legacy VHDX or provider configuration remains in the ordinary-user tree.

## Scope exclusions

This LEGO does not:

- cut ordinary lifecycle CLI commands over to the protected client;
- expose a persistent mutation credential;
- add a generic privileged shell;
- change Hyper-V/provider lifecycle semantics;
- perform provider-aware migration of existing path-bound legacy state;
- alter #197 VM, image, network, media, or cache state;
- touch the operator's existing checkout/worktree.

## Remaining gate before client cutover

1. Hosted Ubuntu + Windows smoke/full CI on the exact integrated head.
2. Run setup migration-safety observation on the real Windows installation.
3. If it reports path-bound legacy state, stop and implement only the provider-aware migration LEGO before provisioning the service.
4. Otherwise run the setup-owned authority reconciliation without image/VM construction.
5. Re-enter from the ordinary token and require the real negative-capability proof to pass.
6. Verify foreign Hyper-V state remains untouched.
7. Only after those #288 canaries pass may #177 proceed to ordinary client cutover.
