# Setup status observation boundary

Date: 2026-08-28
Branch: `stage8/362-protected-activity-channel`

## Assessment

The parameter-free `setup.status` deterministic operation is classified as a host-control observation, but production runtime composition currently implements it by calling `runDevBridgeSetup()`.

That call is not observational. Depending on local state, setup can persist the stable command, discover credentials and repositories, update accepted setup state, install or enable prerequisites, download and persist release authority, reconcile profile configuration, request protected lifecycle reconciliation, activate environments, and publish an execution-enabled operational configuration. A trusted remote task can therefore reach local setup effects through an operation whose public contract contains no authority-bearing parameters and whose name and issue history describe it as read-only.

The defect belongs at the setup-status composition boundary. The parameter validator and remote redaction projection do not themselves grant paths or commands, and the repository-execution boundary is not involved. Calling the mutating setup coordinator is the boundary leak.

## Research

This correction introduces no new platform behavior, so no unstable external platform claim requires new web research. The governing evidence is internal and normative:

- DB-003 says remote content can request work but cannot grant machine authority, and host-control operations must have deliberately bounded local authority.
- DB-007 says silence and ordinary task admission cannot authorize a materially different effect or capability expansion.
- DB-009 requires effect intent and reconciliation before mutation; an observation operation cannot conceal setup effects.
- DB-020 requires diagnostics to remain read-only with respect to authority and requires provider/environment unavailability to fail closed.
- `docs/setup.md` and `docs/bootstrap-durability.md` separate discovery/status from explicit setup and construction effects.

Issue #259 is useful historical evidence, but its earlier assertion that setup-owned reconciliation could occur inside a “read-only gate” is not compatible with the current normative boundary. A read-only physical canary call does not make the preceding mutating setup orchestration read-only.

## Reassessment

The smallest complete correction is not to duplicate all setup reconciliation behind another facade. Runtime already possesses two trustworthy observations: its validated local configuration and the attached repository-execution contract's read-only `inspect()` result. Those are sufficient to report whether the running installation is configured, locally opted into execution, and attached to a ready execution boundary.

Construction, prerequisite, path-installation, repository discovery, media selection, and lifecycle reconciliation status must remain unobserved rather than being recomputed through mutating owners. Richer diagnostics can be added later only through dedicated observation studs owned by those modules.

The replacement therefore removes unowned fields from the remote contract and never claims construction readiness. Losing speculative detail is preferable to crossing authority boundaries or reporting effects as observations.

## Dependency-ordered plan

1. Add a small setup-status observer whose only dependencies are immutable local configuration facts and a neutral `inspect()`-style execution-status port.
2. Rename the operation dependency from a setup runner to an observer and keep the remote operation parameter-free.
3. Remove the mutating setup coordinator import and call from runtime composition.
4. Project the bounded execution-boundary status without its local identity and preserve existing path/repository redaction.
5. Test ready, disabled, unavailable, malformed, redaction, parameter rejection, source isolation, and production composition.
6. Run repository preflight and the complete suite, record exact evidence, commit, push, and update the relevant issue.

## Safety envelope

This work performs no setup reconciliation, download, prerequisite installation, elevation request, protected-service action, provider mutation, image construction, VM action, media approval, or guest execution. No UAC action is requested or permitted.

## Implementation evidence

- `status-observer` is a self-contained component with no imports. It accepts only a configured-subject count, a local enablement fact, and one neutral capability-inspection port. Its output contains only neutral state, count, enablement, and capability fields; it does not name profiles, repositories, providers, guests, lifecycle owners, or neighboring setup components.
- The observer rejects contradictory capability evidence, withholds the capability identity, distinguishes intentional local opt-out from an unavailable opted-in boundary, and never claims construction readiness.
- `setup.status` now depends on an `observeSetup` stud. The old setup-runner stud and production `runDevBridgeSetup()` import are removed rather than retained as compatibility code.
- Runtime composition supplies only already validated local configuration facts and `repositoryExecution.inspect()`. It cannot reach setup, prerequisite, media, lifecycle, construction, provider, or activation mutation through this operation.
- The previous broad projection of a mutating setup result was deleted. The remote adapter now consumes only the closed neutral observation protocol and includes bounded state/readiness/reason/count facts. It rejects foreign fields and removes local paths and slash-shaped identities from the only free-text field.
- Source-isolation tests prove the observer has no imports or effect-method calls, and runtime-source tests prevent the mutating setup coordinator from being wired back into `setup.status`.

Verification from the complete working tree:

- focused setup suite: 86 total, 85 passed, 1 platform skip, 0 failures;
- repository preflight: 110 syntax files, 2 JSON files, 104 targeted test files, passed;
- complete suite: 1,580 total, 1,565 passed, 15 platform skips, 0 failures;
- syntax checks and `git diff --check`: passed.

No UAC request, elevation process, provider mutation, image/VM action, media action, guest execution, or setup reconciliation occurred during implementation or qualification.
