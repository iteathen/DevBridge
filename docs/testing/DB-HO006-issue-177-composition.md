# DB-HO006 issue #177 protected lifecycle composition checkpoint

**Checkpoint:** 2026-08-24 PDT  
**Repository:** `iteathen/DevBridge`  
**Base branch:** `cuda-target`  
**Exact base:** `4bea25e4358ad43ae9166f224235244b19eb8500`  
**Issue:** #177  
**Dispatch:** #286

## Ownership target

This checkpoint evaluated the composition LEGO immediately after the bounded lifecycle authority protocol/transport/host foundation merged in PR #282.

The invariant is one semantic lifecycle owner:

`ordinary production control plane -> neutral lifecycle authority client -> protected authority process -> existing EnvironmentOperator/recovery owner -> existing foundation/provider adapters`

The production surface must not add a second lifecycle API, expose lower `PersistentEnvironments` or provider mutations, accept provider-native identities/paths/commands from callers, or retain a silent ordinary-process provider-mutation fallback when the protected authority is unavailable.

Read and mutation capabilities remain distinct.

## Pre-source gate

The branch was intentionally documentation-only before implementation-source inspection. Draft PR #287 ran the repository clean-checkout CI first.

Initial exact candidate: `09ed5defc0e94e0bdda415218f52531031cb80d0`.

CI run `32789653211` passed all four jobs:

- Ubuntu smoke/preflight: passed;
- Ubuntu test/full suite/doctor: passed;
- Windows smoke/preflight: passed;
- Windows test/full suite/doctor: passed.

Only after both hosted preflights passed were implementation composition surfaces inspected.

## Finding: composition cutover is correctly blocked by missing production authority provisioning

The intended client/host boundary already exists:

- `src/runtime/environment-lifecycle-authority.js` owns the bounded neutral protocol/client;
- `src/runtime/environment-lifecycle-authority-transport.js` derives separate read and mutation endpoints and exposes no local-provider fallback;
- `src/app/environment-lifecycle-authority-host.js` correctly composes the existing high-level `EnvironmentOperator` behind the protected host boundary;
- `src/app/environment-operator-runtime.js` remains the one semantic lifecycle/recovery owner.

The ordinary installed composition is not cut over yet:

- `src/cli.js` still directly constructs `createLocalEnvironmentOperator(config)` for environment commands and doctor;
- `src/app/runtime.js` does not start or compose an environment-lifecycle authority host;
- `src/app/daemon.js` does not start or own an environment-lifecycle authority host;
- `src/app/setup.js` does not provision/start the protected authority or establish its operating-system identity/access policy;
- the production entry inventory contains the authority host module and tests, but no installed authority-service entry that establishes the protected process before client cutover.

Therefore replacing the CLI/doctor local operator with the authority client in this slice would not establish #177 security. It would only make lifecycle/doctor fail closed because no protected production authority exists to answer. Retaining the existing local operator as a fallback would violate the #177 no-fallback contract and preserve the original destructive authority.

This is the exact `blocked_architecture` stop condition declared by #286: protected production composition cannot be activated truthfully before the OS/service identity and endpoint/storage access boundary exists.

## Corrected LEGO order

Do not merge a client-only cutover first. The next bricks are:

1. establish the Windows protected authority identity/service/endpoint/backing-store access boundary needed by the current physical usability path, with exact negative ordinary-process access proof and no generic privileged shell;
2. establish the equivalent Linux authority/polkit/storage boundary;
3. only then cut ordinary CLI/doctor/setup lifecycle composition over to the neutral authority client with no in-process provider fallback;
4. prove real negative/positive provider canaries and protected-storage migration/recovery under #177.

This preserves one lifecycle semantic owner. Platform authority remains a separate adapter/setup responsibility; composition remains topology only.

## Separation from #197

Issue #197 physical construction remains independently preserved at its v4 read-only public gate. This branch changed no Ubuntu construction/canary/media code and performed no physical host mutation.

## Outcome

- No production source was edited.
- No fallback was added.
- No lower provider mutation was exposed.
- The only branch changes are this evidence record.
- #286 should close as an ordering/architecture stop, not merge as a fake security cutover.
- #177 remains open; its next implementation brick is protected operating-system authority provisioning, beginning with Windows for the active Hyper-V usability path.
