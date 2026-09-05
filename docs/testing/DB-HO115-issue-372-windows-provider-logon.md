# DB-HO115 — issue #372 Windows provider logon identity

Date: 2026-09-01

Status: hosted implementation accepted; provider-logon transition physically persisted; final setup acceptance blocked by the separately reproduced DB-HO116 protected-pipe re-arm defect

Coordinates with: #360, #362, #372, #430, DB-003, DB-008, DB-009, DB-011, DB-019, DB-020, DB-HO110, DB-HO111, DB-HO113, and DB-HO114.

## Rejected hypothesis and physical evidence

DB-HO114 deliberately tested the narrowest standard Windows group design first. Exact Stage 8 head `737890fdd73e5594fce90fc73bbe906a9fd8aef1` passed all four pull-request jobs in run `33555094013` and all four fresh post-integration jobs in run `33555496365`. One ordinary setup requested its single UAC child at elapsed setup time zero, completed the protected child in 128 seconds, and completed ordinary verification in 152 seconds.

The new service generation `83e931ffb86024ef868caff3fac67cd28d0cf144d5b9b78e2a82d434ece9c4cf` ran automatically. The exact service SID appeared once in Hyper-V Administrators (`S-1-5-32-578`) and once in Network Configuration Operators (`S-1-5-32-556`). Nevertheless, the PowerShell operational log again recorded `Get-NetNat` returning `System error.` under that exact virtual service identity. The same ordinary operator token could enumerate `Get-NetNat` while enabled in Hyper-V Administrators and absent from Network Configuration Operators. Group admission did not supply the provider execution context required by this host.

No retry, manual group removal, service/account edit, ACL edit, WMI namespace edit, provider/log mutation, network mutation, construction, VM, guest, or GPU effect followed. The result was recorded on issue #372 before replacement work began.

## Windows contract and explicit security decision

Microsoft documents that `SERVICE_SID_TYPE_UNRESTRICTED` adds the service SID to the service process token. That permits the unique `NT SERVICE\DevBridgeLifecycle-…` identity to remain the principal on protected files and named pipes independently of the SCM logon account. Microsoft also documents that LocalSystem has extensive local privileges, includes SYSTEM and Administrators identities in its token, acts as the computer on the network, and can damage the whole system if compromised. This design accepts that privilege expansion only for the existing measured lifecycle authority because the required local provider rejects both tested narrower identities.

The service is not a generic command broker. Its executable, Node runtime, worker package, command line, description, service name, five pipe endpoints, pipe clients, protected filesystem tree, operator SID, accepted configuration subject, and provider effects remain exact and content-addressed. UAC remains confined to installation/refresh. Ordinary work reaches only the existing bounded protocols. The unique service SID remains the ACL identity even though SCM starts the process as LocalSystem.

Official references:

- Microsoft `SERVICE_SID_INFO`: https://learn.microsoft.com/en-us/windows/win32/api/winsvc/ns-winsvc-service_sid_info
- Microsoft LocalSystem account: https://learn.microsoft.com/en-us/windows/win32/services/localsystem-account
- Microsoft guidance requiring justification for LocalSystem: https://learn.microsoft.com/en-us/windows/win32/ad/the-localsystem-account

## Nested design

1. **LEGO:** the immutable lifecycle plan owns two distinct identities: one service SID for object access and one fixed SCM provider logon. The service reconciler owns account configuration and obsolete-membership retirement. Independent proofs own SCM identity and protected-object structure. The environment configuration owner continues to own all switch, address, NAT, and consent semantics.
2. **SOLID:** account selection does not move network implementation into service installation, and ACL identity does not become SCM identity. Legacy runtime migration consumes the same plan field instead of inventing a second account rule.
3. **CUPID:** the plan is explicit, predictable, and domain-based. One fixed `LocalSystem` value replaces the physically rejected virtual-provider context. One fixed two-SID retirement list removes only authority DevBridge previously added and immediately proves absence.
4. **KISS:** retain one measured service and the existing five closed pipes. Add no second broker, delayed UAC, interactive administrator route, caller-selected account/group, WMI ACL edit, direct elevated network fallback, or persistent compatibility branch.

## Candidate contract

- `service.account` remains the unique `NT SERVICE\<exact-name>` ACL identity.
- `service.logonAccount` is the explicit fixed `LocalSystem` SCM execution identity.
- `service.retiredCapabilityGroupSids` contains exactly the former Hyper-V Administrators and Network Configuration Operators SIDs in fixed order.
- Service creation, refresh, exact-match inspection, service proof, and legacy migration all compare/configure SCM against `logonAccount`, never against the ACL identity.
- The refresh transaction admits the retired virtual logon only when service name, exact generation command, and exact runtime description already match an owned generation. That one-way admission may quiesce and reconfigure the service; readiness, start, health, and final proofs accept only LocalSystem.
- The elevated refresh, while the owned service is quiesced, removes the exact service SID from either former capability group if present and post-verifies zero matches. It cannot admit a caller-selected group.
- Filesystem and named-pipe ACLs continue to name only the unique service SID plus their existing SYSTEM/Administrators/operator principals.
- Structural protection independently proves exact ACLs and absence from both retired groups. Service proof independently proves Running, Auto, exact command, exact description, and LocalSystem logon.

## Local qualification checkpoint

The final-byte candidate passes the supported minimum Node 22.16.0 gates:

- focused Windows lifecycle plan, service, service proof, protection, one-command, and refresh tests: 90/90;
- repository preflight: two standalone artifacts, 255 syntax files, two JSON files, and 205 dependency-selected test files;
- repository-execution architecture, product identity, standalone launcher, and setup architecture: 40 passed and one expected Windows symlink-capability skip;
- read-only doctor: `ok: true`, GitHub CLI authentication and native C/CMake/CTest toolchain available, with repository execution truthfully unavailable until a persistent-environment route is published;
- complete serialized suite: 2,111 total, 2,090 passed, 21 expected platform skips, zero failures, in 335.3 seconds; and
- standalone artifact freshness, stale-field scan, `git diff --check`, and disposable-runtime cleanup: passed.

The qualification runtime was downloaded from the official Node distribution, checked against the official SHA-256 list, used only below LocalAppData Temp, and deleted with absence verified. No canonical installation, service, group, ACL, WMI, provider, network, image, VM, guest, repository-execution, or GPU effect occurred.

## Acceptance gates

The final candidate requires focused tests, exact supported-minimum Node 22.16 preflight, architecture/product/standalone/LEGO gates, read-only doctor, the complete serialized suite, artifact/diff hygiene, all four exact-head pull-request jobs, merge into Stage 8, and all four fresh post-integration jobs.

Only then install the exact accepted Stage 8 head. One fresh ordinary setup may request its single immediate UAC child. Physical acceptance must prove:

- SCM reports exact `LocalSystem` logon, Running state, Automatic start, exact generation command, and exact runtime description;
- the unique service SID remains present on every required protected-file and pipe boundary;
- that SID appears zero times in both retired groups;
- ordinary configuration reconciliation successfully observes and applies only the exact accepted provider plan;
- the environment route becomes healthy without a manual service, group, ACL, WMI, provider, switch, NAT, image, VM, guest, PATH, or installation-state workaround.

If the provider still fails under this exact context, stop at the new evidence. Do not introduce another authority or manual correction. GitHub task receipt, Hello World compilation/testing, restart recovery, guest acceptance, and GPU/CUDA remain downstream gates.

## Post-integration physical result

PR #437 merged as exact Stage 8 head `7c4edd4a044cefccb455fe5141083f6e387077bc`; pull-request run `33558729096` and fresh post-integration run `33559135053` passed all four jobs. Exact install-only succeeded. One ordinary setup requested UAC at elapsed zero, the operator accepted the single child, and the protected transaction completed at 190 seconds.

The new LocalSystem candidate was rejected because configuration health was transport-unavailable, and exact previous generation `83e931ffb86024ef868caff3fac67cd28d0cf144d5b9b78e2a82d434ece9c4cf` was restored. The account transition persisted: the restored service is Running/Automatic under `LocalSystem`. Read-only endpoint evidence then showed intermittent false unavailability across otherwise healthy listeners. DB-HO116 reproduces that independent named-pipe re-arm defect in the disposable compiled-host integration harness and owns the correction. Do not reinterpret this result as a provider-logon rejection or retry setup from DB-HO115 bytes.
