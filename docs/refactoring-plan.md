# Structural refactoring

The owner approved this program on 8 September 2026, following the structural
review of c9e83fe. Apply LEGO ownership recursively: each owner encapsulates its
decisions, state, effects, failure, and recovery; parents compose narrow child
contracts. The completion criterion is local repair and qualification, not file
geometry. Existing security, provenance, generation, and fencing contracts remain
normative.

## Sequence

1. **Native delivery:** one Hyper-V file-copy implementation, exact destination
   and content semantics, structured failures, and fresh-consumer qualification.
2. **Recovery:** explicit immutable operation subjects, crash-releasing mutation
   leases, readable committed status, continued accepted serial preparation, and
   independent readiness of selected profiles.
3. **Hello World:** GitHub-initiated compile/run/test success, compiler failure,
   and test failure in both Linux and Windows guests, with automatic results and
   restart/delivery recovery. Existing accepted images and identities are reused.
4. **Operational ownership:** independent installation, accepted image supply,
   lifecycle recovery, readiness decisions, and supported diagnostics; setup
   coordinates these owners.
5. **Component deployment:** generated dependency closure and owned assets,
   versioned component manifests, isolated candidate qualification, and compatible
   activation/rollback. Use pinned esbuild 0.28.2 for build-time graph information;
   preserve source layout and keep the installed verifier independent of it.
6. **Nested state and tasks:** bounded ledger transactions, provider-owned native
   semantics, opaque task/repository subjects, and run-owner persistence queries.
   Preserve existing GitHub durable identities through compatibility translation.
7. **Verification and documentation:** behavioral boundary tests, dependency-aware
   test selection, deduplicated CI, and explicit separation of specification,
   implementation status, and native evidence.

Real GPU support for CUDA-JS follows this program; MCP follows GPU support.

## Migration and acceptance

Preserve durable v1 formats when only ownership changes. Never run two native
mutation implementations concurrently for comparison. A changed declaration or
lost lease prevents further effects; ambiguous effects are observed before retry.
Preserve old generations, backing identity, accepted images, and useful evidence.
Legacy token locks can be migrated only after the previous authority is quiescent
and the replacement exclusive lease is held, never on age alone.

Qualify fresh first-access bootstrap separately from image construction and disk
acceptance. Test crashes before and after effects and state commits, stale
declarations, partial profile readiness, diagnostics before normal guest access,
artifact stability under unrelated changes, source substitution, and rollback.
Hyper-V evidence does not qualify KVM/libvirt. Keep native limitations explicit.

Use focused owner/consumer tests first, native qualification for relevant changes,
and full Windows/Linux regression before merging each coherent block. Track
implementation and evidence in ordinary commits and existing issues. Do not add a
parallel accounting system. No Python.

## Current evidence

The first implementation block consolidates native Hyper-V delivery, passes
explicit lifecycle operation subjects into construction, replaces the persistent
environment mutation token with process-held leases, and leaves committed status
readable during mutation. Installation owns legacy-token retirement after
quiescence. Native effect invocations receive lease-loss cancellation. Accepted
setup activation continues through ready changes and assesses independent
profiles; the elevated workflow uses the installed lifecycle authority.

Focused contract tests and the broad local Windows suite pass on Node 24.15.0:
2,638 passed, 46 skipped. The Windows executable lease has actual process-death
qualification, including Windows 8.3 path spelling and requester/holder death.
Ubuntu smoke and full regression pass on Node 22.16.0, including Linux `flock`
process qualification. Windows CI exposed short-path handling defects; their
focused reproduction passes and the full matrix must pass before merge. These
results do not establish native VM readiness.

A repeatable disposable-guest fixture now consumes the accepted finalized image,
uses production first access, and checks exact network-seed bytes through the
resulting bridge. Its contract tests reject successful delivery to the wrong path.
The first native Linux consumer received successful native copy results but failed
SSH first access. Its owned disposable guest is retained, and the previous service
is restored after each bounded inspection. The existing provider console now
supports bounded 640×480 and 1024×768 captures as well as 320×240; native capture
shows the guest waiting for network readiness during boot. The same retained
guest passed strict SSH at 129 seconds with its existing delivered seed and keys;
the earlier 90-second first-access allowance was insufficient. Access preparation
now allows at most three minutes, clips native probes and delivery to its remaining
deadline, and accepts enclosing cancellation/deadline constraints. This is
diagnostic evidence, not a successful bootstrap qualification. Windows first
access and both Hello World routes remain outstanding.

Remaining recovery and separation work includes bootstrap allocation's legacy
token, lifecycle-owned retirement authorization, consolidated capability status,
image-supply handoff, component-specific packaging, and bounded child transactions.
Bootstrap allocation's lease must be supplied by both its construction and service
parents; it must not depend on the caller's Node installation layout. Continue the
approved sequence above rather than treating this first block as the full refactor.
