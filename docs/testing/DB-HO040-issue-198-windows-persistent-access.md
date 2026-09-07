# DB-HO040 — issue #198 Windows persistent-environment access

Status: implementation plan. This record does not claim that a Windows image or persistent Windows environment has been physically qualified.

## Assessment

The Windows production-image path installs two fixed guest services, including `DevBridgeAccessSeed`, and the guest access agent creates or rotates a fixed `devbridge` account, adds only standard and remote-management membership, removes Administrators membership, persists digest-only evidence, and deletes the transient seed. The host already has exact-owned Hyper-V file delivery, a PowerShell Direct operation adapter, encrypted local credential material, and a Windows bridge attachment.

Those pieces are not connected for a persistent environment. `createEnvironmentConstructionPreparation` accepts an injected `windowsAccess` function, but the protected Windows lifecycle/activity worker supplies none. Consequently a Windows declaration could be accepted and materialized yet fail at enrollment before bootstrap and bridge readiness. Construction-time `Administrator` material is also bound to image construction subjects and must not become the routine repository identity.

This is the next primitive before multi-profile setup or physical Windows activation. Guided setup cannot truthfully advertise a Windows environment until the protected runtime can establish and re-observe a fresh, non-administrative credential for the exact materialized environment.

## Primary-source research

Microsoft's current [PowerShell Direct documentation](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/powershell-direct) states that the VM must run locally, be running with a configured user profile, the host caller must have Hyper-V administrator authority, and the caller must provide valid guest credentials. It does not require that guest credential to be a member of the guest Administrators group. PowerShell Direct is independent of guest networking.

The current [`New-PSSession` documentation](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/new-pssession?view=powershell-7.6) exposes the `-VMName -Credential` parameter set and identifies it as a PowerShell Direct session. The host provider authority and guest login identity are therefore separate contracts.

Microsoft's [JEA over PowerShell Direct guidance](https://learn.microsoft.com/en-us/powershell/scripting/security/remoting/jea/using-jea?view=powershell-7.5) further confirms that PowerShell Direct can connect to a constrained guest endpoint using explicit guest credentials. DevBridge does not need JEA for the first bridge because its checked-in bridge agent is already the bounded operation surface, but this evidence rejects an assumed guest-Administrator transport requirement.

## Reassessment

Routine repository execution must not retain or use the construction-only Administrator credential. The supported bootstrap is:

1. the protected host authority creates one high-entropy credential for the exact persistent-environment identity and stores only a current-user-protected blob plus integrity evidence under protected authority state;
2. exact-owned Hyper-V Guest Service Interface delivery places one bounded seed at the fixed guest inbox without requiring a guest login;
3. the LocalSystem guest service applies the fixed seed, creates/rotates only the `devbridge` account, verifies standard/remote-management access and explicit non-membership in Administrators, persists digest evidence, and deletes the seed;
4. the protected host probes PowerShell Direct with that non-admin credential and verifies the exact account and installed bridge payload;
5. all subsequent bootstrap and repository bridge work resolves the same protected credential through the existing neutral connection contract.

The host provider authority remains inside the protected service. The credential never enters setup status, normal config, controller plans, repository workspaces, Git, task output, or command-line arguments. Guest UAC is not a workflow state: enrollment runs in the existing LocalSystem seed service, and routine work runs noninteractively as the non-admin account.

## Scoped plan

1. Generalize the Windows protected-access material's local contract from one construction identity/user to an exact bounded identity plus constructor-fixed local user. Preserve user-scoped protection, exclusive persistence, and integrity re-observation; do not add a compatibility alias.
2. Add a Windows-owned transient seed-file adapter that writes one exclusive bounded real file under protected state and provides exact cleanup.
3. Add a Windows access-preparation application service parallel to the Linux preparation stud. It verifies the supplied connection, avoids reseeding when strict access already works, delivers only the fixed seed destination, polls boundedly, and always removes the host transient.
4. Add a thin Hyper-V Windows access probe using the existing fixed-operation adapter and exact environment location proof. It must verify the fixed account, non-elevated token, account SID, and bridge payload presence.
5. Compose the adapter by default only for the Windows/Windows family branch of local environment access. Keep generic lifecycle, construction, routing, bridge, and controller code unchanged.
6. Test normal, already-ready, delivery failure, timeout, changed connection, substituted protected record, non-Windows, secret non-exposure, fixed destination, exact-owned location, and LEGO boundary behavior. Run preflight and the complete suite before committing.

Physical completion remains subsequent evidence: approved Microsoft media, image construction/Sysprep, persistent environment creation, fixed C execution, and restart repetition.

## Implementation checkpoint — 2026-08-28

The persistent-access prerequisite is now connected through isolated ownership boundaries:

- protected access material accepts only exact construction-subject or persistent-environment identities and binds each instance to one constructor-fixed local user; the production-image path explicitly retains its temporary `Administrator` identity, while persistent environments use only `devbridge`;
- a separate seed-material adapter creates one exclusive bounded `devbridge/windows-access-seed-v1` file and removes it only after re-observing the exact unchanged content;
- the access-preparation service consumes only neutral material, seed, delivery, and probe ports, rejects connection drift, uses the fixed guest inbox, settles boundedly, and cleans host seed material on every post-creation path;
- the Hyper-V probe reuses the exact-owned location and fixed-operation adapters, authenticates through PowerShell Direct, and requires the exact local account SID, Users and Remote Management Users membership, absence of Administrators membership/elevation, the installed bridge payload, and the system Node runtime;
- the Windows composition root alone selects the protected material, seed, Hyper-V delivery, and probe adapters. Generic environment construction, operator, and protected-activity code no longer carries the unused `windowsAccess` compatibility injection.

Verification at this checkpoint:

- 19 focused Windows-access tests pass, including real current-user DPAPI protect/unprotect and Windows PowerShell 5.1 parsing of the fixed guest operation;
- repository preflight passes with 99 syntax files, 2 JSON files, and 95 targeted tests;
- the first complete-suite run passed 1,512 tests and skipped 15, but one unrelated deterministic-liveness child exited with code 1 under concurrent suite load; that exact test passed immediately in isolation;
- a clean complete-suite repeat passed: 1,529 total, 1,514 passed, 15 platform skips, and zero failures.

This checkpoint proves the composition and host-side boundaries, not physical guest access. The next evidence remains an exact persistent-environment run, followed by the fixed dual-guest C acceptance and restart repetition.
