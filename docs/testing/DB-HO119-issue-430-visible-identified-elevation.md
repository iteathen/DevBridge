# DB-HO119 — issue #430 visible, identified Windows elevation

Date: 2026-09-01

Status: implementation locally qualified; hosted and physical acceptance pending

Coordinates with: #103, #116, #360, #372, #429, #430, DB-003, DB-007, DB-009, DB-019, DB-020, DB-HO110, DB-HO111, DB-HO113, and DB-HO118.

## Scope

This record owns only the ordinary Windows process that requests the existing single protected-setup elevation, the identity Windows presents for that request, and the immediately preceding bounded purpose text. It does not change the protected transaction, lifecycle service, service or pipe ACLs, UAC policy, provider authority, image construction, repository execution, or the one-prompt rule.

Issue #430 already owns the elevation entry point and prompt timing. No new overlapping issue is required.

## Physical evidence

The canonical installation and exact runner were both at accepted Stage 8 head `ee87c7fb7f6ff9f3472c32b4676f234886214744`. The revision-5 protected-apply frontier was `prepared`; doctor was `ok: true`, lifecycle authority was ready, no transition was active, and the selected environment had no provider materialization.

One newly authorized ordinary re-entry emitted `elevation-consent: requested` at setup elapsed zero, then one `protected-transaction` heartbeat every 15 seconds. Three ordinary-desktop UI inventories exposed no consent window. The operator directly confirmed that no UAC screen appeared. At 122 seconds Windows returned cancellation/refusal; setup exited 3, attempted no second elevation, and left the prepared frontier and absent materialization unchanged. A cleanup check found no new `db-*` or `devbridge-*` temporary root.

Read-only host policy and session evidence was:

- `EnableLUA=1`;
- `PromptOnSecureDesktop=1`;
- `ConsentPromptBehaviorAdmin=5`;
- the caller is a member of Administrators; and
- the caller and Explorer are both in interactive session 1.

The operator observes UAC correctly in other workstation situations. The defect is therefore contextual to the DevBridge launch path, not a globally disabled UAC configuration or an obvious cross-session invocation.

Source inspection found that the elevation adapter composes its outer PowerShell request through the generic command invoker, whose Windows spawn policy is always `windowsHide: true`. The elevated target is `powershell.exe`, so even a surfaced prompt identifies Windows PowerShell rather than DevBridge or the protected operation.

## Primary-source research

Microsoft documents that:

- `ShellExecute`/the `runas` verb is the supported prompt boundary for a separate least-privilege helper;
- UAC normally switches to an isolated secure desktop that ordinary user processes cannot inspect or automate;
- a UAC-compliant administrative executable carries an explicit execution-level manifest;
- a separately elevated helper should contain only the operation that requires administrator authority;
- the UAC dialog is not a substitute for an application confirmation or explanation, so purpose text belongs immediately before the elevation UI; and
- signed setup executables produce a more specific/trustworthy elevation UI, but DevBridge currently has no Authenticode release-signing authority and must not invent one.

References:

- https://learn.microsoft.com/en-us/windows/security/application-security/application-control/user-account-control/how-it-works
- https://learn.microsoft.com/en-us/windows/win32/api/shellapi/ns-shellapi-shellexecuteinfoa
- https://learn.microsoft.com/en-us/windows/win32/secbp/running-with-administrator-privileges
- https://learn.microsoft.com/en-us/windows/win32/sbscs/application-manifests
- https://learn.microsoft.com/en-us/windows/win32/uxguide/winenv-uac
- https://learn.microsoft.com/en-us/windows/win32/uxguide/mess-confirm
- https://nodejs.org/api/child_process.html

## Reassessment

Merely changing the generic broker from hidden to visible is incomplete. It may improve surfacing, but it still asks the operator to authorize `powershell.exe` and cannot make the UAC screen identify DevBridge or the bounded purpose.

The smallest complete design is one Windows-specific elevation-launcher LEGO:

1. Ordinary preparation builds and verifies one small DevBridge-owned executable from exact accepted source before the durable protected-apply checkpoint. Re-entry never compiles, downloads, discovers, or constructs before UAC.
2. The executable has an explicit `asInvoker`, `uiAccess=false` manifest and bounded version identity whose displayed application name is `DevBridge Protected Setup - reconcile lifecycle service and protected environment`. Its fallback filename `DevBridge-Protected-Setup-Lifecycle-Environment.exe` still identifies the requester and protected purpose rather than collapsing to a generic shell or opaque helper name.
3. The ordinary CLI emits one bounded purpose immediately before the Windows handoff: DevBridge needs administrator permission to reconcile the DevBridge-owned lifecycle service and protected environment configuration.
4. Only the elevation-launcher adapter opts out of the generic hidden-window policy. Every ordinary command remains hidden by default.
5. The ordinary launcher requests `runas` with a normal show state and waits for exactly one elevated instance. Cancellation remains a clean durable boundary; it never prompts twice.
6. The elevated instance replaces the current elevated PowerShell broker. It accepts no caller-selected executable or arguments. It revalidates the exact managed home, UUID channel, fixed Node executable identity, detached exact runner head, fixed `src/cli.js`, and bound hashes prepared by the ordinary owner, then runs only `setup --lifecycle-authority-child --no-update`.
7. The existing bounded result protocol, child output limits, exact head binding, terminal-receipt handling, and post-child ordinary verification remain unchanged.
8. The helper is content-addressed and setup-owned. A current exact artifact is reused; stale exact owned generations are removed only after the current generation verifies and no setup activity can own them.

This remains one privileged helper and one protected transaction. It replaces the elevated PowerShell broker rather than nesting another elevated process around it.

## Design hierarchy

- **LEGO:** the generic process mechanic remains hidden by default; the Windows elevation launcher is one replaceable platform adapter; the lifecycle child and protected reconciliation remain separate existing bricks.
- **SOLID:** launcher preparation owns exact local artifact materialization, the launcher owns Windows UI/elevation mechanics, and the lifecycle child owns protected reconciliation. None acquires another owner's provider, service, or configuration semantics.
- **CUPID:** one predictable operator message, one identified Windows prompt, one fixed child command, one bounded receipt, and durable cancellation/re-entry.
- **KISS:** no second prompt, generic administrator shell, reusable token, UIAccess bypass, UAC-policy change, service/ACL change, manual host repair, or custom secure-desktop automation.

## Dependency-ordered implementation plan

1. Add a Windows elevation-launcher source template and a neutral preparer/resolver that binds exact source, runner, Node, home, manifest, purpose, and artifact digests.
2. Make ordinary setup prepare the current launcher before writing the protected-apply frontier. A missing or stale launcher on re-entry stops before announcing or requesting consent.
3. Add a closed visibility option to the generic command-invoker factory; preserve hidden as the default and select visible only in the elevation adapter.
4. Replace the encoded elevated PowerShell broker with the identified launcher while retaining the existing result-channel and lifecycle-child protocols.
5. Change progress wording from an unprovable claim about a visible screen to exact request/purpose semantics. A request event proves only that DevBridge invoked Windows; completion proves the approved child returned.
6. Test compile/version/manifest identity, exact reuse, tamper/stale rejection, path and reparse escape, fixed child argv, bounded output, cancellation, timeout preservation, single request, hidden-default preservation, no work between explicit consent entry and `runas`, and cleanup ownership.
7. Run focused tests, the bounded repository preflight, architecture/product boundaries, doctor, the serialized full suite, artifact freshness, diff hygiene, and disposable-root cleanup.
8. Publish one narrow PR against Stage 8, require all four hosted Ubuntu/Windows smoke/full jobs, merge only the accepted exact head, and require the same four jobs on the exact post-integration head.
9. Install only the accepted exact Stage 8 head. Then obtain fresh authorization for one ordinary re-entry while the operator is present. Physical acceptance requires the operator to see the single prompt, verify the displayed DevBridge lifecycle-purpose identity, approve it, and observe exact protected completion.

## Signing boundary

The first implementation can provide a truthful DevBridge file description and purpose identity, but without an existing Authenticode release-signing authority Windows will truthfully report an unverified/unknown publisher. The repair must not create or trust a local signing certificate, weaken UAC policy, or claim a verified publisher. A later signed distribution may bind the same helper bytes to an established release-signing process without changing this launcher contract.

## Local implementation evidence

The final implementation keeps generic command children hidden by default and selects visible process composition only for the outer elevation adapter. Ordinary setup compiles and verifies the exact content-addressed launcher before committing the durable `prepared` frontier; re-entry accepts only that exact launcher/Node/runner/home binding and performs no compilation before `RunAs`. The helper exposes no arbitrary executable or argument surface, rejects widened input, revalidates every elevated path component against filesystem indirection, checks exact hashes/head/channel, and creates a result only after the complete managed binding validates. Its manifest is `asInvoker`, `uiAccess=false`; its displayed description and fallback filename identify both DevBridge and the lifecycle-service/protected-environment purpose.

On Node.js 24.15.0, focused command/setup/elevation evidence passes 85/85. Repository preflight passes two standalone artifacts, 256 syntax files, two JSON files, and 206 dependency-selected test files. Architecture/product/standalone LEGO gates pass 23/23. The complete serialized suite passes 2,126 total / 2,105 passed / 21 expected platform skips / zero failures / zero cancellations in 329.4 seconds. Doctor is `ok: true`, GitHub and native C/CMake/CTest are available, and repository execution remains truthfully unavailable because the persistent environment is absent. Standalone regeneration and diff hygiene pass.

No UAC, service, provider, VM, guest, construction, repository-task, or canonical-install mutation occurred. Cleanup removed 120 qualification-created `db-*`/`devbridge-*` roots from the Windows temporary directory and verified none remained. The pre-existing canonical `.lifecycle-authority-elevation-*` directory is preserved as ambiguous recovery evidence from the failed physical transaction.

The first pull-request run `33578473128` passed Ubuntu smoke/full and Windows smoke, but Windows full failed the new helper identity check: the compiled as-invoker executable exited 2 only on the hosted Windows image. This belongs to DB-HO119, so the candidate was not merged. The identity path unnecessarily used the general JSON runtime even though its value is fixed. The focused correction writes exact static UTF-8 identity bytes, reports only a bounded exception class on rejected input, and directly runs the helper as an ordinary process with a valid bound input to prove complete parsing ends at `UnauthorizedAccessException` without creating a result or requesting elevation. Post-correction focused evidence remains 85/85 and preflight remains green at the same 2 / 256 / 2 / 206 inventory. A fresh exact-head hosted matrix is required.

The second complete pull-request run `33578975609` again passed Ubuntu smoke/full and Windows smoke. Windows full accepted the fixed identity path, then the new direct ordinary-process proof failed before the administrator check with `TypeInitializationException`. The candidate remains unmerged. The launcher had no reason to retain process-wide initialized regular-expression and field-set objects, so the next narrow correction replaces them with constants and local pure validation functions. Rejected input now reports a bounded chain of exception type names, never paths or input values, so any remaining hosted runtime incompatibility is classifiable without weakening the helper contract. The corrected focused boundary passes 85/85, standalone artifact verification is exact, preflight passes 2 / 256 / 2 / 206, and cleanup removed all 29 newly created temporary roots. Require another fresh complete matrix; no UAC or protected host effect occurred.

The third complete pull-request run `33579543488` passed both Ubuntu jobs and Windows smoke. Windows full then supplied the exact nested classification `TypeInitializationException > ConfigurationErrorsException > PathTooLongException` while the helper initialized `System.Web` JSON serialization beside its long, purpose-identifying content-addressed executable. The first correction removed that ambient serializer dependency: the helper uses `DataContractJsonSerializer` with only explicit framework references, retains exact eight-field input shape and bounded result validation, and adds a source gate forbidding the old dependency. The direct ordinary-process proof and focused boundary pass 86/86; standalone verification is exact; preflight passes 2 / 256 / 2 / 206; and cleanup removed all 29 new temporary roots with zero remaining. No UAC or protected host effect occurred.

The fourth complete run `33580106665` passed both Ubuntu jobs and Windows smoke, but Windows full returned the same nested configuration-path exception after `System.Web` was absent. This proves the legacy .NET configuration system itself probes beside the executable and the hosted test path crosses `MAX_PATH`; it is not owned by one JSON serializer. Preserve the full UAC-visible file description and content-addressed bundle, shorten only the fallback file to `DevBridge-Protected-Setup-Lifecycle-Environment.exe`, and fail before compilation if the adjacent `.config` probe would reach 260 characters. The fallback remains specific about DevBridge, protected setup, lifecycle, and environment while saving 22 path characters. Focused evidence passes 87/87, including explicit over-budget rejection before compilation; standalone verification is exact; preflight passes 2 / 256 / 2 / 206; and cleanup again leaves zero new temporary roots. Require another fresh complete matrix; the candidate remains unmerged and no host effect occurred.

## Stop conditions

Stop rather than broaden scope if the correction requires a second privileged helper, a generic elevated shell, caller-selected executable/argv/path authority, reusable administrator token, UIAccess, secure-desktop automation, UAC-policy changes, service/ACL changes, provider mutation, repository-code host execution, deletion of ambiguous elevation evidence, or an invented signing trust root.
