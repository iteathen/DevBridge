# DB-HO114 — issue #372 Windows protected network capability

Date: 2026-09-01

Status: locally qualified implementation candidate; hosted and physical acceptance pending

Coordinates with: #360, #362, #372, #430, DB-003, DB-009, DB-011, DB-019, DB-020, DB-HO110, DB-HO111, and DB-HO113.

## Physical evidence

Exact Stage 8 head `aa531b7dc7bc20ea995e1cb8edcd78f93b312f4d` passed all four pull-request jobs in run `33551382463` and all four post-integration jobs in run `33551771217`. The zero-state install-only transaction selected that exact component and runner in the canonical `C:\Users\josho\.devbridge` installation.

The first ordinary setup re-entry requested UAC at elapsed setup time zero and completed the older interrupted recovery-health transaction in 33 seconds. The required clean-invocation fence stopped there. A second clean ordinary setup again requested UAC at elapsed zero, completed the protected candidate transaction in 144 seconds, and completed ordinary post-apply verification at 177 seconds. The exact service generation `bf3d4bda3edbce3ed3c5ea51f3fa5a6ad0033af6bb9f34102143aba13eee6485` is running automatically as `DevBridgeLifecycle-679c2503003e57fbacccc9a2428da304` with all five expected endpoints.

Ordinary protected-profile reconciliation then failed closed. The configuration endpoint is ready and responds stably, but the exact reconcile operation fails internally in about 173 ms. The activity endpoint truthfully remains unavailable because no declaration has been admitted.

The Windows PowerShell operational log identifies the missing capability without changing the host. Event 4100 runs the existing provider-owned network inspection under exact virtual service identity `NT SERVICE\DevBridgeLifecycle-679c2503003e57fbacccc9a2428da304`, SID `S-1-5-80-1057691056-879223564-2181943567-3098841851-3291569802`. The script reaches `Get-NetNat` and Windows returns `System error.` The same service SID is already an exact member of Hyper-V Administrators and has the intended protected-state/image-catalog ACLs. The host has no NAT and has two inactive DevBridge-looking internal switches, so exact consented conflict retirement and current network creation cannot begin until the service can observe Windows network configuration.

No manual group edit, ACL change, service change, switch/NAT deletion, setup retry, VM construction, or guest/GPU action followed this diagnosis. The existing ambiguous August 27 input-only elevation-channel directory remains preserved for its owning cleanup contract.

## Least-authority decision

Microsoft defines Network Configuration Operators as the built-in group whose members can manage networking features without membership in Administrators. Its fixed well-known SID is `S-1-5-32-556`. DevBridge already uses the same narrow pattern for Hyper-V Administrators (`S-1-5-32-578`). The virtual service account therefore receives the two distinct fixed capabilities it needs; it does not become LocalSystem or a member of Administrators.

This is a physical acceptance candidate, not a claim that group membership alone proves every required `NetNat` operation. If exact post-refresh reconciliation still fails, stop at that evidence and reassess. Do not widen authority speculatively.

## Nested design

1. **LEGO:** the immutable Windows lifecycle plan owns capability selection; the service reconciler owns admission; the protection verifier owns read-only proof; the Hyper-V environment owner continues to own switch, address, and NAT behavior.
2. **SOLID:** add only the separate Network Configuration Operators capability. No networking cmdlet, provider topology, or profile policy moves into service installation.
3. **CUPID:** capability admission is one deterministic idempotent operation over exactly the two plan-owned well-known SIDs. It re-observes each postcondition and fails closed on absent or non-exact service membership.
4. **KISS:** preserve the virtual account, existing service, five bounded pipes and DACLs, transaction journal, immediate UAC path, and ordinary configuration channel. Add no second helper, direct elevated fallback, caller-selected group, or compatibility route.

## Candidate contract

- `createWindowsLifecycleAuthorityPlan` publishes explicit immutable `hyperVGroupSid` and `networkConfigurationGroupSid` fields.
- Elevated service configuration supplies only those two internal fields to one bounded capability-admission script.
- The script translates the exact virtual service account once, admits only missing membership, and then requires exactly one matching service SID in each group.
- Structural protection verification accepts only the two fixed well-known SIDs and independently requires exact membership in both groups.
- Ordinary negative filesystem and mutation-pipe proofs remain unchanged.

## Qualification and physical acceptance

Final-byte local qualification uses the supported minimum Node 22.16.0 runtime and passes:

- focused plan/service/protection/proof tests: 44/44;
- setup architecture, product identity, standalone packaging/launch, and LEGO boundary tests: 19/19;
- repository preflight: two standalone artifacts, 255 syntax files, two JSON files, and 205 dependency-selected test files;
- read-only doctor: `ok: true`, GitHub authentication and the native C/CMake/CTest toolchain available, with repository execution correctly unavailable until setup publishes a persistent-environment route; and
- complete serialized suite: 2,110 total, 2,089 passed, 21 expected platform skips, zero failures, in 85.4 seconds.

The final review also closes substituted-plan authority at the effect boundary: the exported refresh mechanics validate the two exact fixed SIDs before the first service mutation. The focused contract proves this ordering, the admission script re-observes each membership, and the independent structural proof still validates both memberships after service start.

Before any further host mutation, require focused tests, supported-minimum Node 22.16 preflight, architecture/product/standalone gates, read-only doctor, the complete serialized suite, artifact/diff hygiene, all four exact-head pull-request jobs, merge into Stage 8, and all four fresh post-integration jobs.

Then install only the exact accepted Stage 8 head. One fresh ordinary setup invocation may request its single UAC child at elapsed setup time zero. Accept it and prove:

- the exact service SID appears once in both fixed groups;
- candidate service protection and endpoint health pass;
- ordinary configuration reconciliation can inspect and reconcile the exact consented network conflict;
- the accepted declaration is admitted and re-read by digest;
- no manual service, ACL, group, switch, NAT, image, VM, guest, PATH, or installation-state mutation is used.

This checkpoint alone does not claim a healthy environment route, GitHub task execution, Hello World compilation/testing, restart recovery, Windows guest acceptance, or GPU/CUDA readiness.
