# DB-HO088 — goal reconciliation and operational frontier

Date: 2026-08-30

Status: repository, installed runtime, protected-service generation, and no-elevation frontier reconciled; the next product effect is physically gated and no substitute implementation is authorized

## Scope

This checkpoint restarts the durable goal of delivering a correctly working DevBridge. It catches up the exact repository and installation state, rechecks the governing VM boundary and current Microsoft platform behavior, and selects the next work in primitive-to-high-level dependency order.

It authorizes only read-only observation, documentation, ordinary Git publication, and cleanup of exact completed development artifacts. It does not authorize setup, UAC, protected service/provider mutation, VM or guest mutation, repository-controlled execution, Windows media acceptance, GPU/CUDA work, or a coding-model invocation.

## Repository assessment

The active development worktree is clean on `stage8/362-protected-activity-channel` at exact head `9781ac5a7997834cfe7818e8b58bd972d50a193b`, equal to its remote tracking ref. Draft PR [#368](https://github.com/iteathen/DevBridge/pull/368) targets `cuda-target`, reports a clean merge state, and passed all four Windows/Ubuntu smoke and full-test jobs in [GitHub Actions run 33298737554](https://github.com/iteathen/DevBridge/actions/runs/33298737554).

The current remote integration identities are:

- `main`: `ae8fd88e125252a446e912eb17d337c4a1cf4931`;
- `cuda-target`: `3deb41c61482d76bd0af3a789ccbfbcd229265ce`;
- Stage 8 recovery line: `9781ac5a7997834cfe7818e8b58bd972d50a193b`.

The recovery line contains the deliberate current-main contract integration and remains the truthful owner of the Stage 8 continuation. A blind merge or rebase is not justified by the differing commit topology. The original retired fast-track worktree remains intentionally untouched because it contains operator-owned configuration changes. The clean DB-HO005 handoff worktree was already contained in Stage 8, its remote branch was gone, and its exact local worktree/branch metadata was removed while preserving the committed evidence.

## Installed-state assessment

The canonical user installation remains manifest-owned under `C:\Users\josho\.devbridge`. Wrapper-owned `devbridge/entry-install-status-v1` observation binds component head, selected runner, and pinned runner to exact accepted plan commit `8cf98654170a7265052481436ecd8e5607cf1c4b`.

Installed read-only doctor exits zero with `ok: true`, observes the approved `iteathen/DevBridge` queue, GitHub CLI authentication, and host-static/control tool availability, while correctly reporting:

- repository execution unavailable because no local persistent-environment route is configured;
- every repository-code operation unusable;
- coding-model adapters disabled;
- lifecycle state `setup-reentry-required`;
- zero declarations and zero environments; and
- no direct-host fallback.

The protected Windows service `DevBridgeLifecycle-679c2503003e57fbacccc9a2428da304` is running with automatic start. Its exact command line names separate read, mutation, acceptance, and activity pipes, but no configuration pipe. The installed service generation is therefore observably older than the accepted distinct configuration-channel implementation. No setup invocation or failed mutation is needed to establish this fact.

## Primary-source research recheck

Microsoft's service security contract states that `SERVICE_CHANGE_CONFIG` controls the executable the service runs and should be granted only to administrators. Expanding ordinary-user service reconfiguration authority would therefore weaken the host security boundary rather than remove a nuisance prompt:

- <https://learn.microsoft.com/en-us/windows/win32/services/service-security-and-access-rights>

Microsoft's named-pipe security contract applies a security descriptor to both ends and checks a connecting client's token against the pipe DACL. The default descriptor is not a sufficient least-authority boundary, which supports the implemented distinct, explicitly ACL-bound configuration capability:

- <https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights>

Microsoft documents PowerShell Direct as a host-initiated Windows-guest management transport that requires a local running VM, Hyper-V administrator authority on the host, and valid guest credentials. It does not provide a `RunAsAdministrator` switch inside the guest. DevBridge must therefore prepare and qualify the Windows image noninteractively rather than depend on guest UAC prompts during routine runs:

- <https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/powershell-direct>

Official Windows ISO media remains an independently accepted supply-chain/licensing input. No bounded approved Windows ISO is currently present in the discovered local inventory:

- <https://www.microsoft.com/en-us/software-download/windows11>

## Reassessment

The software primitive required to avoid repeated UAC is already implemented and hosted-qualified: a current protected service accepts a bounded configuration subject over its separate ACL-bound endpoint. This workstation's running service predates that endpoint. Exactly one administrator-authorized refresh is consequently required to install the current service generation. After that refresh, ordinary setup re-entry can reconcile accepted declarations through the protected configuration channel without repeated UAC.

There is no safe no-UAC code change that can make the old service host an endpoint it does not contain. Starting provider composition in the ordinary process, directly editing protected state, weakening service or pipe ACLs, copying protected access material, or adding a compatibility route would violate DB-003/DB-020, duplicate an existing authority owner, and create the legacy code the project forbids.

The next usable-product proof is therefore physical rather than another mock or controller feature:

1. one exact protected Windows service refresh/re-entry;
2. ordinary re-observation of one accepted Linux declaration, environment, route, bridge, and required guest tools;
3. fixed C source transfer, guest compile/run, bounded result return, and expected output/exit evidence through the protected activity channel;
4. service/VM restart followed by the identical Linux C proof without guest interaction;
5. independent official Windows-media acceptance and Windows profile construction;
6. the identical Windows C proof and restart repeat; and
7. Stage 7 adversarial/security qualification on real Hyper-V, followed by the separately required KVM/QEMU/libvirt qualification on a capable Linux host.

GPU/CUDA and PCIe-device work remain deferred. Hosted CI proves software contracts and replaceability but does not satisfy any physical provider, guest, or security gate.

## Dependency-ordered plan

1. Publish this exact assessment/research/reassessment checkpoint and require the normal Windows/Ubuntu CI matrix.
2. Preserve the installed runtime and running old service unchanged until UAC is explicitly available.
3. During an announced UAC window, use only the supported exact-subject service refresh/re-entry transaction; do not grant standing service-change authority.
4. Re-observe the new configuration endpoint and accepted Linux profile from an ordinary process before attempting repository execution.
5. Run the fixed Linux C canary through the normal host-authoritative source → protected activity → guest compile/run → bounded result path, restart the owned service/VM, and repeat the exact canary.
6. Acquire/approve official Windows ISO media through the existing bounded setup choice, construct and qualify the Windows profile noninteractively, then perform the same C and restart proofs.
7. Close only the issues whose exact criteria those observations satisfy. Keep Stage 7 and Linux KVM/libvirt open until real provider evidence exists.
8. Integrate the accepted recovery line through its reviewed targets only after minimal functionality is physically proven; then remove the retired fast-track branch/worktree while preserving operator-owned configuration as directed.

## Current implementation result and nonclaims

No production code change is warranted before the protected refresh. The smallest complete LEGO-correct result for this no-elevation slice is the durable frontier and exact next transaction above. Adding code solely to evade the missing endpoint would create a second authority path and regress the architecture.

This checkpoint does not claim DevBridge is ready for repository work, does not close #293, #360, #362, #372, #373, #374, #115, or #116, and does not infer real VM readiness from hosted tests or read-only host observations.
