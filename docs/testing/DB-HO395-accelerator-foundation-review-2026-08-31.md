# Accelerator foundation review — 2026-08-31

## Scope

Independent post-integration review of the host-retained accelerator foundation integrated into `cuda-target` by PR #401.

Reviewed ownership slices:

- #396 — neutral compute requirement/capability contract;
- #397 — read-only Windows/Linux CUDA backend inventory;
- #398 — bounded accelerator broker protocol;
- #399 — transportless durable broker core;
- #400 — immutable file-backed broker ledger store.

The cumulative capability was reviewed against `AGENTS.md`, DB-003, DB-009, DB-015, DB-019, DB-020, issue #395, the actual source/tests, and the integrated PR diff rather than treating prior PR descriptions or CI as proof of architecture correctness.

## Result

Three slices are structurally sound within their declared scope:

1. #396 keeps neutral capability matching provider-free, exact on profile/environment/topology, and explicit about independent evidence rather than a scalar quality score.
2. #398 exposes only the sealed `cuda.canary.u32-add-v1` semantic operation; it carries no raw host command, executable, filesystem path, device identity, module bytes, kernel text, credential, or transport address.
3. #400 implements the broker `load/create/compareAndSwap` port as immutable digest-addressed revision history and correctly limits its durability claim to process/service restart and cross-process CAS rather than power-loss durability.

The broker core in #399 is acceptable only with an explicit composition gate described below. One concrete #397 defect requires correction before the inventory can be used as trusted host observation.

## Confirmed defect — Windows executable authority is inherited from mutable environment roots

The Windows native and WSL inventory adapters describe their subprocesses as fixed trusted system executables, but their default executable candidates are derived from inherited values such as `SystemRoot`, `WINDIR`, `ProgramW6432`, and `ProgramFiles`.

The resolver checks that the derived candidate is a regular non-symlink file and returns its `realpath`, but it does not independently bind the root itself to trusted platform authority. Consequently a caller that launches the inventory process with altered inherited roots can redirect the supposedly fixed `nvidia-smi.exe`, `wsl.exe`, or `nvcuda.dll` observations to caller-selected files while still satisfying the adapter's current local checks.

This conflicts with DB-003's rule that host-control executable identity/static argv come only from built-in DevBridge code or local control configuration and with DB-015's rule that inventory reports authority rather than creating executable authority from discovery/input.

The correction must live in a reusable Windows platform executable/root resolver, not as NVIDIA/WSL-specific path policy duplicated inside the accelerator adapters.

Required properties:

- establish trusted Windows system/program roots from a platform-owned local authority boundary;
- reject inherited-root substitution, canonical-path drift, symlink/junction/reparse escape, and file substitution;
- let accelerator adapters request only closed logical identities such as the Windows system CUDA-driver library, Windows `nvidia-smi`, and Windows `wsl` runtime;
- preserve fixed argv, `shell:false`, timeout/output bounds, and no remote/controller argument surface;
- project no host path or vendor-specific local identity through the neutral inventory protocol;
- add poisoned-environment and path-substitution regression coverage.

Until corrected, the current Windows inventory result should be treated as diagnostic candidate evidence only, not as an input to qualification or execution authority.

## Mandatory pre-transport gate — active effect reconciliation across binding generation retirement

#399 deliberately re-resolves the current binding before nonterminal ensure, observe, and cancel operations. If the same session's expected environment/backend/session generation changes, the core fences the stale backend and persists `unknown/state-unknown` without touching it.

That fail-closed behavior is correct for the transportless slice by itself. It must not, however, become the lifecycle policy for a real backend. A running effect cannot simply become unreachable when a backend/environment generation is replaced.

Before a concrete transport/backend may activate a new generation, composition must prove one of these equivalent safe outcomes:

1. drain/fence/reconcile every nonterminal ledger record for the retiring generation and prove quiescence before the new generation becomes current; or
2. retain a narrowly scoped exact old-generation reconciliation capability that permits observation/cancellation only, never new execution, until every admitted effect becomes terminal/reconciled.

A generation transition that merely makes prior effects permanently `unknown` is insufficient for #395's restart/cancellation/backend-loss acceptance and would not satisfy DB-009's observe/reconcile-before-repeat discipline.

Required tests before transport qualification:

- running execution during attempted backend generation replacement;
- cancel intent present during replacement;
- broker/backend restart before and after retirement intent;
- response loss plus generation transition;
- no new execution on a retired generation;
- old admitted effect remains observable/cancellable or generation activation is blocked until quiescent;
- new generation cannot become authoritative while old effect state is ambiguously live if the backend can still produce effects.

This is a composition/lifecycle gate, not authority to weaken #399 by blindly invoking a stale backend object.

## Documentation correction

`docs/host-retained-cuda-backend-inventory.md` still says the next Windows physical gate is to run the new multi-backend inventory, while the #397 integration evidence records that the Windows native substrate inventory has already been run and classified as `candidate` with WSL `blocked`. The active document should be reconciled to the actual evidence and should continue to state that transport/security and real CUDA execution remain unqualified.

## Nonclaims

This review does not qualify CUDA execution, a VM-to-broker transport, Windows/Linux broker service security, physical display continuity, cancellation on real hardware, backend restart, resource isolation, setup/doctor routing, or a Linux physical GPU host.
