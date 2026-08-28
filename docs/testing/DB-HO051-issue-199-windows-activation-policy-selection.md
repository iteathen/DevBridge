# DB-HO051: Windows activation-policy selection

Status: implemented and verified

Issue: [#199](https://github.com/iteathen/DevBridge/issues/199)

## Assessment

Stage 8 can currently select and construct the Windows execution profile, publish its environment declaration, and advance toward protected activation. It does not yet require an explicit local Windows licensing posture. Consequently, a completed image could eventually be reported operational without distinguishing a licensed activation path from a deliberately deferred one.

This boundary belongs to local setup policy, not to the image constructor, VM provider, guest bridge, repository controller, or remote task. A repository or remote agent must never choose a product key, activation service, host entitlement, or licensing mode. The first safe increment must not collect a secret or execute an activation command.

The existing `devbridge/setup-authority-record-v1` contract already owns independent per-profile construction, distribution, activation, and declaration authority. Windows activation selection should attach through that contract by an opaque subject rather than create a competing authority mechanism.

## Primary-source research

- Microsoft documents KMS, Active Directory-based activation, and MAK as distinct volume-activation methods with different connectivity, key, monitoring, and deployment requirements: <https://learn.microsoft.com/en-us/windows/deployment/volume-activation/volume-activation-windows>
- Microsoft's client-activation guidance distinguishes KMS renewal, domain/GVLK requirements for Active Directory-based activation, and MAK activation through Microsoft services: <https://learn.microsoft.com/en-us/windows/deployment/volume-activation/activate-windows-clients-vamt>
- Active Directory-based activation is tied to domain membership and GVLK configuration; it is not a generally inferable host property: <https://learn.microsoft.com/en-us/windows/deployment/volume-activation/active-directory-based-activation-overview>
- Subscription and inherited activation have explicit qualifying conditions and therefore cannot be generalized into automatic host-license reuse: <https://learn.microsoft.com/en-us/windows/deployment/vda-subscription-activation>
- `slmgr.vbs` product-key installation and activation are privileged guest operations and are not appropriate for this non-elevated policy slice: <https://learn.microsoft.com/en-us/windows-server/get-started/activation-slmgr-vbs-options>
- Windows Data Protection API storage is scope- and account-sensitive. Introducing a product-key vault requires a separate complete secret-lifecycle design rather than an incidental setup-state field: <https://learn.microsoft.com/en-us/windows/win32/seccrypto/example-c-program-using-cryptprotectdata>

## Reassessment

The smallest correct slice is an explicit, non-secret `configure-later` selection:

- the Windows profile cannot pass the new licensing-policy gate until the operator chooses it locally;
- choosing it records that Windows activation remains required, without claiming entitlement or attempting activation;
- the accepted policy is immutable and digest-addressed;
- setup authority carries only the opaque policy subject;
- accepted authority with a missing or substituted policy record fails closed;
- setup status and handoff expose only bounded mode/readiness, never the opaque subject or secret material;
- Linux setup and incomplete Windows media/image construction remain independently progressable;
- no UAC, provider call, VM mutation, guest command, key collection, host-license inference, or coding-model fallback occurs.

Retail, MAK, KMS, Active Directory-based activation, and subscription activation remain intentionally unimplemented until each has a complete local authority, secret-handling, guest-operation, invalidation, and uninstall contract.

## Plan

1. Add an isolated Windows policy value module that accepts only the non-secret `configure-later` record, derives its canonical opaque subject, and rejects extra or secret-shaped fields.
2. Add a narrow persistence port for immutable policy records in a dedicated setup state file.
3. Add an application reconciler that composes that policy port with the existing generic setup-authority manager. Use a component-owned operation prefix, resume only its own interrupted generation, and reject foreign transactions.
4. Add `devbridge setup --windows-activation later`; reject duplicate/unknown values, use outside the Windows profile, and propagation into the protected lifecycle child.
5. Reconcile explicit policy choice early, but enforce the gate only after selected image construction is complete and before profile publication, protected lifecycle/environment activation, or operational enablement.
6. Add bounded status/handoff output that clearly reports `configure later` and `activation required`.
7. Test deterministic policy identity, strict schemas, restart recovery, missing/substituted records, no-option behavior, option boundaries, Linux independence, Windows gate placement, and module isolation.
8. Run focused tests, repository preflight, the full suite, document implementation evidence, commit, push, and update issues #199 and #116. Keep both open until their broader acceptance criteria are proved.

## Protected-operation constraint

The operator has stated that UAC is unavailable for the next three days. This slice must remain entirely non-elevated. Protected Hyper-V work and real guest activation are deferred; no prompt or bypass attempt is permitted.

## Implementation

The completed slice adds four isolated owners:

- `windows-activation-policy.js` owns the closed non-secret value contract and deterministic opaque subject;
- `immutable-subject-record-state-store.js` owns publish-once subject-addressed persistence without understanding the record's domain;
- `setup-windows-activation-policy.js` composes the policy and generic setup-authority ports through a restartable component-owned transaction;
- `setup.js` maps the bounded status into the public setup gate and handoff.

The public CLI accepts only:

```text
devbridge setup --windows-activation later
```

The parser rejects repetitions, any undeclared method, use with an explicitly non-Windows profile, and propagation into the protected lifecycle child. The application independently rejects the option before its adapter when Windows is not selected.

The transaction first records the approved opaque subject with unknown availability in the working setup-authority generation, publishes and re-observes the exact immutable non-secret record, marks availability only after that proof, validates, and commits. A restart can recover the exact `configure-later` intent from the component-owned operation identity without asking again. Another component's interrupted setup-authority transaction is never consumed.

With no accepted policy, Windows media discovery and image construction can still advance, as can independent Linux construction. Once every selected image is complete, the policy gate stops before conflict retirement, declaration publication, protected lifecycle reconciliation, environment activation, or operational enablement. An explicit accepted `configure-later` policy allows those later setup stages while continuing to report that Windows activation is required.

Public setup state and handoff include only selection state, readiness, changed state, `configure-later`, the activation-required fact, and a bounded blocker. The opaque subject, stored record, injected extra fields, and secret-shaped material are not projected.

No retail, MAK, KMS, Active Directory-based, subscription, host-entitlement, product-key, vault, guest-command, provider, VM, or elevation behavior was implemented. No legacy or fallback activation path exists.

## Verification evidence

- focused setup/policy/CLI/LEGO suite: 74 passed, 0 failed;
- repository preflight: 121 syntax files, 2 JSON files, and 113 targeted test files passed;
- complete repository suite: 1,626 total, 1,611 passed, 15 expected platform skips, 0 failed;
- `git diff --check`: passed;
- no installed setup, UAC request, provider mutation, VM operation, guest command, media approval, or activation attempt occurred.

The tests cover strict non-secret policy schema, deterministic identity, immutable persistence, restart/no-op behavior, interruption recovery, foreign-transaction refusal, missing/substituted record failure, protected-child denial, selected-profile enforcement, independent Linux progress, exact Windows gate placement, rejection of widened status, bounded public projection, and handoff guidance.

## Remaining issue scope

Issue #199 remains open. The other declared activation methods need separate complete authority, secret lifecycle where applicable, protected guest operation, status/evidence, rebuild invalidation, and uninstall behavior. Real guest activation and licensing qualification are also pending. This checkpoint supplies the explicit safe deferral path and prevents silent policy inference; it does not claim Windows itself is activated.
